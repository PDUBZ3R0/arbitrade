// FlashArbExecutor's four flash-loan sources, on a local anvil.
//
//   1. Each source funds the same profitable 3-hop cycle and the contract
//      keeps exactly balance - (amount + fee): Aave V3 (mock, 0.05%),
//      Balancer V2 (mock vault, free and with a protocol fee), a REAL
//      Uniswap V3 pool's flash() (v3-core 1.0.0 bytecode, 0.05% tier), and
//      Morpho Blue (mock, free). ArbExecuted reports the lender's actual fee.
//   2. The legacy executeArb (Aave via the constructor pool) is unchanged,
//      and refuses cleanly when deployed without a pool.
//   3. Callback safety: every callback rejects a direct call; a lender that
//      calls back twice, or relays the callback through another contract,
//      makes the whole transaction revert.
//   4. Bad inputs: unknown source, asset not in the V3 pool, unprofitable cycle.
//
//   npm i -D @uniswap/v3-core@1.0.1 solc@0.8.24     (one-time)
//   node test/test-flash-providers.mjs              (anvil on PATH)

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { ethers } from 'ethers';

const require = createRequire(import.meta.url);
const here = (p) => new URL(p, import.meta.url);
let fails = 0;
const ok = (c, l, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${l} ${extra}`); if (!c) fails++; };

const ROGUE = `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
interface IMorphoCb { function onMorphoFlashLoan(uint256, bytes calldata) external; }
interface ITok { function transfer(address, uint256) external returns (bool); }
contract Relay { function relay(address target, uint256 a, bytes calldata d) external { IMorphoCb(target).onMorphoFlashLoan(a, d); } }
/// Behaves like Morpho but misbehaves on request: mode 1 = call back twice,
/// mode 2 = deliver the callback through another contract.
contract RogueLender {
    uint8 public mode; Relay public relay;
    constructor(uint8 m) { mode = m; relay = new Relay(); }
    function flashLoan(address token, uint256 assets, bytes calldata data) external {
        ITok(token).transfer(msg.sender, assets);
        if (mode == 2) { relay.relay(msg.sender, assets, data); return; }
        IMorphoCb(msg.sender).onMorphoFlashLoan(assets, data);
        if (mode == 1) IMorphoCb(msg.sender).onMorphoFlashLoan(assets, data);
    }
}`;

const solc = require('solc');
const out = JSON.parse(solc.compile(JSON.stringify({
    language: 'Solidity',
    sources: {
        'FlashArbExecutor.sol': { content: fs.readFileSync(here('../contracts/FlashArbExecutor.sol'), 'utf8') },
        'Mocks.sol': { content: fs.readFileSync(here('./Mocks.sol'), 'utf8') },
        'V3Harness.sol': { content: fs.readFileSync(here('./v3-golden/V3Harness.sol'), 'utf8') },
        'Rogue.sol': { content: ROGUE },
    },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'shanghai',
                outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
})));
for (const e of out.errors ?? []) if (e.severity === 'error') { console.error(e.formattedMessage); process.exit(1); }
const art = {};
for (const [, cs] of Object.entries(out.contracts)) for (const [n, c] of Object.entries(cs)) art[n] = { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object };
const v3 = n => require(`@uniswap/v3-core/artifacts/contracts/${n}.sol/${n}.json`);

const PORT = 8551;
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
const SRC = { aave: 0, balancer: 1, univ3: 2, morpho: 3 };

/** ROOT -> A -> B -> ROOT on MockPairs; closing pool's ROOT side scaled by `edge`. */
async function cycle(edge = 1.05) {
    const root = await deploy(art.MockToken, 'ROOT', 0), a = await deploy(art.MockToken, 'A', 0), b = await deploy(art.MockToken, 'B', 0);
    const [R, A, B] = await Promise.all([root, a, b].map(t => t.getAddress()));
    const p1 = await deploy(art.MockPair, R, A, 30), p2 = await deploy(art.MockPair, A, B, 30), p3 = await deploy(art.MockPair, B, R, 30);
    const [P1, P2, P3] = await Promise.all([p1, p2, p3].map(p => p.getAddress()));
    for (const [t, p, amt] of [[root, P1, 1e6], [a, P1, 1e6], [a, P2, 1e6], [b, P2, 1e6], [b, P3, 1e6], [root, P3, 1e6 * edge]])
        await send(t.mint(p, E(amt), ov()));
    for (const p of [p1, p2, p3]) await send(p.sync(ov()));
    return { root, R, A, B, P1, P2, P3 };
}
const hopsFor = (c, EX) => [
    [c.P1, c.R, 3000, c.P2, 0], [c.P2, c.A, 3000, c.P3, 0], [c.P3, c.B, 3000, EX, 0],
];
function arbEvent(rc) {
    for (const l of rc.logs) { try { const p = EXI.parseLog(l); if (p?.name === 'ArbExecuted') return p.args; } catch {} }
    return null;
}

try {
    // A real Uniswap V3 factory, for the flash() source.
    const factory = await deploy(v3('UniswapV3Factory'));
    const harness = await deploy(art.Harness);

    console.log('1. every source funds the cycle and is repaid exactly');
    const BORROW = E(1000);
    const cases = [];
    {
        const c = await cycle();
        const aave = await deploy(art.MockAavePool, 5n);
        await send(c.root.mint(await aave.getAddress(), E(1e6), ov()));
        cases.push({ name: 'Aave V3 (0.05%)', c, src: SRC.aave, lender: await aave.getAddress(), fee: BORROW * 5n / 10_000n });
    }
    {
        const c = await cycle();
        const vault = await deploy(art.MockBalancerVault, 0n);
        await send(c.root.mint(await vault.getAddress(), E(1e6), ov()));
        cases.push({ name: 'Balancer V2 (free)', c, src: SRC.balancer, lender: await vault.getAddress(), fee: 0n });
    }
    {
        const c = await cycle();
        const vault = await deploy(art.MockBalancerVault, 10n);
        await send(c.root.mint(await vault.getAddress(), E(1e6), ov()));
        cases.push({ name: 'Balancer V2 (0.1% protocol fee)', c, src: SRC.balancer, lender: await vault.getAddress(), fee: BORROW * 10n / 10_000n });
    }
    {
        const c = await cycle();
        // ROOT/X pool at the 0.05% tier with deep liquidity around price 1.
        const x = await deploy(art.MockToken, 'X', 0);
        const X = await x.getAddress();
        await send(factory.createPool(c.R, X, 500, ov()));
        const pool = new ethers.Contract(await factory.getPool(c.R, X, 500), v3('UniswapV3Pool').abi, signer);
        await send(pool.initialize(1n << 96n, ov()));
        await send(harness.mint(await pool.getAddress(), -887270, 887270, E(1e6), ov()));
        // Uniswap rounds the flash fee UP: fee = mulDivRoundingUp(amount, 500, 1e6)
        const fee = (BORROW * 500n + 999_999n) / 1_000_000n;
        cases.push({ name: 'Uniswap V3 pool flash (0.05% tier)', c, src: SRC.univ3, lender: await pool.getAddress(), fee, X });
    }
    {
        const c = await cycle();
        const morpho = await deploy(art.MockMorpho);
        await send(c.root.mint(await morpho.getAddress(), E(1e6), ov()));
        cases.push({ name: 'Morpho Blue (free)', c, src: SRC.morpho, lender: await morpho.getAddress(), fee: 0n });
    }

    const profits = {};
    for (const k of cases) {
        const exec = await deploy(art.FlashArbExecutor, ethers.ZeroAddress);
        const EX = await exec.getAddress();
        let rc, err;
        try { rc = await send(exec.executeArbFrom(k.src, k.lender, k.c.R, BORROW, 0n, hopsFor(k.c, EX), ov())); }
        catch (e) { err = errName(e); await resync(); }
        if (!rc) { ok(false, k.name, `reverted: ${err}`); continue; }
        const ev = arbEvent(rc);
        const bal = await k.c.root.balanceOf(EX);
        profits[k.name] = bal;
        ok(ev && ev.premium === k.fee && ev.profit === bal && bal > 0n, k.name,
           `fee=${ethers.formatUnits(k.fee, 18)} profit=${Number(ethers.formatUnits(bal, 18)).toFixed(4)} gas=${rc.gasUsed}`);
    }
    ok(profits['Balancer V2 (free)'] > profits['Aave V3 (0.05%)'] && profits['Morpho Blue (free)'] === profits['Balancer V2 (free)'],
       'free lenders keep exactly the premium Aave would have charged');

    console.log('\n2. legacy executeArb');
    {
        const c = await cycle();
        const aave = await deploy(art.MockAavePool, 5n);
        await send(c.root.mint(await aave.getAddress(), E(1e6), ov()));
        const exec = await deploy(art.FlashArbExecutor, await aave.getAddress());
        const rc = await send(exec.executeArb(c.R, BORROW, 0n, hopsFor(c, await exec.getAddress()), ov()));
        ok(arbEvent(rc)?.premium === BORROW * 5n / 10_000n, 'Aave through the constructor pool, same as before');
        const bare = await deploy(art.FlashArbExecutor, ethers.ZeroAddress);
        let e1 = '';
        try { await bare.executeArb.staticCall(c.R, BORROW, 0n, hopsFor(c, await bare.getAddress())); } catch (e) { e1 = errName(e); }
        ok(e1 === 'NoLender', 'deployed without an Aave pool: executeArb refuses with NoLender', `(${e1})`);
    }

    console.log('\n3. callback safety');
    {
        const exec = await deploy(art.FlashArbExecutor, ethers.ZeroAddress);
        const EX = await exec.getAddress();
        const c = cases[0].c;
        const direct = [
            ['executeOperation', () => exec.executeOperation.staticCall(c.R, 1n, 0n, EX, '0x')],
            ['receiveFlashLoan', () => exec.receiveFlashLoan.staticCall([c.R], [1n], [0n], '0x')],
            ['uniswapV3FlashCallback', () => exec.uniswapV3FlashCallback.staticCall(0n, 0n, '0x')],
            ['pancakeV3FlashCallback', () => exec.pancakeV3FlashCallback.staticCall(0n, 0n, '0x')],
            ['algebraFlashCallback', () => exec.algebraFlashCallback.staticCall(0n, 0n, '0x')],
            ['onMorphoFlashLoan', () => exec.onMorphoFlashLoan.staticCall(1n, '0x')],
        ];
        let rejected = 0;
        for (const [, f] of direct) { try { await f(); } catch (e) { if (errName(e) === 'NotPool') rejected++; } }
        ok(rejected === direct.length, 'every callback rejects a direct call with NotPool', `${rejected}/${direct.length}`);

        for (const [mode, label] of [[1, 'a lender calling back twice'], [2, 'a callback relayed through another contract']]) {
            const k = await cycle();
            const rogue = await deploy(art.RogueLender, mode);
            await send(k.root.mint(await rogue.getAddress(), E(1e6), ov()));
            const ex2 = await deploy(art.FlashArbExecutor, ethers.ZeroAddress);
            let e = '';
            try { await ex2.executeArbFrom.staticCall(SRC.morpho, await rogue.getAddress(), k.R, BORROW, 0n, hopsFor(k, await ex2.getAddress())); }
            catch (err) { e = errName(err); }
            ok(e === 'NotPool', `${label}: rejected`, `(${e || 'no revert!'})`);
        }

        const stranger = new ethers.Wallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d', provider);
        let e3 = '';
        try { await exec.connect(stranger).executeArbFrom.staticCall(SRC.morpho, cases[4].lender, c.R, 1n, 0n, hopsFor(c, EX)); }
        catch (e) { e3 = errName(e); }
        ok(e3 === 'NotOwner', 'executeArbFrom is owner-only', `(${e3})`);
    }

    console.log('\n4. bad inputs');
    {
        const exec = await deploy(art.FlashArbExecutor, ethers.ZeroAddress);
        const EX = await exec.getAddress();
        const k = cases[3];
        let e1 = '', e2 = '', e3 = '', e4 = '';
        try { await exec.executeArbFrom.staticCall(9, k.lender, k.c.R, BORROW, 0n, hopsFor(k.c, EX)); } catch (e) { e1 = errName(e); }
        ok(e1 === 'BadSource', 'unknown source', `(${e1})`);
        const other = cases[0].c;   // its ROOT is not in the V3 pool
        try { await exec.executeArbFrom.staticCall(SRC.univ3, k.lender, other.R, BORROW, 0n, hopsFor(other, EX)); } catch (e) { e2 = errName(e); }
        ok(e2 === 'TokenNotInLender', 'asset not held by the V3 pool', `(${e2})`);
        try { await exec.executeArbFrom.staticCall(SRC.morpho, ethers.ZeroAddress, k.c.R, BORROW, 0n, hopsFor(k.c, EX)); } catch (e) { e3 = errName(e); }
        ok(e3 === 'NoLender', 'zero lender', `(${e3})`);
        const flat = await cycle(1.0);
        const vault = await deploy(art.MockBalancerVault, 0n);
        await send(flat.root.mint(await vault.getAddress(), E(1e6), ov()));
        try { await exec.executeArbFrom.staticCall(SRC.balancer, await vault.getAddress(), flat.R, BORROW, 0n, hopsFor(flat, EX)); } catch (e) { e4 = errName(e); }
        ok(e4 === 'InsufficientRepay', 'unprofitable cycle reverts instead of losing money', `(${e4})`);
    }
} finally {
    anvil.kill();
}

console.log(fails === 0 ? '\nALL FLASH PROVIDER CHECKS PASS' : `\n${fails} FAILED`);
process.exit(fails ? 1 : 0);
