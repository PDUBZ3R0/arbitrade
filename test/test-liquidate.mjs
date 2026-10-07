// LiquidationExecutor + the off-chain planner (source/liquidation/plan.ts) on a
// local anvil, end to end: the real contract, the real planner, the real
// route finder reading a pool DB in the scanner's schema, the real ledger.
//
// The lending pool is a mock, but it implements Aave V3's liquidation rules
// where they decide money: HF < 1 to liquidate; close factor 100% under HF
// 0.95 or when the collateral or debt reserve is under $2,000, else 50%; the
// collateral's bonus — or the account's eMode category bonus — on the seized
// amount; the protocol's share of the bonus kept back; the repay scaled down
// when collateral runs out; repayment pulled with transferFrom. Exits go
// through real constant-product pairs (Mocks.sol MockPair, real K check) and
// a REAL Uniswap V3 pool (v3-core 1.0.1).
//
//   1. Cross-asset (WETH collateral, USDC debt, 50% close factor): planner
//      picks the pair, the direct V2 exit, simulates; broadcast; realised
//      profit (event) == simulated == ledger row; Aave math checked by hand.
//   2. Same asset in eMode (WETH/WETH, 1% bonus): no route, still profitable.
//   3. V3 exit: collateral only tradable through a Uniswap V3 pool.
//   4. Two hops via a hub when there is no direct pool.
//   5. MustNotLeaveDust: the 50% amount reverts, the planner's full-debt
//      fallback succeeds.
//   6. Refusals: a healthy account (every simulation reverts), a gas floor
//      above the profit (belowFloor, nothing sent), no route at all.
//   7. Contract safety: NotOwner, a direct callback (NotPool), RouteMismatch
//      both ways, minProfit above the real profit -> InsufficientRepay, and
//      unswept balance already in the contract cannot rescue a losing call.
//
//   npm i -D solc@0.8.24 @uniswap/v3-core@1.0.1     (one-time; anvil on PATH)
//   node --experimental-strip-types test/test-liquidate.mjs

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

const LEND = `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract LTok {
    string public symbol; uint8 public decimals;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    constructor(string memory s, uint8 d) { symbol = s; decimals = d; }
    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function transfer(address to, uint256 a) external returns (bool) { _move(msg.sender, to, a); return true; }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
    function transferFrom(address f, address t, uint256 a) external returns (bool) {
        require(allowance[f][msg.sender] >= a, "allowance");
        allowance[f][msg.sender] -= a; _move(f, t, a); return true;
    }
    function _move(address f, address t, uint256 a) internal { require(balanceOf[f] >= a, "balance"); balanceOf[f] -= a; balanceOf[t] += a; }
}

contract LOracle {
    mapping(address => uint256) public p;
    function set(address a, uint256 v) external { p[a] = v; }
    function BASE_CURRENCY_UNIT() external pure returns (uint256) { return 1e8; }
    function getAssetPrice(address a) external view returns (uint256) { return p[a]; }
    function getAssetsPrices(address[] calldata a) external view returns (uint256[] memory r) {
        r = new uint256[](a.length); for (uint256 i; i < a.length; i++) r[i] = p[a[i]];
    }
}

contract LProvider {
    address public oracle; address public pool;
    constructor(address o) { oracle = o; }
    function setPool(address p) external { pool = p; }
    function getPriceOracle() external view returns (address) { return oracle; }
    function getPoolDataProvider() external view returns (address) { return pool; }   // the pool answers getUserReserveData
}

interface ILT { function decimals() external view returns (uint8); function transfer(address, uint256) external returns (bool);
                function transferFrom(address, address, uint256) external returns (bool); function balanceOf(address) external view returns (uint256); }
interface IRecv { function executeOperation(address, uint256, uint256, address, bytes calldata) external returns (bool); }

struct RD {
    uint256 configuration; uint128 liquidityIndex; uint128 currentLiquidityRate; uint128 variableBorrowIndex;
    uint128 currentVariableBorrowRate; uint128 currentStableBorrowRate; uint40 lastUpdateTimestamp; uint16 id;
    address aTokenAddress; address stableDebtTokenAddress; address variableDebtTokenAddress;
    address interestRateStrategyAddress; uint128 accruedToTreasury; uint128 unbacked; uint128 isolationModeTotalDebt;
}
struct EMC { uint16 ltv; uint16 liquidationThreshold; uint16 liquidationBonus; address priceSource; string label; }

contract LPool {
    error HealthFactorNotBelowThreshold();
    error MustNotLeaveDust();
    // Aave's exact event signatures, so liq-watch's watchlist tracks these accounts.
    event Supply(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint16 indexed referralCode);
    event Borrow(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint8 interestRateMode, uint256 borrowRate, uint16 indexed referralCode);
    address public ADDRESSES_PROVIDER; LOracle public oracle;
    address[] list;
    mapping(address => uint16) public idOf; mapping(address => uint256) public lt; mapping(address => uint256) public bonus; mapping(address => uint256) public pfee;
    mapping(address => mapping(address => uint256)) public coll; mapping(address => mapping(address => uint256)) public debt;
    mapping(address => uint256) public cfg; mapping(address => uint8) public emodeOf;
    uint16 nextId;
    constructor(address prov, address o) { ADDRESSES_PROVIDER = prov; oracle = LOracle(o); }

    function addReserve(address a, uint256 ltBps, uint256 bonusBps, uint256 feeBps) external {
        idOf[a] = nextId++; lt[a] = ltBps; bonus[a] = bonusBps; pfee[a] = feeBps; list.push(a);
    }
    function getReservesList() external view returns (address[] memory) { return list; }
    function getReserveData(address a) external view returns (RD memory d) {
        d.configuration = lt[a] << 16 | bonus[a] << 32 | pfee[a] << 152; d.id = idOf[a];
    }
    function supply(address a, uint256 amt, address u) external {
        LTok(a).mint(address(this), amt); coll[u][a] += amt; cfg[u] |= 1 << (uint256(idOf[a]) * 2 + 1);
        emit Supply(a, msg.sender, u, amt, 0);
    }
    function borrow(address a, uint256 amt, address u) external {
        debt[u][a] += amt; cfg[u] |= 1 << (uint256(idOf[a]) * 2);
        emit Borrow(a, msg.sender, u, amt, 2, 0, 0);
    }
    function setUserEMode(address u, uint8 c) external { emodeOf[u] = c; }
    function getUserEMode(address u) external view returns (uint256) { return emodeOf[u]; }
    function getUserConfiguration(address u) external view returns (uint256) { return cfg[u]; }
    function getEModeCategoryData(uint8 id) external pure returns (EMC memory c) {
        if (id == 1) c = EMC(9300, 9500, 10100, address(0), "ETH correlated");
    }

    function _base(address a, uint256 amt) internal view returns (uint256) { return amt * oracle.getAssetPrice(a) / 10 ** ILT(a).decimals(); }
    function _units(address a, uint256 base) internal view returns (uint256) { return base * 10 ** ILT(a).decimals() / oracle.getAssetPrice(a); }

    function getUserAccountData(address u) public view returns (uint256 c, uint256 d, uint256, uint256 ltOut, uint256, uint256 hf) {
        uint256 w;
        for (uint256 i; i < list.length; i++) {
            address a = list[i];
            uint256 cb = _base(a, coll[u][a]);
            c += cb; w += cb * (emodeOf[u] == 1 ? 9500 : lt[a]); d += _base(a, debt[u][a]);
        }
        ltOut = c == 0 ? 0 : w / c;
        hf = d == 0 ? type(uint256).max : w * 1e18 / (d * 1e4);
    }

    function getUserReserveData(address a, address u) external view returns (
        uint256 supplied, uint256 stableDebt, uint256 variableDebt, uint256, uint256, uint256, uint256, uint40, bool used
    ) { supplied = coll[u][a]; variableDebt = debt[u][a]; used = supplied > 0; stableDebt = 0; }

    function flashLoanSimple(address recv, address asset, uint256 amount, bytes calldata params, uint16) external {
        uint256 premium = amount * 5 / 10_000;
        LTok(asset).mint(address(this), amount);           // infinite liquidity
        ILT(asset).transfer(recv, amount);
        require(IRecv(recv).executeOperation(asset, amount, premium, msg.sender, params), "cb");
        require(ILT(asset).transferFrom(recv, address(this), amount + premium), "repay");
    }

    struct V { uint256 hf; uint256 maxDebt; uint256 actual; uint256 b; uint256 seize; uint256 fee; uint256 totalDebt; }

    /// Aave v3.3 LiquidationLogic: 50% of TOTAL debt when both reserves >= $2,000
    /// and HF > 0.95; the MustNotLeaveDust rule on partial liquidations.
    function liquidationCall(address c, address d, address u, uint256 debtToCover, bool) external {
        V memory v;
        (, v.totalDebt, , , , v.hf) = getUserAccountData(u);
        if (v.hf >= 1e18) revert HealthFactorNotBelowThreshold();
        v.maxDebt = debt[u][d];
        if (_base(c, coll[u][c]) >= 2000e8 && _base(d, debt[u][d]) >= 2000e8 && v.hf > 0.95e18
            && _base(d, debt[u][d]) > v.totalDebt / 2) v.maxDebt = _units(d, v.totalDebt / 2);
        v.actual = debtToCover < v.maxDebt ? debtToCover : v.maxDebt;
        v.b = emodeOf[u] == 1 ? 10100 : bonus[c];
        v.seize = _units(c, _base(d, v.actual) * v.b / 10_000);
        if (c == d) v.seize = v.actual * v.b / 10_000;     // same asset: no price round-trip
        if (v.seize > coll[u][c]) {
            v.seize = coll[u][c];
            v.actual = c == d ? v.seize * 10_000 / v.b : _units(d, _base(c, v.seize) * 10_000 / v.b);
        }
        // Protocol keeps its share of the bonus part of the seized collateral.
        v.fee = (v.seize - v.seize * 10_000 / v.b) * pfee[c] / 10_000;
        v.seize -= v.fee;   // seize is now the liquidator's part; seize + fee leaves the account
        if (v.actual < debt[u][d] && v.seize + v.fee < coll[u][c]) {
            if (_base(d, debt[u][d] - v.actual) < 1000e8 || _base(c, coll[u][c] - v.seize - v.fee) < 1000e8) revert MustNotLeaveDust();
        }
        require(ILT(d).transferFrom(msg.sender, address(this), v.actual), "pull");
        debt[u][d] -= v.actual; coll[u][c] -= v.seize + v.fee;
        if (debt[u][d] == 0) cfg[u] &= ~(1 << (uint256(idOf[d]) * 2));
        ILT(c).transfer(msg.sender, v.seize);
    }

    function accrue(address u, address a, uint256 amt) external { debt[u][a] += amt; }
}`;

const solc = require('solc');
const out = JSON.parse(solc.compile(JSON.stringify({
    language: 'Solidity',
    sources: {
        'HopEngine.sol': { content: fs.readFileSync(here('../contracts/HopEngine.sol'), 'utf8') },
        'LiquidationExecutor.sol': { content: fs.readFileSync(here('../contracts/LiquidationExecutor.sol'), 'utf8') },
        'Mocks.sol': { content: fs.readFileSync(here('./Mocks.sol'), 'utf8') },
        'Multicall3Min.sol': { content: fs.readFileSync(here('./Multicall3Min.sol'), 'utf8') },
        'V3Harness.sol': { content: fs.readFileSync(here('./v3-golden/V3Harness.sol'), 'utf8') },
        'Lend.sol': { content: LEND },
    },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'shanghai',
                outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } } },
}), { import: (p) => ({ contents: fs.readFileSync(here('../contracts/' + p.replace(/^\.\//, '')), 'utf8') }) }));
for (const e of out.errors ?? []) if (e.severity === 'error') { console.error(e.formattedMessage); process.exit(1); }
const art = {};
for (const [, cs] of Object.entries(out.contracts)) for (const [n, c] of Object.entries(cs))
    art[n] = { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object, runtime: '0x' + c.evm.deployedBytecode.object };
const v3 = n => require(`@uniswap/v3-core/artifacts/contracts/${n}.sol/${n}.json`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'liqx-'));
process.env.ARB_LEDGER = path.join(tmp, 'ledger.sqlite');

const { loadAaveMarket, loadEModeBonuses } = await import('../source/liquidation/aave-v3.ts');
const { Liquidator, RouteFinder, choosePairs, readPositions, LIQUIDATOR_ABI } = await import('../source/liquidation/plan.ts');
const { readPrices } = await import('../source/liquidation/aave-v3.ts');
const { MULTICALL3_ADDRESS } = await import('../source/util/multicall.ts');

const PORT = 8557;
const anvil = spawn('anvil', ['--port', String(PORT), '--silent', '--disable-code-size-limit', '--gas-limit', '300000000']);
await new Promise(r => setTimeout(r, 1500));
const provider = new ethers.JsonRpcProvider(`http://127.0.0.1:${PORT}`, undefined, { cacheTimeout: -1, staticNetwork: true });
const owner = new ethers.Wallet('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', provider);
const stranger = new ethers.Wallet('0x59c6995e998f97a5a0044966f0945389dc9c86dae88c7a8412f4603b6b78690d', provider);
let nonce = await provider.getTransactionCount(owner.address);
const ov = () => ({ nonce: nonce++, gasLimit: 30_000_000n });
const resync = async () => { nonce = await provider.getTransactionCount(owner.address); };
const deploy = async (a, ...args) => { const c = await new ethers.ContractFactory(a.abi, a.bytecode, owner).deploy(...args, ov()); await c.waitForDeployment(); return c; };
const send = async (p) => (await p).wait();
const U = () => ethers.Wallet.createRandom().address;
const P = (usd) => BigInt(Math.round(usd * 1e8));
const u = (n, d) => ethers.parseUnits(String(n), d);
const fmt = (v, d) => Number(ethers.formatUnits(v, d)).toFixed(4);

try {
    await provider.send('anvil_setCode', [MULTICALL3_ADDRESS, art.Multicall3Min.runtime]);

    // --- market ---------------------------------------------------------------
    const oracle = await deploy(art.LOracle);
    const prov = await deploy(art.LProvider, await oracle.getAddress());
    const pool = await deploy(art.LPool, await prov.getAddress(), await oracle.getAddress());
    const POOL = await pool.getAddress();
    await send(prov.setPool(POOL, ov()));
    const tok = async (s, d) => { const t = await deploy(art.LTok, s, d); return { c: t, a: await t.getAddress(), d }; };
    const WETH = await tok('WETH', 18), USDC = await tok('USDC', 6), XBTC = await tok('XBTC', 18), LINK = await tok('LINK', 18), ORPH = await tok('ORPH', 18);
    for (const [t, lt, b, f] of [[WETH, 8250, 10500, 1000], [USDC, 7800, 10450, 1000], [XBTC, 7800, 10500, 1000], [LINK, 7000, 10750, 1000], [ORPH, 7000, 10500, 1000]])
        await send(pool.addReserve(t.a, lt, b, f, ov()));
    await send(oracle.set(WETH.a, P(3000), ov()));
    await send(oracle.set(USDC.a, P(1), ov()));
    await send(oracle.set(XBTC.a, P(60000), ov()));
    await send(oracle.set(LINK.a, P(15), ov()));
    await send(oracle.set(ORPH.a, P(10), ov()));

    // --- exit venues ------------------------------------------------------------
    const pair = async (a, b, ra, rb) => {
        const p = await deploy(art.MockPair, a.a, b.a, 30);
        const A = await p.getAddress();
        await send(a.c.mint(A, ra, ov())); await send(b.c.mint(A, rb, ov())); await send(p.sync(ov()));
        return A;
    };
    // Deep WETH/USDC at $2800 (the post-crash price), LINK/WETH at $15.
    const WETH_USDC = await pair(WETH, USDC, u(10_000, 18), u(28_000_000, 6));
    const LINK_WETH = await pair(LINK, WETH, u(1_866_666, 18), u(10_000, 18));
    // XBTC only on a real Uniswap V3 pool (0.3%), at $60,000 vs USDC.
    const factory = await deploy({ abi: v3('UniswapV3Factory').abi, bytecode: v3('UniswapV3Factory').bytecode });
    const harness = await deploy(art.Harness);
    await send(factory.createPool(XBTC.a, USDC.a, 3000, ov()));
    const XBTC_USDC = await factory.getPool(XBTC.a, USDC.a, 3000);
    const v3pool = new ethers.Contract(XBTC_USDC, v3('UniswapV3Pool').abi, owner);
    const [t0] = [XBTC.a, USDC.a].sort((x, y) => x.toLowerCase() < y.toLowerCase() ? -1 : 1);
    // price = token1/token0 in raw units; sqrtPriceX96 = sqrt(price) * 2^96
    const raw = t0 === XBTC.a ? 60000 * 1e6 / 1e18 : 1e18 / (60000 * 1e6);
    const sqrtP = BigInt(Math.floor(Math.sqrt(raw) * 2 ** 48)) * (1n << 48n);
    await send(v3pool.initialize(sqrtP, ov()));
    await send(harness.mint(XBTC_USDC, -887220, 887220, 10n ** 16n, ov()));

    // --- pool DB in the scanner's schema ------------------------------------------
    const dbFile = path.join(tmp, 'anvil.sqlite');
    const pdb = new Database(dbFile);
    pdb.exec(`CREATE TABLE pairs (address TEXT, factory TEXT, token0 TEXT, token1 TEXT, blockNumber INTEGER, fee REAL, stable INTEGER, kind TEXT, tickSpacing INTEGER);
              CREATE TABLE reserves (pair TEXT PRIMARY KEY, reserves0 TEXT, reserves1 TEXT, blockNumber INTEGER, updatedAt INTEGER);
              CREATE TABLE pool_state (pool TEXT PRIMARY KEY, sqrtPriceX96 TEXT, tick INTEGER, liquidity TEXT, fee INTEGER, tickSpacing INTEGER, windowLow INTEGER, windowHigh INTEGER, blockNumber INTEGER, updatedAt INTEGER);`);
    const V2F = '0x00000000000000000000000000000000000000f2', V3F = (await factory.getAddress()).toLowerCase();
    const ins = pdb.prepare('INSERT INTO pairs VALUES (?,?,?,?,1,?,?,?,?)');
    const sorted = (a, b) => (a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a]).map(x => x.toLowerCase());
    ins.run(WETH_USDC.toLowerCase(), V2F, ...sorted(WETH.a, USDC.a), null, null, 'v2', null);
    ins.run(LINK_WETH.toLowerCase(), V2F, ...sorted(LINK.a, WETH.a), null, null, 'v2', null);
    ins.run(XBTC_USDC.toLowerCase(), V3F, ...sorted(XBTC.a, USDC.a), 0.003, null, 'v3', 60);
    // A stable-curve pool LINK/USDC: must be ignored (constant-product math would be wrong).
    ins.run('0x00000000000000000000000000000000000000aa', V2F, ...sorted(LINK.a, USDC.a), 0.0005, 1, 'v2', null);
    pdb.prepare('INSERT INTO reserves VALUES (?,?,?,1,1)').run(WETH_USDC.toLowerCase(), '1', '1');
    pdb.close();

    const cfg = {
        chain: { id: 31337, label: 'anvil', name: 'Anvil', token: 'WETH' },
        factories: [{ address: V2F, group: 'v2', fee: 0.003, name: 'mockv2' }, { address: V3F, group: 'v3', fee: undefined, name: 'univ3' }],
        flashloan: undefined,
    };

    const exec = await deploy(art.LiquidationExecutor);
    const EXEC = await exec.getAddress();
    const market = await loadAaveMarket(provider, POOL);
    ok(market.dataProvider === POOL.toLowerCase() && market.byAsset.get(WETH.a.toLowerCase()).protocolFeeBps === 1000, 'market: data provider and protocol fee decoded');
    const routes = new RouteFinder(cfg, dbFile, [WETH.a, USDC.a]);
    const mkLiq = (o = {}) => new Liquidator(cfg, provider, market, routes, { executor: EXEC, owner: owner.address, signer: owner, live: false, minProfitUsd: 1, ...o });

    const account = async (user) => {
        const d = await pool.getUserAccountData(user);
        return { hf: d[5], eMode: Number(await pool.getUserEMode(user)) };
    };

    console.log('1. cross-asset, V2 exit, broadcast');
    {
        const A = U();
        await send(pool.supply(WETH.a, u(10, 18), A, ov()));
        await send(pool.borrow(USDC.a, u(24_000, 6), A, ov()));
        await send(oracle.set(WETH.a, P(2800), ov()));          // HF = 28000 x .825 / 24000 = 0.9625: 50% close factor
        const { hf, eMode } = await account(A);
        ok(hf < 10n ** 18n && hf > 95n * 10n ** 16n, 'account liquidatable, HF in the 50% band', fmt(hf, 18));

        const prices = await readPrices(provider, market);
        const pos = await readPositions(provider, market, A, prices);
        const plans = choosePairs(market, pos, hf, 0);
        ok(plans.length === 1 && plans[0].closeFactor === 50 && !plans[0].leavesDust && plans[0].debt.symbol === 'USDC' && plans[0].collateral.symbol === 'WETH',
            'pair: WETH -> USDC, 50% close factor', `${plans[0]?.collateral.symbol}->${plans[0]?.debt.symbol} cf ${plans[0]?.closeFactor}`);
        // Aave's math: repay 12,000 USDC, seize 12,000 x 1.05 / 2800 = 4.5 WETH, protocol keeps 10% of the 0.2143 WETH bonus.
        const est = Number(plans[0].estPayoutBase) / 1e8;
        ok(Math.abs(est - 12000 * 0.05 * 0.9) < 1, 'estimated payout = 5% bonus less 10% protocol share = $540', `$${est.toFixed(2)}`);

        const dry = await mkLiq().attempt(A, hf, eMode);
        ok(dry.simulated && !dry.broadcast && dry.best?.route.label.startsWith('direct v2'), 'dry run: simulated through the direct V2 pool, nothing sent', dry.reason ?? dry.best?.route.label);
        const usdcBefore = await USDC.c.balanceOf(EXEC);
        const live = await mkLiq({ live: true }).attempt(A, hf, eMode);
        await resync();
        ok(live.confirmed, 'live: broadcast and confirmed', live.reason ?? live.txHash);
        const gain = (await USDC.c.balanceOf(EXEC)) - usdcBefore;
        ok(live.realisedProfit === gain && gain > 0n, 'realised profit (event) == USDC that landed in the executor', `${fmt(gain, 6)} USDC`);
        // 4.4786 WETH sold into a 10k-WETH pool at 0.3%, less the 5 bp flash premium on 12,024 USDC.
        ok(gain > u(480, 6) && gain < u(520, 6), 'profit matches Aave math minus swap fee, slippage and flash premium (~$497)', fmt(gain, 6));
        ok(Math.abs(Number(dry.best.profit - gain)) < 2e6, 'dry-run simulation predicted it', `${fmt(dry.best.profit, 6)} vs ${fmt(gain, 6)}`);
        const debtLeft = await pool.debt(A, USDC.a);
        ok(debtLeft > u(11_900, 6) && debtLeft < u(12_100, 6), 'Aave capped the repay at the 50% close factor (+0.2% headroom returned)', fmt(debtLeft, 6));
        const L = new Database(process.env.ARB_LEDGER, { readonly: true });
        const row = L.prepare('SELECT * FROM trades').get();
        L.close();
        ok(row?.type === 'liquidation' && BigInt(row.profitWei) === gain && row.rootTokenSymbol === 'USDC' && Math.abs(row.profitUsd - Number(gain) / 1e6) < 0.01,
            'ledger row: type liquidation, realised profit, USD value', row ? `${row.profitWei} ${row.rootTokenSymbol} $${row.profitUsd?.toFixed(2)}` : 'none');
    }

    console.log('2. same asset in eMode');
    {
        const B = U();
        await send(pool.supply(WETH.a, u(10, 18), B, ov()));
        await send(pool.borrow(WETH.a, u(9.6, 18), B, ov()));
        await send(pool.setUserEMode(B, 1, ov()));               // HF = 10 x .95 / 9.6 = 0.9896
        const { hf, eMode } = await account(B);
        await loadEModeBonuses(provider, market, [eMode]);
        const r = await mkLiq({ live: true }).attempt(B, hf, eMode);
        await resync();
        ok(r.best?.route.hops.length === 0 && r.pairs[0].bonusBps === 10100, 'no route, 1% eMode bonus used', `bonus ${r.pairs[0]?.bonusBps}`);
        // repay 4.8 WETH, seize 4.848, protocol keeps 10% of 0.048 -> +0.0432 WETH, less 0.0024 premium.
        ok(r.confirmed && r.realisedProfit > u(0.039, 18) && r.realisedProfit < u(0.042, 18), 'executed: profit ~0.0408 WETH', r.reason ?? fmt(r.realisedProfit, 18));
    }

    console.log('3. V3 exit');
    {
        const C = U();
        await send(pool.supply(XBTC.a, u(1, 18), C, ov()));
        await send(pool.borrow(USDC.a, u(1600, 6), C, ov()));   // small position: 100% close factor
        await send(oracle.set(XBTC.a, P(2000), ov()));          // HF = 2000 x .78 / 1600 = 0.975
        // Re-price the V3 pool's market? No: Aave values collateral at the oracle ($2000),
        // the pool still pays ~$60,000 — a big edge, which is what makes the route obvious.
        const { hf, eMode } = await account(C);
        const r = await mkLiq({ live: true }).attempt(C, hf, eMode);
        await resync();
        ok(r.confirmed && r.best?.route.hops.length === 1 && r.best.route.hops[0].kind === 1, 'executed through the Uniswap V3 pool', r.reason ?? r.best?.route.label);
        ok(r.realisedProfit > u(1000, 6), 'V3 exit profit landed', fmt(r.realisedProfit ?? 0n, 6));
        await send(oracle.set(XBTC.a, P(60000), ov()));
    }

    console.log('4. two hops via a hub');
    {
        const D = U();
        await send(pool.supply(LINK.a, u(200, 18), D, ov()));   // $3,000 of LINK
        await send(pool.borrow(USDC.a, u(2050, 6), D, ov()));   // HF = 3000 x .70 / 2050 = 1.024
        await send(oracle.set(LINK.a, P(14), ov()));             // HF = 2800 x .70 / 2050 = 0.956 -> liquidatable
        const { hf, eMode } = await account(D);
        const r = await mkLiq({ live: true }).attempt(D, hf, eMode);
        await resync();
        const labels = r.tried.map(t => t.route.label);
        ok(!labels.some(l => l.startsWith('direct')), 'stable-curve LINK/USDC pool ignored', labels.join(' | '));
        ok(r.confirmed && r.best?.route.hops.length === 2 && /^via /.test(r.best.route.label), 'executed LINK -> WETH -> USDC', r.reason ?? r.best?.route.label);
        ok(r.best?.route.hops[0].recipient.toLowerCase() === WETH_USDC.toLowerCase() && r.best?.route.hops[1].recipient === EXEC,
            'hop 1 pays the next V2 pair directly, hop 2 pays the executor');
        await send(oracle.set(LINK.a, P(15), ov()));
    }

    console.log('5. MustNotLeaveDust -> reduced amount');
    {
        // WETH $8,400 + LINK $6,500 collateral, USDC debt $11,800:
        //   HF = (8400 x .825 + 6500 x .70) / 11800 = 0.9729 -> 50% band, max repay = 50% of total = $5,900
        //   LINK seized at the max: 5900 x 1.075 = $6,342.50 of $6,500 -> a $157 sliver left: MustNotLeaveDust.
        //   Legal alternative: repay less, so >= $1,000 of LINK stays.
        const E = U();
        // LINK stays at $15, the price its only exit pool trades at: an oracle above the
        // market would (correctly) make every LINK exit unprofitable. 433.33 LINK = $6,500.
        await send(oracle.set(LINK.a, P(15), ov()));
        await send(pool.supply(WETH.a, u(3, 18), E, ov()));
        await send(pool.supply(LINK.a, u('433.333333333333333333', 18), E, ov()));
        await send(pool.borrow(USDC.a, u(11_000, 6), E, ov()));
        await send(pool.accrue(E, USDC.a, u(800, 6), ov()));
        const { hf, eMode } = await account(E);
        const prices = await readPrices(provider, market);
        const plans = choosePairs(market, await readPositions(provider, market, E, prices), hf, 0);
        const link = plans.find(p => p.collateral.symbol === 'LINK');
        ok(link?.leavesDust && link.amounts.length === 2, 'LINK at the max repay flagged as leaving dust; reduced amount offered',
            link ? `dust ${link.leavesDust}, amounts ${link.amounts.map(a => fmt(a, 6)).join(' / ')}` : 'no LINK plan');
        const r = await mkLiq().attempt(E, hf, eMode);
        const maxTry = r.tried.find(t => t.plan.collateral.symbol === 'LINK' && t.amount === link.amounts[0]);
        const redTry = r.tried.find(t => t.plan.collateral.symbol === 'LINK' && t.amount === link.amounts[1]);
        ok(maxTry && maxTry.profit == null && /^MustNotLeaveDust/.test(maxTry.error ?? ''), 'the max amount reverts on-chain: MustNotLeaveDust (decoded)', maxTry?.error);
        ok(redTry && redTry.profit > 0n, 'the reduced amount simulates clean', redTry ? (redTry.error ?? fmt(redTry.profit, 6)) : 'not tried');
        ok(r.simulated, 'planner still finds an executable liquidation', r.reason ?? `${r.best?.plan.collateral.symbol} ${fmt(r.best?.amount ?? 0n, 6)}`);
        await send(oracle.set(LINK.a, P(15), ov()));
    }

    console.log('6. refusals');
    {
        const H = U();
        await send(pool.supply(WETH.a, u(10, 18), H, ov()));
        await send(pool.borrow(USDC.a, u(5_000, 6), H, ov()));
        const hh = await account(H);
        const r = await mkLiq({ live: true }).attempt(H, hh.hf, hh.eMode);
        await resync();
        ok(!r.simulated && !r.broadcast && /HealthFactorNotBelowThreshold/.test(r.reason ?? ''), 'healthy account: every simulation reverts (HealthFactorNotBelowThreshold), nothing sent', r.reason?.slice(0, 80));

        const F = U();
        await send(pool.supply(WETH.a, u(1, 18), F, ov()));
        await send(pool.borrow(USDC.a, u(2_350, 6), F, ov()));   // HF = 2800 x .825 / 2350 = 0.983, $2.35K
        const ff = await account(F);
        const big = await mkLiq({ live: true, gasMarginMultiple: 1e9 }).attempt(F, ff.hf, ff.eMode);
        await resync();
        ok(big.belowFloor && !big.broadcast && big.best?.profit > 0n, 'profitable but under a huge gas margin: belowFloor, nothing sent',
            `profit ${fmt(big.best?.profit ?? 0n, 6)} < floor ${fmt(big.floorDebt ?? 0n, 6)}`);

        const G = U();
        await send(pool.supply(ORPH.a, u(300, 18), G, ov()));    // ORPH has no pool anywhere
        await send(pool.borrow(USDC.a, u(2_000, 6), G, ov()));
        await send(oracle.set(ORPH.a, P(9), ov()));              // HF = 2700 x .70 / 2000 = 0.945
        const gg = await account(G);
        const nr = await mkLiq({ live: true }).attempt(G, gg.hf, gg.eMode);
        ok(!nr.broadcast && /no exit route/.test(nr.reason ?? ''), 'no exit route: refused before simulating', nr.reason);
    }

    console.log('7. contract safety');
    {
        const X = new ethers.Contract(EXEC, LIQUIDATOR_ABI, owner);
        const errName = (e) => {
            for (const d of [e?.data, e?.info?.error?.data, e?.error?.data]) {
                if (typeof d === 'string' && d.length >= 10) { try { return exec.interface.parseError(d)?.name; } catch {} }
            }
            return e?.shortMessage ?? e?.message;
        };
        const K = U();
        await send(pool.supply(WETH.a, u(10, 18), K, ov()));
        await send(pool.borrow(USDC.a, u(24_000, 6), K, ov()));   // at $2800: liquidatable, 50%
        const L = [POOL, K, WETH.a, USDC.a, u(12_000, 6), 0n];
        const hop = [[WETH_USDC, WETH.a, 3000, EXEC, 0]];
        let e;
        try { await X.connect(stranger).liquidate.staticCall(0, POOL, L, hop); } catch (x) { e = errName(x); }
        ok(e === 'NotOwner', 'stranger -> NotOwner', e);
        e = null;
        try { await exec.executeOperation.staticCall(USDC.a, 1n, 0n, EXEC, '0x'); } catch (x) { e = errName(x); }
        ok(e === 'NotPool', 'direct executeOperation -> NotPool', e);
        e = null;
        try { await X.liquidate.staticCall(0, POOL, L, []); } catch (x) { e = errName(x); }
        ok(e === 'EmptyHops', 'cross-asset with no route -> EmptyHops', e);
        e = null;
        try { await X.liquidate.staticCall(0, POOL, [POOL, K, WETH.a, WETH.a, 1n, 0n], hop); } catch (x) { e = errName(x); }
        ok(e === 'RouteMismatch', 'same-asset with a route -> RouteMismatch', e);
        e = null;
        try { await X.liquidate.staticCall(0, POOL, L, [[WETH_USDC, USDC.a, 3000, EXEC, 0]]); } catch (x) { e = errName(x); }
        ok(e === 'RouteMismatch', 'route not starting at the collateral -> RouteMismatch', e);
        const profit = await X.liquidate.staticCall(0, POOL, L, hop);
        e = null;
        try { await X.liquidate.staticCall(0, POOL, [POOL, K, WETH.a, USDC.a, u(12_000, 6), profit + 1n], hop); } catch (x) { e = errName(x); }
        ok(e === 'InsufficientRepay', 'minProfit one wei above the real profit -> InsufficientRepay', e);
        // Unswept balance cannot rescue it: park 10,000 USDC in the executor, same call.
        await send(USDC.c.mint(EXEC, u(10_000, 6), ov()));
        e = null;
        try { await X.liquidate.staticCall(0, POOL, [POOL, K, WETH.a, USDC.a, u(12_000, 6), profit + 1n], hop); } catch (x) { e = errName(x); }
        ok(e === 'InsufficientRepay', 'unswept USDC in the contract does not count toward profit', e);
        const before = await USDC.c.balanceOf(owner.address);
        await send(exec.sweep(USDC.a, ov()));
        ok((await USDC.c.balanceOf(owner.address)) - before >= u(10_000, 6), 'owner sweeps the balance');
    }
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
