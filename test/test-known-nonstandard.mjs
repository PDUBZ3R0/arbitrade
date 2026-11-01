// Tokens known nonstandard by construction are recorded without a probe trade
// and leave the graph like any probe-flagged token.
//
// Polygon, 2026-11-01: POL (0x…1010, the native-token system contract) only
// transfers when msg.value equals the amount, so pools holding it can't pay it
// out; three hot-loop simulations through WPOL/POL on Uniswap V3 reverted
// "TF". The probe had it as untestable, which excludes nothing.
//
//   node --experimental-strip-types test/test-known-nonstandard.mjs   (no anvil)

import fs from 'node:fs';
import { ArbitradeDB } from '../source/util/db.ts';
import { markKnownNonstandard, KNOWN_NONSTANDARD } from '../source/util/token-probe.ts';

let fails = 0;
const ok = (c, l, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${l} ${extra}`); if (!c) fails++; };
const WORK = fs.mkdtempSync('/tmp/arbitrade-known-nonstandard-');
const A = (c) => '0x' + c.repeat(40);
const POL = '0x0000000000000000000000000000000000001010';
const WPOL = A('2'), USDC = A('3');

const db = new ArbitradeDB(`${WORK}/polygon.sqlite`);
db.db.prepare('INSERT INTO factories (address,name,type,fee,deployBlock) VALUES (?,?,?,?,?)').run(A('a'), 'A', 'v2', 0.003, 1);
db.insertPairs([
    { address: A('1'), factory: A('a'), token0: POL, token1: WPOL, blockNumber: 5 },
    { address: A('4'), factory: A('a'), token0: WPOL, token1: USDC, blockNumber: 5 },
]);
for (const p of [A('1'), A('4')]) db.db.prepare('INSERT INTO reserves (pair,reserves0,reserves1,blockNumber,updatedAt) VALUES (?,?,?,?,?)').run(p, '1000', '1000', 5, 1);
// What the probe left: untestable, which keeps the pair.
db.setTokenProbe(POL, { status: 'untestable', buyTaxBps: null, sellTaxBps: null, reason: 'no live, non-restricted root pair in an allowed factory', pair: null });

const pairs = () => db.getPairsForEnumeration().map(p => p.pair);
ok(pairs().includes(A('1')), 'before: the WPOL/POL pair is in the graph (untestable excludes nothing)');

console.log('1. another chain: nothing recorded');
ok(markKnownNonstandard(db, 146).length === 0 && pairs().includes(A('1')), 'Sonic has no known-nonstandard tokens');

console.log('2. Polygon: POL recorded nonstandard');
const marked = markKnownNonstandard(db, 137);
ok(marked.length === 1 && marked[0] === POL, 'returns POL', JSON.stringify(marked));
const row = db.db.prepare('SELECT probeStatus, probeReason FROM tokens WHERE address = ?').get(POL);
ok(row?.probeStatus === 'nonstandard' && /msg\.value/.test(row.probeReason), 'tokens.probeStatus = nonstandard, with the reason', JSON.stringify(row));
ok(!pairs().includes(A('1')) && pairs().includes(A('4')), 'getPairsForEnumeration drops WPOL/POL and keeps WPOL/USDC', JSON.stringify(pairs()));
ok(db.getKnownBad().tokens.some(t => t.address === POL), "the hot loop's known-bad tokens include POL");
ok(KNOWN_NONSTANDARD[137].every(t => t.address === t.address.toLowerCase()), 'addresses are stored lower-case, as the DB keys them');

db.close();
fs.rmSync(WORK, { recursive: true, force: true });
console.log(fails ? `\n${fails} FAILED` : '\nALL KNOWN-NONSTANDARD CHECKS PASS');
process.exit(fails ? 1 : 0);
