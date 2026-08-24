// -----------------------------------------------------------------------------
// Reserves fetcher.
//
// Refreshes reserves for pairs in the DB by calling YoBatches, and for
// Solidly-family pairs, also fetches per-pair fee (and stable flag for
// solidly-v2) via Multicall3.
//
// Pipeline per chain:
//   1. Query DB for pairs to refresh (optionally filtered by factory/max-age)
//   2. Group by factory (so we know which family each pair belongs to)
//   3. For each factory, batch YoBatches calls (~200 pairs per call)
//   4. Filter out zero-reserve pairs (dead pools = no arb opportunity)
//   5. Upsert non-zero reserves
//   6. For solidly-* pairs missing metadata: batch factory.pairFee(pair)
//      via Multicall3, plus pair.stable() for solidly-v2
//   7. Update pairs table with fee/stable
// -----------------------------------------------------------------------------

import { JsonRpcProvider, Interface } from 'ethers';
import type { ChainConfig, NormalizedFactory } from '../util/config.ts';
import { ArbitradeDB } from '../util/db.ts';
import { getReservesByPairs } from '../util/yobatches.ts';
import { multicall3, type Multicall3Call } from '../util/multicall.ts';

const RESERVES_BATCH_SIZE  = 200;   // pairs per YoBatches call
const METADATA_BATCH_SIZE  = 100;   // pairs per Multicall3 batch (each pair = 1-2 sub-calls)

// Selectors and ABI fragments for the Solidly per-pair metadata calls.
// factory.pairFee(address) → uint256
// pair.stable() → bool
const solidlyIface = new Interface([
    'function pairFee(address pair) view returns (uint256)',
    'function stable() view returns (bool)',
]);

// Solidly factories express fees as raw uints — some use basis points
// (divisor = 10_000, so 30 = 0.30%), others use parts per million
// (divisor = 1_000_000, so 3000 = 0.30%). Per-factory feeDivisor lives in
// config; we read cfg.factory.feeDivisor at call time.

// -----------------------------------------------------------------------------

export type FetchOptions = {
    /** Only refresh pairs from this factory (address, lowercase-matched) */
    factory?: string;
    /** Only refresh pairs whose reserves were updated more than N seconds ago */
    maxAgeSeconds?: number;
    /** If true, refetch fee/stable for solidly pairs even if already populated */
    refreshMetadata?: boolean;
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
    errors: string[];
};

// -----------------------------------------------------------------------------

/**
 * Refresh reserves and Solidly-family metadata for pairs on a chain.
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
    const result: FetchResult = { reservesUpdated: 0, reservesSkipped: 0, metadataUpdated: 0, errors: [] };

    // Build factory lookup so we can identify family per pair
    const factoriesByAddr = new Map<string, NormalizedFactory>();
    for (const f of cfg.factories) factoriesByAddr.set(f.address.toLowerCase(), f);

    try {
        // Group all requested pairs by factory address
        const pairs = db.getPairsForReservesFetch({
            factory: opts.factory,
            maxAgeSeconds: opts.maxAgeSeconds,
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
            const factoryName = factory?.name ?? factoryAddr;
            const family = factory?.group ?? 'v2';

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

            // Solidly-family metadata pass (if applicable)
            if (family === 'solidly-v2' || family === 'solidly-native') {
                const feeDivisor = factory?.feeDivisor ?? 10_000;
                const metaCount = await fetchSolidlyMetadata(
                    provider, db, factoryAddr, family, feeDivisor, opts.refreshMetadata ?? false,
                );
                result.metadataUpdated += metaCount;
                console.log(`  [${factoryName}] metadata: ${metaCount} pairs updated (feeDivisor=${feeDivisor})`);
            }
        }
    } finally {
        db.close();
    }

    return result;
}

// -----------------------------------------------------------------------------

/**
 * Batch-fetch fee (and stable, for solidly-v2) for pairs of a Solidly-family
 * factory. Uses Multicall3 to reduce per-pair RPC calls.
 */
async function fetchSolidlyMetadata(
    provider: JsonRpcProvider,
    db: ArbitradeDB,
    factoryAddr: string,
    family: 'solidly-v2' | 'solidly-native',
    feeDivisor: number,
    refreshAll: boolean,
): Promise<number> {
    const targets = db.getPairsForMetadataFetch(factoryAddr, refreshAll);
    if (targets.length === 0) return 0;

    // For solidly-v2 we need BOTH pairFee and stable per pair; for solidly-native
    // stable was populated at scan time from the event so we only need pairFee.
    const wantStable = family === 'solidly-v2';
    const callsPerPair = wantStable ? 2 : 1;
    const pairsPerBatch = Math.max(1, Math.floor(METADATA_BATCH_SIZE * 2 / callsPerPair));

    console.log(`  Fetching metadata for ${targets.length} pairs (${callsPerPair} calls/pair, ${pairsPerBatch}/batch)`);

    let totalUpdated = 0;

    for (let i = 0; i < targets.length; i += pairsPerBatch) {
        const batch = targets.slice(i, i + pairsPerBatch);

        // Build multicall
        const calls: Multicall3Call[] = [];
        for (const t of batch) {
            calls.push({
                target: factoryAddr,
                allowFailure: true,
                callData: solidlyIface.encodeFunctionData('pairFee', [t.pair]),
            });
            if (wantStable) {
                calls.push({
                    target: t.pair,
                    allowFailure: true,
                    callData: solidlyIface.encodeFunctionData('stable'),
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

        // Decode results back into per-pair updates
        const updates: Array<{ pair: string; fee: number; stable?: boolean | null }> = [];
        for (let j = 0; j < batch.length; j++) {
            const t = batch[j];
            const feeResult    = results[j * callsPerPair];
            const stableResult = wantStable ? results[j * callsPerPair + 1] : null;

            if (!feeResult?.success || !feeResult.returnData || feeResult.returnData === '0x') {
                continue;  // couldn't read fee for this pair, skip
            }

            let feeRaw: bigint;
            try {
                feeRaw = BigInt(solidlyIface.decodeFunctionResult('pairFee', feeResult.returnData)[0]);
            } catch { continue; }

            const feeDecimal = Number(feeRaw) / feeDivisor;
            // Sanity check: real-world fees fall between 0.001% and 5%
            if (feeDecimal < 0.00001 || feeDecimal > 0.05) {
                console.log(`\n  [!] Pair ${t.pair} fee ${feeDecimal} looks off (raw ${feeRaw}, divisor ${feeDivisor}). Check the factory's feeDivisor in config.`);
            }

            let stable: boolean | null = null;
            if (wantStable && stableResult?.success && stableResult.returnData && stableResult.returnData !== '0x') {
                try {
                    stable = Boolean(solidlyIface.decodeFunctionResult('stable', stableResult.returnData)[0]);
                } catch { /* leave null */ }
            }

            updates.push({ pair: t.pair, fee: feeDecimal, stable });
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
