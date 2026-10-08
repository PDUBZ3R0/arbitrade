// Layer 1 of Algebra support: creation-event decode + DB round-trip of the
// cl_variant marker. Proves an Algebra pool is decoded and stored as a CL
// (kind 'v3') pool tagged with its variant, so the reserves pass can later
// route it to the right state reader.
import { ethers } from 'ethers';
import { ArbitradeDB } from '../source/util/db.ts';
import { parseCreationLog, POOL_CREATED_ALGEBRA_TOPIC } from '../source/util/pool-events.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log(`  ok   ${m} ${x}`); } else { fail++; console.log(`  FAIL ${m} ${x}`); } };
const pad = a => '0x' + a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const A = n => '0x' + String(n).repeat(40).slice(0, 40);

console.log('1. Algebra creation-event decode');
{
    const t0 = A(1), t1 = A(2), pool = A(3);
    // Algebra: Pool(address indexed token0, address indexed token1, address pool); data = [pool]
    const parsed = parseCreationLog([POOL_CREATED_ALGEBRA_TOPIC, pad(t0), pad(t1)], pad(pool), 'algebra');
    ok(parsed != null, 'decodes an algebra Pool log');
    ok(parsed && parsed.pair === pool.toLowerCase(), 'pool address = last data word', parsed?.pair);
    ok(parsed && parsed.token0 === t0.toLowerCase() && parsed.token1 === t1.toLowerCase(), 'tokens from indexed topics');
    ok(parsed && parsed.feePips === null && parsed.tickSpacing === null, 'no fee/tickSpacing in the event (dynamic)');
}

console.log('2. DB round-trip: cl_variant persists, Algebra stored as kind v3');
{
    const dir = mkdtempSync(join(tmpdir(), 'algebra-'));
    const db = new ArbitradeDB(join(dir, 't.sqlite'));
    const integ = A(3), univ3 = A(4), v2 = A(5);
    db.insertPairs([
        { address: integ, factory: A(6), token0: A(1), token1: A(2), blockNumber: 1, kind: 'v3', clVariant: 'algebra-integral' },
        { address: univ3, factory: A(7), token0: A(1), token1: A(2), blockNumber: 1, kind: 'v3', clVariant: 'univ3' },
        { address: v2,    factory: A(8), token0: A(1), token1: A(2), blockNumber: 1, kind: 'v2' },
    ]);
    db.upsertReserves([
        { pair: integ, reserves0: 1000n, reserves1: 1000n, blockNumber: 1, updatedAt: 1 },
        { pair: univ3, reserves0: 1000n, reserves1: 1000n, blockNumber: 1, updatedAt: 1 },
        { pair: v2,    reserves0: 1000n, reserves1: 1000n, blockNumber: 1, updatedAt: 1 },
    ]);
    const rows = db.getPairsForEnumeration({});
    const byPair = new Map(rows.map(r => [r.pair, r]));
    ok(byPair.get(integ)?.cl_variant === 'algebra-integral', 'algebra-integral variant persisted', byPair.get(integ)?.cl_variant);
    ok(byPair.get(integ)?.kind === 'v3', 'algebra pool stored as kind v3');
    ok(byPair.get(univ3)?.cl_variant === 'univ3', 'univ3 variant persisted');
    ok((byPair.get(v2)?.cl_variant ?? null) === null, 'v2 pool has null cl_variant');
    db.close();
}

console.log(`\n${fail === 0 ? 'all passed' : fail + ' FAILED'} (${pass} ok)`);
process.exit(fail === 0 ? 0 : 1);
