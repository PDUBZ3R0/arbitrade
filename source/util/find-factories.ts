// -----------------------------------------------------------------------------
// DISCOVERY.JSON SCHEMA (planned for phases 2-5 of the classifier work)
//
// Every full sweep will write log/<chain>/discovery.json with every candidate
// factory it saw, all computed signals, and a verdict. This becomes the audit
// trail for the classifier: nothing is silently dropped, and future work
// (better heuristics, manual override, agent replays) can re-classify without
// re-scanning.
//
// Shape:
// {
//   "chain":     "polygon",
//   "scannedAt": "2026-08-26T10:33:00Z",
//   "blockRange": { "from": 0, "to": 92709906 },
//   "totalCandidates": 1243,
//   "knownInConfig":  5,
//   "tiers":     { "confident": 3, "optimistic": 6, "curious": 15, "rejected": 1219 },
//   "candidates": [
//     {
//       "address":         "0x800b052609c355ca8103e06f022aa30647ead60a",
//       "pairCount":       628,
//       "firstBlockSeen":  11791428,
//       "lastBlockSeen":   68402761,
//       "matchedTopics":   ["v2"],
//
//       // --- Signals (populated by classifier phases as they land) ---
//       "contractName":     "UniswapV2Factory",     // phase 1: etherscan name (DONE)
//       "explorerVerified": true,                    // phase 1: source is verified (DONE)
//       "compilerVersion":  "v0.5.16+commit.9c3226ce",// phase 1
//       "licenseType":      "GPL-3.0",               // phase 1
//       "deployBlock":      11633169,                // from verify-factory
//       "family":           "v2",                    // from verify-factory
//       "assumedFee":       0.003,                   // from verify-factory
//       "feeConfidence":    "assumed",               // from verify-factory
//
//       // Phase 2: liquidity + activity
//       "livePairCount":    412,      // pairs with non-zero reserves
//       "topPairTvlUsd":    284350,   // sum of top 20 pair TVLs, rough USD via native pair anchoring
//       "pairsAbove1kUsd":  67,
//       "pairsAbove10kUsd": 23,
//       "activePairsLast30d": 8,      // pairs created in last 30d
//       "stopped":          false,   // no new pairs in 90d
//
//       // Phase 3: classifier verdict
//       "tier":             "confident",    // confident | optimistic | curious | rejected
//       "reasons": [
//         "contract name matches known DEX pattern",
//         "top-pair TVL exceeds $100K threshold",
//         "still actively creating pairs"
//       ],
//       "rejectionReasons": [],   // populated when tier === 'rejected'
//
//       // Phase 5: auto-add
//       "autoAddedTo":      "conf/polygon-auto.json5"  // present if config was written
//     },
//     ...
//   ]
// }
//
// Design principles:
//   - Signals are additive: each phase adds fields but never removes them.
//   - Rejected candidates are FULLY represented, not filtered out — you can
//     always see why something was rejected, and override manually.
//   - `reasons` is human-readable and roughly ordered by weight.
//   - `tier` is derived from signals + thresholds at classify time. Re-running
//     with different `--confidence` bounds doesn't need a re-scan; just
//     replays the classifier over discovery.json.
// -----------------------------------------------------------------------------

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
// Emits a report with config snippets ready to paste into conf/{chain}.json5.
//
// Usage:
//   yarn find-factories <chain>                    # default lookback 100k blocks
//   yarn find-factories <chain> --lookback 500000  # wider sweep
//   yarn find-factories <chain> --transport rpc    # force RPC (usually needs paid tier)
//
// Notes:
//   - Only "active" factories show up (dormant ones haven't created pairs recently)
//   - Requires ETHERSCAN_API_KEY (default transport). RPC transport works only if
//     the RPC supports address-less log queries, which most free tiers don't.
//   - Rate-limited by Etherscan's ~4.5 calls/sec on free tier
// -----------------------------------------------------------------------------

import { ethers, JsonRpcProvider } from 'ethers';
import { realpathSync } from 'node:fs';
import { loadChainConfig } from './config.ts';
import { etherscanGetLogs, rateLimit, notifyRateLimit } from './etherscan.ts';
import { verifyFactory } from './verify-factory.ts';

const PAIR_CREATED_V2_TOPIC      = ethers.id('PairCreated(address,address,address,uint256)');
const PAIR_CREATED_SOLIDLY_TOPIC = ethers.id('PairCreated(address,address,bool,address,uint256)');

// -----------------------------------------------------------------------------

export type FactoryCandidate = {
    address: string;
    pairCreatedCount: number;
    firstBlockSeen: number;
    lastBlockSeen: number;
    matchedTopics: Set<'v2' | 'solidly'>;  // which PairCreated shape(s) this factory emits
};

export type FindOptions = {
    /** Explicit start block. If unset, computed as toBlock - lookbackBlocks. */
    fromBlock?: number;
    /** Explicit end block. If unset, defaults to current head. */
    toBlock?: number;
    /** Only used when fromBlock is unset; how far back from toBlock to look. */
    lookbackBlocks?: number;
    transport?: 'auto' | 'hypersync' | 'etherscan' | 'rpc';
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
    topicLabel: 'v2' | 'solidly',
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
    topicLabel: 'v2' | 'solidly',
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
    scannedRange: { from: number; to: number };
    aborted: boolean;
}> {
    const cfg = loadChainConfig(chainName);
    const provider = new JsonRpcProvider(cfg.chain.host);

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
    const head = await provider.getBlockNumber();
    const lookback = opts.lookbackBlocks;

    let from: number;
    let to: number;
    if (opts.fromBlock !== undefined && opts.toBlock !== undefined) {
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
    if (to < from) throw new Error(`Bad block range: from=${from} > to=${to}`);
    const totalBlocks = to - from + 1;
    const isFullChainScan = opts.fromBlock === undefined && opts.toBlock === undefined && opts.lookbackBlocks === undefined;

    console.log(`\nSweeping ${cfg.chain.name} for PairCreated emitters (both V2 and Solidly-native event shapes)`);
    console.log(`  Range: blocks ${from} → ${to} (${totalBlocks} blocks${isFullChainScan ? ', full chain from genesis' : ''})`);
    console.log(`  Transport: ${opts.transport ?? 'auto'}`);

    // If the user asked for a full-chain scan and HyperSync isn't available,
    // warn loudly — this will take a very long time via RPC or Etherscan.
    if (isFullChainScan) {
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
    const topics: Array<{ hash: string; label: 'v2' | 'solidly' }> = [
        { hash: PAIR_CREATED_V2_TOPIC, label: 'v2' },
        { hash: PAIR_CREATED_SOLIDLY_TOPIC, label: 'solidly' },
    ];

    // Periodic autosave via onProgress callback, if provided.
    let progressTimer: ReturnType<typeof setInterval> | null = null;
    if (opts.onProgress) {
        progressTimer = setInterval(() => opts.onProgress!(emitters), 15_000);
    }

    try {
        // Transport selection. Auto priority: hypersync > etherscan > rpc.
        // Explicit --transport <name> overrides. Missing prereqs cause a clear
        // error, not a silent fallback (fallback silently downgrading from
        // hypersync to rpc would confuse someone doing a large sweep).
        const explicit = opts.transport && opts.transport !== 'auto';
        const hypersyncUrl   = cfg.chain.hypersyncUrl;
        const envioToken     = process.env.ENVIO_API_TOKEN;
        const canHyperSync   = Boolean(hypersyncUrl && envioToken);
        const canEtherscan   = Boolean(opts.explorerApiKey);

        let chosen: 'hypersync' | 'etherscan' | 'rpc';
        if (opts.transport === 'hypersync') {
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
            if      (canHyperSync)  chosen = 'hypersync';
            else if (canEtherscan)  chosen = 'etherscan';
            else                    chosen = 'rpc';
        }
        console.log(`  Chosen transport: ${chosen}${explicit ? ' (explicit)' : ' (auto)'}`);

        for (const topic of topics) {
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

    const knownAddresses = new Set(cfg.factories.map(f => f.address.toLowerCase()));
    const unknown = candidates.filter(c => !knownAddresses.has(c.address));

    return {
        candidates,
        unknown,
        knownCount: candidates.length - unknown.length,
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

/**
 * Emit the full report — top unknowns, verification, config snippets. Used
 * both for natural completion and for Ctrl-C interruption. If `verify` is
 * false (used when interrupted), we skip the verification step to exit fast.
 */
async function emitReport(
    chainArg: string,
    result: Awaited<ReturnType<typeof findFactories>>,
    explorerApiKey: string | undefined,
    opts: { verify: boolean; verifyLimit: number },
) {
    const { candidates, unknown, knownCount, scannedRange, aborted } = result;

    console.log('\n' + '═'.repeat(72));
    if (aborted) console.log(`Sweep INTERRUPTED at blocks ${scannedRange.from}-${scannedRange.to}`);
    else         console.log(`Sweep complete over blocks ${scannedRange.from}-${scannedRange.to}`);
    console.log(`  Unique factories emitting PairCreated: ${candidates.length}`);
    console.log(`  Known (already in config): ${knownCount}`);
    console.log(`  Unknown (candidates to investigate): ${unknown.length}`);
    console.log('═'.repeat(72));

    if (unknown.length === 0) {
        console.log('\nNo new factories found — you already know about all active ones.');
        return;
    }

    console.log('\nTop unknown factories by activity:\n');
    for (const c of unknown.slice(0, 20)) {
        const topicHint = Array.from(c.matchedTopics).join('+');
        console.log(`  [${topicHint.padEnd(11)}] ${c.address}  (${c.pairCreatedCount} pairs, blocks ${c.firstBlockSeen}-${c.lastBlockSeen})`);
    }
    if (unknown.length > 20) {
        console.log(`  ... and ${unknown.length - 20} more`);
    }

    if (!opts.verify) {
        console.log('\n[!] Skipping verification step (interrupted). Re-run without interrupt to verify these candidates.');
        return;
    }

    const toVerify = unknown.slice(0, opts.verifyLimit);
    console.log(`\n─${'─'.repeat(71)}`);
    console.log(`Verifying top ${toVerify.length} candidates...`);
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

    const verified: Array<{ candidate: FactoryCandidate; snippet: string; family: string; contractName?: string; explorerVerified: boolean }> = [];
    for (const c of toVerify) {
        console.log(`\n▶ Verifying ${c.address} (${c.pairCreatedCount} recent pairs)`);
        try {
            const v = await withTimeout(
                verifyFactory(chainArg, c.address, explorerApiKey),
                VERIFY_TIMEOUT_MS,
                `verifyFactory(${c.address})`
            );
            if (v.isV2 && v.isYoBatchesCompatible && v.configSnippet) {
                // Classifier signal: look up the verified contract name on the
                // block explorer. Turns anonymous `Factory_800b0526` into e.g.
                // `MeshSwapFactory` — an immediate quality signal (verified source
                // = someone published it) and often enough to identify a
                // well-known DEX at a glance.
                let displayName: string | undefined;
                let explorerVerified = false;
                if (explorerApiKey) {
                    try {
                        const { getContractSourceInfo, rateLimit: esRateLimit } = await import('./etherscan.ts');
                        await esRateLimit();
                        const info = await withTimeout(
                            getContractSourceInfo(loadChainConfig(chainArg).chain.id, c.address, explorerApiKey),
                            10_000,
                            `getContractSourceInfo(${c.address})`,
                        );
                        if (info?.contractName) {
                            displayName = info.contractName;
                            explorerVerified = true;
                        }
                    } catch { /* best-effort; classifier tolerates missing name */ }
                }

                const feeInfo = v.family === 'v2fee' || v.family === 'solidly'
                    ? 'fee per-pair'
                    : `fee ${v.fee} (${v.feeConfidence})`;
                const nameNote = displayName
                    ? ` ["${displayName}"]`
                    : (explorerApiKey ? ' [unverified on explorer]' : '');
                console.log(`  ✓ [${v.family.toUpperCase()}] YoBatches compatible, ${feeInfo}${nameNote}`);
                verified.push({
                    candidate: c,
                    snippet: v.configSnippet,
                    family: v.family,
                    contractName: displayName,
                    explorerVerified,
                });
            } else {
                console.log(`  ✗ Not usable: ${v.notes[v.notes.length - 1] ?? 'unknown reason'}`);
            }
        } catch (err) {
            console.log(`  ✗ Verification error: ${(err as Error).message.slice(0, 120)}`);
        }
    }

    const byFamily = { v2: 0, v2fee: 0, solidly: 0 } as Record<string, number>;
    for (const v of verified) byFamily[v.family] = (byFamily[v.family] ?? 0) + 1;

    console.log('\n' + '═'.repeat(72));
    console.log(`RESULT: ${verified.length} verified factories ready to add`);
    console.log(`  Pure V2: ${byFamily['v2']}`);
    console.log(`  V2Fee:   ${byFamily['v2fee']}`);
    console.log(`  Solidly: ${byFamily['solidly']}`);
    console.log('═'.repeat(72));

    if (verified.length > 0) {
        console.log(`\nSuggested additions to conf/${chainArg}.json5:\n`);
        for (const { candidate, snippet, contractName } of verified) {
            // Config-key naming rule: prefer the on-explorer contract name when
            // we have one, always suffixed with the address-8 to prevent JSON5
            // key collisions across factories that share a common name (e.g.
            // multiple forks all named `UniswapV2Factory`).
            const configKey = contractName
                ? `${contractName}_${candidate.address.slice(2, 10)}`
                : `Factory_${candidate.address.slice(2, 10)}`;
            const nameHint = contractName
                ? ` (verified on explorer as "${contractName}")`
                : '';
            console.log(`// ${candidate.pairCreatedCount} pairs in the sweep window${nameHint}`);
            console.log(snippet.replace('NAME_ME', configKey));
            console.log('');
        }
        console.log('IMPORTANT:');
        console.log('  1. Config keys already use the on-explorer contract name when available');
        console.log('     (with an address suffix to avoid duplicates). Rename to the DEX brand');
        console.log('     name ("QuickSwap", "MeshSwap") once you\'ve identified it.');
        console.log('  2. For pure V2 entries: VERIFY the fee — check pair swap() source for .mul(N) constant');
        console.log('  3. For solidly-* entries: the config comment says which factories group to use');
    }
}

if (isMain()) {
    const args = process.argv.slice(2);
    const chainArg = args[0];
    if (!chainArg || chainArg.startsWith('--')) {
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
        console.error('');
        console.error('  --transport auto|hypersync|etherscan|rpc  (default: auto)');
        console.error('    auto priority: hypersync > etherscan > rpc');
        console.error('    hypersync needs ENVIO_API_TOKEN in .env AND hypersyncUrl in @chains.json5');
        console.error('    etherscan needs ETHERSCAN_API_KEY in .env');
        console.error('    rpc works without keys but is much slower (only if RPC supports address-less log queries)');
        console.error('  --verify-limit N       Max candidates to verify (default: 20, 0 = skip)');
        console.error('  --autosave PATH        Write partial results as JSON every ~15s');
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
    const verifyLimit  = getNum('--verify-limit', 20);
    const transport    = getStr('--transport', 'auto' as const, ['auto', 'hypersync', 'etherscan', 'rpc'] as const)!;
    const autosavePath = getStr('--autosave', undefined);
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
            transport,
            explorerApiKey,
            abortSignal: controller.signal,
            onProgress,
        });
    } catch (err) {
        console.error(`\n[!] Fatal error: ${(err as Error).message}`);
        process.exit(1);
    }

    // Write final autosave dump so the JSON reflects the definitive end state.
    if (autosavePath && onProgress) {
        // Rebuild an emitter Map view for one final flush
        const finalMap = new Map<string, FactoryCandidate>();
        for (const c of result.candidates) finalMap.set(c.address, c);
        onProgress(finalMap);
        console.log(`Final autosave written to ${autosavePath}`);
    }

    await emitReport(chainArg, result, explorerApiKey, {
        // If interrupted, skip verification so we exit fast — user can re-run
        // on the specific candidates they care about.
        verify: !result.aborted && verifyLimit > 0,
        verifyLimit,
    });

    console.log('');
    process.exit(result.aborted ? 130 : 0);
}
