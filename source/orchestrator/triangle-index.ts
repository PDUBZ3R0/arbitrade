// -----------------------------------------------------------------------------
// Typed-array triangle index with a pair -> triangles reverse index.
//
// WHY THIS EXISTS
//
// The batch evaluator re-scores every triangle on every pass: 3.9M on Polygon,
// 65-100s. That is the right shape for `yarn evaluate`, where you want a full
// picture of a snapshot. It is the wrong shape for a live loop, because between
// two consecutive blocks only a handful of pairs actually moved — re-scoring
// 3.9M cycles to discover that ~3.9M of them are unchanged is almost entirely
// wasted work, and it guarantees the loop is slower than the chain.
//
// A V2 pair emits Sync(reserve0, reserve1) on every swap, mint and burn. So the
// live question is not "what are all the opportunities" but "which cycles did
// THIS block's swaps change". That needs two things this module provides:
//
//   1. A reverse index from pair to the triangles containing it, so a changed
//      pair yields its affected cycles in O(affected) rather than O(all).
//   2. Reserves held in memory and mutated in place, so applying a Sync is an
//      array write rather than a DB round-trip.
//
// WHY TYPED ARRAYS
//
// The batch evaluator holds pairs as JS objects in a Map, which is fine when
// you build it once per pass and throw it away. Here the index is long-lived
// and hot, and 3.9M triangles as objects is roughly 2.4GB and a GC problem.
// Struct-of-arrays over Int32Array/Float64Array is ~145MB for Polygon, has no
// per-element overhead, and keeps the scoring loop free of allocation. The cost
// is that everything is an integer index rather than a string, which is what
// the id-interning below is for.
//
// CONCENTRATED LIQUIDITY (opt-in: build(..., { v3: true })). A V3 pool never
// emits Sync, and its reserves row holds VIRTUAL reserves only valid to the
// next tick, so it cannot be scored on res0/res1. With v3 on, the index also
// holds each pool's full state (price, liquidity, the fetched tick window) and
// scores any cycle through one with the evaluator's own scoreMixed and
// v3_float_hop, exactly as `yarn evaluate` does. The state is replaced
// wholesale by applyV3State — the hot loop re-reads a pool whenever it emits a
// Swap, Mint or Burn, rather than replaying those events — and res0/res1 hold
// the matching virtual reserves, which is what the dust filter reads for a v3
// pool in the evaluator too. A pool with no stored state is left out (the
// evaluator skips it as v3MissingState).
//
// SCORING MUST MATCH THE BATCH EVALUATOR EXACTLY. It uses the same
// cycle_product / optimal_cycle_size / cycle_profit from calculus.js, the same
// clamp, the same filters in the same order. If these two ever disagree, the
// live loop is trading on different arithmetic than `yarn evaluate` reports,
// which is the worst possible failure for debugging. There is a test that
// replays a whole chain through both and requires identical candidate sets.
// -----------------------------------------------------------------------------

import type { ChainConfig, NormalizedFactory } from '../util/config.ts';
import type { ArbitradeDB } from '../util/db.ts';
import { cycle_product, optimal_cycle_size, cycle_profit, cycle_overflows } from '../util/calculus.js';
import { v3_float_hop } from '../util/calculus-v3.js';
import { scoreMixed } from '../evaluator/evaluator.ts';
import { virtualReserves } from '../reserves/v3-state.ts';

/** calculus-v3's V3Pool: what getV3States returns and loadV3States stores. */
export type V3PoolState = {
    sqrtPriceX96: bigint; tick: number; liquidity: bigint; fee: number; tickSpacing: number;
    ticks: Array<{ index: number; liquidityNet: bigint }>;
    windowLow?: number; windowHigh?: number;
};

/** A hop as the scoring loop needs it — oriented, with its fee. */
type OrientedHop = { rIn: number; rOut: number; fee: number };

export type IndexedCandidate = {
    triangleId: number;
    rootToken: string;
    hopCount: 2 | 3;
    direction: 'forward' | 'reverse';
    inputAmount: number;
    grossProfit: number;
    netProfit: number;
    hops: Array<{ pair: string; factory: string; tokenIn: string; tokenOut: string; fee: number; kind: 'v2' | 'v3' }>;
};

export type ScoreThresholds = {
    /** Per-root minimum net profit, in that root's own token units. */
    minProfitByRoot: Map<string, number>;
    /** Per-root minimum input, same units. */
    minInputByRoot: Map<string, number>;
    /** Per-token dust floor in token units, keyed by token index. */
    minReserveByToken: Float64Array;
    maxRoi: number;
    flashPremium: number;
    /**
     * Per-root flash fee, keyed by root token address (lowercase), when roots
     * borrow from different lenders. Falls back to flashPremium. Must match
     * the evaluator's flashPremiumFor, which uses the same flashTermsFor.
     */
    flashPremiumByRoot?: Map<string, number>;
};

export class TriangleIndex {
    // --- interning -----------------------------------------------------------
    /** pair address (lowercase) -> dense pair index */
    readonly pairIdx = new Map<string, number>();
    readonly pairAddr: string[] = [];
    readonly factoryAddr: string[] = [];
    /** token address (lowercase) -> dense token index */
    readonly tokenIdx = new Map<string, number>();
    readonly tokenAddr: string[] = [];

    // --- per-pair columns ----------------------------------------------------
    pairToken0!: Int32Array;
    pairToken1!: Int32Array;
    pairFee!: Float64Array;
    /** Mutated in place by applySync — this is the live state. For a v3
     *  pool, the virtual reserves of its current state (dust filter only). */
    res0!: Float64Array;
    res1!: Float64Array;
    /** 1 for a concentrated-liquidity pool. */
    pairIsV3!: Uint8Array;
    /** v3 pools only: current state, and its float hops per direction (built
     *  on first use, dropped whenever the state is replaced). */
    readonly v3State: Array<V3PoolState | undefined> = [];
    private readonly v3HopZf: any[] = [];
    private readonly v3HopOz: any[] = [];
    /** Number of v3 pools held. */
    v3Count = 0;

    // --- per-triangle columns ------------------------------------------------
    /** 3 entries per triangle: AB, BC, CA. CA is -1 for a 2-hop. */
    triPairs!: Int32Array;
    triRoot!: Int32Array;
    triTokB!: Int32Array;
    triTokC!: Int32Array;
    triHops!: Uint8Array;
    /** The triangles table's own id, for reporting continuity with `yarn evaluate`. */
    triDbId!: Int32Array;

    // --- CSR reverse index: pair -> triangles --------------------------------
    csrOffset!: Uint32Array;   // length pairCount + 1
    csrTri!: Uint32Array;      // length = sum of triangle memberships

    // --- dirty-set dedup scratch --------------------------------------------
    /** Stamp per triangle; compared against `pass` so clearing is O(1). */
    private stamp!: Uint32Array;
    private pass = 0;

    triangleCount = 0;
    pairCount = 0;

    private internPair(addr: string, factory: string): number {
        const a = addr.toLowerCase();
        let i = this.pairIdx.get(a);
        if (i === undefined) {
            i = this.pairAddr.length;
            this.pairIdx.set(a, i);
            this.pairAddr.push(a);
            this.factoryAddr.push(factory.toLowerCase());
        }
        return i;
    }
    private internToken(addr: string): number {
        const a = addr.toLowerCase();
        let i = this.tokenIdx.get(a);
        if (i === undefined) {
            i = this.tokenAddr.length;
            this.tokenIdx.set(a, i);
            this.tokenAddr.push(a);
        }
        return i;
    }

    /**
     * Build the index from the DB. Reads the same pair set the batch evaluator
     * does (getPairsForEnumeration, so probe-flagged and stable pairs are
     * already excluded) plus the reserves table, then the triangles table.
     *
     * Triangles referencing a pair that is absent from the enumerable set are
     * dropped here rather than skipped at score time, which is what keeps the
     * hot path branch-free.
     */
    static build(
        db: ArbitradeDB,
        factoriesByAddr: Map<string, NormalizedFactory>,
        /** v3: also hold concentrated-liquidity pools (see the header). Off by
         *  default: without a V3-capable executor and a V3 feed, a cycle through
         *  one could be found but neither kept current nor traded. */
        opts: { v3?: boolean } = {},
    ): TriangleIndex {
        const ix = new TriangleIndex();

        // 1. pairs
        // V2-style pairs always; v3 pools only when asked AND their state is
        // stored. Leaving a pool out drops every triangle through it (step 3).
        const pairRows = (db as any).getPairsForEnumeration({
            includeStable: false, kinds: opts.v3 ? ['v2', 'v3'] : ['v2'],
        }) as Array<{ pair: string; factory: string; token0: string; token1: string; fee: number | null; kind?: string }>;
        const states: Map<string, V3PoolState> = opts.v3 && pairRows.some(r => r.kind === 'v3')
            ? (db as any).loadV3States() : new Map();
        const t0: number[] = [], t1: number[] = [], fee: number[] = [], isV3: number[] = [];
        for (const r of pairRows) {
            const v3 = r.kind === 'v3';
            const st = v3 ? states.get(String(r.pair).toLowerCase()) : undefined;
            if (v3 && !st) continue;
            const pi = ix.internPair(r.pair, r.factory);
            t0[pi] = ix.internToken(r.token0);
            t1[pi] = ix.internToken(r.token1);
            // Same resolution as the evaluator's resolveFee: per-pair wins,
            // else factory-level, else the 0.3% default. A v3 pool's fee is its
            // stored state's, in pips — as the evaluator overrides it.
            fee[pi] = st ? st.fee / 1e6
                : r.fee != null ? r.fee
                : (factoriesByAddr.get(r.factory.toLowerCase())?.fee ?? 0.003);
            isV3[pi] = v3 ? 1 : 0;
            if (st) { ix.v3State[pi] = st; ix.v3Count++; }
        }
        ix.pairCount = ix.pairAddr.length;
        ix.pairToken0 = Int32Array.from(t0);
        ix.pairToken1 = Int32Array.from(t1);
        ix.pairFee = Float64Array.from(fee);
        ix.pairIsV3 = Uint8Array.from(isV3);
        ix.res0 = new Float64Array(ix.pairCount);
        ix.res1 = new Float64Array(ix.pairCount);

        // 2. reserves (only for pairs we kept). Raw prepare, matching how
        // evaluator.ts loads these — no new DB accessor to keep in sync.
        const reserveRows = (db as any).db.prepare(
            'SELECT pair, reserves0, reserves1 FROM reserves'
        ).all() as Array<{ pair: string; reserves0: string; reserves1: string }>;
        for (const r of reserveRows) {
            const pi = ix.pairIdx.get(String(r.pair).toLowerCase());
            if (pi === undefined) continue;
            ix.res0[pi] = Number(r.reserves0);
            ix.res1[pi] = Number(r.reserves1);
        }

        // 3. triangles, keeping only those whose pairs all survived
        const triRows = (db as any).db.prepare(
            'SELECT id, root_token, hop_count, token_b, token_c, pair_ab, pair_bc, pair_ca FROM triangles'
        ).all() as Array<{
            id: number; root_token: string; hop_count: number;
            token_b: string; token_c: string;
            pair_ab: string; pair_bc: string; pair_ca: string;
        }>;
        const tp: number[] = [], tr: number[] = [], tb: number[] = [], tc: number[] = [],
              th: number[] = [], tid: number[] = [];
        for (const t of triRows) {
            const ab = ix.pairIdx.get(String(t.pair_ab).toLowerCase());
            const bc = ix.pairIdx.get(String(t.pair_bc).toLowerCase());
            if (ab === undefined || bc === undefined) continue;
            let ca = -1;
            if (t.hop_count === 3) {
                const x = ix.pairIdx.get(String(t.pair_ca).toLowerCase());
                if (x === undefined) continue;
                ca = x;
            }
            tp.push(ab, bc, ca);
            tr.push(ix.internToken(t.root_token));
            tb.push(ix.internToken(t.token_b));
            tc.push(ix.internToken(t.token_c));
            th.push(t.hop_count);
            tid.push(t.id);
        }
        ix.triangleCount = th.length;
        ix.triPairs = Int32Array.from(tp);
        ix.triRoot = Int32Array.from(tr);
        ix.triTokB = Int32Array.from(tb);
        ix.triTokC = Int32Array.from(tc);
        ix.triHops = Uint8Array.from(th);
        ix.triDbId = Int32Array.from(tid);
        ix.stamp = new Uint32Array(ix.triangleCount);

        ix.buildCsr();
        return ix;
    }

    /**
     * Counting sort into compressed sparse row form: two passes, no nested
     * arrays, no per-pair allocation. csrTri[csrOffset[p] .. csrOffset[p+1]]
     * is the list of triangles touching pair p.
     */
    private buildCsr(): void {
        const counts = new Uint32Array(this.pairCount + 1);
        for (let t = 0; t < this.triangleCount; t++) {
            const base = t * 3;
            const n = this.triHops[t] === 3 ? 3 : 2;
            for (let k = 0; k < n; k++) counts[this.triPairs[base + k]]++;
        }
        this.csrOffset = new Uint32Array(this.pairCount + 1);
        let acc = 0;
        for (let p = 0; p < this.pairCount; p++) { this.csrOffset[p] = acc; acc += counts[p]; }
        this.csrOffset[this.pairCount] = acc;
        this.csrTri = new Uint32Array(acc);
        const cursor = Uint32Array.from(this.csrOffset.subarray(0, this.pairCount));
        for (let t = 0; t < this.triangleCount; t++) {
            const base = t * 3;
            const n = this.triHops[t] === 3 ? 3 : 2;
            for (let k = 0; k < n; k++) this.csrTri[cursor[this.triPairs[base + k]]++] = t;
        }
    }

    /** Approximate retained bytes, for the startup log. */
    bytes(): number {
        const arrs = [this.pairToken0, this.pairToken1, this.pairFee, this.res0, this.res1, this.pairIsV3,
            this.triPairs, this.triRoot, this.triTokB, this.triTokC, this.triHops,
            this.triDbId, this.csrOffset, this.csrTri, this.stamp];
        return arrs.reduce((n, a) => n + (a?.byteLength ?? 0), 0);
    }

    /**
     * Apply one Sync. Returns the pair index, or -1 when the pair is not in the
     * index — which is the common case and not an error: we subscribe to Sync
     * chain-wide (filtering by 100k addresses is not a filter any RPC will
     * accept), so most events belong to pairs we deliberately excluded.
     */
    applySync(pair: string, reserve0: number, reserve1: number): number {
        const pi = this.pairIdx.get(pair.toLowerCase());
        if (pi === undefined) return -1;
        // A Sync-shaped update for a v3 pool would overwrite its virtual
        // reserves with something else entirely; v3 pools change only through
        // applyV3State.
        if (this.pairIsV3[pi]) return -1;
        this.res0[pi] = reserve0;
        this.res1[pi] = reserve1;
        return pi;
    }

    /** Is this address a v3 pool held by the index? */
    isV3Pool(pair: string): boolean {
        const pi = this.pairIdx.get(pair.toLowerCase());
        return pi !== undefined && this.pairIsV3[pi] === 1;
    }

    /**
     * Replace a v3 pool's state with a fresh read (getV3States). Returns the
     * pool index, or -1 when it is not a v3 pool in the index. A null state (the
     * pool stopped answering slot0) zeroes its virtual reserves, which the dust
     * filter then rejects, so cycles through it stop scoring.
     */
    applyV3State(pair: string, st: V3PoolState | null): number {
        const pi = this.pairIdx.get(pair.toLowerCase());
        if (pi === undefined || !this.pairIsV3[pi]) return -1;
        this.v3HopZf[pi] = undefined;
        this.v3HopOz[pi] = undefined;
        if (!st) { this.res0[pi] = 0; this.res1[pi] = 0; return pi; }
        this.v3State[pi] = st;
        this.pairFee[pi] = st.fee / 1e6;
        const [r0, r1] = virtualReserves(st.sqrtPriceX96, st.liquidity);
        this.res0[pi] = Number(r0);
        this.res1[pi] = Number(r1);
        return pi;
    }

    /** The hop for swapping tokenIn through v3 pool pi — evaluator.ts's orientHop. */
    private v3Hop(pi: number, tokenIn: number): any {
        if (this.pairToken0[pi] === tokenIn) return this.v3HopZf[pi] ??= v3_float_hop(this.v3State[pi] as any, true);
        if (this.pairToken1[pi] === tokenIn) return this.v3HopOz[pi] ??= v3_float_hop(this.v3State[pi] as any, false);
        return null;
    }

    /**
     * Collect the triangles touched by these pairs, deduplicated.
     *
     * Dedup uses a monotonic pass counter against a per-triangle stamp, so
     * resetting the visited set between blocks costs nothing — important when
     * one block can touch pairs sharing thousands of triangles.
     */
    affectedTriangles(pairIndices: Iterable<number>): Uint32Array {
        const mark = ++this.pass;
        const out: number[] = [];
        for (const p of pairIndices) {
            if (p < 0 || p >= this.pairCount) continue;
            const end = this.csrOffset[p + 1];
            for (let i = this.csrOffset[p]; i < end; i++) {
                const t = this.csrTri[i];
                if (this.stamp[t] !== mark) { this.stamp[t] = mark; out.push(t); }
            }
        }
        return Uint32Array.from(out);
    }

    private orient(pi: number, tokenIn: number, into: OrientedHop): boolean {
        if (this.pairToken0[pi] === tokenIn) {
            into.rIn = this.res0[pi]; into.rOut = this.res1[pi];
        } else if (this.pairToken1[pi] === tokenIn) {
            into.rIn = this.res1[pi]; into.rOut = this.res0[pi];
        } else return false;
        into.fee = this.pairFee[pi];
        return true;
    }

    // Reused across calls so the hot loop allocates nothing per triangle.
    private readonly h0: OrientedHop = { rIn: 0, rOut: 0, fee: 0 };
    private readonly h1: OrientedHop = { rIn: 0, rOut: 0, fee: 0 };
    private readonly h2: OrientedHop = { rIn: 0, rOut: 0, fee: 0 };
    private readonly hops2: OrientedHop[] = [this.h0, this.h1];
    private readonly hops3: OrientedHop[] = [this.h0, this.h1, this.h2];

    /**
     * Score one triangle in both directions. Returns 0, 1 or 2 candidates.
     *
     * Deliberately mirrors evaluator.ts's 2-hop and 3-hop blocks: the dust
     * filter, the `hi` bound, the cycle-product gate, the closed-form size,
     * the clamp, then minProfit / minInput / maxRoi in that order. Changing
     * one without the other breaks the equivalence test.
     */
    scoreTriangle(t: number, th: ScoreThresholds, out: IndexedCandidate[]): void {
        const base = t * 3;
        const ab = this.triPairs[base], bc = this.triPairs[base + 1], ca = this.triPairs[base + 2];
        const hopCount = this.triHops[t];
        const root = this.triRoot[t], tokB = this.triTokB[t], tokC = this.triTokC[t];

        const members = hopCount === 3 ? [ab, bc, ca] : [ab, bc];
        // dust filter, decimals-aware per token (same as the evaluator's)
        for (const p of members) {
            const r0 = this.res0[p], r1 = this.res1[p];
            if (!(r0 > 0) || !(r1 > 0)) return;
            if (r0 < th.minReserveByToken[this.pairToken0[p]]) return;
            if (r1 < th.minReserveByToken[this.pairToken1[p]]) return;
        }

        const rootAddr = this.tokenAddr[root];
        const minProfit = th.minProfitByRoot.get(rootAddr) ?? 0;
        const minInput = th.minInputByRoot.get(rootAddr) ?? 0;
        let mixed = false;
        for (const p of members) if (this.pairIsV3[p]) { mixed = true; break; }

        for (let d = 0; d < 2; d++) {
            const forward = d === 0;
            let hops: OrientedHop[];
            let legs: Array<{ pi: number; tokenIn: number; tokenOut: number }>;

            if (hopCount === 2) {
                const first = forward ? ab : bc, second = forward ? bc : ab;
                if (!this.orient(first, root, this.h0)) continue;
                if (!this.orient(second, tokB, this.h1)) continue;
                hops = this.hops2;
                legs = [{ pi: first, tokenIn: root, tokenOut: tokB },
                        { pi: second, tokenIn: tokB, tokenOut: root }];
            } else {
                if (forward) {
                    if (!this.orient(ab, root, this.h0)) continue;
                    if (!this.orient(bc, tokB, this.h1)) continue;
                    if (!this.orient(ca, tokC, this.h2)) continue;
                    legs = [{ pi: ab, tokenIn: root, tokenOut: tokB },
                            { pi: bc, tokenIn: tokB, tokenOut: tokC },
                            { pi: ca, tokenIn: tokC, tokenOut: root }];
                } else {
                    if (!this.orient(ca, root, this.h0)) continue;
                    if (!this.orient(bc, tokC, this.h1)) continue;
                    if (!this.orient(ab, tokB, this.h2)) continue;
                    legs = [{ pi: ca, tokenIn: root, tokenOut: tokC },
                            { pi: bc, tokenIn: tokC, tokenOut: tokB },
                            { pi: ab, tokenIn: tokB, tokenOut: root }];
                }
                hops = this.hops3;
            }

            let x: number, grossProfit: number;
            if (mixed) {
                // The evaluator's mixed path, verbatim: v3 hops as float hops
                // over their tick window, V2 hops as {rIn, rOut, fee}.
                const oriented: any[] = [];
                for (let k = 0; k < legs.length; k++) {
                    const l = legs[k];
                    oriented.push(this.pairIsV3[l.pi]
                        ? this.v3Hop(l.pi, l.tokenIn)
                        : { rIn: hops[k].rIn, rOut: hops[k].rOut, fee: hops[k].fee });
                }
                const sc = scoreMixed(oriented);
                if ('skip' in sc) continue;
                ({ x, grossProfit } = sc);
            } else {
            const smallest = Math.min(...hops.map(h => h.rIn));
            if (!(smallest > 0)) continue;
            const hi = smallest / 2;
            if (!(hi > 1)) continue;
            if (!(cycle_product(hops) > 1)) continue;

            x = optimal_cycle_size(hops);
            if (!(x > 0) || !isFinite(x)) continue;
            if (x < 1) x = 1; else if (x > hi) x = hi;

            grossProfit = cycle_profit(x, hops);
            if (grossProfit <= 0) continue;

            // uint112 feasibility. Mirrors the evaluator's check at the same
            // point in the same order — this whole method is required to be
            // byte-identical to the batch evaluator's scoring, and test-index
            // enforces it.
            if (cycle_overflows(x, hops)) continue;
            }

            const netProfit = grossProfit - x * (th.flashPremiumByRoot?.get(rootAddr) ?? th.flashPremium);
            const roi = x > 0 ? netProfit / x : 0;
            if (netProfit <= minProfit) continue;
            if (x < minInput) continue;
            if (roi > th.maxRoi) continue;

            out.push({
                triangleId: this.triDbId[t],
                rootToken: rootAddr,
                hopCount: hopCount as 2 | 3,
                direction: forward ? 'forward' : 'reverse',
                inputAmount: x,
                grossProfit,
                netProfit,
                hops: legs.map(l => ({
                    pair: this.pairAddr[l.pi],
                    factory: this.factoryAddr[l.pi],
                    tokenIn: this.tokenAddr[l.tokenIn],
                    tokenOut: this.tokenAddr[l.tokenOut],
                    fee: this.pairFee[l.pi],
                    kind: this.pairIsV3[l.pi] ? 'v3' as const : 'v2' as const,
                })),
            });
        }
    }

    /** Score a specific set of triangles. */
    scoreMany(triangles: Iterable<number>, th: ScoreThresholds): IndexedCandidate[] {
        const out: IndexedCandidate[] = [];
        for (const t of triangles) this.scoreTriangle(t, th, out);
        return out;
    }

    /** Score everything — used by the equivalence test and the initial warm pass. */
    scoreAll(th: ScoreThresholds): IndexedCandidate[] {
        const out: IndexedCandidate[] = [];
        for (let t = 0; t < this.triangleCount; t++) this.scoreTriangle(t, th, out);
        return out;
    }
}
