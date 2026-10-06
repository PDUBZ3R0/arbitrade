// -----------------------------------------------------------------------------
// Pair / pool creation event scanner.
//
// For each factory in the chain's config (V2-family PairCreated, or V3
// PoolCreated for the v3 group), walk its creation events from
// the factory's deployment block (or the last scanned block on resume) up to
// the current head, in chunks. Store discovered pairs in SQLite.
//
// The scan is idempotent — running twice discovers zero new pairs the second
// time. Progress is persisted per factory, so a killed scan resumes cleanly.
//
// Chunk sizing is the main knob. Different RPC providers have different log
// window limits:
//   - Alchemy: typically 500 blocks per eth_getLogs, sometimes more
//   - QuickNode: 10000 blocks
//   - Public/free RPCs: often as low as 1000 or with response size caps
// We start at CHUNK_DEFAULT and back off on error.
// -----------------------------------------------------------------------------

import { ethers, JsonRpcProvider } from 'ethers';
import type { ChainConfig, NormalizedFactory, ScanTuning } from '../util/config.ts';
import { ArbitradeDB } from '../util/db.ts';
import { discoverDeployBlock } from '../util/discover-deploy-block.ts';
import { etherscanGetLogs, rateLimit as etherscanRateLimit } from '../util/etherscan.ts';

// Creation-event topics and decoding live in pool-events.ts, shared with
// find-factories / verify-*. Each factory group scans exactly one shape:
//   v2, v2fee : PairCreated(address,address,address,uint256)
//   solidly   : PairCreated(address,address,bool,address,uint256)
//   v3        : PoolCreated — fee-keyed (poolEvent "uniswap", default) or
//               tick-spacing-keyed (poolEvent "tickspacing")
// They have DIFFERENT keccak hashes and index separately on-chain, so the
// scanner must know which topic to filter for.
import { TOPIC_BY_LAYOUT, LAYOUT_BY_POOL_EVENT, parseCreationLog, type EventLayout } from '../util/pool-events.ts';
import { makeProvider } from '../util/rpc.ts';

// Chunk-size defaults. These are the FALLBACKS; both the per-chain config
// (chain.pagesize) and env vars (SCAN_CHUNK_*) can override them.
//
// Real-world limits observed:
//   - Alchemy free tier:  10 blocks/req  (very restrictive)
//   - Alchemy growth+:    500-2000 blocks/req  (soft cap on response size)
//   - QuickNode paid:     10000+ blocks/req
//   - Public/free RPCs:   varies wildly, 500-10000
//
// The adaptive backoff cuts the chunk in half on failures matching a broad
// set of "range too large" / "response too big" / "free tier" messages.
const CHUNK_DEFAULT = 5000;
const CHUNK_MIN     = 10;      // Alchemy free tier caps at 10 — must be able to reach this
const CHUNK_MAX     = 50000;

// Regex covering the common ways RPCs signal "you asked for too much."
// Kept broad — false positives just cause an extra retry with smaller chunk.
const CHUNK_TOO_LARGE_RE = /(response size|range|limit|too large|too many|free tier|upgrade|10 block)/i;

// Regex for transient RPC errors worth retrying (rate limits, gateway
// timeouts, network blips). These don't change the chunk size.
const TRANSIENT_ERROR_RE = /(rate limit|timeout|429|502|503|504|EAI_AGAIN|ECONNRESET|ETIMEDOUT|network|gateway)/i;

// Regex for "the RPC has pruned historical event logs for this range".
// When we hit this, RPC transport is dead for historical scanning; we fall
// through to the Etherscan V2 logs API for the rest of this factory's scan.
const LOGS_PRUNED_RE = /(history has been pruned|log.*pruned|pruned.*log|history is not available|no historical)/i;

// -----------------------------------------------------------------------------
// Small utilities

function sleep(ms: number): Promise<void> {
    return new Promise(res => setTimeout(res, ms));
}

function trim(s: string, n: number): string {
    return s.length > n ? s.slice(0, n) + '…' : s;
}

/**
 * Some RPCs (notably Alchemy free tier) include a suggested working range in
 * the error message, e.g.
 *   "this block range should work: [0xacee62, 0xacee6b]"
 * Extract the size of the suggested range so we can adapt directly instead of
 * guessing via bisection.
 */
function extractSuggestedRange(msg: string): number | null {
    const m = msg.match(/\[(0x[0-9a-f]+)\s*,\s*(0x[0-9a-f]+)\]/i);
    if (!m) return null;
    const lo = parseInt(m[1], 16);
    const hi = parseInt(m[2], 16);
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo) return null;
    return hi - lo + 1;
}

// -----------------------------------------------------------------------------

export type ScanOptions = {
    /** Override the config's deployBlock as the scan start. Useful for testing. */
    fromBlock?: number;
    /** Stop scanning at this block. Defaults to current head. */
    toBlock?: number;
    /** Blocks per eth_getLogs call. Adaptive; this is the initial value. */
    chunkSize?: number;
    /** Chunk sizing / delay tuning; typically from ChainConfig.scan */
    tuning?: ScanTuning;
    /** Chain id, for Etherscan V2 API calls during deploy-block discovery */
    chainId?: number;
    /** Etherscan V2 API key (unified across chains), for deploy-block discovery */
    explorerApiKey?: string;
    /** Force a specific transport for log fetching. Default: try HyperSync first (if configured), then RPC, then Etherscan on pruning. */
    forceTransport?: 'hypersync' | 'rpc' | 'etherscan';
    /** HyperSync URL for fast-path scanning (from cfg.chain.hypersyncUrl). */
    hypersyncUrl?: string;
    /** ENVIO API token (from process.env.ENVIO_API_TOKEN). */
    envioApiToken?: string;
    /** Called after each successful chunk. */
    onProgress?: (info: { factory: string; block: number; head: number; found: number }) => void;
};

/**
 * Discover a factory's deploy block and cache it in the DB so later runs skip
 * the lookup. Only called when the chunked-RPC path is actually going to be
 * used — see the comment at its call site in scanFactory.
 */
async function discoverAndCacheDeployBlock(
    provider: JsonRpcProvider,
    db: ArbitradeDB,
    factory: NormalizedFactory,
    opts: ScanOptions,
): Promise<number> {
    console.log(`  [!] deployBlock not set for ${factory.name}, discovering...`);
    const startBlock = await discoverDeployBlock(provider, factory.address, {
        chainId: opts.chainId,
        explorerApiKey: opts.explorerApiKey,
    });
    console.log(`  [i] Discovered deployBlock: ${startBlock} — caching in DB (add to config too if you like)`);
    db.upsertFactory({
        address: factory.address,
        name: factory.name,
        type: factory.group,
        fee: factory.fee,
        deployBlock: startBlock,
    });
    return startBlock;
}

/** Creation-event layout and topic for a factory's group / poolEvent. */
function layoutOf(factory: NormalizedFactory): EventLayout {
    return factory.group === 'solidly' ? (factory.poolEvent === 'velodrome' ? 'velodrome' : 'solidly') :
           factory.group === 'v3'      ? LAYOUT_BY_POOL_EVENT[(factory.poolEvent as 'uniswap' | 'tickspacing' | undefined) ?? 'uniswap'] :
           'v2';
}

/** A parsed creation event as a pairs-table row. */
function pairRow(factory: NormalizedFactory, p: { pair: string; token0: string; token1: string; stable: boolean | null;
                 feePips?: number | null; tickSpacing?: number | null; blockNumber: number }): import('../util/db.ts').PairRow {
    const isV3 = factory.group === 'v3';
    return {
        address:     p.pair,
        factory:     factory.address,
        token0:      p.token0,
        token1:      p.token1,
        blockNumber: p.blockNumber,
        fee:         isV3 && p.feePips != null ? p.feePips / 1e6 : null,
        stable:      p.stable,
        kind:        isV3 ? 'v3' : 'v2',
        tickSpacing: isV3 ? (p.tickSpacing ?? null) : null,
    };
}

/**
 * Catch up many factories at once over the chain's RPC.
 *
 * WHY. After the first scan, a re-run only has to cover the blocks since the
 * last one — on Sonic, a few thousand. Doing that factory by factory through
 * HyperSync costs one HyperSync request per factory (33 on Sonic) for what is
 * usually zero new pairs, and the free tier allows ~15 requests per window:
 * the scan spent most of its time waiting out rate limits. Here every
 * factory in the set shares ONE eth_getLogs per chunk — address list plus
 * every creation topic — on the configured RPC, which makeProvider makes
 * websocket-first. Logs are routed back to their factory by address.
 *
 * Each factory keeps its own resume point: a log below it (already scanned)
 * is ignored, and a factory's progress is only advanced over blocks it was
 * actually asked to cover. Returns new pairs per factory name; throws on an
 * error it cannot adapt to, leaving progress at the last completed chunk so
 * the per-factory path can take over from there.
 */
export async function scanIncremental(
    provider: JsonRpcProvider,
    db: ArbitradeDB,
    factories: Array<{ factory: NormalizedFactory; fromBlock: number }>,
    head: number,
    tuning: ScanTuning,
    log: (s: string) => void = console.log,
): Promise<Record<string, number>> {
    const found: Record<string, number> = {};
    if (factories.length === 0) return found;
    const byAddr = new Map<string, { factory: NormalizedFactory; fromBlock: number; layout: EventLayout; topic: string }>();
    for (const f of factories) {
        const layout = layoutOf(f.factory);
        byAddr.set(f.factory.address.toLowerCase(), { ...f, layout, topic: TOPIC_BY_LAYOUT[layout] });
        found[f.factory.name] = 0;
    }
    const topics = [...new Set([...byAddr.values()].map(f => f.topic))];
    const addresses = [...byAddr.keys()];
    // Providers cap the address list of one filter; 200 is well inside the
    // usual limits and one call still covers every factory on most chains.
    const ADDR_CHUNK = 200;

    let cursor = Math.min(...factories.map(f => f.fromBlock));
    let chunk = tuning.chunkStart;
    let calls = 0;
    while (cursor <= head) {
        const end = Math.min(cursor + chunk - 1, head);
        let logs: Array<{ address: string; topics: readonly string[]; data: string; blockNumber: number }> = [];
        try {
            for (let i = 0; i < addresses.length; i += ADDR_CHUNK) {
                // Only factories that still need [cursor, end].
                const want = addresses.slice(i, i + ADDR_CHUNK).filter(a => byAddr.get(a)!.fromBlock <= end);
                if (want.length === 0) continue;
                const part = await provider.getLogs({ address: want, topics: [topics], fromBlock: cursor, toBlock: end });
                calls++;
                logs = logs.concat(part as any);
            }
        } catch (err) {
            const raw = err as any;
            const msg = `${raw?.message ?? String(err)} ${raw?.error?.message ?? raw?.info?.error?.message ?? ''}`;
            const suggested = extractSuggestedRange(msg);
            if (suggested && chunk > suggested) { chunk = suggested; continue; }
            if (CHUNK_TOO_LARGE_RE.test(msg) && chunk > tuning.chunkMin) { chunk = Math.max(tuning.chunkMin, Math.floor(chunk / 2)); continue; }
            if (TRANSIENT_ERROR_RE.test(msg)) { log(`  [!] transient error, backing off 5s: ${trim(msg, 80)}`); await sleep(5000); continue; }
            throw new Error(`incremental getLogs ${cursor}-${end}: ${trim(msg, 200)}`);
        }

        const rowsByFactory = new Map<string, import('../util/db.ts').PairRow[]>();
        for (const lg of logs) {
            const f = byAddr.get(String(lg.address).toLowerCase());
            if (!f || lg.blockNumber < f.fromBlock) continue;      // not ours, or already scanned
            if (String(lg.topics[0]).toLowerCase() !== f.topic.toLowerCase()) continue;   // another factory's event shape
            const parsed = parseCreationLog(lg.topics as string[], lg.data, f.layout);
            if (!parsed) continue;
            const rows = rowsByFactory.get(f.factory.address) ?? [];
            rows.push(pairRow(f.factory, { ...parsed, blockNumber: lg.blockNumber }));
            rowsByFactory.set(f.factory.address, rows);
        }
        for (const f of byAddr.values()) {
            if (f.fromBlock > end) continue;
            const rows = rowsByFactory.get(f.factory.address);
            if (rows?.length) found[f.factory.name] += db.insertPairs(rows);
            db.setScanProgress(f.factory.address, end);
        }

        cursor = end + 1;
        if (chunk < tuning.chunkMax && logs.length < 1000) chunk = Math.min(tuning.chunkMax, Math.floor(chunk * 1.25));
        if (tuning.chunkDelayMs > 0) await sleep(tuning.chunkDelayMs);
    }
    log(`  ${factories.length} factories caught up to block ${head} in ${calls} eth_getLogs call(s)`);
    return found;
}

/**
 * Scan a single factory. Returns the number of NEW pairs discovered.
 */
export async function scanFactory(
    provider: JsonRpcProvider,
    db: ArbitradeDB,
    factory: NormalizedFactory,
    opts: ScanOptions = {},
): Promise<number> {
    if (factory.group === 'algebra') {
        // Algebra pools are discovered by find-factories but not modelled
        // downstream (globalState/tickTable, dynamic fee), so scanning them
        // would only fill the DB with pools nothing can price.
        return 0;
    }

    // Event topic and parsing rules depend on the group:
    //   'v2'      : PairCreated(address,address,address,uint256)
    //               No stable info in event.
    //   'v2fee'   : Also uses the V2 topic (Shadow-style). Fee is per-pair
    //               (fetched later at reserves time). Some (Shadow) have
    //               pair.stable() too — see hasStableFlag config.
    //   'solidly' : Canonical Solidly / Equalizer: PairCreated with the
    //               stable flag in the event data. With poolEvent
    //               'velodrome' (Velodrome V2 / Aerodrome V2): PoolCreated
    //               with stable indexed — see pool-events.ts.
    //   'v3'      : PoolCreated in the shape named by factory.poolEvent. The
    //               pool is stored with kind 'v3', its fee tier (when the
    //               event carries it) and its tick spacing.
    const layout = layoutOf(factory);
    const eventTopic = TOPIC_BY_LAYOUT[layout];

    // One row shape for all three transports (and scanIncremental). v2fee/
    // solidly fees are populated later by the reserves fetcher; a v3 pool
    // gets its fee tier from the event when the shape carries it.
    const toRow = (p: Parameters<typeof pairRow>[1]) => pairRow(factory, p);

    const head = opts.toBlock ?? await provider.getBlockNumber();
    const resumeBlock = db.getScanProgress(factory.address);

    // Whether the HyperSync fast path is available. Computed up here rather
    // than immediately before the fast path, because it decides whether we
    // need a deploy block at all — see the next block.
    const canUseHyperSync = Boolean(
        opts.hypersyncUrl && opts.envioApiToken &&
        (!opts.forceTransport || opts.forceTransport === 'hypersync')
    );

    // Deploy-block discovery is ONLY an optimization for the chunked-RPC path,
    // where the number of eth_getLogs calls scales with (head - fromBlock).
    // HyperSync serves an indexed address+topic query, so starting it at block 0
    // costs essentially the same as starting it at the deploy block.
    //
    // Discovering a deploy block we then don't use is pure waste — and not cheap
    // waste: the binary search is ~26 archive eth_getCode calls per factory, which
    // is enough to exhaust a modest RPC compute-unit budget before the scan has
    // fetched a single log. So skip discovery when HyperSync is on. If HyperSync
    // later fails and we fall through to RPC, we discover lazily at that point.
    let startBlock = factory.deployBlock;
    if (!startBlock && resumeBlock === null && !canUseHyperSync) {
        startBlock = await discoverAndCacheDeployBlock(provider, db, factory, opts);
    }

    const fromBlock = opts.fromBlock
        ?? (resumeBlock !== null ? resumeBlock + 1 : (startBlock || 0));

    if (fromBlock > head) {
        // Already caught up
        return 0;
    }

    // Declared here so the HyperSync fast path (below) and the RPC/Etherscan
    // slow path (further below) share the same running counter.
    let totalFound = 0;

    // -----------------------------------------------------------------------
    // HyperSync fast path.
    //
    // If a HyperSync URL is configured for this chain and ENVIO_API_TOKEN is
    // set, use HyperSync for the entire scan. This bypasses the chunked-RPC
    // dance entirely — no window sizing, no rate-limit backoff, no
    // adaptive fallback to Etherscan. HyperSync handles pagination natively
    // and streams parsed pair events in batches. We persist scan progress
    // per batch, so a killed scan resumes from the last completed batch.
    //
    // On any HyperSync error, we fall through to the RPC/Etherscan path below
    // and continue from the last block HyperSync did complete (thanks to the
    // per-batch progress writes).
    // -----------------------------------------------------------------------
    // Starting block for the RPC path. Usually identical to fromBlock, but if
    // HyperSync fails we may have no deploy block yet (discovery was skipped
    // above), leaving fromBlock at 0 — and a chunked RPC scan from genesis is
    // not something we want to start by accident. The catch block below fixes
    // this up before the RPC path reads it.
    let rpcFromBlock = fromBlock;

    if (canUseHyperSync) {
        try {
            const { scanFactoryHyperSync } = await import('../util/hypersync.ts');
            const result = await scanFactoryHyperSync(
                opts.hypersyncUrl!,
                opts.envioApiToken!,
                factory.address,
                fromBlock,
                head,
                eventTopic,
                layout,
                async (batchPairs, progressBlock) => {
                    if (batchPairs.length > 0) {
                        const rows = batchPairs.map(toRow);
                        const inserted = db.insertPairs(rows);
                        totalFound += inserted;
                    }
                    db.setScanProgress(factory.address, progressBlock);
                    opts.onProgress?.({
                        factory: factory.name,
                        block:   progressBlock,
                        head,
                        found:   totalFound,
                    });
                },
            );
            // Success — return immediately without touching RPC.
            return totalFound;
        } catch (err) {
            if (opts.forceTransport === 'hypersync') {
                throw new Error(`HyperSync scan failed and forceTransport='hypersync': ${(err as Error).message}`);
            }
            console.log(`\n  [!] HyperSync scan failed at block ${db.getScanProgress(factory.address) ?? fromBlock}, ` +
                        `falling back to RPC: ${(err as Error).message.slice(0, 100)}`);
            // Fall through to the RPC path below. Work out where it should
            // start: prefer whatever HyperSync managed to persist, otherwise
            // discover the deploy block now (we skipped it above precisely
            // because we expected HyperSync to handle this factory).
            const progressed = db.getScanProgress(factory.address);
            if (progressed !== null) {
                rpcFromBlock = progressed + 1;
            } else if (opts.fromBlock === undefined && !startBlock) {
                rpcFromBlock = await discoverAndCacheDeployBlock(provider, db, factory, opts);
            }
        }
    }

    let chunk = opts.chunkSize ?? opts.tuning?.chunkStart ?? CHUNK_DEFAULT;
    const chunkMin = opts.tuning?.chunkMin ?? CHUNK_MIN;
    const chunkMax = opts.tuning?.chunkMax ?? CHUNK_MAX;
    const chunkDelay = opts.tuning?.chunkDelayMs ?? 0;
    let cursor = rpcFromBlock;
    // totalFound already declared above the HyperSync fast path

    // Once the RPC has told us a specific hard cap (either via a "suggested
    // range" hint like Alchemy's "[from, to] should work" or by rejecting
    // sizes we've tried), remember it and never ramp above it. Without this,
    // we oscillate forever: shrink → success → ramp → reject → shrink.
    let observedCap = Infinity;

    // Transport state: 'rpc' or 'etherscan'. Once we switch to Etherscan for
    // this factory (because RPC pruned its logs), stay there — retrying the
    // same RPC would just re-fail.
    type Transport = 'rpc' | 'etherscan';
    let transport: Transport = 'rpc';

    // If user explicitly wants Etherscan-only, start there.
    if (opts.forceTransport === 'etherscan') {
        transport = 'etherscan';
        if (!opts.explorerApiKey) {
            throw new Error(`forceTransport='etherscan' requires ETHERSCAN_API_KEY in .env`);
        }
    }

    while (cursor <= head) {
        const chunkEnd = Math.min(cursor + chunk - 1, head);

        let logs: { blockNumber: number; topics: string[]; data: string }[];

        if (transport === 'etherscan') {
            // Etherscan path
            if (!opts.explorerApiKey) {
                throw new Error(
                    `Fell back to Etherscan for ${factory.name} but ETHERSCAN_API_KEY isn't set. ` +
                    `The RPC pruned historical logs; there's no way forward without an explorer API key.`
                );
            }
            await etherscanRateLimit();
            try {
                const raw = await etherscanGetLogs({
                    chainId: opts.chainId!,
                    address: factory.address,
                    topic0: eventTopic,
                    fromBlock: cursor,
                    toBlock: chunkEnd,
                    apiKey: opts.explorerApiKey,
                });
                logs = raw;
            } catch (err) {
                const msg = (err as Error).message ?? String(err);
                // If Etherscan complained about window size, treat like RPC
                if (/window|range|size|1000|result/i.test(msg) && chunk > chunkMin) {
                    const newChunk = Math.max(chunkMin, Math.floor(chunk / 2));
                    console.log(`\n  [!] Etherscan window (${chunk} → ${newChunk}): ${trim(msg, 80)}`);
                    chunk = newChunk;
                    continue;
                }
                if (TRANSIENT_ERROR_RE.test(msg)) {
                    console.log(`\n  [!] Etherscan transient error, backing off 5s: ${trim(msg, 80)}`);
                    await sleep(5000);
                    continue;
                }
                throw new Error(`Etherscan error at blocks ${cursor}-${chunkEnd}: ${msg}`);
            }

            // Etherscan caps results at 1000/call; if we hit that, shrink and refetch
            // to avoid missing entries at the tail of the range.
            if (logs.length === 1000 && chunk > chunkMin) {
                const newChunk = Math.max(chunkMin, Math.floor(chunk / 2));
                console.log(`\n  [!] Etherscan returned exactly 1000 logs (likely truncated), shrinking ${chunk} → ${newChunk}`);
                chunk = newChunk;
                continue;
            }
        } else {
            // RPC path
            try {
                const raw = await provider.getLogs({
                    address: factory.address,
                    topics: [eventTopic],
                    fromBlock: cursor,
                    toBlock: chunkEnd,
                });
                logs = raw as any;
            } catch (err) {
                const raw = err as any;
                const innerMsg = raw?.error?.message ?? raw?.info?.error?.message ?? '';
                const outerMsg = raw?.message ?? String(err);
                const msg = `${outerMsg} ${innerMsg}`;

                // Log pruning: RPC is fundamentally unable to serve historical
                // events. Switch transport for the rest of this factory.
                if (LOGS_PRUNED_RE.test(msg)) {
                    if (!opts.explorerApiKey) {
                        throw new Error(
                            `RPC has pruned historical event logs for blocks ${cursor}-${chunkEnd}, and ` +
                            `ETHERSCAN_API_KEY is not set to fall back to. Options:\n` +
                            `  1. Set ETHERSCAN_API_KEY in .env (works with any RPC, slower but reliable)\n` +
                            `  2. Use an archive RPC (paid Alchemy, QuickNode, self-hosted Erigon)\n` +
                            `Underlying error: ${trim(msg, 200)}`
                        );
                    }
                    console.log(`\n  [!] RPC has pruned logs. Switching to Etherscan V2 for ${factory.name}.`);
                    console.log(`      This will be slower (~5 calls/sec) but works.`);
                    transport = 'etherscan';
                    continue;
                }

                const suggested = extractSuggestedRange(msg);
                if (suggested && chunk > suggested) {
                    // Only log the shrink event, not every subsequent attempt
                    if (observedCap === Infinity || suggested < observedCap) {
                        console.log(`\n  [!] RPC caps range at ${suggested} blocks — locking chunk to that ceiling`);
                    }
                    observedCap = suggested;
                    chunk = suggested;
                    continue;
                }

                if (CHUNK_TOO_LARGE_RE.test(msg)) {
                    if (chunk > chunkMin) {
                        const newChunk = Math.max(chunkMin, Math.floor(chunk / 2));
                        // Record whatever chunk just failed as a cap ceiling
                        observedCap = Math.min(observedCap, chunk - 1);
                        console.log(`\n  [!] Chunk too large (${chunk} → ${newChunk}): ${trim(msg, 80)}`);
                        chunk = newChunk;
                        continue;
                    }
                    throw new Error(
                        `RPC chunk size at floor (${chunkMin} blocks) and still rejecting. ` +
                        `Options: (1) set ETHERSCAN_API_KEY to fall back to Etherscan, ` +
                        `(2) upgrade the RPC plan, (3) try another provider. ` +
                        `Underlying error: ${trim(msg, 200)}`
                    );
                }

                if (TRANSIENT_ERROR_RE.test(msg)) {
                    console.log(`\n  [!] Transient error, backing off 5s: ${trim(msg, 80)}`);
                    await sleep(5000);
                    continue;
                }

                throw new Error(
                    `Unexpected error scanning ${factory.name} at blocks ${cursor}-${chunkEnd}: ${msg}`
                );
            }
        }

        if (logs.length > 0) {
            const rows: import('../util/db.ts').PairRow[] = [];
            for (const log of logs) {
                const parsed = parseCreationLog(log.topics, log.data, layout);
                if (!parsed) continue;   // malformed log for this shape; never store a garbage address
                rows.push(toRow({ ...parsed, blockNumber: log.blockNumber }));
            }
            const inserted = db.insertPairs(rows);
            totalFound += inserted;
        }

        db.setScanProgress(factory.address, chunkEnd);
        opts.onProgress?.({
            factory: factory.name,
            block: chunkEnd,
            head,
            found: totalFound,
        });

        cursor = chunkEnd + 1;

        // Ramp chunk size back up on success (gradually, so we don't oscillate).
        // Never exceed observedCap — if the RPC has capped us, stay there.
        const ceiling = Math.min(chunkMax, observedCap);
        if (chunk < ceiling && logs.length < 1000) {
            chunk = Math.min(ceiling, Math.floor(chunk * 1.25));
        }

        // Inter-chunk delay for rate-limited providers
        if (chunkDelay > 0) {
            await sleep(chunkDelay);
        }
    }

    return totalFound;
}

/**
 * Scan every factory in a chain's config (all groups except algebra).
 */
export async function scanChain(
    cfg: ChainConfig,
    dbFilePath: string,
    opts: ScanOptions = {},
): Promise<Record<string, number>> {
    const provider = makeProvider(cfg.chain);
    const db = new ArbitradeDB(dbFilePath);

    // Register factories in the db. IMPORTANT: preserve any DB-cached
    // deployBlock when the config has none (0), so we don't overwrite a
    // previously-discovered value with 0 on every run.
    for (const f of cfg.factories) {
        const cached = db.getFactoryDeployBlock(f.address);
        db.upsertFactory({
            address: f.address,
            name: f.name,
            type: f.group,
            fee: f.fee,
            deployBlock: f.deployBlock || cached || 0,
        });
    }

    const results: Record<string, number> = {};
    const failures: { factory: string; error: string }[] = [];

    // Incremental catch-up: factories already scanned to within
    // incrementalMaxBlocks of the head share eth_getLogs calls on the RPC
    // instead of one HyperSync request each. See scanIncremental. Skipped
    // when a transport is forced or a starting block is given.
    const maxGap = cfg.scan.incrementalMaxBlocks ?? cfg.scan.chunkStart * 40;
    const handled = new Set<string>();
    if (maxGap > 0 && !opts.forceTransport && opts.fromBlock === undefined) {
        const head = opts.toBlock ?? await provider.getBlockNumber();
        const near: Array<{ factory: NormalizedFactory; fromBlock: number }> = [];
        for (const f of cfg.factories) {
            if (f.group === 'algebra') continue;
            const resume = db.getScanProgress(f.address);
            if (resume !== null && head - resume <= maxGap) near.push({ factory: f, fromBlock: resume + 1 });
        }
        if (near.length > 0) {
            const behind = Math.max(0, head - Math.min(...near.map(n => n.fromBlock)) + 1);
            console.log(`\n[${cfg.chain.currency}] Incremental: ${near.length} factor${near.length === 1 ? 'y' : 'ies'} ` +
                `within ${maxGap.toLocaleString()} blocks of the head (up to ${behind.toLocaleString()} behind) — one RPC getLogs per chunk for all of them`);
            try {
                const got = await scanIncremental(provider, db, near, head, cfg.scan);
                for (const n of near) {
                    handled.add(n.factory.address);
                    results[n.factory.name] = got[n.factory.name] ?? 0;
                    if (results[n.factory.name] > 0) console.log(`  ${n.factory.name}: ${results[n.factory.name]} new ${n.factory.group === 'v3' ? 'pools' : 'pairs'}`);
                }
            } catch (err) {
                // Progress is saved per chunk; the per-factory loop below
                // resumes each factory from wherever this got to.
                console.log(`  [!] incremental catch-up failed, scanning factory by factory instead: ${(err as Error).message.slice(0, 160)}`);
            }
        }
    }

    // Announce active tuning so the user sees what's in effect
    const t = cfg.scan;
    console.log(`Scan tuning: chunk ${t.chunkStart} [min ${t.chunkMin} / max ${t.chunkMax}], delay ${t.chunkDelayMs}ms`);

    const explorerApiKey = process.env.ETHERSCAN_API_KEY;
    if (!explorerApiKey) {
        console.log(`[!] ETHERSCAN_API_KEY not set — will fall back to RPC binary search if deploy blocks are unknown.`);
        console.log(`    (This requires archive RPC access; most free tiers don't have it.)`);
    }

    try {
        for (const factory of cfg.factories) {
            if (handled.has(factory.address)) continue;
            if (factory.group === 'algebra') {
                console.log(`\n[skip] ${factory.name}: algebra pools are not modelled yet — not scanned`);
                continue;
            }

            // Prefer DB-cached deploy block over config, since discovery caches to DB
            const cachedBlock = db.getFactoryDeployBlock(factory.address);
            const effectiveFactory: NormalizedFactory = {
                ...factory,
                deployBlock: factory.deployBlock || cachedBlock || 0,
            };

            console.log(`\n[${cfg.chain.currency}] Scanning ${factory.name} @ ${factory.address}`);
            const startPairs = db.countPairs(factory.address);
            try {
                const found = await scanFactory(provider, db, effectiveFactory, {
                    tuning: cfg.scan,
                    chainId: cfg.chain.id,
                    explorerApiKey,
                    hypersyncUrl:   cfg.chain.hypersyncUrl,
                    envioApiToken:  process.env.ENVIO_API_TOKEN,
                    ...opts,
                    onProgress: (info) => {
                        const denom = Math.max(1, info.head - effectiveFactory.deployBlock);
                        const pct = ((info.block - effectiveFactory.deployBlock) / denom * 100).toFixed(1);
                        process.stdout.write(
                            `\r  block ${info.block}/${info.head} (${pct}%) — ${info.found} new pairs`
                        );
                    },
                });
                process.stdout.write('\n');
                console.log(`  → ${found} new pairs; total now ${startPairs + found}`);
                results[factory.name] = found;
            } catch (err) {
                // One bad factory must not cost us the rest of the list. Scan
                // progress is persisted per batch, so a re-run resumes rather
                // than restarting this factory from scratch.
                process.stdout.write('\n');
                console.log(`  [x] FAILED ${factory.name}: ${(err as Error).message.split('\n')[0]}`);
                failures.push({ factory: factory.name, error: (err as Error).message });
                results[factory.name] = 0;
            }
        }
    } finally {
        db.close();
        if (failures.length > 0) {
            console.log(`\n[!] ${failures.length} factor${failures.length === 1 ? 'y' : 'ies'} failed and were skipped:`);
            for (const f of failures) {
                console.log(`    - ${f.factory}: ${f.error.split('\n')[0].slice(0, 160)}`);
            }
            console.log(`    Re-run the scan to retry them; completed factories resume from saved progress.`);
        }
    }

    return results;
}
