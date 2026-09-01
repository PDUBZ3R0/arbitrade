// -----------------------------------------------------------------------------
// Reserves fetcher.
//
// Refreshes reserves for pairs in the DB by calling YoBatches, and for
// v2fee/solidly pairs, also fetches per-pair fee (and stable flag when the
// factory has hasStableFlag) via Multicall3.
//
// Pipeline per chain:
//   1. Query DB for pairs to refresh (optionally filtered by factory/max-age)
//   2. Group by factory
//   3. For each factory, batch YoBatches calls (~200 pairs per call)
//   4. Filter out zero-reserve pairs (dead pools = no arb opportunity)
//   5. Upsert non-zero reserves
//   6. For v2fee/solidly pairs missing metadata: batch fee (and optionally
//      stable) via Multicall3 — dispatched per feeTarget/feeFunction/feeDivisor
//   7. Update pairs table with fee/stable
//
// Fail-loud: if >80% of a factory's fee calls return no data, we throw with
// diagnostics pointing at the likely feeTarget/feeFunction misconfig instead
// of silently declaring "0 pairs updated" like the pre-fix Equalizer bug.
// -----------------------------------------------------------------------------

import { JsonRpcProvider, Interface } from 'ethers';
import type { ChainConfig, NormalizedFactory } from '../util/config.ts';
import { ArbitradeDB } from '../util/db.ts';
import { getReservesByPairs } from '../util/yobatches.ts';
import { multicall3, type Multicall3Call } from '../util/multicall.ts';

const RESERVES_BATCH_SIZE = 200;   // pairs per YoBatches call
const METADATA_BATCH_SIZE = 100;   // pairs per Multicall3 batch (each pair = 1-2 sub-calls)
const FAIL_LOUD_THRESHOLD = 0.80;  // stop if this fraction of fee calls return no data
const DEFAULT_CONCURRENCY = 4;     // fallback when chain config has no `threads` setting
const MAX_CONCURRENCY = 32;        // safety cap; higher hits Node's HTTP socket limit anyway

// Retry policy for transient RPC failures (read timeouts, connection reset,
// occasional -32700 from HyperRPC upstream). Real bugs will fail all attempts;
// transient issues almost always succeed on retry #2 or #3.
const RESERVES_RETRY_DELAYS_MS = [2000, 5000, 15000] as const;

/**
 * Fetch reserves for a batch with exponential backoff. Real errors bubble up
 * after all attempts fail; transient RPC timeouts almost always succeed on
 * the second or third attempt.
 *
 * Silently retries — only logs on failure of the final attempt (via the
 * caller's catch block).
 */
async function fetchReservesWithRetry(
    provider: JsonRpcProvider,
    contractAddr: string,
    triples: Array<[string, string, string]>,
): Promise<Awaited<ReturnType<typeof getReservesByPairs>>> {
    let lastErr: Error | undefined;
    for (let attempt = 0; attempt <= RESERVES_RETRY_DELAYS_MS.length; attempt++) {
        try {
            return await getReservesByPairs(provider, contractAddr, triples);
        } catch (err) {
            lastErr = err as Error;
            // No more attempts — propagate to caller
            if (attempt === RESERVES_RETRY_DELAYS_MS.length) break;
            const delayMs = RESERVES_RETRY_DELAYS_MS[attempt];
            const msg = (err as Error).message?.slice(0, 80) ?? String(err);
            process.stdout.write(`\n  [retry ${attempt + 1}/${RESERVES_RETRY_DELAYS_MS.length}] ${msg} — waiting ${delayMs}ms`);
            await new Promise(r => setTimeout(r, delayMs));
        }
    }
    throw lastErr!;
}

// pair.stable() is universal for v2fee pairs that have the flag (Shadow).
const pairStableIface = new Interface([
    'function stable() view returns (bool)',
]);

/**
 * Build an Interface for the fee-lookup function, choosing signature based
 * on where the function lives:
 *   feeTarget="factory": (address) view returns (uint256)  — Shadow, Equalizer
 *   feeTarget="pair":    () view returns (uint256)         — DXSwap
 */
// Build the ABI Interface for a factory/pair fee lookup. The function
// signature depends on both the target (factory vs pair) and, for factory
// targets, the argument source (pair address vs pair.stable bool).
function makeFeeIface(
    feeFunctionName: string,
    feeTarget: 'factory' | 'pair',
    feeArgSource: 'pair-address' | 'pair-stable' | 'pair-stable-degen' | 'pair-and-caller' = 'pair-address',
): Interface {
    let sig: string;
    if (feeTarget === 'pair') {
        sig = `function ${feeFunctionName}() view returns (uint256)`;
    } else if (feeArgSource === 'pair-stable-degen') {
        // PairFactory Retro-degen variant: factory.<fn>(bool stable, bool degen)
        sig = `function ${feeFunctionName}(bool stable, bool degen) view returns (uint256)`;
    } else if (feeArgSource === 'pair-stable') {
        // PairFactoryUpgradeable-style: factory.<fn>(bool stable)
        sig = `function ${feeFunctionName}(bool stable) view returns (uint256)`;
    } else if (feeArgSource === 'pair-and-caller') {
        // LeetSwapV2-style: factory.<fn>(address pair, address to)
        sig = `function ${feeFunctionName}(address pair, address to) view returns (uint256)`;
    } else {
        sig = `function ${feeFunctionName}(address pair) view returns (uint256)`;
    }
    return new Interface([sig]);
}

// v2fee/solidly factories express fees as raw uints with wildly different scales:
//   Shadow (Sonic):     factory.pairFee(pair)    → ppm     (divisor 1e6)
//   Equalizer (Sonic):  factory.getRealFee(pair) → wad     (divisor 1e18)
//   DXSwap (Gnosis):    pair.swapFee()           → bps     (divisor 1e4)
// Per-factory feeTarget/feeFunction/feeDivisor live in config.

// -----------------------------------------------------------------------------

export type FetchOptions = {
    /** Only refresh pairs from this factory (address, lowercase-matched) */
    factory?: string;
    /** Only refresh pairs whose reserves were updated more than N seconds ago */
    maxAgeSeconds?: number;
    /** If true, refetch fee/stable for solidly pairs even if already populated */
    refreshMetadata?: boolean;
    /**
     * If true, skip pairs whose factory is not in the current config.
     * Default: false (process everything, but warn once).
     */
    strict?: boolean;
    /**
     * Minimum human-readable reserve on BOTH sides of a pair for it to count
     * as "real liquidity" (non-dust). Value is in token units (raw/10^decimals),
     * so 0.01 means "at least 0.01 of each token". Default 0 = disabled.
     *
     * Requires the tokens table to be populated (`yarn tokens <chain>`); pairs
     * whose tokens don't have decimals recorded are conservatively kept.
     *
     * Pairs that pass non-zero but fail this check are counted as `dust` in
     * the factory summary — useful for identifying factories where all pairs
     * technically have reserves but none matter for arb.
     */
    dustThreshold?: number;
    /**
     * If true, after the run's summary auto-append DEAD factories to
     * conf/<chain>-blacklist.json5. Idempotent (existing entries skipped).
     */
    autoBlacklistDead?: boolean;
    /**
     * Max number of concurrent YoBatches calls per factory. Default: chain
     * config's `threads` setting, or 4 if unset. Capped at MAX_CONCURRENCY.
     * Higher values shorten wall time on fast RPCs (HyperRPC handles 8-16
     * easily); low-tier public RPCs may throttle at 4+.
     */
    concurrency?: number;
    /** Callback for progress updates */
    onProgress?: (info: {
        factoryName: string;
        batchIndex: number;
        batchCount: number;
        pairsInBatch: number;
        nonZero: number;
    }) => void;
};

export type FactoryLiquidityStats = {
    name: string;
    address: string;
    group: string;
    totalPairs: number;
    nonZeroPairs: number;    // reserves > 0 on both sides
    dustPairs: number;       // non-zero but below dustThreshold (or 0 if disabled)
    substantialPairs: number;// non-zero AND non-dust — the real-liquidity count
    ratio: number;           // substantialPairs / totalPairs (or nonZero/total if dust disabled)
};

export type FetchResult = {
    reservesUpdated: number;
    reservesSkipped: number;   // zero-reserve pairs
    metadataUpdated: number;
    orphanFactories: number;   // factories in DB but not in current config
    errors: string[];
    /**
     * Per-factory liquidity stats collected during the run. Used to flag
     * dead-scaffolding factories (0% non-zero) and mostly-dead factories
     * (<5% non-zero) in the summary.
     */
    factoryStats: FactoryLiquidityStats[];
};

// -----------------------------------------------------------------------------

/**
 * Refresh reserves and per-pair metadata for pairs on a chain.
 */
export async function fetchReserves(
    cfg: ChainConfig,
    dbFilePath: string,
    opts: FetchOptions = {},
): Promise<FetchResult> {
    if (!cfg.chain.contract) {
        throw new Error(`YoBatches is not deployed for ${cfg.chain.name} (chain.contract is unset in config).`);
    }
    const provider = new JsonRpcProvider(cfg.chain.host);
    const db = new ArbitradeDB(dbFilePath);
    const result: FetchResult = { reservesUpdated: 0, reservesSkipped: 0, metadataUpdated: 0, orphanFactories: 0, errors: [], factoryStats: [] };

    // Build factory lookup so we can identify group per pair.
    const factoriesByAddr = new Map<string, NormalizedFactory>();
    for (const f of cfg.factories) factoriesByAddr.set(f.address.toLowerCase(), f);
    const currentFactoryAddrs = Array.from(factoriesByAddr.keys());

    // Token decimals lookup for dust filter. Loaded once from the tokens table
    // (populated by `yarn tokens`). Empty map = no dust filtering happens.
    // Also seeded with flashloan tokens' decimals from config (higher trust).
    const decimalsByToken = new Map<string, number>();
    if (opts.dustThreshold && opts.dustThreshold > 0) {
        for (const t of cfg.flashloan?.tokens ?? []) {
            decimalsByToken.set(t.address.toLowerCase(), t.decimals);
        }
        try {
            const allPairs = db.getPairsForReservesFetch({ factoryAllowlist: currentFactoryAddrs });
            const tokenAddrs = new Set<string>();
            for (const p of allPairs) {
                tokenAddrs.add(p.token0.toLowerCase());
                tokenAddrs.add(p.token1.toLowerCase());
            }
            const tokenRows = db.getTokens(Array.from(tokenAddrs));
            let hits = 0;
            for (const [addr, row] of tokenRows) {
                if (row.decimals !== null && !decimalsByToken.has(addr)) {
                    decimalsByToken.set(addr, row.decimals);
                    hits++;
                }
            }
            console.log(`[dust filter] threshold=${opts.dustThreshold}; loaded decimals for ${hits + (cfg.flashloan?.tokens?.length ?? 0)} token(s) (of ${tokenAddrs.size} referenced)`);
            if (hits === 0 && (cfg.flashloan?.tokens?.length ?? 0) === 0) {
                console.log(`[dust filter] WARNING: tokens table is empty. Run 'yarn tokens ${cfg.chain.name.toLowerCase()}' first, or the dust filter will be a no-op.`);
            }
        } catch (err) {
            console.log(`[dust filter] Failed to load token decimals: ${(err as Error).message}`);
        }
    }

    // Detect orphan pairs (factory in DB but not in current config). Report them
    // and, in strict mode, filter them out of this run.
    const orphans = db.countOrphanPairs(currentFactoryAddrs);
    if (orphans.length > 0) {
        result.orphanFactories = orphans.length;
        const totalOrphanPairs = orphans.reduce((n, o) => n + o.count, 0);
        console.log(`\n[!] Found ${totalOrphanPairs} pair(s) from ${orphans.length} factor${orphans.length === 1 ? 'y' : 'ies'} not in current config:`);
        for (const o of orphans) console.log(`      ${o.factory}: ${o.count} pair(s)`);
        console.log(`    These were probably scanned by a previous config that included these factories.`);
        console.log(`    Fix: yarn reserves ${cfg.chain.name.toLowerCase()} --strict            (skip them this run)`);
        console.log(`         yarn db-clean ${cfg.chain.name.toLowerCase()}                     (delete them permanently)`);
        console.log('');
    }

    try {
        // Group all requested pairs by factory address
        const pairs = db.getPairsForReservesFetch({
            factory: opts.factory,
            maxAgeSeconds: opts.maxAgeSeconds,
            factoryAllowlist: opts.strict ? currentFactoryAddrs : undefined,
        });
        if (pairs.length === 0) {
            console.log('No pairs need refresh.');
            return result;
        }

        const byFactory = new Map<string, typeof pairs>();
        for (const p of pairs) {
            const key = p.factory.toLowerCase();
            const arr = byFactory.get(key) ?? [];
            arr.push(p);
            byFactory.set(key, arr);
        }

        console.log(`Refreshing reserves for ${pairs.length} pairs across ${byFactory.size} factories`);
        console.log(`YoBatches: ${cfg.chain.contract}`);

        // Resolve effective concurrency: CLI flag > chain.threads > default.
        // Capped at MAX_CONCURRENCY. Anything <= 0 becomes 1 (sequential).
        const rawConcurrency = opts.concurrency ?? (cfg.chain as any).threads ?? DEFAULT_CONCURRENCY;
        const concurrency = Math.max(1, Math.min(MAX_CONCURRENCY, Number(rawConcurrency) || DEFAULT_CONCURRENCY));
        if (concurrency > 1) {
            console.log(`Concurrency: ${concurrency} parallel batches per factory`);
        }

        for (const [factoryAddr, factoryPairs] of byFactory) {
            const factory = factoriesByAddr.get(factoryAddr);
            const factoryName = factory?.name ?? `(orphan) ${factoryAddr}`;
            const family = factory?.group ?? 'unknown';

            const batches = Math.ceil(factoryPairs.length / RESERVES_BATCH_SIZE);
            console.log(`\n[${factoryName}] ${factoryPairs.length} pairs (${family}), ${batches} batch(es)`);

            // Per-factory liquidity accumulator — tallies non-zero and dust
            // pairs across this factory's batches. `substantial` = non-zero AND
            // above the dust threshold; that's the real-liquidity count that
            // categorizes the factory as DEAD / MOSTLY DEAD / THIN / HEALTHY.
            let factoryNonZeroCount = 0;
            let factoryDustCount = 0;

            // Fetch head block ONCE per factory instead of per batch. Saves
            // one RPC round-trip per batch AND ensures all pairs in this
            // factory get labeled with a consistent block number. Cross-factory
            // drift is a few seconds — acceptable for arb.
            let headBlock: number;
            try {
                headBlock = await provider.getBlockNumber();
            } catch (err) {
                console.log(`  [!] Failed to fetch head block: ${(err as Error).message.slice(0, 100)} — skipping factory`);
                continue;
            }

            // Bounded-concurrency batch runner. Each worker pulls the next
            // batch index, processes it, updates the shared counters, and
            // repeats. Log a compact running counter (per-batch echo would
            // interleave chaotically with concurrent workers).
            let batchIdx = 0;
            let batchesDone = 0;
            const factoryStart = Date.now();

            const processBatch = async (i: number): Promise<void> => {
                const batch = factoryPairs.slice(i * RESERVES_BATCH_SIZE, (i + 1) * RESERVES_BATCH_SIZE);
                const triples: Array<[string, string, string]> = batch.map(p => [p.pair, p.token0, p.token1]);

                let reserves;
                try {
                    reserves = await fetchReservesWithRetry(provider, cfg.chain.contract!, triples);
                } catch (err) {
                    const msg = (err as Error).message ?? String(err);
                    result.errors.push(`${factoryName} batch ${i + 1}/${batches}: ${msg.slice(0, 200)}`);
                    process.stdout.write(`\n  [!] Batch ${i + 1}/${batches} failed after retries: ${msg.slice(0, 100)}\n`);
                    return;
                }

                // Filter zero-reserve pairs (dead pools)
                const nonZero = reserves.filter(r => r.reserves0 > 0n && r.reserves1 > 0n);
                const skipped = reserves.length - nonZero.length;
                result.reservesSkipped += skipped;
                factoryNonZeroCount += nonZero.length;

                // Dust detection
                if (opts.dustThreshold && opts.dustThreshold > 0 && decimalsByToken.size > 0) {
                    const pairByAddr = new Map(batch.map(b => [b.pair.toLowerCase(), b]));
                    for (const r of nonZero) {
                        const bp = pairByAddr.get(r.pair.toLowerCase());
                        if (!bp) continue;
                        const d0 = decimalsByToken.get(bp.token0.toLowerCase());
                        const d1 = decimalsByToken.get(bp.token1.toLowerCase());
                        if (d0 === undefined || d1 === undefined) continue;
                        const h0 = Number(r.reserves0) / (10 ** d0);
                        const h1 = Number(r.reserves1) / (10 ** d1);
                        if (h0 < opts.dustThreshold || h1 < opts.dustThreshold) {
                            factoryDustCount++;
                        }
                    }
                }

                const updated = db.upsertReserves(nonZero.map(r => ({
                    pair: r.pair,
                    reserves0: r.reserves0,
                    reserves1: r.reserves1,
                    blockNumber: headBlock,
                })));
                result.reservesUpdated += updated;

                opts.onProgress?.({
                    factoryName,
                    batchIndex: i + 1,
                    batchCount: batches,
                    pairsInBatch: batch.length,
                    nonZero: nonZero.length,
                });

                batchesDone++;
                // Compact single-line progress. Worker-safe (we just overwrite).
                process.stdout.write(
                    `\r  ${batchesDone}/${batches} batches done, ${result.reservesUpdated} total upserts`
                );
            };

            // Worker pool: exactly `concurrency` workers, each grabs the next
            // batch index atomically until none remain.
            const workers: Promise<void>[] = [];
            for (let w = 0; w < Math.min(concurrency, batches); w++) {
                workers.push((async () => {
                    while (true) {
                        const i = batchIdx++;
                        if (i >= batches) return;
                        await processBatch(i);
                    }
                })());
            }
            await Promise.all(workers);

            const factorySecs = ((Date.now() - factoryStart) / 1000).toFixed(1);
            process.stdout.write(`\n  [${factoryName}] done in ${factorySecs}s (block ${headBlock})\n`);

            // Record per-factory stats for the summary printed at end of run.
            const substantial = factoryNonZeroCount - factoryDustCount;
            result.factoryStats.push({
                name: factoryName,
                address: factoryAddr,
                group: family,
                totalPairs: factoryPairs.length,
                nonZeroPairs: factoryNonZeroCount,
                dustPairs: factoryDustCount,
                substantialPairs: substantial,
                ratio: factoryPairs.length > 0 ? substantial / factoryPairs.length : 0,
            });

            // Per-pair metadata pass — runs for v2fee and solidly groups.
            //   v2fee   : fetch fee; also fetch stable() if hasStableFlag
            //   solidly : fetch fee only (stable was populated at scan time)
            if (family === 'v2fee' || family === 'solidly') {
                if (!factory) throw new Error(`No config for factory ${factoryAddr} on chain`);
                const wantStable = family === 'v2fee' && factory.hasStableFlag;
                const metaCount = await fetchPerPairMetadata(
                    provider, db, factory, wantStable, opts.refreshMetadata ?? false,
                );
                result.metadataUpdated += metaCount;
                // Only print the per-pair method details when we actually used
                // the multicall (i.e. flat-fee mode wasn't triggered). Flat-fee
                // mode logs its own "applied fee=X" line inside the helper.
                if (factory.fee === undefined || factory.fee === null) {
                    console.log(
                        `  [${factoryName}] metadata: ${metaCount} pairs updated ` +
                        `(target=${factory.feeTarget}, fn=${factory.feeFunction}, divisor=${factory.feeDivisor}` +
                        `${wantStable ? ', +stable' : ''})`
                    );
                }
            }
        }

        // Summary: flag factories with suspiciously low real-liquidity rates.
        // "Real liquidity" = pairs with non-zero reserves AND above the dust
        // threshold (when configured). Three tiers based on substantial ratio:
        //   DEAD        (0 substantial pairs)                 — remove/blacklist
        //   MOSTLY DEAD (<5% substantial)                     — consider removing
        //   THIN        (5%–20% substantial)                  — advisory only
        //
        // When `--blacklist-dead` was passed and there are DEAD factories,
        // auto-append them to conf/<chain>-blacklist.json5.
        if (result.factoryStats.length > 0) {
            const dead   = result.factoryStats.filter(s => s.totalPairs > 0 && s.ratio === 0);
            const mostly = result.factoryStats.filter(s => s.totalPairs > 0 && s.ratio > 0    && s.ratio < 0.05);
            const thin   = result.factoryStats.filter(s => s.totalPairs > 0 && s.ratio >= 0.05 && s.ratio < 0.20);
            const totalDust = result.factoryStats.reduce((n, s) => n + s.dustPairs, 0);

            if (dead.length > 0 || mostly.length > 0 || thin.length > 0 || totalDust > 0) {
                console.log(`\n${'─'.repeat(72)}`);
                console.log(`Suspicious factories by liquidity signal:`);
                if (opts.dustThreshold && opts.dustThreshold > 0) {
                    console.log(`  Dust threshold: ${opts.dustThreshold} tokens (both sides). Dust pairs across run: ${totalDust}.`);
                }
                console.log(`${'─'.repeat(72)}`);

                const formatEntry = (s: typeof dead[0]): string => {
                    const dustNote = s.dustPairs > 0 ? ` [+${s.dustPairs} dust]` : '';
                    return `   ${s.name.padEnd(45)}  ${s.substantialPairs}/${s.totalPairs} pairs (${(s.ratio * 100).toFixed(1)}%)${dustNote}`;
                };

                if (dead.length > 0) {
                    console.log(`\n🚨 DEAD (0 pairs with real liquidity — likely CREATE2 spoof or abandoned):`);
                    for (const s of dead) console.log(formatEntry(s));
                    if (!opts.autoBlacklistDead) {
                        console.log(`\n   → To auto-blacklist these: re-run with --blacklist-dead`);
                        console.log(`   → Or manually add to conf/${cfg.chain.name.toLowerCase()}-blacklist.json5:`);
                        for (const s of dead) {
                            console.log(`       { address: "${s.address}", reason: "dead (0/${s.totalPairs} pairs)" },`);
                        }
                    }
                }

                if (mostly.length > 0) {
                    console.log(`\n⚠️  MOSTLY DEAD (<5% pairs with real liquidity):`);
                    for (const s of mostly.sort((a, b) => a.ratio - b.ratio)) console.log(formatEntry(s));
                    console.log(`   → Small contribution to arb surface; consider removing.`);
                }

                if (thin.length > 0) {
                    console.log(`\nℹ️  THIN (5%–20% pairs with real liquidity — advisory only):`);
                    for (const s of thin.sort((a, b) => a.ratio - b.ratio)) console.log(formatEntry(s));
                }

                console.log('');

                // --blacklist-dead: auto-append DEAD factories to the blacklist file.
                if (opts.autoBlacklistDead && dead.length > 0) {
                    const { appendToBlacklist } = await import('../util/blacklist.ts');
                    const chainLabel = cfg.chain.name.toLowerCase();
                    const entries = dead.map(s => ({
                        address: s.address,
                        reason:  `dead (0/${s.totalPairs} pairs with real liquidity)`,
                    }));
                    const { added, skipped } = appendToBlacklist(chainLabel, entries);
                    console.log(`[blacklist] Appended ${added} entry(ies) to conf/${chainLabel}-blacklist.json5 (${skipped} already present).`);
                    console.log(`[blacklist] Next scan/reserves/triangles/evaluate run will skip these factories.`);
                }
            }
        }
    } finally {
        db.close();
    }

    return result;
}

// -----------------------------------------------------------------------------

/**
 * Batch-fetch per-pair fee (and stable, when applicable) for a v2fee or
 * solidly factory. Uses Multicall3 to batch reads.
 *
 * Fails loud: throws with diagnostics if the first batch's fee calls come
 * back mostly empty — that's the signature of a wrong feeTarget/feeFunction.
 */
async function fetchPerPairMetadata(
    provider: JsonRpcProvider,
    db: ArbitradeDB,
    factory: NormalizedFactory,
    wantStable: boolean,
    refreshAll: boolean,
): Promise<number> {
    const targets = db.getPairsForMetadataFetch(factory.address, refreshAll);
    if (targets.length === 0) {
        // Diagnostic: distinguish "already populated" from "no pairs match".
        const totalForFactory = db.db.prepare('SELECT COUNT(*) AS n FROM pairs WHERE factory = ?')
            .get(factory.address.toLowerCase()) as { n: number };
        const withFee = db.db.prepare('SELECT COUNT(*) AS n FROM pairs WHERE factory = ? AND fee IS NOT NULL')
            .get(factory.address.toLowerCase()) as { n: number };
        if (refreshAll) {
            console.log(`  (no pairs found for factory=${factory.address} — check config address matches DB)`);
        } else if (totalForFactory.n === 0) {
            console.log(`  (no pairs in DB for factory=${factory.address} — has the scanner run?)`);
        } else if (withFee.n === totalForFactory.n) {
            console.log(`  (all ${totalForFactory.n} pairs already have fee populated — pass --refresh-metadata to re-fetch)`);
        } else {
            console.log(`  (unexpected: ${totalForFactory.n} pairs exist, ${withFee.n} have fee, but query returned 0)`);
        }
        return 0;
    }

    // Flat-fee fast path: some v2fee/solidly factories charge a uniform fee
    // for all pairs (e.g. Dystopia = 0.05% flat). If the config declares a
    // `fee` on the factory, use it directly — no multicall needed, and no
    // failure mode from a missing/mismatched feeFunction on-chain.
    //
    // This is the escape hatch for Solidly forks whose fee API doesn't fit
    // our single-feeFunction schema (Velodrome/Aerodrome-style stableFee +
    // volatileFee split, uniform-fee forks like Dystopia, or forks where
    // the fee is hardcoded in the pair's swap() and not queryable at all).
    if (factory.fee !== undefined && factory.fee !== null) {
        const updated = db.db.prepare(
            'UPDATE pairs SET fee = ? WHERE factory = ? AND fee IS NULL'
        ).run(factory.fee, factory.address.toLowerCase()).changes;
        const total = targets.length;
        console.log(
            `  Flat fee mode: applied fee=${factory.fee} to ${updated} pair(s) ` +
            `(config declares uniform fee for this factory; skipping metadata multicall)`
        );
        return updated;
    }

    // stableFees fast path: some factories hardcode fees in swap() based on
    // pair.stable (e.g. WhaleSwap = 0.04% stable, 0.25% volatile). Not
    // queryable on-chain — look up each pair's cached `stable` flag and
    // apply the corresponding fee via bulk UPDATE. Solidly-family only.
    if (factory.stableFees) {
        const { stable, volatile } = factory.stableFees;
        const stableApplied = db.db.prepare(
            `UPDATE pairs SET fee = ? WHERE factory = ? AND stable = 1 AND fee IS NULL`
        ).run(stable, factory.address.toLowerCase()).changes;
        const volatileApplied = db.db.prepare(
            `UPDATE pairs SET fee = ? WHERE factory = ? AND (stable = 0 OR stable IS NULL) AND fee IS NULL`
        ).run(volatile, factory.address.toLowerCase()).changes;
        const total = stableApplied + volatileApplied;
        console.log(
            `  Static per-type mode: applied stable=${stable} to ${stableApplied} pair(s) + ` +
            `volatile=${volatile} to ${volatileApplied} pair(s) = ${total} total ` +
            `(config declares static per-type fees; skipping metadata multicall)`
        );
        return total;
    }

    const { feeTarget, feeFunction, feeDivisor, feeArgSource } = factory;
    const feeIface = makeFeeIface(feeFunction, feeTarget, feeArgSource);

    // If feeArgSource='pair-stable', we need every pair to have a stable
    // value. Warn (not fail) if any are missing — they'll return 0 fee
    // which the caller can decide how to handle.
    if (feeTarget === 'factory' && feeArgSource === 'pair-stable') {
        const missingStable = targets.filter(t => t.stable === null || t.stable === undefined).length;
        if (missingStable > 0) {
            console.log(
                `  [!] ${missingStable}/${targets.length} pairs have no stable flag; ` +
                `feeArgSource='pair-stable' calls will use false (volatile) for those.`
            );
        }
    }

    // pair-stable-degen prefetch: `degen` is a mutable boolean per pair,
    // toggleable by the factory's feeManager. Not stored at scan time (would
    // go stale). We fetch it fresh here via one Multicall3 pass, then use
    // it when encoding the getFee(stable, degen) calls below.
    const degenByPair = new Map<string, boolean>();
    if (feeTarget === 'factory' && feeArgSource === 'pair-stable-degen') {
        const degenIface = new Interface(['function degen() view returns (bool)']);
        const SEL_degen = degenIface.getFunction('degen')!.selector;
        const DEGEN_BATCH = 500;
        let fetched = 0;
        for (let i = 0; i < targets.length; i += DEGEN_BATCH) {
            const chunk = targets.slice(i, i + DEGEN_BATCH);
            const calls: Multicall3Call[] = chunk.map(t => ({
                target: t.pair,
                allowFailure: true,
                callData: SEL_degen,
            }));
            try {
                const results = await multicall3(provider, calls);
                for (let j = 0; j < chunk.length; j++) {
                    const r = results[j];
                    if (r.success && r.returnData !== '0x') {
                        try {
                            const isDegen = degenIface.decodeFunctionResult('degen', r.returnData)[0] as boolean;
                            degenByPair.set(chunk[j].pair.toLowerCase(), isDegen);
                            fetched++;
                        } catch { /* leave undefined — defaults to false */ }
                    }
                }
            } catch (err) {
                console.log(`  [!] degen prefetch batch failed: ${(err as Error).message.slice(0, 100)}`);
            }
        }
        console.log(`  Prefetched degen flag for ${fetched}/${targets.length} pair(s)`);
    }

    const callsPerPair = wantStable ? 2 : 1;
    const pairsPerBatch = Math.max(1, Math.floor(METADATA_BATCH_SIZE * 2 / callsPerPair));

    console.log(
        `  Fetching metadata for ${targets.length} pairs ` +
        `(${callsPerPair} calls/pair, ${pairsPerBatch}/batch, ` +
        `${feeTarget === 'pair' ? 'pair.' : 'factory.'}${feeFunction})`
    );

    let totalUpdated = 0;
    let firstBatchChecked = false;

    for (let i = 0; i < targets.length; i += pairsPerBatch) {
        const batch = targets.slice(i, i + pairsPerBatch);

        // Build the multicall. Fee call target and args depend on feeTarget.
        const calls: Multicall3Call[] = [];
        for (const t of batch) {
            let feeCallData: string;
            if (feeTarget === 'pair') {
                feeCallData = feeIface.encodeFunctionData(feeFunction, []);
            } else if (feeArgSource === 'pair-stable-degen') {
                const isStable = Boolean(t.stable);
                const isDegen = degenByPair.get(t.pair.toLowerCase()) ?? false;
                feeCallData = feeIface.encodeFunctionData(feeFunction, [isStable, isDegen]);
            } else if (feeArgSource === 'pair-stable') {
                // PairFactoryUpgradeable.getFee(bool stable). Fall back to
                // false (volatile) when the pair has no stable flag.
                feeCallData = feeIface.encodeFunctionData(feeFunction, [Boolean(t.stable)]);
            } else if (feeArgSource === 'pair-and-caller') {
                // LeetSwapV2.tradingFees(pair, to). Pass 0x0 as `to` — that
                // returns the baseline fee (matches what any user without a
                // per-recipient discount would pay).
                feeCallData = feeIface.encodeFunctionData(feeFunction, [t.pair, '0x0000000000000000000000000000000000000000']);
            } else {
                feeCallData = feeIface.encodeFunctionData(feeFunction, [t.pair]);
            }
            calls.push({
                target: feeTarget === 'pair' ? t.pair : factory.address,
                allowFailure: true,
                callData: feeCallData,
            });
            if (wantStable) {
                calls.push({
                    target: t.pair,
                    allowFailure: true,
                    callData: pairStableIface.encodeFunctionData('stable'),
                });
            }
        }

        let results;
        try {
            results = await multicall3(provider, calls);
        } catch (err) {
            console.log(`\n  [!] Multicall failed on batch starting ${i}: ${(err as Error).message.slice(0, 100)}`);
            continue;
        }

        // Decode. Track fee-call successes for fail-loud detection.
        let feeSuccesses = 0;
        const updates: Array<{ pair: string; fee: number; stable?: boolean | null }> = [];
        for (let j = 0; j < batch.length; j++) {
            const t = batch[j];
            const feeResult    = results[j * callsPerPair];
            const stableResult = wantStable ? results[j * callsPerPair + 1] : null;

            if (!feeResult?.success || !feeResult.returnData || feeResult.returnData === '0x') {
                continue;  // fee call failed for this pair, skip
            }

            let feeRaw: bigint;
            try {
                feeRaw = BigInt(feeIface.decodeFunctionResult(feeFunction, feeResult.returnData)[0]);
            } catch { continue; }
            feeSuccesses++;

            const feeDecimal = Number(feeRaw) / feeDivisor;
            // Warn only for impossible values (> 100%) — legit outliers like
            // 50% "brake" pools shouldn't spam.
            if (feeDecimal > 1.0) {
                console.log(`\n  [!] Pair ${t.pair} fee ${feeDecimal} > 100% — likely wrong divisor (raw ${feeRaw}, divisor ${feeDivisor}).`);
            }

            let stable: boolean | null = null;
            if (wantStable && stableResult?.success && stableResult.returnData && stableResult.returnData !== '0x') {
                try {
                    stable = Boolean(pairStableIface.decodeFunctionResult('stable', stableResult.returnData)[0]);
                } catch { /* leave null */ }
            }

            updates.push({ pair: t.pair, fee: feeDecimal, stable });
        }

        // Fail-loud after the first batch. If the config is wrong, almost
        // every call will fail — no reason to burn through the whole factory
        // before saying so.
        if (!firstBatchChecked) {
            firstBatchChecked = true;
            const failureRate = 1 - (feeSuccesses / batch.length);
            if (failureRate >= FAIL_LOUD_THRESHOLD) {
                throw new Error(
                    `Metadata fetch is failing for ${factory.name}: ` +
                    `${batch.length - feeSuccesses}/${batch.length} pairs (${(failureRate * 100).toFixed(0)}%) ` +
                    `returned no fee data in the first batch.\n` +
                    `  Config: feeTarget="${feeTarget}", feeFunction="${feeFunction}", feeDivisor=${feeDivisor}\n` +
                    `  Likely cause: wrong feeTarget or feeFunction. Check the factory contract on the block explorer.\n` +
                    `  Common patterns:\n` +
                    `    Shadow-like (Sonic):  feeTarget="factory", feeFunction="pairFee",    feeDivisor=1000000\n` +
                    `    Equalizer-like:       feeTarget="factory", feeFunction="getRealFee", feeDivisor=1e18\n` +
                    `    DXSwap-like (Gnosis): feeTarget="pair",    feeFunction="swapFee",    feeDivisor=10000\n` +
                    `\n` +
                    `  Escape hatch: if the factory charges a UNIFORM fee for all pairs\n` +
                    `  (e.g. Dystopia = 0.0005, Velodrome-style, hardcoded-in-swap()), set\n` +
                    `  "fee": 0.0005  on the factory entry to skip metadata entirely.`
                );
            }
        }

        const upserted = db.updatePairMetadata(updates);
        totalUpdated += upserted;
        process.stdout.write(
            `\r    metadata batch ${Math.floor(i / pairsPerBatch) + 1}/${Math.ceil(targets.length / pairsPerBatch)} — ${totalUpdated}/${targets.length} pairs updated`
        );
    }
    process.stdout.write('\n');

    return totalUpdated;
}
