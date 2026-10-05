// FlashArbExecutor's V3 hops, on a local anvil, against REAL Uniswap V3 pools
// (v3-core 1.0.0 bytecode) and V2 MockPairs with the real K check.
//
//   1. Mixed cycles execute, and the on-chain profit equals buildHops'
//      prediction to the wei: V2->V3->V2, V3->V2->V2 (borrowed root goes
//      straight into a V3 pool), V3->V3->V2 (V3 output feeds another V3).
//   2. The PancakeV3 callback spelling pays the pool too.
//   3. Profit is measured from the balance held BEFORE the loan: unswept
//      profit already in the executor cannot make a losing cycle pass, and a
//      second arb reports only its own profit.
//   4. Callback safety: a direct call to either swap callback is refused; a
//      "pool" that bills more than the hop's input, calls back twice, or
//      relays the callback through another contract makes the trade revert.
//   5. Bad routes: a hop feeding a V3 hop that did not send its output to the
//      executor, and an unknown hop kind, are refused up front.
//   6. CandidateExecutor-facing pieces: buildHops routes outputs (V2 next ->
//      that pair, V3 next -> executor) and the executor reports HOP_V3.
//
//   npm i -D @uniswap/v3-core@1.0.1 solc@0.8.24     (one-time)
//   node --experimental-strip-types test/test-v3-exec.mjs   (anvil on PATH)

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { ethers } from 'ethers';
import { buildHops, HOP_V2, HOP_V3 } from '../source/orchestrator/build-hops.ts';

const require = createRequire(import.meta.url);
const here = (p) => new URL(p, import.meta.url);
let fails = 0;
const ok = (c, l, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${l} ${extra}`); if (!c) fails++; };

// Test-only pools: a constant-rate pool that calls the PancakeV3 spelling, and
// a hostile pool with configurable misbehaviour.
const EXTRA = `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
interface ITk { function transfer(address, uint256) external returns (bool); function balanceOf(address) external view returns (uint256); }
interface IPancakeCb { function pancakeV3SwapCallback(int256, int256, bytes calldata) external; }
interface IUniCb { function uniswapV3SwapCallback(int256, int256, bytes calldata) external; }

/// Pays out amountIn * 9975 / 10000 of the other token, PancakeV3-style:
/// output first, then the callback, then a balance check on the input.
contract MockPancakePool {
    address public token0; address public token1;
    constructor(address a, address b) { (token0, token1) = a < b ? (a, b) : (b, a); }
    function swap(address to, bool zeroForOne, int256 amountSpecified, uint160, bytes calldata data)
        external returns (int256 a0, int256 a1)
    {
        uint256 inAmt = uint256(amountSpecified);
        uint256 out = inAmt * 9975 / 10000;
        (address tIn, address tOut) = zeroForOne ? (token0, token1) : (token1, token0);
        ITk(tOut).transfer(to, out);
        uint256 before = ITk(tIn).balanceOf(address(this));
        (a0, a1) = zeroForOne ? (int256(inAmt), -int256(out)) : (-int256(out), int256(inAmt));
        IPancakeCb(msg.sender).pancakeV3SwapCallback(a0, a1, data);
        require(ITk(tIn).balanceOf(address(this)) >= before + inAmt, "IIA");
    }
}

contract Relay { function relay(address t, int256 a, int256 b) external { IUniCb(t).uniswapV3SwapCallback(a, b, ""); } }

/// mode 1: bill twice the input; 2: call back twice; 3: relay the callback.
contract RoguePool {
    address public token0; address public token1; uint8 public mode; Relay public relay;
    constructor(address a, address b, uint8 m) { (token0, token1) = a < b ? (a, b) : (b, a); mode = m; relay = new Relay(); }
    function swap(address to, bool zeroForOne, int256 amountSpecified, uint160, bytes calldata)
        external returns (int256 a0, int256 a1)
    {
        uint256 inAmt = uint256(amountSpecified);
        address tOut = zeroForOne ? token1 : token0;
        ITk(tOut).transfer(to, inAmt);
        int256 bill = mode == 1 ? int256(inAmt * 2) : int256(inAmt);
        (a0, a1) = zeroForOne ? (bill, -int256(inAmt)) : (-int256(inAmt), bill);
        if (mode == 3) { relay.relay(msg.sender, a0, a1); return (a0, a1); }
        IUniCb(msg.sender).uniswapV3SwapCallback(a0, a1, "");
        if (mode == 2) IUniCb(msg.sender).uniswapV3SwapCallback(a0, a1, "");
    }
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
        'Extra.sol': { content: EXTRA },
    },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'shanghai',
                outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
})));
for (const e of out.errors ?? []) if (e.severity === 'error') { console.error(e.formattedMessage); process.exit(1); }
const art = {};
for (const [, cs] of Object.entries(out.contracts)) for (const [n, c] of Object.entries(cs)) art[n] = { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object };
const v3 = n => require(`@uniswap/v3-core/artifacts/contracts/${n}.sol/${n}.json`);

const PORT = 8553;
const anvil = spawn('anvil', ['--port', String(PORT), '--disable-code-size-limit', '--gas-limit', '3000000000', '--silent']);
await new Promise(r => setTimeout(r, 1500));
const provider = new ethers.JsonRpcProvider(`http://127.0.0.1:${PORT}`, undefined, { cacheTimeout: -1, staticNetwork: true });
const signer = await provider.getSigner(0);
let nonce = await provider.getTransactionCount(await signer.getAddress());
const ov = () => ({ nonce: nonce++, gasLimit: 30_000_000n });
const resync = async () => { nonce = await provider.getTransactionCount(await signer.getAddress()); };
const deploy = async (a, ...args) => { const c = await new ethers.ContractFactory(a.abi, a.bytecode, signer).deploy(...args, ov()); await c.waitForDeployment(); return c; };
const send = async (p) => (await p).wait();
const E = (n) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;

const EXI = new ethers.Interface(art.FlashArbExecutor.abi);
const errName = (e) => {
    for (const d of [e?.data, e?.info?.error?.data, e?.error?.data, e?.revert?.data]) {
        if (typeof d === 'string' && d.length >= 10) { try { const p = EXI.parseError(d); if (p) return p.name; } catch {} }
    }
    return String(e?.shortMessage ?? e?.message ?? e).slice(0, 90);
};
function arbEvent(rc) {
    for (const l of rc.logs) { try { const p = EXI.parseLog(l); if (p?.name === 'ArbExecuted') return p.args; } catch {} }
    return null;
}
const SRC_MORPHO = 3;

try {
    // Multicall3 at its canonical address (build-hops reads V2 reserves through it).
    {
        const mc = await deploy(art.Multicall3Min);
        await provider.send('anvil_setCode', ['0xcA11bde05977b3631167028862bE2a173976CA11', await provider.getCode(await mc.getAddress())]);
    }
    const factory = await deploy(v3('UniswapV3Factory'));
    const harness = await deploy(art.Harness);
    const yo = await deploy(art.YoBatches3);
    const YO = await yo.getAddress();
    const morpho = await deploy(art.MockMorpho);
    const MORPHO = await morpho.getAddress();

    const token = async (n) => { const t = await deploy(art.MockToken, n, 0); return { t, a: await t.getAddress() }; };
    const R = await token('ROOT');
    let A, B;
    // Fresh A/B per scenario: a V3 factory allows one pool per (pair, fee).
    const fresh = async () => { A = await token('A'); B = await token('B'); };
    await send(R.t.mint(MORPHO, E(1e9), ov()));

    // pairs/pools registry for the buildHops token-order stub
    const order = new Map();
    async function v2(x, y, rx, ry) {
        const p = await deploy(art.MockPair, x.a, y.a, 30);
        const P = await p.getAddress();
        await send(x.t.mint(P, E(rx), ov())); await send(y.t.mint(P, E(ry), ov())); await send(p.sync(ov()));
        order.set(P.toLowerCase(), { token0: await p.token0(), token1: await p.token1() });
        return P;
    }
    /** Real V3 pool, full-range liquidity, price = y per x. */
    async function v3pool(x, y, fee, price, liq = E(1e6)) {
        await send(factory.createPool(x.a, y.a, fee, ov()));
        const P = await factory.getPool(x.a, y.a, fee);
        const pool = new ethers.Contract(P, v3('UniswapV3Pool').abi, signer);
        const t0 = await pool.token0();
        const p01 = t0.toLowerCase() === x.a.toLowerCase() ? price : 1 / price;   // token1 per token0
        const sqrt = BigInt(Math.round(Math.sqrt(p01) * 2 ** 48)) << 48n;
        await send(pool.initialize(sqrt, ov()));
        const sp = fee === 500 ? 10 : fee === 3000 ? 60 : 200;
        const lim = Math.floor(887272 / sp) * sp;
        await send(harness.mint(P, -lim, lim, liq, ov()));
        order.set(P.toLowerCase(), { token0: t0, token1: await pool.token1() });
        return P;
    }
    const db = { getPairTokenOrder: (addrs) => new Map(addrs.map(a => [a.toLowerCase(), order.get(a.toLowerCase())])) };

    const exec = await deploy(art.FlashArbExecutor, ethers.ZeroAddress);
    const EX = await exec.getAddress();

    /** buildHops -> executeArbFrom (Morpho, free) -> compare to the prediction. */
    async function runCycle(label, legs, input, ex = exec) {
        const EXA = await ex.getAddress();
        const cand = {
            rootToken: R.a, inputAmount: Number(input), netProfit: 0, triangleId: 0,
            hops: legs.map(([pair, tin, tout, kind, fee]) => ({ pair, factory: ethers.ZeroAddress, tokenIn: tin.a, tokenOut: tout.a, fee, kind })),
        };
        const built = await buildHops(provider, EXA, db, cand, 0n, YO);
        if (!built) { ok(false, label, 'buildHops returned null'); return null; }
        const before = await R.t.balanceOf(EXA);
        let rc, err;
        try { rc = await send(ex.executeArbFrom(SRC_MORPHO, MORPHO, R.a, built.rootAmountIn, 0n, built.hops.map(h => [h.pair, h.tokenIn, h.feePpm, h.recipient, h.kind]), ov())); }
        catch (e) { err = errName(e); await resync(); }
        if (!rc) { ok(false, label, `reverted: ${err}`); return null; }
        const ev = arbEvent(rc);
        const gained = (await R.t.balanceOf(EXA)) - before;
        ok(ev && ev.profit === built.expectedProfit && gained === built.expectedProfit && gained > 0n, label,
           `predicted=${ethers.formatUnits(built.expectedProfit, 18)} on-chain=${ev ? ethers.formatUnits(ev.profit, 18) : '-'} gas=${rc.gasUsed}`);
        return { built, ev, rc };
    }

    console.log('1. mixed cycles: on-chain profit equals the buildHops prediction');
    {
        await fresh();
        // V2 -> V3 -> V2: R->A on a V2 pair, A->B on a 0.3% V3 pool, B->R on a V2 pair priced 5% rich.
        const p1 = await v2(R, A, 1e6, 1e6), q = await v3pool(A, B, 3000, 1.0), p3 = await v2(B, R, 1e6, 1.05e6);
        const r = await runCycle('V2 -> V3 -> V2', [[p1, R, A, 'v2', 0.003], [q, A, B, 'v3', 0.003], [p3, B, R, 'v2', 0.003]], E(1000));
        if (r) ok(r.built.hops[0].recipient === EX && r.built.hops[1].recipient === p3 && r.built.hops[2].recipient === EX
                  && r.built.hops.map(h => h.kind).join() === `${HOP_V2},${HOP_V3},${HOP_V2}`,
                  'routing: V2 feeding V3 pays the executor; V3 feeding V2 pays the pair; last hop pays the executor');
    }
    {
        await fresh();
        // V3 first: the borrowed root goes straight into a V3 pool.
        const q = await v3pool(R, A, 500, 1.0), p2 = await v2(A, B, 1e6, 1e6), p3 = await v2(B, R, 1e6, 1.04e6);
        await runCycle('V3 -> V2 -> V2 (borrowed root swapped in a V3 pool)', [[q, R, A, 'v3', 0.0005], [p2, A, B, 'v2', 0.003], [p3, B, R, 'v2', 0.003]], E(1000));
    }
    {
        await fresh();
        // V3 output feeding another V3 hop, both directions of zeroForOne exercised by token order.
        const q1 = await v3pool(R, A, 500, 1.0), q2 = await v3pool(A, B, 3000, 1.03), p3 = await v2(B, R, 1e6, 1e6);
        const r = await runCycle('V3 -> V3 -> V2', [[q1, R, A, 'v3', 0.0005], [q2, A, B, 'v3', 0.003], [p3, B, R, 'v2', 0.003]], E(500));
        if (r) ok(r.built.hops[0].recipient === EX, 'routing: V3 feeding V3 pays the executor');
    }

    console.log('\n2. PancakeV3 callback spelling');
    {
        await fresh();
        const pk = await deploy(art.MockPancakePool, A.a, B.a);
        const PK = await pk.getAddress();
        await send(A.t.mint(PK, E(1e6), ov())); await send(B.t.mint(PK, E(1e6), ov()));
        const p1 = await v2(R, A, 1e6, 1e6), p3 = await v2(B, R, 1e6, 1.05e6);
        const hops = [[p1, R.a, 3000, EX, HOP_V2], [PK, A.a, 2500, p3, HOP_V3], [p3, B.a, 3000, EX, HOP_V2]];
        let rc, err;
        try { rc = await send(exec.executeArbFrom(SRC_MORPHO, MORPHO, R.a, E(1000), 0n, hops, ov())); } catch (e) { err = errName(e); await resync(); }
        ok(rc && arbEvent(rc)?.profit > 0n, 'pancakeV3SwapCallback pays the pool and the cycle closes in profit', err ? `(${err})` : '');
    }

    console.log('\n3. profit is measured from the pre-loan balance');
    {
        await fresh();
        const ex2 = await deploy(art.FlashArbExecutor, ethers.ZeroAddress);
        const EX2 = await ex2.getAddress();
        // A cycle with no edge: fees alone make it lose.
        const p1 = await v2(R, A, 1e6, 1e6), q = await v3pool(A, B, 3000, 1.0), p3 = await v2(B, R, 1e6, 1e6);
        const hops = [[p1, R.a, 3000, EX2, HOP_V2], [q, A.a, 3000, p3, HOP_V3], [p3, B.a, 3000, EX2, HOP_V2]];
        await send(R.t.mint(EX2, E(100), ov()));   // "unswept profit" from earlier arbs
        let e1 = '';
        try { await ex2.executeArbFrom.staticCall(SRC_MORPHO, MORPHO, R.a, E(1000), 0n, hops); } catch (e) { e1 = errName(e); }
        ok(e1 === 'InsufficientRepay', 'a losing cycle reverts even with 100 ROOT already sitting in the executor', `(${e1})`);

        // Two profitable arbs in a row: the second reports only its own profit.
        await fresh();
        const pa = await v2(R, A, 1e6, 1e6), qa = await v3pool(A, B, 3000, 1.0), pc = await v2(B, R, 1e6, 1.05e6);
        const r1 = await runCycle('first arb', [[pa, R, A, 'v2', 0.003], [qa, A, B, 'v3', 0.003], [pc, B, R, 'v2', 0.003]], E(1000), ex2);
        const r2 = await runCycle('second arb reports its own profit, not the running total', [[pa, R, A, 'v2', 0.003], [qa, A, B, 'v3', 0.003], [pc, B, R, 'v2', 0.003]], E(1000), ex2);
        if (r1 && r2) ok(r2.ev.profit < r1.ev.profit, 'second arb found a smaller edge (the first one moved the prices)',
                          `${ethers.formatUnits(r1.ev.profit, 18)} then ${ethers.formatUnits(r2.ev.profit, 18)}`);
    }

    console.log('\n4. callback safety');
    {
        await fresh();
        let rejected = 0;
        for (const f of [() => exec.uniswapV3SwapCallback.staticCall(1n, -1n, '0x'), () => exec.pancakeV3SwapCallback.staticCall(1n, -1n, '0x')]) {
            try { await f(); } catch (e) { if (errName(e) === 'NotPool') rejected++; }
        }
        ok(rejected === 2, 'both swap callbacks reject a direct call with NotPool', `${rejected}/2`);

        const p3 = await v2(B, R, 1e6, 1.05e6);
        for (const [mode, label, want] of [
            [1, 'a pool billing twice the hop input', 'SwapOverpaid'],
            [2, 'a pool calling back twice', 'NotPool'],
            [3, 'a callback relayed through another contract', 'NotPool'],
        ]) {
            const rogue = await deploy(art.RoguePool, A.a, B.a, mode);
            const RG = await rogue.getAddress();
            await send(B.t.mint(RG, E(1e6), ov()));
            const p1 = await v2(R, A, 1e6, 1e6);
            // Plenty of A already in the executor: a capped callback must not let the pool take it.
            await send(A.t.mint(EX, E(5000), ov()));
            const hops = [[p1, R.a, 3000, EX, HOP_V2], [RG, A.a, 3000, p3, HOP_V3], [p3, B.a, 3000, EX, HOP_V2]];
            let e1 = '';
            try { await exec.executeArbFrom.staticCall(SRC_MORPHO, MORPHO, R.a, E(1000), 0n, hops); } catch (e) { e1 = errName(e); }
            ok(e1 === want, `${label}: reverts ${want}`, `(${e1})`);
        }
    }

    console.log('\n5. bad routes are refused up front');
    {
        await fresh();
        const p1 = await v2(R, A, 1e6, 1e6), q = await v3pool(A, B, 3000, 1.0), p3 = await v2(B, R, 1e6, 1.05e6);
        let e1 = '', e2 = '';
        try { await exec.executeArbFrom.staticCall(SRC_MORPHO, MORPHO, R.a, E(1000), 0n,
            [[p1, R.a, 3000, q, HOP_V2], [q, A.a, 3000, p3, HOP_V3], [p3, B.a, 3000, EX, HOP_V2]]); } catch (e) { e1 = errName(e); }
        ok(e1 === 'BadRecipient', 'a V2 hop feeding a V3 hop must send to the executor', `(${e1})`);
        try { await exec.executeArbFrom.staticCall(SRC_MORPHO, MORPHO, R.a, E(1000), 0n,
            [[p1, R.a, 3000, p3, 2], [p3, A.a, 3000, EX, HOP_V2]]); } catch (e) { e2 = errName(e); }
        ok(e2 === 'BadHopKind', 'an unknown hop kind is refused', `(${e2})`);
    }

    console.log('\n6. version probe');
    ok(Number(await exec.HOP_V3()) === HOP_V3 && Number(await exec.HOP_V2()) === HOP_V2, 'executor exposes HOP_V2/HOP_V3 matching build-hops');
} catch (e) {
    console.error(e); fails++;
} finally {
    provider.destroy();
    anvil.kill();
}
console.log(fails === 0 ? '\nALL V3 EXECUTION CHECKS PASS' : `\n${fails} FAILED`);
process.exit(fails ? 1 : 0);
