// -----------------------------------------------------------------------------
// log/<chain>/discovery.json — written by every run, interrupted ones included
//
// The audit trail for a sweep: every factory that emitted a pool-creation
// event in the window, known or not, with what verification found and what
// was (or would be) added to the config. Nothing is silently dropped — a
// candidate that was not verified, failed verification, or was held back from
// --add is there with the reason.
//
// {
//   "chain": "polygon", "scannedAt": "2026-10-10T…Z", "aborted": false,
//   "blockRange": { "from": 0, "to": 92709906 },
//   "totals": { "candidates": 1243, "known": 5, "blacklisted": 12, "unknown": 1226,
//               "verified": 14, "addable": 9, "added": 9 },
//   "candidates": [
//     { "address": "0x800b…", "pairCount": 628, "firstBlockSeen": 11791428,
//       "lastBlockSeen": 68402761, "matchedTopics": ["v2"],
//       "status": "known" | "blacklisted" | "verified" | "unusable" | "error" | "not-verified",
//       "reason": "…",                         // unusable / error / why held back
//       "family": "v2", "contractName": "UniswapV2Factory", "implementationName": "…",
//       "explorerVerified": true,
//       "proposed": { "group": "v2", "key": "UniswapV2Factory_800b0526",
//                     "entry": { "address": "0x…", "deployBlock": 11633169, "fee": 0.003 },
//                     "basis": "fee derived from swap() bytecode" },
//       "addable": true, "heldBack": "…",       // why not addable, when it isn't
//       "added": { "group": "v2", "key": "UniswapV2Factory_800b0526" }   // with --add
//     }, …
//   ]
// }
//
// Not built (yet): the liquidity/activity signals and confidence tiers once
// sketched for this file. "addable" is the only verdict today — see
// proposeEntry() for exactly what qualifies.
// -----------------------------------------------------------------------------
// Factory finder.
//
// Discovers unknown V2-style factories on a chain by sweeping recent
// PairCreated events across ALL contracts, then grouping by emitter address.
// Each unique emitter is a candidate factory.
//
// For each unknown candidate (not in config), runs verify-factory to check:
//   - Does it emit PairCreated?
//   - Are its pairs YoBatches-compatible?
//   - What's the deploy block?
//
// A verified candidate then gets the audits of verify-fees, check-fee-config and
// pair-code (factory-audit.ts; skip with --no-audit, --claude to read the code),
// and is named from DefiLlama and DexScreener (llama.ts). Its entry records the
// factory's creator and DEX.
//
// Emits a report with config snippets ready to paste into conf/{chain}.json5,
// writes log/<chain>/discovery.json, and with --add puts the verified ones
// straight into conf/<chain>.json5 (comments preserved; see conf-edit.ts).
//
// Usage:
//   yarn find-factories <chain>                    # default lookback 100k blocks
//   yarn find-factories <chain> --lookback 500000  # wider sweep
//   yarn find-factories <chain> --transport rpc    # force RPC (usually needs paid tier)
//   yarn find-factories <chain> --add              # also write verified factories to conf
//   yarn find-factories <chain> --new              # only what appeared since the last full sweep
//
// Notes:
//   - Only "active" factories show up (dormant ones haven't created pairs recently)
//   - Requires ETHERSCAN_API_KEY (default transport). RPC transport works only if
//     the RPC supports address-less log queries, which most free tiers don't.
//   - Rate-limited by Etherscan's ~4.5 calls/sec on free tier
// -----------------------------------------------------------------------------

import { ethers, JsonRpcProvider } from 'ethers';
import { realpathSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadChainConfig, dbPath, type FactoryEntry, type NormalizedFactory } from './config.ts';
import { ArbitradeDB } from './db.ts';
import { blacklistedAddresses } from './blacklist.ts';
import { addFactoriesToConf, type FactoryAddition } from './conf-edit.ts';
import type { VerifyResult } from './verify-factory.ts';
import type { V3VerifyResult } from './verify-v3-factory.ts';
import { DEX_PATTERNS, type DexPattern } from './dex-patterns.ts';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
import { etherscanGetLogs, rateLimit, notifyRateLimit } from './etherscan.ts';
import { verifyFactory } from './verify-factory.ts';
import { hypersyncUp } from './hypersync.ts';
import { detectProxy } from './proxy-detect.ts';
import { asFactory, auditCandidate, auditEffect, type AuditContext } from './factory-audit.ts';
import { hubTokens, type Sample } from './sample-pairs.ts';
import { identifyDex, loadLlamaIndex, type LlamaIndex } from './llama.ts';

// Contract names that indicate a proxy wrapper rather than the actual DEX logic.
// When Etherscan returns one of these, we should try detectProxy() and look up
// the implementation's contract name for the real identity.
const PROXY_NAME_PATTERNS = [
    /Proxy$/i,                        // ERC1967Proxy, BeaconProxy, TransparentUpgradeableProxy
    /^Proxy/i,                        // ProxyAdmin, ProxyFactory
    /UpgradeableProxy/i,
    /InitializableProxy/i,
];
function isProxyName(name: string): boolean {
    return PROXY_NAME_PATTERNS.some(re => re.test(name));
}

import {
    PAIR_CREATED_V2_TOPIC, PAIR_CREATED_SOLIDLY_TOPIC, POOL_CREATED_VELODROME_TOPIC,
    POOL_CREATED_V3_TOPIC, POOL_CREATED_AERODROME_TOPIC, POOL_CREATED_ALGEBRA_TOPIC,
    CL_LAYOUTS, type EventLayout,
} from './pool-events.ts';
import { makeProvider, sharedProvider } from './rpc.ts';
import { EnvioRest } from './envio-rest.ts';

/** A candidate whose events are concentrated-liquidity pool creations. */
function isClCandidate(c: FactoryCandidate): boolean {
    for (const t of c.matchedTopics) if (CL_LAYOUTS.has(t)) return true;
    return false;
}

// -----------------------------------------------------------------------------

export type FactoryCandidate = {
    address: string;
    pairCreatedCount: number;
    firstBlockSeen: number;
    lastBlockSeen: number;
    /** Which creation event shape(s) this factory emits — PairCreated (v2, solidly)
     *  or a concentrated-liquidity PoolCreated/Pool (v3, aerodrome, algebra). The
     *  count field is named for pairs but counts pools too. */
    matchedTopics: Set<EventLayout>;
};

export type FindOptions = {
    /** Explicit start block. If unset, computed as toBlock - lookbackBlocks. */
    fromBlock?: number;
    /** Sweep from this block to the head (--new: one past the last full sweep).
     *  Wins over fromBlock / toBlock / lookbackBlocks. */
    sinceBlock?: number;
    /** Explicit end block. If unset, defaults to current head. */
    toBlock?: number;
    /** Only used when fromBlock is unset; how far back from toBlock to look. */
    lookbackBlocks?: number;
    /** 'envio' asks our own indexer (envio-rest.ts) instead of sweeping logs. There
     *  `fromBlock` means "factories whose FIRST pool is at or after it", and the
     *  range ends where the indexer has got to, not at the head. */
    transport?: 'auto' | 'envio' | 'hypersync' | 'etherscan' | 'rpc';
    chunkSize?: number;
    explorerApiKey?: string;
    /** If set, sweep bails out at the next chunk boundary and returns partial results. */
    abortSignal?: AbortSignal;
    /** Called periodically with current emitter count so caller can autosave. */
    onProgress?: (emitters: Map<string, FactoryCandidate>) => void;
};

// -----------------------------------------------------------------------------
// Sweep - collect unique emitters of PairCreated topic in a block window

async function sweepEtherscan(
    chainId: number,
    fromBlock: number,
    toBlock: number,
    apiKey: string,
    chunkSize: number,
    topic: string,
    topicLabel: EventLayout,
    into?: Map<string, FactoryCandidate>,
    abortSignal?: AbortSignal,
): Promise<Map<string, FactoryCandidate>> {
    const emitters = into ?? new Map<string, FactoryCandidate>();
    let processed = 0;
    let currentChunk = chunkSize;
    const MIN_CHUNK = 100;
    let consecutiveRateLimits = 0;

    for (let start = fromBlock; start <= toBlock; ) {
        if (abortSignal?.aborted) {
            process.stdout.write('\n  [!] Aborted — returning partial results\n');
            return emitters;
        }
        const end = Math.min(start + currentChunk - 1, toBlock);
        await rateLimit();

        let logs;
        try {
            logs = await etherscanGetLogs({
                chainId,
                topic0: topic,
                fromBlock: start,
                toBlock: end,
                apiKey,
            });
            consecutiveRateLimits = 0;  // success — reset backoff counter
        } catch (err) {
            const msg = (err as Error).message ?? String(err);

            // Rate limit (Etherscan's "NOTOK — Max ... rate limit reached"): back off,
            // notify the rate limiter to slow future calls, and retry.
            if (/rate limit|too many|NOTOK/i.test(msg)) {
                consecutiveRateLimits++;
                notifyRateLimit();  // permanently slow the pacer for the rest of this process
                const wait = Math.min(30_000, 1000 * 2 ** consecutiveRateLimits);
                console.log(`\n  [!] Etherscan rate limit (attempt ${consecutiveRateLimits}), waiting ${wait}ms: ${msg.slice(0, 100)}`);
                await new Promise(r => setTimeout(r, wait));
                if (consecutiveRateLimits < 6) continue;
                throw new Error(`Rate limit exceeded ${consecutiveRateLimits} consecutive times — giving up. ${msg}`);
            }

            // Result cap or window too large - shrink and retry
            if (currentChunk > MIN_CHUNK && /result|window|1000|range|size|limit/i.test(msg)) {
                const shrunken = Math.max(MIN_CHUNK, Math.floor(currentChunk / 2));
                console.log(`\n  [!] Etherscan hit limit (window ${currentChunk} → ${shrunken}): ${msg.slice(0, 80)}`);
                currentChunk = shrunken;
                continue;
            }
            throw err;
        }

        for (const log of logs) {
            const addr = log.address.toLowerCase();
            const existing = emitters.get(addr);
            if (existing) {
                existing.pairCreatedCount++;
                existing.lastBlockSeen = Math.max(existing.lastBlockSeen, log.blockNumber);
                existing.firstBlockSeen = Math.min(existing.firstBlockSeen, log.blockNumber);
                existing.matchedTopics.add(topicLabel);
            } else {
                emitters.set(addr, {
                    address: addr,
                    pairCreatedCount: 1,
                    firstBlockSeen: log.blockNumber,
                    lastBlockSeen: log.blockNumber,
                    matchedTopics: new Set([topicLabel]),
                });
            }
        }

        processed += logs.length;
        const pct = ((end - fromBlock) / Math.max(1, toBlock - fromBlock) * 100).toFixed(1);
        process.stdout.write(
            `\r  [${topicLabel}] scanning ${start}-${end} (${pct}%) — ${emitters.size} unique factories, ${processed} events`
        );

        // If we got exactly the cap, shrink so we don't miss entries
        if (logs.length === 1000 && currentChunk > MIN_CHUNK) {
            currentChunk = Math.max(MIN_CHUNK, Math.floor(currentChunk / 2));
            console.log(`\n  [!] Etherscan returned exactly 1000 (likely truncated); shrinking window to ${currentChunk}`);
            continue;
        }

        start = end + 1;
    }

    process.stdout.write('\n');
    return emitters;
}

async function sweepRpc(
    provider: JsonRpcProvider,
    fromBlock: number,
    toBlock: number,
    chunkSize: number,
    topic: string,
    topicLabel: EventLayout,
    into?: Map<string, FactoryCandidate>,
    abortSignal?: AbortSignal,
): Promise<Map<string, FactoryCandidate>> {
    const emitters = into ?? new Map<string, FactoryCandidate>();
    let currentChunk = chunkSize;
    const MIN_CHUNK = 100;

    for (let start = fromBlock; start <= toBlock; ) {
        if (abortSignal?.aborted) {
            process.stdout.write('\n  [!] Aborted — returning partial results\n');
            return emitters;
        }
        const end = Math.min(start + currentChunk - 1, toBlock);
        let logs;
        try {
            logs = await provider.getLogs({
                topics: [topic],
                fromBlock: start,
                toBlock: end,
            });
        } catch (err) {
            const msg = (err as any)?.error?.message ?? (err as Error).message ?? String(err);
            if (currentChunk > MIN_CHUNK && /range|limit|size|too large|10 block/i.test(msg)) {
                const shrunken = Math.max(MIN_CHUNK, Math.floor(currentChunk / 2));
                console.log(`\n  [!] RPC hit limit (window ${currentChunk} → ${shrunken}): ${msg.slice(0, 80)}`);
                currentChunk = shrunken;
                continue;
            }
            throw err;
        }
        for (const log of logs) {
            const addr = log.address.toLowerCase();
            const existing = emitters.get(addr);
            if (existing) {
                existing.pairCreatedCount++;
                existing.lastBlockSeen = Math.max(existing.lastBlockSeen, log.blockNumber);
                existing.firstBlockSeen = Math.min(existing.firstBlockSeen, log.blockNumber);
                existing.matchedTopics.add(topicLabel);
            } else {
                emitters.set(addr, {
                    address: addr,
                    pairCreatedCount: 1,
                    firstBlockSeen: log.blockNumber,
                    lastBlockSeen: log.blockNumber,
                    matchedTopics: new Set([topicLabel]),
                });
            }
        }
        const pct = ((end - fromBlock) / Math.max(1, toBlock - fromBlock) * 100).toFixed(1);
        process.stdout.write(
            `\r  [${topicLabel}] scanning ${start}-${end} (${pct}%) — ${emitters.size} unique factories`
        );
        start = end + 1;
    }
    process.stdout.write('\n');
    return emitters;
}

// -----------------------------------------------------------------------------

export async function findFactories(chainName: string, opts: FindOptions = {}): Promise<{
    candidates: FactoryCandidate[];
    unknown: FactoryCandidate[];
    knownCount: number;
    /** Emitters on conf/<chain>-blacklist.json5 — neither known nor unknown. */
    blacklisted: FactoryCandidate[];
    scannedRange: { from: number; to: number };
    aborted: boolean;
}> {
    const cfg = loadChainConfig(chainName);
    const provider = makeProvider(cfg.chain);

    const chunkSize = opts.chunkSize ?? 10_000;

    // Resolve block range with these precedence rules:
    //
    //   Both fromBlock and toBlock explicit  → exact range (lookback ignored)
    //   Only fromBlock                       → from → from + lookback   (or head if smaller)
    //   Only toBlock                         → to - lookback → to
    //   Only lookback                        → head - lookback → head
    //   Nothing specified                    → 0 → head  (full chain scan)
    //
    // The full-chain default only makes sense because HyperSync is fast enough
    // to make it practical. For chains without HyperSync configured (or with
    // RPC transport), the CLI warns before starting.
    const lookback = opts.lookbackBlocks;

    // Transport selection. Auto priority: envio > hypersync > etherscan > rpc.
    // Explicit --transport <name> overrides. Missing prereqs cause a clear
    // error, not a silent fallback (fallback silently downgrading from
    // hypersync to rpc would confuse someone doing a large sweep).
    const explicit = opts.transport && opts.transport !== 'auto';
    const hypersyncUrl   = cfg.chain.hypersyncUrl;
    const envioToken     = process.env.ENVIO_API_TOKEN;
    const canHyperSync   = Boolean(hypersyncUrl && envioToken && await hypersyncUp(hypersyncUrl, envioToken));
    const canEtherscan   = Boolean(opts.explorerApiKey);
    const envio          = EnvioRest.fromEnv();
    // The indexer answers "factories created since N", not "emitters active in
    // a window", so a --lookback / --to-block sweep can't be asked of it.
    const windowed       = lookback !== undefined || opts.toBlock !== undefined;

    let chosen: 'envio' | 'hypersync' | 'etherscan' | 'rpc';
    if (opts.transport === 'envio') {
        if (!envio)   throw new Error(`--transport envio but ENVIO_REST_URL not set in .env`);
        if (windowed) throw new Error(`--transport envio takes --from-block (or --new) only: it finds factories by their first pool, not by activity in a window`);
        chosen = 'envio';
    } else if (opts.transport === 'hypersync') {
        if (!hypersyncUrl) throw new Error(`--transport hypersync but ${cfg.chain.name} has no hypersyncUrl in @chains.json5`);
        if (!envioToken)   throw new Error(`--transport hypersync but ENVIO_API_TOKEN not set in .env`);
        chosen = 'hypersync';
    } else if (opts.transport === 'etherscan') {
        if (!canEtherscan) throw new Error(`--transport etherscan but ETHERSCAN_API_KEY not set in .env`);
        chosen = 'etherscan';
    } else if (opts.transport === 'rpc') {
        chosen = 'rpc';
    } else {
        // auto
        if      (envio && !windowed) chosen = 'envio';
        else if (canHyperSync)  chosen = 'hypersync';
        else if (canEtherscan)  chosen = 'etherscan';
        else                    chosen = 'rpc';
    }

    // With envio the range ends where the indexer has got to: its answer says
    // nothing about the blocks past that, so they must not count as swept.
    const head = chosen === 'envio' ? await envio!.processed(cfg.chain.id) : await provider.getBlockNumber();

    let from: number;
    let to: number;
    if (opts.sinceBlock !== undefined) {
        from = opts.sinceBlock;
        to   = head;
    } else if (chosen === 'envio') {
        // Its --from-block means "first pool at or after", so the range runs to
        // the head rather than a lookback window.
        from = opts.fromBlock ?? 0;
        to   = head;
    } else if (opts.fromBlock !== undefined && opts.toBlock !== undefined) {
        from = opts.fromBlock;
        to   = opts.toBlock;
    } else if (opts.fromBlock !== undefined) {
        from = opts.fromBlock;
        to   = Math.min(head, opts.fromBlock + (lookback ?? 100_000));
    } else if (opts.toBlock !== undefined) {
        to   = opts.toBlock;
        from = Math.max(0, opts.toBlock - (lookback ?? 100_000));
    } else if (lookback !== undefined) {
        to   = head;
        from = Math.max(0, head - lookback);
    } else {
        // No constraints — sweep genesis to head. Fast with HyperSync.
        to   = head;
        from = 0;
    }
    // from = to + 1 is an empty range, not an error: --new right after a sweep.
    if (to < from - 1) throw new Error(`Bad block range: from=${from} > to=${to}`);
    const totalBlocks = to - from + 1;
    const isFullChainScan = opts.fromBlock === undefined && opts.toBlock === undefined && opts.lookbackBlocks === undefined
        && opts.sinceBlock === undefined;

    console.log(`\nSweeping ${cfg.chain.name} for pool-creation emitters (V2/Solidly PairCreated, V3 PoolCreated, Algebra Pool)`);
    console.log(`  Range: blocks ${from} → ${to} (${totalBlocks} blocks${isFullChainScan ? ', full chain from genesis' : ''})`);
    console.log(`  Transport: ${chosen}${explicit ? ' (explicit)' : ' (auto)'}`);
    if (chosen === 'envio') console.log(`  The indexer has processed up to block ${head}; factories whose first pool is in range`);

    // If the user asked for a full-chain scan and HyperSync isn't available,
    // warn loudly — this will take a very long time via RPC or Etherscan.
    if (isFullChainScan && chosen !== 'envio') {
        const hasHyperSync = Boolean(cfg.chain.hypersyncUrl && process.env.ENVIO_API_TOKEN);
        const explicitOther = opts.transport && opts.transport !== 'auto' && opts.transport !== 'hypersync';
        if (!hasHyperSync || explicitOther) {
            console.log('');
            console.log('  [!] Full-chain scan without HyperSync will be slow.');
            console.log('      Add hypersyncUrl to @chains.json5 and set ENVIO_API_TOKEN in .env,');
            console.log('      or narrow the range with --lookback / --from-block / --to-block.');
        }
    }

    const emitters = new Map<string, FactoryCandidate>();
    const topics: Array<{ hash: string; label: EventLayout }> = [
        { hash: PAIR_CREATED_V2_TOPIC,      label: 'v2' },
        { hash: PAIR_CREATED_SOLIDLY_TOPIC, label: 'solidly' },
        // Velodrome V2 / Aerodrome V2: Solidly pools announced with
        // PoolCreated(..., bool indexed stable, ...). Without this topic the
        // biggest V2-style DEX on Base (and Optimism) never shows up at all.
        { hash: POOL_CREATED_VELODROME_TOPIC, label: 'velodrome' },
        { hash: POOL_CREATED_V3_TOPIC,      label: 'v3' },
        { hash: POOL_CREATED_AERODROME_TOPIC,   label: 'aerodrome' },
        { hash: POOL_CREATED_ALGEBRA_TOPIC, label: 'algebra' },
    ];

    // Periodic autosave via onProgress callback, if provided.
    let progressTimer: ReturnType<typeof setInterval> | null = null;
    if (opts.onProgress) {
        progressTimer = setInterval(() => opts.onProgress!(emitters), 15_000);
    }

    try {
        if (totalBlocks === 0) {
            console.log(`  Nothing to sweep: already swept to block ${to}`);
        } else if (chosen === 'envio') {
            for (const f of await envio!.factories(cfg.chain.id, from)) {
                if (f.firstBlock > to) continue;   // indexed after we read `processed`
                if (!f.layout) { console.log(`  [!] ${f.factory}: unknown family "${f.family}" from envio — skipped`); continue; }
                // One row per (factory, family): a factory emitting two shapes
                // is one candidate, like the log sweeps make it.
                const c = emitters.get(f.factory);
                if (c) {
                    c.pairCreatedCount += f.pairCount;
                    c.firstBlockSeen = Math.min(c.firstBlockSeen, f.firstBlock);
                    c.lastBlockSeen = Math.max(c.lastBlockSeen, f.lastBlock);
                    c.matchedTopics.add(f.layout);
                } else {
                    emitters.set(f.factory, {
                        address: f.factory, pairCreatedCount: f.pairCount,
                        firstBlockSeen: f.firstBlock, lastBlockSeen: f.lastBlock,
                        matchedTopics: new Set([f.layout]),
                    });
                }
            }
            console.log(`  ${emitters.size} factories from envio`);
        }
        for (const topic of chosen === 'envio' || totalBlocks === 0 ? [] : topics) {
            if (opts.abortSignal?.aborted) break;
            console.log(`\n  Sweeping topic: ${topic.label}...`);
            switch (chosen) {
                case 'hypersync': {
                    const { sweepHyperSync } = await import('./hypersync.ts');
                    await sweepHyperSync(hypersyncUrl!, envioToken!, from, to, topic.hash, topic.label, emitters, opts.abortSignal);
                    break;
                }
                case 'etherscan':
                    await sweepEtherscan(cfg.chain.id, from, to, opts.explorerApiKey!, chunkSize, topic.hash, topic.label, emitters, opts.abortSignal);
                    break;
                case 'rpc':
                    await sweepRpc(provider, from, to, chunkSize, topic.hash, topic.label, emitters, opts.abortSignal);
                    break;
            }
        }
    } finally {
        if (progressTimer) clearInterval(progressTimer);
    }

    const candidates = Array.from(emitters.values())
        .sort((a, b) => b.pairCreatedCount - a.pairCreatedCount);

    // cfg.factories is already blacklist-filtered, so a blacklisted factory
    // would otherwise look "unknown" — re-verified every run, and put straight
    // back into the config by --add.
    const knownAddresses = new Set(cfg.factories.map(f => f.address.toLowerCase()));
    const black = blacklistedAddresses(cfg.chain.label);
    const blacklisted = candidates.filter(c => black.has(c.address) && !knownAddresses.has(c.address));
    const unknown = candidates.filter(c => !knownAddresses.has(c.address) && !black.has(c.address));

    return {
        candidates,
        unknown,
        knownCount: candidates.length - unknown.length - blacklisted.length,
        blacklisted,
        scannedRange: { from, to },
        aborted: opts.abortSignal?.aborted ?? false,
    };
}

// -----------------------------------------------------------------------------
// CLI

function isMain(): boolean {
    try {
        return realpathSync(process.argv[1]) === import.meta.url.replace(/^file:\/\//, '');
    } catch {
        return false;
    }
}

/**
 * Serialize the emitters map to a JSON-safe shape for autosave/dump.
 */
function serializeEmitters(emitters: Map<string, FactoryCandidate>): unknown {
    return Array.from(emitters.values())
        .sort((a, b) => b.pairCreatedCount - a.pairCreatedCount)
        .map(c => ({
            address: c.address,
            pairCreatedCount: c.pairCreatedCount,
            firstBlockSeen: c.firstBlockSeen,
            lastBlockSeen: c.lastBlockSeen,
            matchedTopics: Array.from(c.matchedTopics),
        }));
}

// -----------------------------------------------------------------------------
// Outcomes, proposals, discovery.json

export type CandidateOutcome = {
    status: 'verified' | 'unusable' | 'error' | 'not-verified';
    reason?: string;
    creator?: string;
    /** The DEX, per DefiLlama: by the factory's address in its adapter, or DexScreener's dexId. */
    dex?: { name: string; via: 'adapter' | 'dexscreener'; tvl: number };
    audit?: { fee?: string; accessor?: string; code?: string; notes: string[] };
    family?: string;
    contractName?: string;
    implementationName?: string;
    implementationAddress?: string;
    explorerVerified?: boolean;
    proposed?: { group: FactoryAddition['group']; key: string; entry: FactoryEntry; basis: string };
    addable?: boolean;
    heldBack?: string;
    added?: { group: string; key: string };
};

/**
 * Is a pattern matched by contract NAME borne out on-chain? Patterns with a
 * fee function need the interface probe to have answered through the same
 * accessor; name-only patterns (flat fee, fees hardcoded in swap()) have
 * nothing to call, so for them the name is all the evidence there is.
 */
export function patternConfirmed(pattern: DexPattern, r: Pick<VerifyResult, 'probedPattern'>): boolean {
    if (pattern.fee !== undefined || pattern.stableFees || !pattern.feeFunction) return true;
    const probed = r.probedPattern ? DEX_PATTERNS[r.probedPattern] : undefined;
    return !!probed && probed.feeFunction === pattern.feeFunction && probed.feeTarget === pattern.feeTarget
        && (probed.feeArgSource ?? 'pair-address') === (pattern.feeArgSource ?? 'pair-address') && probed.feeDivisor === pattern.feeDivisor;
}

/**
 * Swap callbacks every FlashArbExecutor since V3 hops pays by name. Anything
 * else the verifier records is still (int256,int256,bytes)-shaped, and an
 * executor with V3_ANY_CALLBACK pays it through its fallback — so those are
 * added too, with a note; attempt.ts refuses them at trade time on an older
 * executor.
 */
const EXECUTOR_CALLBACKS = new Set(['uniswapV3SwapCallback', 'pancakeV3SwapCallback', 'algebraSwapCallback']);
const PROBE_CONFIDENT = new Set(['high', 'medium']);

/** Everything auditCandidate needs, once per run. */
async function auditContext(chainArg: string, claude: boolean): Promise<AuditContext> {
    const cfg = loadChainConfig(chainArg);
    const provider = sharedProvider(cfg.chain);
    const logDir = path.join(PROJECT_ROOT, 'log', cfg.chain.label);
    mkdirSync(logDir, { recursive: true });
    const hubs = await hubTokens(cfg, provider);
    if (!hubs.length) console.log('// [!] no hub tokens known for this chain — audits only see recently created pairs');
    const anthropic = process.env.ANTHROPIC_API_KEY;
    return {
        provider, hubs, trusted: new Set(hubs), codeCacheFile: path.join(logDir, 'pair-code-cache.json'),
        fees: {
            provider, chainId: cfg.chain.id, rpcUrl: cfg.chain.host, group: 'v2', etherscanKey: process.env.ETHERSCAN_API_KEY,
            hypersync: cfg.chain.hypersyncUrl && process.env.ENVIO_API_TOKEN ? { url: cfg.chain.hypersyncUrl, apiToken: process.env.ENVIO_API_TOKEN } : undefined,
            claude: claude && anthropic ? { all: false, allowHeimdall: true, apiKey: anthropic, cacheFile: path.join(logDir, 'fee-analysis-cache.json') } : undefined,
        },
    };
}

/** The snippet was rendered before the audits: show what will actually be written. */
export function withEntryFacts(snippet: string, entry: FactoryEntry | undefined): string {
    if (!entry) return snippet;
    let out = entry.fee != null ? snippet.replace(/^(\s*)fee: [\d.e-]+.*$/m, `$1fee: ${entry.fee}`) : snippet;
    const facts = [entry.creator && `creator: "${entry.creator}",`, entry.dex && `dex: ${JSON.stringify(entry.dex)},`].filter(Boolean);
    if (facts.length) out = out.replace(/^(\s*)address: .*$/m, m => `${m}\n${facts.map(f => `${/^\s*/.exec(m)![0]}${f}`).join('\n')}`);
    return out;
}

/** Longest one candidate's audits may take: a heimdall decompile alone may run 180s. */
const AUDIT_TIMEOUT_MS = 300_000;

/** Creator and DEX onto the proposed entry, then the audits' verdict onto the outcome. */
async function annotateOutcome(
    o: CandidateOutcome,
    v: VerifyResult | V3VerifyResult,
    dexId: string | null | undefined,
    llama: LlamaIndex | null,
    auditing: AuditContext | null,
): Promise<void> {
    if (v.creator) o.creator = v.creator;
    const dex = llama ? identifyDex(llama, v.address, dexId) : null;
    if (dex) { o.dex = dex; console.log(`// ${v.address}: DefiLlama "${dex.name}" (${dex.via === 'adapter' ? 'address in its adapter' : `dexId ${dexId}`})`); }
    if (!o.proposed) return;
    const entry = o.proposed.entry as FactoryEntry;
    if (v.creator) entry.creator = v.creator;
    if (dex) entry.dex = dex.name;
    if (!auditing) return;

    const recent: Sample[] = 'samplePairs' in v ? v.samplePairs : [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const factory = asFactory(o.proposed.group as NormalizedFactory['group'], o.proposed.key, entry);
        const a = await Promise.race([
            auditCandidate(auditing, factory, recent),
            new Promise<never>((_, no) => { timer = setTimeout(() => no(new Error(`audit exceeded ${AUDIT_TIMEOUT_MS / 1000}s`)), AUDIT_TIMEOUT_MS); }),
        ]);
        o.audit = {
            fee: a.fee && `${a.fee.status}${a.fee.finalFee != null ? ` ${a.fee.finalFee} (${a.fee.source})` : ''}`,
            accessor: a.accessor && `${a.accessor.status}: ${a.accessor.detail}`,
            code: a.code && `${a.code.report.verdict}${a.code.note ? ` (${a.code.note})` : ''}`,
            notes: a.notes,
        };
        const effect = auditEffect(o.proposed.group, a);
        console.log(`// ${v.address}: audit fee ${o.audit.fee ?? (o.audit.accessor ?? '-')}, code ${o.audit.code ?? '-'}${effect.hold ? ` — HELD: ${effect.hold}` : ''}`);
        if (effect.setFee != null) { entry.fee = effect.setFee; o.addable = true; o.heldBack = undefined; }
        if (effect.basis) o.proposed.basis = `${o.proposed.basis}; ${effect.basis}`;
        if (effect.hold) { o.addable = false; o.heldBack = effect.hold; }
    } catch (err) {
        console.log(`// ${v.address}: audit failed, nothing changed: ${(err as Error).message.slice(0, 160)}`);
        o.audit = { notes: [`audit failed: ${(err as Error).message.slice(0, 200)}`] };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * The config entry for a verified factory, and whether --add may write it.
 *
 * Addable means every field the pipeline needs to price the factory's pools
 * was MEASURED or matched a registered DEX pattern — never guessed:
 *   v3 / algebra   fee tiers, event layout and callback read from real pools;
 *                  any (int256,int256,bytes) callback; an unknown name needs V3_ANY_CALLBACK
 *   pattern hit    the contract (or its implementation) is a registered DEX
 *   v2fee/solidly  the interface probe found the fee accessor (high/medium)
 *   v2             the fee was derived from swap() bytecode; an ASSUMED fee
 *                  only with --add-assumed-fees
 */
export function proposeEntry(
    c: FactoryCandidate,
    key: string,
    v: VerifyResult | V3VerifyResult,
    pattern: DexPattern | null,
    addAssumedFees: boolean,
): Pick<CandidateOutcome, 'proposed' | 'addable' | 'heldBack'> {
    const deployBlock = v.deployBlock ?? undefined;
    if (v.family === 'v3' || v.family === 'algebra') {
        const r = v as V3VerifyResult;
        const entry: FactoryEntry = r.family === 'v3'
            ? { address: c.address, deployBlock, poolEvent: r.poolEvent ?? undefined, callback: r.callback ?? undefined }
            : { address: c.address, deployBlock, ...({ algebraVariant: r.algebraVariant ?? 'integral' } as object) } as FactoryEntry;
        const group = r.family as 'v3' | 'algebra';   // narrowed by the if above
        const proposed = { group, key, entry, basis: `measured: fees ${r.feesSeen.join('/')} pips${r.callback ? `, callback ${r.callback}` : ''}` };
        if (r.callback && !EXECUTOR_CALLBACKS.has(r.callback)) {
            return { proposed: { ...proposed, basis: `${proposed.basis} — needs an executor with V3_ANY_CALLBACK (yarn deploy flasharb)` }, addable: true };
        }
        return { proposed, addable: true };
    }

    const r = v as VerifyResult;
    const velodrome = c.matchedTopics.has('velodrome') ? 'velodrome' as const : undefined;
    // A contract NAME is not proof of the fee accessor: "PairFactory" and
    // "PoolFactory" are what half of all Solidly forks are called. A pattern
    // whose fee is read through a function is trusted only when the on-chain
    // probe answered through that same accessor; otherwise the probe's own
    // answer (below) decides. Name-only patterns (a flat fee, or fees
    // hardcoded in swap()) have nothing to call, so the name is all there is.
    let nameNote = '';
    if (pattern && !patternConfirmed(pattern, r)) {
        nameNote = `name matches a registered pattern whose fee call did not answer on-chain${r.probedPattern ? `; probe found ${r.probedPattern}` : ''}`;
        pattern = null;
    }
    if (pattern) {
        const entry: FactoryEntry = { address: c.address, deployBlock, poolEvent: velodrome };
        if (pattern.hasStableFlag) entry.hasStableFlag = true;
        if (pattern.fee !== undefined) entry.fee = pattern.fee;
        else if (pattern.stableFees) entry.stableFees = pattern.stableFees;
        else {
            if (pattern.feeTarget) entry.feeTarget = pattern.feeTarget;
            if (pattern.feeArgSource && pattern.feeArgSource !== 'pair-address') entry.feeArgSource = pattern.feeArgSource;
            if (pattern.feeFunction) entry.feeFunction = pattern.feeFunction;
            if (pattern.feeDivisor) entry.feeDivisor = pattern.feeDivisor;
        }
        return { proposed: { group: pattern.family, key, entry, basis: 'registered DEX pattern' }, addable: true };
    }
    if (r.family === 'v2fee' || r.family === 'solidly') {
        const entry: FactoryEntry = { address: c.address, deployBlock, poolEvent: r.family === 'solidly' ? r.poolEvent : undefined };
        if (r.probedFlatFee !== undefined) entry.fee = r.probedFlatFee;
        else {
            if (r.probedFeeTarget) entry.feeTarget = r.probedFeeTarget;
            if (r.probedFeeArgSource && r.probedFeeArgSource !== 'pair-address') entry.feeArgSource = r.probedFeeArgSource as FactoryEntry['feeArgSource'];
            if (r.probedFeeFunction) entry.feeFunction = r.probedFeeFunction;
            if (r.probedFeeDivisor) entry.feeDivisor = r.probedFeeDivisor;
        }
        if (r.probedHasStableFlag || (r.family === 'v2fee' && !r.probedPattern)) entry.hasStableFlag = true;
        const proposed = { group: r.family, key, entry, basis: (r.probedPattern ? `probed ${r.probedPattern} [${r.probedConfidence}]` : 'no fee accessor found') + (nameNote ? ` (${nameNote})` : '') };
        if (!r.probedPattern) return { proposed, addable: false, heldBack: 'per-pair fee accessor unknown — configure feeTarget/feeFunction/feeDivisor by hand' };
        if (!PROBE_CONFIDENT.has(r.probedConfidence ?? '')) return { proposed, addable: false, heldBack: `fee probe confidence ${r.probedConfidence}` };
        return { proposed, addable: true };
    }
    // pure v2
    const entry: FactoryEntry = { address: c.address, deployBlock, fee: r.fee ?? undefined };
    const proposed = { group: 'v2' as const, key, entry, basis: `fee ${r.fee} (${r.feeConfidence})${nameNote ? ` (${nameNote})` : ''}` };
    if (r.fee == null) return { proposed, addable: false, heldBack: 'fee undetermined' };
    if (r.feeConfidence === 'derived' || r.feeConfidence === 'probed') return { proposed, addable: true };
    if (addAssumedFees) return { proposed, addable: true };
    return { proposed, addable: false, heldBack: `fee ${r.fee} is ${r.feeConfidence} — pass --add-assumed-fees to add anyway, then check with yarn verify-fees` };
}

/** Write log/<chain>/discovery.json. Returns its path. */
function writeDiscovery(
    chainArg: string,
    result: Awaited<ReturnType<typeof findFactories>>,
    outcomes: Map<string, CandidateOutcome>,
): string {
    const label = loadChainConfig(chainArg).chain.label;
    const dir = path.join(PROJECT_ROOT, 'log', label);
    mkdirSync(dir, { recursive: true });
    const unknown = new Set(result.unknown.map(c => c.address));
    const black = new Set(result.blacklisted.map(c => c.address));
    const all = [...outcomes.values()];
    const doc = {
        chain: label,
        scannedAt: new Date().toISOString(),
        aborted: result.aborted,
        blockRange: result.scannedRange,
        totals: {
            candidates: result.candidates.length,
            known: result.knownCount,
            blacklisted: result.blacklisted.length,
            unknown: result.unknown.length,
            verified: all.filter(o => o.status === 'verified').length,
            addable: all.filter(o => o.addable).length,
            added: all.filter(o => o.added).length,
        },
        candidates: result.candidates.map(c => ({
            address: c.address,
            pairCount: c.pairCreatedCount,
            firstBlockSeen: c.firstBlockSeen,
            lastBlockSeen: c.lastBlockSeen,
            matchedTopics: [...c.matchedTopics],
            ...(black.has(c.address) ? { status: 'blacklisted' }
                : !unknown.has(c.address) ? { status: 'known' }
                : (outcomes.get(c.address) ?? { status: 'not-verified', reason: result.aborted ? 'sweep interrupted' : 'beyond --verify-limit' })),
        })),
    };
    const p = path.join(dir, 'discovery.json');
    writeFileSync(p, JSON.stringify(doc, null, 2));
    return p;
}

/**
 * Emit the full report — top unknowns, verification, config snippets. Used
 * both for natural completion and for Ctrl-C interruption. If `verify` is
 * false (used when interrupted), we skip the verification step to exit fast.
 */
async function emitReport(
    chainArg: string,
    result: Awaited<ReturnType<typeof findFactories>>,
    explorerApiKey: string | undefined,
    opts: { verify: boolean; verifyLimit: number; addAssumedFees: boolean; audit: boolean; claude: boolean },
): Promise<Map<string, CandidateOutcome>> {
    const { candidates, unknown, knownCount, scannedRange, aborted } = result;
    const outcomes = new Map<string, CandidateOutcome>();

    console.log('\n' + '═'.repeat(72));
    if (aborted) console.log(`Sweep INTERRUPTED at blocks ${scannedRange.from}-${scannedRange.to}`);
    else         console.log(`Sweep complete over blocks ${scannedRange.from}-${scannedRange.to}`);
    console.log(`  Unique factories emitting a pool-creation event: ${candidates.length}`);
    console.log(`  Known (already in config): ${knownCount}`);
    if (result.blacklisted.length) console.log(`  Blacklisted (skipped): ${result.blacklisted.length}`);
    console.log(`  Unknown (candidates to investigate): ${unknown.length}`);
    console.log('═'.repeat(72));

    if (unknown.length === 0) {
        console.log('\nNo new factories found — you already know about all active ones.');
        return outcomes;
    }

    console.log('\nTop unknown factories by activity:\n');
    for (const c of unknown.slice(0, 20)) {
        const topicHint = Array.from(c.matchedTopics).join('+');
        console.log(`  [${topicHint.padEnd(11)}] ${c.address}  (${c.pairCreatedCount} ${isClCandidate(c) ? 'pools' : 'pairs'}, blocks ${c.firstBlockSeen}-${c.lastBlockSeen})`);
    }
    if (unknown.length > 20) {
        console.log(`  ... and ${unknown.length - 20} more`);
    }

    if (!opts.verify) {
        console.log('\n[!] Skipping verification step (interrupted). Re-run without interrupt to verify these candidates.');
        return outcomes;
    }

    const toVerify = opts.verifyLimit > 0 ? unknown.slice(0, opts.verifyLimit) : unknown;
    console.log(`\n─${'─'.repeat(71)}`);
    // For big verify runs, give a rough time estimate so nobody accidentally
    // kicks off thousands of RPC calls thinking it'll be quick.
    if (toVerify.length >= 100) {
        const estMinutes = Math.ceil((toVerify.length * 5) / 60);
        console.log(`Verifying ${toVerify.length} candidates (rough estimate ~${estMinutes} min at 5s/candidate)`);
        console.log(`Ctrl-C to abort — sweep results are already saved.`);
    } else {
        console.log(`Verifying top ${toVerify.length} candidates...`);
    }
    console.log(`─${'─'.repeat(71)}\n`);

    // Each verify makes many RPC calls (getCode, getLogs chunks, eth_call).
    // On flaky/rate-limited RPCs any one can hang indefinitely. Cap each
    // candidate at 60s so we surface "RPC too slow" instead of hanging forever.
    const VERIFY_TIMEOUT_MS = 60_000;
    const withTimeout = <T,>(p: Promise<T>, ms: number, label: string): Promise<T> => {
        return new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms (RPC may be rate-limiting or unreachable)`)), ms);
            p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
        });
    };

    // Classifier signal: look up the verified contract name on the block
    // explorer. Turns anonymous `Factory_800b0526` into e.g. `MeshSwapFactory`
    // — an immediate quality signal (verified source = someone published it)
    // and often enough to identify a well-known DEX at a glance. Used for both
    // V2-family and V3 candidates; the config key is built from it.
    //
    // Proxy resolution: if the top-level contract name looks like a proxy
    // wrapper (TransparentUpgradeableProxy, ERC1967Proxy, BeaconProxy, etc.),
    // read EIP-1967 storage to find the implementation address, then look up
    // ITS contract name. The implementation name is what actually identifies
    // the DEX (e.g. "PairFactory" for Retro Finance behind its proxy).
    const resolveExplorerIdentity = async (address: string) => {
        let displayName: string | undefined;
        let explorerVerified = false;
        let implementationName: string | undefined;
        let implementationAddress: string | undefined;
        if (explorerApiKey) {
            try {
                const { getContractSourceInfo, rateLimit: esRateLimit } = await import('./etherscan.ts');
                await esRateLimit();
                const info = await withTimeout(
                    getContractSourceInfo(loadChainConfig(chainArg).chain.id, address, explorerApiKey),
                    10_000,
                    `getContractSourceInfo(${address})`,
                );
                if (info?.contractName) {
                    displayName = info.contractName;
                    explorerVerified = true;
                }
            } catch { /* best-effort; classifier tolerates missing name */ }
        }
        if (displayName && isProxyName(displayName)) {
            try {
                const proxyProvider = sharedProvider(loadChainConfig(chainArg).chain);
                const proxyInfo = await withTimeout(detectProxy(proxyProvider, address), 10_000, `detectProxy(${address})`);
                if (proxyInfo.isProxy && proxyInfo.implementation && explorerApiKey) {
                    implementationAddress = proxyInfo.implementation;
                    const { getContractSourceInfo, rateLimit: esRateLimit } = await import('./etherscan.ts');
                    await esRateLimit();
                    const implInfo = await withTimeout(
                        getContractSourceInfo(loadChainConfig(chainArg).chain.id, proxyInfo.implementation, explorerApiKey),
                        10_000,
                        `getContractSourceInfo(impl ${proxyInfo.implementation})`,
                    );
                    if (implInfo?.contractName) implementationName = implInfo.contractName;
                }
            } catch { /* proxy detect / impl lookup best-effort */ }
        }
        // Display: the implementation name when the top level is a proxy
        // wrapper (both shown, so the proxy hop is legible), else the top level.
        const effectiveName = implementationName ?? displayName;
        let nameNote = '';
        if (effectiveName) {
            nameNote = implementationName && displayName
                ? ` ["${displayName}" → "${implementationName}"]`
                : ` ["${effectiveName}"]`;
        } else if (explorerApiKey) {
            nameNote = ' [unverified on explorer]';
        }
        return { displayName, explorerVerified, implementationName, implementationAddress, nameNote };
    };

    // DexScreener check — surfaces raw dexId/liquidity for a sample pair or
    // pool so an unrecognized/suspicious factory (like Polygon's Panaromaswap)
    // is visible right in this report instead of needing a manual web search
    // later. See dexscreener.ts's scope note: this flags "worth a look", it
    // does not confirm anything on its own. DexScreener indexes V3 pools by
    // pool address the same way it indexes V2 pairs.
    const printDexScreener = async (pair: string): Promise<string | null> => {
        try {
            const { lookupPairOnDexScreener, isWellKnownDex } = await import('./dexscreener.ts');
            const dsInfo = await lookupPairOnDexScreener(chainArg, pair);
            if (dsInfo) {
                const flag = isWellKnownDex(dsInfo.dexId) ? '' : '  [!] not a well-known dexId — worth a manual look';
                const liq = dsInfo.liquidityUsd != null ? `$${dsInfo.liquidityUsd.toLocaleString()}` : 'unknown';
                console.log(`    DexScreener: dexId="${dsInfo.dexId}" pair=${dsInfo.baseSymbol}/${dsInfo.quoteSymbol} liquidity=${liq}${flag}`);
                console.log(`    ${dsInfo.url}`);
                return dsInfo.dexId;
            }
        } catch { /* best-effort — DexScreener lookup never blocks the report */ }
        return null;
    };

    // The verifiers read our indexer's pools when it has them; see samplePools.
    const envio = EnvioRest.fromEnv();
    const chainId = loadChainConfig(chainArg).chain.id;
    const indexed = async (address: string) => envio ? envio.samplePools(chainId, address).catch(() => null) : null;

    const verified: Array<{ candidate: FactoryCandidate; snippet: string; family: string; dexId?: string | null; contractName?: string; implementationName?: string; implementationAddress?: string; explorerVerified: boolean; result: VerifyResult | V3VerifyResult }> = [];
    for (const c of toVerify) {
        if (isClCandidate(c)) {
            console.log(`\n▶ Verifying ${c.address} (${c.pairCreatedCount} recent pools, concentrated liquidity)`);
            try {
                const { verifyV3Factory } = await import('./verify-v3-factory.ts');
                const v = await withTimeout(verifyV3Factory(chainArg, c.address, explorerApiKey, { known: await indexed(c.address) }), VERIFY_TIMEOUT_MS, `verifyV3Factory(${c.address})`);
                if (v.usable) {
                    const { displayName, explorerVerified, implementationName, implementationAddress, nameNote } =
                        await resolveExplorerIdentity(c.address);
                    const tag = v.family === 'algebra' ? `ALGEBRA ${v.algebraVariant}` : 'V3';
                    const how = v.family === 'algebra' ? '' : `, poolEvent ${v.poolEvent}`;
                    console.log(`  ✓ [${tag}] callback ${v.callback}${how}, fees ${v.feesSeen.join('/')} pips` +
                        (v.lensChecked ? ', YoBatches reads it' : '') + nameNote);
                    const dexId = v.samplePool ? await printDexScreener(v.samplePool) : null;
                    verified.push({
                        candidate: c, snippet: v.configSnippet, family: v.family, dexId,
                        contractName: displayName, implementationName, implementationAddress, explorerVerified, result: v,
                    });
                } else {
                    const reason = v.notes[v.notes.length - 1] ?? 'unknown reason';
                    console.log(`  ✗ Not usable: ${reason}`);
                    outcomes.set(c.address, { status: 'unusable', family: v.family, reason });
                }
            } catch (err) {
                console.log(`  ✗ Verification error: ${(err as Error).message.slice(0, 120)}`);
                outcomes.set(c.address, { status: 'error', reason: (err as Error).message.slice(0, 300) });
            }
            continue;
        }
        console.log(`\n▶ Verifying ${c.address} (${c.pairCreatedCount} recent pairs)`);
        try {
            const v = await withTimeout(
                verifyFactory(chainArg, c.address, explorerApiKey, await indexed(c.address)),
                VERIFY_TIMEOUT_MS,
                `verifyFactory(${c.address})`
            );
            if (v.isV2 && v.isYoBatchesCompatible && v.configSnippet) {
                const { displayName, explorerVerified, implementationName, implementationAddress, nameNote } =
                    await resolveExplorerIdentity(c.address);
                const feeInfo = v.family === 'v2fee' || v.family === 'solidly'
                    ? 'fee per-pair'
                    : `fee ${v.fee} (${v.feeConfidence})`;
                console.log(`  ✓ [${v.family.toUpperCase()}] YoBatches compatible, ${feeInfo}${nameNote}`);
                const dexId = v.samplePair ? await printDexScreener(v.samplePair) : null;
                verified.push({
                    candidate: c,
                    dexId,
                    snippet: v.configSnippet,
                    family: v.family,
                    contractName: displayName,
                    implementationName,
                    implementationAddress,
                    explorerVerified,
                    result: v,
                });
            } else {
                // The LAST note is not necessarily the reason: when the fee
                // probe ran after a failed YoBatches check, it printed
                // "Sample fees (1): 0.000500" for Velodrome V2 and hid why.
                const reason = (v.isV2 && !v.isYoBatchesCompatible
                    ? v.notes.find(n => /mismatch|doesn't implement|Failed to read/.test(n))
                    : undefined) ?? v.notes[v.notes.length - 1] ?? 'unknown reason';
                console.log(`  ✗ Not usable: ${reason}`);
                outcomes.set(c.address, { status: 'unusable', family: v.family, reason });
            }
        } catch (err) {
            console.log(`  ✗ Verification error: ${(err as Error).message.slice(0, 120)}`);
            outcomes.set(c.address, { status: 'error', reason: (err as Error).message.slice(0, 300) });
        }
    }

    const byFamily = { v2: 0, v2fee: 0, solidly: 0, v3: 0, algebra: 0 } as Record<string, number>;
    for (const v of verified) byFamily[v.family] = (byFamily[v.family] ?? 0) + 1;

    console.log('\n' + '═'.repeat(72));
    console.log(`RESULT: ${verified.length} verified factories ready to add`);
    console.log(`  Pure V2: ${byFamily['v2']}`);
    console.log(`  V2Fee:   ${byFamily['v2fee']}`);
    console.log(`  Solidly: ${byFamily['solidly']}`);
    console.log(`  V3 (CL): ${byFamily['v3']}`);
    console.log(`  Algebra: ${byFamily['algebra']}`);
    console.log('═'.repeat(72));

    if (verified.length > 0) {
        console.log(`\nSuggested additions to conf/${chainArg}.json5:\n`);
        // Load pattern registry lazily so this file doesn't hard-depend on it
        const { lookupDexPattern, renderPatternSnippet } = await import('./dex-patterns.ts');

        const conf = loadChainConfig(chainArg);
        const llama: LlamaIndex | null = await loadLlamaIndex(conf.chain.name, path.join(PROJECT_ROOT, 'log', conf.chain.label, 'llama-dex.json')).catch(() => null);
        if (!llama) console.log('// [!] DefiLlama unavailable — factories go unnamed by it this run');
        const auditing: AuditContext | null = opts.audit ? await auditContext(chainArg, opts.claude) : null;
        for (const { candidate, snippet, family, dexId, contractName, implementationName, implementationAddress, explorerVerified, result: vr } of verified) {
            // Naming rule for config keys: prefer the implementation's contract
            // name (real DEX identity) when we detected a proxy. Fall back to
            // the top-level contract name, then to a generic Factory_ prefix.
            // Always suffix with address-8 so JSON5 keys don't collide across
            // forks that share a common name.
            const nameForKey = implementationName ?? contractName;
            const configKey = nameForKey
                ? `${nameForKey}_${candidate.address.slice(2, 10)}`
                : `Factory_${candidate.address.slice(2, 10)}`;

            // Try the registered-pattern path first: if we recognize the
            // contract name (or the impl name behind a proxy) as a known
            // template, we can emit a pre-filled snippet with the right
            // family + feeTarget/feeFunction/feeDivisor and drop the
            // generic placeholder comments.
            // V3/Algebra snippets come straight from measurement; the pattern registry is V2-family only.
            const named = family === 'v3' || family === 'algebra' ? null : (lookupDexPattern(implementationName) ?? lookupDexPattern(contractName));
            // The name is a hint; the snippet below follows it only when the chain agrees.
            const pattern = named && patternConfirmed(named, vr as VerifyResult) ? named : null;
            if (named && !pattern) console.log(`// [!] named like a registered pattern, but its fee call did not answer on-chain — using the probe instead`);
            outcomes.set(candidate.address, {
                status: 'verified', family, contractName, implementationName, implementationAddress, explorerVerified,
                ...proposeEntry(candidate, configKey, vr, named, opts.addAssumedFees),
            });
            await annotateOutcome(outcomes.get(candidate.address)!, vr, dexId, llama, auditing);

            let nameHint = '';
            if (implementationName && contractName) {
                nameHint = ` (${contractName} proxy → impl "${implementationName}" at ${implementationAddress?.slice(0, 10)}...)`;
            } else if (contractName) {
                nameHint = ` (verified on explorer as "${contractName}")`;
            }
            console.log(`// ${candidate.pairCreatedCount} pairs in the sweep window${nameHint}`);

            const final = outcomes.get(candidate.address)?.proposed?.entry as FactoryEntry | undefined;
            if (pattern) {
                // Emit a snippet from the pattern registry.
                const groupComment = `    // Add under factories["${pattern.family}"]:`;
                // poolEvent comes from what the sweep SAW this factory emit,
                // never from the pattern: a contract name does not prove the
                // event, and the wrong one makes `yarn scan` find nothing.
                const body = renderPatternSnippet(
                    candidate.address,
                    // pattern.family override may differ from verify-factory's runtime family;
                    // that's the point of the registry — we trust the template match.
                    vr.deployBlock ?? undefined,
                    { ...pattern, poolEvent: candidate.matchedTopics.has('velodrome') ? 'velodrome' : undefined },
                );
                const patternNote = pattern.notes
                    ? `\n          // Pattern: ${pattern.notes}`
                    : '';
                console.log(withEntryFacts(
                    `${groupComment}\n` +
                    `        "${configKey}": {${patternNote}\n` +
                    `${body}\n` +
                    `        }`, final));
            } else {
                // Fall through to the verify-factory-generated snippet with
                // NAME_ME substitution.
                console.log(withEntryFacts(snippet.replace('NAME_ME', configKey), final));
            }
            console.log('');
        }
        console.log('IMPORTANT:');
        console.log('  1. Config keys already use the on-explorer contract name when available');
        console.log('     (with an address suffix to avoid duplicates). Rename to the DEX brand');
        console.log('     name ("QuickSwap", "MeshSwap") once you\'ve identified it.');
        console.log('  2. For pure V2 entries: VERIFY the fee — check pair swap() source for .mul(N) constant');
        console.log('  3. For solidly-* entries: the config comment says which factories group to use');
        console.log('  4. For v3 entries: callback is what the executor must implement for these pools;');
        console.log('     it was read from the pool bytecode, so trust it over the factory\'s name.');
        console.log('  5. For algebra entries: needs a YoBatches with getAlgebraState (yarn deploy-contract)');
        console.log('     and an executor with algebraSwapCallback before live trades.');
    }
    return outcomes;
}

if (isMain()) {
    const args = process.argv.slice(2);
    // Accept the chain name in any position — first non-flag arg wins.
    // This makes `yarn find-factories --verify-all polygon` work as expected
    // instead of interpreting `--verify-all` as the chain name.
    const chainArg = args.find(a => !a.startsWith('--'));
    if (!chainArg) {
        console.error('Usage: yarn find-factories <chain> [options]');
        console.error('');
        console.error('  --from-block N         Start block (default: 0 if nothing else set)');
        console.error('  --to-block N           End block   (default: chain head)');
        console.error('  --lookback N           Window size to combine with --from or --to,');
        console.error('                         or with nothing to mean "last N blocks from head"');
        console.error('');
        console.error('  Block-range precedence:');
        console.error('    both --from and --to  → exact range (--lookback ignored)');
        console.error('    only --from           → from → from + lookback (default 100k)');
        console.error('    only --to             → to - lookback → to');
        console.error('    only --lookback       → head - lookback → head');
        console.error('    nothing               → 0 → head  (full chain scan; needs HyperSync)');
        console.error('  --new                  From one past the block the last full sweep reached, to the head:');
        console.error('                         only factories that are new since then. Every sweep that covers');
        console.error('                         block 0 (or continues a saved one) saves where it got to.');
        console.error('');
        console.error('  --transport auto|envio|hypersync|etherscan|rpc  (default: auto)');
        console.error('    auto priority: envio > hypersync > etherscan > rpc (envio only without --lookback/--to-block)');
        console.error('    envio needs ENVIO_REST_URL (+ ENVIO_REST_SECRET) in .env: our own indexer, ../hyperindex/ronin.');
        console.error('      It finds factories by their FIRST pool (--from-block N: first pool at >= N) and stops at');
        console.error('      the block the indexer has processed, not the head.');
        console.error('    hypersync needs ENVIO_API_TOKEN in .env AND hypersyncUrl in @chains.json5');
        console.error('    etherscan needs ETHERSCAN_API_KEY in .env');
        console.error('    rpc works without keys but is much slower (only if RPC supports address-less log queries)');
        console.error('  --verify-limit N       Max candidates to verify (default: 20, 0 = skip)');
        console.error('  --no-audit             Skip the fee and pair-code audits of verified candidates');
        console.error('  --claude               Audits also have Claude read unresolved pairs (costs API money)');
        console.error('  --verify-all           Verify every unknown candidate (may take a long time on');
        console.error('                         chains with many hits; overrides --verify-limit)');
        console.error('  --autosave PATH        Write partial results as JSON every ~15s');
        console.error('  --add                  Write verified factories into conf/<chain>.json5 (comments');
        console.error('                         kept; only entries whose fee/callback were measured or match');
        console.error('                         a registered DEX pattern — see discovery.json for the rest)');
        console.error('  --add-assumed-fees     With --add: also add pure-V2 factories whose fee was only');
        console.error('                         ASSUMED (0.3%) — check them with yarn verify-fees after');
        console.error('');
        console.error('Every run writes log/<chain>/discovery.json: every candidate, its verdict, the');
        console.error('entry that would be added, and why anything was held back.');
        console.error('');
        console.error('Ctrl-C during a sweep flushes the partial report before exiting.');
        process.exit(1);
    }

    const getNum = (flag: string, dflt: number) => {
        const i = args.indexOf(flag);
        return (i >= 0 && args[i + 1]) ? parseInt(args[i + 1], 10) : dflt;
    };
    const getStr = <T extends string>(flag: string, dflt: T | undefined, allowed?: readonly T[]): T | undefined => {
        const i = args.indexOf(flag);
        if (i < 0 || !args[i + 1]) return dflt;
        const v = args[i + 1] as T;
        if (allowed && !allowed.includes(v)) return dflt;
        return v;
    };

    const fromBlock    = getNum('--from-block', -1);
    const toBlock      = getNum('--to-block',   -1);
    const lookback     = getNum('--lookback',   -1);
    // --verify-limit N     : verify top N candidates. Default 20. 0 = skip entirely.
    // --verify-all         : verify every unknown candidate (equivalent to --verify-limit Infinity).
    //                        On chains with 1000+ candidates this can take a long time.
    const verifyAll    = args.includes('--verify-all');
    const verifyLimit  = verifyAll ? Number.MAX_SAFE_INTEGER : getNum('--verify-limit', 20);
    const transport    = getStr('--transport', 'auto' as const, ['auto', 'envio', 'hypersync', 'etherscan', 'rpc'] as const)!;
    // --new: continue from the last sweep that reached the head. The mark lives
    // in the chain's DB (meta table), next to scan's per-factory progress.
    const SWEPT_KEY = 'find-factories.lastBlock';
    const onlyNew = args.includes('--new');
    if (onlyNew && (fromBlock >= 0 || toBlock >= 0 || lookback >= 0)) {
        console.error('--new picks its own range: drop --from-block / --to-block / --lookback');
        process.exit(1);
    }
    const readSwept = (): number | null => {
        const db = new ArbitradeDB(dbPath(chainArg));
        try {
            const v = db.getMeta(SWEPT_KEY);
            return v !== null && Number.isFinite(Number(v)) ? Number(v) : null;
        } finally { db.close(); }
    };
    const swept = readSwept();
    if (onlyNew) {
        console.log(swept === null
            ? '[i] --new: no saved sweep for this chain yet — sweeping all of it (and saving where it gets to)'
            : `[i] --new: the last sweep reached block ${swept} — sweeping from ${swept + 1}`);
    }
    const autosavePath = getStr('--autosave', undefined);
    const addToConf      = args.includes('--add');
    const addAssumedFees = args.includes('--add-assumed-fees');
    if (addAssumedFees && !addToConf) console.log('[!] --add-assumed-fees does nothing without --add');
    const explorerApiKey = process.env.ETHERSCAN_API_KEY;

    // AbortController wired to SIGINT so Ctrl-C flushes partial results.
    const controller = new AbortController();
    let sigintCount = 0;
    process.on('SIGINT', () => {
        sigintCount++;
        if (sigintCount === 1) {
            process.stdout.write('\n[!] Ctrl-C received — finishing current chunk, then emitting partial report. Press Ctrl-C again to force exit.\n');
            controller.abort();
        } else {
            process.stdout.write('\n[!] Force exit.\n');
            process.exit(130);
        }
    });

    // Autosave callback: dumps current emitter state to disk every ~15s.
    const fs = await import('node:fs');
    const onProgress = autosavePath
        ? (emitters: Map<string, FactoryCandidate>) => {
            try {
                fs.writeFileSync(autosavePath!, JSON.stringify(serializeEmitters(emitters), null, 2));
            } catch (err) {
                console.error(`  [!] Autosave failed: ${(err as Error).message}`);
            }
        }
        : undefined;

    if (autosavePath) console.log(`Autosaving progress to ${autosavePath} every ~15s`);

    let result: Awaited<ReturnType<typeof findFactories>>;
    try {
        result = await findFactories(chainArg, {
            fromBlock: fromBlock >= 0 ? fromBlock : undefined,
            toBlock:   toBlock >= 0   ? toBlock   : undefined,
            lookbackBlocks: lookback >= 0 ? lookback : undefined,
            sinceBlock: onlyNew && swept !== null ? swept + 1 : undefined,
            transport,
            explorerApiKey,
            abortSignal: controller.signal,
            onProgress,
        });
    } catch (err) {
        console.error(`\n[!] Fatal error: ${(err as Error).message}`);
        process.exit(1);
    }

    // Save how far the sweeps reach, unbroken from block 0: a sweep that starts
    // at or before the saved block + 1 extends it; a --lookback window that
    // leaves a gap does not, or --new would skip what is in the gap.
    if (!result.aborted && result.scannedRange.from <= (swept ?? -1) + 1 && result.scannedRange.to > (swept ?? -1)) {
        const db = new ArbitradeDB(dbPath(chainArg));
        try { db.setMeta(SWEPT_KEY, String(result.scannedRange.to)); } finally { db.close(); }
        console.log(`[i] Saved: swept to block ${result.scannedRange.to} — the next --new starts at ${result.scannedRange.to + 1}`);
    }

    // Write final autosave dump so the JSON reflects the definitive end state.
    if (autosavePath && onProgress) {
        // Rebuild an emitter Map view for one final flush
        const finalMap = new Map<string, FactoryCandidate>();
        for (const c of result.candidates) finalMap.set(c.address, c);
        onProgress(finalMap);
        console.log(`Final autosave written to ${autosavePath}`);
    }

    const outcomes = await emitReport(chainArg, result, explorerApiKey, {
        // If interrupted, skip verification so we exit fast — user can re-run
        // on the specific candidates they care about.
        verify: !result.aborted && verifyLimit > 0,
        verifyLimit,
        addAssumedFees,
        audit: !args.includes('--no-audit'),
        claude: args.includes('--claude'),
    });

    const addable = [...outcomes.entries()].filter(([, o]) => o.addable && o.proposed);
    const held = [...outcomes.entries()].filter(([, o]) => o.status === 'verified' && !o.addable);
    if (addToConf) {
        const label = loadChainConfig(chainArg).chain.label;
        console.log('\n' + '═'.repeat(72));
        if (addable.length === 0) {
            console.log(`--add: nothing qualifies to add to conf/${label}.json5`);
        } else {
            const today = new Date().toLocaleDateString('en-CA');   // local YYYY-MM-DD
            const additions: FactoryAddition[] = addable.map(([addr, o]) => {
                const c = result.unknown.find(x => x.address === addr)!;
                const name = o.implementationName ?? o.contractName;
                return {
                    group: o.proposed!.group, key: o.proposed!.key, entry: o.proposed!.entry,
                    comment: `find-factories --add ${today}: ${c.pairCreatedCount} ${o.family === 'v3' || o.family === 'algebra' ? 'pools' : 'pairs'} in sweep` +
                        `${name ? `, explorer "${name}"` : ', unverified on explorer'}${o.dex ? `, DefiLlama "${o.dex.name}"` : ''}; ${o.proposed!.basis}`,
                };
            });
            try {
                const added = addFactoriesToConf(path.join(PROJECT_ROOT, 'conf'), label, additions);
                added.forEach((a, i) => { outcomes.get(addable[i][0])!.added = a; });
                console.log(`--add: wrote ${added.length} factor${added.length === 1 ? 'y' : 'ies'} to conf/${label}.json5:`);
                for (const a of added) console.log(`  + factories.${a.group}.${a.key}`);
                console.log(`Next: yarn scan ${label} && yarn reserves ${label}` +
                    (addable.some(([, o]) => o.family === 'v2' && !/fee confirmed|fee \S+ → /.test(o.proposed!.basis)) ? `, and yarn verify-fees ${label} for the v2 fees` : ''));
            } catch (err) {
                console.log(`[!] --add failed, conf/${label}.json5 NOT modified: ${(err as Error).message}`);
            }
        }
        if (held.length) {
            console.log(`Held back (${held.length}) — details in discovery.json:`);
            for (const [addr, o] of held) console.log(`  - ${o.proposed?.key ?? addr}: ${o.heldBack}`);
        }
    } else if (addable.length) {
        console.log(`\n${addable.length} of these qualify for --add (rerun with --add to write them to the config).`);
    }

    try {
        console.log(`\nDiscovery log: ${path.relative(process.cwd(), writeDiscovery(chainArg, result, outcomes))}`);
    } catch (err) {
        console.log(`[!] could not write discovery.json: ${(err as Error).message}`);
    }

    console.log('');
    process.exit(result.aborted ? 130 : 0);
}
