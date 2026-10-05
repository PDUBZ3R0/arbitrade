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
import { getV3States, getReservesByPairs } from '../util/yobatches.ts';

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

    // Adaptive batch size. A batch's cost on the node is dominated by its
    // pools' initialized ticks, which vary by orders of magnitude (a 1-bp
    // stable pool can have hundreds inside the window, a fresh memecoin pool
    // none). One fixed size is either too small for the empty pools or so big
    // for the dense ones that a single call runs for minutes. Workers take
    // `size` pools at a time; a batch slower than TARGET_MS halves it, a fast
    // one grows it back toward the configured maximum, and a failed batch is
    // split and re-queued rather than retried whole.
    const TARGET_MS = 8_000, MIN_SIZE = 5;
    let size = batchSize;
    const queue: string[][] = [];
    let cursor = 0;
    const take = (): string[] | null => {
        if (queue.length) return queue.shift()!;
        if (cursor >= pools.length) return null;
        const b = pools.slice(cursor, cursor + size).map(p => p.pair);
        cursor += b.length;
        return b;
    };

    let doneCalls = 0, poolsDone = 0, bytes = 0, inflight = 0;
    const t0 = Date.now();
    const rpcStats = (provider as any).stats as { ws: number; http: number; fallbacks: number } | undefined;
    const worker = async () => {
        while (true) {
            const batch = take();
            if (!batch) {
                // Another worker may still split a failed batch back into the queue.
                if (inflight === 0) return;
                await new Promise(r => setTimeout(r, 50));
                continue;
            }
            inflight++;
            let res: Awaited<ReturnType<typeof getV3States>> | null = null;
            const bt = Date.now();
            try {
                for (let attempt = 0; ; attempt++) {
                    try { res = await getV3States(provider, yobatches, batch, words); break; }
                    catch (err) {
                        // A batch that errors (gas cap, response limit, a
                        // timeout) is split rather than retried as-is — down
                        // to single pools, which also isolates one pool that
                        // breaks every call it is in.
                        if (batch.length > 1) {
                            const h = Math.ceil(batch.length / 2);
                            queue.push(batch.slice(0, h), batch.slice(h));
                            size = Math.max(MIN_SIZE, Math.min(size, h));
                            break;
                        }
                        if (attempt >= RETRY_DELAYS_MS.length) {
                            stats.errors.push(`v3 batch of ${batch.length} (${batch[0]}…): ${(err as Error).message.slice(0, 160)}`);
                            break;
                        }
                        await new Promise(r => setTimeout(r, RETRY_DELAYS_MS[attempt]));
                    }
                }
            } finally {
                inflight--;
            }
            if (!res) continue;
            const ms = Date.now() - bt;
            if (ms > TARGET_MS) size = Math.max(MIN_SIZE, Math.floor(size / 2));
            else if (ms < TARGET_MS / 4) size = Math.min(batchSize, Math.ceil(size * 1.5));
            bytes += res.bytes ?? 0;
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
            doneCalls++;
            poolsDone += batch.length;
            const secs = (Date.now() - t0) / 1000;
            const rate = poolsDone / Math.max(secs, 1e-9);
            const eta = rate > 0 ? (pools.length - poolsDone) / rate : 0;
            const rpc = rpcStats ? ` | ws ${rpcStats.ws} http ${rpcStats.http}${rpcStats.fallbacks ? ` fallbacks ${rpcStats.fallbacks}` : ''}` : '';
            process.stdout.write(`\r  [v3] ${poolsDone}/${pools.length} pools — ${stats.live} live, ${stats.empty} empty, ` +
                `${stats.unreadable} unreadable | ${rate.toFixed(1)} pools/s, batch ${size}, ` +
                `${(bytes / 1e6 / Math.max(secs, 1e-9)).toFixed(2)} MB/s in, ETA ${fmtDuration(eta)}${rpc}   `);
        }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, Math.ceil(pools.length / batchSize) || 1) }, worker));
    if (pools.length) process.stdout.write('\n');
    return stats;
}

function fmtDuration(sec: number): string {
    if (!isFinite(sec) || sec <= 0) return '—';
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), x = Math.floor(sec % 60);
    return h ? `${h}h${String(m).padStart(2, '0')}m` : m ? `${m}m${String(x).padStart(2, '0')}s` : `${x}s`;
}

// -----------------------------------------------------------------------------
// Reachability prefilter (see reserves.v3Prefilter in config.ts).
//
// The enumerator only builds cycles root -> A -> (B ->) root. So a v3 pool is
// worth reading only if it is a root pool that can pay out at least
// `minRoot` of its root, or it joins two tokens that both have such a root
// pool. Deciding that needs only token balances of the ROOT pools — two
// balanceOf each, hundreds of pools per eth_call — instead of getV3State's
// ~10 calls plus tick reads for every pool on the chain.
// -----------------------------------------------------------------------------

export type ReachabilityResult<T> = {
    keep: T[];
    dropped: T[];
    rootPools: number;      // root pools checked (v2 + v3)
    rootPoolsLive: number;  // ...with enough root balance and a non-zero other side
    neighbours: number;     // distinct non-root tokens reachable from a root
    failedBatches: number;  // balance batches that errored (their pools were kept)
};

export async function filterReachableV3<T extends { pair: string; token0: string; token1: string }>(
    provider: JsonRpcProvider,
    yobatches: string,
    v3Pools: T[],
    /** Every pool and pair on the chain (v2 and v3), for root-pool discovery. */
    allPairs: Array<{ pair: string; token0: string; token1: string }>,
    /** root token (lowercase) -> minimum root-side balance in raw units */
    roots: Map<string, bigint>,
    opts: {
        batchSize?: number;
        concurrency?: number;
        /**
         * Balance cache (db.root_checks). `get` returns balances recent
         * enough to reuse; `put` stores fresh reads. Most root pools on a
         * busy chain are dead and stay dead, so after the first run only the
         * expired entries cost an RPC call.
         */
        cache?: {
            get: () => Map<string, { bal0: bigint; bal1: bigint }>;
            put: (rows: Array<{ pool: string; bal0: bigint; bal1: bigint }>) => void;
        };
    } = {},
): Promise<ReachabilityResult<T> & { cached: number }> {
    const batchSize = Math.max(1, Math.floor(opts.batchSize ?? 500));
    const concurrency = Math.max(1, Math.floor(opts.concurrency ?? 4));
    const isRoot = (t: string) => roots.has(t.toLowerCase());

    const rootPairs = allPairs.filter(p => isRoot(p.token0) || isRoot(p.token1));
    const live = new Set<string>();
    const neighbours = new Set<string>();
    let failedBatches = 0;

    const judge = (pair: string, t0l: string, t1l: string, b0: bigint, b1: bigint) => {
        const ok0 = isRoot(t0l) && b0 > 0n && b0 >= roots.get(t0l)! && b1 > 0n;
        const ok1 = isRoot(t1l) && b1 > 0n && b1 >= roots.get(t1l)! && b0 > 0n;
        if (ok0 || ok1) markLive(pair, t0l, t1l);
    };

    // Cached balances first; only the rest go to the chain.
    const cachedBal = opts.cache?.get() ?? new Map();
    const toRead: typeof rootPairs = [];
    let cached = 0;
    for (const p of rootPairs) {
        const c = cachedBal.get(p.pair.toLowerCase());
        if (c) { cached++; judge(p.pair.toLowerCase(), p.token0.toLowerCase(), p.token1.toLowerCase(), c.bal0, c.bal1); }
        else toRead.push(p);
    }
    if (cached > 0) {
        console.log(`  [prefilter] ${cached.toLocaleString()} root pool(s) from cache, ${toRead.length.toLocaleString()} to read`);
    }

    const batches: Array<typeof rootPairs> = [];
    for (let i = 0; i < toRead.length; i += batchSize) batches.push(toRead.slice(i, i + batchSize));
    let next = 0, done = 0;
    const t0 = Date.now();
    const worker = async () => {
        while (true) {
            const i = next++;
            if (i >= batches.length) return;
            const batch = batches[i];
            let rows: Awaited<ReturnType<typeof getReservesByPairs>> | null = null;
            for (let attempt = 0; ; attempt++) {
                try {
                    rows = await getReservesByPairs(provider, yobatches, batch.map(p => [p.pair, p.token0, p.token1] as [string, string, string]), { canonical: true });
                    break;
                } catch {
                    if (attempt >= RETRY_DELAYS_MS.length) break;
                    await new Promise(r => setTimeout(r, RETRY_DELAYS_MS[attempt]));
                }
            }
            if (!rows) {
                // Unknown is not unreachable: keep the whole batch.
                failedBatches++;
                for (const p of batch) markLive(p.pair.toLowerCase(), p.token0.toLowerCase(), p.token1.toLowerCase());
            } else {
                for (const r of rows) judge(r.pair.toLowerCase(), r.token0.toLowerCase(), r.token1.toLowerCase(), r.reserves0, r.reserves1);
                try { opts.cache?.put(rows.map(r => ({ pool: r.pair, bal0: r.reserves0, bal1: r.reserves1 }))); } catch { /* cache is best-effort */ }
            }
            done++;
            process.stdout.write(`\r  [prefilter] ${done}/${batches.length} root-pool balance batches — ${live.size} live, ` +
                `${neighbours.size} reachable tokens (${((Date.now() - t0) / 1000).toFixed(0)}s)   `);
        }
    };
    function markLive(pair: string, a: string, b: string) {
        live.add(pair);
        if (!roots.has(a)) neighbours.add(a);
        if (!roots.has(b)) neighbours.add(b);
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, worker));
    if (batches.length) process.stdout.write('\n');

    const reachable = (t: string) => roots.has(t) || neighbours.has(t);
    const keep: T[] = [], dropped: T[] = [];
    for (const p of v3Pools) {
        const a = p.token0.toLowerCase(), b = p.token1.toLowerCase();
        const ok = (roots.has(a) || roots.has(b))
            ? live.has(p.pair.toLowerCase())
            : reachable(a) && reachable(b);
        (ok ? keep : dropped).push(p);
    }
    return { keep, dropped, rootPools: rootPairs.length, rootPoolsLive: live.size, neighbours: neighbours.size, failedBatches, cached };
}
