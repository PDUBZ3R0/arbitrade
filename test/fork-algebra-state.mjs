// Fork / live-RPC validation of the on-chain Algebra reader (YoBatches2/3
// getAlgebraState). The ONE check that needs a real pool: it proves the Yul
// selectors and word offsets match a live Algebra V1 or Integral pool, by
// comparing the batch reader's decoded state against the same values read
// directly from the pool.
//
// Variant-agnostic: it decodes globalState/ticks by RAW WORD POSITION (price@0,
// tick@1, fee@2; ticks.liquidityDelta@1), exactly as the YoBatches Yul does — so
// it works whether the pool is Algebra V1 (7-field globalState, 8-field ticks)
// or Integral (6-field / 6-field). Do NOT type the tuples: field COUNT differs
// by variant, only the leading word positions are stable.
//
// Not in CI (needs a chain). Run before trusting Algebra sizes:
//   node --experimental-strip-types test/fork-algebra-state.mjs \
//        --rpc https://rpc.<chain> --yo 0x<YoBatches3> --pool 0x<algebraPool> [--pool 0x...]
import { JsonRpcProvider, id } from 'ethers';
import { getAlgebraStates, supportsAlgebra } from '../source/util/yobatches.ts';

const argv = process.argv.slice(2);
const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const all = (k) => argv.reduce((a, v, i) => (argv[i - 1] === k ? [...a, v] : a), []);
const RPC = opt('--rpc') ?? process.env.ALGEBRA_FORK_RPC;
const YO = opt('--yo') ?? process.env.ALGEBRA_YOBATCHES;
const POOLS = all('--pool');
const WORDS = Number(opt('--words') ?? 2);
if (!RPC || !YO || POOLS.length === 0) {
    console.error('usage: --rpc <url> --yo <YoBatches3 addr> --pool <algebra pool> [--pool ...] [--words N]');
    process.exit(2);
}

const provider = new JsonRpcProvider(RPC);

// --- raw, variant-agnostic pool reads (word-position decode) ------------------
const sel = (s) => id(s).slice(0, 10);
const wordAt = (hex, i) => hex.slice(2 + i * 64, 2 + (i + 1) * 64);     // 32-byte word i
const u = (h) => BigInt('0x' + h);
const i256 = (h) => BigInt.asIntN(256, BigInt('0x' + h));               // int24/int128 are sign-extended to 256 in ABI
const argWord = (v) => BigInt.asUintN(256, BigInt(v)).toString(16).padStart(64, '0');
const raw = (addr, data) => provider.call({ to: addr, data });

const SEL = {
    globalState: sel('globalState()'),
    liquidity: sel('liquidity()'),
    tickSpacing: sel('tickSpacing()'),
    ticks: sel('ticks(int24)'),
    tickTable: sel('tickTable(int16)'),
};

let pass = 0, fail = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log(`  ok   ${m} ${x}`); } else { fail++; console.log(`  FAIL ${m} ${x}`); } };

// Direct tick walk: read the tickTable bitmap over the same window the contract
// uses, and each initialized tick's liquidityDelta (word 1 of ticks()).
async function directTicks(addr, tick, spacing) {
    const w0 = Math.floor(tick / spacing) >> 8;
    const out = [];
    for (let wp = w0 - WORDS; wp <= w0 + WORDS; wp++) {
        if (wp < -32768 || wp > 32767) continue;
        const bmHex = await raw(addr, SEL.tickTable + argWord(wp));
        const bm = u(wordAt(bmHex, 0));
        for (let b = 0; b < 256; b++) {
            if ((bm >> BigInt(b)) & 1n) {
                const t = (wp * 256 + b) * spacing;
                const tkHex = await raw(addr, SEL.ticks + argWord(t));
                out.push({ index: t, liquidityNet: i256(wordAt(tkHex, 1)) });
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

    let gsHex, liqHex, spHex;
    try {
        gsHex = await raw(addr, SEL.globalState);
        liqHex = await raw(addr, SEL.liquidity);
        spHex = await raw(addr, SEL.tickSpacing);
    } catch (e) {
        ok(false, `direct reads reverted — is ${addr} really an Algebra pool? (${(e?.shortMessage || e?.message || e).toString().slice(0, 60)})`);
        continue;
    }
    const price = u(wordAt(gsHex, 0));
    const gTick = Number(i256(wordAt(gsHex, 1)));
    const gFee = Number(u(wordAt(gsHex, 2)) & 0xffffn);
    const liq = u(wordAt(liqHex, 0));
    const spacing = Number(i256(wordAt(spHex, 0)));

    // The reader prefers fee() (Integral: the fee the NEXT swap pays, from the
    // plugin) and falls back to globalState.lastFee when the pool has no fee()
    // (Algebra V1). Mirror that here.
    let liveFee = null;
    try { liveFee = Number(u(wordAt(await raw(addr, sel('fee()')), 0)) & 0xffffffn); } catch { /* no fee() → V1 */ }
    const expectedFee = liveFee ?? gFee;

    ok(st.sqrtPriceX96 === price, 'price = globalState word0', `${st.sqrtPriceX96}`);
    ok(st.tick === gTick, 'tick = globalState word1', `${st.tick}`);
    ok(st.fee === expectedFee, liveFee !== null ? 'fee = fee() (live, next swap)' : 'fee = globalState word2 (lastFee; pool has no fee())', `${st.fee}`);
    ok(st.liquidity === liq, 'liquidity = liquidity()', `${st.liquidity}`);
    ok(st.tickSpacing === spacing, 'tickSpacing = tickSpacing()', `${st.tickSpacing}`);
    if (liveFee !== null && liveFee !== gFee) console.log(`  [i] fee() live=${liveFee} vs globalState.lastFee=${gFee} — dynamic fee moved; reader correctly uses fee()`);

    const direct = await directTicks(addr, gTick, spacing);
    ok(st.ticks.length === direct.length, 'tick count matches direct bitmap walk', `reader ${st.ticks.length} vs direct ${direct.length}`);
    const byIdx = new Map(direct.map(t => [t.index, t.liquidityNet]));
    let mism = 0;
    for (const t of st.ticks) if (byIdx.get(t.index) !== t.liquidityNet) mism++;
    ok(mism === 0, "every reader tick has the pool's liquidityNet", mism ? `${mism} mismatched` : '');
    console.log('');
}

console.log(`${fail === 0 ? 'ALL PASSED — reader matches the live pool' : fail + ' FAILED — do NOT trust Algebra sizes until fixed'} (${pass} ok)`);
process.exit(fail === 0 ? 0 : 1);
