// What the hot loop learns from a failed attempt and keeps for the run.
//
// Polygon, 2026-10-13, 90 minutes live: 1,939 simulation reverts, ~1,900 of
// them from five pairs whose swap() only serves their own router ("UniswapV2:
// caller is not verified", "TOMI PAIR : FORBIDDEN", "UniswapV2:
// UNAUTHORISED", "ConveyorV2: FORBIDDEN!"). The failed-pair filter lasts one
// block, so the same pairs were re-simulated block after block. And 17 QUOTE
// MISMATCHes, ~5% short, all through one pair: a transfer-tax token the probe
// had never measured.
//
//   1. permissioned pair: the attempt names the pair (asked directly with
//      swap(1, 0, executor) — only an exact reason match convicts it), marks it
//      pair-restricted in the DB, and knownBad() refuses later candidates
//      through it without an RPC call.
//   2. no false conviction: an unprofitable cycle through ordinary pairs
//      (InsufficientRepay) and a revert reason the pairs do not reproduce
//      convict nothing.
//   3. transfer-tax token: QUOTE MISMATCH → the token is probed through
//      TokenProbe, found fee-on-transfer, recorded in the DB, and banned.
//   4. seedKnownBad: a fresh executor picks both up from the DB.
//   5. hot loop: deps.knownBad filters before any attempt (skippedKnownBad).
//
//   npm i -D solc@0.8.24   (one-time)
//   node --experimental-strip-types test/test-known-bad.mjs   (anvil on PATH; own anvil on 8571)

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { ethers } from 'ethers';
import { ArbitradeDB } from '../source/util/db.ts';
import { CandidateExecutor } from '../source/orchestrator/attempt.ts';

const require = createRequire(import.meta.url);
const here = (p) => new URL(p, import.meta.url);
let fails = 0;
const ok = (c, l, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${l} ${extra}`); if (!c) fails++; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const WORK = fs.mkdtempSync('/tmp/arbitrade-knownbad-');
process.env.ARB_LEDGER = `${WORK}/ledger.sqlite`;
const CWD = process.cwd();
process.chdir(WORK);   // diagnostics write log/<chain>/… relative to the cwd

// A router-gated V2 pair: MockPair with the access check a permissioned fork puts first in swap().
const mocks = fs.readFileSync(here('./Mocks.sol'), 'utf8');
const mockPair = mocks.slice(mocks.indexOf('contract MockPair {'), mocks.indexOf('interface IFlashReceiver'));
const gated = mockPair.replace('contract MockPair {', 'contract GatedPair {\n    address public router;')
    .replace('function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external {',
        'function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external {\n        require(msg.sender == router, "UniswapV2: caller is not verified");');

const solc = require('solc');
const out = JSON.parse(solc.compile(JSON.stringify({
    language: 'Solidity',
    sources: {
        'FlashArbExecutor.sol': { content: fs.readFileSync(here('../contracts/FlashArbExecutor.sol'), 'utf8') },
        'TokenProbe.sol': { content: fs.readFileSync(here('../contracts/TokenProbe.sol'), 'utf8') },
        'YoBatches3.sol': { content: fs.readFileSync(here('../contracts/YoBatches3.sol'), 'utf8') },
        'YoBatches2.sol': { content: fs.readFileSync(here('../contracts/YoBatches2.sol'), 'utf8') },
        'Mocks.sol': { content: mocks },
        'Gated.sol': { content: `// SPDX-License-Identifier: MIT\npragma solidity ^0.8.24;\nimport "Mocks.sol";\n${gated}` },
        'Multicall3Min.sol': { content: fs.readFileSync(here('./Multicall3Min.sol'), 'utf8') },
    },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'shanghai', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
})));
for (const e of out.errors ?? []) if (e.severity === 'error') { console.error(e.formattedMessage); process.exit(1); }
const art = {};
for (const [, cs] of Object.entries(out.contracts)) for (const [n, c] of Object.entries(cs)) art[n] = { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object };

const PORT = 8571, RPC_URL = `http://127.0.0.1:${PORT}`;
const anvil = spawn('anvil', ['--port', String(PORT), '--disable-code-size-limit', '--gas-limit', '3000000000', '--silent']);
await sleep(1500);
const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { cacheTimeout: -1, staticNetwork: true });
const w = new ethers.Wallet('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', provider);
let nonce = await provider.getTransactionCount(w.address);
const ov = () => ({ nonce: nonce++, gasLimit: 30_000_000n });
const deploy = async (a, ...args) => { const c = await new ethers.ContractFactory(a.abi, a.bytecode, w).deploy(...args, ov()); await c.waitForDeployment(); return c; };
const send = async (p) => (await p).wait();
const E = (n) => BigInt(Math.round(n)) * 10n ** 18n;
const lc = (x) => x.toLowerCase();

let db;
try {
    console.log('0. venue');
    { const mc = await deploy(art.Multicall3Min); await provider.send('anvil_setCode', ['0xcA11bde05977b3631167028862bE2a173976CA11', await provider.getCode(await mc.getAddress())]); }
    const yo = await deploy(art.YoBatches3);
    const tok = async (n, tax = 0) => { const t = await deploy(art.MockToken, n, tax); return { t, a: lc(await t.getAddress()) }; };
    const R = await tok('ROOT'), B = await tok('B'), C = await tok('C'), T = await tok('TAX', 500);
    const pair = async (art_, X, Y, x, y) => {
        const p = await deploy(art_, X.a, Y.a, 30);
        const P = lc(await p.getAddress());
        await send(X.t.mint(P, E(x), ov())); await send(Y.t.mint(P, E(y), ov())); await send(p.sync(ov()));
        return { p, P, t0: lc(await p.token0()), t1: lc(await p.token1()) };
    };
    const G = await pair(art.GatedPair, R, B, 1_000_000, 1_000_000);   // permissioned
    const BC = await pair(art.MockPair, B, C, 1_000_000, 1_000_000);
    const CR = await pair(art.MockPair, C, R, 1_000_000, 1_040_000);   // the edge
    const RB = await pair(art.MockPair, R, B, 1_000_000, 1_000_000);   // an ordinary twin of G
    const RT = await pair(art.MockPair, R, T, 1_000_000, 1_000_000);   // T taxes 5% per transfer
    const TC = await pair(art.MockPair, T, C, 1_000_000, 1_000_000);
    const aave = await deploy(art.MockAavePool, 5n);
    const AAVE = await aave.getAddress();
    await send(R.t.mint(AAVE, E(10_000_000), ov()));
    const exec = await deploy(art.FlashArbExecutor, AAVE);
    const EX = await exec.getAddress();
    const probe = await deploy(art.TokenProbe, AAVE);

    db = new ArbitradeDB(`${WORK}/kb.sqlite`);
    const V2F = '0x00000000000000000000000000000000000f4c70';
    db.insertPairs([G, BC, CR, RB, RT, TC].map(x => ({ address: x.P, factory: V2F, token0: x.t0, token1: x.t1, blockNumber: 1 })));
    const cfg = {
        raw: {},
        chain: { name: 'Anvil', label: 'anvil', id: 31337, host: RPC_URL, token: R.a, executor: EX, contract: await yo.getAddress(), probe: await probe.getAddress() },
        factories: [{ address: V2F, fee: 0.003, group: 'v2' }],
        flashloan: { provider: 'aave-v3', pool: AAVE, premium: 0.0005, tokens: [{ symbol: 'ROOT', address: R.a, decimals: 18 }] },
        evaluator: { minProfitTokens: 0.01, minLiquidityTokens: 1, minInputTokens: 0.1 },
        scan: {},
    };
    const pricing = { [R.a]: { symbol: 'ROOT', priceInNumeraire: 1, sourceLiquidity: 1e24, minProfitInRootTokens: 0.01, minInputInRootTokens: 0.1 } };
    const exOpts = { ownerAddress: w.address, live: false, signer: w, gasMarginMultiple: 1, minProfitTokens: 0.01, gasPriceMaxAgeMs: 1 };
    const hop = (p, a, b) => ({ pair: p.P, factory: V2F, tokenIn: a.a, tokenOut: b.a, fee: 0.003, kind: 'v2' });
    const cand = (id, hops, input = 5_000e18) => ({ triangleId: id, rootToken: R.a, hopCount: hops.length, direction: 'forward', inputAmount: input, grossProfit: 1, netProfit: 1, hops });
    const probeOf = (P) => db.db.prepare('SELECT probeStatus, probeReason FROM pairs WHERE address = ?').get(P);
    const ex = new CandidateExecutor(cfg, provider, pricing, exOpts);

    console.log('\n1. permissioned pair');
    {
        const c = cand(1, [hop(G, R, B), hop(BC, B, C), hop(CR, C, R)]);
        const a = await ex.attempt(c, db);
        ok(/unusable pair .*permissioned/.test(a.simulationError ?? '') && a.simulationError.includes(G.P), 'the attempt names the gated pair', (a.simulationError ?? '').slice(-200));
        ok(probeOf(G.P)?.probeStatus === 'pair-restricted', 'marked pair-restricted in the DB', JSON.stringify(probeOf(G.P)));
        ok(probeOf(BC.P)?.probeStatus == null && probeOf(CR.P)?.probeStatus == null, 'the ordinary pairs of the same cycle are not marked');
        const other = cand(2, [hop(CR, R, C), hop(BC, C, B), hop(G, B, R)]);
        ok(/fails with "UniswapV2: caller is not verified"/.test(ex.knownBad(other) ?? ''), 'knownBad: any cycle through it, either direction', ex.knownBad(other));
        const b = await ex.attempt(other, db);
        ok(b.knownBad === true && b.built === null && b.gasEstimate == null, 'refused before building or estimating', b.simulationError);
    }

    console.log('\n2. no false conviction');
    {
        const c = cand(3, [hop(RB, R, B), hop(BC, B, C), hop(CR, C, R)]);
        const ex2 = new CandidateExecutor(cfg, provider, pricing, exOpts);
        const repay = { data: ethers.id('InsufficientRepay(uint256,uint256)').slice(0, 10) + ethers.AbiCoder.defaultAbiCoder().encode(['uint256', 'uint256'], [1, 2]).slice(2) };
        ok(await ex2.diagnoseGated(repay, c) === '' && ex2.knownBad(c) === null && probeOf(RB.P)?.probeStatus == null, 'an InsufficientRepay through ordinary pairs convicts nothing');
        // A reason string that no pair reproduces.
        const fakeErr = { data: '0x08c379a0' + ethers.AbiCoder.defaultAbiCoder().encode(['string'], ['UniswapV2: K']).slice(2) };
        const s = await ex2.diagnoseGated(fakeErr, c);
        ok(s === '' && ex2.knownBad(c) === null, 'a reason the pairs do not answer with convicts nothing');
    }

    console.log('\n3. transfer-tax token found by a QUOTE MISMATCH');
    {
        const c = cand(4, [hop(RT, R, T), hop(TC, T, C), hop(CR, C, R)]);
        ok(ex.knownBad(c) === null, 'not known before');
        const a = await ex.attempt(c, db);
        ok(/QUOTE MISMATCH/.test(a.simulationError ?? '') && /probed: .*fee-on-transfer/.test(a.simulationError ?? ''), 'mismatch → probe → fee-on-transfer', (a.simulationError ?? (a.built ? 'built, simulated=' + a.simulated : 'decayed')).slice(-400));
        const row = db.db.prepare('SELECT probeStatus, buyTaxBps, sellTaxBps FROM tokens WHERE address = ?').get(T.a);
        ok(row?.probeStatus === 'fee-on-transfer', 'recorded in the DB', JSON.stringify(row));
        ok(/token .* is fee-on-transfer/.test(ex.knownBad(c) ?? ''), 'knownBad now refuses cycles through it', ex.knownBad(c));
    }

    console.log('\n4. a fresh executor seeds both from the DB');
    {
        const ex3 = new CandidateExecutor(cfg, provider, pricing, exOpts);
        const n = ex3.seedKnownBad(db);
        ok(n.pairs === 1 && n.tokens === 1, 'one pair, one token', JSON.stringify(n));
        ok(ex3.knownBad(cand(5, [hop(G, R, B)])) && ex3.knownBad(cand(6, [hop(RT, R, T)])), 'both refused');
    }

    console.log('\n5a. a decayed edge says why');
    {
        const exHigh = new CandidateExecutor(cfg, provider, { [R.a]: { ...pricing[R.a], minProfitInRootTokens: 1e9 } }, exOpts);
        const a = await exHigh.attempt(cand(15, [hop(RB, R, B), hop(BC, B, C), hop(CR, C, R)]), db);
        ok(a.built === null && /exact walk at block \d+: \d+ in → \d+ out \(profit -?\d+, floor \d+\); the index scored net .* hops \d+ → \d+\(v2 0x/.test(a.decayReason ?? ''),
            'decayReason: amounts in/out, profit vs floor, the index\'s score, per-hop outputs', (a.decayReason ?? '').slice(0, 200));
    }

    console.log('\n5b. the same pair short in two DIFFERENT paths is convicted; one path convicts nothing');
    {
        const ex4 = new CandidateExecutor(cfg, provider, pricing, exOpts);
        const p1 = cand(7, [hop(RB, R, B), hop(BC, B, C), hop(CR, C, R)]);
        const p2 = cand(8, [hop(RT, R, T), hop(TC, T, C), hop(CR, C, R)]);
        ok(ex4.learnFromShortfall(p1, 500) === '' && ex4.knownBad(p1) === null, 'one short path: nothing convicted');
        ok(ex4.learnFromShortfall(p1, 500) === '', 'the same path again: still one path');
        const s = ex4.learnFromShortfall(p2, 500);
        ok(s.includes(CR.P) && !s.includes(RB.P) && !s.includes(RT.P), 'second path: only the shared pair is convicted', s.slice(0, 200));
        ok(/2 different paths .* 500 ppm short/.test(ex4.knownBad(cand(9, [hop(CR, R, C)])) ?? '') && /~0\.350%/.test(s), 'knownBad refuses it, with the fee that would match', ex4.knownBad(cand(9, [hop(CR, R, C)])));
        ok(ex4.learnFromShortfall(cand(10, [hop(RB, R, B), hop(BC, B, C)]), 50) === '', 'rounding-sized shortfalls are ignored');
    }

    console.log('\n5c. a non-root token in two DIFFERENT paths failing the same way is convicted; roots never');
    {
        const ex5 = new CandidateExecutor(cfg, provider, pricing, exOpts);
        const p1 = cand(11, [hop(RB, R, B), hop(BC, B, C), hop(CR, C, R)]);
        const p2 = cand(12, [hop(RT, R, T), hop(TC, T, C), hop(CR, C, R)]);
        ok(ex5.learnFromRevert(p1, 'TF') === '', 'first path: nothing');
        ok(ex5.learnFromRevert(p2, 'IIA') === '', 'a different reason does not combine');
        const s = ex5.learnFromRevert(p2, 'TF');
        ok(s.includes(C.a) && !s.includes(R.a) && !s.includes(B.a) && !s.includes(T.a), 'second TF path: only the shared non-root token C', s);
        ok(/in 2 different paths that all reverted "TF"/.test(ex5.knownBad(cand(13, [hop(BC, B, C)])) ?? ''), 'knownBad refuses cycles through C');
        ok(ex5.knownBad(cand(14, [hop(RB, R, B)])) === null, 'the root is never convicted');
    }

    console.log('\n5. hot loop filters before attempting');
    {
        const { createHotLoop } = await import('../source/orchestrator/hot-loop.ts');
        const src = fs.readFileSync(new URL('../source/orchestrator/hot-loop.ts', import.meta.url), 'utf8');
        ok(/deps\.knownBad\?\.\(ic as Candidate\)\) \{ stats\.skippedKnownBad\+\+/.test(src) && typeof createHotLoop === 'function', 'live filter consults deps.knownBad and counts skippedKnownBad');
    }
} catch (e) {
    console.error(e); fails++;
} finally {
    try { db?.close(); } catch {}
    provider.destroy();
    anvil.kill();
    process.chdir(CWD);
    fs.rmSync(WORK, { recursive: true, force: true });
}
console.log(fails === 0 ? '\nALL KNOWN-BAD CHECKS PASS' : `\n${fails} FAILED`);
process.exit(fails ? 1 : 0);
