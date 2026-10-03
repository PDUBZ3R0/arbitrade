// Does the index score identically to a full pass, and does incremental
// re-scoring find the same candidates as re-scoring everything?
//
// Runs against the live Sonic DB. The second question is the one that matters:
// if "re-score only the triangles touching a changed pair" ever differs from
// "re-score all of them", the live loop silently misses trades.

import { DatabaseSync } from 'node:sqlite';
import { TriangleIndex } from '../source/orchestrator/triangle-index.ts';

const DB = process.env.ARB_TEST_DB ?? 'db/sonic.sqlite';
const db = { db: new DatabaseSync(DB, { readOnly: true }) };

// Mirror getPairsForEnumeration + the evaluator's fee resolution.
const UNSAFE_TOKEN = ["'fee-on-transfer'", "'nonstandard'", "'honeypot'", "'dead'"].join(',');
const UNSAFE_PAIR = ["'pair-restricted'"].join(',');
db.getPairsForEnumeration = () => db.db.prepare(`
    SELECT p.address AS pair, p.factory, p.token0, p.token1, p.fee, p.stable
    FROM pairs p INNER JOIN reserves r ON r.pair = p.address
    WHERE r.reserves0 != '0' AND r.reserves1 != '0'
      AND (p.stable IS NULL OR p.stable = 0)
      AND (p.probeStatus IS NULL OR p.probeStatus NOT IN (${UNSAFE_PAIR}))
      AND p.token0 NOT IN (SELECT address FROM tokens WHERE probeStatus IN (${UNSAFE_TOKEN}))
      AND p.token1 NOT IN (SELECT address FROM tokens WHERE probeStatus IN (${UNSAFE_TOKEN}))
    ORDER BY p.address
`).all();

const factoriesByAddr = new Map();
for (const r of db.db.prepare('select address, fee from factories').all())
    factoriesByAddr.set(String(r.address).toLowerCase(), { fee: r.fee == null ? 0.003 : Number(r.fee) });

let fails = 0;
const ok = (c, l, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${l} ${extra}`); if (!c) fails++; };

// --- build ------------------------------------------------------------------
const t0 = performance.now();
const ix = TriangleIndex.build(db, factoriesByAddr);
const buildMs = performance.now() - t0;
console.log(`built: ${ix.triangleCount.toLocaleString()} triangles, ${ix.pairCount.toLocaleString()} pairs, ` +
    `${(ix.bytes() / 1e6).toFixed(1)} MB, ${buildMs.toFixed(0)} ms\n`);

// thresholds matching conf/sonic.json5
const decimals = new Map();
for (const r of db.db.prepare('select address, decimals from tokens where decimals is not null').all())
    decimals.set(String(r.address).toLowerCase(), Number(r.decimals));

const MIN_LIQ = 0.5, MIN_PROFIT = 0.01, MIN_INPUT = 0.1;
const minReserveByToken = new Float64Array(ix.tokenAddr.length);
for (let i = 0; i < ix.tokenAddr.length; i++)
    minReserveByToken[i] = MIN_LIQ * 10 ** (decimals.get(ix.tokenAddr[i]) ?? 18);

const minProfitByRoot = new Map(), minInputByRoot = new Map();
for (const a of ix.tokenAddr) {
    minProfitByRoot.set(a, MIN_PROFIT * 1e18);
    minInputByRoot.set(a, MIN_INPUT * 1e18);
}
const th = { minProfitByRoot, minInputByRoot, minReserveByToken, maxRoi: 20, flashPremium: 0.0005 };

const key = (c) => `${c.triangleId}|${c.direction}`;
const summarise = (cs) => {
    const m = new Map();
    for (const c of cs) m.set(key(c), c);
    return m;
};

// --- 1. full scan twice is deterministic ------------------------------------
console.log('1. determinism');
{
    const a = ix.scoreAll(th), b = ix.scoreAll(th);
    ok(a.length === b.length, 'same count on repeat', `${a.length}`);
    const ma = summarise(a), mb = summarise(b);
    let same = true;
    for (const [k, v] of ma) {
        const w = mb.get(k);
        if (!w || w.inputAmount !== v.inputAmount || w.netProfit !== v.netProfit) { same = false; break; }
    }
    ok(same, 'identical inputs and profits on repeat');
}

// --- 2. incremental == full, for every single pair --------------------------
console.log('\n2. incremental re-score == full re-score (per-pair, all pairs)');
{
    const full = summarise(ix.scoreAll(th));
    // For each pair, the candidates the index attributes to it must be exactly
    // the full-scan candidates whose hops include that pair.
    let mismatches = 0, checked = 0, withCands = 0;
    for (let p = 0; p < ix.pairCount; p++) {
        const affected = ix.affectedTriangles([p]);
        if (affected.length === 0) continue;
        checked++;
        const inc = summarise(ix.scoreMany(affected, th));
        const expected = new Map();
        for (const [k, c] of full) {
            if (c.hops.some(h => h.pair === ix.pairAddr[p])) expected.set(k, c);
        }
        if (expected.size > 0) withCands++;
        if (inc.size < expected.size) { mismatches++; continue; }
        for (const [k, c] of expected) {
            const g = inc.get(k);
            if (!g || g.inputAmount !== c.inputAmount || g.netProfit !== c.netProfit) { mismatches++; break; }
        }
    }
    ok(mismatches === 0, `every pair's affected set reproduces its full-scan candidates`,
        `(${checked.toLocaleString()} pairs, ${withCands} with candidates, ${mismatches} mismatches)`);
}

// --- 3. a reserve change propagates, and ONLY to affected triangles ---------
console.log('\n3. applySync changes exactly the right candidates');
{
    const before = summarise(ix.scoreAll(th));
    // Pick a pair that participates in at least one candidate.
    let target = -1;
    for (const c of before.values()) { target = ix.pairIdx.get(c.hops[0].pair); break; }
    ok(target >= 0, 'found a pair inside a live candidate', ix.pairAddr[target]);

    const save0 = ix.res0[target], save1 = ix.res1[target];
    // Shift the pool 10% — enough to move pricing, not enough to empty it.
    ix.applySync(ix.pairAddr[target], save0 * 1.1, save1 * 0.9);

    const afterFull = summarise(ix.scoreAll(th));
    const affected = ix.affectedTriangles([target]);
    const afterInc = summarise(ix.scoreMany(affected, th));

    // Every candidate that CHANGED between before/after must be in the
    // affected set — that is the whole correctness claim of the hot loop.
    const affectedKeys = new Set();
    for (const t of affected) affectedKeys.add(t);
    let leaked = 0;
    const allKeys = new Set([...before.keys(), ...afterFull.keys()]);
    for (const k of allKeys) {
        const b = before.get(k), a = afterFull.get(k);
        const changed = (!b !== !a) || (b && a && (b.inputAmount !== a.inputAmount || b.netProfit !== a.netProfit));
        if (!changed) continue;
        const triId = Number(k.split('|')[0]);
        // map db id -> internal index
        let internal = -1;
        for (let t = 0; t < ix.triangleCount; t++) if (ix.triDbId[t] === triId) { internal = t; break; }
        if (!affectedKeys.has(internal)) leaked++;
    }
    ok(leaked === 0, 'no candidate changed outside the affected set', `(${leaked} leaked)`);

    // And the incremental results for affected triangles match the full scan.
    let wrong = 0;
    for (const t of affected) {
        const id = ix.triDbId[t];
        for (const dir of ['forward', 'reverse']) {
            const k = `${id}|${dir}`;
            const a = afterFull.get(k), i = afterInc.get(k);
            if (!a !== !i) { wrong++; continue; }
            if (a && i && (a.inputAmount !== i.inputAmount || a.netProfit !== i.netProfit)) wrong++;
        }
    }
    ok(wrong === 0, 'incremental values match the full scan after the change', `(${wrong} wrong)`);

    ix.applySync(ix.pairAddr[target], save0, save1);
    const restored = summarise(ix.scoreAll(th));
    ok(restored.size === before.size, 'restoring reserves restores the candidate set',
        `${before.size} -> ${restored.size}`);
}

// --- 4. unknown pairs are ignored, not crashed on -------------------------
console.log('\n4. robustness');
{
    ok(ix.applySync('0x000000000000000000000000000000000000dead', 1, 1) === -1, 'unknown pair returns -1');
    ok(ix.affectedTriangles([-1, 1e9]).length === 0, 'out-of-range pair indices ignored');
}

// --- 5. the speedup ---------------------------------------------------------
console.log('\n5. cost of incremental vs full');
{
    const tFull0 = performance.now();
    ix.scoreAll(th);
    const fullMs = performance.now() - tFull0;

    // A realistic block: a handful of pairs moved.
    const sample = [];
    for (let p = 0; p < ix.pairCount && sample.length < 8; p += Math.max(1, (ix.pairCount / 97) | 0)) sample.push(p);
    const aff = ix.affectedTriangles(sample);
    const tInc0 = performance.now();
    for (let i = 0; i < 20; i++) ix.scoreMany(aff, th);
    const incMs = (performance.now() - tInc0) / 20;

    console.log(`     full scan     : ${fullMs.toFixed(1)} ms over ${ix.triangleCount.toLocaleString()} triangles`);
    console.log(`     ${sample.length} pairs moved : ${aff.length.toLocaleString()} affected triangles, ${incMs.toFixed(2)} ms`);
    console.log(`     speedup       : ${(fullMs / incMs).toFixed(0)}x`);
    ok(incMs < fullMs, 'incremental is cheaper');
}

console.log(fails === 0 ? '\nALL INDEX CHECKS PASS' : `\n${fails} FAILED`);
process.exit(fails ? 1 : 0);
