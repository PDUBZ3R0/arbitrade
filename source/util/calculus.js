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
 * Formula: y = b * (1 - a / (a + x * (1 - fee)))
 *   which is algebraically identical to the canonical Uniswap V2 form
 *   y = (x * (1-fee) * b) / (a + x * (1-fee))
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
    return b * (1 - a / (a + xNet));
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
 * NOTE: This is 2-hop only. For 3-hop and longer cycles there is no clean
 * closed form and you need numerical optimization (ternary search etc.).
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
