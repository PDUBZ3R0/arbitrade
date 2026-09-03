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
     * Minimum reserves that BOTH sides of every pair in the triangle must
     * have, expressed in WHOLE TOKENS (human units), not wei — e.g. 0.01
     * means "at least 0.01 of whatever token is on that side of the pair".
     * Converted per-token using decimals from the tokens table (populated by
     * `yarn tokens <chain>`) or flashloan config, defaulting to 18 decimals
     * with a warning when a token's decimals are unknown. Default: 0 (off).
     *
     * This REPLACES the old `minPairReservesWei` (flat-wei) filter, which
     * was decimal-blind: a flat 1e18 wei threshold is "1 whole token" for an
     * 18-decimal token but "1 trillion tokens" for a 6-decimal one like
     * USDC — silently killing every pair on that token regardless of real
     * liquidity. If you were relying on minPairReservesWei, switch to this.
     */
    minLiquidityTokens?: number;
    /**
     * DEPRECATED — decimal-blind, see minLiquidityTokens above. Still
     * accepted for backwards compatibility (applied as an absolute wei floor
     * ADDITIONALLY to minLiquidityTokens, not instead of it), but you almost
     * certainly want minLiquidityTokens instead. Default: 0 (off).
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
    /**
     * Print a per-triangle breakdown (reserves, decimals used, fee, computed
     * profit/ROI, and exactly which filter tripped) for a sample of filtered
     * triangles, so filter behavior can be audited against real numbers
     * instead of trusted blind. Bounded by debugLimit — this is a diagnostic
     * aid, not a full dump (a big chain has millions of triangles).
     * Default: false.
     */
    debug?: boolean;
    /** Max triangles to print full detail for for when debug=true. Default: 25. */
    debugLimit?: number;
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

/**
 * Aggregate counts of WHY triangles were skipped, always populated (cheap —
 * just counters) regardless of `debug`. This is the first thing to check
 * when "candidates disappeared" — a spike in one bucket points straight at
 * which filter is responsible, before looking at any individual triangle.
 */
export type SkipReasons = {
    /** One of the triangle's 3 pairs isn't in the pairs table at all (blacklisted factory, deleted pair, etc). */
    missingPair: number;
    /** A pair exists but has no reserves row, or a reserve is exactly zero. */
    missingReserves: number;
    /** Tripped minLiquidityTokens (or the deprecated minPairReservesWei). */
    dustLiquidity: number;
    /** Direction produced no positive spread at all (grossProfit <= 0) — not a filter, just not profitable. */
    notProfitable: number;
    /** grossProfit > 0 but netProfit (after flash premium) < minProfit threshold. */
    belowMinProfit: number;
    /** Optimal input converged below minInput threshold — usually a math phantom, not a real opportunity. */
    belowMinInput: number;
    /** ROI exceeded maxRoiPct — almost always a phantom (impossible or wildly unrealistic spread). */
    roiCapExceeded: number;
};

export type EvaluateResult = {
    candidatesFound: number;
    profitableCount: number;
    trianglesScored: number;
    trianglesSkipped: number;      // sum of all skipReasons buckets except notProfitable
    skipReasons: SkipReasons;
    /** Count of distinct tokens whose decimals were unknown and defaulted to 18 for the liquidity filter. */
    tokensWithUnknownDecimals: number;
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
    /** Per-token minimum reserve (raw units) for the dust filter — token0/token1's own decimals, not a global flat number. */
    minReserve0: number;
    minReserve1: number;
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
    const debug = opts.debug ?? false;
    const debugLimit = opts.debugLimit ?? 25;
    let debugPrinted = 0;

    const skipReasons: SkipReasons = {
        missingPair: 0,
        missingReserves: 0,
        dustLiquidity: 0,
        notProfitable: 0,
        belowMinProfit: 0,
        belowMinInput: 0,
        roiCapExceeded: 0,
    };

    const result: EvaluateResult = {
        candidatesFound: 0,
        profitableCount: 0,
        trianglesScored: 0,
        trianglesSkipped: 0,
        skipReasons,
        tokensWithUnknownDecimals: 0,
        topCandidates: [],
        elapsedMs: 0,
    };

    try {
        // 1. Bulk load pairs+reserves+fee into an in-memory index.
        const pairRows = db.getPairsForEnumeration({ includeStable: false }) as any[];

        // 1a. Decimals lookup for the liquidity filter — same pattern as the
        // reserves fetcher's --dust option (config wins over DB, DB wins over
        // the 18-decimal fallback). Loaded once for every token touched by
        // any pair, not just root tokens — the OLD flat-wei dust filter's bug
        // was exactly that it never looked at per-token decimals at all.
        const decimalsByToken = new Map<string, number>();
        for (const t of cfg.flashloan?.tokens ?? []) {
            decimalsByToken.set(t.address.toLowerCase(), t.decimals);
        }
        const minLiquidityTokens = opts.minLiquidityTokens ?? 0;
        let unknownDecimalsTokens = new Set<string>();
        if (minLiquidityTokens > 0) {
            const allTokenAddrs = new Set<string>();
            for (const r of pairRows) {
                allTokenAddrs.add(r.token0.toLowerCase());
                allTokenAddrs.add(r.token1.toLowerCase());
            }
            const tokenRows = db.getTokens(Array.from(allTokenAddrs));
            for (const addr of allTokenAddrs) {
                if (decimalsByToken.has(addr)) continue;
                const row = tokenRows.get(addr);
                if (row?.decimals != null) {
                    decimalsByToken.set(addr, row.decimals);
                } else {
                    unknownDecimalsTokens.add(addr);
                }
            }
            result.tokensWithUnknownDecimals = unknownDecimalsTokens.size;
            if (unknownDecimalsTokens.size > 0) {
                console.log(
                    `[liquidity filter] ${unknownDecimalsTokens.size} token(s) have unknown decimals ` +
                    `(run \`yarn tokens ${cfg.chain.label}\` to fix) — defaulting to 18 for those. ` +
                    `Any of them that are actually 6/8/etc-decimal will get an over-strict dust threshold.`
                );
            }
        }
        const decimalsOf = (addr: string): number => decimalsByToken.get(addr.toLowerCase()) ?? 18;

        const pairsByAddr = new Map<string, PairData>();
        for (const r of pairRows) {
            const minReserve0 = minLiquidityTokens > 0 ? minLiquidityTokens * (10 ** decimalsOf(r.token0)) : 0;
            const minReserve1 = minLiquidityTokens > 0 ? minLiquidityTokens * (10 ** decimalsOf(r.token1)) : 0;
            pairsByAddr.set(r.pair, {
                pair: r.pair,
                factory: r.factory,
                token0: r.token0,
                token1: r.token1,
                reserves0: 0,
                reserves1: 0,
                fee: resolveFee(r, factoriesByAddr),
                minReserve0,
                minReserve1,
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

        // DEPRECATED flat-wei floor — applied ADDITIONALLY to minLiquidityTokens
        // for backwards compat, but decimal-blind. See EvaluateOptions doc.
        const legacyMinLiqWei = Number(opts.minPairReservesWei ?? 0n);

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

        // 3. Enumerate triangles via streaming cursor (NOT .all()).
        //
        // With ~5M triangles on a big chain, .all() blows past the 4 GB heap
        // (each row is ~500 bytes of JS objects; 5M × 500 = 2.5 GB just for
        // the array). .iterate() yields rows one at a time via SQLite's cursor
        // so memory stays flat: O(candidates) instead of O(all_triangles).
        //
        // Get the total count first so the log line + progress indicator are
        // meaningful. This is a separate query but SQLite counts triangles in
        // milliseconds thanks to the primary key.
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

        const totalTriRow = db.db.prepare(`SELECT COUNT(*) as n FROM triangles ${triWhere}`)
            .get(...triParams) as { n: number };
        const totalTriangles = totalTriRow.n;
        console.log(`Evaluating ${totalTriangles} triangles (streaming to keep memory flat)...`);

        const triStmt = db.db.prepare(`SELECT * FROM triangles ${triWhere}`);

        const candidates: Candidate[] = [];
        let processed = 0;
        const PROGRESS_EVERY = 100_000;

        // Debug helper: describes a pair's reserves/decimals/threshold for
        // whichever side tripped the dust filter, so you can see the exact
        // numbers instead of trusting the boolean.
        const symOrAddr = (addr: string): string => addr.slice(0, 10);
        const dumpDustDetail = (label: string, p: PairData) => {
            const d0 = decimalsOf(p.token0), d1 = decimalsOf(p.token1);
            console.log(
                `      [${label}] ${p.pair.slice(0,10)}  ` +
                `${symOrAddr(p.token0)}: reserve=${(p.reserves0 / 10 ** d0).toFixed(6)} (dec=${d0}) min=${minLiquidityTokens}  ` +
                `${symOrAddr(p.token1)}: reserve=${(p.reserves1 / 10 ** d1).toFixed(6)} (dec=${d1}) min=${minLiquidityTokens}`
            );
        };

        for (const tri of triStmt.iterate(...triParams) as Iterable<any>) {
            processed++;
            if (processed % PROGRESS_EVERY === 0) {
                const pct = ((processed / totalTriangles) * 100).toFixed(1);
                process.stdout.write(`\r  ${pct.padStart(5)}%  —  ${processed}/${totalTriangles} processed, ${result.trianglesScored} scored, ${candidates.length} kept`);
            }
            const loaded = loadTrianglePairs(tri, pairsByAddr);
            if (!loaded) {
                skipReasons.missingPair++;
                continue;
            }
            const [pAB, pBC, pCA] = loaded;
            if (pAB.reserves0 <= 0 || pAB.reserves1 <= 0 ||
                pBC.reserves0 <= 0 || pBC.reserves1 <= 0 ||
                pCA.reserves0 <= 0 || pCA.reserves1 <= 0) {
                skipReasons.missingReserves++;
                continue;
            }
            // Dust-pool filter: per-token-decimals-aware. Each side is
            // checked against ITS OWN token's minReserve (minLiquidityTokens
            // × 10^that token's decimals) — not a single global number.
            // legacyMinLiqWei (deprecated) is still ANDed in on top if set.
            const dustTripped =
                pAB.reserves0 < pAB.minReserve0 || pAB.reserves1 < pAB.minReserve1 ||
                pBC.reserves0 < pBC.minReserve0 || pBC.reserves1 < pBC.minReserve1 ||
                pCA.reserves0 < pCA.minReserve0 || pCA.reserves1 < pCA.minReserve1 ||
                (legacyMinLiqWei > 0 && (
                    pAB.reserves0 < legacyMinLiqWei || pAB.reserves1 < legacyMinLiqWei ||
                    pBC.reserves0 < legacyMinLiqWei || pBC.reserves1 < legacyMinLiqWei ||
                    pCA.reserves0 < legacyMinLiqWei || pCA.reserves1 < legacyMinLiqWei
                ));
            if (dustTripped) {
                skipReasons.dustLiquidity++;
                if (debug && debugPrinted < debugLimit) {
                    debugPrinted++;
                    console.log(`  [debug] triangle #${tri.id} skipped: dust liquidity`);
                    dumpDustDetail('AB', pAB);
                    dumpDustDetail('BC', pBC);
                    dumpDustDetail('CA', pCA);
                }
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
                    if (!(x > 0) || !isFinite(x)) { skipReasons.notProfitable++; continue; }

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
                    const roi = x > 0 ? netProfit / x : 0;

                    if (netProfit <= minProfit) { skipReasons.belowMinProfit++; continue; }
                    if (x < minInput)           { skipReasons.belowMinInput++;  continue; }
                    if (roi > maxRoi)           { skipReasons.roiCapExceeded++;
                        if (debug && debugPrinted < debugLimit) {
                            debugPrinted++;
                            console.log(
                                `  [debug] triangle #${tri.id} [2h ${direction}] skipped: ROI cap ` +
                                `(roi=${(roi*100).toFixed(2)}% > cap=${(maxRoi*100).toFixed(2)}%, ` +
                                `in=${x.toFixed(6)}, net=${netProfit.toFixed(6)})`
                            );
                        }
                        continue;
                    }

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
                    if (smallestInReserve <= 0) { skipReasons.notProfitable++; continue; }
                    const hi = smallestInReserve / 2;  // never swap more than 50% of any pool
                    const evalAt = (x: number) => simulate3Hop(x, root, hops) - x;
                    const xStar = ternarySearchLog(evalAt, 1, hi, 40);
                    const grossProfit = evalAt(xStar);
                    if (grossProfit <= 0) { skipReasons.notProfitable++; continue; }

                    const netProfit = grossProfit - xStar * flashPremium;
                    const roi = xStar > 0 ? netProfit / xStar : 0;

                    if (netProfit <= minProfit) { skipReasons.belowMinProfit++; continue; }
                    if (xStar < minInput)       { skipReasons.belowMinInput++;  continue; }
                    if (roi > maxRoi)           { skipReasons.roiCapExceeded++;
                        if (debug && debugPrinted < debugLimit) {
                            debugPrinted++;
                            console.log(
                                `  [debug] triangle #${tri.id} [3h ${direction}] skipped: ROI cap ` +
                                `(roi=${(roi*100).toFixed(2)}% > cap=${(maxRoi*100).toFixed(2)}%, ` +
                                `in=${xStar.toFixed(6)}, net=${netProfit.toFixed(6)})`
                            );
                        }
                        continue;
                    }

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

        result.trianglesSkipped =
            skipReasons.missingPair + skipReasons.missingReserves + skipReasons.dustLiquidity +
            skipReasons.belowMinProfit + skipReasons.belowMinInput + skipReasons.roiCapExceeded;

        candidates.sort((a, b) => b.netProfit - a.netProfit);
        result.profitableCount = candidates.length;
        result.topCandidates = opts.limit ? candidates.slice(0, opts.limit) : candidates;
    } finally {
        db.close();
    }

    result.elapsedMs = Date.now() - t0;
    return result;
}
