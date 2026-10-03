// -----------------------------------------------------------------------------
// Concentrated-liquidity reserves pass.
//
// For every kind = 'v3' pool in the DB, read its state through
// YoBatches2.getV3State and store it (db.upsertV3States):
//
//   pool_state / pool_ticks   exact state for sizing — calculus-v3.js
//   pairs.fee / tickSpacing   refreshed from the pool itself
//   reserves                  VIRTUAL reserves, x = L/sqrtP and y = L*sqrtP
//
// The virtual reserves are what let a v3 pool flow through every stage that
// only needs a price or a depth signal without touching that stage: their
// ratio IS the pool price, so numeraire pricing and the enumerator's
// non-zero join work; their size is the in-range depth, so dust filters mean
// what they say. They are NOT a V2 pool — beyond the next initialized tick
// the depth changes — so the evaluator sizes v3 hops from pool_state, never
// from these numbers.
//
// A pool with zero in-range liquidity, or one that did not answer, is stored
// with zero reserves so it drops out of enumeration rather than lingering at
// its last price.
// -----------------------------------------------------------------------------

import type { JsonRpcProvider } from 'ethers';
import type { ArbitradeDB } from '../util/db.ts';
import { getV3States } from '../util/yobatches.ts';

const Q96 = 1n << 96n;
export const V3_BATCH_SIZE = 100;
export const V3_WORDS = 2;
const RETRY_DELAYS_MS = [2000, 5000, 15000] as const;

/** Virtual reserves of a pool at its current price: (L * 2^96 / sqrtP, L * sqrtP / 2^96). */
export function virtualReserves(sqrtPriceX96: bigint, liquidity: bigint): [bigint, bigint] {
    if (sqrtPriceX96 === 0n || liquidity === 0n) return [0n, 0n];
    return [(liquidity * Q96) / sqrtPriceX96, (liquidity * sqrtPriceX96) / Q96];
}

export type V3FetchStats = {
    pools: number;
    live: number;        // answered, with in-range liquidity > 0
    empty: number;       // answered, zero in-range liquidity
    unreadable: number;  // slot0() etc. did not answer — not a v3-compatible pool
    ticksStored: number;
    errors: string[];
    byFactory: Map<string, { total: number; live: number }>;
};

export async function fetchV3States(
    provider: JsonRpcProvider,
    db: ArbitradeDB,
    yobatches: string,
    pools: Array<{ pair: string; factory: string }>,
    opts: { batchSize?: number; words?: number; concurrency?: number } = {},
): Promise<V3FetchStats> {
    const batchSize = Math.max(1, Math.floor(opts.batchSize ?? V3_BATCH_SIZE));
    const words = Math.max(0, Math.floor(opts.words ?? V3_WORDS));
    const concurrency = Math.max(1, Math.floor(opts.concurrency ?? 4));
    const stats: V3FetchStats = { pools: pools.length, live: 0, empty: 0, unreadable: 0, ticksStored: 0, errors: [], byFactory: new Map() };
    const factoryOf = new Map(pools.map(p => [p.pair.toLowerCase(), p.factory.toLowerCase()]));
    for (const p of pools) {
        const f = p.factory.toLowerCase();
        const e = stats.byFactory.get(f) ?? { total: 0, live: 0 };
        e.total++;
        stats.byFactory.set(f, e);
    }

    const batches: string[][] = [];
    for (let i = 0; i < pools.length; i += batchSize) batches.push(pools.slice(i, i + batchSize).map(p => p.pair));

    let next = 0, done = 0;
    const worker = async () => {
        while (true) {
            const i = next++;
            if (i >= batches.length) return;
            const batch = batches[i];
            let res: Awaited<ReturnType<typeof getV3States>> | null = null;
            for (let attempt = 0; ; attempt++) {
                try { res = await getV3States(provider, yobatches, batch, words); break; }
                catch (err) {
                    if (attempt >= RETRY_DELAYS_MS.length) {
                        stats.errors.push(`v3 batch ${i + 1}/${batches.length}: ${(err as Error).message.slice(0, 160)}`);
                        break;
                    }
                    await new Promise(r => setTimeout(r, RETRY_DELAYS_MS[attempt]));
                }
            }
            if (!res) continue;
            const rows = batch.map((pool, k) => {
                const st = res!.pools[k];
                if (!st) { stats.unreadable++; return { pool, blockNumber: res!.block, state: null, reserves0: 0n, reserves1: 0n }; }
                const [r0, r1] = virtualReserves(st.sqrtPriceX96, st.liquidity);
                if (r0 > 0n && r1 > 0n) {
                    stats.live++;
                    const e = stats.byFactory.get(factoryOf.get(pool.toLowerCase())!);
                    if (e) e.live++;
                } else stats.empty++;
                stats.ticksStored += st.ticks.length;
                // getV3States always sets the window bounds
                return { pool, blockNumber: res!.block, state: { ...st, windowLow: st.windowLow!, windowHigh: st.windowHigh! }, reserves0: r0, reserves1: r1 };
            });
            db.upsertV3States(rows);
            done++;
            process.stdout.write(`\r  [v3] ${done}/${batches.length} batches — ${stats.live} live, ${stats.empty} empty, ${stats.unreadable} unreadable`);
        }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, worker));
    if (batches.length) process.stdout.write('\n');
    return stats;
}
