// verify-v3-factory's Algebra path against a scripted provider (no RPC).
// Integral: 6-word globalState + live fee(); V1: 7-word globalState, no fee().
//   node --experimental-strip-types test/test-verify-algebra.mjs
import { ethers } from 'ethers';
import { verifyV3Factory } from '../source/util/verify-v3-factory.ts';
import { POOL_CREATED_ALGEBRA_TOPIC } from '../source/util/pool-events.ts';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ok   ${m}`); } else { fail++; console.log(`  FAIL ${m}`); } };

const FACTORY = '0x' + 'fa'.repeat(20);
const POOL = '0x' + '9a'.repeat(20);
const T0 = '0x' + '01'.repeat(20), T1 = '0x' + '02'.repeat(20);
const sel = (s) => ethers.id(s).slice(0, 10);
const w = (v) => BigInt.asUintN(256, BigInt(v)).toString(16).padStart(64, '0');
const pad = (a) => '0x' + a.slice(2).padStart(64, '0');

function mockProvider({ variant, liveFee, lastFee, callbackInCode = true }) {
    const tick = 1234, spacing = 60;
    const compressed = Math.floor(tick / spacing);          // 20 -> word 0, bit 20
    const initTick = compressed * spacing;
    const gsWords = variant === 'v1'
        ? [2n ** 96n, tick, lastFee, 0, 0, 0, 1]             // V1: 7 fields
        : [2n ** 96n, tick, lastFee, 0, 0, 1];               // Integral: 6 fields
    const cbSel = ethers.id('algebraSwapCallback(int256,int256,bytes)').slice(2, 10);
    const poolCode = '0x6080' + (callbackInCode ? '63' + cbSel : '') + '00';
    const calls = {
        [sel('globalState()')]: () => '0x' + gsWords.map(w).join(''),
        [sel('liquidity()')]: () => '0x' + w(10n ** 18n),
        [sel('tickSpacing()')]: () => '0x' + w(spacing),
        [sel('token0()')]: () => '0x' + w(BigInt(T0)),
        [sel('fee()')]: () => { if (liveFee == null) throw new Error('revert'); return '0x' + w(liveFee); },
        [sel('tickTable(int16)')]: (arg) => '0x' + w(BigInt.asIntN(256, BigInt('0x' + arg)) === 0n ? (1n << BigInt(compressed)) : 0n),
        [sel('ticks(int24)')]: (arg) => {
            const t = Number(BigInt.asIntN(256, BigInt('0x' + arg)));
            return '0x' + (t === initTick ? w(5n * 10n ** 17n) + w(-(3n * 10n ** 17n)) : w(0) + w(0)) + w(0).repeat(4);
        },
    };
    return {
        async getCode(a) { return a.toLowerCase() === FACTORY ? '0x6001' : poolCode; },
        async getBlockNumber() { return 500_000; },
        async getLogs() {
            return [{ blockNumber: 499_000, topics: [POOL_CREATED_ALGEBRA_TOPIC, pad(T0), pad(T1)], data: pad(POOL) }];
        },
        async call({ to, data }) {
            const f = calls[data.slice(0, 10)];
            if (!f || to.toLowerCase() !== POOL) throw new Error('revert');
            return f(data.slice(10));
        },
    };
}

const ctx = (p) => ({ provider: p, chain: { id: 146 } });

console.log('Integral (fee() live differs from lastFee):');
let r = await verifyV3Factory('sonic', FACTORY, undefined, ctx(mockProvider({ variant: 'integral', liveFee: 90, lastFee: 500 })));
ok(r.usable, 'usable');
ok(r.family === 'algebra' && r.algebraVariant === 'integral', `family algebra / integral (${r.family}/${r.algebraVariant})`);
ok(r.feesSeen.length === 1 && r.feesSeen[0] === 90, `fee from live fee() = 90 (${r.feesSeen})`);
ok(r.spacingsSeen[0] === 60, 'spacing 60');
ok(r.callback === 'algebraSwapCallback', 'callback algebraSwapCallback');
ok(r.notes.some(n => n.includes('✓ ticks() layout')), 'tick layout checked via tickTable');
ok(r.configSnippet.includes('factories["algebra"]') && r.configSnippet.includes('algebraVariant: "integral"'), 'snippet targets algebra group');

console.log('V1 (no fee(); fee from globalState word2):');
r = await verifyV3Factory('sonic', FACTORY, undefined, ctx(mockProvider({ variant: 'v1', liveFee: null, lastFee: 3000 })));
ok(r.usable, 'usable');
ok(r.algebraVariant === 'v1', `variant v1 (${r.algebraVariant})`);
ok(r.feesSeen[0] === 3000, `fee = word2 3000 (${r.feesSeen})`);
ok(r.configSnippet.includes('algebraVariant: "v1"'), 'snippet says v1');

console.log('Callback selector not visible in bytecode:');
r = await verifyV3Factory('sonic', FACTORY, undefined, ctx(mockProvider({ variant: 'integral', liveFee: 100, lastFee: 100, callbackInCode: false })));
ok(r.usable && r.callback === 'algebraSwapCallback', 'falls back to algebraSwapCallback, still usable');

console.log(`\n${fail === 0 ? 'ALL PASSED' : fail + ' FAILED'} (${pass} ok)`);
process.exit(fail === 0 ? 0 : 1);
