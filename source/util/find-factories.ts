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
    transport?: 'rpc' | 'etherscan';
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
    //   Neither                              → head - lookback → head
    //
    // This makes "start at X and go N blocks forward" (--from-block 250000 --lookback 50000)
    // do what you'd expect: scan 250000..300000.
    const head = await provider.getBlockNumber();
    const lookback = opts.lookbackBlocks ?? 100_000;

    let from: number;
    let to: number;
    if (opts.fromBlock !== undefined && opts.toBlock !== undefined) {
        from = opts.fromBlock;
        to   = opts.toBlock;
    } else if (opts.fromBlock !== undefined) {
        from = opts.fromBlock;
        to   = Math.min(head, opts.fromBlock + lookback);
    } else if (opts.toBlock !== undefined) {
        to   = opts.toBlock;
        from = Math.max(0, opts.toBlock - lookback);
    } else {
        to   = head;
        from = Math.max(0, head - lookback);
    }
    if (to < from) throw new Error(`Bad block range: from=${from} > to=${to}`);
    const totalBlocks = to - from + 1;

    console.log(`\nSweeping ${cfg.chain.name} for PairCreated emitters (both V2 and Solidly-native event shapes)`);
    console.log(`  Range: blocks ${from} → ${to} (${totalBlocks} blocks)`);
    console.log(`  Transport: ${opts.transport ?? 'auto'}`);

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
        for (const topic of topics) {
            if (opts.abortSignal?.aborted) break;
            console.log(`\n  Sweeping topic: ${topic.label}...`);
            if (opts.transport === 'rpc') {
                await sweepRpc(provider, from, to, chunkSize, topic.hash, topic.label, emitters, opts.abortSignal);
            } else {
                if (!opts.explorerApiKey) {
                    throw new Error(`ETHERSCAN_API_KEY not set — required for Etherscan transport. Set it in .env, or use --transport rpc if your RPC supports address-less log queries.`);
                }
                await sweepEtherscan(cfg.chain.id, from, to, opts.explorerApiKey, chunkSize, topic.hash, topic.label, emitters, opts.abortSignal);
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

    const verified: Array<{ candidate: FactoryCandidate; snippet: string; family: string }> = [];
    for (const c of toVerify) {
        console.log(`\n▶ Verifying ${c.address} (${c.pairCreatedCount} recent pairs)`);
        try {
            const v = await verifyFactory(chainArg, c.address, explorerApiKey);
            if (v.isV2 && v.isYoBatchesCompatible && v.configSnippet) {
                const feeInfo = v.family === 'solidly-v2' || v.family === 'solidly-native'
                    ? 'fee per-pair (Solidly)'
                    : `fee ${v.fee} (${v.feeConfidence})`;
                console.log(`  ✓ [${v.family.toUpperCase()}] YoBatches compatible, ${feeInfo}`);
                verified.push({ candidate: c, snippet: v.configSnippet, family: v.family });
            } else {
                console.log(`  ✗ Not usable: ${v.notes[v.notes.length - 1] ?? 'unknown reason'}`);
            }
        } catch (err) {
            console.log(`  ✗ Verification error: ${(err as Error).message.slice(0, 100)}`);
        }
    }

    const byFamily = { v2: 0, 'solidly-v2': 0, 'solidly-native': 0 } as Record<string, number>;
    for (const v of verified) byFamily[v.family] = (byFamily[v.family] ?? 0) + 1;

    console.log('\n' + '═'.repeat(72));
    console.log(`RESULT: ${verified.length} verified factories ready to add`);
    console.log(`  Pure V2:         ${byFamily['v2']}`);
    console.log(`  Solidly-v2:      ${byFamily['solidly-v2']}`);
    console.log(`  Solidly-native:  ${byFamily['solidly-native']}`);
    console.log('═'.repeat(72));

    if (verified.length > 0) {
        console.log(`\nSuggested additions to conf/${chainArg}.json5:\n`);
        for (const { candidate, snippet } of verified) {
            console.log(`// ${candidate.pairCreatedCount} pairs in the sweep window`);
            console.log(snippet.replace('NAME_ME', `Factory_${candidate.address.slice(2, 10)}`));
            console.log('');
        }
        console.log('IMPORTANT:');
        console.log('  1. Rename each "Factory_xxxxxxxx" to the DEX\'s real name');
        console.log('     (look up the factory on the block explorer — verified contracts are labeled)');
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
        console.error('  --from-block N         Start block (default: derived)');
        console.error('  --to-block N           End block   (default: derived)');
        console.error('  --lookback N           Window size (default: 100000)');
        console.error('');
        console.error('  Range resolution:');
        console.error('    both --from and --to  → exact range (--lookback ignored)');
        console.error('    only --from           → from → from + lookback');
        console.error('    only --to             → to - lookback → to');
        console.error('    neither               → head - lookback → head');
        console.error('');
        console.error('  --transport rpc|etherscan   (default: etherscan)');
        console.error('  --verify-limit N       Max candidates to verify (default: 10, 0 = skip)');
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
    const lookback     = getNum('--lookback',   100_000);
    const verifyLimit  = getNum('--verify-limit', 10);
    const transport    = getStr('--transport', 'etherscan' as const, ['rpc', 'etherscan'] as const)!;
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
            lookbackBlocks: lookback,
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
