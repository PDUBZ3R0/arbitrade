// Solidly stable-curve math. The anchor check is k-preservation: a swap's
// output must keep the invariant x·y·(x²+y²) constant (fee=0), which is exactly
// what a Velodrome/Aerodrome pool's swap() asserts — so matching it means our
// off-chain quote matches what the pool would allow, without leaning on a
// reimplementation of the pool. Primitives live in calculus.js; the mixed-cycle
// machinery (shared with V3) is in calculus-v3.js.
import { stable_k, stable_amount_out, stable_marginal, swap_output } from '../source/util/calculus.js';
import { hop_output, mixed_cycle_product, mixed_cycle_profit, optimal_mixed_cycle } from '../source/util/calculus-v3.js';

let pass = 0, fail = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log(`  ok   ${m} ${x}`); } else { fail++; console.log(`  FAIL ${m} ${x}`); } };
const rel = (a, b) => Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1);
const kNorm = (rIn, rOut, dIn, dOut) => stable_k(rIn / 10 ** dIn, rOut / 10 ** dOut);

console.log('1. k-preservation (the invariant swap() enforces)');
{
    const rIn = 1_000_000e18, rOut = 1_000_000e18;
    for (const amt of [1e18, 1000e18, 50_000e18, 300_000e18]) {
        const out = stable_amount_out(amt, rIn, rOut, 0, 18, 18);
        const k0 = kNorm(rIn, rOut, 18, 18);
        const k1 = kNorm(rIn + amt, rOut - out, 18, 18);
        ok(rel(k0, k1) < 1e-9, `k preserved at in=${(amt / 1e18).toLocaleString()}`, `rel=${rel(k0, k1).toExponential(1)}`);
    }
}

console.log('2. decimal scaling: 6-dp USDC vs 18-dp DAI, equal token counts');
{
    const rUSDC = 1_000_000e6, rDAI = 1_000_000e18;
    const out = stable_amount_out(1_000e6, rUSDC, rDAI, 0, 6, 18);   // USDC -> DAI
    ok(rel(out, 1_000e18) < 1e-3, 'USDC→DAI 1k ≈ 1k DAI across the decimal gap', `${(out / 1e18).toFixed(2)} DAI`);
    const k0 = kNorm(rUSDC, rDAI, 6, 18), k1 = kNorm(rUSDC + 1_000e6, rDAI - out, 6, 18);
    ok(rel(k0, k1) < 1e-9, 'k preserved across the 6/18 decimal gap', `rel=${rel(k0, k1).toExponential(1)}`);
    const back = stable_amount_out(out, rDAI, rUSDC, 0, 18, 6);      // DAI -> USDC
    ok(rel(back, 1_000e6) < 1e-3, 'round-trip USDC→DAI→USDC ≈ input at fee=0', `${(back / 1e6).toFixed(2)} USDC`);
}

console.log('3. stable has less slippage than CP near balance');
{
    const r = 1_000_000e18, big = 200_000e18;
    const s = stable_amount_out(big, r, r, 0, 18, 18);
    const c = swap_output(big, r, r, 0);
    ok(s > c, 'stable out > CP out for a large trade on a balanced pool', `stable ${(s / 1e18).toFixed(0)} vs CP ${(c / 1e18).toFixed(0)}`);
    ok(s < big, 'stable still has slippage (out < in)');
}

console.log('4. fee reduces output; output scales ~(1−fee) for a small trade');
{
    const r = 1_000_000e18, amt = 10_000e18;
    const noFee = stable_amount_out(amt, r, r, 0, 18, 18);
    const withFee = stable_amount_out(amt, r, r, 0.0005, 18, 18);
    ok(withFee < noFee, 'fee lowers output');
    ok(rel(withFee / noFee, 1 - 0.0005) < 1e-3, 'output ≈ (1−fee)·no-fee for a small trade', `ratio ${(withFee / noFee).toFixed(5)}`);
}

console.log('5. marginal rate matches a tiny discrete trade');
{
    const rIn = 800_000e18, rOut = 1_200_000e18;
    const discrete = stable_amount_out(1e18, rIn, rOut, 0, 18, 18) / 1e18;
    const marginal = stable_marginal(rIn, rOut, 0, 18, 18);
    ok(rel(discrete, marginal) < 1e-4, 'stable_marginal ≈ output/input for a 1-token trade', `${marginal.toFixed(6)} vs ${discrete.toFixed(6)}`);
}

console.log('6. mixed cycle (calculus-v3 machinery): stable leg + CP leg');
{
    const stableHop = { rIn: 2_000_000e6, rOut: 2_000_000e18, fee: 0.0001, stable: true, decIn: 6, decOut: 18 };   // USDC->DAI
    const cpHop = { rIn: 1_000_000e18, rOut: 1_001_500e6, fee: 0.0005, stable: false, decIn: 18, decOut: 6 };       // DAI->USDC, DAI slightly cheap
    const hops = [stableHop, cpHop];
    const P = mixed_cycle_product(hops);
    ok(P > 1, 'gate: mixed stable+CP cycle flagged profitable (P>1)', `P=${P.toFixed(6)}`);
    const r = optimal_mixed_cycle(hops);
    ok(r.x > 0, 'optimizer returns a positive optimum', `x*=${(r.x / 1e6).toFixed(0)} USDC`);
    const prof = mixed_cycle_profit(r.x, hops);
    ok(prof > 0, 'profit at x* is positive', `${(prof / 1e6).toFixed(2)} USDC`);
    ok(prof >= mixed_cycle_profit(r.x * 0.5, hops) && prof >= mixed_cycle_profit(r.x * 1.5, hops), 'x* is at/near the peak');
    const flat = [{ rIn: 2_000_000e6, rOut: 2_000_000e18, fee: 0.0005, stable: true, decIn: 6, decOut: 18 },
                  { rIn: 2_000_000e18, rOut: 2_000_000e6, fee: 0.0005, stable: true, decIn: 18, decOut: 6 }];
    ok(mixed_cycle_product(flat) < 1, 'gate: no-edge stable↔stable cycle rejected (P<1)', `P=${mixed_cycle_product(flat).toFixed(6)}`);
}

console.log('7. hop_output dispatches on h.stable');
{
    ok(hop_output(1e18, { rIn: 1e24, rOut: 1e24, fee: 0, stable: true, decIn: 18, decOut: 18 }) === stable_amount_out(1e18, 1e24, 1e24, 0, 18, 18), 'stable path');
    ok(hop_output(1e18, { rIn: 1e24, rOut: 1e24, fee: 0, stable: false }) === swap_output(1e18, 1e24, 1e24, 0), 'CP path');
}

console.log('8. evaluator integration: orientHop + scoreMixed (the live path)');
{
    const { orientHop, scoreMixed } = await import('../source/evaluator/evaluator.ts');
    const USDC = '0xusdc', DAI = '0xdai';
    // USDC(6)/DAI(18) stable pool, balanced at 2M each.
    const stablePair = { pair: '0xstable', factory: '0xf', token0: USDC, token1: DAI,
        reserves0: 2_000_000e6, reserves1: 2_000_000e18, fee: 0.0001, minReserve0: 0, minReserve1: 0,
        kind: 'v2', stable: true, dec0: 6, dec1: 18 };
    // DAI(18)/USDC(6) constant-product pool with DAI slightly cheap → the round-trip profits.
    const cpPair = { pair: '0xcp', factory: '0xf', token0: DAI, token1: USDC,
        reserves0: 1_000_000e18, reserves1: 1_001_500e6, fee: 0.0005, minReserve0: 0, minReserve1: 0,
        kind: 'v2', stable: false, dec0: 18, dec1: 6 };

    const sh = orientHop(stablePair, USDC);
    ok(sh.stable === true && sh.decIn === 6 && sh.decOut === 18 && sh.rIn === 2_000_000e6 && sh.rOut === 2_000_000e18,
        'orientHop builds a stable hop with correct decimals/reserves', JSON.stringify({ stable: sh.stable, decIn: sh.decIn, decOut: sh.decOut }));
    ok(orientHop(cpPair, DAI).stable === undefined, 'orientHop leaves a CP hop unmarked');

    const sc = scoreMixed([orientHop(stablePair, USDC), orientHop(cpPair, DAI)]);   // USDC→DAI (stable) → USDC (CP)
    ok(!('skip' in sc), 'scoreMixed routes the stable+CP cycle (not skipped)', 'skip' in sc ? sc.skip : '');
    ok(!('skip' in sc) && sc.x > 0 && sc.grossProfit > 0, 'scoreMixed finds a positive stable candidate',
        !('skip' in sc) ? `x=${(sc.x / 1e6).toFixed(0)} USDC, profit=${(sc.grossProfit / 1e6).toFixed(2)} USDC` : '');
}

console.log(`\n${fail === 0 ? 'all passed' : fail + ' FAILED'} (${pass} ok)`);
process.exit(fail === 0 ? 0 : 1);
