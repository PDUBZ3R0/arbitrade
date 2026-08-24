// -----------------------------------------------------------------------------
// PairCreated event scanner.
//
// For each V2 factory in the chain's config, walk `PairCreated` events from
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

// PairCreated event topic0 hashes. There are two variants in the wild:
//   V2:      PairCreated(address,address,address,uint256)          - standard Uniswap V2
//   Solidly: PairCreated(address,address,bool,address,uint256)     - has stable flag in event
// They have DIFFERENT keccak hashes and index separately on-chain, so a
// factory-family scanner must know which topic to filter for.
const PAIR_CREATED_V2_TOPIC      = ethers.id('PairCreated(address,address,address,uint256)');
const PAIR_CREATED_SOLIDLY_TOPIC = ethers.id('PairCreated(address,address,bool,address,uint256)');

// Kept for backward compat with the earlier code that only knew about V2
const PAIR_CREATED_TOPIC = PAIR_CREATED_V2_TOPIC;

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
    /** Force a specific transport for log fetching. Default: try RPC, fall through to Etherscan on pruning. */
    forceTransport?: 'rpc' | 'etherscan';
    /** Called after each successful chunk. */
    onProgress?: (info: { factory: string; block: number; head: number; found: number }) => void;
};

/**
 * Scan a single factory. Returns the number of NEW pairs discovered.
 */
export async function scanFactory(
    provider: JsonRpcProvider,
    db: ArbitradeDB,
    factory: NormalizedFactory,
    opts: ScanOptions = {},
): Promise<number> {
    if (factory.group !== 'v2'
        && factory.group !== 'v2fee'
        && factory.group !== 'solidly') {
        // V3/Algebra use different event shapes; separate scanner needed.
        return 0;
    }

    // Event topic and parsing rules depend on the group:
    //   'v2'      : PairCreated(address,address,address,uint256)
    //               No stable info in event.
    //   'v2fee'   : Also uses the V2 topic (Shadow-style). Fee is per-pair
    //               (fetched later at reserves time). Some (Shadow) have
    //               pair.stable() too — see hasStableFlag config.
    //   'solidly' : Canonical Solidly / Aerodrome / Velodrome / Equalizer.
    //               Different topic. Stable flag IS in the event data.
    const eventTopic = factory.group === 'solidly'
        ? PAIR_CREATED_SOLIDLY_TOPIC
        : PAIR_CREATED_V2_TOPIC;
    const parseStableFromEvent = factory.group === 'solidly';

    const head = opts.toBlock ?? await provider.getBlockNumber();
    const resumeBlock = db.getScanProgress(factory.address);

    let startBlock = factory.deployBlock;
    if (!startBlock && resumeBlock === null) {
        console.log(`  [!] deployBlock not set for ${factory.name}, discovering...`);
        startBlock = await discoverDeployBlock(provider, factory.address, {
            chainId: opts.chainId,
            explorerApiKey: opts.explorerApiKey,
        });
        console.log(`  [i] Discovered deployBlock: ${startBlock} — caching in DB (add to config too if you like)`);
        // Update the DB so subsequent runs don't re-discover
        db.upsertFactory({
            address: factory.address,
            name: factory.name,
            type: factory.group,
            fee: factory.fee,
            deployBlock: startBlock,
        });
    }

    const fromBlock = opts.fromBlock
        ?? (resumeBlock !== null ? resumeBlock + 1 : startBlock);

    if (fromBlock > head) {
        // Already caught up
        return 0;
    }

    let chunk = opts.chunkSize ?? opts.tuning?.chunkStart ?? CHUNK_DEFAULT;
    const chunkMin = opts.tuning?.chunkMin ?? CHUNK_MIN;
    const chunkMax = opts.tuning?.chunkMax ?? CHUNK_MAX;
    const chunkDelay = opts.tuning?.chunkDelayMs ?? 0;
    let cursor = fromBlock;
    let totalFound = 0;

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
            const rows = logs.map(log => {
                // topics: [topic0, token0 (padded), token1 (padded)]
                // data: pair (address) + allPairsLength (uint256)
                const token0 = '0x' + log.topics[1].slice(-40);
                const token1 = '0x' + log.topics[2].slice(-40);
                // Extract pair (and stable flag if the event has one).
                //
                // V2 event data:      [pair (32B), index (32B)]
                //   pair = data[0..32]  → hex chars 2..66  → address in last 40 chars
                //
                // Solidly-native data: [stable (32B), pair (32B), index (32B)]
                //   stable = data[0..32] (bool, LSB)
                //   pair   = data[32..64]  → hex chars 66..130  → last 40 chars
                let pair: string;
                let stable: boolean | null = null;
                if (parseStableFromEvent) {
                    // solidly: word 0 = stable bool, word 1 = pair
                    stable = BigInt('0x' + log.data.slice(2, 66)) === 1n;
                    pair = '0x' + log.data.slice(66, 130).slice(-40);
                } else {
                    // v2 or v2fee (Shadow-style): word 0 = pair
                    pair = '0x' + log.data.slice(2, 66).slice(-40);
                }

                return {
                    address: pair,
                    factory: factory.address,
                    token0,
                    token1,
                    blockNumber: log.blockNumber,
                    // fee is populated later by reserves fetcher for v2fee/solidly
                    fee: null,
                    stable,  // set from event for solidly; null otherwise
                } satisfies import('../util/db.ts').PairRow;
            });
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
 * Scan every V2 factory in a chain's config.
 */
export async function scanChain(
    cfg: ChainConfig,
    dbFilePath: string,
    opts: ScanOptions = {},
): Promise<Record<string, number>> {
    const provider = new JsonRpcProvider(cfg.chain.host);
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
            if (factory.group !== 'v2'
                && factory.group !== 'v2fee'
                && factory.group !== 'solidly') continue;

            // Prefer DB-cached deploy block over config, since discovery caches to DB
            const cachedBlock = db.getFactoryDeployBlock(factory.address);
            const effectiveFactory: NormalizedFactory = {
                ...factory,
                deployBlock: factory.deployBlock || cachedBlock || 0,
            };

            console.log(`\n[${cfg.chain.currency}] Scanning ${factory.name} @ ${factory.address}`);
            const startPairs = db.countPairs(factory.address);
            const found = await scanFactory(provider, db, effectiveFactory, {
                tuning: cfg.scan,
                chainId: cfg.chain.id,
                explorerApiKey,
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
        }
    } finally {
        db.close();
    }

    return results;
}
