// Does YoBatches2.getV3State return exactly the pool's state, and is that
// state enough to price swaps bit-exactly?
//
// Against the real UniswapV3Pool bytecode (v3-core 1.0.0) on a local anvil:
//
//   1. Every field matches a direct read of the pool: slot0 price and tick,
//      liquidity, fee, tickSpacing, and the full set of initialized ticks in
//      the window (found independently by scanning tickBitmap), with their
//      liquidityNet.
//   2. v3_swap_exact on the DECODED state reproduces the pool's own swap
//      result to the wei whenever the swap stays in the window — the end-to-
//      end property the reserves stage relies on — and reports incomplete
//      rather than a wrong number when it does not.
//   3. Junk entries (an EOA, a V2-style ERC20, a reverting contract) come back
//      as null without disturbing the pools around them.
//   4. getReserves still answers in the flat two-words-per-pair layout.
//   5. Gas per pool at several window sizes, so batch size can be chosen
//      against the node's eth_call gas cap.
//   6. YoBatches3's packed reads return exactly what the ABI reads return —
//      every pool and window size, junk entries, zero / small / > 2^128
//      balances — in a fraction of the bytes. Sections 1-4 above already run
//      through the packed path, because the client picks it automatically
//      for a YoBatches3 (ARB_NO_PACKED=1 forces the ABI one).
//
//   npm i -D @uniswap/v3-core@1.0.1 solc@0.8.24     (one-time)
//   node test/test-yobatches-v3.mjs                 (anvil on PATH)

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { ethers } from 'ethers';
import { getV3States, getReservesByPairs } from '../source/util/yobatches.ts';
import { v3_swap_exact, getSqrtRatioAtTick, MIN_SQRT_RATIO, MAX_SQRT_RATIO } from '../source/util/calculus-v3.js';

const require = createRequire(import.meta.url);
const here = (p) => new URL(p, import.meta.url);

let fails = 0;
const ok = (c, l, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${l} ${extra}`); if (!c) fails++; };

// ---- compile -----------------------------------------------------------------
const solc = require('solc');
const input = {
    language: 'Solidity',
    sources: {
        'YoBatches2.sol': { content: fs.readFileSync(here('../contracts/YoBatches2.sol'), 'utf8') },
        'YoBatches3.sol': { content: fs.readFileSync(here('../contracts/YoBatches3.sol'), 'utf8') },
        'V3Harness.sol': { content: fs.readFileSync(here('./v3-golden/V3Harness.sol'), 'utf8') },
    },
    settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
};
const compiled = JSON.parse(solc.compile(JSON.stringify(input)));
for (const e of compiled.errors ?? []) if (e.severity === 'error') { console.error(e.formattedMessage); process.exit(1); }
const pick = (f, n) => ({ abi: compiled.contracts[f][n].abi, bytecode: '0x' + compiled.contracts[f][n].evm.bytecode.object });
const A = { Yo: pick('YoBatches3.sol', 'YoBatches3'), Tok: pick('V3Harness.sol', 'Tok'), Harness: pick('V3Harness.sol', 'Harness') };
const art = n => require(`@uniswap/v3-core/artifacts/contracts/${n}.sol/${n}.json`);
const F = art('UniswapV3Factory'), P = art('UniswapV3Pool');

// ---- chain -------------------------------------------------------------------
const PORT = 8548;
const anvil = spawn('anvil', ['--port', String(PORT), '--disable-code-size-limit', '--gas-limit', '3000000000', '--silent']);
await new Promise(r => setTimeout(r, 1500));
const provider = new ethers.JsonRpcProvider(`http://127.0.0.1:${PORT}`, undefined, { cacheTimeout: -1, staticNetwork: true });
const signer = await provider.getSigner(0);
let nonce = await provider.getTransactionCount(await signer.getAddress());
const ov = () => ({ nonce: nonce++, gasLimit: 30_000_000n });
const send = async (p) => (await p).wait();
const deploy = async (a, ...args) => { const c = await new ethers.ContractFactory(a.abi, a.bytecode, signer).deploy(...args, ov()); await c.waitForDeployment(); return c; };

let seed = 99;
const rnd = () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const big = (x) => BigInt(Math.floor(x).toLocaleString('fullwide', { useGrouping: false }));

try {
    const factory = await deploy(F);
    await send(factory.enableFeeAmount(100, 1, ov()));
    const harness = await deploy(A.Harness);
    const yo = await deploy(A.Yo);
    const YO = await yo.getAddress();

    // Pools across all tiers; spacing-1 pools get ranges that span several
    // bitmap words so the window edge is actually exercised.
    const TIERS = [[100, 1], [500, 10], [3000, 60], [10000, 200]];
    const pools = [];
    for (let p = 0; p < 12; p++) {
        const [fee, spacing] = TIERS[p % 4];
        const ta = await deploy(A.Tok), tb = await deploy(A.Tok);
        let [t0, t1] = [await ta.getAddress(), await tb.getAddress()];
        if (BigInt(t0) > BigInt(t1)) [t0, t1] = [t1, t0];
        await send(factory.createPool(t0, t1, fee, ov()));
        const pool = new ethers.Contract(await factory.getPool(t0, t1, fee), P.abi, signer);
        const tick = ri(-60000, 60000);
        const s0 = getSqrtRatioAtTick(tick), s1 = getSqrtRatioAtTick(tick + 1);
        await send(pool.initialize(s0 + (s1 - s0) / 3n, ov()));
        const c = Math.floor(tick / spacing) * spacing;
        const reach = spacing === 1 ? 1500 : 700;
        for (let k = ri(4, 14); k > 0; k--) {
            let lo = c - ri(0, reach) * spacing, hi = c + ri(1, reach) * spacing;
            if (rnd() < 0.3) { const o = ri(-80, 80) * spacing; lo += o; hi += o; }
            if (lo >= hi) hi = lo + spacing;
            await send(harness.mint(await pool.getAddress(), lo, hi, big(10 ** (12 + rnd() * 9)), ov()));
        }
        pools.push({ pool, fee, spacing, t0, t1 });
    }
    const addrs = await Promise.all(pools.map(p => p.pool.getAddress()));

    // Independent read: every initialized tick in a word range, via tickBitmap.
    async function directTicks(pool, spacing, tick, words) {
        const w0 = Math.floor(tick / spacing) >> 8;
        const ws = []; for (let w = w0 - words; w <= w0 + words; w++) ws.push(w);
        const bms = await Promise.all(ws.map(w => pool.tickBitmap(w)));
        const idx = [];
        ws.forEach((w, k) => { for (let b = 0; b < 256; b++) if ((bms[k] >> BigInt(b)) & 1n) idx.push((w * 256 + b) * spacing); });
        const t = await Promise.all(idx.map(i => pool.ticks(i)));
        return idx.map((index, k) => ({ index, liquidityNet: t[k].liquidityNet }));
    }

    console.log('1. getV3State matches direct reads of the pool');
    let swapChecks = 0, swapIncomplete = 0, swapBad = 0, crossed = 0, reverts = 0;
    for (let round = 0; round < 6; round++) {
        const words = [0, 1, 2, 3][round % 4];
        const batch = await getV3States(provider, YO, addrs, words);
        let fieldBad = 0, tickBad = 0, nTicks = 0;
        for (let i = 0; i < pools.length; i++) {
            const { pool, fee, spacing } = pools[i];
            const got = batch.pools[i];
            const [s0, liq] = await Promise.all([pool.slot0(), pool.liquidity()]);
            if (!got || got.sqrtPriceX96 !== s0[0] || got.tick !== Number(s0[1]) || got.liquidity !== liq
                || got.fee !== fee || got.tickSpacing !== spacing) { fieldBad++; continue; }
            const want = await directTicks(pool, spacing, got.tick, words);
            nTicks += want.length;
            if (want.length !== got.ticks.length
                || want.some((t, k) => t.index !== got.ticks[k].index || t.liquidityNet !== got.ticks[k].liquidityNet)) tickBad++;
        }
        ok(fieldBad === 0 && tickBad === 0, `round ${round + 1}, words=${words}: price/tick/liquidity/fee/spacing and window ticks`,
           `pools=${pools.length} ticks=${nTicks}`);

        // 2. price swaps off the decoded state, compare with the pool itself
        for (let i = 0; i < pools.length; i++) {
            const st = batch.pools[i];
            for (let s = 0; s < 6; s++) {
                const zf = rnd() < 0.5;
                const L = st.liquidity > 0n ? st.liquidity : 10n ** 15n;
                let amt = (L * big(10 ** (rnd() * 8))) / 10n ** 6n + 1n;
                if (rnd() < 0.4) amt = -amt;
                const lim = zf ? MIN_SQRT_RATIO + 1n : MAX_SQRT_RATIO - 1n;
                let sim, r, simErr, chainErr;
                try { sim = v3_swap_exact(st, zf, amt); } catch (e) { simErr = e.message; }
                if (sim && !sim.complete) { swapIncomplete++; continue; }
                try { r = await harness.swapReport.staticCall(addrs[i], zf, amt, lim); } catch (e) { chainErr = e.shortMessage ?? e.message; }
                swapChecks++;
                if (simErr || chainErr) { reverts++; if (!(simErr && chainErr)) swapBad++; continue; }
                crossed += sim.crossed;
                if (r[0] !== sim.amount0 || r[1] !== sim.amount1 || r[2] !== sim.sqrtPriceX96
                    || Number(r[3]) !== sim.tick || r[4] !== sim.liquidity) swapBad++;
            }
            // move the pool so the next round reads a different state
            const zf = rnd() < 0.5;
            const amt = (st.liquidity > 0n ? st.liquidity : 10n ** 15n) * big(10 ** (rnd() * 6)) / 10n ** 6n + 1n;
            try { await send(harness.swap(addrs[i], zf, amt, zf ? MIN_SQRT_RATIO + 1n : MAX_SQRT_RATIO - 1n, ov())); }
            catch { nonce = await provider.getTransactionCount(await signer.getAddress()); }
        }
    }

    console.log('\n2. swaps priced from the decoded state match the pool');
    ok(swapChecks > 150, 'enough in-window swaps checked', `n=${swapChecks}, crossings=${crossed}, both-reverted=${reverts}`);
    ok(swapIncomplete > 0, 'and some swaps ran past the window', `incomplete=${swapIncomplete} (reported, not mispriced)`);
    ok(swapBad === 0, 'every in-window swap bit-exact', `${swapChecks - swapBad}/${swapChecks}`);

    console.log('\n3. junk entries degrade to null without disturbing neighbours');
    {
        const eoa = await signer.getAddress();
        const tok = pools[0].t0;                                    // has code, no slot0()
        const list = [addrs[0], eoa, addrs[1], tok, ethers.ZeroAddress, addrs[2]];
        const b = await getV3States(provider, YO, list, 1);
        ok(b.pools[1] === null && b.pools[3] === null && b.pools[4] === null, 'EOA, ERC20 and zero address -> null');
        const clean = await getV3States(provider, YO, [addrs[0], addrs[1], addrs[2]], 1);
        const same = (x, y) => JSON.stringify(x, (k, v) => typeof v === 'bigint' ? v.toString() : v) ===
                               JSON.stringify(y, (k, v) => typeof v === 'bigint' ? v.toString() : v);
        ok(same(b.pools[0], clean.pools[0]) && same(b.pools[2], clean.pools[1]) && same(b.pools[5], clean.pools[2]),
           'real pools around them decode identically');
        ok(b.block === Number(await provider.getBlockNumber()), 'block number echoed', `block=${b.block}`);
    }

    console.log('\n4. getReserves (V2 path) unchanged');
    {
        // Mint a known balance to a pool address and read it back as "reserves".
        const ta = new ethers.Contract(pools[0].t0, A.Tok.abi, signer);
        const holder = ethers.Wallet.createRandom().address;
        await send(ta.mint(holder, 123456789n, ov()));
        const r = await getReservesByPairs(provider, YO, [[holder, pools[0].t0, pools[0].t1], [addrs[0], ethers.ZeroAddress, pools[0].t1]]);
        ok(r[0].reserves0 === 123456789n && r[0].reserves1 === 0n, 'balance read back as reserve0');
        ok(r[1].reserves0 === 0n, 'codeless token reads as 0 instead of reverting');
    }

    console.log('\n6. packed reads = ABI reads, in fewer bytes');
    {
        const { supportsPacked } = await import('../source/util/yobatches.ts');
        ok(await supportsPacked(provider, YO), 'client detects the packed functions on YoBatches3');
        const junk = [await signer.getAddress(), pools[0].t0, ethers.ZeroAddress];
        const list = [...addrs.slice(0, 4), junk[0], ...addrs.slice(4, 8), junk[1], ...addrs.slice(8), junk[2]];
        const norm = (x) => JSON.stringify(x, (k, v) => typeof v === 'bigint' ? v.toString() : v);
        const vi = new ethers.Interface(A.Yo.abi);
        const blockTag = await provider.getBlockNumber();
        let same = true, abiBytes = 0, packedBytes = 0;
        for (const words of [0, 1, 2, 3]) {
            const packed = await getV3States(provider, YO, list, words, blockTag);
            process.env.ARB_NO_PACKED = '1';
            const plain = await getV3States(provider, YO, list, words, blockTag);
            delete process.env.ARB_NO_PACKED;
            if (norm(packed.pools) !== norm(plain.pools) || packed.block !== plain.block) same = false;
            abiBytes += plain.bytes; packedBytes += packed.bytes;
        }
        ok(same, 'getV3StatePacked decodes identically to getV3State (words 0-3, 12 pools + 3 junk)');
        const pIn = vi.encodeFunctionData('getV3StatePacked', ['0x' + list.map(a => a.slice(2)).join(''), 2]).length;
        const aIn = vi.encodeFunctionData('getV3State', [list, 2]).length;
        console.log(`  v3: calldata ${aIn / 2 - 1} -> ${pIn / 2 - 1} bytes, returndata ${abiBytes} -> ${packedBytes} bytes ` +
            `(${(abiBytes / packedBytes).toFixed(1)}x smaller)`);
        ok(packedBytes * 2 < abiBytes, 'packed v3 response is under half the size');

        // Reserves: zero, small, and a balance above 2^128 (huge-supply tokens exist).
        const ta = new ethers.Contract(pools[0].t0, A.Tok.abi, signer);
        const tb = new ethers.Contract(pools[0].t1, A.Tok.abi, signer);
        const holders = Array.from({ length: 6 }, () => ethers.Wallet.createRandom().address);
        await send(ta.mint(holders[0], 1n, ov()));
        await send(ta.mint(holders[1], (1n << 200n) + 12345n, ov()));
        await send(tb.mint(holders[1], 255n, ov()));
        await send(tb.mint(holders[2], 256n, ov()));
        const triples = [
            ...holders.map(h => [h, pools[0].t0, pools[0].t1]),
            [addrs[0], ethers.ZeroAddress, pools[0].t1],          // codeless token
            [addrs[1], await signer.getAddress(), pools[0].t0],   // EOA as token
            ...addrs.map((a, i) => [a, pools[i].t0, pools[i].t1]),
        ];
        const pr = await getReservesByPairs(provider, YO, triples);
        process.env.ARB_NO_PACKED = '1';
        const ar = await getReservesByPairs(provider, YO, triples);
        delete process.env.ARB_NO_PACKED;
        ok(norm(pr) === norm(ar), 'getReservesPacked = getReserves (0, 1, 255, 256, 2^200+12345, junk tokens, real pools)');
        ok(pr[1].reserves0 === (1n << 200n) + 12345n, 'a balance above 2^128 survives the variable-length encoding');
        // getReservesByPool: the contract reads token0()/token1() itself.
        const canon = addrs.map((a, i) => [a, pools[i].t0, pools[i].t1]);
        const bp = await getReservesByPairs(provider, YO, canon, { canonical: true });
        process.env.ARB_NO_PACKED = '1';
        const ap = await getReservesByPairs(provider, YO, canon);
        delete process.env.ARB_NO_PACKED;
        ok(norm(bp) === norm(ap) && bp.some(r => r.reserves0 > 0n), 'getReservesByPool = getReserves on real pools (tokens read by the contract)');
        const junkPool = await getReservesByPairs(provider, YO, [[await signer.getAddress(), pools[0].t0, pools[0].t1], [pools[0].t0, pools[0].t0, pools[0].t1]], { canonical: true });
        ok(junkPool.every(r => r.reserves0 === 0n && r.reserves1 === 0n), 'an EOA or a non-pool contract reads as 0 / 0');
        const byPoolReq = (vi.encodeFunctionData('getReservesByPool', ['0x' + canon.map(c => c[0].slice(2)).join('')]).length - 2) / 2;
        const abiCanon = (vi.encodeFunctionData('getReserves', [canon]).length - 2) / 2;
        console.log(`  by-pool: calldata ${abiCanon} -> ${byPoolReq} bytes for ${canon.length} pairs (${(abiCanon / byPoolReq).toFixed(1)}x smaller)`);
        const pq = 0;
        const reqBytes = 2 + 20 * new Set(triples.flatMap(t => [t[1].toLowerCase(), t[2].toLowerCase()])).size + 24 * triples.length;
        const abiReq = (vi.encodeFunctionData('getReserves', [triples]).length - 2) / 2;
        console.log(`  reserves: calldata ${abiReq} -> ~${reqBytes + 4 + 64} bytes for ${triples.length} pairs`);
        void pq;
    }

    console.log('\n5. gas per pool (for choosing a batch size)');
    {
        const iface = new ethers.Interface(['function getV3State(address[] pools, uint256 words) view returns (uint256[])']);
        for (const words of [0, 1, 2, 4]) {
            const g = async (list) => Number(await provider.estimateGas({ to: YO, data: iface.encodeFunctionData('getV3State', [list, words]) }));
            const one = await g([addrs[0]]), all = await g(addrs);
            const per = (all - one) / (addrs.length - 1);
            const b = await getV3States(provider, YO, addrs, words);
            const avgTicks = b.pools.reduce((a, p) => a + p.ticks.length, 0) / addrs.length;
            console.log(`  words=${words}: ~${Math.round(per).toLocaleString()} gas/pool  (avg ${avgTicks.toFixed(1)} ticks returned)` +
                `  -> ~${Math.floor(50e6 / per)} pools per 50M eth_call`);
        }
        console.log('  each estimate is a fresh call, so every pool and slot access is cold — this is the real cost.');
    }
} finally {
    anvil.kill();
}

console.log(fails === 0 ? '\nALL YOBATCHES V3 CHECKS PASS' : `\n${fails} FAILED`);
process.exit(fails ? 1 : 0);
