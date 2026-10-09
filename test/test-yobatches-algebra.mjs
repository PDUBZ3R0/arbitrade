// getAlgebraStates client decode. The on-chain Algebra reader emits the SAME
// wire layout as getV3State(Packed), so this crafts those exact bytes and runs
// them through readCLStates with a mock provider — proving the packed and ABI
// decoders, the support probes, and the window math, without a chain. (The
// on-chain reads themselves — right selectors/offsets against a live pool — are
// covered by the fork harness test/fork-algebra-state.mjs, not here.)
import { Interface, AbiCoder } from 'ethers';
import { getAlgebraStates, supportsAlgebra } from '../source/util/yobatches.ts';

let pass = 0, fail = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log(`  ok   ${m} ${x}`); } else { fail++; console.log(`  FAIL ${m} ${x}`); } };
const near = (a, b, m) => ok(a === b, m, `${a} === ${b}`);

const iface = new Interface([
    'function getAlgebraState(address[] pools, uint256 words) view returns (uint256[])',
    'function getAlgebraStatePacked(bytes pools, uint256 words) view returns (bytes)',
    'function getReservesPacked(bytes req) view returns (bytes)',
    'function getV3StatePacked(bytes pools, uint256 words) view returns (bytes)',
    'function getReservesByPool(bytes pools) view returns (bytes)',
]);
const SEL = fn => iface.getFunction(fn).selector.slice(2);
// Fake bytecode that "contains" a PUSH4 for each listed fn (the hasFns heuristic).
const codeWith = (...fns) => '0x' + fns.map(f => '63' + SEL(f)).join('6080');

const A = n => '0x' + String(n).repeat(40).slice(0, 40);
const expectedWindow = (tick, spacing, words) => {
    const w0 = Math.floor(tick / spacing) >> 8;
    return { windowLow: (w0 - words) * 256 * spacing, windowHigh: ((w0 + words) * 256 + 255) * spacing };
};

// ---- packed buffer builder, matching YoBatches3.getAlgebraStatePacked ----
const hx = (n, bytes) => BigInt(n).toString(16).padStart(bytes * 2, '0');
const fixed = (v, nb) => { let x = BigInt(v); if (x < 0n) x += 1n << BigInt(nb * 8); return x.toString(16).padStart(nb * 2, '0'); };
const varf = v => { let x = BigInt(v); if (x === 0n) return '00'; const h = x.toString(16); const b = h.length % 2 ? '0' + h : h; return hx(b.length / 2, 1) + b; };
function packedBuf(block, records) {
    let s = hx(block, 8);
    for (const rec of records) {
        if (!rec) { s += '00'; continue; }
        s += '01' + varf(rec.sqrtPriceX96) + fixed(rec.tick, 3) + varf(rec.liquidity) + fixed(rec.fee, 3) + fixed(rec.spacing, 3) + hx(rec.ticks.length, 2);
        for (const t of rec.ticks) s += fixed(t.index, 3) + fixed(t.liquidityNet, 16);
    }
    return '0x' + s;
}
// ---- ABI uint256[] builder, matching YoBatches2.getAlgebraState ----
const u = x => BigInt.asUintN(256, BigInt(x));
function abiWords(block, records) {
    const f = [u(block)];
    for (const rec of records) {
        if (!rec) { f.push(0n, 0n, 0n, 0n, 0n, 0n); continue; }
        f.push(u(rec.sqrtPriceX96), u(rec.tick), u(rec.liquidity), u(rec.fee), u(rec.spacing), u(rec.ticks.length));
        for (const t of rec.ticks) f.push(u(t.index), u(t.liquidityNet));
    }
    return f;
}

const POOLS = [A(1), A(2)];
const RECS = [
    { sqrtPriceX96: 79228162514264337593543950336n, tick: 6, fee: 500, liquidity: 123456789n, spacing: 60,
      ticks: [{ index: -120, liquidityNet: 5000n }, { index: 180, liquidityNet: -5000n }] },
    null, // second pool: globalState() failed on chain
];
const WORDS = 2;

const mockProvider = (code, callRet) => ({ getCode: async () => code, call: async () => callRet });

console.log('1. packed path: support probed, bytes decoded, window computed');
{
    const raw = iface.encodeFunctionResult('getAlgebraStatePacked', [packedBuf(99, RECS)]);
    const prov = mockProvider(codeWith('getReservesPacked', 'getV3StatePacked', 'getReservesByPool', 'getAlgebraStatePacked'), raw);
    const res = await getAlgebraStates(prov, A(9), POOLS, WORDS);
    near(res.block, 99, 'block');
    const p = res.pools[0];
    ok(p != null, 'pool 0 decoded');
    near(p.sqrtPriceX96, RECS[0].sqrtPriceX96, 'sqrtPriceX96');
    near(p.tick, 6, 'tick');
    near(p.fee, 500, 'fee (globalState word2, pips)');
    near(p.liquidity, 123456789n, 'liquidity');
    near(p.tickSpacing, 60, 'tickSpacing');
    ok(p.ticks.length === 2 && p.ticks[0].index === -120 && p.ticks[0].liquidityNet === 5000n, 'ticks decoded');
    ok(p.ticks[1].liquidityNet === -5000n, 'negative liquidityNet (int128) sign-correct');
    const win = expectedWindow(6, 60, WORDS);
    ok(p.windowLow === win.windowLow && p.windowHigh === win.windowHigh, 'window', `${p.windowLow}..${p.windowHigh}`);
    ok(res.pools[1] === null, 'pool 1 (failed globalState) is null');
}

console.log('2. ABI path: used when packed not in bytecode');
{
    const words = abiWords(42, RECS);
    const raw = AbiCoder.defaultAbiCoder().encode(['uint256[]'], [words]);
    const prov = mockProvider(codeWith('getAlgebraState'), raw);   // ABI only, no packed
    const res = await getAlgebraStates(prov, A(8), POOLS, WORDS);  // distinct addr: getCode is cached per-address
    near(res.block, 42, 'block (abi)');
    const p = res.pools[0];
    ok(p != null && p.tick === 6 && p.fee === 500 && p.tickSpacing === 60, 'pool 0 decoded (abi)');
    ok(p.ticks.length === 2 && p.ticks[1].liquidityNet === -5000n, 'ticks decoded (abi)');
    ok(res.pools[1] === null, 'pool 1 null (abi)');
}

console.log('3. supportsAlgebra reflects bytecode');
{
    ok(await supportsAlgebra(mockProvider(codeWith('getAlgebraState'), '0x'), A(5)), 'true when getAlgebraState present');
    ok(await supportsAlgebra(mockProvider(codeWith('getAlgebraStatePacked'), '0x'), A(6)), 'true when only packed present');
    ok(!(await supportsAlgebra(mockProvider(codeWith('getReservesByPool'), '0x'), A(7))), 'false on an Algebra-less deployment');
}

console.log('4. empty input short-circuits');
{
    const res = await getAlgebraStates(mockProvider('0x', '0x'), A(9), [], WORDS);
    ok(res.pools.length === 0 && res.block === 0, 'empty pools → empty batch, no call');
}

console.log(`\n${fail === 0 ? 'all passed' : fail + ' FAILED'} (${pass} ok)`);
process.exit(fail === 0 ? 0 : 1);
