// fetchV3States routing by cl_variant: univ3 pools must be read through
// getV3State(Packed), algebra-* pools through getAlgebraState(Packed), and when
// the deployed YoBatches has no Algebra support the algebra pools degrade to
// "unreadable" (zeroed) rather than erroring. Uses a real temp DB and a mock
// provider that records which reader selector each pool address was sent to.
import { Interface } from 'ethers';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArbitradeDB } from '../source/util/db.ts';
import { fetchV3States } from '../source/reserves/v3-state.ts';

let pass = 0, fail = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log(`  ok   ${m} ${x}`); } else { fail++; console.log(`  FAIL ${m} ${x}`); } };

const iface = new Interface([
    'function getV3StatePacked(bytes pools, uint256 words) view returns (bytes)',
    'function getAlgebraStatePacked(bytes pools, uint256 words) view returns (bytes)',
    'function getReservesPacked(bytes req) view returns (bytes)',
    'function getReservesByPool(bytes pools) view returns (bytes)',
    'function getAlgebraState(address[] pools, uint256 words) view returns (uint256[])',
    'function getV3State(address[] pools, uint256 words) view returns (uint256[])',
]);
const SEL = fn => iface.getFunction(fn).selector;
const codeWith = (...fns) => '0x' + fns.map(f => '63' + SEL(f).slice(2)).join('6080');
const A = n => '0x' + String(n).repeat(40).slice(0, 40);

// Minimal live packed record for every pool in a batch (one tick each).
const hx = (n, b) => BigInt(n).toString(16).padStart(b * 2, '0');
const fixed = (v, nb) => { let x = BigInt(v); if (x < 0n) x += 1n << BigInt(nb * 8); return x.toString(16).padStart(nb * 2, '0'); };
const varf = v => { let x = BigInt(v); if (x === 0n) return '00'; const h = x.toString(16); const hh = h.length % 2 ? '0' + h : h; return hx(hh.length / 2, 1) + hh; };
function livePacked(nPools) {
    let s = hx(123, 8);
    for (let i = 0; i < nPools; i++) {
        s += '01' + varf(79228162514264337593543950336n) + fixed(0, 3) + varf(1_000_000n) + fixed(500, 3) + fixed(60, 3) + hx(1, 2) + fixed(-60, 3) + fixed(10n, 16);
    }
    return '0x' + s;
}
// decode a packed request's pool addresses (20-byte concat)
function poolsFromReq(fn, data) {
    const [reqBytes] = iface.decodeFunctionData(fn, data);
    const h = reqBytes.slice(2);
    const out = [];
    for (let i = 0; i < h.length; i += 40) out.push('0x' + h.slice(i, i + 40).toLowerCase());
    return out;
}

const UNIV3 = [A(1), A(2)];
const ALG = [A(3), A(4)];

function mkDbWith(pools) {
    const dir = mkdtempSync(join(tmpdir(), 'route-'));
    const db = new ArbitradeDB(join(dir, 't.sqlite'));
    db.insertPairs(pools.map(p => ({
        address: p.pair, factory: p.factory, token0: A(8), token1: A(9), blockNumber: 1,
        kind: 'v3', clVariant: p.clVariant,
    })));
    return db;
}

console.log('1. routing: univ3 → getV3State, algebra → getAlgebraState');
{
    const seen = { getV3StatePacked: new Set(), getAlgebraStatePacked: new Set() };
    const provider = {
        getCode: async () => codeWith('getReservesPacked', 'getReservesByPool', 'getV3StatePacked', 'getAlgebraStatePacked'),
        call: async ({ data }) => {
            const fn = data.startsWith(SEL('getV3StatePacked')) ? 'getV3StatePacked'
                     : data.startsWith(SEL('getAlgebraStatePacked')) ? 'getAlgebraStatePacked' : null;
            if (!fn) throw new Error('unexpected selector ' + data.slice(0, 10));
            for (const p of poolsFromReq(fn, data)) seen[fn].add(p);
            return iface.encodeFunctionResult(fn, [livePacked(poolsFromReq(fn, data).length)]);
        },
    };
    const pools = [
        { pair: UNIV3[0], factory: A(6), clVariant: 'univ3' },
        { pair: ALG[0], factory: A(7), clVariant: 'algebra-integral' },
        { pair: UNIV3[1], factory: A(6), clVariant: null },        // null → treated as univ3
        { pair: ALG[1], factory: A(7), clVariant: 'algebra-v1' },
    ];
    const db = mkDbWith(pools);
    const stats = await fetchV3States(provider, db, A(5), pools, { batchSize: 100, words: 2, concurrency: 2 });
    db.close();
    const low = s => new Set([...s].map(x => x.toLowerCase()));
    const v3 = low(seen.getV3StatePacked), alg = low(seen.getAlgebraStatePacked);
    ok(v3.has(UNIV3[0].toLowerCase()) && v3.has(UNIV3[1].toLowerCase()), 'both univ3 pools (incl null) → getV3State');
    ok(!v3.has(ALG[0].toLowerCase()) && !v3.has(ALG[1].toLowerCase()), 'no algebra pool leaked into getV3State');
    ok(alg.has(ALG[0].toLowerCase()) && alg.has(ALG[1].toLowerCase()), 'both algebra pools → getAlgebraState');
    ok(!alg.has(UNIV3[0].toLowerCase()), 'no univ3 pool leaked into getAlgebraState');
    ok(stats.live === 4, 'all four priced live', `live=${stats.live}`);
}

console.log('2. degrade: no getAlgebraState in bytecode → algebra pools unreadable, univ3 still read');
{
    let algebraCalled = false;
    const provider = {
        getCode: async () => codeWith('getReservesPacked', 'getReservesByPool', 'getV3StatePacked'), // no algebra
        call: async ({ data }) => {
            if (data.startsWith(SEL('getAlgebraStatePacked')) || data.startsWith(SEL('getAlgebraState'))) { algebraCalled = true; throw new Error('should not be called'); }
            if (!data.startsWith(SEL('getV3StatePacked'))) throw new Error('unexpected ' + data.slice(0, 10));
            return iface.encodeFunctionResult('getV3StatePacked', [livePacked(poolsFromReq('getV3StatePacked', data).length)]);
        },
    };
    const pools = [
        { pair: A(1), factory: A(6), clVariant: 'univ3' },
        { pair: A(3), factory: A(7), clVariant: 'algebra-integral' },
    ];
    const db = mkDbWith(pools);
    // yobatches addr must not collide with test 1's A(5) — getCode is cached
    // per-address for the whole process. ('0xab'*20 can't be any A(n) digit-repeat.)
    const YO2 = '0x' + 'ab'.repeat(20);
    const stats = await fetchV3States(provider, db, YO2, pools, { batchSize: 100, words: 2, concurrency: 2 });
    db.close();
    ok(!algebraCalled, 'never called a getAlgebra* read on an Algebra-less contract');
    ok(stats.live === 1, 'the univ3 pool is still priced', `live=${stats.live}`);
    ok(stats.unreadable === 1, 'the algebra pool is marked unreadable, not errored', `unreadable=${stats.unreadable}`);
    ok(stats.errors.length === 0, 'no batch errors from the skip');
}

console.log(`\n${fail === 0 ? 'all passed' : fail + ' FAILED'} (${pass} ok)`);
process.exit(fail === 0 ? 0 : 1);
