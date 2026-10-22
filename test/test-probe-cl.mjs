// TokenProbe through concentrated-liquidity pools (probeCLFrom), on REAL
// Uniswap V3 pools (v3-core 1.0.1): sniper sees ~13% of Robinhood launches on
// V3 / CL pools, and those were "untestable" with a V2-only probe.
//
//   1. clean token → clean; buy-only tax → fee-on-transfer with the buy tax;
//      a token taxed into the pool → honeypot (a V3 pool can't take a taxed
//      sell: its balance check reverts), sell tax measured.
//   2. a token whose holders can't send to the pool → honeypot (sell transfer);
//      a token the pool can't send out → honeypot ("TF" from the pool).
//   3. through a V3 flash lender and Morpho alike.
//   4. safety: direct swap callbacks → NotPool; the lender as the pool under
//      test → lender config error; probeSupportsCL reads the selector.
//   5. nothing persists.
//
//   npm i -D @uniswap/v3-core@1.0.1 solc@0.8.24     (one-time; or NODE_PATH to a copy)
//   node test/test-probe-cl.mjs                     (anvil on PATH; own anvil on 8567)

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { ethers } from 'ethers';
import { probeCLPool, probeSupportsCL, probeSupportsLenders } from '../source/util/token-probe.ts';

const require = createRequire(import.meta.url);
const here = (p) => new URL(p, import.meta.url);
let fails = 0;
const ok = (c, l, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${l} ${extra}`); if (!c) fails++; };

// A token with per-direction rules against one pool: what launch tokens do.
const RULES = `
pragma solidity ^0.8.24;
contract RuleToken {
    mapping(address => uint256) public balanceOf;
    uint8 public decimals = 18;
    address public pool;
    uint16 public buyTaxBps; uint16 public sellTaxBps; bool public blockSell; bool public blockBuy;
    constructor(uint16 b, uint16 s, bool bs, bool bb) { buyTaxBps = b; sellTaxBps = s; blockSell = bs; blockBuy = bb; }
    function setPool(address p) external { pool = p; }
    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function transfer(address to, uint256 a) external returns (bool) {
        require(balanceOf[msg.sender] >= a, "balance");
        uint256 tax;
        if (msg.sender == pool) { require(!blockBuy, "buys off"); tax = a * buyTaxBps / 10000; }
        if (to == pool) { require(!blockSell, "sells off"); tax = a * sellTaxBps / 10000; }
        balanceOf[msg.sender] -= a; balanceOf[to] += a - tax;
        return true;
    }
}`;

const solc = require('solc');
const out = JSON.parse(solc.compile(JSON.stringify({
    language: 'Solidity',
    sources: {
        'TokenProbe.sol': { content: fs.readFileSync(here('../contracts/TokenProbe.sol'), 'utf8') },
        'Mocks.sol': { content: fs.readFileSync(here('./Mocks.sol'), 'utf8') },
        'V3Harness.sol': { content: fs.readFileSync(here('./v3-golden/V3Harness.sol'), 'utf8') },
        'RuleToken.sol': { content: RULES },
    },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'shanghai',
                outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
})));
for (const e of out.errors ?? []) if (e.severity === 'error') { console.error(e.formattedMessage); process.exit(1); }
const art = {};
for (const [, cs] of Object.entries(out.contracts)) for (const [n, c] of Object.entries(cs)) art[n] = { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object };
const v3 = n => require(`@uniswap/v3-core/artifacts/contracts/${n}.sol/${n}.json`);

const PORT = 8567;
const anvil = spawn('anvil', ['--port', String(PORT), '--disable-code-size-limit', '--gas-limit', '3000000000', '--silent']);
await new Promise(r => setTimeout(r, 1500));
const provider = new ethers.JsonRpcProvider(`http://127.0.0.1:${PORT}`, undefined, { cacheTimeout: -1, staticNetwork: true });
const signer = await provider.getSigner(0);
let nonce = await provider.getTransactionCount(await signer.getAddress());
const ov = () => ({ nonce: nonce++, gasLimit: 30_000_000n });
const deploy = async (a, ...args) => { const c = await new ethers.ContractFactory(a.abi, a.bytecode, signer).deploy(...args, ov()); await c.waitForDeployment(); return c; };
const send = async (p) => (await p).wait();
const E = (n) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;
const SRC = { univ3: 2, morpho: 3 };

try {
    const root = await deploy(art.MockToken, 'ROOT', 0);
    const R = await root.getAddress();
    const factory = await deploy(v3('UniswapV3Factory'));
    const harness = await deploy(art.Harness);
    const poolFor = async (tokenAddr, fee = 3000) => {
        await send(factory.createPool(R, tokenAddr, fee, ov()));
        const P = await factory.getPool(R, tokenAddr, fee);
        await send(new ethers.Contract(P, v3('UniswapV3Pool').abi, signer).initialize(1n << 96n, ov()));
        await send(harness.mint(P, -887220, 887220, E(1e6), ov()));
        return P;
    };
    const tokens = {
        clean: [0, 0, false, false], buyTax: [500, 0, false, false], bothTax: [500, 500, false, false],
        sellsOff: [0, 0, true, false], buysOff: [0, 0, false, true],
    };
    const pools = {};
    for (const [k, args] of Object.entries(tokens)) {
        const t = await deploy(art.RuleToken, ...args);
        const P = await poolFor(await t.getAddress());
        await send(t.setPool(P, ov()));
        pools[k] = P;
    }
    // Lenders: a separate ROOT/X V3 pool (its flash) and a Morpho mock.
    const x = await deploy(art.MockToken, 'X', 0);
    const lenderPool = await poolFor(await x.getAddress(), 500);
    const morpho = await deploy(art.MockMorpho);
    await send(root.mint(await morpho.getAddress(), E(1e6), ov()));
    const lenders = { univ3: lenderPool, morpho: await morpho.getAddress() };

    const probe = await deploy(art.TokenProbe, ethers.ZeroAddress);
    const PROBE = await probe.getAddress();
    const AMOUNT = E(1000);
    const bal = () => Promise.all([lenders.univ3, lenders.morpho, ...Object.values(pools)].map(a => root.balanceOf(a)));
    const before = await bal();

    for (const k of ['univ3', 'morpho']) {
        const via = { source: SRC[k], lender: lenders[k] };
        const p = (name) => probeCLPool(provider, PROBE, R, pools[name], AMOUNT, via);
        console.log(`\n1-2. verdicts through V3 pools, borrowing from ${k}`);
        const c = await p('clean');
        ok(c.status === 'clean', 'clean token → clean', `(${c.status}: ${c.reason})`);
        const b = await p('buyTax');
        ok(b.status === 'fee-on-transfer' && Math.abs(b.buyTaxBps - 500) <= 1 && b.sellTaxBps === 0, '5% buy tax → fee-on-transfer, buy 5%, sell 0', `(${b.status} ${b.buyTaxBps}/${b.sellTaxBps})`);
        const t = await p('bothTax');
        ok(t.status === 'honeypot' && Math.abs(t.sellTaxBps - 500) <= 1 && /can't take a taxed sell/.test(t.reason), 'taxed into the pool → honeypot, sell tax measured', `(${t.status} ${t.buyTaxBps}/${t.sellTaxBps}: ${t.reason})`);
        const s = await p('sellsOff');
        ok(s.status === 'honeypot' && s.stage === 3, 'holders can\'t send to the pool → honeypot at the sell transfer', `(${s.status} stage ${s.stage}: ${s.reason})`);
        const o = await p('buysOff');
        ok(o.status === 'honeypot' && o.stage === 2, 'the pool can\'t send it out ("TF") → honeypot at the buy', `(${o.status} stage ${o.stage}: ${o.reason})`);
    }

    console.log('\n4. safety');
    for (const n of ['uniswapV3SwapCallback', 'pancakeV3SwapCallback', 'algebraSwapCallback']) {
        let e = null;
        try { await probe[n].staticCall(1, 0, '0x'); } catch (err) { e = err?.revert?.name ?? err?.shortMessage ?? String(err); }
        ok(/NotPool/.test(String(e)), `direct ${n} → NotPool`, `(${e})`);
    }
    const self = await probeCLPool(provider, PROBE, R, lenders.univ3, AMOUNT, { source: SRC.univ3, lender: lenders.univ3 });
    ok(self.status === 'error' && /TokenNotInLender/.test(self.reason), 'probing the V3 lender itself → lender config error, not a verdict', `(${self.reason})`);
    ok(await probeSupportsCL(provider, PROBE) && await probeSupportsLenders(provider, PROBE), 'probeSupportsCL / probeSupportsLenders → yes on the new probe');
    ok(!(await probeSupportsCL(provider, lenders.morpho)), 'probeSupportsCL → no on another contract');

    console.log('\n5. nothing persists');
    const after = await bal();
    ok(before.every((v, i) => v === after[i]), 'every lender\'s and pool\'s root balance unchanged');
    ok((await root.balanceOf(PROBE)) === 0n, 'probe holds nothing');
} finally {
    anvil.kill();
}

console.log(fails === 0 ? '\nALL PROBE-CL CHECKS PASS' : `\n${fails} FAILED`);
process.exit(fails ? 1 : 0);
