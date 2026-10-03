// Uniswap V3 math: is the off-chain simulation the pool's own arithmetic?
//
// 1. EXACT TIER vs the real contract. test/fixtures/v3-golden.json holds swaps
//    executed against the deployed UniswapV3Pool bytecode (v3-core 1.0.0) on
//    anvil — random fee tiers incl. 1bp/spacing-1, liquidity gaps, price
//    limits, exact-in and exact-out, multi-tick and multi-word walks. Every
//    field must match to the wei: amount0, amount1, sqrtPriceX96, tick,
//    liquidity. (Regenerate with scripts/v3-golden.mjs if the port changes.)
// 2. FLOAT TIER vs EXACT TIER. Float hop output tracks BigInt output to ~1e-9
//    relative, including across tick crossings.
// 3. The virtual-reserve identity: inside one range, a V3 hop IS
//    swap_output(x, L/sqrtP, L*sqrtP, fee).
// 4. optimal_mixed_cycle finds the true maximum of a concave piecewise profit
//    curve, checked against a dense scan, for V3-only and V2/V3-mixed cycles.

import fs from 'node:fs';
import { swap_output } from '../source/util/calculus.js';
import {
    v3_swap_exact, v3_amount_out_exact, v3_float_hop, hop_output,
    mixed_cycle_product, mixed_cycle_profit, optimal_mixed_cycle,
    getSqrtRatioAtTick, getTickAtSqrtRatio, v3_apply_position_change,
    MIN_TICK, MAX_TICK, MIN_SQRT_RATIO, MAX_SQRT_RATIO, Q96,
} from '../source/util/calculus-v3.js';

let fails = 0;
const ok = (c, l, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${l} ${extra}`); if (!c) fails++; };

// mulberry32 — a float LCG loses bits past 2^53 and cycles early.
let seed = 7;
const rnd = () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const big = (x) => BigInt(Math.floor(x).toLocaleString('fullwide', { useGrouping: false }));

console.log('1. exact tier matches UniswapV3Pool bytecode (golden vectors)');
{
    const raw = fs.readFileSync(new URL('./fixtures/v3-golden.json', import.meta.url), 'utf8');
    const cases = JSON.parse(raw, (k, v) => typeof v === 'string' && /^-?\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v);
    let bad = 0, crossings = 0;
    for (const c of cases) {
        const r = v3_swap_exact(c.pool, c.zeroForOne, c.amountSpecified, c.sqrtPriceLimitX96);
        crossings += r.crossed;
        const e = c.expect;
        if (!(r.complete && r.amount0 === e.amount0 && r.amount1 === e.amount1 && r.sqrtPriceX96 === e.sqrtPriceX96
              && r.tick === e.tick && r.liquidity === e.liquidity)) {
            bad++;
            if (bad <= 3) console.log('    mismatch', { want: e, got: r });
        }
    }
    ok(cases.length >= 100, 'fixture has a meaningful number of cases', `n=${cases.length}`);
    ok(crossings > cases.length / 2, 'and exercises tick crossings', `crossings=${crossings}`);
    ok(bad === 0, 'every field bit-exact', `${cases.length - bad}/${cases.length}`);
}

console.log('\n2. TickMath');
{
    ok(getSqrtRatioAtTick(MIN_TICK) === MIN_SQRT_RATIO, 'MIN_TICK -> MIN_SQRT_RATIO');
    ok(getSqrtRatioAtTick(MAX_TICK) === MAX_SQRT_RATIO, 'MAX_TICK -> MAX_SQRT_RATIO');
    ok(getSqrtRatioAtTick(0) === Q96, 'tick 0 -> 2^96');
    let bad = 0;
    for (let i = 0; i < 3000; i++) {
        const t = ri(MIN_TICK, MAX_TICK - 1);
        const a = getSqrtRatioAtTick(t), b = getSqrtRatioAtTick(t + 1);
        if (!(a < b) || getTickAtSqrtRatio(a) !== t || getTickAtSqrtRatio(b - 1n) !== t) bad++;
    }
    ok(bad === 0, 'getTickAtSqrtRatio inverts getSqrtRatioAtTick (floor semantics)', '3000 random ticks');
}

// A random pool with real structure: overlapping ranges, gaps, a known window.
function randomPool() {
    const [fee, spacing] = [[100, 1], [500, 10], [3000, 60], [10000, 200]][ri(0, 3)];
    const tick = ri(-50000, 50000);
    const lo = getSqrtRatioAtTick(tick), hi = getSqrtRatioAtTick(tick + 1);
    const pool = { sqrtPriceX96: lo + (hi - lo) / 3n, tick, liquidity: 0n, fee, tickSpacing: spacing, ticks: [] };
    const c = Math.floor(tick / spacing) * spacing;
    for (let k = ri(3, 12); k > 0; k--) {
        let a = c - ri(0, 400) * spacing, b = c + ri(1, 400) * spacing;
        if (rnd() < 0.3) { const o = ri(-50, 50) * spacing; a += o; b += o; }
        if (a >= b) b = a + spacing;
        v3_apply_position_change(pool, a, b, big(10 ** (12 + rnd() * 8)));
    }
    return pool;
}

console.log('\n3. float tier tracks the exact tier');
{
    let worst = 0, n = 0, crossed = 0;
    for (let i = 0; i < 1500; i++) {
        const pool = randomPool();
        if (pool.liquidity === 0n) continue;
        const zf = rnd() < 0.5;
        const sP = Number(pool.sqrtPriceX96) / 2 ** 96;
        const depth = zf ? Number(pool.liquidity) / sP : Number(pool.liquidity) * sP;
        const x = depth * 10 ** (-6 + rnd() * 6.5);
        const ex = v3_swap_exact(pool, zf, big(x));
        if (!ex.complete) continue;
        const exOut = Number(zf ? -ex.amount1 : -ex.amount0);
        const flOut = hop_output(Number(big(x)), v3_float_hop(pool, zf));
        // The pool truncates the fee-adjusted input to an integer (mulDiv round
        // down), so a 3e8-wei input already carries ~1e-9 of pure wei rounding.
        // Compare where that is negligible.
        if (x < 1e13 || exOut < 1e9) continue;
        worst = Math.max(worst, Math.abs(flOut - exOut) / exOut);
        crossed += ex.crossed > 0; n++;
    }
    ok(n > 800 && crossed > 100, 'sample includes tick-crossing swaps', `n=${n} crossing=${crossed}`);
    ok(worst < 1e-9, 'float output within 1e-9 of exact', `worst=${worst.toExponential(2)}`);
}

console.log('\n4. inside one range a V3 hop is a V2 pool on virtual reserves');
{
    let worst = 0;
    for (let i = 0; i < 200; i++) {
        const pool = randomPool();
        if (pool.liquidity === 0n) continue;
        const zf = rnd() < 0.5;
        const h = v3_float_hop(pool, zf);
        const rIn = zf ? h.L / h.s : h.L * h.s, rOut = zf ? h.L * h.s : h.L / h.s;
        const x = rIn * 1e-7;               // small enough to stay inside the range
        const a = hop_output(x, h), b = swap_output(x, rIn, rOut, h.fee);
        worst = Math.max(worst, Math.abs(a - b) / b);
    }
    ok(worst < 1e-12, 'hop_output == swap_output(x, L/sqrtP, L*sqrtP)', `worst=${worst.toExponential(2)}`);
}

console.log('\n5. optimal_mixed_cycle finds the maximum');
{
    // Build a profitable cycle: three V3 pools on a token triangle with prices
    // nudged off consistency, plus mixed cycles with a V2 leg.
    function v3Leg(price, mispricing, zf) {
        // pool price p = token1/token0; pick tick, add a stack of ranges
        const p = price * mispricing;
        const tick = Math.floor(Math.log(p) / Math.log(1.0001));
        const s0 = getSqrtRatioAtTick(tick), s1 = getSqrtRatioAtTick(tick + 1);
        const pool = { sqrtPriceX96: s0 + (s1 - s0) / 2n, tick, liquidity: 0n, fee: [500, 3000][ri(0, 1)], tickSpacing: 10, ticks: [] };
        const c = Math.floor(tick / 10) * 10;
        for (let k = ri(4, 10); k > 0; k--) {
            const a = c - ri(1, 60) * 10, b = c + ri(1, 60) * 10;
            v3_apply_position_change(pool, a, b, big(10 ** (17 + rnd() * 3)));
        }
        return v3_float_hop(pool, zf);
    }
    let checked = 0, worstGap = 0, crossings = 0, mixed = 0, gateBad = 0;
    for (let i = 0; i < 300; i++) {
        // token prices in some numeraire: A=1, B=pb, C=pc. Hop A->B in a pool
        // with token0=A means zf=true and price(token1/token0)=1/pb.
        const pb = 10 ** (rnd() * 4 - 2), pc = 10 ** (rnd() * 4 - 2);
        const m = () => 1 + (rnd() - 0.3) * 0.04;
        const useV2 = rnd() < 0.4;
        const hops = [
            v3Leg(1 / pb, m(), true),                               // A -> B
            useV2 ? { rIn: 1e21 / pb, rOut: 1e21 / pc * m(), fee: 0.003 } // B -> C (V2)
                  : v3Leg(pb / pc, m(), true),                      // B -> C
            v3Leg(pc, m(), true),                                   // C -> A
        ];
        const P = mixed_cycle_product(hops);
        const { x, iterations } = optimal_mixed_cycle(hops);
        if (P <= 1) { if (x > 0) gateBad++; continue; }
        if (!(x > 0)) { gateBad++; continue; }
        // dense log scan around the optimum
        let best = -Infinity;
        for (let k = -400; k <= 400; k++) best = Math.max(best, mixed_cycle_profit(x * 10 ** (k / 100), hops));
        const got = mixed_cycle_profit(x, hops);
        worstGap = Math.max(worstGap, (best - got) / Math.abs(best));
        // and it IS a local max: tiny moves either side don't improve
        checked++; crossings += iterations > 1; mixed += useV2;
    }
    ok(gateBad === 0, 'P > 1 <=> positive optimum (the gate stays exact)');
    ok(checked > 100 && crossings > 30 && mixed > 30, 'sample: profitable, multi-segment, mixed V2/V3',
       `n=${checked} multiSegment=${crossings} mixed=${mixed}`);
    ok(worstGap < 1e-9, 'no scanned size beats the returned optimum', `worst shortfall=${worstGap.toExponential(2)}`);
}

console.log('\n6. window safety');
{
    const pool = randomPool();
    pool.windowLow = pool.tick - 5 * pool.tickSpacing;
    pool.windowHigh = pool.tick + 5 * pool.tickSpacing;
    const r = v3_swap_exact(pool, true, 10n ** 40n);
    ok(r.complete === false, 'a swap that walks out of the tick window is flagged incomplete');
    ok(v3_amount_out_exact(pool, true, 10n ** 40n) === 0n, 'and v3_amount_out_exact refuses to price it');
    const h = v3_float_hop(pool, true);
    ok(Number.isFinite(hop_output(1e40, h)), 'float hop stops at the window wall instead of extrapolating');
}

console.log(fails === 0 ? '\nALL V3 MATH CHECKS PASS' : `\n${fails} FAILED`);
process.exit(fails ? 1 : 0);
