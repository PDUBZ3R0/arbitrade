// Euler V2 as a liquidation venue. The lending side is a MOCK — but one that
// implements the pieces my code depends on: the EVC on-behalf-of context and
// batch (checks deferred), accountLiquidity/checkLiquidation with a
// health-dependent discount, and liquidate/redeem/repay. The real pieces are
// LiquidationExecutor (+HopEngine, the EVC batch + onEulerLiquidate callback),
// the real planner (plan-venues.ts), real exit pools and the ledger. Euler's
// EVK+EVC is a large module system behind a factory; a faithful mock is the
// project's convention for the lending side (cf. test-liquidate / test-liq-cv2).
// NOTE: because the EVC is mocked, this does not exercise the REAL EVC's
// authentication — dry-run Euler on a fork/testnet before enabling it live.
//
//   node --experimental-strip-types test/test-liq-euler.mjs      (anvil on PATH)
//
//   1. Discovery: vaults from the factory; Borrow adds `account:liability`.
//   2. Health: our HF matches the vault's accountLiquidity on both sides of 1.
//   3. liquidateEuler end to end: EVC batch assumes the debt, redeems the seized
//      shares, swaps, repays; realised == executor gain == ledger; debt cleared.
//   4. onEulerLiquidate is guarded (direct call -> NotPool).
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

const EUL = `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
interface IERC20 { function transfer(address,uint256) external returns (bool); function transferFrom(address,address,uint256) external returns (bool); function balanceOf(address) external view returns (uint256); }

// Shared oracle + risk params (USD, 1e18 per whole token; ltv in 1e4).
contract Reg {
    mapping(address => uint256) public price;              // by vault
    mapping(address => mapping(address => uint256)) public ltv;   // liability -> collateral -> 1e4
    uint256 public constant MAX_DISCOUNT = 0.2e18;
    function setPrice(address v, uint256 p) external { price[v] = p; }
    function setLtv(address liab, address coll, uint256 l) external { ltv[liab][coll] = l; }
}

contract EVC {
    mapping(address => address[]) public cols;
    mapping(address => address) public controller;
    address public onBehalf;
    function enableCollateral(address a, address v) external { for (uint i;i<cols[a].length;i++) if (cols[a][i]==v) return; cols[a].push(v); }
    function enableController(address a, address v) external { controller[a] = v; }
    function getCollaterals(address a) external view returns (address[] memory) { return cols[a]; }
    function getControllers(address a) external view returns (address[] memory) { address[] memory r = new address[](controller[a]==address(0)?0:1); if (r.length==1) r[0]=controller[a]; return r; }
    function getCurrentOnBehalfOfAccount(address) external view returns (address, bool) { return (onBehalf, false); }
    struct BatchItem { address targetContract; address onBehalfOfAccount; uint256 value; bytes data; }
    function batch(BatchItem[] calldata items) external payable {
        for (uint i; i < items.length; i++) {
            onBehalf = items[i].onBehalfOfAccount;
            (bool okc, bytes memory ret) = items[i].targetContract.call(items[i].data);
            if (!okc) { assembly { revert(add(ret,32), mload(ret)) } }
        }
        onBehalf = address(0);
    }
}

// An EVK-style vault: lends asset, mints 1:1 shares for collateral, tracks debt.
contract EVault {
    address public asset; string public symbol; address public unitOfAccount; EVC public evc; Reg public reg;
    mapping(address => uint256) public balanceOf;          // collateral shares
    mapping(address => uint256) public debtOf;
    constructor(address a, string memory s, address _evc, address _reg) { asset = a; symbol = s; evc = EVC(_evc); reg = Reg(_reg); unitOfAccount = 0x0000000000000000000000000000000000000348; }
    function convertToAssets(uint256 sh) public pure returns (uint256) { return sh; }
    // Seed a borrower: collateral shares in this (collateral) vault, debt in the liability vault.
    function mintShares(address to, uint256 sh) external { balanceOf[to] += sh; IERC20(asset); }
    function setDebt(address a, uint256 d) external { debtOf[a] = d; }
    event Borrow(address indexed account, uint256 assets);
    function emitBorrow(address a, uint256 d) external { debtOf[a] += d; emit Borrow(a, d); }
    event Liquidate(address indexed liquidator, address indexed violator, address collateral, uint256 repayAssets, uint256 yieldBalance);

    function _onBehalf() internal view returns (address) { (address a,) = evc.getCurrentOnBehalfOfAccount(address(this)); return a == address(0) ? msg.sender : a; }

    // Risk-adjusted collateral vs liability, in USD 1e18 (this = liability vault).
    function accountLiquidity(address account, bool) public view returns (uint256 collateralValue, uint256 liabilityValue) {
        liabilityValue = debtOf[account] * reg.price(address(this)) / 1e18;
        address[] memory cs = evc.getCollaterals(account);
        for (uint i; i < cs.length; i++) {
            uint256 v = EVault(cs[i]).balanceOf(account) * reg.price(cs[i]) / 1e18;
            collateralValue += v * reg.ltv(address(this), cs[i]) / 1e4;
        }
    }
    function checkLiquidation(address, address violator, address collateral) public view returns (uint256 maxRepay, uint256 maxYield) {
        (uint256 c, uint256 l) = accountLiquidity(violator, true);
        if (l == 0 || c >= l) return (0, 0);
        uint256 health = c * 1e18 / l;                      // < 1e18
        uint256 discount = 1e18 - health; if (discount > reg.MAX_DISCOUNT()) discount = reg.MAX_DISCOUNT();
        maxRepay = debtOf[violator];                        // allow full repay
        uint256 repayValue = maxRepay * reg.price(address(this)) / 1e18;
        uint256 yieldValue = repayValue * 1e18 / (1e18 - discount);
        maxYield = yieldValue * 1e18 / reg.price(collateral);
        uint256 have = EVault(collateral).balanceOf(violator);
        if (maxYield > have) { maxYield = have; }
    }
    // Assume repay of the violator's debt; seize collateral shares to the liquidator.
    function liquidate(address violator, address collateral, uint256 repay, uint256 minYield) external {
        address liq = _onBehalf();
        (uint256 maxRepay, uint256 maxYield) = checkLiquidation(liq, violator, collateral);
        require(repay <= maxRepay && maxRepay > 0, "excessive");
        uint256 yield = maxYield * repay / maxRepay;
        require(yield >= minYield, "minYield");
        debtOf[violator] -= repay; debtOf[liq] += repay;
        EVault(collateral).seizeShares(violator, liq, yield);
        emit Liquidate(liq, violator, collateral, repay, yield);
    }
    function seizeShares(address from, address to, uint256 sh) external { require(balanceOf[from] >= sh, "sh"); balanceOf[from] -= sh; balanceOf[to] += sh; }
    // Redeem shares for underlying (collateral vault holds the asset).
    function redeem(uint256 sh, address to, address owner) external returns (uint256) {
        address a = _onBehalf(); require(a == owner, "owner");
        require(balanceOf[owner] >= sh, "bal"); balanceOf[owner] -= sh;
        require(IERC20(asset).transfer(to, sh), "xfer"); return sh;   // 1:1
    }
    // Repay assumed debt (liability vault).
    function repay(uint256 amount, address receiver) external returns (uint256) {
        if (amount > debtOf[receiver]) amount = debtOf[receiver];
        require(IERC20(asset).transferFrom(msg.sender, address(this), amount), "pull");
        debtOf[receiver] -= amount; return amount;
    }
    function disableController() external { }
}

contract Factory {
    address[] public list;
    function add(address v) external { list.push(v); }
    function getProxyListLength() external view returns (uint256) { return list.length; }
    function getProxyListSlice(uint256 s, uint256 e) external view returns (address[] memory r) { r = new address[](e - s); for (uint i=s;i<e;i++) r[i-s]=list[i]; }
}`;

const solc = require('solc');
const out = JSON.parse(solc.compile(JSON.stringify({
    language: 'Solidity',
    sources: {
        'HopEngine.sol': { content: fs.readFileSync(here('../contracts/HopEngine.sol'), 'utf8') },
        'LiquidationExecutor.sol': { content: fs.readFileSync(here('../contracts/LiquidationExecutor.sol'), 'utf8') },
        'Mocks.sol': { content: fs.readFileSync(here('./Mocks.sol'), 'utf8') },
        'Multicall3Min.sol': { content: fs.readFileSync(here('./Multicall3Min.sol'), 'utf8') },
        'Eul.sol': { content: EUL },
    },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'shanghai',
                outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } } },
}), { import: (p) => ({ contents: fs.readFileSync(here('../contracts/' + p.replace(/^\.\//, '')), 'utf8') }) }));
for (const e of out.errors ?? []) if (e.severity === 'error') { console.error(e.formattedMessage); process.exit(1); }
const art = {};
for (const [, cs] of Object.entries(out.contracts)) for (const [n, c] of Object.entries(cs))
    art[n] = { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object, runtime: '0x' + c.evm.deployedBytecode.object };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eul-'));
process.env.ARB_LEDGER = path.join(tmp, 'ledger.sqlite');

const { MULTICALL3_ADDRESS } = await import('../source/util/multicall.ts');
const { UsdOracle } = await import('../source/liquidation/usd.ts');
const { DexUsd } = await import('../source/liquidation/dex-usd.ts');
const { EulerVenue } = await import('../source/liquidation/euler.ts');
const { VenueLiquidator, VENUE_LIQUIDATOR_ABI } = await import('../source/liquidation/plan-venues.ts');
const { RouteFinder } = await import('../source/liquidation/plan.ts');
const { LiqDB } = await import('../source/liquidation/watchlist-db.ts');
const { HealthMonitor } = await import('../source/liquidation/health.ts');
const { tailRpc } = await import('../source/liquidation/events.ts');

const PORT = 8560;
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
const head = () => provider.getBlockNumber();
const WAD = 10n ** 18n;
const hfNum = (h) => Number(h) / 1e18;

try {
    await provider.send('anvil_setCode', [MULTICALL3_ADDRESS, art.Multicall3Min.runtime]);
    await provider.send('anvil_setBalance', [stranger.address, '0x56BC75E2D63100000']);

    const mtok = async (s) => { const t = await deploy(art.MockToken, s, 0); return { c: t, a: (await t.getAddress()).toLowerCase() }; };
    const USDC = await mtok('USDC'), WETH = await mtok('WETH');
    const reg = await deploy(art.Reg);
    const evc = await deploy(art.EVC);
    const EVCA = (await evc.getAddress());
    const factory = await deploy(art.Factory);
    const mkVault = async (asset, sym) => { const v = await deploy(art.EVault, asset.a, sym, EVCA, await reg.getAddress()); const A = (await v.getAddress()); await send(factory.add(A)); return { v, a: A.toLowerCase() }; };
    const vUSDC = await mkVault(USDC, 'eUSDC');   // liability vault (USDC borrowed)
    const vWETH = await mkVault(WETH, 'eWETH');   // collateral vault (WETH)
    // Prices (USD 1e18): USDC $1, WETH $3000. Liquidation LTV WETH->(as collateral under USDC liability) 0.8.
    await send(reg.setPrice(vUSDC.a, u(1, 18)));
    await send(reg.setPrice(vWETH.a, u(3000, 18)));
    await send(reg.setLtv(vUSDC.a, vWETH.a, 8000));
    // The collateral vault custodies its underlying so redeem can pay out.
    await send(WETH.c.mint(vWETH.a, u(100, 18)));

    // Exit pool WETH->USDC and route DB.
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
    const lenders = { pick: async () => ({ source: 3, lender: ethers.ZeroAddress, label: 'n/a', feeBps: 0 }) };   // Euler needs no flash
    const mkVL = (o = {}) => new VenueLiquidator(cfg, provider, routes, lenders, usd, { executor: EXEC, owner: owner.address, signer: owner, live: false, minProfitUsd: 1, ...o });

    const venue = new EulerVenue(provider, EVCA, await factory.getAddress(), usd);
    await venue.init();

    // Borrower: 10 WETH collateral ($30k), $23k USDC debt. HF = 30000*0.8/23000 = 1.043.
    const B = ethers.Wallet.createRandom().address;
    await send(vWETH.v.mintShares(B, u(10, 18)));
    await send(evc.enableCollateral(B, vWETH.a));
    await send(evc.enableController(B, vUSDC.a));
    await send(vUSDC.v.emitBorrow(B, u(23_000, 18)));
    // Also enable the executor's collateral/controller is done inside liquidateEuler.

    console.log('1. discovery + events');
    const db = new LiqDB(path.join(tmp, 'eul.sqlite'), venue.key);
    {
        ok(venue.vaults.size === 2 && venue.vaults.has(vUSDC.a) && venue.vaults.has(vWETH.a), 'vaults enumerated from the factory', `${venue.vaults.size}`);
        await tailRpc(provider, db, 0, await head(), { source: venue });
        const users = new Set(db.accounts().map(a => a.user));
        ok(users.has(`${B.toLowerCase()}:${vUSDC.a}`), 'Borrow tracks account:liability', [...users].join(','));
    }

    console.log('2. health vs accountLiquidity');
    const mon = new HealthMonitor(provider, venue, db, { watchEvery: 1000, sweepMs: 1_000_000 }, () => 0);
    {
        await mon.sweep(await head());
        const a = mon.accounts.get(`${B.toLowerCase()}:${vUSDC.a}`);
        ok(a && Math.abs(hfNum(a.hf) - 30000 * 0.8 / 23000) < 1e-3, 'HF = risk-adjusted collateral / liability', hfNum(a?.hf ?? 0n).toFixed(5));
        const [c, l] = await vUSDC.v.accountLiquidity(B, true);
        ok(c > l === (a.hf >= WAD), 'agrees with the vault at HF >= 1');
        await send(reg.setPrice(vWETH.a, u(2700, 18)));     // $27k*0.8=21.6k < 23k: unhealthy
        const x = (await venue.readAccounts([`${B.toLowerCase()}:${vUSDC.a}`])).accounts[0];
        const [c2, l2] = await vUSDC.v.accountLiquidity(B, true);
        ok(x.hf < WAD && c2 < l2, 'after a price drop both say liquidatable', `our HF ${hfNum(x.hf).toFixed(4)}`);
    }

    console.log('3. liquidateEuler end to end');
    {
        const key = `${B.toLowerCase()}:${vUSDC.a}`;
        const debtBefore = await vUSDC.v.debtOf(B);
        const dry = await mkVL().attemptEuler(venue, key);
        ok(dry.simulated && !dry.broadcast, 'dry run simulated', dry.reason ?? fmt(dry.best?.profit ?? 0n, 18));
        const before = await USDC.c.balanceOf(EXEC);
        const live = await mkVL({ live: true }).attemptEuler(venue, key);
        const gain = (await USDC.c.balanceOf(EXEC)) - before;
        ok(live.confirmed, 'broadcast and confirmed', live.reason ?? live.txHash);
        ok(live.realisedProfit === gain && gain > 0n, 'realised profit (event) == USDC gained', fmt(gain, 18));
        ok((await vUSDC.v.debtOf(B)) < debtBefore, "violator's debt reduced by the repay");
        ok((await vUSDC.v.debtOf(EXEC)) === 0n, 'the executor assumed then cleared the debt (no leftover liability)');
        const L = new Database(process.env.ARB_LEDGER, { readonly: true });
        const row = L.prepare('SELECT * FROM trades ORDER BY rowid DESC').get(); L.close();
        ok(row?.type === 'liquidation' && BigInt(row.profitWei) === gain, 'ledger row: liquidation, realised profit', row?.profitWei);
    }

    console.log('4. callback guard');
    {
        let e = null;
        const job = [EVCA, vUSDC.a, vWETH.a, WETH.a, USDC.a, B, 1n, 0n];
        try { await exec.onEulerLiquidate.staticCall(job, []); } catch (x) {
            for (const d of [x?.data, x?.info?.error?.data, x?.error?.data]) if (typeof d === 'string' && d.length >= 10) { try { e = exec.interface.parseError(d)?.name; } catch {} }
            e ??= x?.shortMessage;
        }
        ok(e === 'NotPool', 'direct onEulerLiquidate -> NotPool', e);
    }

    console.log('5. safety');
    {
        const X = new ethers.Contract(EXEC, VENUE_LIQUIDATOR_ABI, stranger);
        let e = null;
        try { await X.liquidateEuler.staticCall([EVCA, vUSDC.a, vWETH.a, WETH.a, USDC.a, B, u(1, 18), 0n], [[WETH_USDC, WETH.a, 3000, EXEC, 0]]); } catch (x) {
            for (const d of [x?.data, x?.info?.error?.data, x?.error?.data]) if (typeof d === 'string' && d.length >= 10) { try { e = exec.interface.parseError(d)?.name; } catch {} }
            e ??= x?.shortMessage;
        }
        ok(e === 'NotOwner', 'stranger liquidateEuler -> NotOwner', e);
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
