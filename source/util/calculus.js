// -----------------------------------------------------------------------------
// Uniswap V2 constant-product AMM math for arbitrage evaluation.
//
// This is a direct rebuild of the original calculus.js, cleaned up:
//   - Removed the stray top-level braces that made it invalid as a module
//   - Converted CommonJS `module.exports` to ESM `export`
//   - Fixed the buggy `_f || 0.003` short-circuit inside swap_output
//     (the original had `1 - fee || 0.003` which parses as `(1-fee) || 0.003`
//     and thus never triggered the default — the outer `_f || 0.003` was
//     already covering that but the redundant one was misleading)
//   - Added light defensive checks for zero reserves and negative results
//
// Everything still runs on JS Number (float64). That's fine for OFF-CHAIN
// candidate scoring — we're picking triangles to actually simulate on-chain,
// where BigInt math will confirm profitability before we send a tx.
// For on-chain execution the Solidity contract does exact integer math.
// -----------------------------------------------------------------------------

/**
 * Output of a single swap on a V2 constant-product AMM.
 * Given input `x` of the token with reserve `a`, returns amount out of the
 * token with reserve `b`, net of the swap fee.
 *
 * Formula: y = (x * (1-fee) * b) / (a + x * (1-fee))
 *   the canonical Uniswap V2 form, and the same shape the Solidity integer
 *   math uses on-chain.
 *
 * DO NOT rewrite this as `b * (1 - a / (a + xNet))`. The two are algebraically
 * identical but NOT numerically identical in float64, and the subtractive form
 * is catastrophically wrong in the regime we actually care about. When
 * xNet << a — a modest trade against a deep pool, i.e. almost every candidate
 * we score — `a / (a + xNet)` sits within an eps of 1.0, so `1 - that` cancels
 * away most of its significant digits. Around xNet/a ~ 1e-15 the result is
 * essentially quantized noise.
 *
 * That mattered concretely. Cycle profit is a difference of two large,
 * nearly-equal numbers (out - x), so this noise landed directly on the profit
 * signal rather than averaging out. Measured over 200k random 3-hop cycles,
 * the subtractive form overstated profit by >1% on 2.1% of profitable
 * candidates and understated it by >1% on 3.6%, with a worst observed case
 * reporting -9.4e19 where the true profit was +1.0e14 — a sign flip. It also
 * destroyed the unimodality that ternary search depends on, so the old 3-hop
 * search could converge 3-4 orders of magnitude away from the real optimum
 * and report ~3% of the available profit.
 *
 * @param {number} x   input amount
 * @param {number} a   reserve of input token in the pool
 * @param {number} b   reserve of output token in the pool
 * @param {number} [fee=0.003]   swap fee as a decimal (0.003 = 0.3%)
 * @returns {number} amount out (>= 0)
 */
export function swap_output(x, a, b, fee = 0.003) {
    if (!(x > 0) || !(a > 0) || !(b > 0)) return 0;
    const xNet = x * (1 - fee);
    return (xNet * b) / (a + xNet);
}

/**
 * Gross profit of two successive swaps forming a closed cycle:
 *   TokenA --pool1--> TokenB --pool2--> TokenA
 *
 * Reserves are labeled from the perspective of the swap direction:
 *   pool1: a1 = TokenA reserve, b1 = TokenB reserve
 *   pool2: b2 = TokenB reserve (input side), a2 = TokenA reserve (output side)
 *
 * @param {number} x    input amount of TokenA
 * @param {{a1: number, b1: number}} reserves1
 * @param {{a2: number, b2: number}} reserves2
 * @param {number} [fee=0.003]
 * @returns {number} profit in TokenA (may be negative)
 */
export function trade_profit(x, reserves1, reserves2, fee = 0.003) {
    const { a1, b1 } = reserves1;
    const { a2, b2 } = reserves2;
    const midB = swap_output(x, a1, b1, fee);
    const outA = swap_output(midB, b2, a2, fee);
    return outA - x;
}

/**
 * Closed-form optimal input for a 2-hop TokenA-TokenB-TokenA cycle where both
 * pools use the same fee. Derived by setting d(trade_profit)/dx = 0 and solving.
 *
 * SUPERSEDED by optimal_cycle_size() below, which handles any cycle length
 * with per-pool fees and is exact. This one assumes BOTH pools share `fee`,
 * so callers with differing fees had to average and then refine numerically.
 * Kept for the 2-pool case and for reference against the general form.
 *
 * (The old note here claimed 3-hop and longer cycles have no clean closed
 * form and need ternary search. That was wrong — see fold_cycle.)
 *
 * @param {{a1: number, b1: number}} reserves1
 * @param {{a2: number, b2: number}} reserves2
 * @param {number} [fee=0.003]
 * @returns {number} optimal input amount (may be negative or NaN if no positive
 *          optimum exists — always check trade_profit at the returned value)
 */
export function optimal_trade_size(reserves1, reserves2, fee = 0.003) {
    const { a1, b1 } = reserves1;
    const { a2, b2 } = reserves2;
    const oneMinusF = 1 - fee;
    const denomInner = b1 * oneMinusF + b2;
    const numerator = Math.sqrt(a1 * b1 * a2 * b2 * oneMinusF ** 4 * denomInner ** 2)
                    - a1 * b2 * oneMinusF * denomInner;
    const denominator = (oneMinusF * denomInner) ** 2;
    return numerator / denominator;
}

// -----------------------------------------------------------------------------
// N-hop cycles: exact gate + exact closed-form sizing.
//
// A cycle of N series constant-product pools is itself exactly ONE
// constant-product pool. That single fact replaces the numerical search the
// evaluator used to run for 3-hop cycles, and it generalizes the 2-hop closed
// form above to any length with per-pool fees (no equal-fee assumption, no
// averaging, no refinement pass).
//
// Each hop is {rIn, rOut, fee}: the reserve of the token going IN, the reserve
// of the token coming OUT, and that pool's fee — already oriented for the
// direction being walked.
// -----------------------------------------------------------------------------

/**
 * Cycle product P = prod of (1 - fee_i) * rOut_i / rIn_i.
 *
 * This is the marginal rate of return at infinitesimal size: for a cycle whose
 * gross profit is f(x) = out(x) - x, we have f(0) = 0 and f'(0) = P - 1. Since
 * f is strictly concave on x > 0 (see optimal_cycle_size), P <= 1 means
 * f(x) < 0 for EVERY x > 0 — there is no profitable trade at any size.
 *
 * So `P > 1` is an exact necessary-and-sufficient gate for "could this cycle
 * be profitable at all", costing N multiplies and no search. It is not a
 * heuristic and it has no false negatives: verified against the old ternary
 * search over 400k random 3-hop cycles with zero disagreement on the
 * keep/skip decision.
 *
 * @param {Array<{rIn: number, rOut: number, fee: number}>} hops
 * @returns {number} P
 */
export function cycle_product(hops) {
    let p = 1;
    for (let i = 0; i < hops.length; i++) {
        const h = hops[i];
        p *= (1 - h.fee) * h.rOut / h.rIn;
    }
    return p;
}

/**
 * Fold a cycle of series pools into the single equivalent pool
 *   out(x) = G * x * B / (A + G * x)
 *
 * Derivation for two hops (a1,b1,g1) then (a2,b2,g2), where g = 1 - fee:
 *   out = g2*b2 * [g1*x*b1/(a1+g1*x)] / (a2 + g2*g1*x*b1/(a1+g1*x))
 *       = g1*g2*b1*b2*x / (a1*a2 + g1*(a2 + g2*b1)*x)
 * Dividing through by (a2 + g2*b1) puts it back in the original form with
 *   A' = a1*a2 / (a2 + g2*b1)
 *   B' = g2*b1*b2 / (a2 + g2*b1)
 *   G' = g1
 * The result is the same functional shape as the input, so folding is
 * associative and this iterates to any N.
 *
 * Note G*B/A = prod(g_i * b_i / a_i) = cycle_product(hops) identically, so the
 * gate and the sizing are the same computation seen two ways.
 *
 * Both A and B are bounded by the original reserves (A' <= a1, B' < b2), so
 * this does not accumulate magnitude and cannot overflow float64 for any
 * plausible reserve values.
 *
 * @param {Array<{rIn: number, rOut: number, fee: number}>} hops
 * @returns {{A: number, B: number, G: number}}
 */
export function fold_cycle(hops) {
    let A = hops[0].rIn;
    let B = hops[0].rOut;
    const G = 1 - hops[0].fee;
    for (let i = 1; i < hops.length; i++) {
        const h = hops[i];
        const g = 1 - h.fee;
        const d = h.rIn + g * B;
        A = A * h.rIn / d;
        B = g * B * h.rOut / d;
    }
    return { A, B, G };
}

/**
 * Exact optimal input for an N-hop cycle, maximizing gross profit out(x) - x.
 *
 * With the folded pool out(x) = G*x*B/(A + G*x):
 *   f'(x) = G*A*B / (A + G*x)^2 - 1 = 0  =>  (A + G*x)^2 = A*B*G
 *   x* = (sqrt(A*B*G) - A) / G
 * and f''(x) = -2*G^2*A*B/(A+G*x)^3 < 0, so f is strictly concave and x* is
 * the unique maximum.
 *
 * x* > 0 exactly when A*B*G > A^2, i.e. G*B/A > 1, i.e. cycle_product > 1 —
 * the same condition as the gate, as it must be.
 *
 * This returns the UNCONSTRAINED optimum. Callers must still clamp it to
 * whatever input bounds they enforce (the evaluator caps input at a fraction
 * of the shallowest pool so the on-chain uint112 reserve slots can't overflow)
 * and then evaluate profit at the clamped size.
 *
 * @param {Array<{rIn: number, rOut: number, fee: number}>} hops
 * @returns {number} optimal input; <= 0 when no profitable size exists
 */
export function optimal_cycle_size(hops) {
    const { A, B, G } = fold_cycle(hops);
    if (!(A > 0) || !(B > 0) || !(G > 0)) return 0;
    return (Math.sqrt(A * B * G) - A) / G;
}

/**
 * Gross profit of an N-hop cycle at input x, walking the hops one at a time.
 * Kept separate from the folded form on purpose: this is the number we report
 * and rank on, and it uses the same swap_output the rest of the pipeline uses,
 * so a candidate's profit is never an artifact of the folding algebra.
 *
 * @param {number} x
 * @param {Array<{rIn: number, rOut: number, fee: number}>} hops
 * @returns {number} profit in the root token (may be negative)
 */
export function cycle_profit(x, hops) {
    let amt = x;
    for (let i = 0; i < hops.length; i++) {
        const h = hops[i];
        amt = swap_output(amt, h.rIn, h.rOut, h.fee);
        if (amt === 0) return -x;
    }
    return amt - x;
}

/**
 * Largest value a UniswapV2 pair can hold in a reserve slot.
 *
 * UniswapV2Pair._update ends with
 *
 *     require(balance0 <= uint112(-1) && balance1 <= uint112(-1), 'UniswapV2: OVERFLOW');
 *
 * and that require is the ONLY source of the string "OVERFLOW" in the whole
 * contract. So an `OVERFLOW` revert always means exactly one thing: a post-swap
 * ERC20 balance exceeded 2^112 - 1.
 *
 * Note that float64 cannot represent 2^112 - 1 distinctly from 2^112 (it needs
 * 113 bits of mantissa), so an exact comparison at this scale is meaningless
 * anyway. UINT112_SAFE therefore keeps 0.1% of headroom, which also absorbs
 * reserve movement between scoring and execution — the margin we would want
 * regardless of the representation question.
 */
export const UINT112_MAX = 2 ** 112;
export const UINT112_SAFE = UINT112_MAX * 0.999;

/**
 * Would executing this cycle at input `x` push any pair past the uint112
 * ceiling?
 *
 * WHY THIS IS NOT COVERED BY THE INPUT BOUND
 *
 * The evaluator already caps x at half the smallest INPUT-side reserve, which
 * sounds like it should make overflow impossible. It does not, and a real
 * Polygon run shows why: WPOL -> Dogma -> MegaDoge -> WPOL, where the
 * WPOL/Dogma pool held ~299 WPOL and the Dogma/MegaDoge pool held a Dogma
 * reserve already sitting near 2^112. Capping x at ~149 WPOL is irrelevant;
 * 45 WPOL buys an enormous number of Dogma, and depositing that into the next
 * pair tips its Dogma balance over the ceiling. All five top-ranked Polygon
 * candidates reverted this way.
 *
 * The off-chain math is not wrong about those candidates — the profit is real
 * in float64. It is simply denominated in a number the chain cannot store at
 * that size.
 *
 * REJECT, NOT CLAMP, AND THIS IS A CHOICE
 *
 * Note "at that size": a cycle flagged here is usually still executable if you
 * shrink it to fit the remaining headroom. For the Polygon case above the
 * Dogma side had ~1e32 units of room left, which works out to a ~6 WPOL input
 * against a 149 WPOL optimum. So clamping is possible and would not be
 * nonsense. We reject anyway, for two reasons:
 *
 *   1. The candidate was RANKED at its optimal size. A trade cut to 4% of that
 *      size no longer has the profit that won it a slot, so honouring the
 *      ranking would mean acting on a number that is no longer true.
 *   2. A token whose pools sit against the uint112 ceiling has an absurd
 *      supply, which is a reliable scam/joke-token signal. Sizing a trade to
 *      fit such a token's leftover headroom is not a trade worth engineering.
 *
 * If that ever looks like money being left behind, the fix is to bound the
 * size by per-hop headroom BEFORE optimising, so the candidate is ranked at a
 * size it can actually execute at — not to clamp after ranking.
 *
 * PRECISION, AND WHY THE MARGIN IS NOT COSMETIC
 *
 * At this magnitude float64's spacing is 2^112 * 2^-52 = 2^60, about 1.15e18
 * — roughly 1.15 whole tokens at 18 decimals. Near the ceiling, adding
 * anything smaller than that to a reserve is a no-op in float64, so this check
 * genuinely cannot resolve small headroom and must not pretend to. That is
 * what UINT112_SAFE's margin is for, and it is why build-hops.ts repeats the
 * check in BigInt, where it is exact, before spending an eth_estimateGas.
 *
 * Checks the INPUT side of each hop only. The output side always decreases, so
 * it cannot overflow.
 *
 * @param {number} x
 * @param {Array<{rIn: number, rOut: number, fee: number}>} hops
 * @param {number} [cap]
 * @returns {boolean} true if the cycle is unexecutable at this size
 */
export function cycle_overflows(x, hops, cap = UINT112_SAFE) {
    let amt = x;
    for (let i = 0; i < hops.length; i++) {
        const h = hops[i];
        if (!(h.rIn + amt <= cap)) return true;
        amt = swap_output(amt, h.rIn, h.rOut, h.fee);
        if (!(amt > 0)) return true;
    }
    return false;
}

// -----------------------------------------------------------------------------
// Solidly stable-pool math (Velodrome V2 / Aerodrome / Pharaoh shape).
//
// A stable pool is NOT constant product. Its invariant is
//   k = x³y + xy³  =  x·y·(x² + y²)
// evaluated on reserves NORMALISED to a common unit (each side divided by its
// token's decimals), which is what makes a 6-dp USDC side and an 18-dp DAI side
// comparable. getAmountOut on-chain (Velodrome `_getAmountOut`): take the fee
// off the input, normalise, then Newton-solve the new output reserve that keeps
// k constant, and de-normalise. We reproduce that here in float64 — exact enough
// to SCORE a candidate; the Solidity contract redoes it in integer math before
// anything is sent (same contract as the CP path — see calculus.js header).
//
// Everything below composes in RAW token amounts (same as swap_output), so a
// stable hop drops straight into a mixed cycle next to constant-product hops:
// the normalise/de-normalise happens inside each call.
// -----------------------------------------------------------------------------

/** Stable invariant on NORMALISED reserves X, Y (token-count units): x·y·(x²+y²). */
export function stable_k(X, Y) {
    return X * Y * (X * X + Y * Y);
}

/**
 * Output of one swap on a Solidly STABLE pool, in raw token units.
 * Mirrors Velodrome `getAmountOut`: fee off the input first, then the k-solve.
 *
 * @param {number} amountIn    raw input amount
 * @param {number} reserveIn   raw reserve of the input token
 * @param {number} reserveOut  raw reserve of the output token
 * @param {number} [fee=0.0005]  swap fee as a decimal (stable pools are ~0.01–0.05%)
 * @param {number} [decIn=18]  decimals of the input token
 * @param {number} [decOut=18] decimals of the output token
 * @returns {number} raw amount out (>= 0)
 */
export function stable_amount_out(amountIn, reserveIn, reserveOut, fee = 0.0005, decIn = 18, decOut = 18) {
    if (!(amountIn > 0) || !(reserveIn > 0) || !(reserveOut > 0)) return 0;
    const sIn = 10 ** decIn, sOut = 10 ** decOut;
    const X = reserveIn / sIn;
    const Y = reserveOut / sOut;
    const dx = (amountIn * (1 - fee)) / sIn;      // fee is taken off the input, same as on-chain
    const k = stable_k(X, Y);
    const Xp = X + dx;
    // Solve Xp·y·(Xp² + y²) = k for y (the new output-side reserve), Newton from Y.
    //   g(y)  = Xp·y·(Xp² + y²) − k
    //   g'(y) = Xp·(Xp² + 3y²)
    let y = Y;
    for (let i = 0; i < 64; i++) {
        const g = Xp * y * (Xp * Xp + y * y) - k;
        const gp = Xp * (Xp * Xp + 3 * y * y);
        if (!(gp > 0)) break;
        const step = g / gp;
        y -= step;
        if (Math.abs(step) <= Math.abs(y) * 1e-15) break;
    }
    const outTokens = Y - y;
    return outTokens > 0 ? outTokens * sOut : 0;
}

/**
 * Marginal output rate of a stable hop at infinitesimal size (the spot rate,
 * net of fee), in raw out-token per raw in-token — the stable analogue of
 * (1−fee)·rOut/rIn, for the mixed-cycle gate. The spot slope of x·y·(x²+y²)=k
 * is (3X²Y + Y³)/(X³ + 3XY²) in normalised units; scale back to raw by
 * decOut/decIn.
 * @param {number} reserveIn   raw reserve of the input token
 * @param {number} reserveOut  raw reserve of the output token
 * @param {number} fee         swap fee as a decimal
 * @param {number} [decIn=18]
 * @param {number} [decOut=18]
 * @returns {number} raw out per raw in at zero size
 */
export function stable_marginal(reserveIn, reserveOut, fee, decIn = 18, decOut = 18) {
    const sIn = 10 ** decIn, sOut = 10 ** decOut;
    const X = reserveIn / sIn, Y = reserveOut / sOut;
    const num = 3 * X * X * Y + Y * Y * Y;
    const den = X * X * X + 3 * X * Y * Y;
    if (!(den > 0)) return 0;
    return (1 - fee) * (sOut / sIn) * (num / den);
}

// ----- Convenience wrappers matching the original public API ----------------

/**
 * Single swap using a pair object with `reserves0` (input) and `reserves1` (output).
 * The caller is responsible for orienting the pair so token0 is the input side.
 */
export function swap(pair, amount, fee) {
    return swap_output(amount, Number(pair.reserves0), Number(pair.reserves1), fee);
}

/**
 * Two-hop profit given "from" and "to" pair objects.
 *   from: pair where you swap loan-token OUT for the intermediate token
 *   to:   pair where you swap the intermediate token back to the loan-token
 * Reserves are extracted as numbers; the caller must ensure orientation.
 */
export function profit(from, to, amount, fee) {
    return trade_profit(
        amount,
        { a1: Number(from.reserves0), b1: Number(from.reserves1) },
        { a2: Number(to.reserves0),   b2: Number(to.reserves1)   },
        fee
    );
}

/**
 * Optimum input for a two-hop cycle. See optimal_trade_size.
 */
export function optimum(from, to, fee) {
    return optimal_trade_size(
        { a1: Number(from.reserves0), b1: Number(from.reserves1) },
        { a2: Number(to.reserves0),   b2: Number(to.reserves1)   },
        fee
    );
}
