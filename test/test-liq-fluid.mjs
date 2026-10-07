// Fluid vault liquidations. The lending side (resolver + vault) is a MOCK that
// matches the shapes my code calls: the FluidVaultLiquidationResolver's
// getAllVaultsSwap() return, and the vault's liquidate(debtAmt, colPerUnitDebt,
// to, absorb). Real: LiquidationExecutor (+HopEngine, the flash + liquidate +
// swap path), the real FluidScanner parsing, the real planner, real exit pools,
// a real Morpho flash loan, and the ledger. Fluid's liquidity layer + vault is
// a large system; a faithful mock is the project's convention for the lending
// side. Fluid is a per-vault poll (no borrower watchlist), so there is no
// HealthMonitor here.
//
//   node --experimental-strip-types test/test-liq-fluid.mjs       (anvil on PATH)
//
//   1. Scanner parses getAllVaultsSwap into opportunities; native legs skipped.
//   2. colPerUnitDebt matches the resolver's getSwapTx formula.
//   3. liquidateFluid end to end: flash USDC, liquidate the vault, swap WETH
//      back, repay; realised == executor gain == ledger.
//   4. A colPerUnitDebt above what the vault pays reverts (slippage guard).
//   5. Safety: NotOwner.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import Database from 'better-sqlite3';
import { ethers } from 'ethers';

const require = createRequire(import.meta.url);
const here = (p) => new URL(p, import.meta.url);
let fails = 0;
const ok = (c, l, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${l} ${extra}`); if (!c) fails++; };

const FL = `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
interface IERC20 { function transfer(address,uint256) external returns (bool); function transferFrom(address,address,uint256) external returns (bool); function balanceOf(address) external view returns (uint256); }

// A Fluid T1 vault: repay debt token, receive collateral token at a fixed rate.
contract Vault {
    address public debt; address public col; uint256 public colPerDebt;   // collateral per 1e18 debt (1e18)
    constructor(address d, address c, uint256 rate) { debt = d; col = c; colPerDebt = rate; }
    error FluidLiquidateResult(uint256 colLiquidated, uint256 debtLiquidated);
    function liquidate(uint256 debtAmt, uint256 colPerUnitDebt, address to, bool) external payable returns (uint256, uint256) {
        require(IERC20(debt).transferFrom(msg.sender, address(this), debtAmt), "pull");
        uint256 colAmt = debtAmt * colPerDebt / 1e18;
        require(colAmt * 1e18 / debtAmt >= colPerUnitDebt, "slippage");
        require(IERC20(col).transfer(to, colAmt), "xfer");
        return (debtAmt, colAmt);
    }
}

// Minimal FluidVaultLiquidationResolver: one vault, one opportunity.
contract Resolver {
    struct SwapPath { address protocol; address tokenIn; address tokenOut; }
    struct SwapData { uint256 inAmt; uint256 outAmt; bool withAbsorb; uint256 ratio; }
    struct Swap { SwapPath path; SwapData data; }
    address public vault; address public tokenIn; address public tokenOut; uint256 public inAmt; uint256 public outAmt;
    function set(address v, address ti, address to, uint256 i, uint256 o) external { vault=v; tokenIn=ti; tokenOut=to; inAmt=i; outAmt=o; }
    function getAllVaultsSwap() external view returns (Swap[] memory swaps) {
        if (vault == address(0)) return new Swap[](0);
        swaps = new Swap[](1);
        swaps[0] = Swap(SwapPath(vault, tokenIn, tokenOut), SwapData(inAmt, outAmt, false, outAmt * 1e27 / inAmt));
    }
}`;

const solc = require('solc');
const out = JSON.parse(solc.compile(JSON.stringify({
    language: 'Solidity',
    sources: {
        'HopEngine.sol': { content: fs.readFileSync(here('../contracts/HopEngine.sol'), 'utf8') },
        'LiquidationExecutor.sol': { content: fs.readFileSync(here('../contracts/LiquidationExecutor.sol'), 'utf8') },
        'Mocks.sol': { content: fs.readFileSync(here('./Mocks.sol'), 'utf8') },
        'Multicall3Min.sol': { content: fs.readFileSync(here('./Multicall3Min.sol'), 'utf8') },
        'Fl.sol': { content: FL },
    },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'shanghai',
                outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } } },
}), { import: (p) => ({ contents: fs.readFileSync(here('../contracts/' + p.replace(/^\.\//, '')), 'utf8') }) }));
for (const e of out.errors ?? []) if (e.severity === 'error') { console.error(e.formattedMessage); process.exit(1); }
const art = {};
for (const [, cs] of Object.entries(out.contracts)) for (const [n, c] of Object.entries(cs))
    art[n] = { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object, runtime: '0x' + c.evm.deployedBytecode.object };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fluid-'));
process.env.ARB_LEDGER = path.join(tmp, 'ledger.sqlite');

const { MULTICALL3_ADDRESS } = await import('../source/util/multicall.ts');
const { UsdOracle } = await import('../source/liquidation/usd.ts');
const { DexUsd } = await import('../source/liquidation/dex-usd.ts');
const { FluidScanner } = await import('../source/liquidation/fluid.ts');
const { LenderBook } = await import('../source/liquidation/lenders.ts');
const { VenueLiquidator, VENUE_LIQUIDATOR_ABI } = await import('../source/liquidation/plan-venues.ts');
const { RouteFinder } = await import('../source/liquidation/plan.ts');

const PORT = 8561;
const anvil = spawn('anvil', ['--port', String(PORT), '--silent', '--disable-code-size-limit', '--gas-limit', '300000000']);
await new Promise(r => setTimeout(r, 1500));
const provider = new ethers.JsonRpcProvider(`http://127.0.0.1:${PORT}`, undefined, { cacheTimeout: -1, staticNetwork: true });
const owner = new ethers.Wallet('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', provider);
const stranger = new ethers.Wallet('0x59c6995e998f97a5a0044966f0945389dc9c86dae88c7a8412f4603b6b78690d', provider);
const BIG = { gasLimit: 60_000_000n };
const deploy = async (a, ...args) => { const c = await new ethers.ContractFactory(a.abi, a.bytecode, owner).deploy(...args, BIG); await c.waitForDeployment(); return c; };
const send = async (p) => (await p).wait();
const u = (n, d) => ethers.parseUnits(String(n), d);
const fmt = (v, d) => Number(ethers.formatUnits(v, d)).toFixed(4);
const WAD = 10n ** 18n;

try {
    await provider.send('anvil_setCode', [MULTICALL3_ADDRESS, art.Multicall3Min.runtime]);
    await provider.send('anvil_setBalance', [stranger.address, '0x56BC75E2D63100000']);

    const mtok = async (s) => { const t = await deploy(art.MockToken, s, 0); return { c: t, a: (await t.getAddress()).toLowerCase() }; };
    const USDC = await mtok('USDC'), WETH = await mtok('WETH');
    // Vault pays WETH for USDC at ~$2571/WETH (a discount to the $2700 pool price: that spread is the profit).
    const rate = u(1, 18) * WAD / u(2571, 18);   // WETH per 1e18 USDC
    const vault = await deploy(art.Vault, USDC.a, WETH.a, rate);
    const VAULT = (await vault.getAddress()).toLowerCase();
    await send(WETH.c.mint(VAULT, u(1000, 18)));   // vault custodies collateral to pay out
    const resolver = await deploy(art.Resolver);
    const RES = await resolver.getAddress();
    const inAmt = u(10_000, 18);                   // repay 10,000 USDC
    const outAmt = inAmt * rate / WAD;             // ~3.889 WETH
    await send(resolver.set(VAULT, USDC.a, WETH.a, inAmt, outAmt));

    // Exit pool WETH->USDC at $2700, and the route DB.
    const pair = async (a, b, ra, rb) => { const p = await deploy(art.MockPair, a.a, b.a, 30); const A = await p.getAddress(); await send(a.c.mint(A, ra)); await send(b.c.mint(A, rb)); await send(p.sync()); return A; };
    const WETH_USDC = await pair(WETH, USDC, u(10_000, 18), u(27_000_000, 18));
    const dbFile = path.join(tmp, 'pools.sqlite');
    const pdb = new Database(dbFile);
    pdb.exec(`CREATE TABLE pairs (address TEXT, factory TEXT, token0 TEXT, token1 TEXT, blockNumber INTEGER, fee REAL, stable INTEGER, kind TEXT, tickSpacing INTEGER);
              CREATE TABLE reserves (pair TEXT PRIMARY KEY, reserves0 TEXT, reserves1 TEXT, blockNumber INTEGER, updatedAt INTEGER);
              CREATE TABLE pool_state (pool TEXT PRIMARY KEY, sqrtPriceX96 TEXT, tick INTEGER, liquidity TEXT, fee INTEGER, tickSpacing INTEGER, windowLow INTEGER, windowHigh INTEGER, blockNumber INTEGER, updatedAt INTEGER);
              CREATE TABLE tokens (address TEXT PRIMARY KEY, symbol TEXT, name TEXT, decimals INTEGER, fetchStatus TEXT, fetchedAt INTEGER, discoveredAt INTEGER);`);
    for (const [a, s] of [[USDC.a, 'USDC'], [WETH.a, 'WETH']]) pdb.prepare("INSERT INTO tokens VALUES (?,?,?,18,'ok',0,0)").run(a, s, s);
    const V2F = '0x00000000000000000000000000000000000000f2';
    const sorted = (a, b) => (a < b ? [a, b] : [b, a]);
    const [t0, t1] = sorted(WETH.a, USDC.a);
    pdb.prepare('INSERT INTO pairs VALUES (?,?,?,?,1,NULL,NULL,?,NULL)').run(WETH_USDC.toLowerCase(), V2F, t0, t1, 'v2');
    const [r0, r1] = t0 === WETH.a ? [u(10_000, 18), u(27_000_000, 18)] : [u(27_000_000, 18), u(10_000, 18)];
    pdb.prepare('INSERT INTO reserves VALUES (?,?,?,1,1)').run(WETH_USDC.toLowerCase(), String(r0), String(r1));
    pdb.close();

    const cfg = { chain: { id: 31337, label: 'anvil', name: 'Anvil', token: WETH.a }, factories: [{ address: V2F, group: 'v2', fee: 0.003, name: 'mockv2' }], flashloan: undefined };
    const routes = new RouteFinder(cfg, dbFile, [WETH.a, USDC.a]);
    const exec = await deploy(art.LiquidationExecutor);
    const EXEC = await exec.getAddress();
    const dexUsd = new DexUsd(dbFile, WETH.a);
    const usd = new UsdOracle(provider, null, 60_000, (t) => dexUsd.priceUsd(t));
    await usd.tokenMeta([USDC.a, WETH.a]);
    const morpho = await deploy(art.MockMorpho);
    const MORPHO = (await morpho.getAddress()).toLowerCase();
    await send(USDC.c.mint(MORPHO, u(1_000_000, 18)));
    const lenders = new LenderBook(provider, cfg, null, { morpho: MORPHO });
    const mkVL = (o = {}) => new VenueLiquidator(cfg, provider, routes, lenders, usd, { executor: EXEC, owner: owner.address, signer: owner, live: false, minProfitUsd: 1, ...o });

    const scanner = new FluidScanner(provider, RES, usd);

    console.log('1. scanner parses opportunities');
    let opp;
    {
        const opps = await scanner.opportunities();
        ok(opps.length === 1, 'one opportunity from getAllVaultsSwap', `${opps.length}`);
        opp = opps[0];
        ok(opp.vault === VAULT && opp.debt === USDC.a && opp.collateral === WETH.a, 'vault / debt / collateral parsed', `${opp.debt.slice(0,8)}→${opp.collateral.slice(0,8)}`);
        ok(opp.inAmt === inAmt && opp.outAmt === outAmt, 'in/out amounts parsed');
        // native-leg filter
        await send(resolver.set(VAULT, '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', WETH.a, inAmt, outAmt));
        ok((await scanner.opportunities()).length === 0, 'a native-token leg is skipped');
        await send(resolver.set(VAULT, USDC.a, WETH.a, inAmt, outAmt));
    }

    console.log('2. colPerUnitDebt matches the resolver formula');
    {
        const cpd = scanner.colPerUnitDebt(opp, 50);
        const expect = (outAmt * WAD / inAmt) * 9950n / 10000n;
        ok(cpd === expect, 'outAmt/inAmt x 1e18 less 0.5% slippage', `${fmt(cpd, 18)}`);
    }

    console.log('3. liquidateFluid end to end');
    {
        const before = await USDC.c.balanceOf(EXEC);
        const dry = await mkVL().attemptFluid(scanner, opp);
        ok(dry.simulated && !dry.broadcast, 'dry run simulated', dry.reason ?? fmt(dry.best?.profit ?? 0n, 18));
        const live = await mkVL({ live: true }).attemptFluid(scanner, opp);
        const gain = (await USDC.c.balanceOf(EXEC)) - before;
        ok(live.confirmed, 'broadcast and confirmed', live.reason ?? live.txHash);
        ok(live.realisedProfit === gain && gain > 0n, 'realised profit (event) == USDC gained', fmt(gain, 18));
        // 3.889 WETH sold into the $2700 pool ≈ $10,470; less the $10,000 repaid and fees ≈ $450.
        ok(gain > u(350, 18) && gain < u(550, 18), 'profit = vault discount less swap fee & slippage (~$450)', fmt(gain, 18));
        const L = new Database(process.env.ARB_LEDGER, { readonly: true });
        const row = L.prepare('SELECT * FROM trades ORDER BY rowid DESC').get(); L.close();
        ok(row?.type === 'liquidation' && BigInt(row.profitWei) === gain, 'ledger row: liquidation, realised profit', row?.profitWei);
    }

    console.log('4. slippage guard');
    {
        // Ask for more collateral per debt than the vault pays: liquidate() must revert.
        const X = new ethers.Contract(EXEC, VENUE_LIQUIDATOR_ABI, owner);
        const tooHigh = (outAmt * WAD / inAmt) * 2n;   // 2x the real rate
        let reverted = false;
        try { await X.liquidateFluid.staticCall(3, MORPHO, [VAULT, WETH.a, USDC.a, inAmt, tooHigh, false, 0n], [[WETH_USDC, WETH.a, 3000, EXEC, 0]]); }
        catch { reverted = true; }
        ok(reverted, 'colPerUnitDebt above the vault rate reverts');
    }

    console.log('5. safety');
    {
        const X = new ethers.Contract(EXEC, VENUE_LIQUIDATOR_ABI, stranger);
        let e = null;
        try { await X.liquidateFluid.staticCall(3, MORPHO, [VAULT, WETH.a, USDC.a, inAmt, scanner.colPerUnitDebt(opp), false, 0n], [[WETH_USDC, WETH.a, 3000, EXEC, 0]]); } catch (x) {
            for (const d of [x?.data, x?.info?.error?.data, x?.error?.data]) if (typeof d === 'string' && d.length >= 10) { try { e = exec.interface.parseError(d)?.name; } catch {} }
            e ??= x?.shortMessage;
        }
        ok(e === 'NotOwner', 'stranger liquidateFluid -> NotOwner', e);
    }
    dexUsd.close();
    routes.close();
} catch (e) {
    console.error(e);
    fails++;
} finally {
    anvil.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
