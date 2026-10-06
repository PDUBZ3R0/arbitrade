// Liquidation watcher (source/liquidation/*) on a local anvil.
//
// The lending pool here is a mock, but a faithful one where it matters: it
// emits Aave V3's exact event signatures, keeps the real UserConfiguration
// bitmap layout, assigns reserve ids that diverge from getReservesList()
// order once a reserve is dropped, and computes HF from live oracle prices
// the way Aave does (sum of collateral x liquidation threshold over debt).
// So a price change really does move the health factor, and the test can ask
// whether the monitor noticed — and whether it left unexposed accounts alone.
//
//   1. loadAaveMarket: oracle, base unit, symbols, and reserve ids taken from
//      getReserveData (not list position) after a reserve is dropped.
//   2. Events -> watchlist: Borrow adds the DEBTOR (onBehalfOf, not the
//      caller); supply-only accounts are not tracked; progress is durable and
//      a re-tail adds nothing. HyperSync-shaped logs decode identically.
//   3. Sweep: tiers match the HF Aave reports; idle after full repay; rows
//      persist across a reopen.
//   4. Price trigger: an oracle drop makes an exposed account liquidatable
//      and it is caught on the next tick; an unexposed account is NOT read;
//      near-tier accounts are re-read every tick.
//   5. priceRecheckMaxHF / bigMoveFrac: a safe account skips small moves but
//      is re-read once the asset has moved >10% since the sweep.
//   6. Event trigger: a new Borrow after the sweep is read on the next tick;
//      a full repay moves the account to idle.
//   7. A failing account read is omitted, never reported as HF 0.
//   8. Full sweep re-runs once sweepMs has elapsed (injected clock).
//   9. Dust + rolling sweep: an account under minDebtUsd is not re-read per
//      tick even when liquidatable and exposed to a moving price, only by its
//      own events and its turn in the rolling sweep; the sweep reads a slice
//      per tick proportional to elapsed time and covers every account with
//      debt exactly once per sweepMs, flagging the cycle's completion.
//  10. A pruned pinned block (Arbitrum: "historical state … not available")
//      drops the pin instead of bisecting; the startup sweep is never pinned.
//      An eth_call gas cap (the Optimism failure: "missing revert data" for any
//      batch above N accounts) is learned by bisection, every account still
//      read; one account that breaks any batch it is in is isolated; the
//      learned size carries into later HealthMonitor ticks; a dead endpoint
//      throws instead of one call per account.
//  11. Subgraph seed, against a local fake of The Graph's gateway: id_gt
//      pagination over several pages, every page pinned to _meta's block, a
//      429 retried, ids lowercased; progress set to the snapshot block so the
//      RPC tail picks up a Borrow made after it; a stale account the subgraph
//      still lists reads idle on-chain; a subgraph for a different pool is
//      refused; GraphQL errors surface. Plus resolveSubgraphUrl / redactUrl.
//
//   npm i -D solc@0.8.24     (one-time; anvil on PATH)
//   node --experimental-strip-types test/test-liq-watch.mjs

import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ethers } from 'ethers';

const require = createRequire(import.meta.url);
const here = (p) => new URL(p, import.meta.url);
let fails = 0;
const ok = (c, l, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${l} ${extra}`); if (!c) fails++; };

const SRC = `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract MetaToken {
    string public symbol; uint8 public decimals;
    constructor(string memory s, uint8 d) { symbol = s; decimals = d; }
}

contract LendOracle {
    mapping(address => uint256) public price;
    function set(address a, uint256 p) external { price[a] = p; }
    function BASE_CURRENCY_UNIT() external pure returns (uint256) { return 1e8; }
    function getAssetPrice(address a) external view returns (uint256) { return price[a]; }
    function getAssetsPrices(address[] calldata a) external view returns (uint256[] memory r) {
        r = new uint256[](a.length);
        for (uint256 i; i < a.length; i++) r[i] = price[a[i]];
    }
}

contract LendProvider {
    address public oracle;
    constructor(address o) { oracle = o; }
    function getPriceOracle() external view returns (address) { return oracle; }
}

struct ReserveDataLegacy {
    uint256 configuration; uint128 liquidityIndex; uint128 currentLiquidityRate; uint128 variableBorrowIndex;
    uint128 currentVariableBorrowRate; uint128 currentStableBorrowRate; uint40 lastUpdateTimestamp; uint16 id;
    address aTokenAddress; address stableDebtTokenAddress; address variableDebtTokenAddress;
    address interestRateStrategyAddress; uint128 accruedToTreasury; uint128 unbacked; uint128 isolationModeTotalDebt;
}

interface IMeta { function decimals() external view returns (uint8); }

/// Aave V3 Pool surface the watcher reads, with Aave's exact event signatures.
contract LendPool {
    event Supply(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint16 indexed referralCode);
    event Withdraw(address indexed reserve, address indexed user, address indexed to, uint256 amount);
    event Borrow(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint8 interestRateMode, uint256 borrowRate, uint16 indexed referralCode);
    event Repay(address indexed reserve, address indexed user, address indexed repayer, uint256 amount, bool useATokens);
    event LiquidationCall(address indexed collateralAsset, address indexed debtAsset, address indexed user, uint256 debtToCover, uint256 liquidatedCollateralAmount, address liquidator, bool receiveAToken);
    event ReserveUsedAsCollateralEnabled(address indexed reserve, address indexed user);
    event ReserveUsedAsCollateralDisabled(address indexed reserve, address indexed user);
    event UserEModeSet(address indexed user, uint8 categoryId);
    struct EModeCategoryLegacy { uint16 ltv; uint16 liquidationThreshold; uint16 liquidationBonus; address priceSource; string label; }
    mapping(address => uint8) public emodeOf;
    function setUserEMode(address u, uint8 c) external { emodeOf[u] = c; emit UserEModeSet(u, c); }
    function getUserEMode(address u) external view returns (uint256) { return emodeOf[u]; }
    /// Category 1 = ETH-correlated, 1% liquidation bonus (Aave's usual setting).
    function getEModeCategoryData(uint8 id) external pure returns (EModeCategoryLegacy memory c) {
        if (id == 1) c = EModeCategoryLegacy(9300, 9500, 10100, address(0), "ETH correlated");
    }

    address public ADDRESSES_PROVIDER;
    LendOracle public oracle;
    address[] list;
    address[] all;                       // every reserve ever added, for HF math
    mapping(address => uint16) public idOf;
    mapping(address => bool) listed;
    mapping(address => uint256) public lt;          // bps
    mapping(address => mapping(address => uint256)) public coll;
    mapping(address => mapping(address => uint256)) public debt;
    mapping(address => uint256) public cfg;
    mapping(address => bool) public poisoned;
    uint16 nextId;

    constructor(address provider, address o) { ADDRESSES_PROVIDER = provider; oracle = LendOracle(o); }

    function addReserve(address a, uint256 ltBps) external { idOf[a] = nextId++; lt[a] = ltBps; listed[a] = true; list.push(a); all.push(a); }
    /// Like Aave's dropReserve: gone from the list, but every other id is unchanged.
    function dropReserve(address a) external {
        listed[a] = false;
        for (uint256 i; i < list.length; i++) if (list[i] == a) { list[i] = list[list.length - 1]; list.pop(); break; }
    }
    function poison(address u) external { poisoned[u] = true; }

    function getReservesList() external view returns (address[] memory r) {
        // Keep list order stable for the test: rebuild in id order.
        r = new address[](list.length);
        uint256 k;
        for (uint256 i; i < all.length; i++) if (listed[all[i]]) r[k++] = all[i];
    }
    function getReserveData(address a) external view returns (ReserveDataLegacy memory d) {
        d.configuration = (lt[a] << 16) | (uint256(10500) << 32);   // threshold + 5% liquidation bonus, Aave's bit layout
        d.id = idOf[a]; d.aTokenAddress = address(uint160(0xA0000 + idOf[a])); d.lastUpdateTimestamp = uint40(block.timestamp);
        d.liquidityIndex = 1e27; d.variableBorrowIndex = 1e27;
    }

    function supply(address asset, uint256 amount, address onBehalfOf) external {
        coll[onBehalfOf][asset] += amount;
        emit Supply(asset, msg.sender, onBehalfOf, amount, 0);
        uint256 bit = 1 << (uint256(idOf[asset]) * 2 + 1);
        if (cfg[onBehalfOf] & bit == 0) { cfg[onBehalfOf] |= bit; emit ReserveUsedAsCollateralEnabled(asset, onBehalfOf); }
    }
    function borrow(address asset, uint256 amount, address onBehalfOf) external {
        debt[onBehalfOf][asset] += amount;
        cfg[onBehalfOf] |= 1 << (uint256(idOf[asset]) * 2);
        emit Borrow(asset, msg.sender, onBehalfOf, amount, 2, 0, 0);
    }
    function repay(address asset, uint256 amount, address onBehalfOf) external {
        debt[onBehalfOf][asset] -= amount;
        if (debt[onBehalfOf][asset] == 0) cfg[onBehalfOf] &= ~(1 << (uint256(idOf[asset]) * 2));
        emit Repay(asset, onBehalfOf, msg.sender, amount, false);
    }

    function getUserConfiguration(address u) external view returns (uint256) { return cfg[u]; }

    function getUserAccountData(address u) external view returns (
        uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase,
        uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor
    ) {
        require(!poisoned[u], "poisoned");
        uint256 weighted;
        for (uint256 i; i < all.length; i++) {
            (uint256 c, uint256 w, uint256 d) = _value(u, all[i]);
            totalCollateralBase += c; weighted += w; totalDebtBase += d;
        }
        currentLiquidationThreshold = totalCollateralBase == 0 ? 0 : weighted / totalCollateralBase;
        ltv = currentLiquidationThreshold;
        availableBorrowsBase = 0;
        healthFactor = totalDebtBase == 0 ? type(uint256).max : weighted * 1e18 / (totalDebtBase * 1e4);
    }

    function _value(address u, address a) internal view returns (uint256 c, uint256 w, uint256 d) {
        uint256 unit = 10 ** IMeta(a).decimals();
        uint256 p = oracle.getAssetPrice(a);
        if (cfg[u] & (1 << (uint256(idOf[a]) * 2 + 1)) != 0) { c = coll[u][a] * p / unit; w = c * lt[a]; }
        d = debt[u][a] * p / unit;
    }
}`;

const solc = require('solc');
const out = JSON.parse(solc.compile(JSON.stringify({
    language: 'Solidity',
    sources: {
        'Lend.sol': { content: SRC },
        'Multicall3Min.sol': { content: fs.readFileSync(here('./Multicall3Min.sol'), 'utf8') },
    },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'shanghai',
                outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } } },
})));
for (const e of out.errors ?? []) if (e.severity === 'error') { console.error(e.formattedMessage); process.exit(1); }
const art = {};
for (const [, cs] of Object.entries(out.contracts)) for (const [n, c] of Object.entries(cs))
    art[n] = { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object, runtime: '0x' + c.evm.deployedBytecode.object };

// Scratch DB, so the test never touches db/<chain>-liq.sqlite.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'liq-'));
process.env.ARB_LIQ_DB = path.join(tmp, 'liq.sqlite');

const { loadAaveMarket, readAccounts, positionAssets, decodePoolEvent, TOPIC } = await import('../source/liquidation/aave-v3.ts');
const { LiqDB, liqDbPath } = await import('../source/liquidation/watchlist-db.ts');
const { tailRpc, fromHyperSyncLog } = await import('../source/liquidation/events.ts');
const { HealthMonitor, wad, MAX_UINT } = await import('../source/liquidation/health.ts');
const { MULTICALL3_ADDRESS } = await import('../source/util/multicall.ts');
const { seedFromSubgraph, resolveSubgraphUrl, redactUrl, AAVE_V3_SUBGRAPHS } = await import('../source/liquidation/subgraph.ts');

const PORT = 8556;
const anvil = spawn('anvil', ['--port', String(PORT), '--silent']);
await new Promise(r => setTimeout(r, 1500));
const provider = new ethers.JsonRpcProvider(`http://127.0.0.1:${PORT}`, undefined, { cacheTimeout: -1, staticNetwork: true });
const signer = await provider.getSigner(0);
let nonce = await provider.getTransactionCount(await signer.getAddress());
const ov = () => ({ nonce: nonce++, gasLimit: 10_000_000n });
const deploy = async (a, ...args) => { const c = await new ethers.ContractFactory(a.abi, a.bytecode, signer).deploy(...args, ov()); await c.waitForDeployment(); return c; };
const send = async (p) => (await p).wait();
const head = () => provider.getBlockNumber();
const U = (n) => ethers.Wallet.createRandom().address.toLowerCase();
const units = (n, d) => ethers.parseUnits(String(n), d);
const P = (usd) => BigInt(Math.round(usd * 1e8));   // base currency, 8 decimals

try {
    await provider.send('anvil_setCode', [MULTICALL3_ADDRESS, art.Multicall3Min.runtime]);

    const oracle = await deploy(art.LendOracle);
    const prov = await deploy(art.LendProvider, await oracle.getAddress());
    const pool = await deploy(art.LendPool, await prov.getAddress(), await oracle.getAddress());
    const POOL = (await pool.getAddress()).toLowerCase();
    const weth = await deploy(art.MetaToken, 'WETH', 18);
    const junk = await deploy(art.MetaToken, 'JUNK', 18);
    const usdc = await deploy(art.MetaToken, 'USDC', 6);
    const wbtc = await deploy(art.MetaToken, 'WBTC', 8);
    const [WETH, JUNK, USDC, WBTC] = (await Promise.all([weth, junk, usdc, wbtc].map(t => t.getAddress()))).map(a => a.toLowerCase());
    // ids: WETH 0, JUNK 1, USDC 2, WBTC 3 — then JUNK is dropped, so USDC sits at list position 1 with id 2.
    await send(pool.addReserve(WETH, 8250, ov()));
    await send(pool.addReserve(JUNK, 5000, ov()));
    await send(pool.addReserve(USDC, 7800, ov()));
    await send(pool.addReserve(WBTC, 7800, ov()));
    await send(pool.dropReserve(JUNK, ov()));
    await send(oracle.set(WETH, P(3000), ov()));
    await send(oracle.set(USDC, P(1), ov()));
    await send(oracle.set(WBTC, P(60000), ov()));
    const fromBlock = await head();

    console.log('1. loadAaveMarket');
    const market = await loadAaveMarket(provider, POOL);
    ok(market.oracle === (await oracle.getAddress()).toLowerCase(), 'oracle resolved through the addresses provider');
    ok(market.baseUnit === 10n ** 8n, 'BASE_CURRENCY_UNIT read', String(market.baseUnit));
    ok(market.reserves.length === 3 && !market.byAsset.has(JUNK), 'dropped reserve not listed');
    ok(market.byAsset.get(USDC)?.id === 2 && market.reserves.findIndex(r => r.asset === USDC) === 1,
        'USDC id is 2 (from getReserveData) although it is list position 1');
    ok(market.byAsset.get(USDC)?.symbol === 'USDC' && market.byAsset.get(USDC)?.decimals === 6, 'symbol + decimals');
    ok(market.byAsset.get(WBTC)?.id === 3, 'WBTC id 3');
    ok(market.reserves.every(r => r.bonusBps === 10500), 'liquidation bonus decoded from the configuration bitmap', String(market.byAsset.get(WETH)?.bonusBps));

    console.log('2. events -> watchlist');
    const [A, B, X, C, D] = [U(), U(), U(), U(), U()];
    // A: 10 WETH collateral, borrows 15k USDC  -> HF = 30000*0.825/15000 = 1.65
    await send(pool.supply(WETH, units(10, 18), A, ov()));
    await send(pool.borrow(USDC, units(15000, 6), A, ov()));
    // B: credit delegation — the SIGNER borrows on B's behalf. HF = 30000*0.825/24000 = 1.03125 (near)
    await send(pool.supply(WETH, units(10, 18), B, ov()));
    await send(pool.borrow(USDC, units(24000, 6), B, ov()));
    // C: supply only. D: borrows then repays in full.
    await send(pool.supply(WETH, units(1, 18), C, ov()));
    await send(pool.supply(USDC, units(5000, 6), D, ov()));
    await send(pool.borrow(WETH, units(0.5, 18), D, ov()));
    await send(pool.repay(WETH, units(0.5, 18), D, ov()));

    const db = new LiqDB(liqDbPath('anvil'), POOL);
    const h1 = await head();
    const r1 = await tailRpc(provider, db, fromBlock + 1, h1, { chunk: 3 });   // tiny chunks: many getLogs
    const tracked = new Set(db.accounts().map(a => a.user));
    ok(tracked.has(A) && tracked.has(B) && tracked.has(D), 'borrowers tracked', `(${[...tracked].length})`);
    ok(!tracked.has(C), 'supply-only account not tracked');
    const signerAddr = (await signer.getAddress()).toLowerCase();
    ok(!tracked.has(signerAddr) && !tracked.has(X), 'credit-delegation caller not tracked (onBehalfOf is the debtor)');
    ok(db.lastBlock() === h1, 'progress recorded through head', `${db.lastBlock()} / ${h1}`);
    ok(r1.calls > 1, 'spanned several getLogs chunks', `${r1.calls} calls, ${r1.logs} logs`);
    const r1b = await tailRpc(provider, db, h1 + 1, h1);
    ok(r1b.logs === 0 && db.count() === 3, 're-tail from lastBlock+1 adds nothing');

    // HyperSync log shape: null topic slots, camelCase.
    const rawBorrow = (await provider.getLogs({ address: POOL, topics: [TOPIC.Borrow], fromBlock: fromBlock + 1, toBlock: h1 }))[0];
    const hsShape = { topics: [...rawBorrow.topics, null], data: rawBorrow.data, blockNumber: rawBorrow.blockNumber };
    const e1 = decodePoolEvent(rawBorrow), e2 = decodePoolEvent(fromHyperSyncLog(hsShape));
    ok(e1 && e2 && e1.account === e2.account && e2.isBorrow && e1.account === A, 'HyperSync-shaped log decodes identically');

    console.log('3. sweep + tiers');
    let clock = 0;
    const mon = new HealthMonitor(provider, market, db, { watchEvery: 1000, sweepMs: 1_000_000 }, () => clock);
    const sw = await mon.sweep(h1);
    const st = (u) => mon.accounts.get(u);
    ok(sw.read === 3 && sw.failed === 0, 'all three borrowers read', `read ${sw.read}`);
    ok(st(A).tier === 'far', 'A far', `HF ${ethers.formatUnits(st(A).hf, 18)}`);
    ok(st(A).hf === 1650000000000000000n, 'A HF = 1.65 exactly (Aave-reported, not recomputed)');
    ok(st(B).tier === 'near', 'B near', `HF ${ethers.formatUnits(st(B).hf, 18)}`);
    ok(st(D).tier === 'idle' && st(D).hf === MAX_UINT, 'D idle after full repay');
    const pa = positionAssets(market, st(A).config);
    ok(pa.collateral.map(r => r.symbol).join() === 'WETH' && pa.debt.map(r => r.symbol).join() === 'USDC', 'A exposure from config bitmap');
    db.close();
    const db2 = new LiqDB(liqDbPath('anvil'), POOL);
    const rowA = db2.accounts().find(r => r.user === A);
    ok(rowA?.tier === 'far' && rowA.hf === st(A).hf && rowA.checkedBlock === h1, 'health persisted across reopen');
    db2.close();
    const db3 = new LiqDB(liqDbPath('anvil'), POOL);
    const mon2 = new HealthMonitor(provider, market, db3, { watchEvery: 1000, sweepMs: 1_000_000 }, () => clock);
    await mon2.sweep(await head());

    console.log('4. price trigger');
    // E: WBTC collateral, USDC debt, HF = 60000*0.78/40000 = 1.17 (watch). F: same shape but WBTC-free: USDC coll, WETH debt.
    const [E, F] = [U(), U()];
    await send(pool.supply(WBTC, units(1, 8), E, ov()));
    await send(pool.borrow(USDC, units(40000, 6), E, ov()));
    await send(pool.supply(USDC, units(10000, 6), F, ov()));
    await send(pool.borrow(WETH, units(1, 18), F, ov()));        // HF = 10000*0.78/3000 = 2.6
    let hh = await head();
    let ev = await tailRpc(provider, db3, db3.lastBlock() + 1, hh);
    let t = await mon2.tick(hh, ev.touched);
    ok(mon2.accounts.get(E)?.tier === 'watch' && mon2.accounts.get(F)?.tier === 'far', 'new borrowers read on the tick after their Borrow',
        `${mon2.accounts.get(E)?.tier}/${mon2.accounts.get(F)?.tier}`);
    const fChecked = mon2.accounts.get(F).checkedBlock, aChecked = mon2.accounts.get(A).checkedBlock;

    await send(oracle.set(WBTC, P(50000), ov()));                // E: 50000*0.78/40000 = 0.975
    hh = await head();
    ev = await tailRpc(provider, db3, db3.lastBlock() + 1, hh);
    t = await mon2.tick(hh, ev.touched);
    const tE = t.transitions.find(x => x.user === E);
    ok(t.movedAssets.length === 1 && t.movedAssets[0] === WBTC, 'WBTC price move detected', t.movedAssets.join());
    ok(tE?.to === 'liquidatable' && tE.from === 'watch', 'E caught as liquidatable on the next tick', `HF ${tE && ethers.formatUnits(tE.account.hf, 18)}`);
    ok(mon2.accounts.get(F).checkedBlock === fChecked, 'F (no WBTC exposure) NOT re-read');
    ok(mon2.accounts.get(A).checkedBlock === aChecked, 'A (far, no WBTC exposure) NOT re-read');
    ok(mon2.accounts.get(B).checkedBlock === hh, 'B (near tier) re-read every tick');
    ok(t.reasons.bigMove === 1 && t.reasons.tier === 1, 'reasons: E by big move (-16.7%), B by tier', JSON.stringify(t.reasons));
    ok(t.calls <= 3, 'one price call + one account batch', `${t.calls} calls`);

    console.log('5. priceRecheckMaxHF / bigMoveFrac');
    // F has HF 2.6 > 2.0 and WETH debt. A 1% WETH move must not re-read it; a cumulative 12% move must.
    const fBefore = mon2.accounts.get(F).checkedBlock;
    const aBefore = mon2.accounts.get(A).checkedBlock;
    await send(oracle.set(WETH, P(3030), ov()));
    hh = await head();
    t = await mon2.tick(hh, []);
    ok(mon2.accounts.get(F).checkedBlock === fBefore, 'safe account skips a 1% move');
    ok(mon2.accounts.get(B).checkedBlock === hh, 'near account still read on the same move');
    ok(mon2.accounts.get(A).checkedBlock === hh && aBefore !== hh && t.reasons.price === 1, 'A (HF 1.65 < 2.0, WETH collateral) read by the small price move', JSON.stringify(t.reasons));
    await send(oracle.set(WETH, P(3360), ov()));                 // +12% vs sweep base 3000
    hh = await head();
    t = await mon2.tick(hh, []);
    ok(mon2.accounts.get(F).checkedBlock === hh && t.reasons.bigMove >= 1, 'safe account re-read after >10% since sweep', JSON.stringify(t.reasons));
    // B: 10 WETH @ 3360 -> HF = 33600*0.825/24000 = 1.155 -> leaves near for watch
    ok(t.transitions.some(x => x.user === B && x.from === 'near' && x.to === 'watch'), 'B leaves near as collateral appreciates');
    const fAfter = mon2.accounts.get(F).checkedBlock;
    hh = await head();
    t = await mon2.tick(hh, []);
    ok(mon2.accounts.get(F).checkedBlock === fAfter && t.reasons.bigMove === 0,
        'big-move reference resets: an unchanged price does not re-read the safe account again', JSON.stringify(t.reasons));

    console.log('6. event trigger');
    const G = U();
    await send(pool.supply(WETH, units(1, 18), G, ov()));
    await send(pool.borrow(USDC, units(2700, 6), G, ov()));       // 3360*0.825/2700 = 1.0267 -> near
    await send(pool.repay(USDC, units(24000, 6), B, ov()));       // B -> idle
    hh = await head();
    ev = await tailRpc(provider, db3, db3.lastBlock() + 1, hh);
    ok(ev.touched.has(G) && ev.touched.has(B), 'tail marks G (new) and B (repaid) dirty');
    t = await mon2.tick(hh, ev.touched);
    ok(t.transitions.some(x => x.user === G && x.from === null && x.to === 'near'), 'G enters at near');
    ok(t.transitions.some(x => x.user === B && x.to === 'idle'), 'B goes idle after full repay');

    console.log('7. failed reads');
    await send(pool.poison(A, ov()));
    const rr = await readAccounts(provider, POOL, [A, E, G], { batchSize: 2 });
    ok(rr.failed === 1 && rr.accounts.length === 2 && !rr.accounts.some(a => a.user === A), 'reverting account omitted, not zero-filled', `failed ${rr.failed}`);
    hh = await head();
    const hfA = mon2.accounts.get(A).hf;
    await mon2.refresh([A], hh);
    ok(mon2.accounts.get(A).hf === hfA && mon2.accounts.get(A).tier === 'far', 'monitor keeps last known state on a failed read');

    console.log('8. periodic sweep');
    // The rolling queue was snapshotted at the section-4 sweep (A, B). A full
    // sweepMs elapsing drains it in one tick and starts a new cycle that
    // includes every account added since; the next long tick drains that.
    clock += 2_000_000;
    await provider.send('evm_mine', []);
    hh = await head();
    t = await mon2.tick(hh, []);
    ok(!t.sweep && t.sweepCompleted, 'a full sweepMs drains the rolling queue in one tick', JSON.stringify(t.reasons));
    clock += 2_000_000;
    await provider.send('evm_mine', []);
    const hh8 = await head();
    t = await mon2.tick(hh8, []);
    ok(t.sweepCompleted && [E, F, G].every(u => mon2.accounts.get(u).checkedBlock === hh8),
        'next cycle covers accounts added after the first queue (E F G read)', JSON.stringify(t.reasons));
    ok(mon2.accounts.get(B).checkedBlock !== hh8 && mon2.accounts.get(D).checkedBlock !== hh8, 'idle accounts not swept');
    const tiers = Object.fromEntries(['liquidatable', 'near', 'watch', 'far', 'idle'].map(k => [k, mon2.inTier(k).length]));
    ok(tiers.liquidatable === 1 && tiers.idle === 2, 'tier census', JSON.stringify(tiers));
    db3.close();

    console.log('9. dust floor + rolling sweep');
    {
        // WETH is 3360. K: 0.01 WETH ($33.6) vs 30 USDC -> HF 0.924, liquidatable, but the most
        // liquidating it could pay is min(33.6, 30 x 1.05) x 0.05/1.05 = $1.50 -> dust under a $5 floor.
        const K = U();
        await send(pool.supply(WETH, units(0.01, 18), K, ov()));
        await send(pool.borrow(USDC, units(30, 6), K, ov()));
        const Ls = [U(), U(), U(), U()];
        for (const L of Ls) {                                     // far, WETH collateral, HF 3360*.825/1500 = 1.85 (< priceRecheckMaxHF)
            await send(pool.supply(WETH, units(1, 18), L, ov()));
            await send(pool.borrow(USDC, units(1500, 6), L, ov()));
        }
        const order = [E, F, G, ...Ls, K];                       // K last: its sweep turn is the 4th slice of 2
        const rdb = new LiqDB(path.join(tmp, 'roll.sqlite'), POOL);
        rdb.applyEvents(order.map(account => ({ account, isBorrow: true, blockNumber: 1 })), 1);
        let rclock = 0;
        const rmon = new HealthMonitor(provider, market, rdb, { sweepMs: 1000, minProfitUsd: 5 }, () => rclock);
        const h0 = await head();
        await rmon.sweep(h0);
        ok(rmon.accounts.get(K).tier === 'liquidatable' && rmon.isDust(rmon.accounts.get(K)), 'K is liquidatable and dust');
        const kp = Number(rmon.maxProfitBase(rmon.accounts.get(K))) / 1e8;
        ok(Math.abs(kp - 1.5) < 0.01, 'K max profit = min(coll, debt x bonus) x bonus share = $1.50', `$${kp.toFixed(4)}`);
        const wethColl = 1n << 1n;                                   // WETH id 0, collateral bit
        const bad = { debtBase: 500n * 10n ** 8n, collateralBase: 2n * 10n ** 8n, config: wethColl | 4n, eMode: 0, hf: 4n * 10n ** 15n };
        ok(Number(rmon.maxProfitBase(bad)) / 1e8 < 0.1 && rmon.isDust({ ...bad, user: 'x', tier: 'liquidatable', checkedBlock: 1 }),
            'bad debt ($500 owed, $2 collateral) is dust however big the debt', `$${(Number(rmon.maxProfitBase(bad)) / 1e8).toFixed(3)}`);
        ok(!rmon.isDust({ user: 'y', hf: null, debtBase: null, collateralBase: null, config: 0n, eMode: 0, tier: null, checkedBlock: null }), 'never-read account is not dust');

        const swept = new Set();
        let completions = 0, kReadEarly = false;
        for (let i = 1; i <= 4; i++) {
            rclock += 250;
            if (i === 2) await send(oracle.set(WETH, P(3350), ov()));   // WETH moves: K and the Ls are exposed
            else await provider.send('evm_mine', []);
            const hi = await head();
            const ti = await rmon.tick(hi, []);
            if (i < 4 && rmon.accounts.get(K).checkedBlock === hi) kReadEarly = true;
            ok(ti.reasons.tier === 2, `tick ${i}: tier reads are E and G only — dust K skipped`, JSON.stringify(ti.reasons));
            if (i === 2) ok(ti.reasons.price + ti.reasons.sweep >= 1 && rmon.accounts.get(K).checkedBlock !== hi, 'price move re-reads exposed non-dust accounts, not dust K');
            if (ti.sweepCompleted) completions++;
            for (const u of order) if (rmon.accounts.get(u).checkedBlock === hi) swept.add(u);
            ok(ti.reasons.sweep <= 2, `tick ${i}: sweep slice ≤ 2 (8 accounts × 250/1000ms)`, `sweep ${ti.reasons.sweep}`);
        }
        ok(!kReadEarly && rmon.accounts.get(K).checkedBlock > h0, 'dust K read only on its sweep turn (tick 4)');
        ok(order.every(u => swept.has(u)), 'every account with debt read within one sweepMs');
        ok(completions === 1, 'exactly one cycle completion in sweepMs', `${completions}`);

        await send(pool.repay(USDC, units(30, 6), K, ov()));
        const hk = await head();
        const evk = await tailRpc(provider, rdb, hk, hk);
        rclock += 1;
        const tk = await rmon.tick(hk, evk.touched);
        ok(evk.touched.has(K) && tk.transitions.some(x => x.user === K && x.to === 'idle'), 'dust K still read on its own event (repaid -> idle)');
        rdb.close();

        // Payout estimate: eMode bonus and the 50% close factor (WETH 3350 now).
        const M = U(), N = U();
        await send(pool.supply(WETH, units(10, 18), M, ov()));
        await send(pool.borrow(USDC, units(31000, 6), M, ov()));      // HF 33500*.825/31000 = 0.8915 < 0.95 -> 100% close
        await send(pool.setUserEMode(M, 1, ov()));                     // ...but at the 1% eMode bonus
        await send(pool.supply(WETH, units(10, 18), N, ov()));
        await send(pool.borrow(USDC, units(26800, 6), N, ov()));      // HF 1.031, $26.8K debt -> 50% close at 5%
        const edb = new LiqDB(path.join(tmp, 'emode.sqlite'), POOL);
        edb.applyEvents([M, N].map(account => ({ account, isBorrow: true, blockNumber: 1 })), 1);
        const emon = new HealthMonitor(provider, market, edb, {}, () => 0);
        await emon.sweep(await head());
        const pm = Number(emon.maxProfitBase(emon.accounts.get(M))) / 1e8;
        const pn = Number(emon.maxProfitBase(emon.accounts.get(N))) / 1e8;
        ok(emon.accounts.get(M).eMode === 1 && market.eModeBonus.get(1) === 10100, 'eMode category and its 1% bonus read', `${emon.accounts.get(M).eMode} / ${market.eModeBonus.get(1)}`);
        ok(Math.abs(pm - 31000 * 1.01 * 0.01 / 1.01) < 0.5, 'eMode account priced at the category bonus: $310, not $1,550', `$${pm.toFixed(2)}`);
        ok(Math.abs(pn - 13400 * 1.05 * 0.05 / 1.05) < 0.5, 'big non-eMode near account: 50% close factor -> $670', `$${pn.toFixed(2)}`);
        const reopened = new LiqDB(path.join(tmp, 'emode.sqlite'), POOL);
        ok(reopened.accounts().find(r => r.user === M)?.eMode === 1, 'eMode persisted');
        reopened.close(); edb.close();
    }

    console.log('10. eth_call cap / batch bisection');
    const AGG = new ethers.Interface(['function aggregate3((address,bool,bytes)[]) returns ((bool,bytes)[])']);
    class CappedProvider extends ethers.JsonRpcProvider {
        constructor(url, cap, bomb = null, dead = false, pruned = false) { super(url, undefined, { cacheTimeout: -1, staticNetwork: true }); this.cap = cap; this.bomb = bomb; this.dead = dead; this.pruned = pruned; this.sizes = []; this.pinned = 0; }
        async call(tx) {
            if (this.dead) throw new Error('connect ECONNREFUSED 127.0.0.1:1');
            if (this.pruned && typeof tx.blockTag === 'number') {
                // What arb1's public RPC answered: no data, the reason only in info.error.
                this.pinned++;
                const e = new Error('missing revert data'); e.code = 'CALL_EXCEPTION'; e.data = null;
                e.info = { error: { message: 'historical state 2d947d9329300a073e60310 is not available' } }; throw e;
            }
            if (tx.to?.toLowerCase() === MULTICALL3_ADDRESS.toLowerCase() && tx.data?.startsWith(AGG.getFunction('aggregate3').selector)) {
                const calls = AGG.decodeFunctionData('aggregate3', tx.data)[0];
                const n = calls.length / 3;   // getUserAccountData + getUserConfiguration + getUserEMode per account
                this.sizes.push(n);
                if (n > this.cap || (this.bomb && tx.data.toLowerCase().includes(this.bomb.slice(2)))) {
                    const e = new Error('missing revert data'); e.code = 'CALL_EXCEPTION'; e.data = null; throw e;
                }
            }
            return super.call(tx);
        }
    }
    const everyone = [A, B, D, E, F, G, ...Array.from({ length: 30 }, () => U())];
    const capped = new CappedProvider(`http://127.0.0.1:${PORT}`, 7);
    const logs = [];
    const rc = await readAccounts(capped, POOL, everyone, { batchSize: 100, concurrency: 1, log: s => logs.push(s) });
    // A is still poisoned from section 7 (reverts inside the batch, allowFailure) -> 1 failed.
    ok(rc.accounts.length === everyone.length - 1 && rc.failed === 1, 'every account read despite the cap', `${rc.accounts.length}/${everyone.length}, failed ${rc.failed}`);
    ok(rc.batchSize <= 7 && rc.batchSize >= 4, 'learned a batch size under the cap', `size ${rc.batchSize}`);
    const firstOk = capped.sizes.findIndex(n => n <= 7);
    ok(capped.sizes.slice(firstOk).every(n => n <= 7), 'once a size works, nothing bigger is retried', capped.sizes.join(','));
    ok(capped.sizes.length <= 14, 'bounded number of calls for 36 accounts', `${capped.sizes.length} calls`);
    ok(logs.length >= 1 && /rejected/.test(logs[0]), 'shrink logged once per step', logs[0]?.trim().slice(0, 70));

    const bombed = new CappedProvider(`http://127.0.0.1:${PORT}`, 1000, E);
    const rb = await readAccounts(bombed, POOL, everyone, { batchSize: 16, concurrency: 2 });
    ok(rb.accounts.length === everyone.length - 2 && !rb.accounts.some(a => a.user === E) && rb.errors.length === 1 && rb.errors[0].startsWith(E),
        'one batch-breaking account isolated, the rest read', `${rb.accounts.length} read, errors ${rb.errors.length}`);

    const mcap = new CappedProvider(`http://127.0.0.1:${PORT}`, 5);
    const cdb = new LiqDB(path.join(tmp, 'cap.sqlite'), POOL);
    cdb.applyEvents(everyone.map(account => ({ account, isBorrow: true, blockNumber: 1 })), 1);
    const cmon = new HealthMonitor(mcap, market, cdb, { batchSize: 100 }, () => 0);
    const csw = await cmon.sweep(await head());
    ok(csw.read === everyone.length - 1 && cmon.batchSize <= 5, 'HealthMonitor sweep survives the cap and keeps the learned size', `read ${csw.read}, size ${cmon.batchSize}`);
    mcap.sizes.length = 0;
    await cmon.refresh(everyone.slice(0, 12), await head());
    ok(mcap.sizes.length > 0 && Math.max(...mcap.sizes) <= 5, 'next refresh starts at the learned size, no re-bisection', mcap.sizes.join(','));
    cdb.close();

    const dead = new CappedProvider(`http://127.0.0.1:${PORT}`, 1000, null, true);
    dead.sizes.length = 0;
    let derr = '';
    try { await readAccounts(dead, POOL, everyone, { batchSize: 8, concurrency: 1 }); } catch (e) { derr = e.message; }
    ok(/failing on every call/.test(derr), 'dead endpoint throws instead of one call per account', derr.slice(0, 60));

    // Arbitrum: the pinned block's state is gone. Not a size problem — no bisection.
    const pruned = new CappedProvider(`http://127.0.0.1:${PORT}`, 1000, null, false, true);
    const plogs = [];
    const rp = await readAccounts(pruned, POOL, everyone, { batchSize: 100, concurrency: 1, blockTag: await head(), log: s => plogs.push(s) });
    ok(rp.accounts.length === everyone.length - 1 && rp.batchSize === 100 && rp.unpinned,
        'pruned-state error drops the pin, keeps the batch size', `read ${rp.accounts.length}, size ${rp.batchSize}, unpinned ${rp.unpinned}`);
    ok(pruned.pinned === 1 && plogs.some(l => /reading at latest/.test(l)), 'one pinned attempt, then latest for the rest', `${pruned.pinned} pinned calls`);
    const pdb = new LiqDB(path.join(tmp, 'pruned.sqlite'), POOL);
    pdb.applyEvents(everyone.map(account => ({ account, isBorrow: true, blockNumber: 1 })), 1);
    const pmon = new HealthMonitor(pruned, market, pdb, {}, () => 0);
    pruned.pinned = 0;
    const psw = await pmon.sweep(await head());
    ok(psw.read === everyone.length - 1 && pruned.pinned === 0, 'startup sweep reads at latest — never pinned', `pinned ${pruned.pinned}`);
    await provider.send('evm_mine', []);
    const pt = await pmon.tick(await head(), [E]);
    ok(pt.read >= 1 && pt.failed === 0, 'a tick whose block is pruned still completes (prices + accounts at latest)', JSON.stringify(pt.reasons));
    pdb.close();

    console.log('11. subgraph seed');
    ok(resolveSubgraphUrl('base', undefined, 'KEY') === `https://gateway.thegraph.com/api/KEY/subgraphs/id/${AAVE_V3_SUBGRAPHS.base}`, 'gateway URL from built-in id + key');
    ok(resolveSubgraphUrl('base', undefined, undefined) === null, 'no key -> no subgraph');
    ok(resolveSubgraphUrl('nochain', undefined, 'KEY') === null, 'unknown chain -> no subgraph');
    ok(resolveSubgraphUrl('base', 'http://x/y', undefined) === 'http://x/y', 'full-URL override used as-is, no key needed');
    ok(!redactUrl(resolveSubgraphUrl('base', undefined, 'SECRET')).includes('SECRET'), 'API key redacted for logs');

    const ghost = U();                                   // subgraph still lists it; no position on-chain
    const metaBlock = await head();
    const sgUsers = [A, E, F, G, ghost].map((u, i) => i === 0 ? u.toUpperCase().replace('0X', '0x') : u)
        .sort((x, y) => (x.toLowerCase() < y.toLowerCase() ? -1 : 1));
    let reqs = 0, unpinned = 0, served429 = false, mode = 'ok';
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', c => (body += c));
        req.on('end', () => {
            reqs++;
            const { query, variables } = JSON.parse(body);
            const reply = (o, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
            if (mode === 'autherr') return reply({ errors: [{ message: 'auth error: invalid api key' }] });
            if (query.includes('_meta')) {
                return reply({ data: { _meta: { block: { number: metaBlock }, hasIndexingErrors: false },
                    pools: [{ id: '0xprovider', pool: mode === 'wrongpool' ? '0x' + '11'.repeat(20) : POOL }] } });
            }
            if (!served429) { served429 = true; return reply({}, 429); }
            if (variables.b !== metaBlock) unpinned++;
            const page = sgUsers.filter(u => u.toLowerCase() > variables.last.toLowerCase()).slice(0, variables.n).map(id => ({ id }));
            reply({ data: { users: page } });
        });
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const SG = `http://127.0.0.1:${server.address().port}/subgraph`;
    try {
        const seedDb = new LiqDB(path.join(tmp, 'seed.sqlite'), POOL);
        const H2 = U();
        await send(pool.supply(WETH, units(1, 18), H2, ov()));
        await send(pool.borrow(USDC, units(1000, 6), H2, ov()));      // after the snapshot block
        const seeded = await seedFromSubgraph(SG, seedDb, { pageSize: 2 });
        ok(seeded.users === 5 && seeded.pages === 3, 'paginated by id_gt over 3 pages', `${seeded.users} users, ${seeded.pages} pages`);
        ok(unpinned === 0, 'every page pinned to the _meta block');
        ok(served429, 'a 429 was retried');
        ok(seedDb.lastBlock() === metaBlock, 'progress = snapshot block', `${seedDb.lastBlock()} / ${metaBlock}`);
        ok(seedDb.accounts().some(r => r.user === A), 'ids lowercased');
        const tail = await tailRpc(provider, seedDb, metaBlock + 1, await head());
        ok(tail.touched.has(H2) && seedDb.count() === 6, 'RPC tail adds the Borrow made after the snapshot', `${seedDb.count()} tracked`);
        const smon = new HealthMonitor(provider, market, seedDb, {}, () => 0);
        await smon.sweep(await head());
        ok(smon.accounts.get(ghost)?.tier === 'idle', 'stale subgraph account reads idle on-chain — never tiered on the seed');
        ok(smon.accounts.get(E)?.tier === 'liquidatable' && smon.accounts.get(H2)?.tier != null, 'seeded + tailed accounts tiered from on-chain reads');
        seedDb.close();

        mode = 'wrongpool';
        const otherDb = new LiqDB(path.join(tmp, 'seed2.sqlite'), POOL);
        let err = '';
        try { await seedFromSubgraph(SG, otherDb); } catch (e) { err = e.message; }
        ok(/wrong market/.test(err) && otherDb.count() === 0 && otherDb.lastBlock() === null, 'subgraph for another pool refused, nothing stored');
        mode = 'autherr';
        err = '';
        try { await seedFromSubgraph(SG, otherDb); } catch (e) { err = e.message; }
        ok(/invalid api key/.test(err), 'GraphQL error surfaced', err.slice(0, 60));
        otherDb.close();
    } finally {
        server.close();
    }
} catch (e) {
    console.error(e);
    fails++;
} finally {
    anvil.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
