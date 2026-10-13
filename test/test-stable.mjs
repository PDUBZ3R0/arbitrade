// Solidly STABLE pools (x³y + xy³ = k), traded end to end.
//
// Against test/Mocks.sol's MockVeloPool, whose stable math is Velodrome V2's
// Pool.sol ported line for line (fee off the input, decimals normalisation,
// the _get_y Newton loop, K on normalised reserves) — with a 6-decimal token,
// because that is where a stable implementation goes wrong.
//
//   1. calculus.js stable_amount_out (what the evaluator and index score with)
//      agrees with the pool's own getAmountOut, both directions, 6 and 18 dp.
//   2. Enumeration includes stable pools by default (--exclude-stable drops them).
//   3. The evaluator gate: with an executor lacking HOP_STABLE the stable cycle
//      is counted stableNotExecutable; with it, it is a candidate.
//   4. The hot loop's index finds the same candidates as the evaluator, with
//      stable pools in; without them it finds none.
//   5. The real attempt path (CandidateExecutor, live, on anvil) trades the
//      cycle: hop kinds [HOP_STABLE, HOP_V2], and the realised profit equals
//      buildHops' prediction minus the lender premium TO THE WEI — buildHops
//      quotes the stable hop with the pair's own getAmountOut.
//   6. The same cycle as a flash swap (stable first hop is the loan): realised
//      profit equals the prediction to the wei, no premium.
//   7. Traded as if it were constant-product (HOP_V2), the same stable pool
//      gives up most of the edge — why the hop kind exists.
//   8. An executor without HOP_STABLE (the same contract, constant renamed) is
//      detected from its bytecode, and a stable cycle is refused with a reason.
//
//   node test/compile.mjs ; node test/test-stable.mjs   (anvil on PATH; own anvil on 8568)

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ethers } from 'ethers';
import { ArbitradeDB } from '../source/util/db.ts';
import { stable_amount_out } from '../source/util/calculus.js';
import { enumerateTriangles } from '../source/triangles/enumerator.ts';
import { evaluateTriangles } from '../source/evaluator/evaluator.ts';
import { TriangleIndex } from '../source/orchestrator/triangle-index.ts';
import { CandidateExecutor } from '../source/orchestrator/attempt.ts';
import { buildHops, HOP_STABLE, HOP_V2 } from '../source/orchestrator/build-hops.ts';

const require = createRequire(import.meta.url);
let fails = 0;
const ok = (c, l, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${l} ${extra}`); if (!c) fails++; };
const quiet = async (fn) => {
    const w = process.stdout.write.bind(process.stdout), l = console.log, wn = console.warn;
    process.stdout.write = () => true; console.log = () => {}; console.warn = () => {};
    try { return await fn(); } finally { process.stdout.write = w; console.log = l; console.warn = wn; }
};
const art = JSON.parse(fs.readFileSync(new URL('./artifacts.json', import.meta.url), 'utf8'));

const PORT = 8568, RPC = `http://127.0.0.1:${PORT}`;
const anvil = spawn('anvil', ['--port', String(PORT), '--silent']);
await new Promise(r => setTimeout(r, 1500));
const provider = new ethers.JsonRpcProvider(RPC, undefined, { cacheTimeout: -1, staticNetwork: true });
const w = new ethers.Wallet('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', provider);
let nonce = await provider.getTransactionCount(w.address);
const ov = () => ({ nonce: nonce++, gasLimit: 15_000_000n });
const deploy = async (a, ...args) => { const c = await new ethers.ContractFactory(a.abi, a.bytecode, w).deploy(...args, ov()); await c.waitForDeployment(); return c; };
const send = async (p) => (await p).wait();
const resync = async () => { nonce = await provider.getTransactionCount(w.address); };
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'stable-'));
const ARB_EVENT = new ethers.Interface(['event ArbExecuted(address indexed asset, uint256 amountBorrowed, uint256 premium, uint256 profit)']);
const realised = (rc) => { for (const l of rc.logs) { try { const e = ARB_EVENT.parseLog(l); if (e) return e.args.profit; } catch {} } return null; };

globalThis.__DBG = true;
try {
    const mc = await deploy(art.Multicall3Min);
    await provider.send('anvil_setCode', ['0xcA11bde05977b3631167028862bE2a173976CA11', await provider.getCode(await mc.getAddress())]);

    // DAI (18 dp, the root and numeraire) and USDC (6 dp).
    const dai = await deploy(art.MockToken, 'DAI', 0), usdc = await deploy(art.MockToken, 'USDC', 0);
    await send(usdc.setDecimals(6, ov()));
    const DAI = (await dai.getAddress()).toLowerCase(), USDC = (await usdc.getAddress()).toLowerCase();
    const D = (n) => BigInt(Math.round(n * 1e6)) * 10n ** 12n, U = (n) => BigInt(Math.round(n * 1e6));

    const vf = await deploy(art.MockVeloFactory);
    const VF = (await vf.getAddress()).toLowerCase();
    await send(vf.createPool(DAI, USDC, true, ov()));
    const SP = (await vf.allPools(0)).toLowerCase();
    const sp = new ethers.Contract(SP, art.MockVeloPool.abi, w);
    await send(dai.mint(SP, D(1_000_000), ov())); await send(usdc.mint(SP, U(1_000_000), ov())); await send(sp.sync(ov()));

    // The way back: a V2 pair where USDC is 2% rich in DAI.
    const back = await deploy(art.MockPair, USDC, DAI, 30);
    const BACK = (await back.getAddress()).toLowerCase();
    await send(usdc.mint(BACK, U(1_000_000), ov())); await send(dai.mint(BACK, D(1_020_000), ov())); await send(back.sync(ov()));

    const aave = await deploy(art.MockAavePool, 5n);   // 0.05%
    const POOL = (await aave.getAddress()).toLowerCase();
    await send(dai.mint(POOL, D(10_000_000), ov()));
    const exec = await deploy(art.FlashArbExecutor, POOL);
    const EXEC = (await exec.getAddress()).toLowerCase();

    console.log('1. the stable curve: evaluator math vs the pool\'s own getAmountOut');
    {
        const [r0, r1] = await sp.getReserves();
        const t0 = (await sp.token0()).toLowerCase();
        const [rDai, rUsdc] = t0 === DAI ? [r0, r1] : [r1, r0];
        let worst = 0;
        for (const [tokIn, amt, rIn, rOut, dIn, dOut] of [
            [DAI, D(1), rDai, rUsdc, 18, 6], [DAI, D(5_000), rDai, rUsdc, 18, 6], [DAI, D(300_000), rDai, rUsdc, 18, 6],
            [USDC, U(1), rUsdc, rDai, 6, 18], [USDC, U(5_000), rUsdc, rDai, 6, 18], [USDC, U(300_000), rUsdc, rDai, 6, 18],
        ]) {
            const chain = await sp.getAmountOut(amt, tokIn);
            const mine = stable_amount_out(Number(amt), Number(rIn), Number(rOut), 0.0005, dIn, dOut);
            // On-chain output is floored to an integer unit; allow that one unit.
            worst = Math.max(worst, Math.max(0, Math.abs(mine - Number(chain)) - 1) / Number(chain));
        }
        ok(worst < 1e-6, 'within 1e-6 relative (plus the 1-unit floor), 1 to 300k, both directions, 18↔6 decimals', `(worst ${worst.toExponential(2)})`);
        const out1 = await sp.getAmountOut(D(1000), DAI);
        ok(out1 > U(999) && out1 < U(1000), 'near peg a stable pool is ~1:1 net of fee — not what x·y=k would say', `(1000 DAI → ${Number(out1) / 1e6} USDC)`);
    }

    // DB: what scan / reserves / tokens would have written.
    const dbFile = path.join(WORK, 'stable.sqlite');
    {
        const db = new ArbitradeDB(dbFile);
        const now = Math.floor(Date.now() / 1000);
        db.upsertTokens([{ address: DAI, symbol: 'DAI', name: 'DAI', decimals: 18, fetchStatus: 'ok' }, { address: USDC, symbol: 'USDC', name: 'USDC', decimals: 6, fetchStatus: 'ok' }]);
        const tok = async (c) => [(await c.token0()).toLowerCase(), (await c.token1()).toLowerCase()];
        const [s0, s1] = await tok(sp), [b0, b1] = await tok(back);
        db.insertPairs([
            { address: SP, factory: VF, token0: s0, token1: s1, blockNumber: 1, fee: 0.0005, stable: true },
            { address: BACK, factory: '0x' + 'f'.repeat(40), token0: b0, token1: b1, blockNumber: 1, fee: 0.003, stable: false },
        ]);
        const [sr0, sr1] = await sp.getReserves(), [br0, br1] = await back.getReserves();
        db.upsertReserves([{ pair: SP, reserves0: sr0, reserves1: sr1, blockNumber: 1 }, { pair: BACK, reserves0: br0, reserves1: br1, blockNumber: 1 }]);
        db.close();
    }
    const factories = [
        { group: 'solidly', name: 'Velo', address: VF, fee: undefined, poolEvent: 'velodrome', feeTarget: 'factory', feeArgSource: 'pair-address-stable', feeFunction: 'getFee', feeDivisor: 10000, abi: [] },
        { group: 'v2', name: 'Back', address: '0x' + 'f'.repeat(40), fee: 0.003, abi: [] },
    ];
    const cfg = (flashSwap) => ({
        raw: {}, chain: { name: 'Anvil', label: 'anvil', id: 31337, host: RPC, token: DAI, executor: EXEC },
        factories,
        flashloan: { provider: 'aave-v3', pool: POOL, premium: 0.0005, flashSwap, tokens: [{ symbol: 'DAI', address: DAI, decimals: 18 }] },
        evaluator: {}, reserves: {}, scan: {},
    });

    console.log('\n2. enumeration includes stable pools by default');
    {
        const without = await quiet(() => enumerateTriangles(cfg(false), dbFile, { includeStable: false }));
        ok(without.trianglesInserted === 0, '--exclude-stable: no cycle (the only DAI/USDC loop runs through the stable pool)');
        const res = await quiet(() => enumerateTriangles(cfg(false), dbFile, {}));
        ok(res.trianglesInserted === 1 && res.hops2Count === 1, 'default: the 2-hop through the stable pool is enumerated', `(${res.trianglesInserted})`);
    }

    const evalOpts = { minProfitTokens: 0.01, minInputTokens: 0.1, minLiquidityTokens: 1, limit: 10, executableOnly: true };
    console.log('\n3. the evaluator gate');
    let cand;
    {
        const old = await quiet(() => evaluateTriangles(cfg(false), dbFile, { ...evalOpts, stableHops: false }));
        ok(old.candidatesFound === 0 && old.skipReasons.stableNotExecutable > 0, 'executor without HOP_STABLE: stableNotExecutable, no candidate',
            `(${old.skipReasons.stableNotExecutable} skipped)`);
        const r = await quiet(() => evaluateTriangles(cfg(false), dbFile, { ...evalOpts, stableHops: true }));
        if (process.env.DBG) console.log(JSON.stringify(r.skipReasons, (k, v) => k === 'topCandidates' ? undefined : v), r.candidatesFound);
        cand = r.topCandidates[0];
        ok(r.candidatesFound >= 1 && cand?.hops.some(h => h.stable) && cand.hops[0].pair === SP,
            'with HOP_STABLE: a candidate whose first hop is the stable pool', cand ? `(in ${(cand.inputAmount / 1e18).toFixed(2)} DAI, net ${(cand.netProfit / 1e18).toFixed(4)} DAI)` : '');
    }

    console.log('\n4. the hot loop\'s index scores it the same');
    {
        const db = new ArbitradeDB(dbFile);
        const fbA = new Map(factories.map(f => [f.address.toLowerCase(), f]));
        const decimals = new Map([[DAI, 18]]);
        const thresholdsFor = (ix) => ({
            minProfitByRoot: new Map([[DAI, 0.01 * 1e18]]), minInputByRoot: new Map([[DAI, 0.1 * 1e18]]),
            minReserveByToken: Float64Array.from(ix.tokenAddr.map(a => 10 ** (a === USDC ? 6 : 18))),
            maxRoi: 20, flashPremium: 0.0005, flashSwap: false, stableHops: true,
        });
        const off = TriangleIndex.build(db, fbA, { decimalsByToken: decimals });
        ok(off.scoreAll(thresholdsFor(off)).length === 0, 'built without stable pools: nothing (the stable pool is not held)');
        const ix = TriangleIndex.build(db, fbA, { stable: true, decimalsByToken: decimals });
        const got = ix.scoreAll(thresholdsFor(ix));
        const same = got.length === 1 && got[0].triangleId === cand.triangleId && got[0].direction === cand.direction
            && Math.abs(got[0].inputAmount - cand.inputAmount) / cand.inputAmount < 1e-12
            && Math.abs(got[0].netProfit - cand.netProfit) / cand.netProfit < 1e-12 && got[0].hops[0].stable === true;
        ok(same, 'built with stable pools: the same candidate, same size and profit, hop flagged stable',
            got[0] ? `(index in ${(got[0].inputAmount / 1e18).toFixed(4)} vs evaluator ${(cand.inputAmount / 1e18).toFixed(4)})` : '(none)');
        db.close();
    }

    const pricing = { [DAI]: { symbol: 'DAI', priceInNumeraire: 1, sourceLiquidity: 1e24, minProfitInRootTokens: 0.01, minInputInRootTokens: 0.1, decimals: 18 } };
    const exOpts = { ownerAddress: w.address, live: true, signer: w, gasMarginMultiple: 1, minProfitTokens: 0.01, gasPriceMaxAgeMs: 1 };
    const snap = await provider.send('evm_snapshot', []);

    console.log('\n5. the attempt path trades it through the lender');
    {
        const ex = new CandidateExecutor(cfg(false), provider, pricing, exOpts);
        ok(await ex.supportsStable(), 'executor bytecode has HOP_STABLE');
        const db = new ArbitradeDB(dbFile);
        const a = await quiet(() => ex.attempt(cand, db));
        await resync();
        ok(a.built?.hops.map(h => h.kind).join(',') === `${HOP_STABLE},${HOP_V2}`, 'hops encoded [HOP_STABLE, HOP_V2]', `(${a.built?.hops.map(h => h.kind)})`);
        // The prediction is net of the lender's fee (rounded up; the mock pool
        // rounds down), so realised = prediction to within one wei.
        const d = a.built ? a.realisedProfit - a.built.expectedProfit : -1n;
        ok(a.confirmed && d >= 0n && d <= 1n && a.built.flashFee === (a.built.rootAmountIn * 5n + 9_999n) / 10_000n,
            'confirmed; realised profit = prediction (already net of the premium), to the wei',
            a.confirmed ? `(${ethers.formatEther(a.realisedProfit)} DAI on ${ethers.formatEther(a.built.rootAmountIn)})` : `(${a.simulationError?.slice(0, 120)})`);
        db.close();
    }
    await provider.send('evm_revert', [snap]);
    await resync();
    const snap2 = await provider.send('evm_snapshot', []);

    console.log('\n6. the same cycle as a flash swap — the stable pool is the loan');
    {
        const ex = new CandidateExecutor(cfg(true), provider, pricing, exOpts);
        const db = new ArbitradeDB(dbFile);
        const a = await quiet(() => ex.attempt(cand, db));
        await resync();
        ok(a.confirmed && a.built?.hops[0].kind === HOP_STABLE && a.built.hops[0].recipient.toLowerCase() === EXEC,
            'confirmed via executeFlashSwap, hop 0 HOP_STABLE paying out to the executor', a.confirmed ? '' : `(${a.simulationError?.slice(0, 120)})`);
        ok(a.realisedProfit === a.built?.expectedProfit, 'realised profit = prediction to the wei — no premium',
            a.realisedProfit != null ? `(${ethers.formatEther(a.realisedProfit)} DAI)` : '');
        db.close();
    }
    await provider.send('evm_revert', [snap2]);
    await resync();

    console.log('\n7. the same stable pool traded as if it were x·y=k');
    {
        const db = new ArbitradeDB(dbFile);
        const built = await buildHops(provider, EXEC, db, cand, 0n);
        db.close();
        const hopsAs = (kind) => built.hops.map((h, i) => [h.pair, h.tokenIn, h.feePpm, h.recipient, i === 0 ? kind : h.kind]);
        const s = await provider.send('evm_snapshot', []);
        const rcStable = await send(exec.executeArbFrom(0, POOL, DAI, built.rootAmountIn, 0n, hopsAs(HOP_STABLE), ov()));
        await provider.send('evm_revert', [s]); await resync();
        let asV2 = null, why = '';
        try { asV2 = realised(await send(exec.executeArbFrom(0, POOL, DAI, built.rootAmountIn, 0n, hopsAs(HOP_V2), ov()))); }
        catch (e) { why = e.shortMessage ?? e.message; await resync(); }
        const asStable = realised(rcStable);
        ok(asStable > 0n && (asV2 === null || asV2 < asStable / 2n), 'HOP_V2 math on a stable pool loses the trade or most of its edge',
            `(stable ${ethers.formatEther(asStable)} DAI vs as-V2 ${asV2 === null ? `reverted: ${why.slice(0, 60)}` : ethers.formatEther(asV2) + ' DAI'})`);
    }

    console.log('\n8. an executor without HOP_STABLE is detected and refused');
    {
        const solc = require('solc');
        const src = fs.readFileSync(new URL('../contracts/FlashArbExecutor.sol', import.meta.url), 'utf8').replaceAll('HOP_STABLE', 'HOP_STABLX');
        const out = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources: { 'F.sol': { content: src } },
            settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'shanghai', outputSelection: { '*': { FlashArbExecutor: ['abi', 'evm.bytecode.object'] } } } })));
        const c = out.contracts['F.sol'].FlashArbExecutor;
        const old = await deploy({ abi: c.abi, bytecode: '0x' + c.evm.bytecode.object }, POOL);
        const oldCfg = { ...cfg(false), chain: { ...cfg(false).chain, executor: (await old.getAddress()).toLowerCase() } };
        const ex = new CandidateExecutor(oldCfg, provider, pricing, exOpts);
        ok(await ex.supportsV3() && !(await ex.supportsStable()), 'V3-capable, but no HOP_STABLE in its bytecode');
        const db = new ArbitradeDB(dbFile);
        const a = await quiet(() => ex.attempt(cand, db));
        db.close();
        ok(!a.broadcast && /predates HOP_STABLE/.test(a.simulationError ?? ''), 'a stable cycle is refused, saying why', `(${a.simulationError?.slice(0, 90)})`);
    }
} finally {
    anvil.kill();
    fs.rmSync(WORK, { recursive: true, force: true });
}

console.log(fails === 0 ? '\nALL STABLE-POOL CHECKS PASS' : `\n${fails} FAILED`);
process.exit(fails ? 1 : 0);
