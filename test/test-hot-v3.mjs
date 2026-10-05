// -----------------------------------------------------------------------------
// The hot loop with a V3 pool in the cycle, end to end on anvil.
//
//   ROOT -> B on a V2 MockPair, B -> C on a REAL Uniswap V3 pool (v3-core
//   1.0.0), C -> ROOT on a V2 MockPair, all in one triangle.
//
//   1. The index holds the V3 pool (build { v3: true }) and scores the mixed
//      cycle identically to `yarn evaluate` — same input size, same profit.
//   2. A swap on the V3 pool — which emits Swap, never Sync — reaches the
//      real watcher (watchV3), the real hot loop re-reads the pool through
//      YoBatches3, re-scores, and the real CandidateExecutor trades the cycle
//      through the real FlashArbExecutor's V3 hop. Confirmed on-chain.
//   3. A Mint on the pool (liquidity changes, price does not) also triggers a
//      re-read; a Sync-shaped update for the V3 pool is ignored.
//   4. Self-healing re-reads a cycle's V3 pool through refreshV3, not through
//      the V2 balanceOf path.
//
//   npm i -D @uniswap/v3-core@1.0.1 solc@0.8.24     (one-time)
//   node --experimental-strip-types test/test-hot-v3.mjs   (anvil on PATH)
// -----------------------------------------------------------------------------

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { ethers } from 'ethers';
import { ArbitradeDB } from '../source/util/db.ts';
import { TriangleIndex } from '../source/orchestrator/triangle-index.ts';
import { watchSync } from '../source/orchestrator/sync-watcher.ts';
import { createHotLoop } from '../source/orchestrator/hot-loop.ts';
import { CandidateExecutor } from '../source/orchestrator/attempt.ts';
import { printAttempt } from '../source/orchestrator/report.ts';
import { evaluateTriangles } from '../source/evaluator/evaluator.ts';
import { getV3States } from '../source/util/yobatches.ts';
import { virtualReserves } from '../source/reserves/v3-state.ts';
import { MIN_SQRT_RATIO, MAX_SQRT_RATIO } from '../source/util/calculus-v3.js';

const require = createRequire(import.meta.url);
const here = (p) => new URL(p, import.meta.url);
let fails = 0;
const ok = (c, l, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${l} ${extra}`); if (!c) fails++; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const WORK = process.env.ARB_TEST_WORK ?? '/tmp/arbitrade-hot-v3-test';
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
process.env.ARB_LEDGER = `${WORK}/ledger.sqlite`;   // never the real trade ledger

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
    },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'shanghai',
                outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
})));
for (const e of out.errors ?? []) if (e.severity === 'error') { console.error(e.formattedMessage); process.exit(1); }
const art = {};
for (const [, cs] of Object.entries(out.contracts)) for (const [n, c] of Object.entries(cs)) art[n] = { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object };
const v3 = n => require(`@uniswap/v3-core/artifacts/contracts/${n}.sol/${n}.json`);

const PORT = 8554;
const RPC_URL = `http://127.0.0.1:${PORT}`;
const anvil = spawn('anvil', ['--port', String(PORT), '--disable-code-size-limit', '--gas-limit', '3000000000', '--silent']);
await sleep(1500);
const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { cacheTimeout: -1, staticNetwork: true });
const w = new ethers.Wallet('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', provider);
const send = async (p) => (await p).wait();
const deploy = async (a, ...args) => { const c = await new ethers.ContractFactory(a.abi, a.bytecode, w).deploy(...args); await c.waitForDeployment(); return c; };
const E = (n) => BigInt(Math.round(n)) * 10n ** 18n;

let watcher, db;
try {
    console.log('0. venue');
    {
        const mc = await deploy(art.Multicall3Min);
        await provider.send('anvil_setCode', ['0xcA11bde05977b3631167028862bE2a173976CA11', await provider.getCode(await mc.getAddress())]);
    }
    const yo = await deploy(art.YoBatches3);
    const YO = await yo.getAddress();
    const factory = await deploy(v3('UniswapV3Factory'));
    const harness = await deploy(art.Harness);

    const tRoot = await deploy(art.MockToken, 'ROOT', 0), tB = await deploy(art.MockToken, 'B', 0), tC = await deploy(art.MockToken, 'C', 0);
    const [ROOT, B, C] = await Promise.all([tRoot, tB, tC].map(t => t.getAddress()));
    const pAB = await deploy(art.MockPair, ROOT, B, 30), pCA = await deploy(art.MockPair, C, ROOT, 30);
    const [AB, CA] = await Promise.all([pAB, pCA].map(p => p.getAddress()));
    for (const [t, p] of [[tRoot, AB], [tB, AB], [tC, CA], [tRoot, CA]]) await send(t.mint(p, E(1_000_000)));
    await send(pAB.sync()); await send(pCA.sync());

    await send(factory.createPool(B, C, 3000));
    const BCaddr = await factory.getPool(B, C, 3000);
    const pBC = new ethers.Contract(BCaddr, v3('UniswapV3Pool').abi, w);
    await send(pBC.initialize(1n << 96n));                       // price 1, like the V2 legs
    await send(harness.mint(BCaddr, -887220, 887220, E(1_000_000)));
    const BC = BCaddr.toLowerCase();
    const bcToken0 = (await pBC.token0()).toLowerCase();

    const aave = await deploy(art.MockAavePool, 5n);
    const POOL = await aave.getAddress();
    await send(tRoot.mint(POOL, E(10_000_000)));
    const exec = await deploy(art.FlashArbExecutor, POOL);
    const EXEC = await exec.getAddress();
    ok(Number(await exec.HOP_V3()) === 1, 'executor has the V3 hop path');

    console.log('\n1. database, index, and agreement with the evaluator');
    const dbFile = `${WORK}/hot-v3.sqlite`;
    db = new ArbitradeDB(dbFile);
    const raw = db.db;
    const V2F = '0x00000000000000000000000000000000000f4c70';
    const V3F = (await factory.getAddress()).toLowerCase();
    const now = Math.floor(Date.now() / 1000);
    raw.prepare('INSERT INTO factories (address,name,type,fee,deployBlock) VALUES (?,?,?,?,?)').run(V2F, 'MockFactory', 'v2', 0.003, 0);
    raw.prepare('INSERT INTO factories (address,name,type,fee,deployBlock) VALUES (?,?,?,?,?)').run(V3F, 'UniswapV3', 'v3', null, 0);
    const insTok = raw.prepare('INSERT INTO tokens (address,symbol,name,decimals,fetchStatus,fetchedAt,discoveredAt) VALUES (?,?,?,?,?,?,?)');
    for (const [s, a] of [['ROOT', ROOT], ['B', B], ['C', C]]) insTok.run(a.toLowerCase(), s, s, 18, 'ok', now, now);
    const insPair = raw.prepare('INSERT INTO pairs (address,factory,token0,token1,blockNumber,fee,stable,kind) VALUES (?,?,?,?,?,?,?,?)');
    const insRes = raw.prepare('INSERT INTO reserves (pair,reserves0,reserves1,blockNumber,updatedAt) VALUES (?,?,?,?,?)');
    for (const p of [pAB, pCA]) {
        const a = (await p.getAddress()).toLowerCase();
        const [r0, r1] = await p.getReserves();
        insPair.run(a, V2F, (await p.token0()).toLowerCase(), (await p.token1()).toLowerCase(), 1, 0.003, null, 'v2');
        insRes.run(a, r0.toString(), r1.toString(), 1, now);
    }
    insPair.run(BC, V3F, bcToken0, (await pBC.token1()).toLowerCase(), 1, 0.003, null, 'v3');
    insRes.run(BC, '1', '1', 1, now);   // replaced by upsertV3States below

    /** Read the pool through YoBatches3 and store it the way `yarn reserves` does. */
    const storeV3 = async () => {
        const st = await getV3States(provider, YO, [BC], 2);
        const s = st.pools[0];
        const [r0, r1] = virtualReserves(s.sqrtPriceX96, s.liquidity);
        db.upsertV3States([{ pool: BC, blockNumber: st.block, state: s, reserves0: r0, reserves1: r1 }]);
        return s;
    };
    await storeV3();
    const canonical = [AB, BC, CA].map(a => a.toLowerCase()).sort().join('-');
    raw.prepare(`INSERT INTO triangles (id,root_token,hop_count,token_a,token_b,token_c,pair_ab,pair_bc,pair_ca,
        factory_ab,factory_bc,factory_ca,canonical,createdAt) VALUES (1,?,3,?,?,?,?,?,?,?,?,?,?,?)`)
       .run(ROOT.toLowerCase(), ROOT.toLowerCase(), B.toLowerCase(), C.toLowerCase(),
            AB.toLowerCase(), BC, CA.toLowerCase(), V2F, V3F, V2F, canonical, now);

    const factoriesByAddr = new Map([[V2F, { address: V2F, fee: 0.003 }], [V3F, { address: V3F, callback: 'uniswapV3SwapCallback' }]]);
    const v2only = TriangleIndex.build(db, factoriesByAddr);
    ok(v2only.triangleCount === 0, 'without { v3: true } the V3 pool and its triangle stay out', `${v2only.triangleCount} triangle(s)`);
    const ix = TriangleIndex.build(db, factoriesByAddr, { v3: true });
    ok(ix.triangleCount === 1 && ix.v3Count === 1 && ix.isV3Pool(BC), 'with { v3: true } the index holds the pool and the triangle',
       `${ix.triangleCount} triangle, ${ix.pairCount} pairs, ${ix.v3Count} v3`);

    const cfg = {
        raw: {},
        chain: { name: 'Anvil', label: 'anvil', id: 31337, host: RPC_URL, token: ROOT, executor: EXEC, contract: YO },
        factories: [{ address: V2F, fee: 0.003, group: 'v2' }, { address: V3F, group: 'v3', callback: 'uniswapV3SwapCallback' }],
        flashloan: { provider: 'aave-v3', pool: POOL, premium: 0.0005, tokens: [
            { symbol: 'ROOT', address: ROOT, decimals: 18 }] },
        evaluator: { minProfitTokens: 0.01, minLiquidityTokens: 1, minInputTokens: 0.1 },
        scan: {},
    };
    const pricing = { [ROOT.toLowerCase()]: { symbol: 'ROOT', priceInNumeraire: 1, sourceLiquidity: 1e24, minProfitInRootTokens: 0.01, minInputInRootTokens: 0.1 } };
    const thresholds = {
        minProfitByRoot: new Map(ix.tokenAddr.map(a => [a, 0.01 * 1e18])),
        minInputByRoot: new Map(ix.tokenAddr.map(a => [a, 0.1 * 1e18])),
        minReserveByToken: Float64Array.from(ix.tokenAddr.map(() => 1e18)),
        maxRoi: 20,
        flashPremium: 0.0005,
    };
    ok(ix.scoreAll(thresholds).length === 0, 'no arbitrage at balanced prices');

    // Move the V3 pool, store the new state for the evaluator, apply it to the
    // index, and compare: same cycles, same size, same profit.
    const swapV3 = async (amount, cIn = true) => {
        // cIn: sell C into the pool (C gets cheaper there).
        const zeroForOne = cIn ? bcToken0 === C.toLowerCase() : bcToken0 === B.toLowerCase();
        await send(harness.swap(BCaddr, zeroForOne, amount, zeroForOne ? MIN_SQRT_RATIO + 1n : MAX_SQRT_RATIO - 1n));
    };
    await swapV3(E(20_000));
    const fresh = await storeV3();
    ix.applyV3State(BC, fresh);
    const mine = ix.scoreAll(thresholds);
    const ev = await evaluateTriangles(cfg, dbFile, { minProfitTokens: 0.01, maxRoiPct: 2000, minLiquidityTokens: 1, minInputTokens: 0.1, executableOnly: false });
    const theirs = ev.topCandidates;
    const same = mine.length === theirs.length && mine.length > 0 && mine.every((m, k) => {
        const t = theirs.find(c => c.direction === m.direction);
        return t && t.inputAmount === m.inputAmount && t.netProfit === m.netProfit
            && t.hops.map(h => `${h.pair}/${h.kind}`).join() === m.hops.map(h => `${h.pair}/${h.kind}`).join();
    });
    ok(same, 'index and evaluator agree on the mixed cycle (size, profit, hops, kinds)',
       mine.map(m => `${m.direction} x=${(m.inputAmount / 1e18).toFixed(4)} net=${(m.netProfit / 1e18).toFixed(6)}`).join('; ') +
       ' | evaluator: ' + theirs.map(t => `${t.direction} x=${(t.inputAmount / 1e18).toFixed(4)} net=${(t.netProfit / 1e18).toFixed(6)}`).join('; '));
    ok(mine.some(m => m.hops.some(h => h.kind === 'v3')), 'the candidate marks its V3 hop');

    console.log('\n2. a V3 Swap (no Sync) drives the loop to a confirmed trade');
    const executor = new CandidateExecutor(cfg, provider, pricing, {
        ownerAddress: w.address, live: true, signer: w, gasMarginMultiple: 1, minProfitTokens: 0.01, gasPriceMaxAgeMs: 1,
    });
    ok(await executor.supportsV3(), 'CandidateExecutor sees the V3-capable executor');
    const reports = [];
    const refreshV3 = async (pools) => {
        const st = await getV3States(provider, YO, pools, 2);
        return pools.map((p, k) => ({ pair: p, state: st.pools[k] }));
    };
    const v3Calls = [];
    const hot = createHotLoop({
        index: ix, db,
        thresholds: () => thresholds, pricing: () => pricing,
        decimalsByToken: new Map(ix.tokenAddr.map(a => [a, 18])),
        attempt: (c, d) => executor.attempt(c, d),
        report: (a) => { reports.push(a); printAttempt(cfg, a, (s) => console.log(`    ${s}`)); },
        candidatesPerBlock: 3, cooldownMs: 0,
        log: (s) => console.log(`    ${s}`),
        refreshV3: async (pools) => { v3Calls.push(pools); return refreshV3(pools); },
    });
    watcher = await watchSync(RPC_URL, undefined, {
        isInteresting: (p) => ix.pairIdx.has(p),
        onBatch: hot.onBatch,
        onError: (e, ctx) => console.log(`    [feed error] ${ctx}: ${e.message}`),
        pollMs: 200,
        watchV3: true,
    });
    // Put the index back on stale pre-swap state, so ONLY the loop's own
    // re-read can make it see the edge.
    const stale = (await refreshV3([BC]))[0].state;
    await swapV3(E(30_000));
    ix.applyV3State(BC, { ...stale, sqrtPriceX96: 1n << 96n });
    {
        const head = await provider.getBlockNumber();
        for (let i = 0; i < 75 && (watcher.lastBlock() < head || !reports.some(r => r.confirmed)); i++) await sleep(200);
        const s = hot.stats();
        ok(s.v3PoolsRefreshed > 0 && v3Calls.some(c => c.includes(BC)), 'the Swap event made the loop re-read the V3 pool',
           `${s.v3PoolsRefreshed} re-read(s)`);
        ok(s.candidatesFound > 0, 'the mixed cycle was found from that re-read', `${s.candidatesFound}`);
        const confirmed = reports.find(r => r.confirmed);
        ok(confirmed != null, 'a flash-loan arb through the V3 pool CONFIRMED on-chain',
           confirmed ? confirmed.txHash : reports.map(r => r.simulationError ?? '(no error)').join(' | '));
        if (confirmed) {
            ok(confirmed.built.hops.some(h => h.kind === 1 && h.pair.toLowerCase() === BC), 'the trade routed through the V3 pool as a V3 hop');
            ok(confirmed.realisedProfit > 0n && confirmed.realisedProfit <= confirmed.built.expectedProfit,
               'realised profit > 0 and within the prediction', `${confirmed.realisedProfit} vs ${confirmed.built.expectedProfit}`);
        }
    }

    console.log('\n3. Mint re-reads too; Sync-shaped updates cannot touch a V3 pool');
    {
        const before = hot.stats().v3PoolsRefreshed;
        await send(harness.mint(BCaddr, -600, 600, E(1000)));
        const head = await provider.getBlockNumber();
        for (let i = 0; i < 40 && (watcher.lastBlock() < head || hot.stats().v3PoolsRefreshed === before); i++) await sleep(200);
        ok(hot.stats().v3PoolsRefreshed > before, 'a Mint on the pool triggered a re-read');
        const pi = ix.pairIdx.get(BC);
        const r0 = ix.res0[pi];
        ok(ix.applySync(BC, 5, 5) === -1 && ix.res0[pi] === r0, 'applySync refuses a V3 pool');
    }

    console.log('\n4. self-healing uses refreshV3 for V3 pools');
    {
        const calls = [];
        const v2calls = [];
        const ix2 = TriangleIndex.build(db, factoriesByAddr, { v3: true });
        const h2 = createHotLoop({
            index: ix2, db, thresholds: () => thresholds, pricing: () => pricing,
            decimalsByToken: new Map(ix2.tokenAddr.map(a => [a, 18])),
            attempt: async (c) => ({ candidate: c, built: null, simulated: false, broadcast: false, confirmed: false }),
            report: () => {}, candidatesPerBlock: 1, cooldownMs: 0, log: () => {},
            refresh: async (pairs) => { v2calls.push(pairs); return []; },
            refreshV3: async (pools) => { calls.push(pools); return refreshV3(pools); },
        });
        await h2.sweep([{ triangleId: 1, rootToken: ROOT.toLowerCase(), hopCount: 3, direction: 'forward', inputAmount: 1e18, grossProfit: 1, netProfit: 1,
            hops: [{ pair: AB.toLowerCase(), factory: V2F, tokenIn: ROOT, tokenOut: B, fee: 0.003, kind: 'v2' },
                   { pair: BC, factory: V3F, tokenIn: B, tokenOut: C, fee: 0.003, kind: 'v3' },
                   { pair: CA.toLowerCase(), factory: V2F, tokenIn: C, tokenOut: ROOT, fee: 0.003, kind: 'v2' }] }]);
        ok(calls.length === 1 && calls[0].length === 1 && calls[0][0] === BC, 'the V3 pool went to refreshV3');
        ok(v2calls.length === 1 && !v2calls[0].includes(BC) && v2calls[0].length === 2, 'and only the V2 pairs to refresh');
    }
} catch (e) {
    console.error(e); fails++;
} finally {
    try { await watcher?.stop(); } catch {}
    try { db?.close(); } catch {}
    provider.destroy();
    anvil.kill();
}
console.log(fails === 0 ? '\nALL HOT-LOOP V3 CHECKS PASS' : `\n${fails} FAILED`);
process.exit(fails ? 1 : 0);
