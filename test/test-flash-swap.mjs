// FlashArbExecutor.executeFlashSwap — hop 0 funds the cycle, no lender.
//
//   1. Same cycle, same state (evm_snapshot), four ways: Aave (mock, 0.05%),
//      Morpho (mock, free), Balancer (mock, free), flash swap. The flash swap
//      must keep EXACTLY what a free lender keeps (same sizes, same path), Aave
//      that minus its premium — and the flash swap must use the least gas.
//      Hop 0 is a REAL UniswapV2Pair (v2-core 1.0.1 bytecode), so the
//      uniswapV2Call callback, lock and K check are the production ones.
//      Cases: 2-hop across two V2 factories, 3-hop V2, and V2 -> V3 -> V2
//      with a real v3-core pool as hop 1.
//   2. Callback spellings: pancakeCall, Solidly hook (Velodrome-shaped pool
//      that moves its fee out before K), and an arbitrary fork name
//      (BiswapCall) reaching `fallback`.
//   3. Live sizing: reserve drift on hop 0 AND on hop 1 between quote and
//      execution reduces profit instead of reverting; a taxed middle token is
//      measured, not assumed.
//   4. Money safety: minProfit enforced; unswept root balance cannot rescue a
//      losing cycle and is untouched after the revert; a taxed ROOT token
//      reverts (hop 0 underpaid) rather than settling short.
//   5. Callback safety: direct calls (named and fallback) with nothing armed;
//      a pair that tampers with the echoed data; one that calls back twice;
//      one that reports a different initiator; one that pays out without
//      calling back; a lender callback while a flash swap is armed.
//   6. Bad inputs: owner-only, hop 0 not V2, hop 0 recipient not the
//      executor, hops[1].tokenIn not hop 0's output, root not in the pair,
//      single hop, zero amount.
//
//   npm i -D @uniswap/v2-core@1.0.1 @uniswap/v3-core@1.0.1 solc@0.8.24   (one-time)
//   node test/test-flash-swap.mjs        (anvil on PATH; own anvil on 8559)

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { ethers } from 'ethers';

const require = createRequire(import.meta.url);
const here = (p) => new URL(p, import.meta.url);
let fails = 0;
const ok = (c, l, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${l} ${extra}`); if (!c) fails++; };

// A V2 pair whose callback name and behaviour are configurable.
//   mode 0 honest · 1 tamper with the echoed data · 2 call back twice
//   mode 3 report a different initiator · 4 pay out, never call back, no K
const FORK = `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
interface ITokF { function transfer(address, uint256) external returns (bool); function balanceOf(address) external view returns (uint256); }
contract ForkPair {
    address public token0; address public token1; uint112 r0; uint112 r1;
    bytes4 public sel; uint8 public mode;
    constructor(address a, address b, bytes4 _sel, uint8 _mode) { (token0, token1) = a < b ? (a, b) : (b, a); sel = _sel; mode = _mode; }
    function getReserves() external view returns (uint112, uint112, uint32) { return (r0, r1, 0); }
    function sync() external { r0 = uint112(ITokF(token0).balanceOf(address(this))); r1 = uint112(ITokF(token1).balanceOf(address(this))); }
    function _cb(address to, address s, uint256 a0, uint256 a1, bytes memory d) internal {
        (bool ok, bytes memory ret) = to.call(abi.encodeWithSelector(sel, s, a0, a1, d));
        if (!ok) assembly { revert(add(ret, 32), mload(ret)) }
    }
    function swap(uint256 a0, uint256 a1, address to, bytes calldata data) external {
        if (a0 > 0) ITokF(token0).transfer(to, a0);
        if (a1 > 0) ITokF(token1).transfer(to, a1);
        if (mode == 4) return;
        if (data.length > 0) {
            bytes memory d = data;
            if (mode == 1) d[d.length - 1] = bytes1(uint8(d[d.length - 1]) ^ 1);
            address s = mode == 3 ? address(this) : msg.sender;
            _cb(to, s, a0, a1, d);
            if (mode == 2) _cb(to, s, a0, a1, d);
        }
        uint256 b0 = ITokF(token0).balanceOf(address(this)); uint256 b1 = ITokF(token1).balanceOf(address(this));
        uint256 in0 = b0 > r0 - a0 ? b0 - (r0 - a0) : 0; uint256 in1 = b1 > r1 - a1 ? b1 - (r1 - a1) : 0;
        require(in0 > 0 || in1 > 0, "IIA");
        require((b0 * 1000 - in0 * 3) * (b1 * 1000 - in1 * 3) >= uint256(r0) * r1 * 1e6, "K");
        r0 = uint112(b0); r1 = uint112(b1);
    }
}
/// Calls the Aave callback on whoever it is pointed at, from inside a hop.
contract AaveCaller {
    function poke(address exec) external {
        (bool ok, bytes memory ret) = exec.call(abi.encodeWithSignature(
            "executeOperation(address,uint256,uint256,address,bytes)", address(0), 0, 0, exec, ""));
        if (!ok) assembly { revert(add(ret, 32), mload(ret)) }
    }
}`;

const solc = require('solc');
const out = JSON.parse(solc.compile(JSON.stringify({
    language: 'Solidity',
    sources: {
        'FlashArbExecutor.sol': { content: fs.readFileSync(here('../contracts/FlashArbExecutor.sol'), 'utf8') },
        'Mocks.sol': { content: fs.readFileSync(here('./Mocks.sol'), 'utf8') },
        'V3Harness.sol': { content: fs.readFileSync(here('./v3-golden/V3Harness.sol'), 'utf8') },
        'Fork.sol': { content: FORK },
    },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'shanghai',
                outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
})));
for (const e of out.errors ?? []) if (e.severity === 'error') { console.error(e.formattedMessage); process.exit(1); }
const art = {};
for (const [, cs] of Object.entries(out.contracts)) for (const [n, c] of Object.entries(cs)) art[n] = { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object };
const v2 = n => { const j = require(`@uniswap/v2-core/build/${n}.json`); return { abi: j.abi, bytecode: '0x' + j.bytecode.replace(/^0x/, '') }; };
const v3 = n => require(`@uniswap/v3-core/artifacts/contracts/${n}.sol/${n}.json`);

const PORT = 8559;
const anvil = spawn('anvil', ['--port', String(PORT), '--disable-code-size-limit', '--gas-limit', '3000000000', '--silent']);
await new Promise(r => setTimeout(r, 1500));
const provider = new ethers.JsonRpcProvider(`http://127.0.0.1:${PORT}`, undefined, { cacheTimeout: -1, staticNetwork: true });
const signer = await provider.getSigner(0);
let nonce = await provider.getTransactionCount(await signer.getAddress());
const ov = () => ({ nonce: nonce++, gasLimit: 30_000_000n });
const resync = async () => { nonce = await provider.getTransactionCount(await signer.getAddress()); };
const deploy = async (a, ...args) => { const c = await new ethers.ContractFactory(a.abi, a.bytecode, signer).deploy(...args, ov()); await c.waitForDeployment(); return c; };
const send = async (p) => (await p).wait();
const snapshot = () => provider.send('evm_snapshot', []);
const revertTo = async (id) => { await provider.send('evm_revert', [id]); await resync(); };

const E = (n) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;
const fmt = (w) => Number(ethers.formatUnits(w, 18)).toFixed(4);
const EXI = new ethers.Interface(art.FlashArbExecutor.abi);
const errName = (e) => {
    for (const d of [e?.data, e?.info?.error?.data, e?.error?.data, e?.revert?.data]) {
        if (typeof d === 'string' && d.length >= 10) { try { const p = EXI.parseError(d); if (p) return p.name; } catch {} }
    }
    const m = String(e?.shortMessage ?? e?.message ?? e);
    const r = m.match(/reverted with reason string ['"]([^'"]+)/) ?? m.match(/reason="([^"]+)"/) ?? m.match(/execution reverted: "?([^"\n]+)/);
    return r ? r[1] : m.slice(0, 90);
};
const tryErr = async (f) => { try { await f(); return ''; } catch (e) { return errName(e); } };
function arbEvent(rc) {
    for (const l of rc.logs) { try { const p = EXI.parseLog(l); if (p?.name === 'ArbExecuted') return p.args; } catch {} }
    return null;
}
const SRC = { aave: 0, balancer: 1, morpho: 3 };
const SEL = (sig) => ethers.id(sig).slice(0, 10);

try {
    const tok = async (name, tax = 0) => { const t = await deploy(art.MockToken, name, tax); return { t, a: await t.getAddress() }; };
    const v2f1 = await deploy(v2('UniswapV2Factory'), ethers.ZeroAddress);
    const v2f2 = await deploy(v2('UniswapV2Factory'), ethers.ZeroAddress);
    const v3f = await deploy(v3('UniswapV3Factory'));
    const harness = await deploy(art.Harness);
    const PAIR_ABI = v2('UniswapV2Pair').abi;

    /** A real UniswapV2Pair from `factory`, seeded with x of A and y of B. */
    async function v2pair(factory, A, B, x, y) {
        await send(factory.createPair(A.a, B.a, ov()));
        const P = await factory.getPair(A.a, B.a);
        await send(A.t.mint(P, E(x), ov())); await send(B.t.mint(P, E(y), ov()));
        const p = new ethers.Contract(P, PAIR_ABI, signer);
        await send(p.mint(await signer.getAddress(), ov()));
        return { p, P };
    }
    async function forkPair(A, B, x, y, sig, mode = 0) {
        const p = await deploy(art.ForkPair, A.a, B.a, SEL(sig), mode);
        const P = await p.getAddress();
        await send(A.t.mint(P, E(x), ov())); await send(B.t.mint(P, E(y), ov())); await send(p.sync(ov()));
        return { p, P };
    }
    /** A real v3-core pool at price 1, wide liquidity. */
    async function v3pool(A, B, fee = 500) {
        await send(v3f.createPool(A.a, B.a, fee, ov()));
        const pool = new ethers.Contract(await v3f.getPool(A.a, B.a, fee), v3('UniswapV3Pool').abi, signer);
        await send(pool.initialize(1n << 96n, ov()));
        await send(harness.mint(await pool.getAddress(), -887270, 887270, E(1e6), ov()));
        return { p: pool, P: await pool.getAddress() };
    }
    /** Executor + funded lenders for root R. */
    async function rig(R) {
        const exec = await deploy(art.FlashArbExecutor, ethers.ZeroAddress);
        const aave = await deploy(art.MockAavePool, 5n), morpho = await deploy(art.MockMorpho), vault = await deploy(art.MockBalancerVault, 0n);
        for (const l of [aave, morpho, vault]) await send(R.t.mint(await l.getAddress(), E(1e7), ov()));
        return { exec, EX: await exec.getAddress(), aave: await aave.getAddress(), morpho: await morpho.getAddress(), vault: await vault.getAddress() };
    }
    // Hop tuples: [pair, tokenIn, feePpm, recipient, kind]
    const H = (P, tokenIn, recipient, kind = 0, fee = 3000) => [P, tokenIn, fee, recipient, kind];

    // Lender-path hops route hop 0 straight into hop 1 when hop 1 is V2; the
    // flash path always routes hop 0 HERE (it is the callback target).
    const lenderHops = (hops, EX) => hops.map((h, i) => i === 0 && hops[1][4] === 0 ? [h[0], h[1], h[2], hops[1][0], h[4]] : h);

    const gasRows = [];
    async function compare(label, R, hops, rg, BORROW) {
        const res = {};
        const ts = (await provider.getBlock('latest')).timestamp + 1000;
        const lh = lenderHops(hops, rg.EX);
        for (const [name, fn, args] of [
            ['aave',     'executeArbFrom', [SRC.aave, rg.aave, R.a, BORROW, 0n, lh]],
            ['balancer', 'executeArbFrom', [SRC.balancer, rg.vault, R.a, BORROW, 0n, lh]],
            ['morpho',   'executeArbFrom', [SRC.morpho, rg.morpho, R.a, BORROW, 0n, lh]],
            ['flash',    'executeFlashSwap', [BORROW, 0n, hops]],
        ]) {
            // Each run starts from the identical state (anvil consumes a
            // snapshot on revert, so take a fresh one every time).
            const snap = await snapshot();
            // Same block timestamp for every run: a real UniswapV2Pair writes
            // its price accumulators only when time has passed, and a 20k
            // zero->nonzero SSTORE landing in one run and not another would
            // swamp the difference being measured.
            await provider.send('evm_setNextBlockTimestamp', [ts]);
            let rc, err;
            try { rc = await send(rg.exec[fn](...args, ov())); }
            catch { await resync(); err = await tryErr(() => rg.exec[fn].staticCall(...args)) || 'reverted'; }
            res[name] = rc ? { gas: rc.gasUsed, profit: arbEvent(rc)?.profit, premium: arbEvent(rc)?.premium } : { err };
            await revertTo(snap);
        }
        const f = res.flash, m = res.morpho, a = res.aave, b = res.balancer;
        if (f.err || m.err || a.err) { ok(false, label, JSON.stringify({ f: f.err, m: m.err, a: a.err })); return; }
        ok(f.profit === m.profit && f.profit === b.profit, `${label}: flash swap keeps exactly what a free lender keeps`, `(${fmt(f.profit)})`);
        ok(f.profit - a.profit === a.premium && a.premium > 0n, `${label}: and Aave's premium more than Aave`, `(+${fmt(a.premium)})`);
        ok(f.gas < m.gas && f.gas < b.gas && f.gas < a.gas, `${label}: least gas of all four`,
           `(flash ${f.gas} · morpho ${m.gas} · balancer ${b.gas} · aave ${a.gas})`);
        gasRows.push([label, f.gas, m.gas, b.gas, a.gas]);
    }

    // ---------------------------------------------------------------------
    console.log('1. same cycle, same state: flash swap vs every lender');
    {
        // 2-hop: R/X on two V2 factories, X 4% dearer on the second.
        const R = await tok('R'), X = await tok('X');
        const A = await v2pair(v2f1, R, X, 1e6, 1e6), B = await v2pair(v2f2, X, R, 1e6, 1.04e6);
        const rg = await rig(R);
        await compare('2-hop V2/V2', R, [H(A.P, R.a, rg.EX), H(B.P, X.a, rg.EX)], rg, E(2000));
    }
    {
        // 3-hop: R -> X -> Y -> R, closing pool 5% rich.
        const R = await tok('R'), X = await tok('X'), Y = await tok('Y');
        const A = await v2pair(v2f1, R, X, 1e6, 1e6), B = await v2pair(v2f1, X, Y, 1e6, 1e6), C = await v2pair(v2f1, Y, R, 1e6, 1.05e6);
        const rg = await rig(R);
        await compare('3-hop V2/V2/V2', R, [H(A.P, R.a, rg.EX), H(B.P, X.a, C.P), H(C.P, Y.a, rg.EX)], rg, E(2000));
    }
    {
        // V2 -> V3 -> V2: hop 1 is a real v3-core pool paid from this contract.
        const R = await tok('R'), X = await tok('X'), Y = await tok('Y');
        const A = await v2pair(v2f1, R, X, 1e6, 1e6), B = await v3pool(X, Y), C = await v2pair(v2f1, Y, R, 1e6, 1.05e6);
        const rg = await rig(R);
        await compare('3-hop V2/V3/V2', R, [H(A.P, R.a, rg.EX), H(B.P, X.a, C.P, 1, 500), H(C.P, Y.a, rg.EX)], rg, E(2000));
    }

    // ---------------------------------------------------------------------
    console.log('\n2. callback spellings');
    for (const sig of ['pancakeCall(address,uint256,uint256,bytes)', 'BiswapCall(address,uint256,uint256,bytes)']) {
        const R = await tok('R'), X = await tok('X');
        const A = await forkPair(R, X, 1e6, 1e6, sig), B = await v2pair(v2f1, X, R, 1e6, 1.04e6);
        const rg = await rig(R);
        let rc, e;
        try { rc = await send(rg.exec.executeFlashSwap(E(2000), 0n, [H(A.P, R.a, rg.EX), H(B.P, X.a, rg.EX)], ov())); } catch (err) { e = errName(err); await resync(); }
        const name = sig.split('(')[0];
        ok(rc && arbEvent(rc)?.profit > 0n, `${name}${name === 'BiswapCall' ? ' (through fallback)' : ''}`, rc ? `profit ${fmt(arbEvent(rc).profit)} gas ${rc.gasUsed}` : `reverted: ${e}`);
    }
    {
        // Solidly hook: Velodrome-shaped pool (fee taken out before K) as hop 0.
        const R = await tok('R'), X = await tok('X');
        const vf = await deploy(art.MockVeloFactory);
        await send(vf.createPool(R.a, X.a, false, ov()));
        const VP = await vf.allPools(0);
        const vp = new ethers.Contract(VP, art.MockVeloPool.abi, signer);
        await send(R.t.mint(VP, E(1e6), ov())); await send(X.t.mint(VP, E(1e6), ov())); await send(vp.sync(ov()));
        const B = await v2pair(v2f1, X, R, 1e6, 1.04e6);
        const rg = await rig(R);
        let rc, e;
        try { rc = await send(rg.exec.executeFlashSwap(E(2000), 0n, [H(VP, R.a, rg.EX, 0, 3000), H(B.P, X.a, rg.EX)], ov())); } catch (err) { e = errName(err); await resync(); }
        ok(rc && arbEvent(rc)?.profit > 0n, 'hook (Velodrome-shaped pool, fee moved out before K)', rc ? `profit ${fmt(arbEvent(rc).profit)}` : `reverted: ${e}`);
    }

    // ---------------------------------------------------------------------
    console.log('\n3. live sizing');
    {
        const R = await tok('R'), X = await tok('X');
        const A = await v2pair(v2f1, R, X, 1e6, 1e6), B = await v2pair(v2f2, X, R, 1e6, 1.04e6);
        const rg = await rig(R);
        const hops = [H(A.P, R.a, rg.EX), H(B.P, X.a, rg.EX)];
        const base = await rg.exec.executeFlashSwap.staticCall(E(2000), 0n, hops).then(() => true, () => false);
        ok(base, 'baseline simulates clean');
        // Someone trades both pairs between our quote and our execution.
        const snap = await snapshot();
        const trader = async (pair, tIn, tOut, amt) => {
            await send(tIn.t.mint(pair.P, E(amt), ov()));
            const [r0, r1] = await pair.p.getReserves();
            const t0 = await pair.p.token0();
            const zero = t0.toLowerCase() === tIn.a.toLowerCase();
            const [rin, rout] = zero ? [r0, r1] : [r1, r0];
            const ain = E(amt), o = ain * 997n * rout / (rin * 1000n + ain * 997n);
            await send(pair.p.swap(zero ? 0n : o, zero ? o : 0n, await signer.getAddress(), '0x', ov()));
        };
        await trader(A, R, X, 3000);   // moves hop 0 (the borrowed pair)
        await trader(B, R, X, 3000);   // moves hop 1 against us
        let rc, e;
        try { rc = await send(rg.exec.executeFlashSwap(E(2000), 0n, hops, ov())); } catch (err) { e = errName(err); await resync(); }
        ok(rc && arbEvent(rc).profit > 0n, 'drift on hop 0 and hop 1 shrinks profit instead of reverting', rc ? `profit ${fmt(arbEvent(rc).profit)}` : `reverted: ${e}`);
        await revertTo(snap);
    }
    {
        // 1% transfer tax on the MIDDLE token: what arrived is what gets spent.
        const R = await tok('R'), X = await tok('X', 100);
        const A = await forkPair(R, X, 1e6, 1e6, 'uniswapV2Call(address,uint256,uint256,bytes)'), B = await forkPair(X, R, 1e6, 1.06e6, 'uniswapV2Call(address,uint256,uint256,bytes)');
        const rg = await rig(R);
        let rc, e;
        try { rc = await send(rg.exec.executeFlashSwap(E(2000), 0n, [H(A.P, R.a, rg.EX), H(B.P, X.a, rg.EX)], ov())); } catch (err) { e = errName(err); await resync(); }
        ok(rc && arbEvent(rc).profit > 0n, 'taxed middle token: measured, trade completes', rc ? `profit ${fmt(arbEvent(rc).profit)}` : `reverted: ${e}`);
    }

    // ---------------------------------------------------------------------
    console.log('\n4. money safety');
    {
        const R = await tok('R'), X = await tok('X');
        const A = await v2pair(v2f1, R, X, 1e6, 1e6), B = await v2pair(v2f2, X, R, 1e6, 1.04e6);
        const rg = await rig(R);
        const hops = [H(A.P, R.a, rg.EX), H(B.P, X.a, rg.EX)];
        const profit = await (async () => { const s = await snapshot(); const rc = await send(rg.exec.executeFlashSwap(E(2000), 0n, hops, ov())); await revertTo(s); return arbEvent(rc).profit; })();
        ok(await tryErr(() => rg.exec.executeFlashSwap.staticCall(E(2000), profit + 1n, hops)) === 'InsufficientRepay', 'minProfit one wei above the edge reverts');
        ok(await tryErr(() => rg.exec.executeFlashSwap.staticCall(E(2000), profit, hops)) === '', 'minProfit exactly at the edge passes');

        const flatR = await tok('R'), flatX = await tok('X');
        const A2 = await v2pair(v2f1, flatR, flatX, 1e6, 1e6), B2 = await v2pair(v2f2, flatX, flatR, 1e6, 1e6);
        const rg2 = await rig(flatR);
        await send(flatR.t.mint(rg2.EX, E(500), ov()));   // "unswept profit" from earlier arbs
        const losing = [H(A2.P, flatR.a, rg2.EX), H(B2.P, flatX.a, rg2.EX)];
        const e = await tryErr(() => rg2.exec.executeFlashSwap.staticCall(E(2000), 0n, losing));
        await send(rg2.exec.executeFlashSwap(E(2000), 0n, losing, ov())).catch(() => {});   // and for real
        await resync();
        ok(e === 'InsufficientRepay', 'unswept root balance cannot rescue a losing cycle', `(${e})`);
        ok(await flatR.t.balanceOf(rg2.EX) === E(500), 'and it is untouched afterwards');

        // Taxed ROOT: hop 0 is underpaid, the pair's K check refuses.
        const tR = await tok('TR', 100), tX = await tok('X');
        const A3 = await v2pair(v2f1, tR, tX, 1e6, 1e6), B3 = await v2pair(v2f2, tX, tR, 1e6, 1.06e6);
        const rg3 = await rig(tR);
        const e3 = await tryErr(() => rg3.exec.executeFlashSwap.staticCall(E(2000), 0n, [H(A3.P, tR.a, rg3.EX), H(B3.P, tX.a, rg3.EX)]));
        ok(e3 !== '', 'taxed root token reverts rather than settling short', `(${e3})`);
    }

    // ---------------------------------------------------------------------
    console.log('\n5. callback safety');
    {
        const R = await tok('R'), X = await tok('X');
        const rg = await rig(R);
        const EX = rg.EX;
        const raw = (sel) => provider.call({ to: EX, data: sel + ethers.AbiCoder.defaultAbiCoder().encode(['address', 'uint256', 'uint256', 'bytes'], [EX, 1n, 0n, '0x1234']).slice(2) });
        let n = 0;
        for (const s of ['uniswapV2Call(address,uint256,uint256,bytes)', 'pancakeCall(address,uint256,uint256,bytes)', 'hook(address,uint256,uint256,bytes)', 'BiswapCall(address,uint256,uint256,bytes)'])
            if (await tryErr(() => raw(SEL(s))) === 'NotPool') n++;
        ok(n === 4, 'direct callback (named or via fallback) with nothing armed: NotPool', `${n}/4`);
        ok(await tryErr(() => provider.call({ to: EX, data: '0x' })) !== '', 'empty calldata / plain call refused');

        const B = await v2pair(v2f1, X, R, 1e6, 1.04e6);
        const cases = [
            [1, 'NotPool', 'pair tampers with the echoed data'],
            [2, 'NotPool', 'pair calls back twice'],
            [3, 'UntrustedInitiator', 'pair reports a different initiator'],
            [4, 'NoFlashCallback', 'pair pays out and never calls back'],
        ];
        for (const [mode, want, label] of cases) {
            const A = await forkPair(R, X, 1e6, 1e6, 'uniswapV2Call(address,uint256,uint256,bytes)', mode);
            const e = await tryErr(() => rg.exec.executeFlashSwap.staticCall(E(2000), 0n, [H(A.P, R.a, EX), H(B.P, X.a, EX)]));
            ok(e === want, label, `(${e || 'no revert!'})`);
        }

        // A lender callback arriving mid-flash-swap: a "pair" in hop 1 pokes
        // executeOperation. _lender is unset, so it must be refused.
        const caller = await deploy(art.AaveCaller);
        ok(await tryErr(() => caller.poke.staticCall(EX)) === 'NotPool', 'lender callbacks stay closed (no lender armed)');
    }

    // ---------------------------------------------------------------------
    console.log('\n6. bad inputs');
    {
        const R = await tok('R'), X = await tok('X'), Y = await tok('Y');
        const A = await v2pair(v2f1, R, X, 1e6, 1e6), B = await v2pair(v2f2, X, R, 1e6, 1.04e6);
        const rg = await rig(R);
        const EX = rg.EX;
        const good = [H(A.P, R.a, EX), H(B.P, X.a, EX)];
        const stranger = new ethers.Wallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d', provider);
        const check = async (label, want, f) => { const e = await tryErr(f); ok(e === want, label, `(${e || 'no revert!'})`); };
        await check('owner-only', 'NotOwner', () => rg.exec.connect(stranger).executeFlashSwap.staticCall(E(1), 0n, good));
        // Kind 1 (V3) is a valid flash-swap first hop now (V3_FLASH_SWAP; test-v3-flash-swap.mjs); an unknown kind is not.
        await check('hop 0 kind must be V2 / STABLE / V3', 'BadHopKind', () => rg.exec.executeFlashSwap.staticCall(E(1), 0n, [H(A.P, R.a, EX, 3), good[1]]));
        await check('hop 0 output must come here', 'BadRecipient', () => rg.exec.executeFlashSwap.staticCall(E(1), 0n, [H(A.P, R.a, B.P), good[1]]));
        await check('hops[1].tokenIn must be hop 0 output', 'TokenNotInPair', () => rg.exec.executeFlashSwap.staticCall(E(1), 0n, [good[0], H(B.P, Y.a, EX)]));
        await check('root not in hop 0 pair', 'TokenNotInPair', () => rg.exec.executeFlashSwap.staticCall(E(1), 0n, [H(A.P, Y.a, EX), good[1]]));
        await check('single hop', 'EmptyHops', () => rg.exec.executeFlashSwap.staticCall(E(1), 0n, [good[0]]));
        await check('zero amount', 'NothingArrived', () => rg.exec.executeFlashSwap.staticCall(0n, 0n, good));
        ok(await rg.exec.FLASH_SWAP() === true, 'FLASH_SWAP version probe');
    }

    console.log('\nGas (receipt gasUsed; lenders are MOCKS — real Aave/Balancer/Morpho cost more, so these savings are a floor):');
    console.log('  cycle               flash    morpho   balancer  aave     saved vs aave');
    for (const [l, f, m, b, a] of gasRows)
        console.log(`  ${l.padEnd(18)}  ${String(f).padEnd(7)}  ${String(m).padEnd(7)}  ${String(b).padEnd(8)}  ${String(a).padEnd(7)}  ${a - f} (${(Number(a - f) * 100 / Number(a)).toFixed(1)}%)`);
} finally {
    anvil.kill();
}

console.log(fails === 0 ? '\nALL FLASH SWAP CHECKS PASS' : `\n${fails} FAILED`);
process.exit(fails ? 1 : 0);
