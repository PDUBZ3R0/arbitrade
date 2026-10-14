// A V3 pool that renamed its swap callback is still tradeable
// (FlashArbExecutor V3_ANY_CALLBACK) — and the verifier finds the name by
// making a pool call back, not by knowing it in advance.
//
// Sonic, 2026-10-13: find-factories rejected NineMMV3Factory (148 pools) and
// ZFV3Factory (40 pools), PancakeV3 forks, with "No known swap-callback
// selector": their pools call back under a name of their own. Every such
// callback passes (int256 amount0Delta, int256 amount1Delta, bytes data).
//
// The renamed pool here is the real v3-core pool with its callback selector
// rewritten in the factory's embedded pool code — exactly what a fork does.
//
//   1. executor exposes V3_ANY_CALLBACK; CandidateExecutor sees it.
//   2. ordinary V3 hop through the renamed pool (Aave-funded V2 → V3 → V2).
//   3. renamed pool as the V3 flash swap's loan: same profit, to the wei, as
//      an identically-seeded uniswapV3SwapCallback pool.
//   4. fallback safety: renamed selector from a stranger with empty / forged
//      data, a V2-shaped forged call, short calldata — all NotPool.
//   5. verifier: measureSwapCallback on the renamed pool → its selector
//      (V3-shaped, name unknown); on the real pool → uniswapV3SwapCallback;
//      on a pull-model pool (transferFrom, no callback) → not usable, with why.
//   6. find-factories: an unknown-name callback is addable, with a note.
//
//   npm i -D @uniswap/v3-core@1.0.1 solc@0.8.24   (one-time)
//   node --experimental-strip-types test/test-any-callback.mjs   (anvil on PATH; own anvil on 8570)

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { ethers } from 'ethers';
import { measureSwapCallback } from '../source/util/verify-v3-factory.ts';
import { proposeEntry } from '../source/util/find-factories.ts';
import { CandidateExecutor } from '../source/orchestrator/attempt.ts';

const require = createRequire(import.meta.url);
const here = (p) => new URL(p, import.meta.url);
let fails = 0;
const ok = (c, l, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${l} ${extra}`); if (!c) fails++; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const PULL_POOL = `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
interface ITok { function transferFrom(address, address, uint256) external returns (bool); }
/// Solidly-V3-style: swap() pulls the input with transferFrom; no callback.
contract PullPool {
    address public token0; address public token1;
    constructor(address a, address b) { token0 = a; token1 = b; }
    function swap(address, bool zf, int256 amt, uint160, bytes calldata) external returns (int256, int256) {
        ITok(zf ? token0 : token1).transferFrom(msg.sender, address(this), uint256(amt));
        return (amt, 0);
    }
}`;

const solc = require('solc');
const out = JSON.parse(solc.compile(JSON.stringify({
    language: 'Solidity',
    sources: {
        'FlashArbExecutor.sol': { content: fs.readFileSync(here('../contracts/FlashArbExecutor.sol'), 'utf8') },
        'Mocks.sol': { content: fs.readFileSync(here('./Mocks.sol'), 'utf8') },
        'V3Harness.sol': { content: fs.readFileSync(here('./v3-golden/V3Harness.sol'), 'utf8') },
        'PullPool.sol': { content: PULL_POOL },
    },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'shanghai', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
})));
for (const e of out.errors ?? []) if (e.severity === 'error') { console.error(e.formattedMessage); process.exit(1); }
const art = {};
for (const [, cs] of Object.entries(out.contracts)) for (const [n, c] of Object.entries(cs)) art[n] = { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object };
const v3 = n => require(`@uniswap/v3-core/artifacts/contracts/${n}.sol/${n}.json`);

// The fork: same factory, swap-callback selector renamed.
const UNI_SEL = ethers.id('uniswapV3SwapCallback(int256,int256,bytes)').slice(2, 10);
const ZF_SIG = 'zfV3SwapCallback(int256,int256,bytes)';
const ZF_SEL = ethers.id(ZF_SIG).slice(2, 10);
const uniFactory = v3('UniswapV3Factory');
const zfBytecode = uniFactory.bytecode.split('63' + UNI_SEL).join('63' + ZF_SEL);

const PORT = 8570, RPC_URL = `http://127.0.0.1:${PORT}`;
const anvil = spawn('anvil', ['--port', String(PORT), '--disable-code-size-limit', '--gas-limit', '3000000000', '--silent']);
await sleep(1500);
const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { cacheTimeout: -1, staticNetwork: true });
const w = new ethers.Wallet('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', provider);
let nonce = await provider.getTransactionCount(w.address);
const ov = () => ({ nonce: nonce++, gasLimit: 30_000_000n });
const resync = async () => { nonce = await provider.getTransactionCount(w.address); };
const deploy = async (a, ...args) => { const c = await new ethers.ContractFactory(a.abi, a.bytecode, w).deploy(...args, ov()); await c.waitForDeployment(); return c; };
const send = async (p) => (await p).wait();
const E = (n) => BigInt(Math.round(n)) * 10n ** 18n;
const EXI = new ethers.Interface(art.FlashArbExecutor.abi);
const errName = (e) => {
    for (const d of [e?.data, e?.info?.error?.data, e?.error?.data, e?.revert?.data]) {
        if (typeof d === 'string' && d.length >= 10) { try { const p = EXI.parseError(d); if (p) return p.name; } catch {} }
    }
    return String(e?.shortMessage ?? e?.message ?? e).slice(0, 90);
};
const arbEvent = (rc) => { for (const l of rc.logs) { try { const p = EXI.parseLog(l); if (p?.name === 'ArbExecuted') return p.args; } catch {} } return null; };
const H = (P, tokenIn, recipient, kind = 0, fee = 3000) => [P, tokenIn, fee, recipient, kind];
const rawCall = async (to, data) => { try { await provider.call({ to, data, from: w.address }); return ''; } catch (e) { return errName(e); } };

try {
    console.log('0. venue');
    ok(zfBytecode !== uniFactory.bytecode && !zfBytecode.includes('63' + UNI_SEL), `renamed factory: ${uniFactory.bytecode.split('63' + UNI_SEL).length - 1} PUSH4 site(s) rewritten to ${ZF_SIG}`);
    const uniF = await deploy(uniFactory);
    const zfF = await deploy({ abi: uniFactory.abi, bytecode: zfBytecode });
    const harness = await deploy(art.Harness);
    const tok = async (n) => { const t = await deploy(art.MockToken, n, 0); return { t, a: (await t.getAddress()) }; };
    const R = await tok('ROOT'), B = await tok('B'), C = await tok('C');
    const v2 = async (X, Y, x, y) => {
        const p = await deploy(art.MockPair, X.a, Y.a, 30);
        const P = await p.getAddress();
        await send(X.t.mint(P, E(x), ov())); await send(Y.t.mint(P, E(y), ov())); await send(p.sync(ov()));
        return { p, P };
    };
    const v3pool = async (fac, X, Y, fee = 500) => {
        await send(fac.createPool(X.a, Y.a, fee, ov()));
        const P = await fac.getPool(X.a, Y.a, fee);
        const pool = new ethers.Contract(P, v3('UniswapV3Pool').abi, w);
        await send(pool.initialize(1n << 96n, ov()));
        await send(harness.mint(P, -887270, 887270, E(1_000_000), ov()));
        return { p: pool, P };
    };
    const uniRB = await v3pool(uniF, R, B);
    const zfRB = await v3pool(zfF, R, B);
    const zfBC = await v3pool(zfF, B, C);
    const BC = await v2(B, C, 1_000_000, 1_000_000);
    const CR = await v2(C, R, 1_000_000, 1_050_000);
    const RBv2 = await v2(R, B, 1_000_000, 1_000_000);
    const aave = await deploy(art.MockAavePool, 5n);
    const AAVE = await aave.getAddress();
    await send(R.t.mint(AAVE, E(10_000_000), ov()));
    const exec = await deploy(art.FlashArbExecutor, AAVE);
    const EX = await exec.getAddress();
    const IN = E(5_000);

    console.log('\n1. version probe');
    ok(await exec.V3_ANY_CALLBACK() === true, 'executor exposes V3_ANY_CALLBACK');
    {
        const ce = Object.create(CandidateExecutor.prototype);
        ce.cfg = { chain: { executor: EX, name: 'anvil', label: 'anvil' } };
        ce.provider = provider;
        ce.executorVersionError = undefined;
        await ce.checkExecutorVersion();
        ok(ce.executorHasAnyCallback === true, 'CandidateExecutor detects it from the bytecode');
    }

    console.log('\n2. ordinary V3 hop through the renamed pool (Aave: V2 → zf V3 → V2)');
    {
        const snap = await provider.send('evm_snapshot', []);
        const hops = [H(RBv2.P, R.a, EX), H(zfBC.P, B.a, CR.P, 1, 500), H(CR.P, C.a, EX)];
        let rc = null, err = '';
        try { rc = await send(exec.executeArbFrom(0, AAVE, R.a, IN, 0n, hops, ov())); } catch (e) { err = errName(e); await resync(); }
        const ev = rc && arbEvent(rc);
        ok(ev && ev.profit > 0n, 'confirmed: the pool called zfV3SwapCallback and was paid', ev ? `profit ${ethers.formatEther(ev.profit)}` : err);
        await provider.send('evm_revert', [snap]); await resync();
    }

    console.log('\n3. renamed pool as the V3 flash swap\'s loan');
    {
        const snap = await provider.send('evm_snapshot', []);
        const rcU = await send(exec.executeFlashSwap(IN, 0n, [H(uniRB.P, R.a, EX, 1, 500), H(BC.P, B.a, CR.P), H(CR.P, C.a, EX)], ov()));
        const pU = arbEvent(rcU)?.profit;
        await provider.send('evm_revert', [snap]); await resync();
        let rcZ = null, err = '';
        try { rcZ = await send(exec.executeFlashSwap(IN, 0n, [H(zfRB.P, R.a, EX, 1, 500), H(BC.P, B.a, CR.P), H(CR.P, C.a, EX)], ov())); } catch (e) { err = errName(e); await resync(); }
        const pZ = rcZ && arbEvent(rcZ)?.profit;
        ok(pZ != null && pZ === pU, 'same profit as the uniswapV3SwapCallback pool, to the wei', `${pZ ?? err} vs ${pU}`);
        if (rcZ) console.log(`      gas: renamed ${rcZ.gasUsed} vs named ${rcU.gasUsed}`);
    }

    console.log('\n4. fallback safety');
    {
        const coder = ethers.AbiCoder.defaultAbiCoder();
        const zf = (a0, a1, d) => '0x' + ZF_SEL + coder.encode(['int256', 'int256', 'bytes'], [a0, a1, d]).slice(2);
        ok(await rawCall(EX, zf(E(1), 0, '0x')) === 'NotPool', 'renamed callback, empty data, nothing armed → NotPool');
        ok(await rawCall(EX, zf(E(1), 0, coder.encode(['uint256'], [1]))) === 'NotPool', 'renamed callback, forged data → NotPool');
        const v2shape = '0x' + ethers.id('BiswapCall(address,uint256,uint256,bytes)').slice(2, 10) + coder.encode(['address', 'uint256', 'uint256', 'bytes'], [EX, E(1), 0, '0x01']).slice(2);
        ok(await rawCall(EX, v2shape) === 'NotPool', 'V2-shaped forged call (sender = executor) → NotPool');
        ok(await rawCall(EX, '0x' + ZF_SEL + '00'.repeat(40)) === 'NotPool', 'short calldata → NotPool');
        const held = await R.t.balanceOf(EX);
        await provider.send('anvil_impersonateAccount', [zfRB.P]);
        await provider.send('anvil_setBalance', [zfRB.P, '0x' + (10n ** 18n).toString(16)]);
        let stolen = '';
        try { await provider.call({ from: zfRB.P, to: EX, data: zf(E(1), 0, '0x') }); } catch (e) { stolen = errName(e); }
        ok(stolen === 'NotPool', 'a real pool calling back outside a swap (nothing armed) → NotPool; the executor\'s profit stays', `holds ${ethers.formatEther(held)} ROOT`);
    }

    console.log('\n5. verifier: measure the callback');
    {
        const mz = await measureSwapCallback(provider, zfRB.P);
        ok(mz.ok && mz.selector === ZF_SEL && !mz.known && mz.name === '0x' + ZF_SEL, 'renamed pool → its selector, V3-shaped, name unknown', JSON.stringify(mz));
        const mu = await measureSwapCallback(provider, uniRB.P);
        ok(mu.ok && mu.name === 'uniswapV3SwapCallback' && mu.known, 'v3-core pool → uniswapV3SwapCallback', JSON.stringify(mu));
        const pull = await deploy(art.PullPool, R.a, B.a);
        const mp = await measureSwapCallback(provider, await pull.getAddress());
        ok(!mp.ok && /allowance/.test(mp.why), 'pull-model pool → not usable, says why', JSON.stringify(mp));
    }

    console.log('\n6. find-factories: an unknown-name callback is addable');
    {
        const r = { family: 'v3', feesSeen: [500], spacingsSeen: [10], poolEvent: 'uniswap', callback: '0x' + ZF_SEL, deployBlock: 1, algebraVariant: null };
        const p = proposeEntry({ address: '0x924aee39' + '00'.repeat(16) }, 'ZF', r, null, false);
        ok(p.addable && p.proposed.entry.callback === '0x' + ZF_SEL && /V3_ANY_CALLBACK/.test(p.proposed.basis), 'addable, entry keeps the selector, basis notes the executor need', p.proposed.basis);
    }
} finally {
    anvil.kill();
}

console.log(fails === 0 ? '\nALL ANY-CALLBACK CHECKS PASS' : `\n${fails} FAILED`);
process.exit(fails ? 1 : 0);
