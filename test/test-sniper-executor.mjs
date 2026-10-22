// SniperExecutor: sniper's real trades. Owner-only buy (with a same-tx sell
// check) and sell through V2 pairs (MockPair, the real UniswapV2 K check) and
// REAL Uniswap V3 pools (v3-core 1.0.1), on rule tokens that tax or block one
// direction, the way launch tokens do.
//
//   1. clean token, V2 and V3: the stake is pulled from the owner's wallet (approved),
//      the whole position's sell is checked and undone, staged sells pay the wallet.
//   2. sell taxes: 5% under a 10% cap passes on V2 (tax reported); 20% reverts
//      SellCheck; any sell tax on V3 reverts (the pool's balance check); sells
//      blocked reverts; a reverted buy spends nothing.
//   3. minOut: TooLittle on buy and on sell.
//   4. safety: only the owner trades or withdraws; a direct swap callback →
//      NotPool; a fake "pool" that asks its callback for more than the swap
//      was for → reverted, balance intact; a pool without the base → BadPool.
//
//   npm i -D @uniswap/v3-core@1.0.1 solc@0.8.24     (one-time; or NODE_PATH to a copy)
//   node test/test-sniper-executor.mjs              (anvil on PATH; own anvil on 8568)

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { ethers } from 'ethers';

const require = createRequire(import.meta.url);
const here = (p) => new URL(p, import.meta.url);
let fails = 0;
const ok = (c, l, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${l} ${extra}`); if (!c) fails++; };

const EXTRA = `
pragma solidity ^0.8.24;
contract RuleToken {
    mapping(address => uint256) public balanceOf;
    uint8 public decimals = 18;
    address public pool;
    uint16 public buyTaxBps; uint16 public sellTaxBps; bool public blockSell; uint16 public maxSellBps;
    mapping(address => uint256) public bought;
    constructor(uint16 b, uint16 s, bool bs) { buyTaxBps = b; sellTaxBps = s; blockSell = bs; }
    /// Anti-dump, as a real BSC token: a holder may sell at most this share of what it bought.
    function setMaxSell(uint16 bps) external { maxSellBps = bps; }
    function setPool(address p) external { pool = p; }
    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function transfer(address to, uint256 a) external returns (bool) {
        require(balanceOf[msg.sender] >= a, "balance");
        uint256 tax;
        if (msg.sender == pool) { tax = a * buyTaxBps / 10000; bought[to] += a - tax; }
        if (to == pool) {
            require(!blockSell, "sells off");
            require(maxSellBps == 0 || a <= bought[msg.sender] * maxSellBps / 10000, "Anti-Dump: Max 25% purchase volume per 1 day allowed");
            tax = a * sellTaxBps / 10000;
        }
        balanceOf[msg.sender] -= a; balanceOf[to] += a - tax;
        return true;
    }
}
interface ICb { function uniswapV3SwapCallback(int256, int256, bytes calldata) external; }
/// A "pool" found by topic alone: its swap asks the caller's callback for 10x what it was sent.
contract GreedyPool {
    address public token0; address public token1;
    constructor(address a, address b) { token0 = a; token1 = b; }
    function swap(address, bool, int256 amount, uint160, bytes calldata) external returns (int256, int256) {
        ICb(msg.sender).uniswapV3SwapCallback(amount * 10, 0, "");
        return (amount * 10, 0);
    }
}`;

const solc = require('solc');
const out = JSON.parse(solc.compile(JSON.stringify({
    language: 'Solidity',
    sources: {
        'SniperExecutor.sol': { content: fs.readFileSync(here('../contracts/SniperExecutor.sol'), 'utf8') },
        'Mocks.sol': { content: fs.readFileSync(here('./Mocks.sol'), 'utf8') },
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

const PORT = 8568;
const anvil = spawn('anvil', ['--port', String(PORT), '--disable-code-size-limit', '--gas-limit', '3000000000', '--silent']);
await new Promise(r => setTimeout(r, 1500));
const provider = new ethers.JsonRpcProvider(`http://127.0.0.1:${PORT}`, undefined, { cacheTimeout: -1, staticNetwork: true });
const owner = await provider.getSigner(0), other = await provider.getSigner(1);
const nonces = new Map();
const ov = async (s = owner) => { const a = await s.getAddress(); if (!nonces.has(a)) nonces.set(a, await provider.getTransactionCount(a)); const n = nonces.get(a); nonces.set(a, n + 1); return { nonce: n, gasLimit: 30_000_000n }; };
const deploy = async (a, ...args) => { const c = await new ethers.ContractFactory(a.abi, a.bytecode, owner).deploy(...args, await ov()); await c.waitForDeployment(); return c; };
const send = async (p) => (await p).wait();
const E = (n) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;
const SX = new ethers.Interface(art.SniperExecutor.abi);
const errName = (e) => {
    for (const d of [e?.data, e?.info?.error?.data, e?.error?.data, e?.revert?.data]) {
        if (typeof d === 'string' && d.length >= 10) { try { const p = SX.parseError(d); return p ? `${p.name}${p.name === 'Failed' ? `(${p.args[0]})` : ''}` : d.slice(0, 10); } catch { return d.slice(0, 10); } }
    }
    return String(e?.shortMessage ?? e?.message ?? e).slice(0, 90);
};
const reverts = async (f) => { try { await f(); return null; } catch (e) { return errName(e); } };

try {
    const base = await deploy(art.MockToken, 'WBNB', 0);
    const B = await base.getAddress();
    const ex = await deploy(art.SniperExecutor, await owner.getAddress());
    const EX = await ex.getAddress();
    const OWNER = await owner.getAddress();
    // The money stays in the owner's wallet: approved for the executor, pulled per buy.
    await send(base.mint(OWNER, E(100), await ov()));
    await send(base.approve(EX, ethers.MaxUint256, await ov()));
    const factory = await deploy(v3('UniswapV3Factory'));
    const harness = await deploy(art.Harness);

    const make = async (kind, rules) => {
        const t = await deploy(art.RuleToken, ...rules);
        const T = await t.getAddress();
        let P;
        if (kind === 'v2') {
            const p = await deploy(art.MockPair, B, T, 30);
            P = await p.getAddress();
            await send(base.mint(P, E(1000), await ov())); await send(t.mint(P, E(1e6), await ov())); await send(p.sync(await ov()));
        } else {
            await send(factory.createPool(B, T, 3000, await ov()));
            P = await factory.getPool(B, T, 3000);
            await send(new ethers.Contract(P, v3('UniswapV3Pool').abi, owner).initialize(1n << 96n, await ov()));
            await send(harness.mint(P, -887220, 887220, E(1e6), await ov()));
        }
        await send(t.setPool(P, await ov()));
        return { t, T, P, cl: kind !== 'v2' };
    };
    /** The revert reason (staticCall), then the transaction itself, which must revert too. */
    const buyFails = async (m, amount, cap = 1000) => {
        const why = await reverts(() => ex.buy.staticCall(m.P, m.cl, B, amount, 0, 30, cap));
        const sent = await reverts(async () => send(ex.buy(m.P, m.cl, B, amount, 0, 30, cap, await ov())));
        return sent ? why : null;
    };
    const buy = async (m, amount, minOut = 0n, cap = 1000) => {
        const rc = await send(ex.buy(m.P, m.cl, B, amount, minOut, 30, cap, await ov()));
        const ev = rc.logs.map(l => { try { return SX.parseLog(l); } catch { return null; } }).find(e => e?.name === 'Bought');
        return { rc, ev };
    };

    let clean0;
    for (const kind of ['v2', 'v3']) {
        console.log(`\n1. clean token through ${kind}`);
        const m = await make(kind, [0, 0, false]);
        if (kind === 'v2') clean0 = m;
        const b0 = await base.balanceOf(OWNER);
        const { ev } = await buy(m, E(1));
        const held = await m.t.balanceOf(EX);
        ok(ev && ev.args.tokensKept === held && ev.args.checkSold === held && ev.args.checkBack > 0n, `buy: kept all ${ethers.formatEther(held)} tokens; selling all of them would bring ${ethers.formatEther(ev?.args.checkBack ?? 0n)} back`);
        ok(ev?.args.sellTaxBps === 0n && b0 - (await base.balanceOf(OWNER)) === E(1), 'sell tax 0; exactly the stake left the wallet (the check was undone)');
        ok((await base.balanceOf(EX)) === 0n, 'the executor holds no base: only the bought tokens');
        const r = await reverts(() => ex.sell.staticCall(m.P, m.cl, B, held / 2n, E(1e9), 30));
        ok(r === 'TooLittle', `sell with an impossible minOut → TooLittle`, `(${r})`);
        const w0 = await base.balanceOf(OWNER);
        const rc = await send(ex.sell(m.P, m.cl, B, held / 2n, 0, 30, await ov()));
        const sold = rc.logs.map(l => { try { return SX.parseLog(l); } catch { return null; } }).find(e => e?.name === 'Sold');
        ok(sold && sold.args.tokensOut === held / 2n && sold.args.baseBack > 0n && (await base.balanceOf(OWNER)) - w0 === sold.args.baseBack, `sell half: ${ethers.formatEther(sold?.args.baseBack ?? 0n)} back, paid straight to the wallet`);
        await send(ex.sell(m.P, m.cl, B, held - held / 2n, 0, 30, await ov()));
        ok((await m.t.balanceOf(EX)) === 0n, 'sell the rest: none left');
        ok(await reverts(() => ex.buy.staticCall(m.P, m.cl, B, E(1), E(1e9), 30, 1000)) === 'TooLittle', 'buy with an impossible minOut → TooLittle');
    }

    console.log('\n2. sell taxes and blocked sells');
    const v2tax5 = await make('v2', [0, 500, false]);
    const t5 = await buy(v2tax5, E(1));
    ok(t5.ev && Math.abs(Number(t5.ev.args.sellTaxBps) - 500) <= 1, `v2, 5% sell tax under a 10% cap → bought, tax reported ${t5.ev?.args.sellTaxBps}`);
    const v2buyTax = await make('v2', [500, 0, false]);
    const tb = await buy(v2buyTax, E(1));
    ok(tb.ev && tb.ev.args.sellTaxBps === 0n, 'v2, 5% buy tax only → bought (the tax is in what arrived)');
    const v2tax20 = await make('v2', [0, 2000, false]);
    const before = await base.balanceOf(OWNER);
    ok(await buyFails(v2tax20, E(1)) === 'SellCheck', 'v2, 20% sell tax over a 10% cap → SellCheck');
    ok((await base.balanceOf(OWNER)) === before, 'the reverted buy spent nothing');
    const v3tax = await make('v3', [0, 500, false]);
    const r3 = await buyFails(v3tax, E(1));
    ok(r3 === 'Failed(2)', 'v3, 5% sell tax → the sell check reverts (a V3 pool can\'t take a taxed sell)', `(${r3})`);
    for (const kind of ['v2', 'v3']) {
        const hp = await make(kind, [0, 0, true]);
        const r = await buyFails(hp, E(1));
        ok(r != null && r.startsWith('Failed'), `${kind}, sells blocked (honeypot) → the buy reverts`, `(${r})`);
    }
    ok((await base.balanceOf(OWNER)) === before, 'nothing spent on any of them');

    const antiDump = await make('v2', [0, 0, false]);
    await send(antiDump.t.setMaxSell(2500, await ov()));
    ok(await buyFails(antiDump, E(1)) === 'Failed(2)', 'v2, sells capped at 25% of what was bought (a real BSC anti-dump) → the buy reverts: the WHOLE position is checked');
    ok((await base.balanceOf(OWNER)) === before, 'nothing spent on any of them');

    console.log('\n3-4. safety');
    ok(await reverts(() => ex.sellCheck.staticCall(clean0.P, false, clean0.T, B, 1, 30)) === 'NotOwner', 'sellCheck from outside → NotOwner (only the executor calls it, and it always reverts)');
    const clean = await make('v2', [0, 0, false]);
    const asOther = ex.connect(other);
    ok(await reverts(() => asOther.buy.staticCall(clean.P, false, B, E(1), 0, 30, 1000)) === 'NotOwner', 'someone else: buy → NotOwner');
    ok(await reverts(() => asOther.sell.staticCall(clean.P, false, B, 1, 0, 30)) === 'NotOwner', 'someone else: sell → NotOwner');
    ok(await reverts(() => asOther.withdraw.staticCall(B, 1)) === 'NotOwner', 'someone else: withdraw → NotOwner');
    ok(await reverts(() => ex.uniswapV3SwapCallback.staticCall(E(1), 0, '0x')) === 'NotPool', 'a direct swap callback → NotPool');
    const greedy = await deploy(art.GreedyPool, B, await (await deploy(art.MockToken, 'X', 0)).getAddress());
    const g0 = await base.balanceOf(OWNER);
    const G = await greedy.getAddress();
    const rg = await buyFails({ P: G, cl: true }, E(1));
    ok(rg != null && (await base.balanceOf(OWNER)) === g0, 'a fake pool asking its callback for 10x the swap → reverted, balance intact', `(${rg})`);
    const noBase = await deploy(art.GreedyPool, await (await deploy(art.MockToken, 'Y', 0)).getAddress(), await (await deploy(art.MockToken, 'Z', 0)).getAddress());
    const NB = await noBase.getAddress();
    ok(await reverts(() => ex.buy.staticCall(NB, true, B, E(1), 0, 30, 1000)) === 'BadPool', 'a pool without the base → BadPool');
    await buy(clean, E(1));
    const held = await clean.t.balanceOf(EX);
    await send(ex.withdraw(clean.T, ethers.MaxUint256, await ov()));
    ok((await clean.t.balanceOf(EX)) === 0n && (await clean.t.balanceOf(OWNER)) === held, 'withdraw(max) a position\'s tokens: all of them to the owner');
    // Approvals bound what it can spend.
    await send(base.approve(EX, E(0.5), await ov()));
    ok((await reverts(() => ex.buy.staticCall(clean.P, false, B, E(1), 0, 30, 1000)))?.startsWith('Failed'), 'approved 0.5, a 1.0 buy → reverts (transferFrom), nothing spent');
    await send(base.approve(EX, 0, await ov()));
    ok((await reverts(() => ex.buy.staticCall(clean.P, false, B, E(0.1), 0, 30, 1000)))?.startsWith('Failed'), 'approval revoked → every buy reverts');
} finally {
    anvil.kill();
}

console.log(fails === 0 ? '\nALL SNIPER-EXECUTOR CHECKS PASS' : `\n${fails} FAILED`);
process.exit(fails ? 1 : 0);
