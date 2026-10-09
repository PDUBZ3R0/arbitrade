// Fork / live-RPC validation of the on-chain Algebra reader (YoBatches2/3
// getAlgebraState). This is the ONE check that can't run without a real pool:
// it proves the Yul selectors and struct offsets match a live Algebra V1 or
// Integral pool, by comparing the batch reader's decoded state against the same
// values read field-by-field with ethers directly from the pool.
//
// It does NOT run in CI (needs a chain). Run it against a fork or a live RPC
// before trusting Algebra sizes:
//
//   node --experimental-strip-types test/fork-algebra-state.mjs \
//        --rpc https://rpc.<chain> --yo 0x<YoBatches3> --pool 0x<algebraPool> [--pool 0x...]
//
// (--yo must be a YoBatches redeployed with getAlgebraState. A fork is ideal —
//  anvil --fork-url <rpc> — but a plain archive/live RPC works too since every
//  call is a view.)
//
// Pass = the batch reader agrees with the direct reads on price, tick, fee,
// liquidity, spacing, and every initialized tick's liquidityNet in the window.
import { JsonRpcProvider, Interface } from 'ethers';
import { getAlgebraStates, supportsAlgebra } from '../source/util/yobatches.ts';

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const all = (k) => args.reduce((a, v, i) => (args[i - 1] === k ? [...a, v] : a), []);
const RPC = opt('--rpc') ?? process.env.ALGEBRA_FORK_RPC;
const YO = opt('--yo') ?? process.env.ALGEBRA_YOBATCHES;
const POOLS = all('--pool');
const WORDS = Number(opt('--words') ?? 2);
if (!RPC || !YO || POOLS.length === 0) {
    console.error('usage: --rpc <url> --yo <YoBatches3 addr> --pool <algebra pool> [--pool ...] [--words N]');
    process.exit(2);
}

const provider = new JsonRpcProvider(RPC);
const pool = new Interface([
    'function globalState() view returns (uint160 price, int24 tick, uint16 fee, uint16 a, uint8 b, uint8 c, bool d)',
    'function liquidity() view returns (uint128)',
    'function tickSpacing() view returns (int24)',
    'function tickTable(int16) view returns (uint256)',
    'function ticks(int24) view returns (uint256 liquidityTotal, int128 liquidityDelta)',
]);
const call = async (addr, fn, ...a) => pool.decodeFunctionResult(fn, await provider.call({ to: addr, data: pool.encodeFunctionData(fn, a) }));

let pass = 0, fail = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log(`  ok   ${m} ${x}`); } else { fail++; console.log(`  FAIL ${m} ${x}`); } };

// Independent tick walk: read tickTable bitmap words across the same window the
// contract uses, collect initialized ticks, read each one's liquidityDelta.
async function directTicks(addr, tick, spacing) {
    const compressed = Math.floor(tick / spacing);
    const w0 = compressed >> 8;
    const out = [];
    for (let wp = w0 - WORDS; wp <= w0 + WORDS; wp++) {
        if (wp < -32768 || wp > 32767) continue;
        const [bm] = await call(addr, 'tickTable', wp);
        for (let b = 0; b < 256; b++) {
            if ((bm >> BigInt(b)) & 1n) {
                const t = (wp * 256 + b) * spacing;
                const [, delta] = await call(addr, 'ticks', t);
                out.push({ index: t, liquidityNet: delta });
            }
        }
    }
    return out;
}

console.log(`RPC ${RPC}\nYoBatches ${YO}\n`);
if (!(await supportsAlgebra(provider, YO))) {
    console.error(`[!] ${YO} has no getAlgebraState in its bytecode — redeploy with \`yarn deploy-contract\` first.`);
    process.exit(2);
}

const batch = await getAlgebraStates(provider, YO, POOLS, WORDS);
console.log(`batch block ${batch.block}, ${batch.pools.filter(Boolean).length}/${POOLS.length} pools answered\n`);

for (let i = 0; i < POOLS.length; i++) {
    const addr = POOLS[i];
    const st = batch.pools[i];
    console.log(`── ${addr} ──`);
    if (!st) { ok(false, 'reader returned a pool (null = globalState/tickSpacing read failed — not Algebra, or wrong YoBatches)'); continue; }

    const [gs] = [await call(addr, 'globalState')];
    const [liq] = await call(addr, 'liquidity');
    const [spacing] = await call(addr, 'tickSpacing');
    ok(st.sqrtPriceX96 === gs.price, 'price = globalState.price', `${st.sqrtPriceX96}`);
    ok(st.tick === Number(gs.tick), 'tick = globalState.tick', `${st.tick}`);
    ok(st.fee === Number(gs.fee), 'fee = globalState.fee (pips)', `${st.fee}`);
    ok(st.liquidity === liq, 'liquidity = liquidity()', `${st.liquidity}`);
    ok(st.tickSpacing === Number(spacing), 'tickSpacing = tickSpacing()', `${st.tickSpacing}`);

    const direct = await directTicks(addr, Number(gs.tick), Number(spacing));
    ok(st.ticks.length === direct.length, 'tick count matches direct bitmap walk', `reader ${st.ticks.length} vs direct ${direct.length}`);
    const byIdx = new Map(direct.map(t => [t.index, t.liquidityNet]));
    let mism = 0;
    for (const t of st.ticks) if (byIdx.get(t.index) !== t.liquidityNet) mism++;
    ok(mism === 0, 'every reader tick has the pool\'s liquidityNet', mism ? `${mism} mismatched` : '');
    console.log('');
}

console.log(`${fail === 0 ? 'ALL PASSED — reader matches the live pool' : fail + ' FAILED — do NOT trust Algebra sizes until fixed'} (${pass} ok)`);
process.exit(fail === 0 ? 0 : 1);
