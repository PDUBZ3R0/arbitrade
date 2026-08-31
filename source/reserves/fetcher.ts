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
    feeArgSource: 'pair-address' | 'pair-stable' = 'pair-address',
): Interface {
    let sig: string;
    if (feeTarget === 'pair') {
        sig = `function ${feeFunctionName}() view returns (uint256)`;
    } else if (feeArgSource === 'pair-stable') {
        // PairFactoryUpgradeable-style: factory.<fn>(bool stable)
        sig = `function ${feeFunctionName}(bool stable) view returns (uint256)`;
    } else {
        // Default factory-target: takes pair address
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
    /** Callback for progress updates */
    onProgress?: (info: {
        factoryName: string;
        batchIndex: number;
        batchCount: number;
        pairsInBatch: number;
        nonZero: number;
    }) => void;
};

export type FetchResult = {
    reservesUpdated: number;
    reservesSkipped: number;   // zero-reserve pairs
    metadataUpdated: number;
    orphanFactories: number;   // factories in DB but not in current config
    errors: string[];
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
    const result: FetchResult = { reservesUpdated: 0, reservesSkipped: 0, metadataUpdated: 0, orphanFactories: 0, errors: [] };

    // Build factory lookup so we can identify group per pair.
    const factoriesByAddr = new Map<string, NormalizedFactory>();
    for (const f of cfg.factories) factoriesByAddr.set(f.address.toLowerCase(), f);
    const currentFactoryAddrs = Array.from(factoriesByAddr.keys());

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

        for (const [factoryAddr, factoryPairs] of byFactory) {
            const factory = factoriesByAddr.get(factoryAddr);
            const factoryName = factory?.name ?? `(orphan) ${factoryAddr}`;
            const family = factory?.group ?? 'unknown';

            const batches = Math.ceil(factoryPairs.length / RESERVES_BATCH_SIZE);
            console.log(`\n[${factoryName}] ${factoryPairs.length} pairs (${family}), ${batches} batch(es)`);

            for (let i = 0; i < batches; i++) {
                const batch = factoryPairs.slice(i * RESERVES_BATCH_SIZE, (i + 1) * RESERVES_BATCH_SIZE);
                const triples: Array<[string, string, string]> = batch.map(p => [p.pair, p.token0, p.token1]);

                let reserves;
                try {
                    reserves = await getReservesByPairs(provider, cfg.chain.contract, triples);
                } catch (err) {
                    const msg = (err as Error).message ?? String(err);
                    result.errors.push(`${factoryName} batch ${i + 1}/${batches}: ${msg.slice(0, 200)}`);
                    process.stdout.write(`\n  [!] Batch ${i + 1}/${batches} failed: ${msg.slice(0, 100)}\n`);
                    continue;
                }

                // Filter zero-reserve pairs (dead pools)
                const nonZero = reserves.filter(r => r.reserves0 > 0n && r.reserves1 > 0n);
                const skipped = reserves.length - nonZero.length;
                result.reservesSkipped += skipped;

                // Upsert non-zero reserves. blockNumber = "current" (we don't
                // know exactly which block the eth_call was against without an
                // extra call to get it, so we use head as a best-effort approximation).
                // For arbitrage purposes, "current-ish" is what matters.
                const headBlock = await provider.getBlockNumber();
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
                process.stdout.write(
                    `\r  batch ${i + 1}/${batches} — ${nonZero.length}/${batch.length} non-zero, ${result.reservesUpdated} total upserts`
                );
            }
            process.stdout.write('\n');

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
            } else if (feeArgSource === 'pair-stable') {
                // PairFactoryUpgradeable.getFee(bool stable). Fall back to
                // false (volatile) when the pair has no stable flag.
                feeCallData = feeIface.encodeFunctionData(feeFunction, [Boolean(t.stable)]);
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
