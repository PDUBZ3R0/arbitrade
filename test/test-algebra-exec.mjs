// Algebra pools end to end, against the REAL Algebra Integral 1.1 pool
// (@cryptoalgebra/integral-core 1.1.0 — the version SwapX and Atlantis run on
// Sonic), on anvil.
//
//   1. YoBatches3.getAlgebraState reads the pool exactly (price, tick, fee,
//      liquidity, tick spacing), and getV3State — the Uniswap reader the hot
//      loop used for every CL pool — cannot (null): why Algebra cycles all
//      "decayed" before.
//   2. The off-chain swap math (calculus-v3) on that state equals the pool's
//      own swap() to the wei, both directions, small to tick-crossing sizes.
//   3. The pool's Swap/Mint/Burn topics are the Uniswap V3 ones the feed
//      already watches; Fee/TickSpacing topics are the watched constants.
//   4. A ROOT → B (V2) → C (Algebra) → ROOT (V2) cycle trades through the real
//      CandidateExecutor and FlashArbExecutor's algebraSwapCallback: build-hops
//      reads the pool with getAlgebraState, the trade CONFIRMS, and realised
//      profit equals the prediction (net of the premium) within one wei.
//   5. An executor without algebraSwapCallback refuses the cycle off-chain,
//      with the redeploy hint — no gas spent finding out.
//
//   npm i -D @cryptoalgebra/integral-core@1.1.0 solc@0.8.24   (one-time)
//   node --experimental-strip-types test/test-algebra-exec.mjs (anvil on PATH; own anvil on 8568)

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { ethers } from 'ethers';
import { ArbitradeDB } from '../source/util/db.ts';
import { CandidateExecutor } from '../source/orchestrator/attempt.ts';
import { getV3States, getAlgebraStates } from '../source/util/yobatches.ts';
import { virtualReserves } from '../source/reserves/v3-state.ts';
import { v3_amount_out_exact, MIN_SQRT_RATIO, MAX_SQRT_RATIO } from '../source/util/calculus-v3.js';
import { V3_SWAP_TOPIC, V3_MINT_TOPIC, ALGEBRA_FEE_TOPIC, ALGEBRA_TICKSPACING_TOPIC, V3_POOL_TOPICS } from '../source/orchestrator/sync-watcher.ts';

const require = createRequire(import.meta.url);
const here = (p) => new URL(p, import.meta.url);
let fails = 0;
const ok = (c, l, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${l} ${extra}`); if (!c) fails++; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const WORK = fs.mkdtempSync('/tmp/arbitrade-algebra-');
process.env.ARB_LEDGER = `${WORK}/ledger.sqlite`;

const HARNESS = `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
interface IAlg {
    function mint(address, address, int24, int24, uint128, bytes calldata) external returns (uint256, uint256, uint128);
    function swap(address, bool, int256, uint160, bytes calldata) external returns (int256, int256);
    function token0() external view returns (address);
    function token1() external view returns (address);
}
interface IMintable { function mint(address, uint256) external; }
contract AlgHarness {
    function pay(address pool, int256 a0, int256 a1) internal {
        if (a0 > 0) IMintable(IAlg(pool).token0()).mint(pool, uint256(a0));
        if (a1 > 0) IMintable(IAlg(pool).token1()).mint(pool, uint256(a1));
    }
    function algebraMintCallback(uint256 a0, uint256 a1, bytes calldata) external { pay(msg.sender, int256(a0), int256(a1)); }
    function algebraSwapCallback(int256 a0, int256 a1, bytes calldata) external { pay(msg.sender, a0, a1); }
    function mint(address pool, int24 lo, int24 hi, uint128 amt) external { IAlg(pool).mint(address(this), address(this), lo, hi, amt, ""); }
    function swap(address pool, bool z, int256 amt, uint160 lim) external returns (int256, int256) { return IAlg(pool).swap(address(this), z, amt, lim, ""); }
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
        'AlgHarness.sol': { content: HARNESS },
    },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'shanghai', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
})));
for (const e of out.errors ?? []) if (e.severity === 'error') { console.error(e.formattedMessage); process.exit(1); }
const art = {};
for (const [, cs] of Object.entries(out.contracts)) for (const [n, c] of Object.entries(cs)) art[n] = { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object };
const alg = n => require(`@cryptoalgebra/integral-core/artifacts/contracts/${n}.sol/${n}.json`);

const PORT = 8568, RPC_URL = `http://127.0.0.1:${PORT}`;
const anvil = spawn('anvil', ['--port', String(PORT), '--disable-code-size-limit', '--gas-limit', '3000000000', '--silent']);
await sleep(1500);
const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { cacheTimeout: -1, staticNetwork: true });
const w = new ethers.Wallet('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', provider);
const send = async (p) => (await p).wait();
const deploy = async (a, ...args) => { const c = await new ethers.ContractFactory(a.abi, a.bytecode, w).deploy(...args); await c.waitForDeployment(); return c; };
const E = (n) => BigInt(Math.round(n)) * 10n ** 18n;

let db;
try {
    console.log('0. venue: a real Algebra Integral 1.1 factory, deployer and pool');
    { const mc = await deploy(art.Multicall3Min); await provider.send('anvil_setCode', ['0xcA11bde05977b3631167028862bE2a173976CA11', await provider.getCode(await mc.getAddress())]); }
    const yo = await deploy(art.YoBatches3);
    const YO = await yo.getAddress();
    // Factory and deployer reference each other: predict the deployer's address.
    const n0 = await provider.getTransactionCount(w.address);
    const predictedDeployer = ethers.getCreateAddress({ from: w.address, nonce: n0 + 1 });
    const factory = await deploy(alg('AlgebraFactory'), predictedDeployer);
    const deployer = await deploy(alg('AlgebraPoolDeployer'), await factory.getAddress());
    ok((await deployer.getAddress()) === predictedDeployer, 'factory ↔ deployer wired');
    const harness = await deploy(art.AlgHarness);

    const tRoot = await deploy(art.MockToken, 'ROOT', 0), tB = await deploy(art.MockToken, 'B', 0), tC = await deploy(art.MockToken, 'C', 0);
    const [ROOT, B, C] = await Promise.all([tRoot, tB, tC].map(t => t.getAddress()));
    const pAB = await deploy(art.MockPair, ROOT, B, 30), pCA = await deploy(art.MockPair, C, ROOT, 30);
    const [AB, CA] = await Promise.all([pAB, pCA].map(p => p.getAddress()));
    for (const [t, p] of [[tRoot, AB], [tB, AB], [tC, CA], [tRoot, CA]]) await send(t.mint(p, E(1_000_000)));
    await send(pAB.sync()); await send(pCA.sync());

    await send(factory.createPool(B, C));
    const BCaddr = await factory.poolByPair(B, C);
    const pool = new ethers.Contract(BCaddr, alg('AlgebraPool').abi, w);
    await send(pool.initialize(1n << 96n));
    const spacing = Number(await pool.tickSpacing());
    const full = Math.floor(887272 / spacing) * spacing;
    const rcMint = await send(harness.mint(BCaddr, -full, full, E(1_000_000)));
    await send(harness.mint(BCaddr, -spacing * 10, spacing * 10, E(2_000_000)));   // a narrow position: big swaps cross its ticks
    const BC = BCaddr.toLowerCase();
    const t0 = (await pool.token0()).toLowerCase();
    ok(Number(await pool.fee()) > 0, `pool live: fee ${await pool.fee()} pips, tick spacing ${spacing}`);

    console.log('\n1. reading the pool');
    const uniRead = await getV3States(provider, YO, [BC], 2);
    ok(uniRead.pools[0] == null, 'the Uniswap reader (getV3State) cannot read it — the hot loop saw every Algebra pool as dead');
    const st = (await getAlgebraStates(provider, YO, [BC], 2)).pools[0];
    const gs = await pool.globalState();
    ok(st && st.sqrtPriceX96 === gs[0] && st.tick === Number(gs[1]) && st.fee === Number(await pool.fee())
        && st.liquidity === await pool.liquidity() && st.tickSpacing === spacing,
        'getAlgebraState: price, tick, fee, liquidity, tick spacing all match the pool', st ? `(fee ${st.fee}, ${st.ticks.length} ticks in window)` : '(null)');

    console.log('\n2. off-chain math = the pool\'s swap(), to the wei');
    for (const [zf, amt] of [[true, E(1)], [false, E(1)], [true, E(5_000)], [false, E(50_000)], [true, E(400_000)], [false, E(900_000)]]) {
        const s = (await getAlgebraStates(provider, YO, [BC], 4)).pools[0];
        const predicted = v3_amount_out_exact(s, zf, amt);
        const [a0, a1] = await harness.swap.staticCall(BCaddr, zf, amt, zf ? MIN_SQRT_RATIO + 1n : MAX_SQRT_RATIO - 1n);
        const actual = -(zf ? a1 : a0);
        ok(predicted === actual && predicted > 0n, `${zf ? '0→1' : '1→0'} ${ethers.formatEther(amt)} in`, `predicted ${predicted} vs pool ${actual}`);
    }

    console.log('\n3. events the feed watches');
    const rcSwap = await send(harness.swap(BCaddr, true, E(10), MIN_SQRT_RATIO + 1n));
    const topicsOf = (rc) => rc.logs.filter(l => l.address.toLowerCase() === BC).map(l => l.topics[0]);
    ok(topicsOf(rcSwap).includes(V3_SWAP_TOPIC), 'the Algebra pool\'s Swap topic is the Uniswap V3 one (already watched)');
    ok(topicsOf(rcMint).includes(V3_MINT_TOPIC), 'its Mint topic too');
    const iface = new ethers.Interface(alg('AlgebraPool').abi);
    ok(iface.getEvent('Fee').topicHash === ALGEBRA_FEE_TOPIC && iface.getEvent('TickSpacing').topicHash === ALGEBRA_TICKSPACING_TOPIC
        && V3_POOL_TOPICS.includes(ALGEBRA_FEE_TOPIC) && V3_POOL_TOPICS.includes(ALGEBRA_TICKSPACING_TOPIC),
        'Fee / TickSpacing topics match the pool ABI and are watched');
    ok(iface.getEvent('Burn').topicHash === V3_POOL_TOPICS[3], 'Burn topic is the Uniswap V3 one');

    console.log('\n4. a cycle through the Algebra pool trades');
    const aave = await deploy(art.MockAavePool, 5n);
    const POOL = await aave.getAddress();
    await send(tRoot.mint(POOL, E(10_000_000)));
    const exec = await deploy(art.FlashArbExecutor, POOL);
    const EXEC = await exec.getAddress();
    // Make C cheap in the Algebra pool: sell C into it.
    const cIsZero = t0 === C.toLowerCase();
    await send(harness.swap(BCaddr, cIsZero, E(60_000), cIsZero ? MIN_SQRT_RATIO + 1n : MAX_SQRT_RATIO - 1n));

    db = new ArbitradeDB(`${WORK}/alg.sqlite`);
    const V2F = '0x00000000000000000000000000000000000f4c70';
    const ALF = (await factory.getAddress()).toLowerCase();
    // build-hops takes token order from the pairs table, as after a scan.
    db.insertPairs([
        { address: AB.toLowerCase(), factory: V2F, token0: (await pAB.token0()).toLowerCase(), token1: (await pAB.token1()).toLowerCase(), blockNumber: 1 },
        { address: CA.toLowerCase(), factory: V2F, token0: (await pCA.token0()).toLowerCase(), token1: (await pCA.token1()).toLowerCase(), blockNumber: 1 },
        { address: BC, factory: ALF, token0: t0, token1: (await pool.token1()).toLowerCase(), blockNumber: 1, kind: 'v3', clVariant: 'algebra-integral' },
    ]);
    const cfg = {
        raw: {},
        chain: { name: 'Anvil', label: 'anvil', id: 31337, host: RPC_URL, token: ROOT, executor: EXEC, contract: YO },
        factories: [{ address: V2F, fee: 0.003, group: 'v2' }, { address: ALF, group: 'algebra' }],
        flashloan: { provider: 'aave-v3', pool: POOL, premium: 0.0005, tokens: [{ symbol: 'ROOT', address: ROOT, decimals: 18 }] },
        evaluator: { minProfitTokens: 0.01, minLiquidityTokens: 1, minInputTokens: 0.1 },
        scan: {},
    };
    const pricing = { [ROOT.toLowerCase()]: { symbol: 'ROOT', priceInNumeraire: 1, sourceLiquidity: 1e24, minProfitInRootTokens: 0.01, minInputInRootTokens: 0.1 } };
    const exOpts = { ownerAddress: w.address, live: true, signer: w, gasMarginMultiple: 1, minProfitTokens: 0.01, gasPriceMaxAgeMs: 1 };
    // C is cheap in the Algebra pool: buy it there with B, sell it to the V2 pair: ROOT → B → C → ROOT.
    const poolFee = Number(await pool.fee()) / 1e6;
    const cand = (input) => ({
        triangleId: 1, rootToken: ROOT.toLowerCase(), hopCount: 3, direction: 'forward', inputAmount: input, grossProfit: 1, netProfit: 1,
        hops: [
            { pair: AB.toLowerCase(), factory: V2F, tokenIn: ROOT.toLowerCase(), tokenOut: B.toLowerCase(), fee: 0.003, kind: 'v2' },
            { pair: BC, factory: ALF, tokenIn: B.toLowerCase(), tokenOut: C.toLowerCase(), fee: poolFee, kind: 'v3' },
            { pair: CA.toLowerCase(), factory: V2F, tokenIn: C.toLowerCase(), tokenOut: ROOT.toLowerCase(), fee: 0.003, kind: 'v2' },
        ],
    });
    const ex = new CandidateExecutor(cfg, provider, pricing, exOpts);
    ok(await ex.supportsAlgebra(), 'CandidateExecutor sees algebraSwapCallback on the executor');
    const a = await ex.attempt(cand(5_000e18), db);
    ok(a.confirmed, 'the trade CONFIRMED on-chain through the Algebra pool', a.confirmed ? a.txHash : (a.simulationError ?? (a.built ? 'built but not confirmed' : 'edge decayed (build returned null)')));
    if (a.confirmed) {
        ok(a.built.hops[1].kind === 1 && a.built.hops[1].pair.toLowerCase() === BC, 'routed as a V3-kind hop');
        const d = a.realisedProfit - a.built.expectedProfit;
        ok(d >= 0n && d <= 1n, 'realised profit = prediction (net of the premium) within one wei', `${a.realisedProfit} vs ${a.built.expectedProfit}`);
    }

    console.log('\n5. an executor without algebraSwapCallback is refused off-chain');
    {
        const ex2 = new CandidateExecutor(cfg, provider, pricing, { ...exOpts, live: false });
        await ex2.supportsV3();
        ex2.executorHasAlgebra = false;   // as an executor deployed before the callback existed
        const r = await ex2.attempt(cand(5_000e18), db);
        ok(/predates algebraSwapCallback — yarn deploy flasharb anvil/.test(r.simulationError ?? '') && r.gasEstimate == null,
            'refused before any gas estimate', r.simulationError?.slice(0, 120));
    }
} catch (e) {
    console.error(e); fails++;
} finally {
    try { db?.close(); } catch {}
    provider.destroy();
    anvil.kill();
    fs.rmSync(WORK, { recursive: true, force: true });
}
console.log(fails === 0 ? '\nALL ALGEBRA EXECUTION CHECKS PASS' : `\n${fails} FAILED`);
process.exit(fails ? 1 : 0);
