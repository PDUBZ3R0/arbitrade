// Does the uint112 feasibility filter reject exactly the cycles the chain
// cannot execute, and nothing else?
//
// This covers a failure the other suites structurally cannot reach. The mock
// pair stores reserves as uint112 and would silently truncate a reserve set
// near the ceiling, so anvil cannot reproduce the real revert; and no Sonic
// token sits anywhere near 2^112, so test-index's equivalence check never
// exercises the branch. The filter is therefore tested directly, against the
// arithmetic it is meant to encode.
//
// The case being encoded, from a real Polygon run: all five top-ranked
// candidates were WPOL -> Dogma -> MegaDoge -> WPOL, every one reverting with
// "UniswapV2: OVERFLOW" / "ApeSwap: OVERFLOW". The WPOL/Dogma pool held ~299
// WPOL; the Dogma/MegaDoge pool's Dogma reserve was already near 2^112.

import {
    cycle_overflows, cycle_product, cycle_profit, optimal_cycle_size,
    UINT112_MAX, UINT112_SAFE,
} from '../source/util/calculus.js';

let fails = 0;
const ok = (c, l, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${l} ${extra}`); if (!c) fails++; };

console.log('1. the constants');
{
    ok(UINT112_MAX === 2 ** 112, 'UINT112_MAX is 2^112', UINT112_MAX.toExponential(4));
    // Documents rather than asserts around the float64 limitation: 2^112 needs
    // 113 bits of mantissa, so 2^112 - 1 is not representable and rounds back.
    ok(2 ** 112 - 1 === 2 ** 112, 'float64 cannot distinguish 2^112-1 from 2^112 (hence the margin)');
    ok(UINT112_SAFE < UINT112_MAX && UINT112_SAFE > UINT112_MAX * 0.99,
       'UINT112_SAFE leaves a small margin', `${(100 * (1 - UINT112_SAFE / UINT112_MAX)).toFixed(2)}%`);
    // And the exact BigInt value build-hops.ts uses must agree in magnitude.
    const exact = (1n << 112n) - 1n;
    ok(Math.abs(Number(exact) / UINT112_MAX - 1) < 1e-15,
       "matches build-hops.ts's exact BigInt ceiling");
}

console.log('\n2. an ordinary cycle is untouched');
{
    // Three healthy pools, nowhere near the ceiling.
    const hops = [
        { rIn: 1e21, rOut: 1.02e21, fee: 0.003 },
        { rIn: 1e21, rOut: 1.02e21, fee: 0.003 },
        { rIn: 1e21, rOut: 1.02e21, fee: 0.003 },
    ];
    ok(cycle_product(hops) > 1, 'the cycle is profitable to begin with');
    const x = optimal_cycle_size(hops);
    ok(x > 0 && cycle_profit(x, hops) > 0, 'and has a positive optimum', x.toExponential(3));
    ok(cycle_overflows(x, hops) === false, 'not flagged as overflowing');
    ok(cycle_overflows(1, hops) === false, 'nor at a tiny size');
}

console.log('\n3. the Polygon shape: hop 1 is small, hop 2 sits at the ceiling');
{
    const WPOL = 299e18;                 // ~299 WPOL, matching the observed pool
    const DOGMA_HUGE = UINT112_MAX * 0.98;
    const hops = [
        // WPOL -> Dogma: a thin WPOL side against an enormous Dogma side
        { rIn: WPOL, rOut: DOGMA_HUGE, fee: 0.003 },
        // Dogma -> MegaDoge: the receiving Dogma reserve is already at the cap
        { rIn: DOGMA_HUGE, rOut: 1e24, fee: 0.003 },
        // MegaDoge -> WPOL
        { rIn: 1e24, rOut: 400e18, fee: 0.003 },
    ];

    // The point of the test: this looks GOOD to the profit math.
    ok(cycle_product(hops) > 1, 'the cycle still looks profitable off-chain',
       cycle_product(hops).toFixed(4));
    let x = optimal_cycle_size(hops);
    const hi = Math.min(...hops.map(h => h.rIn)) / 2;
    if (x > hi) x = hi;
    ok(cycle_profit(x, hops) > 0, 'and reports a positive profit at the optimum',
       `${(cycle_profit(x, hops) / 1e18).toFixed(4)} WPOL-ish`);

    // And the old input bound does not save us: x is capped by the SMALLEST
    // input reserve, which is the thin WPOL side, not the huge Dogma side.
    ok(hi === WPOL / 2, 'the input bound is set by the thin pool, not the huge one',
       `hi=${(hi / 1e18).toFixed(1)}`);

    // But it cannot execute at that size.
    ok(cycle_overflows(x, hops) === true, 'the filter rejects it at the optimum');
    ok(cycle_overflows(hi, hops) === true, 'and at the clamped size');

    // Honest about the limit of the claim: there IS residual headroom on the
    // Dogma side, so a much smaller trade would fit. Rejecting is a deliberate
    // choice (see cycle_overflows), not a mathematical necessity, and this
    // asserts the choice rather than a false impossibility.
    const tiny = 1e18;   // 1 WPOL against a 149 WPOL optimum
    ok(cycle_overflows(tiny, hops) === false,
       'a far smaller trade would fit — rejection is a policy, not a necessity');
    const bigEnoughToBreak = 50e18;
    ok(cycle_overflows(bigEnoughToBreak, hops) === true,
       'and the boundary sits between the two', '50 WPOL overflows, 1 WPOL does not');
}

console.log('\n4. the boundary, at a resolution float64 can actually represent');
{
    // The first version of this test used a headroom of 1000 units and failed,
    // for a reason worth keeping: at 2^112 the float64 spacing is 2^60, so
    // `UINT112_SAFE - 1000 === UINT112_SAFE` exactly. A headroom smaller than
    // one ULP does not exist as a number here.
    const ulp = 2 ** 60;
    ok(UINT112_SAFE - 1000 === UINT112_SAFE, 'a 1000-unit headroom is not representable at 2^112');
    ok(UINT112_SAFE - ulp !== UINT112_SAFE, 'one ULP is', `ulp=${ulp.toExponential(3)}`);

    const headroom = 1000 * ulp;   // ~1.15e21, comfortably representable
    const hops = [
        { rIn: UINT112_SAFE - headroom, rOut: 1e24, fee: 0 },
        { rIn: 1e24, rOut: UINT112_SAFE, fee: 0 },
    ];
    ok(cycle_overflows(headroom * 0.5, hops) === false, 'fits well inside the headroom');
    ok(cycle_overflows(headroom * 2, hops) === true, 'overflows well outside it');
}

console.log('\n5. degenerate inputs are rejected, not crashed on');
{
    ok(cycle_overflows(1, [{ rIn: 0, rOut: 1e21, fee: 0.003 }]) === true, 'empty input reserve');
    ok(cycle_overflows(1, [{ rIn: 1e21, rOut: 0, fee: 0.003 }]) === true, 'empty output reserve');
    ok(cycle_overflows(0, [{ rIn: 1e21, rOut: 1e21, fee: 0.003 }]) === true, 'zero size yields no output');
    ok(cycle_overflows(1, []) === false, 'an empty cycle trivially fits');
}

console.log(fails === 0 ? '\nALL OVERFLOW CHECKS PASS' : `\n${fails} FAILED`);
process.exit(fails ? 1 : 0);
