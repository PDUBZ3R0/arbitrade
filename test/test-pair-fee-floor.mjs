// A fee declared on a factory in the conf reaches pairs already priced below it,
// and never lowers a pair priced above it.
//
// Polygon, 2026-11-01: UniswapV2Factory_3ed75aff went to fee 0.0035 in the conf
// on 10-14 (its pairs skim ~0.05% of output), but flat-fee mode only filled
// pairs with no fee — and returned early when every pair had one — so its 110
// pairs stayed at 0.003 and hot-loop paths through them came up 500 ppm short.
// CompactV2 / ProtofiV2 / BazookaAV2 are the other direction: pairs priced
// above the conf by verify-fees, which must stay (a fee too low reverts).
//
//   node --experimental-strip-types test/test-pair-fee-floor.mjs   (no anvil)

import fs from 'node:fs';
import { ArbitradeDB } from '../source/util/db.ts';

let fails = 0;
const ok = (c, l, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${l} ${extra}`); if (!c) fails++; };
const WORK = fs.mkdtempSync('/tmp/arbitrade-fee-floor-');
const A = (c) => '0x' + c.repeat(40);
const F = A('f'), G = A('e');

const db = new ArbitradeDB(`${WORK}/t.sqlite`);
db.db.prepare('INSERT INTO factories (address,name,type,fee,deployBlock) VALUES (?,?,?,?,?)').run(F, 'F', 'v2', 0.0035, 1);
db.insertPairs([
    { address: A('1'), factory: F, token0: A('a'), token1: A('b'), blockNumber: 5 },
    { address: A('2'), factory: F, token0: A('a'), token1: A('c'), blockNumber: 5 },
    { address: A('3'), factory: F, token0: A('a'), token1: A('d'), blockNumber: 5 },
    { address: A('4'), factory: G, token0: A('a'), token1: A('b'), blockNumber: 5 },
    { address: A('5'), factory: G, token0: A('a'), token1: A('c'), blockNumber: 5 },
]);
const set = db.db.prepare('UPDATE pairs SET fee = ?, stable = ? WHERE address = ?');
set.run(null, null, A('1')); set.run(0.003, null, A('2')); set.run(0.004, null, A('3'));
set.run(0.0001, 1, A('4')); set.run(0.002, 0, A('5'));
const fee = (p) => db.db.prepare('SELECT fee FROM pairs WHERE address = ?').get(p).fee;

console.log('1. flat fee 0.0035');
const n = db.raisePairFeesTo(F, 0.0035);
ok(n === 2, 'two pairs changed', `(${n})`);
ok(fee(A('1')) === 0.0035, 'unpriced pair → 0.0035');
ok(fee(A('2')) === 0.0035, 'pair at 0.003 raised to 0.0035 (3ed75aff)');
ok(fee(A('3')) === 0.004, 'pair at 0.004 kept: never lowered (CompactV2 & co.)');
ok(db.raisePairFeesTo(F, 0.0035) === 0, 'a second run changes nothing');

console.log('\n2. static per-type fees');
ok(db.raisePairFeesTo(G, 0.0004, true) === 1 && fee(A('4')) === 0.0004, 'stable pair raised to the stable fee');
ok(db.raisePairFeesTo(G, 0.0025, false) === 1 && fee(A('5')) === 0.0025 && fee(A('4')) === 0.0004, 'volatile pair raised; the stable one untouched');

db.close();
fs.rmSync(WORK, { recursive: true, force: true });
console.log(fails ? `\n${fails} FAILED` : '\nALL PAIR-FEE-FLOOR CHECKS PASS');
process.exit(fails ? 1 : 0);
