// -----------------------------------------------------------------------------
// Profit evaluator (piece 5).
//
// For each cached triangle:
//   1. Load current reserves for each of the 3 pairs
//   2. Pick which direction to trade (each triangle has 2 traversal directions;
//      only one is profitable when a mispricing exists)
//   3. Find optimal input amount:
//        - 2-hop: closed-form solution from calculus.js
//        - 3-hop: ternary search over input in log space
//   4. Compute expected profit after all fees + flash-loan premium
//   5. Filter to profitable candidates, sort by profit
//
// This is OFF-CHAIN candidate scoring using float math. Any candidate that
// looks profitable enough gets confirmed by an on-chain simulation using
// exact BigInt arithmetic (in the orchestrator, piece 6) before executing.
//
// The evaluator is stateless per-pass. Run it repeatedly (every block, or
// every N seconds) — each pass re-reads all reserves and re-scores.
// -----------------------------------------------------------------------------

import { ArbitradeDB } from '../util/db.ts';
import type { ChainConfig, NormalizedFactory } from '../util/config.ts';
import { swap_output, optimal_trade_size } from '../util/calculus.js';

// -----------------------------------------------------------------------------

export type EvaluateOptions = {
    /** Only evaluate triangles rooted at this token. */
    onlyRoot?: string;
    /** Minimum profit in root-token wei to include in results. Default 0. */
    minProfitWei?: bigint;
    /**
     * Minimum profit as a decimal fraction of the root token (e.g. 0.001 =
     * 0.001 root tokens). Applied ADDITIVELY with minProfitWei — candidate
     * must exceed BOTH. Converted to wei per triangle using each root token's
     * decimals from flashloan config. Default: 0.001.
     * Set to 0 to disable and show raw output including sub-cent profits.
     */
    minProfitTokens?: number;
    /**
     * Minimum optimal input as a fraction of the root token. Filters
     * candidates where ternary search converged to dust — a common source
     * of math phantoms. Default: 0.001.
     */
    minInputTokens?: number;
    /** Include only 2-hop / only 3-hop cycles. */
    onlyHops?: 2 | 3;
    /** Max candidates to emit (top-N by profit). Default: unlimited. */
    limit?: number;
    /**
     * Minimum reserves (in wei) that BOTH sides of every pair in the triangle
     * must have. Skips dust pools that produce math phantoms. Default: 0 (no
     * filter). A sensible default for 18-decimal tokens is 1e18 (1 whole token).
     */
    minPairReservesWei?: bigint;
    /**
     * Skip candidates whose ROI exceeds this percentage. Real arbitrage almost
     * never exceeds a few percent; anything > 100% is provably impossible in
     * any market that charges fees, and > 20% is a strong phantom signal.
     * Default: 100 (skip only outright impossibilities).
     */
    maxRoiPct?: number;
    /**
     * Warn if reserves are older than this many seconds. Doesn't filter,
     * just prints a warning at the start. Default: 300 (5 min).
     */
    stalenessWarningSec?: number;
};

export type Candidate = {
    triangleId: number;
    rootToken: string;
    hopCount: 2 | 3;
    /** Which direction produced the profit: 'forward' = A→B→C→A, 'reverse' = A→C→B→A. */
    direction: 'forward' | 'reverse';
    /** Optimal input amount in root-token wei (as float — evaluator is off-chain). */
    inputAmount: number;
    /** Expected profit in root-token wei, gross (before flash-loan premium). */
    grossProfit: number;
    /** Expected profit after subtracting flash-loan premium. */
    netProfit: number;
    /** Sequence of pairs and factories used, in traversal order. */
    hops: Array<{
        pair: string;
        factory: string;
        tokenIn: string;
        tokenOut: string;
        fee: number;
    }>;
};

export type EvaluateResult = {
    candidatesFound: number;
    profitableCount: number;
    trianglesScored: number;
    trianglesSkipped: number;      // missing reserves / dust
    topCandidates: Candidate[];
    elapsedMs: number;
};

// -----------------------------------------------------------------------------
// Ternary search for the optimal input over a 3-hop cycle.
//
// The profit-as-function-of-input curve is unimodal for AMM cycles (single
// peak), which makes ternary search well-suited. We search in log space
// because the optimum can span many orders of magnitude depending on pool
// liquidity.

/**
 * Ternary search for the maximum of a unimodal function on [lo, hi].
 * Returns the x that maximizes f(x). ~40 iterations gives ~1e-6 relative precision.
 */
function ternarySearchLog(f: (x: number) => number, lo: number, hi: number, iters = 40): number {
    if (lo <= 0 || hi <= 0 || lo >= hi) return 0;
    let logLo = Math.log(lo);
    let logHi = Math.log(hi);
    for (let i = 0; i < iters; i++) {
        const l1 = logLo + (logHi - logLo) / 3;
        const l2 = logHi - (logHi - logLo) / 3;
        if (f(Math.exp(l1)) < f(Math.exp(l2))) logLo = l1;
        else                                    logHi = l2;
    }
    return Math.exp((logLo + logHi) / 2);
}

// -----------------------------------------------------------------------------

type PairData = {
    pair: string;
    factory: string;
    token0: string;
    token1: string;
    reserves0: number;   // Number for off-chain math; BigInt is used on-chain
    reserves1: number;
    fee: number;         // effective fee for this pair
};

/**
 * Resolve the fee for a given pair. For pure v2 pairs, we use the factory's
 * flat fee. For v2fee/solidly, we use the per-pair fee stored in the DB
 * (populated by the reserves fetcher).
 */
function resolveFee(row: any, factoriesByAddr: Map<string, NormalizedFactory>): number {
    // If pair.fee is populated in DB, use it (v2fee/solidly case).
    if (row.fee != null) return row.fee;
    // Else use factory-level fee (pure v2 case).
    const factory = factoriesByAddr.get(row.factory.toLowerCase());
    return factory?.fee ?? 0.003;
}

/**
 * Look up pair data (with reserves) for the 3 pairs in a triangle. Returns
 * null if any pair is missing reserves (skip this triangle).
 */
function loadTrianglePairs(
    tri: any,
    pairsByAddr: Map<string, PairData>,
): [PairData, PairData, PairData] | null {
    const a = pairsByAddr.get(tri.pair_ab);
    const b = pairsByAddr.get(tri.pair_bc);
    const c = pairsByAddr.get(tri.pair_ca);
    if (!a || !b || !c) return null;
    return [a, b, c];
}

/**
 * Orient a pair for a swap: return (reserveIn, reserveOut) matching the
 * requested `tokenIn` direction.
 */
function orient(p: PairData, tokenIn: string): { rIn: number; rOut: number } {
    if (p.token0 === tokenIn) return { rIn: p.reserves0, rOut: p.reserves1 };
    if (p.token1 === tokenIn) return { rIn: p.reserves1, rOut: p.reserves0 };
    throw new Error(`Token ${tokenIn} not in pair ${p.pair} (${p.token0}/${p.token1})`);
}

/**
 * Simulate walking a 3-hop cycle: input x of `startToken`, output is
 * how much of `startToken` we get back at the end. Profit = output - input.
 */
function simulate3Hop(
    x: number,
    startToken: string,
    hops: Array<{ pair: PairData; tokenIn: string; tokenOut: string }>,
): number {
    let amt = x;
    for (const h of hops) {
        const { rIn, rOut } = orient(h.pair, h.tokenIn);
        amt = swap_output(amt, rIn, rOut, h.pair.fee);
        if (amt === 0) return 0;
    }
    return amt;
}

// -----------------------------------------------------------------------------

/**
 * Evaluate all triangles for a chain and return the profitable ones.
 */
export async function evaluateTriangles(
    cfg: ChainConfig,
    dbFilePath: string,
    opts: EvaluateOptions = {},
): Promise<EvaluateResult> {
    const t0 = Date.now();

    const db = new ArbitradeDB(dbFilePath);
    const factoriesByAddr = new Map<string, NormalizedFactory>();
    for (const f of cfg.factories) factoriesByAddr.set(f.address.toLowerCase(), f);

    const flashPremium = cfg.flashloan?.premium ?? 0.0005;

    const result: EvaluateResult = {
        candidatesFound: 0,
        profitableCount: 0,
        trianglesScored: 0,
        trianglesSkipped: 0,
        topCandidates: [],
        elapsedMs: 0,
    };

    try {
        // 1. Bulk load pairs+reserves+fee into an in-memory index.
        const pairRows = db.getPairsForEnumeration({ includeStable: false }) as any[];
        const pairsByAddr = new Map<string, PairData>();
        for (const r of pairRows) {
            pairsByAddr.set(r.pair, {
                pair: r.pair,
                factory: r.factory,
                token0: r.token0,
                token1: r.token1,
                reserves0: 0,
                reserves1: 0,
                fee: resolveFee(r, factoriesByAddr),
            });
        }
        // 2. Load reserves and attach
        const reserveRows = db.db.prepare(`
            SELECT r.pair, r.reserves0, r.reserves1, r.updatedAt FROM reserves r
        `).all() as any[];
        let oldestUpdatedAt = Number.MAX_SAFE_INTEGER;
        for (const r of reserveRows) {
            const pd = pairsByAddr.get(r.pair);
            if (!pd) continue;
            pd.reserves0 = Number(r.reserves0);
            pd.reserves1 = Number(r.reserves1);
            if (r.updatedAt < oldestUpdatedAt) oldestUpdatedAt = r.updatedAt;
        }
        console.log(`Loaded ${pairsByAddr.size} pairs with reserves`);

        // Staleness warning. If reserves haven't been refreshed recently, any
        // "profitable" candidate is worth suspicion — market has almost certainly
        // moved.
        const nowSec = Math.floor(Date.now() / 1000);
        const oldestAgeSec = nowSec - oldestUpdatedAt;
        const warnThresh = opts.stalenessWarningSec ?? 300;
        if (oldestAgeSec > warnThresh) {
            const mins = Math.floor(oldestAgeSec / 60);
            console.log(`\n[!] Warning: oldest reserves are ${mins} minute(s) old. Consider running \`yarn reserves <chain>\` first for accurate scoring.\n`);
        }

        const minLiq = Number(opts.minPairReservesWei ?? 0n);
        // ROI cap. Real arb almost never exceeds a few percent. Above 100% is
        // physically impossible in a market with fees. Default 100 skips only
        // outright math phantoms; set lower (e.g. 20) for stricter filtering.
        const maxRoi = (opts.maxRoiPct ?? 100) / 100;

        // Per-root-token thresholds for profit + input, expressed in wei using
        // each root token's decimals from flashloan config. Handles multi-decimal
        // chains correctly (e.g. USDC 6 decimals vs wS 18 decimals).
        //
        // If a triangle's root isn't in the flashloan config (shouldn't happen
        // for enumerated triangles, but defensive) we assume 18 decimals.
        const minProfitTokensFrac = opts.minProfitTokens ?? 0.001;
        const minInputTokensFrac  = opts.minInputTokens  ?? 0.001;
        const rootThresholds = new Map<string, { minProfit: number; minInput: number }>();
        for (const t of (cfg.flashloan?.tokens ?? [])) {
            const scale = 10 ** t.decimals;
            rootThresholds.set(t.address.toLowerCase(), {
                minProfit: minProfitTokensFrac * scale,
                minInput:  minInputTokensFrac  * scale,
            });
        }
        // Base minimum from --min-profit (in wei) still applies on top.
        const baseMinProfit = Number(opts.minProfitWei ?? 0n);
        const thresholdsFor = (root: string) => {
            const t = rootThresholds.get(root.toLowerCase())
                ?? { minProfit: minProfitTokensFrac * 1e18, minInput: minInputTokensFrac * 1e18 };
            return { minProfit: Math.max(t.minProfit, baseMinProfit), minInput: t.minInput };
        };

        // 3. Load triangles
        const triWheres: string[] = [];
        const triParams: any[] = [];
        if (opts.onlyRoot) {
            triWheres.push('root_token = ?');
            triParams.push(opts.onlyRoot.toLowerCase());
        }
        if (opts.onlyHops) {
            triWheres.push('hop_count = ?');
            triParams.push(opts.onlyHops);
        }
        const triWhere = triWheres.length ? 'WHERE ' + triWheres.join(' AND ') : '';
        const triangles = db.db.prepare(`SELECT * FROM triangles ${triWhere}`).all(...triParams) as any[];
        console.log(`Evaluating ${triangles.length} triangles...`);

        const candidates: Candidate[] = [];

        for (const tri of triangles) {
            const loaded = loadTrianglePairs(tri, pairsByAddr);
            if (!loaded) { result.trianglesSkipped++; continue; }
            const [pAB, pBC, pCA] = loaded;
            if (pAB.reserves0 <= 0 || pAB.reserves1 <= 0 ||
                pBC.reserves0 <= 0 || pBC.reserves1 <= 0 ||
                pCA.reserves0 <= 0 || pCA.reserves1 <= 0) {
                result.trianglesSkipped++;
                continue;
            }
            // Dust-pool filter: if any pair has less than minLiq wei on either
            // side, skip. Prevents math phantoms where a near-zero reserve
            // produces impossible "profits".
            if (minLiq > 0 && (
                pAB.reserves0 < minLiq || pAB.reserves1 < minLiq ||
                pBC.reserves0 < minLiq || pBC.reserves1 < minLiq ||
                pCA.reserves0 < minLiq || pCA.reserves1 < minLiq
            )) {
                result.trianglesSkipped++;
                continue;
            }
            result.trianglesScored++;

            const root  = tri.root_token;
            const tokB  = tri.token_b;
            const tokC  = tri.token_c;
            const { minProfit, minInput } = thresholdsFor(root);

            if (tri.hop_count === 2) {
                // 2-hop: swap root→tokB on one pair, tokB→root on the other.
                // We use the closed-form optimum. Direction just decides which pair goes first.
                for (const direction of ['forward', 'reverse'] as const) {
                    const first  = direction === 'forward' ? pAB : pBC;
                    const second = direction === 'forward' ? pBC : pAB;

                    // Orient for the direction we're walking: input = root
                    const firstO  = orient(first, root);
                    const secondO = orient(second, tokB);

                    // Use avg fee for closed form (both pairs must use same fee for it to be exact;
                    // if fees differ we still get a good initial guess then refine)
                    const avgFee = (first.fee + second.fee) / 2;
                    let x = optimal_trade_size(
                        { a1: firstO.rIn, b1: firstO.rOut },
                        { a2: secondO.rOut, b2: secondO.rIn },  // note: a2/b2 swap for the closed form's convention
                        avgFee,
                    );
                    if (!(x > 0) || !isFinite(x)) continue;

                    // Refine with a couple ternary iterations if fees differ (usually tiny effect)
                    if (first.fee !== second.fee) {
                        const evalAt = (xi: number) => {
                            const mid = swap_output(xi, firstO.rIn, firstO.rOut, first.fee);
                            const out = swap_output(mid, secondO.rIn, secondO.rOut, second.fee);
                            return out - xi;
                        };
                        x = ternarySearchLog(evalAt, x * 0.1, x * 10, 20);
                    }

                    const mid = swap_output(x, firstO.rIn, firstO.rOut, first.fee);
                    const out = swap_output(mid, secondO.rIn, secondO.rOut, second.fee);
                    const grossProfit = out - x;
                    const netProfit   = grossProfit - x * flashPremium;

                    if (netProfit > minProfit && x >= minInput && (netProfit / x) <= maxRoi) {
                        result.candidatesFound++;
                        candidates.push({
                            triangleId: tri.id,
                            rootToken: root,
                            hopCount: 2,
                            direction,
                            inputAmount: x,
                            grossProfit,
                            netProfit,
                            hops: [
                                { pair: first.pair,  factory: first.factory,  tokenIn: root, tokenOut: tokB, fee: first.fee },
                                { pair: second.pair, factory: second.factory, tokenIn: tokB, tokenOut: root, fee: second.fee },
                            ],
                        });
                    }
                }
            } else {
                // 3-hop: try both traversal directions
                for (const direction of ['forward', 'reverse'] as const) {
                    const hops = direction === 'forward'
                        ? [
                            { pair: pAB, tokenIn: root, tokenOut: tokB },
                            { pair: pBC, tokenIn: tokB, tokenOut: tokC },
                            { pair: pCA, tokenIn: tokC, tokenOut: root },
                          ]
                        : [
                            { pair: pCA, tokenIn: root, tokenOut: tokC },
                            { pair: pBC, tokenIn: tokC, tokenOut: tokB },
                            { pair: pAB, tokenIn: tokB, tokenOut: root },
                          ];

                    // Bounds for ternary search: 1 wei to a fraction of the smallest pool's input reserve
                    const smallestInReserve = Math.min(
                        orient(hops[0].pair, hops[0].tokenIn).rIn,
                        orient(hops[1].pair, hops[1].tokenIn).rIn,
                        orient(hops[2].pair, hops[2].tokenIn).rIn,
                    );
                    if (smallestInReserve <= 0) continue;
                    const hi = smallestInReserve / 2;  // never swap more than 50% of any pool
                    const evalAt = (x: number) => simulate3Hop(x, root, hops) - x;
                    const xStar = ternarySearchLog(evalAt, 1, hi, 40);
                    const grossProfit = evalAt(xStar);
                    if (grossProfit <= 0) continue;

                    const netProfit = grossProfit - xStar * flashPremium;
                    if (netProfit > minProfit && xStar >= minInput && (netProfit / xStar) <= maxRoi) {
                        result.candidatesFound++;
                        candidates.push({
                            triangleId: tri.id,
                            rootToken: root,
                            hopCount: 3,
                            direction,
                            inputAmount: xStar,
                            grossProfit,
                            netProfit,
                            hops: hops.map(h => ({
                                pair: h.pair.pair,
                                factory: h.pair.factory,
                                tokenIn: h.tokenIn,
                                tokenOut: h.tokenOut,
                                fee: h.pair.fee,
                            })),
                        });
                    }
                }
            }
        }

        candidates.sort((a, b) => b.netProfit - a.netProfit);
        result.profitableCount = candidates.length;
        result.topCandidates = opts.limit ? candidates.slice(0, opts.limit) : candidates;
    } finally {
        db.close();
    }

    result.elapsedMs = Date.now() - t0;
    return result;
}
