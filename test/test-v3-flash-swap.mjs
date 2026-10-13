// A V3 / Algebra first hop is its own flash loan (FlashArbExecutor V3_FLASH_SWAP).
//
// Sonic, 2026-10-13: every cycle whose first hop was a V3 pool borrowed its
// root from Aave and paid 0.05% — on thin edges, the whole profit — though a
// V3 swap already pays out before it collects. executeFlashSwap now takes a
// V3-kind first hop: the pool's swap sends hop 0's output, the rest of the
// cycle runs inside its swap callback, and the pool is paid from the proceeds.
//
//   1. Real v3-core pool first (V3 → V2 → V2): the same cycle from the same
//      state (evm_snapshot) through Aave and through the V3 flash swap — the
//      flash swap keeps exactly Aave's premium more, the lender is untouched,
//      and profit equals the off-chain V3 math to the wei.
//   2. V3 → V3 → V2: an ordinary V3 hop nested inside the flash callback.
//   3. Real Algebra Integral 1.1 pool first (algebraSwapCallback).
//   4. Callback safety: a callback with data when nothing is armed, a direct
//      call with forged data, an unprofitable cycle (InsufficientRepay),
//      hops[1] not fed by hop 0, hop 0 output not to the executor.
//   5. The off-chain side: cyclePremium is 0 for a V3 first hop only with
//      v3FlashSwap; CandidateExecutor (flashSwap on) funds a V3-first cycle by
//      flash swap, confirmed, realised = predicted, Aave untouched; with an
//      executor lacking V3_FLASH_SWAP it borrows from Aave instead.
//
//   npm i -D @uniswap/v3-core@1.0.1 @cryptoalgebra/integral-core@1.1.0 solc@0.8.24   (one-time)
//   node --experimental-strip-types test/test-v3-flash-swap.mjs   (anvil on PATH; own anvil on 8569)

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { ethers } from 'ethers';
import { ArbitradeDB } from '../source/util/db.ts';
import { CandidateExecutor } from '../source/orchestrator/attempt.ts';
import { getV3States, getAlgebraStates } from '../source/util/yobatches.ts';
import { cyclePremium } from '../source/util/config.ts';
import { v3_amount_out_exact } from '../source/util/calculus-v3.js';

const require = createRequire(import.meta.url);
const here = (p) => new URL(p, import.meta.url);
let fails = 0;
const ok = (c, l, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${l} ${extra}`); if (!c) fails++; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const WORK = fs.mkdtempSync('/tmp/arbitrade-v3flash-');
process.env.ARB_LEDGER = `${WORK}/ledger.sqlite`;

const ALG_HARNESS = `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
interface IAlg { function mint(address, address, int24, int24, uint128, bytes calldata) external returns (uint256, uint256, uint128);
                 function token0() external view returns (address); function token1() external view returns (address); }
interface IMintable { function mint(address, uint256) external; }
contract AlgHarness {
    function algebraMintCallback(uint256 a0, uint256 a1, bytes calldata) external {
        if (a0 > 0) IMintable(IAlg(msg.sender).token0()).mint(msg.sender, a0);
        if (a1 > 0) IMintable(IAlg(msg.sender).token1()).mint(msg.sender, a1);
    }
    function mint(address pool, int24 lo, int24 hi, uint128 amt) external { IAlg(pool).mint(address(this), address(this), lo, hi, amt, ""); }
}`;

const solc = require('solc');
const out = JSON.parse(solc.compile(JSON.stringify({
    language: 'Solidity',
    sources: {
        'FlashArbExecutor.sol': { content: fs.readFileSync(here('../contracts/FlashArbExecutor.sol'), 'utf8') },
        'YoBatches2.sol': { content: fs.readFileSync(here('../contracts/YoBatches2.sol'), 'utf8') },
        'YoBatches3.sol': { content: fs.readFileSync(here('../contracts/YoBatches3.sol'), 'utf8') },
        'Mocks.sol': { content: fs.readFileSync(here('./Mocks.sol'), 'utf8') },
        'Multicall3Min.sol': { content: fs.readFileSync(here('./Multicall3Min.sol'), 'utf8') },
        'V3Harness.sol': { content: fs.readFileSync(here('./v3-golden/V3Harness.sol'), 'utf8') },
        'AlgHarness.sol': { content: ALG_HARNESS },
    },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'shanghai', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
})));
for (const e of out.errors ?? []) if (e.severity === 'error') { console.error(e.formattedMessage); process.exit(1); }
const art = {};
for (const [, cs] of Object.entries(out.contracts)) for (const [n, c] of Object.entries(cs)) art[n] = { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object };
const v3 = n => require(`@uniswap/v3-core/artifacts/contracts/${n}.sol/${n}.json`);
const alg = n => require(`@cryptoalgebra/integral-core/artifacts/contracts/${n}.sol/${n}.json`);

const PORT = 8569, RPC_URL = `http://127.0.0.1:${PORT}`;
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
const tryErr = async (f) => { try { await f(); return ''; } catch (e) { return errName(e); } };
const arbEvent = (rc) => { for (const l of rc.logs) { try { const p = EXI.parseLog(l); if (p?.name === 'ArbExecuted') return p.args; } catch {} } return null; };
const H = (P, tokenIn, recipient, kind = 0, fee = 3000) => [P, tokenIn, fee, recipient, kind];

let db;
try {
    console.log('0. venue');
    { const mc = await deploy(art.Multicall3Min); await provider.send('anvil_setCode', ['0xcA11bde05977b3631167028862bE2a173976CA11', await provider.getCode(await mc.getAddress())]); }
    const yo = await deploy(art.YoBatches3);
    const YO = await yo.getAddress();
    const v3f = await deploy(v3('UniswapV3Factory'));
    const harness = await deploy(art.Harness);
    const tok = async (n) => { const t = await deploy(art.MockToken, n, 0); return { t, a: (await t.getAddress()) }; };
    const R = await tok('ROOT'), B = await tok('B'), C = await tok('C'), D = await tok('D');
    const v2 = async (X, Y, x, y) => {
        const p = await deploy(art.MockPair, X.a, Y.a, 30);
        const P = await p.getAddress();
        await send(X.t.mint(P, E(x), ov())); await send(Y.t.mint(P, E(y), ov())); await send(p.sync(ov()));
        return { p, P };
    };
    const v3pool = async (X, Y, fee = 500) => {
        await send(v3f.createPool(X.a, Y.a, fee, ov()));
        const P = await v3f.getPool(X.a, Y.a, fee);
        const pool = new ethers.Contract(P, v3('UniswapV3Pool').abi, w);
        await send(pool.initialize(1n << 96n, ov()));
        const t = fee === 500 ? 887270 : 887220;   // a multiple of the tier's tick spacing (10 / 60)
        await send(harness.mint(P, -t, t, E(1_000_000), ov()));
        return { p: pool, P };
    };
    // R → B on V3 at 1:1; B → C, C → R on V2 with a 5% edge on the closing pair.
    const RB = await v3pool(R, B);
    const BC = await v2(B, C, 1_000_000, 1_000_000);
    const CR = await v2(C, R, 1_000_000, 1_050_000);
    const aave = await deploy(art.MockAavePool, 5n);
    const AAVE = await aave.getAddress();
    await send(R.t.mint(AAVE, E(10_000_000), ov()));
    const exec = await deploy(art.FlashArbExecutor, AAVE);
    const EX = await exec.getAddress();
    ok(await exec.V3_FLASH_SWAP() === true, 'executor exposes V3_FLASH_SWAP');
    const IN = E(5_000);
    const fresh = await provider.send('evm_snapshot', []);   // section 5 starts from here

    console.log('\n1. V3 → V2 → V2: flash swap vs Aave, same state');
    {
        const flashHops = [H(RB.P, R.a, EX, 1, 500), H(BC.P, B.a, CR.P), H(CR.P, C.a, EX)];
        const lenderHops = [H(RB.P, R.a, BC.P, 1, 500), H(BC.P, B.a, CR.P), H(CR.P, C.a, EX)];
        // Off-chain prediction: V3 math on the pool's state, then V2.
        const st = (await getV3States(provider, YO, [RB.P], 2)).pools[0];
        const zf = R.a.toLowerCase() < B.a.toLowerCase();
        const midOut = v3_amount_out_exact(st, zf, IN);
        const [b0, b1] = await BC.p.getReserves(), [c0, c1] = await CR.p.getReserves();
        const amt = (x, rin, rout) => (x * 997n * rout) / (rin * 1000n + x * 997n);
        const bIs0 = B.a.toLowerCase() < C.a.toLowerCase();
        const cOut = amt(midOut, bIs0 ? b0 : b1, bIs0 ? b1 : b0);
        const cIs0 = C.a.toLowerCase() < R.a.toLowerCase();
        const rOut = amt(cOut, cIs0 ? c0 : c1, cIs0 ? c1 : c0);
        const predicted = rOut - IN;

        const snap = await provider.send('evm_snapshot', []);
        const rcL = await send(exec.executeArbFrom(0, AAVE, R.a, IN, 0n, lenderHops, ov()));
        const viaAave = arbEvent(rcL).profit;
        await provider.send('evm_revert', [snap]); await resync();
        const aaveBefore = await R.t.balanceOf(AAVE);
        const rcF = await send(exec.executeFlashSwap(IN, 0n, flashHops, ov()));
        const ev = arbEvent(rcF);
        ok(ev && ev.profit === predicted, 'V3 flash swap: profit = off-chain V3 + V2 math, to the wei', `${ev?.profit} vs ${predicted}`);
        ok(ev && ev.profit - viaAave === (IN * 5n) / 10_000n, 'keeps exactly Aave\'s 0.05% premium more', `flash ${ev?.profit} vs aave ${viaAave}`);
        ok(ev && ev.premium === 0n && (await R.t.balanceOf(AAVE)) === aaveBefore, 'no lender involved');
        console.log(`      gas: flash swap ${rcF.gasUsed} vs Aave ${rcL.gasUsed}`);
    }

    console.log('\n2. V3 → V3 → V2: an ordinary V3 hop inside the flash callback');
    {
        const BD = await v3pool(B, D, 3000);
        const DR = await v2(D, R, 1_000_000, 1_060_000);
        const hops = [H(RB.P, R.a, EX, 1, 500), H(BD.P, B.a, DR.P, 1, 3000), H(DR.P, D.a, EX)];
        const rc = await send(exec.executeFlashSwap(E(2_000), 0n, hops, ov()));
        const ev = arbEvent(rc);
        ok(ev && ev.profit > 0n, 'confirmed with a nested V3 hop', `profit ${ev ? ethers.formatEther(ev.profit) : '-'}`);
    }

    console.log('\n3. Algebra Integral 1.1 first hop');
    {
        const n0 = await provider.getTransactionCount(w.address);
        const fac = await deploy(alg('AlgebraFactory'), ethers.getCreateAddress({ from: w.address, nonce: n0 + 1 }));
        await deploy(alg('AlgebraPoolDeployer'), await fac.getAddress());
        const ah = await deploy(art.AlgHarness);
        const E2 = await tok('E2');
        await send(fac.createPool(R.a, E2.a, ov()));
        const AP = await fac.poolByPair(R.a, E2.a);
        const apool = new ethers.Contract(AP, alg('AlgebraPool').abi, w);
        await send(apool.initialize(1n << 96n, ov()));
        const sp = Number(await apool.tickSpacing());
        await send(ah.mint(AP, -Math.floor(887272 / sp) * sp, Math.floor(887272 / sp) * sp, E(1_000_000), ov()));
        const ER = await v2(E2, R, 1_000_000, 1_050_000);
        const st = (await getAlgebraStates(provider, YO, [AP], 2)).pools[0];
        const zf = R.a.toLowerCase() < E2.a.toLowerCase();
        const mid = v3_amount_out_exact(st, zf, IN);
        const [e0, e1] = await ER.p.getReserves();
        const eIs0 = E2.a.toLowerCase() < R.a.toLowerCase();
        const predicted = (mid * 997n * (eIs0 ? e1 : e0)) / ((eIs0 ? e0 : e1) * 1000n + mid * 997n) - IN;
        const rc = await send(exec.executeFlashSwap(IN, 0n, [H(AP, R.a, EX, 1, 500), H(ER.P, E2.a, EX)], ov()));
        const ev = arbEvent(rc);
        ok(ev && ev.profit === predicted, 'Algebra pool as the loan: profit = prediction to the wei', `${ev?.profit} vs ${predicted}`);
    }

    console.log('\n4. callback safety and bad inputs');
    {
        const fake = ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [1]);
        ok(await tryErr(() => exec.uniswapV3SwapCallback.staticCall(E(1), 0, fake)) === 'NotPool', 'callback with data, nothing armed → NotPool');
        ok(await tryErr(() => exec.algebraSwapCallback.staticCall(E(1), 0, fake)) === 'NotPool', 'algebra spelling too');
        ok(await tryErr(() => exec.uniswapV3SwapCallback.staticCall(E(1), 0, '0x')) === 'NotPool', 'empty data, nothing armed → NotPool');
        const flatC = await v2(C, R, 1_000_000, 1_000_000);   // no edge
        ok(await tryErr(() => exec.executeFlashSwap.staticCall(IN, 0n, [H(RB.P, R.a, EX, 1, 500), H(BC.P, B.a, flatC.P), H(flatC.P, C.a, EX)])) === 'InsufficientRepay',
            'unprofitable → InsufficientRepay (the pool is never paid short)');
        ok(await tryErr(() => exec.executeFlashSwap.staticCall(IN, 0n, [H(RB.P, R.a, EX, 1, 500), H(CR.P, C.a, EX)])) === 'TokenNotInPair',
            'hops[1] not fed by hop 0 → TokenNotInPair');
        ok(await tryErr(() => exec.executeFlashSwap.staticCall(IN, 0n, [H(RB.P, R.a, BC.P, 1, 500), H(BC.P, B.a, CR.P), H(CR.P, C.a, EX)])) === 'BadRecipient',
            'hop 0 output not to the executor → BadRecipient');
        ok(await tryErr(() => exec.executeFlashSwap.staticCall(IN, E(1_000_000), [H(RB.P, R.a, EX, 1, 500), H(BC.P, B.a, CR.P), H(CR.P, C.a, EX)])) === 'InsufficientRepay',
            'minProfit enforced');
    }

    console.log('\n5. off-chain: scoring and the attempt path');
    {
        await provider.send('evm_revert', [fresh]); await resync();   // the edge as section 1 found it
        const flashCfg = { flashloan: { provider: 'aave-v3', pool: AAVE, premium: 0.0005, flashSwap: true, tokens: [{ symbol: 'ROOT', address: R.a, decimals: 18 }] } };
        ok(cyclePremium(flashCfg, R.a, { kind: 'v3' }) === 0.0005, 'cyclePremium: V3 first hop pays the premium without v3FlashSwap');
        ok(cyclePremium(flashCfg, R.a, { kind: 'v3' }, false, true) === 0, '… and 0 with it');

        db = new ArbitradeDB(`${WORK}/v3f.sqlite`);
        const V2F = '0x00000000000000000000000000000000000f4c70', V3F = (await v3f.getAddress()).toLowerCase();
        const lc = (x) => x.toLowerCase();
        const tok01 = (x, y) => (lc(x) < lc(y) ? [lc(x), lc(y)] : [lc(y), lc(x)]);
        const [rb0, rb1] = tok01(R.a, B.a), [bc0, bc1] = tok01(B.a, C.a), [cr0, cr1] = tok01(C.a, R.a);
        db.insertPairs([
            { address: lc(RB.P), factory: V3F, token0: rb0, token1: rb1, blockNumber: 1, kind: 'v3', clVariant: 'univ3' },
            { address: lc(BC.P), factory: V2F, token0: bc0, token1: bc1, blockNumber: 1 },
            { address: lc(CR.P), factory: V2F, token0: cr0, token1: cr1, blockNumber: 1 },
        ]);
        const cfg = {
            raw: {},
            chain: { name: 'Anvil', label: 'anvil', id: 31337, host: RPC_URL, token: R.a, executor: EX, contract: YO },
            factories: [{ address: V2F, fee: 0.003, group: 'v2' }, { address: V3F, group: 'v3', callback: 'uniswapV3SwapCallback' }],
            flashloan: flashCfg.flashloan,
            evaluator: { minProfitTokens: 0.01, minLiquidityTokens: 1, minInputTokens: 0.1 },
            scan: {},
        };
        const pricing = { [lc(R.a)]: { symbol: 'ROOT', priceInNumeraire: 1, sourceLiquidity: 1e24, minProfitInRootTokens: 0.01, minInputInRootTokens: 0.1 } };
        const exOpts = { ownerAddress: w.address, live: true, signer: w, gasMarginMultiple: 1, minProfitTokens: 0.01, gasPriceMaxAgeMs: 1 };
        const cand = {
            triangleId: 1, rootToken: lc(R.a), hopCount: 3, direction: 'forward', inputAmount: 3_000e18, grossProfit: 1, netProfit: 1,
            hops: [
                { pair: lc(RB.P), factory: V3F, tokenIn: lc(R.a), tokenOut: lc(B.a), fee: 0.0005, kind: 'v3' },
                { pair: lc(BC.P), factory: V2F, tokenIn: lc(B.a), tokenOut: lc(C.a), fee: 0.003, kind: 'v2' },
                { pair: lc(CR.P), factory: V2F, tokenIn: lc(C.a), tokenOut: lc(R.a), fee: 0.003, kind: 'v2' },
            ],
        };
        const ex = new CandidateExecutor(cfg, provider, pricing, exOpts);
        ok(await ex.supportsV3FlashSwap(), 'CandidateExecutor sees V3_FLASH_SWAP');
        const aaveBefore = await R.t.balanceOf(AAVE);
        const a = await ex.attempt(cand, db); await resync();
        ok(a.confirmed && a.funding === 'flash-swap', 'V3-first cycle funded by flash swap and CONFIRMED', a.confirmed ? `${a.funding} ${a.txHash}` : (a.simulationError ?? 'not built'));
        if (a.confirmed) {
            ok(a.built.flashFee === 0n && a.realisedProfit === a.built.expectedProfit, 'realised = predicted, no fee', `${a.realisedProfit} vs ${a.built.expectedProfit}`);
            ok((await R.t.balanceOf(AAVE)) === aaveBefore, 'Aave untouched');
        }
        const ex2 = new CandidateExecutor(cfg, provider, pricing, { ...exOpts, live: false });
        await ex2.supportsV3();
        ex2.executorHasV3Flash = false;   // an executor deployed before V3_FLASH_SWAP
        const b = await ex2.attempt(cand, db);
        ok(b.funding === 'aave-v3' && b.built?.flashFee > 0n, 'without V3_FLASH_SWAP: borrows from Aave and the prediction carries its fee',
            `${b.funding ?? b.simulationError} fee ${b.built?.flashFee}`);
    }
} catch (e) {
    console.error(e); fails++;
} finally {
    try { db?.close(); } catch {}
    provider.destroy();
    anvil.kill();
    fs.rmSync(WORK, { recursive: true, force: true });
}
console.log(fails === 0 ? '\nALL V3 FLASH SWAP CHECKS PASS' : `\n${fails} FAILED`);
process.exit(fails ? 1 : 0);
