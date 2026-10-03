// -----------------------------------------------------------------------------
// Uniswap V3 concentrated-liquidity math for arbitrage evaluation.
//
// Companion to calculus.js, in the same two tiers the V2 path already uses:
//
//   FLOAT TIER  (ranking; candidate scoring)
//     Inside one initialized-tick range a V3 pool IS a constant-product pool,
//     on virtual reserves  x_v = L / sqrtP,  y_v = L * sqrtP  (x_v * y_v = L^2).
//     A swap of gross input x inside the range returns exactly
//         swap_output(x, x_v, y_v, fee)
//     — the same Möbius form calculus.js already uses — so the V2 gate, fold and
//     closed-form optimum apply per segment. Crossing a tick changes L but NOT
//     the price, so each hop's marginal rate is continuous in its input, each
//     hop is concave, and the whole cycle stays concave with a single profit
//     peak. optimal_mixed_cycle() exploits that: closed form within the current
//     segment combination, step to the next breakpoint only if the optimum lies
//     beyond it. No numerical search.
//
//   EXACT TIER  (confirmation; BigInt)
//     A line-for-line port of v3-core 1.0.0's TickMath, SqrtPriceMath, SwapMath
//     and the UniswapV3Pool.swap loop, including the one-bitmap-word step
//     granularity (the pool splits a swap at every 256*tickSpacing word
//     boundary even when no tick is initialized there, and each split rounds
//     separately, so ignoring it is off by a wei). Verified bit-exact against
//     the deployed UniswapV3Pool bytecode — see test/test-v3-math.mjs.
//
// What this does NOT model (each is a different contract, not a parameter):
//   - PancakeV3: same math, different callback name and slot0 layout. Usable.
//   - Algebra (QuickSwap V3, Camelot, Thena...): dynamic fee, different
//     state getter, fee applied per-step with a different rounding path.
//   - Uniswap V4: hooks can rewrite deltas; out of scope.
//   - Protocol fee: does not change what the swapper pays or receives, so it
//     is correctly ignored here.
// -----------------------------------------------------------------------------

import { swap_output, optimal_cycle_size } from './calculus.js';

// =============================================================================
// Constants
// =============================================================================

export const Q96 = 1n << 96n;
export const MIN_TICK = -887272;
export const MAX_TICK = 887272;
export const MIN_SQRT_RATIO = 4295128739n;
export const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n;

const U256 = (1n << 256n);
const U256_MAX = U256 - 1n;
const U160_MAX = (1n << 160n) - 1n;
const U128 = 1n << 128n;
const Q96F = 2 ** 96;

// =============================================================================
// EXACT TIER — FullMath / UnsafeMath
// =============================================================================

function mulDiv(a, b, d) {
    if (d === 0n) throw new Error('mulDiv: div by zero');
    const r = (a * b) / d;
    if (r > U256_MAX) throw new Error('mulDiv: overflow');
    return r;
}

function mulDivRoundingUp(a, b, d) {
    const r = mulDiv(a, b, d);
    if ((a * b) % d > 0n) {
        if (r >= U256_MAX) throw new Error('mulDivRoundingUp: overflow');
        return r + 1n;
    }
    return r;
}

function divRoundingUp(a, b) {
    return a / b + (a % b > 0n ? 1n : 0n);
}

// =============================================================================
// EXACT TIER — TickMath
// =============================================================================

const TICK_MULTIPLIERS = [
    [0x2n, 0xfff97272373d413259a46990580e213an],
    [0x4n, 0xfff2e50f5f656932ef12357cf3c7fdccn],
    [0x8n, 0xffe5caca7e10e4e61c3624eaa0941cd0n],
    [0x10n, 0xffcb9843d60f6159c9db58835c926644n],
    [0x20n, 0xff973b41fa98c081472e6896dfb254c0n],
    [0x40n, 0xff2ea16466c96a3843ec78b326b52861n],
    [0x80n, 0xfe5dee046a99a2a811c461f1969c3053n],
    [0x100n, 0xfcbe86c7900a88aedcffc83b479aa3a4n],
    [0x200n, 0xf987a7253ac413176f2b074cf7815e54n],
    [0x400n, 0xf3392b0822b70005940c7a398e4b70f3n],
    [0x800n, 0xe7159475a2c29b7443b29c7fa6e889d9n],
    [0x1000n, 0xd097f3bdfd2022b8845ad8f792aa5825n],
    [0x2000n, 0xa9f746462d870fdf8a65dc1f90e061e5n],
    [0x4000n, 0x70d869a156d2a1b890bb3df62baf32f7n],
    [0x8000n, 0x31be135f97d08fd981231505542fcfa6n],
    [0x10000n, 0x9aa508b5b7a84e1c677de54f3e99bc9n],
    [0x20000n, 0x5d6af8dedb81196699c329225ee604n],
    [0x40000n, 0x2216e584f5fa1ea926041bedfe98n],
    [0x80000n, 0x48a170391f7dc42444e8fa2n],
];

/** sqrt(1.0001^tick) * 2^96, exactly as TickMath.getSqrtRatioAtTick. */
export function getSqrtRatioAtTick(tick) {
    if (!Number.isInteger(tick) || tick < MIN_TICK || tick > MAX_TICK) throw new Error('T');
    const absTick = BigInt(tick < 0 ? -tick : tick);
    let ratio = (absTick & 1n) !== 0n ? 0xfffcb933bd6fad37aa2d162d1a594001n : 1n << 128n;
    for (const [bit, m] of TICK_MULTIPLIERS) {
        if ((absTick & bit) !== 0n) ratio = (ratio * m) >> 128n;
    }
    if (tick > 0) ratio = U256_MAX / ratio;
    return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
}

/**
 * Greatest tick t with getSqrtRatioAtTick(t) <= sqrtPriceX96 — the contract's
 * own specification of getTickAtSqrtRatio. The contract computes it with a
 * fixed-point log2; we use a float estimate and correct it against the exact
 * forward function, which gives the same answer by definition.
 */
export function getTickAtSqrtRatio(sqrtPriceX96) {
    if (sqrtPriceX96 < MIN_SQRT_RATIO || sqrtPriceX96 >= MAX_SQRT_RATIO) throw new Error('R');
    const s = Number(sqrtPriceX96) / Q96F;
    let t = Math.floor((2 * Math.log(s)) / Math.log(1.0001));
    t = Math.max(MIN_TICK, Math.min(MAX_TICK - 1, t));
    while (t > MIN_TICK && getSqrtRatioAtTick(t) > sqrtPriceX96) t--;
    while (t < MAX_TICK - 1 && getSqrtRatioAtTick(t + 1) <= sqrtPriceX96) t++;
    return t;
}

// =============================================================================
// EXACT TIER — SqrtPriceMath
// =============================================================================

function nextSqrtFromAmount0RoundingUp(sqrtP, L, amount, add) {
    if (amount === 0n) return sqrtP;
    const numerator1 = L << 96n;
    // Solidity 0.7: `amount * sqrtP` is unchecked, so emulate the 256-bit wrap
    // and the explicit overflow probes the contract performs.
    const product = (amount * sqrtP) % U256;
    if (add) {
        if (product / amount === sqrtP) {
            const denominator = (numerator1 + product) % U256;
            if (denominator >= numerator1) return mulDivRoundingUp(numerator1, sqrtP, denominator);
        }
        return divRoundingUp(numerator1, numerator1 / sqrtP + amount);
    }
    if (!(product / amount === sqrtP && numerator1 > product)) throw new Error('SPM: amount0 out');
    const r = mulDivRoundingUp(numerator1, sqrtP, numerator1 - product);
    if (r > U160_MAX) throw new Error('SPM: toUint160');
    return r;
}

function nextSqrtFromAmount1RoundingDown(sqrtP, L, amount, add) {
    if (add) {
        const q = amount <= U160_MAX ? (amount << 96n) / L : mulDiv(amount, Q96, L);
        const r = sqrtP + q;
        if (r > U160_MAX) throw new Error('SPM: toUint160');
        return r;
    }
    const q = amount <= U160_MAX ? divRoundingUp(amount << 96n, L) : mulDivRoundingUp(amount, Q96, L);
    if (!(sqrtP > q)) throw new Error('SPM: amount1 out');
    return sqrtP - q;
}

function nextSqrtFromInput(sqrtP, L, amountIn, zeroForOne) {
    return zeroForOne
        ? nextSqrtFromAmount0RoundingUp(sqrtP, L, amountIn, true)
        : nextSqrtFromAmount1RoundingDown(sqrtP, L, amountIn, true);
}

function nextSqrtFromOutput(sqrtP, L, amountOut, zeroForOne) {
    return zeroForOne
        ? nextSqrtFromAmount1RoundingDown(sqrtP, L, amountOut, false)
        : nextSqrtFromAmount0RoundingUp(sqrtP, L, amountOut, false);
}

export function getAmount0Delta(a, b, L, roundUp) {
    if (a > b) [a, b] = [b, a];
    const numerator1 = L << 96n;
    const numerator2 = b - a;
    if (!(a > 0n)) throw new Error('SPM: a=0');
    return roundUp
        ? divRoundingUp(mulDivRoundingUp(numerator1, numerator2, b), a)
        : mulDiv(numerator1, numerator2, b) / a;
}

export function getAmount1Delta(a, b, L, roundUp) {
    if (a > b) [a, b] = [b, a];
    return roundUp ? mulDivRoundingUp(L, b - a, Q96) : mulDiv(L, b - a, Q96);
}

// =============================================================================
// EXACT TIER — SwapMath.computeSwapStep
// =============================================================================

/**
 * @param {bigint} sqrtCur
 * @param {bigint} sqrtTarget
 * @param {bigint} L
 * @param {bigint} amountRemaining  >0 exact input, <0 exact output
 * @param {number} feePips          e.g. 3000 for 0.3%
 */
export function computeSwapStep(sqrtCur, sqrtTarget, L, amountRemaining, feePips) {
    const fee = BigInt(feePips);
    const zeroForOne = sqrtCur >= sqrtTarget;
    const exactIn = amountRemaining >= 0n;
    let sqrtNext, amountIn = 0n, amountOut = 0n, feeAmount;

    if (exactIn) {
        const lessFee = mulDiv(amountRemaining, 1_000_000n - fee, 1_000_000n);
        amountIn = zeroForOne
            ? getAmount0Delta(sqrtTarget, sqrtCur, L, true)
            : getAmount1Delta(sqrtCur, sqrtTarget, L, true);
        sqrtNext = lessFee >= amountIn ? sqrtTarget : nextSqrtFromInput(sqrtCur, L, lessFee, zeroForOne);
    } else {
        amountOut = zeroForOne
            ? getAmount1Delta(sqrtTarget, sqrtCur, L, false)
            : getAmount0Delta(sqrtCur, sqrtTarget, L, false);
        sqrtNext = -amountRemaining >= amountOut ? sqrtTarget : nextSqrtFromOutput(sqrtCur, L, -amountRemaining, zeroForOne);
    }

    const max = sqrtTarget === sqrtNext;
    if (zeroForOne) {
        amountIn = max && exactIn ? amountIn : getAmount0Delta(sqrtNext, sqrtCur, L, true);
        amountOut = max && !exactIn ? amountOut : getAmount1Delta(sqrtNext, sqrtCur, L, false);
    } else {
        amountIn = max && exactIn ? amountIn : getAmount1Delta(sqrtCur, sqrtNext, L, true);
        amountOut = max && !exactIn ? amountOut : getAmount0Delta(sqrtCur, sqrtNext, L, false);
    }
    if (!exactIn && amountOut > -amountRemaining) amountOut = -amountRemaining;

    feeAmount = exactIn && sqrtNext !== sqrtTarget
        ? amountRemaining - amountIn
        : mulDivRoundingUp(amountIn, fee, 1_000_000n - fee);

    return { sqrtNext, amountIn, amountOut, feeAmount };
}

// =============================================================================
// EXACT TIER — TickBitmap.nextInitializedTickWithinOneWord, over a sorted list
// =============================================================================

// floor division / arithmetic shift, which JS `/` and `>>` on Numbers don't
// give for negatives the way Solidity's int24 `>> 8` does.
const fdiv = (a, b) => Math.floor(a / b);

function compress(tick, spacing) {
    return fdiv(tick, spacing);   // == (tick / spacing) then -- for negative remainders
}

/**
 * Same result as the bitmap lookup, computed from a sorted array of
 * initialized tick indices. Returns { next, initialized }.
 */
function nextInitializedTickWithinOneWord(sortedTicks, tick, spacing, lte) {
    const compressed = compress(tick, spacing);
    if (lte) {
        const wordStart = fdiv(compressed, 256) * 256;
        // largest initialized c with wordStart <= c <= compressed
        let lo = 0, hi = sortedTicks.length - 1, best = -1;
        const maxIdx = compressed * spacing;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (sortedTicks[mid].index <= maxIdx) { best = mid; lo = mid + 1; } else hi = mid - 1;
        }
        if (best >= 0 && compress(sortedTicks[best].index, spacing) >= wordStart) {
            return { next: sortedTicks[best].index, initialized: true, at: best };
        }
        return { next: wordStart * spacing, initialized: false };
    }
    const c1 = compressed + 1;
    const wordEnd = fdiv(c1, 256) * 256 + 255;
    // smallest initialized c with c1 <= c <= wordEnd
    let lo = 0, hi = sortedTicks.length - 1, best = -1;
    const minIdx = c1 * spacing;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (sortedTicks[mid].index >= minIdx) { best = mid; hi = mid - 1; } else lo = mid + 1;
    }
    if (best >= 0 && compress(sortedTicks[best].index, spacing) <= wordEnd) {
        return { next: sortedTicks[best].index, initialized: true, at: best };
    }
    return { next: wordEnd * spacing, initialized: false };
}

// =============================================================================
// EXACT TIER — UniswapV3Pool.swap
// =============================================================================

/**
 * @typedef {Object} V3Pool
 * @property {bigint} sqrtPriceX96   slot0.sqrtPriceX96
 * @property {number} tick           slot0.tick
 * @property {bigint} liquidity      pool.liquidity()
 * @property {number} fee            fee in pips (500, 3000, 10000, ...)
 * @property {number} tickSpacing
 * @property {Array<{index:number, liquidityNet:bigint}>} ticks
 *           initialized ticks, sorted ascending by index
 * @property {number} [windowLow]    ticks list is complete for indices >= this
 * @property {number} [windowHigh]   ticks list is complete for indices <= this
 */

/**
 * Simulate UniswapV3Pool.swap without touching the chain.
 *
 * Result amounts use the pool's sign convention: positive = paid INTO the
 * pool, negative = paid OUT. `complete` is false when the swap needed tick
 * data outside [windowLow, windowHigh]; the amounts then cover only the part
 * that was inside the window and MUST NOT be trusted as the full swap.
 *
 * @param {V3Pool} pool
 * @param {boolean} zeroForOne
 * @param {bigint} amountSpecified   >0 exact input, <0 exact output
 * @param {bigint} [sqrtPriceLimitX96]  defaults to MIN+1 / MAX-1 (no limit)
 */
export function v3_swap_exact(pool, zeroForOne, amountSpecified, sqrtPriceLimitX96) {
    if (amountSpecified === 0n) throw new Error('AS');
    const limit = sqrtPriceLimitX96 ?? (zeroForOne ? MIN_SQRT_RATIO + 1n : MAX_SQRT_RATIO - 1n);
    if (zeroForOne
        ? !(limit < pool.sqrtPriceX96 && limit > MIN_SQRT_RATIO)
        : !(limit > pool.sqrtPriceX96 && limit < MAX_SQRT_RATIO)) throw new Error('SPL');

    const exactInput = amountSpecified > 0n;
    const ticks = pool.ticks;
    const spacing = pool.tickSpacing;
    const wLow = pool.windowLow ?? MIN_TICK;
    const wHigh = pool.windowHigh ?? MAX_TICK;

    let remaining = amountSpecified;
    let calculated = 0n;
    let sqrtP = pool.sqrtPriceX96;
    let tick = pool.tick;
    let L = pool.liquidity;
    let steps = 0, crossed = 0, complete = true;

    while (remaining !== 0n && sqrtP !== limit) {
        const start = sqrtP;
        let { next, initialized, at } = nextInitializedTickWithinOneWord(ticks, tick, spacing, zeroForOne);
        if (zeroForOne ? next < wLow : next > wHigh) { complete = false; break; }
        if (next < MIN_TICK) next = MIN_TICK; else if (next > MAX_TICK) next = MAX_TICK;
        const sqrtNextTick = getSqrtRatioAtTick(next);
        const target = (zeroForOne ? sqrtNextTick < limit : sqrtNextTick > limit) ? limit : sqrtNextTick;

        const s = computeSwapStep(sqrtP, target, L, remaining, pool.fee);
        sqrtP = s.sqrtNext;
        steps++;

        if (exactInput) {
            remaining -= s.amountIn + s.feeAmount;
            calculated -= s.amountOut;
        } else {
            remaining += s.amountOut;
            calculated += s.amountIn + s.feeAmount;
        }

        if (sqrtP === sqrtNextTick) {
            if (initialized) {
                let net = ticks[at].liquidityNet;
                if (zeroForOne) net = -net;
                L += net;
                if (L < 0n || L >= U128) throw new Error(net < 0n ? 'LS' : 'LA');
                crossed++;
            }
            tick = zeroForOne ? next - 1 : next;
        } else if (sqrtP !== start) {
            tick = getTickAtSqrtRatio(sqrtP);
        }
    }

    const [amount0, amount1] = zeroForOne === exactInput
        ? [amountSpecified - remaining, calculated]
        : [calculated, amountSpecified - remaining];

    return { amount0, amount1, sqrtPriceX96: sqrtP, tick, liquidity: L, steps, crossed, complete };
}

/**
 * Convenience: exact-input swap returning just the output amount (positive),
 * or 0n when the window was not deep enough to price it.
 */
export function v3_amount_out_exact(pool, zeroForOne, amountIn) {
    const r = v3_swap_exact(pool, zeroForOne, amountIn);
    if (!r.complete) return 0n;
    const out = zeroForOne ? -r.amount1 : -r.amount0;
    // A price-limit stop would leave input unspent; with the default limit that
    // only happens at the absolute price bounds.
    const used = zeroForOne ? r.amount0 : r.amount1;
    return used === amountIn ? out : 0n;
}

/**
 * Apply a Swap event's absolute post-state to a cached pool. The event carries
 * sqrtPriceX96, liquidity and tick, so — like V2's Sync — replaying it is
 * idempotent. It does NOT carry tick-table changes; those come from Mint/Burn.
 */
export function v3_apply_swap_event(pool, { sqrtPriceX96, liquidity, tick }) {
    pool.sqrtPriceX96 = BigInt(sqrtPriceX96);
    pool.liquidity = BigInt(liquidity);
    pool.tick = Number(tick);
    return pool;
}

/**
 * Apply a Mint (delta > 0) or Burn (delta < 0, pass -amount) to the cached
 * tick table and active liquidity, mirroring Pool._modifyPosition.
 */
export function v3_apply_position_change(pool, tickLower, tickUpper, delta) {
    const bump = (index, d) => {
        const i = pool.ticks.findIndex(t => t.index >= index);
        if (i >= 0 && pool.ticks[i].index === index) {
            pool.ticks[i].liquidityNet += d;
            // liquidityGross is not tracked; a net of zero usually means the
            // tick was cleared, and an uninitialized tick only costs an extra
            // zero-liquidity step, which changes nothing in the amounts.
            if (pool.ticks[i].liquidityNet === 0n) pool.ticks.splice(i, 1);
        } else {
            pool.ticks.splice(i < 0 ? pool.ticks.length : i, 0, { index, liquidityNet: d });
        }
    };
    bump(tickLower, delta);
    bump(tickUpper, -delta);
    if (pool.tick >= tickLower && pool.tick < tickUpper) pool.liquidity += delta;
    return pool;
}

// =============================================================================
// FLOAT TIER — hops
// =============================================================================

/**
 * Build a float hop for one direction through a V3 pool. The result is
 * accepted by the mixed_* functions below alongside plain V2 hops
 * ({rIn, rOut, fee}).
 *
 * Edges are the initialized ticks in the walk direction, with the liquidity
 * change already signed for that direction. `wallS` is the last price the tick
 * window vouches for; a hop never prices input beyond it.
 *
 * @param {V3Pool} pool
 * @param {boolean} zeroForOne
 */
export function v3_float_hop(pool, zeroForOne) {
    const edges = [];
    if (zeroForOne) {
        for (let i = pool.ticks.length - 1; i >= 0; i--) {
            const t = pool.ticks[i];
            if (t.index > pool.tick) continue;
            if (pool.windowLow !== undefined && t.index < pool.windowLow) break;
            edges.push({ s: Number(getSqrtRatioAtTick(t.index)) / Q96F, dL: -Number(t.liquidityNet) });
        }
    } else {
        for (const t of pool.ticks) {
            if (t.index <= pool.tick) continue;
            if (pool.windowHigh !== undefined && t.index > pool.windowHigh) break;
            edges.push({ s: Number(getSqrtRatioAtTick(t.index)) / Q96F, dL: Number(t.liquidityNet) });
        }
    }
    const wallTick = zeroForOne
        ? Math.max(MIN_TICK, pool.windowLow ?? MIN_TICK)
        : Math.min(MAX_TICK, pool.windowHigh ?? MAX_TICK);
    return {
        v3: true,
        zeroForOne,
        fee: pool.fee / 1e6,
        s: Number(pool.sqrtPriceX96) / Q96F,
        L: Number(pool.liquidity),
        edges,
        wallS: Number(getSqrtRatioAtTick(wallTick)) / Q96F,
    };
}

// Mutable walking state for one hop. V2 hops get the same interface with an
// unbounded single segment, so the optimizer treats them uniformly.
function cursor(h) {
    return h.v3
        ? { v3: true, zf: h.zeroForOne, g: 1 - h.fee, fee: h.fee, s: h.s, L: h.L, edges: h.edges, i: 0, wallS: h.wallS }
        : { v3: false, g: 1 - h.fee, fee: h.fee, rIn: h.rIn, rOut: h.rOut };
}

// Relative distance below which a cursor counts as sitting ON its next edge.
// The optimizer maps a breakpoint back through the inverse of earlier hops and
// then forward again; float rounding can land a hop one ulp short of its tick,
// leaving a residual segment so thin the next iteration makes no progress.
// Snapping across at 1e-12 of the virtual reserve is far below anything that
// moves a price or an amount we care about.
const EDGE_EPS = 1e-12;

// A zero-liquidity gap is crossed for free (the contract does the same: a step
// with L = 0 moves the price to the next tick at zero cost). So is an edge the
// cursor is already, to within EDGE_EPS, sitting on.
function normalize(c) {
    while (c.v3 && c.i < c.edges.length) {
        const e = c.edges[c.i].s;
        if (c.L > 0) {
            const rIn = c.zf ? c.L / c.s : c.L * c.s;
            const capNet = (c.zf ? c.L / e : c.L * e) - rIn;
            if (capNet > EDGE_EPS * rIn) break;
        }
        c.s = e; c.L += c.edges[c.i].dL; c.i++;
    }
}

// Current segment as a V2-shaped hop plus its capacity in GROSS input.
function segment(c) {
    if (!c.v3) return { rIn: c.rIn, rOut: c.rOut, fee: c.fee, cap: Infinity, wall: false };
    normalize(c);
    if (!(c.L > 0)) return { rIn: 0, rOut: 0, fee: c.fee, cap: 0, wall: true };
    const L = c.L, s = c.s;
    const edge = c.i < c.edges.length ? c.edges[c.i].s : c.wallS;
    const wall = c.i >= c.edges.length;
    let rIn, rOut, capNet;
    if (c.zf) { rIn = L / s; rOut = L * s; capNet = L / edge - rIn; }
    else      { rIn = L * s; rOut = L / s; capNet = L * edge - rIn; }
    return { rIn, rOut, fee: c.fee, cap: Math.max(0, capNet) / c.g, wall };
}

// Push gross input x through the hop, crossing edges as needed. Returns
// { out, left } — `left` is input that hit the wall and was not priced.
function advance(c, x) {
    let net = x * c.g, out = 0;
    if (!c.v3) {
        // Advance on NET input so that out(a) then out(b) == out(a + b) exactly
        // in real arithmetic — the property the segment stepping relies on.
        // (Booking the gross input, as the real pair does, differs only at
        // second order in the fee.)
        const o = (net * c.rOut) / (c.rIn + net);
        c.rIn += net; c.rOut -= o;
        return { out: o, left: 0 };
    }
    while (net > 0) {
        normalize(c);
        if (!(c.L > 0)) break;
        const hasEdge = c.i < c.edges.length;
        const edge = hasEdge ? c.edges[c.i].s : c.wallS;
        const L = c.L;
        const rIn = c.zf ? L / c.s : L * c.s;
        const rOut = c.zf ? L * c.s : L / c.s;
        const capNet = (c.zf ? L / edge : L * edge) - rIn;
        if (net < capNet - EDGE_EPS * rIn) {
            out += (rOut * net) / (rIn + net);
            const xv = rIn + net;
            c.s = c.zf ? L / xv : xv / L;
            net = 0;
            break;
        }
        const used = Math.max(0, Math.min(net, capNet));
        out += used > 0 ? (rOut * used) / (rIn + used) : 0;
        net -= used;
        c.s = edge;
        if (!hasEdge) break;               // wall
        c.L += c.edges[c.i].dL; c.i++;
    }
    return { out, left: net / c.g };
}

/** Float output of one hop (V2 or V3) for gross input x. Wall-limited. */
export function hop_output(x, h) {
    if (!(x > 0)) return 0;
    if (!h.v3) return swap_output(x, h.rIn, h.rOut, h.fee);
    return advance(cursor(h), x).out;
}

/**
 * Marginal cycle rate at zero size — the exact gate, as in calculus.js.
 * For a V3 hop the marginal rate is just the (fee-adjusted) pool price.
 */
export function mixed_cycle_product(hops) {
    let p = 1;
    for (const h of hops) {
        const sg = segment(cursor(h));
        if (!(sg.rIn > 0)) return 0;
        p *= (1 - sg.fee) * sg.rOut / sg.rIn;
    }
    return p;
}

/**
 * Gross profit at input x, walking every hop piecewise. Input that a V3 hop
 * cannot price inside its tick window is treated as lost (conservative).
 */
export function mixed_cycle_profit(x, hops) {
    let amt = x;
    for (const h of hops) {
        amt = hop_output(amt, h);
        if (!(amt > 0)) return -x;
    }
    return amt - x;
}

/**
 * Exact (in real arithmetic) profit-maximizing input for a cycle of any mix of
 * V2 and V3 hops.
 *
 * Within the current segment of every hop, the cycle is ONE constant-product
 * pool, so optimal_cycle_size gives the optimum in closed form. If that
 * optimum is reachable without any hop leaving its segment, it is the global
 * optimum (profit is concave). Otherwise advance every hop to the first
 * breakpoint, re-fold from the new state, and repeat. Iterations are bounded
 * by the number of tick crossings on the optimal path.
 *
 * Returns { x, wall, iterations }. `wall` is true when the optimum was
 * clamped at the edge of some hop's tick window — profit is still positive
 * there, but a wider window might find more.
 *
 * @param {Array} hops  V2 hops {rIn, rOut, fee} and/or v3_float_hop() results
 */
export function optimal_mixed_cycle(hops, maxIter = 256) {
    const cs = hops.map(cursor);
    let total = 0;
    for (let it = 0; it < maxIter; it++) {
        const segs = cs.map(segment);
        if (segs.some(s => !(s.rIn > 0) || !(s.rOut > 0))) return { x: total, wall: true, iterations: it };

        const xs = optimal_cycle_size(segs);
        if (!(xs > 0)) return { x: total, wall: false, iterations: it };

        // First breakpoint, mapped back to cycle-input space through the
        // inverse Möbius map of each preceding hop's current segment:
        //   y = g x B / (A + g x)   <=>   x = A y / (g (B - y))
        let db = Infinity, binding = -1;
        for (let i = 0; i < segs.length; i++) {
            let c = segs[i].cap;
            for (let j = i - 1; j >= 0 && Number.isFinite(c); j--) {
                const sj = segs[j];
                c = c < sj.rOut ? (sj.rIn * c) / ((1 - sj.fee) * (sj.rOut - c)) : Infinity;
            }
            if (c < db) { db = c; binding = i; }
        }

        if (xs <= db) return { x: total + xs, wall: false, iterations: it + 1 };

        total += db;
        let amt = db;
        for (const c of cs) amt = advance(c, amt).out;
        if (segs[binding].wall) return { x: total, wall: true, iterations: it + 1 };
    }
    return { x: total, wall: false, iterations: maxIter };
}
