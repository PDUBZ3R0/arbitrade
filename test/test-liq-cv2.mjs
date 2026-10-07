// Compound V2 (and forks: Benqi, Moonwell, Sonne) as a liquidation venue.
//
// Unlike the Morpho/Comet suite, the lending side here is a MOCK — but one that
// implements Compound V2's exact money-deciding math: getAccountSnapshot,
// getAccountLiquidity's weighted collateral vs borrow, the close-factor cap, and
// liquidateCalculateSeizeTokens (incentive x priceBorrow / (priceColl x exRate)).
// The real pieces are LiquidationExecutor (+HopEngine), the real planner
// (plan-venues.ts), a real Morpho flash loan picked by the LenderBook, real
// constant-product exit pairs, and the real ledger. Compound V2 is solc 0.5.16
// behind a Unitroller delegate; a faithful mock is the project's convention for
// the lending side (see test-liquidate.mjs), where the executor/planner are real.
//
//   node --experimental-strip-types test/test-liq-cv2.mjs     (anvil on PATH)
//
//   1. Events: Borrow adds `borrower:comptroller`; a supplier is not tracked.
//   2. Health: our HF, debt and collateral match the mock Comptroller's
//      getAccountLiquidity on both sides of the threshold.
//   3. HealthMonitor: a price drop flips the exposed account to liquidatable.
//   4. liquidateCompoundV2 end to end: flash USDC from Morpho, liquidateBorrow,
//      redeem the seized cToken, swap back; realised == executor gain == ledger;
//      the borrow shrank by the repay and the collateral by the seize.
//   5. Native-leg collateral (cETH-style) is skipped as a seize leg.
//   6. Safety: NotOwner.

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

const CV2 = `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract CErc20 {
    string public symbol; uint8 public decimals = 8;
    address public underlying;                      // address(0) = native-coin market
    uint256 public exchangeRateStored;              // 1e18-scaled underlying per cToken-wei... see mint
    Comptroller public comptroller;
    mapping(address => uint256) public balanceOf;   // cToken balance
    mapping(address => uint256) public borrowBalanceStored;
    constructor(string memory s, address u, uint256 exRate, address c) { symbol = s; underlying = u; exchangeRateStored = exRate; comptroller = Comptroller(c); }
    function setBorrow(address a, uint256 v) external { borrowBalanceStored[a] = v; }
    function mintFor(address a, uint256 cTok) external { balanceOf[a] += cTok; }
    function getAccountSnapshot(address a) external view returns (uint256,uint256,uint256,uint256) {
        return (0, balanceOf[a], borrowBalanceStored[a], exchangeRateStored);
    }
    // Liquidator repays some of THIS market's underlying and seizes cTokenColl.
    function liquidateBorrow(address borrower, uint256 repay, address cTokenColl) external returns (uint256) {
        require(repay <= borrowBalanceStored[borrower] * comptroller.closeFactorMantissa() / 1e18, "TOO_MUCH_REPAY");
        require(IERC20(underlying).transferFrom(msg.sender, address(this), repay), "pull");
        borrowBalanceStored[borrower] -= repay;
        uint256 seize = comptroller.liquidateCalculateSeizeTokens(address(this), cTokenColl, repay);
        require(CErc20(cTokenColl).seize(borrower, msg.sender, seize), "seize");
        return 0;
    }
    function seize(address from, address to, uint256 cTok) external returns (bool) {
        require(balanceOf[from] >= cTok, "coll"); balanceOf[from] -= cTok; balanceOf[to] += cTok; return true;
    }
    // Redeem cTokens for underlying (ERC20 markets only).
    function redeem(uint256 cTok) external returns (uint256) {
        require(balanceOf[msg.sender] >= cTok, "bal"); balanceOf[msg.sender] -= cTok;
        require(underlying != address(0), "native");
        uint256 u = cTok * exchangeRateStored / 1e18;
        require(IERC20(underlying).transfer(msg.sender, u), "xfer");
        return 0;
    }
    event Borrow(address indexed borrower, uint256 borrowAmount, uint256 accountBorrows, uint256 totalBorrows);
    function emitBorrow(address b, uint256 amt) external { borrowBalanceStored[b] += amt; emit Borrow(b, amt, borrowBalanceStored[b], 0); }
}

interface IERC20 { function transfer(address,uint256) external returns (bool); function transferFrom(address,address,uint256) external returns (bool); }

contract Oracle {
    mapping(address => uint256) public getUnderlyingPrice;   // 1e(36-dec)
    function set(address c, uint256 p) external { getUnderlyingPrice[c] = p; }
}

contract Comptroller {
    address public oracle;
    uint256 public closeFactorMantissa = 0.5e18;
    uint256 public liquidationIncentiveMantissa = 1.08e18;
    address[] public allMarkets;
    mapping(address => uint256) public cf;                 // collateral factor per cToken
    mapping(address => bool) listed;
    mapping(address => address[]) assetsIn;
    constructor(address o) { oracle = o; }
    function getAllMarkets() external view returns (address[] memory) { return allMarkets; }
    function support(address c, uint256 collFactor) external { allMarkets.push(c); cf[c] = collFactor; listed[c] = true; }
    function markets(address c) external view returns (bool, uint256) { return (listed[c], cf[c]); }
    function enter(address user, address c) external { assetsIn[user].push(c); }
    function getAssetsIn(address user) external view returns (address[] memory) { return assetsIn[user]; }
    function liquidateCalculateSeizeTokens(address cBorrowed, address cColl, uint256 repay) public view returns (uint256) {
        uint256 pB = Oracle(oracle).getUnderlyingPrice(cBorrowed);
        uint256 pC = Oracle(oracle).getUnderlyingPrice(cColl);
        uint256 exRate = CErc20(cColl).exchangeRateStored();
        uint256 numerator = liquidationIncentiveMantissa * pB / 1e18;
        uint256 denominator = pC * exRate / 1e18;
        uint256 ratio = numerator * 1e18 / denominator;
        return ratio * repay / 1e18;
    }
    // (err, liquidity, shortfall) — the real weighted-collateral vs borrow sum.
    function getAccountLiquidity(address user) external view returns (uint256, uint256, uint256) {
        uint256 coll; uint256 borrow;
        address[] memory a = assetsIn[user];
        for (uint256 i; i < a.length; i++) {
            (, uint256 cBal, uint256 bBal, uint256 ex) = CErc20(a[i]).getAccountSnapshot(user);
            uint256 p = Oracle(oracle).getUnderlyingPrice(a[i]);
            coll += (cBal * ex / 1e18) * p / 1e18 * cf[a[i]] / 1e18;
            borrow += bBal * p / 1e18;
        }
        if (coll >= borrow) return (0, coll - borrow, 0);
        return (0, 0, borrow - coll);
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
        'Cv2.sol': { content: CV2 },
    },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'shanghai',
                outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } } },
}), { import: (p) => ({ contents: fs.readFileSync(here('../contracts/' + p.replace(/^\.\//, '')), 'utf8') }) }));
for (const e of out.errors ?? []) if (e.severity === 'error') { console.error(e.formattedMessage); process.exit(1); }
const art = {};
for (const [, cs] of Object.entries(out.contracts)) for (const [n, c] of Object.entries(cs))
    art[n] = { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object, runtime: '0x' + c.evm.deployedBytecode.object };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cv2-'));
process.env.ARB_LEDGER = path.join(tmp, 'ledger.sqlite');

const { MULTICALL3_ADDRESS } = await import('../source/util/multicall.ts');
const { UsdOracle } = await import('../source/liquidation/usd.ts');
const { DexUsd } = await import('../source/liquidation/dex-usd.ts');
const { CompoundV2Venue } = await import('../source/liquidation/compound-v2.ts');
const { LenderBook } = await import('../source/liquidation/lenders.ts');
const { VenueLiquidator, VENUE_LIQUIDATOR_ABI } = await import('../source/liquidation/plan-venues.ts');
const { RouteFinder } = await import('../source/liquidation/plan.ts');
const { LiqDB } = await import('../source/liquidation/watchlist-db.ts');
const { HealthMonitor } = await import('../source/liquidation/health.ts');
const { tailRpc } = await import('../source/liquidation/events.ts');

const PORT = 8559;
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

    // MockToken is fixed at 18 decimals; keep every token 18dp so the on-chain
    // money math (exchange rate, oracle price, pool reserves) is self-consistent.
    const mtok = async (s) => { const t = await deploy(art.MockToken, s, 0); return { c: t, a: (await t.getAddress()).toLowerCase(), d: 18 }; };
    const USDC = await mtok('USDC'), WETH = await mtok('WETH');

    const oracle = await deploy(art.Oracle);
    const comp = await deploy(art.Comptroller, await oracle.getAddress());
    const COMP = (await comp.getAddress()).toLowerCase();
    // cToken exchange rate: 1 cToken(8dp) = 0.02 underlying -> exRate 0.02e18 scaled to underlying decimals.
    // Keep it simple: exRate such that cBal(1e8) * exRate/1e18 = underlying wei.
    const exUSDC = u(0.02, 18) * WAD / u(1, 8);   // underlying(18) per cToken(8)
    const exWETH = u(0.02, 18) * WAD / u(1, 8);
    const cUSDC = await deploy(art.CErc20, 'cUSDC', USDC.a, exUSDC, COMP);
    const cWETH = await deploy(art.CErc20, 'cWETH', WETH.a, exWETH, COMP);
    const cNATIVE = await deploy(art.CErc20, 'cETH', ethers.ZeroAddress, u(0.02, 18) * WAD / u(1, 8), COMP);
    const [CUSDC, CWETH, CNAT] = await Promise.all([cUSDC, cWETH, cNATIVE].map(async c => (await c.getAddress()).toLowerCase()));
    await send(comp.support(CUSDC, u(0.85, 18)));
    await send(comp.support(CWETH, u(0.80, 18)));
    await send(comp.support(CNAT, u(0.80, 18)));
    // Oracle prices: getUnderlyingPrice scaled 1e(36-dec). USDC $1 -> 1e30; WETH $3000 -> 3000e18.
    await send(oracle.set(CUSDC, u(1, 18)));   // 1e(36-18)
    await send(oracle.set(CWETH, u(3000, 18)));
    await send(oracle.set(CNAT, u(3000, 18)));

    // --- exit pool + route DB ---------------------------------------------------
    const pair = async (a, b, ra, rb) => {
        const p = await deploy(art.MockPair, a.a, b.a, 30); const A = await p.getAddress();
        await send(a.c.mint(A, ra)); await send(b.c.mint(A, rb)); await send(p.sync());
        return A;
    };
    const WETH_USDC = await pair(WETH, USDC, u(10_000, 18), u(27_000_000, 18));   // $2,700
    const dbFile = path.join(tmp, 'pools.sqlite');
    const pdb = new Database(dbFile);
    pdb.exec(`CREATE TABLE pairs (address TEXT, factory TEXT, token0 TEXT, token1 TEXT, blockNumber INTEGER, fee REAL, stable INTEGER, kind TEXT, tickSpacing INTEGER);
              CREATE TABLE reserves (pair TEXT PRIMARY KEY, reserves0 TEXT, reserves1 TEXT, blockNumber INTEGER, updatedAt INTEGER);
              CREATE TABLE pool_state (pool TEXT PRIMARY KEY, sqrtPriceX96 TEXT, tick INTEGER, liquidity TEXT, fee INTEGER, tickSpacing INTEGER, windowLow INTEGER, windowHigh INTEGER, blockNumber INTEGER, updatedAt INTEGER);
              CREATE TABLE tokens (address TEXT PRIMARY KEY, symbol TEXT, name TEXT, decimals INTEGER, fetchStatus TEXT, fetchedAt INTEGER, discoveredAt INTEGER);`);
    for (const [a, sym] of [[USDC.a, 'USDC'], [WETH.a, 'WETH']]) pdb.prepare("INSERT INTO tokens VALUES (?,?,?,18,'ok',0,0)").run(a, sym, sym);
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
    // No Aave oracle (the Robinhood case): USD comes from the pool DB via DexUsd.
    const dexUsd = new DexUsd(dbFile, WETH.a);
    const usd = new UsdOracle(provider, null, 60_000, (t) => dexUsd.priceUsd(t));

    // Morpho flash source: MockMorpho holding USDC.
    const morpho = await deploy(art.MockMorpho);
    const MORPHO = (await morpho.getAddress()).toLowerCase();
    await send(USDC.c.mint(MORPHO, u(1_000_000, 18)));
    const lenders = new LenderBook(provider, cfg, null, { morpho: MORPHO });
    const mkVL = (o = {}) => new VenueLiquidator(cfg, provider, routes, lenders, usd, { executor: EXEC, owner: owner.address, signer: owner, live: false, minProfitUsd: 1, ...o });

    const venue = new CompoundV2Venue(provider, { testfork: COMP }, usd, 'anvil');

    // --- borrowers ---------------------------------------------------------------
    // B1: WETH collateral, USDC debt. supply 10 WETH ($30k), cf 0.8 -> borrow up to $24k.
    const B1 = ethers.Wallet.createRandom().address;
    await send(WETH.c.mint(CWETH, u(10, 18)));                     // the cToken custodies the underlying
    await send(cWETH.mintFor(B1, u(10, 18) * WAD / exWETH));       // 10 WETH worth of cWETH
    await send(comp.enter(B1, CWETH));
    await send(comp.enter(B1, CUSDC));
    await send(cUSDC.emitBorrow(B1, u(23_000, 18)));                // $23k debt; HF = 24000/23000 = 1.043
    // A plain supplier (not tracked).
    const S = ethers.Wallet.createRandom().address;
    await send(cUSDC.mintFor(S, u(1000, 8)));

    console.log('1. events -> watchlist');
    const db = new LiqDB(path.join(tmp, 'cv2.sqlite'), venue.key);
    await venue.init();
    {
        await tailRpc(provider, db, 0, await head(), { source: venue });
        const users = new Set(db.accounts().map(a => a.user));
        ok(users.size === 1 && users.has(`${B1.toLowerCase()}:${COMP}`), 'Borrow tracks borrower:comptroller', [...users].join(','));
    }

    console.log('2. health vs the comptroller');
    const mon = new HealthMonitor(provider, venue, db, { watchEvery: 1000, sweepMs: 1_000_000 }, () => 0);
    {
        await mon.sweep(await head());
        const a = mon.accounts.get(`${B1.toLowerCase()}:${COMP}`);
        ok(a && Math.abs(hfNum(a.hf) - 24000 / 23000) < 1e-3, 'HF = weighted collateral / borrow', hfNum(a?.hf ?? 0n).toFixed(5));
        const [, liq, short] = await comp.getAccountLiquidity(B1);
        ok(short === 0n && liq > 0n && a.hf >= WAD, 'comptroller agrees: healthy (no shortfall)', `short ${short}`);
        await send(oracle.set(CWETH, u(2600, 18)));   // $26k coll -> weighted $20.8k < $23k: shortfall
        const x = (await venue.readAccounts([`${B1.toLowerCase()}:${COMP}`])).accounts[0];
        const [, , short2] = await comp.getAccountLiquidity(B1);
        ok(short2 > 0n && x.hf < WAD, 'after a price drop both say liquidatable', `our HF ${hfNum(x.hf).toFixed(4)}, shortfall ${short2 > 0n}`);
    }

    console.log('3. HealthMonitor price trigger');
    {
        await send(oracle.set(CWETH, u(3000, 18)));            // back to healthy
        await mon.tick(await head());
        await send(oracle.set(CWETH, u(2600, 18)));            // drop again
        const t = await mon.tick(await head());
        const tr = t.transitions.find(x => x.user === `${B1.toLowerCase()}:${COMP}`);
        ok(tr?.to === 'liquidatable', 'price drop -> liquidatable on the next tick', `${tr?.from}->${tr?.to}`);
    }

    console.log('4. liquidateCompoundV2 end to end');
    {
        const key = `${B1.toLowerCase()}:${COMP}`;
        const borrowBefore = await cUSDC.borrowBalanceStored(B1);
        const collBefore = await cWETH.balanceOf(B1);
        const dry = await mkVL().attemptCompoundV2(venue, key);
        ok(dry.simulated && !dry.broadcast, 'dry run simulated', dry.reason ?? fmt(dry.best?.profit ?? 0n, 18));
        const before = await USDC.c.balanceOf(EXEC);
        const live = await mkVL({ live: true }).attemptCompoundV2(venue, key);
        const gain = (await USDC.c.balanceOf(EXEC)) - before;
        ok(live.confirmed, 'broadcast and confirmed', live.reason ?? live.txHash);
        ok(live.realisedProfit === gain && gain > 0n, 'realised profit (event) == USDC gained', fmt(gain, 18));
        const repaid = borrowBefore - (await cUSDC.borrowBalanceStored(B1));
        ok(repaid > u(11_000, 18) && repaid <= u(11_500, 18), 'repaid ~50% close factor of $23k', fmt(repaid, 18));
        ok((await cWETH.balanceOf(B1)) < collBefore, 'collateral cTokens seized from the borrower');
        const L = new Database(process.env.ARB_LEDGER, { readonly: true });
        const row = L.prepare('SELECT * FROM trades ORDER BY rowid DESC').get(); L.close();
        ok(row?.type === 'liquidation' && BigInt(row.profitWei) === gain, 'ledger row: liquidation, realised profit', row?.profitWei);
    }

    console.log('5. native-leg collateral is skipped as a seize leg');
    {
        const B2 = ethers.Wallet.createRandom().address;
        await send(cNATIVE.mintFor(B2, u(10, 18) * WAD / (u(0.02, 18) * WAD / u(1, 8))));   // native collateral only
        await send(comp.enter(B2, CNAT));
        await send(comp.enter(B2, CUSDC));
        await send(cUSDC.emitBorrow(B2, u(23_000, 18)));
        await send(oracle.set(CNAT, u(2600, 18)));
        const r = await mkVL({ live: true }).attemptCompoundV2(venue, `${B2.toLowerCase()}:${COMP}`);
        ok(!r.simulated && /no ERC20 collateral/.test(r.reason ?? ''), 'native-only collateral: refused (no routable seize leg)', r.reason);
        const d = venue.describe({ user: `${B2.toLowerCase()}:${COMP}`, config: (await venue.readAccounts([`${B2.toLowerCase()}:${COMP}`])).accounts[0].config });
        ok(/⟡/.test(d), 'describe marks the native leg', d);
    }

    console.log('6. safety');
    {
        const X = new ethers.Contract(EXEC, VENUE_LIQUIDATOR_ABI, stranger);
        let e = null;
        try { await X.liquidateCompoundV2.staticCall(3, MORPHO, [CUSDC, CWETH, WETH.a, USDC.a, B1, u(1, 18), 0n], [[WETH_USDC, WETH.a, 3000, EXEC, 0]]); } catch (x) {
            for (const d of [x?.data, x?.info?.error?.data, x?.error?.data]) if (typeof d === 'string' && d.length >= 10) { try { e = exec.interface.parseError(d)?.name; } catch {} }
            e ??= x?.shortMessage;
        }
        ok(e === 'NotOwner', 'stranger -> NotOwner', e);
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
