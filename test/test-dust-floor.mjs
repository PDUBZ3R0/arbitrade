// A pool holding a few raw units pays whole units, not fractions.
//
// Polygon, 2026-10-30: pair 0xe24548… held 2,562,695 raw USDC (2.56 USDC)
// against 2 units of XSC, a 0-decimal token. The float walk credited ~0.6 XSC
// for a couple of USDC, the next pool valued that above the input, and the
// index scored an edge. The exact walk floors to 0 XSC: 33 of the run's 51
// "edge decayed" attempts went through that pair, one cycle 13 times.
//
//   node --experimental-strip-types test/test-dust-floor.mjs   (no anvil)

import { cycle_product, cycle_profit, optimal_cycle_size, cycle_input_cap, swap_output } from '../source/util/calculus.js';
import { mixed_cycle_profit } from '../source/util/calculus-v3.js';
import { scoreMixed } from '../source/evaluator/evaluator.ts';

let fails = 0;
const ok = (c, l, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${l} ${extra}`); if (!c) fails++; };

// USDC -> XSC on the dust pair, XSC -> USDC on a pool that prices XSC at ~10 USDC.
const dust = [
    { rIn: 2_562_695, rOut: 2, fee: 0.003 },
    { rIn: 10, rOut: 100_000_000, fee: 0.003 },
];

console.log('1. the XSC dust cycle');
{
    ok(cycle_product(dust) > 1, 'the continuous gate still says open (what the index saw)', cycle_product(dust).toFixed(2));
    let x = optimal_cycle_size(dust);
    const hi = cycle_input_cap(dust);
    if (x < 1) x = 1; else if (x > hi) x = hi;
    const fractional = swap_output(x, dust[0].rIn, dust[0].rOut, dust[0].fee);
    ok(fractional > 0 && fractional < 1, 'at its size, hop 1 is a fraction of one XSC', fractional.toFixed(3));
    ok(cycle_profit(x, dust) === -x, 'cycle_profit floors that to 0 XSC: the whole input is lost', `${cycle_profit(x, dust)} at x=${x}`);
    ok(mixed_cycle_profit(x, dust) > 0, 'the unfloored walk is what scored it profitable (control)', mixed_cycle_profit(x, dust).toFixed(0));
    ok(mixed_cycle_profit(x, dust, true) === -x, 'mixed_cycle_profit(whole) agrees with cycle_profit');
    const sc = scoreMixed(dust);
    ok('skip' in sc, 'scoreMixed drops it', JSON.stringify(sc));
}

console.log('\n2. a real pool is unaffected');
{
    const deep = [
        { rIn: 1_000_000e6, rOut: 1_000e18, fee: 0.003 },
        { rIn: 990e18, rOut: 1_000_000e6, fee: 0.003 },
    ];
    const x = Math.min(optimal_cycle_size(deep), cycle_input_cap(deep));
    const floored = cycle_profit(x, deep), raw = mixed_cycle_profit(x, deep);
    ok(floored > 0 && Math.abs(floored - raw) <= 1, 'profit within one raw unit of the continuous walk', `${floored.toFixed(0)} vs ${raw.toFixed(0)}`);
}

console.log(fails ? `\n${fails} FAILED` : '\nALL DUST-FLOOR CHECKS PASS');
process.exit(fails ? 1 : 0);
