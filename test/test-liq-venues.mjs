// Morpho Blue and Compound III as liquidation venues, against the REAL
// protocols (morpho-blue and comet compiled from source at pinned commits by
// test/vendor.mjs), the real LiquidationExecutor, the real watcher pieces
// (venue reads, event feed, HealthMonitor) and the real planner
// (source/liquidation/plan-venues.ts) with a real flash loan from Morpho.
//
// MORPHO BLUE
//   1. Events: Borrow adds `${borrower}:${marketId}`; collateral-only users are
//      not tracked; marketId() matches the singleton's ids.
//   2. Health: HF, debt and collateral; interest accrued off-chain to a later
//      block equals what Morpho's own accrueInterest writes (to the wei);
//      HF < 1 exactly when Morpho's _isHealthy says unhealthy (both sides of
//      the boundary).
//   3. HealthMonitor: an oracle drop makes the exposed account liquidatable on
//      the next tick; an account in another market is not re-read.
//   4. liquidateMorpho via VenueLiquidator: full repay by shares, collateral
//      swapped inside onMorphoLiquidate; realised (event) == executor gain ==
//      ledger row ≈ dry run; the Liquidate event takes the account idle.
//   5. Underwater position: only the max-seize amount is offered and works.
// COMPOUND III
//   6. Events: Withdraw-past-zero adds `${borrower}:${comet}`; suppliers are
//      not tracked.
//   7. Health: HF < 1 exactly when comet.isLiquidatable (both sides).
//   8. HealthMonitor: a feed drop re-reads only accounts holding that asset.
//   9. liquidateComet: Morpho flash loan picked by LenderBook (free), absorb,
//      buyCollateral at the store-front discount, swap back; realised ==
//      gain; reserves emptied; the flash loan repaid.
//  10. Reserves-only buy after someone else absorbed (buyableReserves).
//  11. Refusal: a healthy borrower — every simulation reverts, nothing sent.
// SAFETY
//  12. NotOwner on both entry points; direct onMorphoLiquidate / onMorphoFlashLoan -> NotPool.
//
//   node test/vendor.mjs                      (one-time: fetch + compile the protocols)
//   node --experimental-strip-types test/test-liq-venues.mjs

import { spawn, execFile } from 'node:child_process';
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

const vendorFile = here('./vendor/artifacts.json');
if (!fs.existsSync(vendorFile)) { console.error('test/vendor/artifacts.json missing — run: node test/vendor.mjs'); process.exit(1); }
const V = JSON.parse(fs.readFileSync(vendorFile, 'utf8'));

const HELP = `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
contract Tok {
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
/// Stands in for the chain's Aave oracle, which UsdOracle reads for USD values.
contract UsdFeed {
    mapping(address => uint256) public p;
    function set(address a, uint256 v) external { p[a] = v; }
    function BASE_CURRENCY_UNIT() external pure returns (uint256) { return 1e8; }
    function getAssetPrice(address a) external view returns (uint256) { return p[a]; }
}`;

const solc = require('solc');
const out = JSON.parse(solc.compile(JSON.stringify({
    language: 'Solidity',
    sources: {
        'HopEngine.sol': { content: fs.readFileSync(here('../contracts/HopEngine.sol'), 'utf8') },
        'LiquidationExecutor.sol': { content: fs.readFileSync(here('../contracts/LiquidationExecutor.sol'), 'utf8') },
        'Mocks.sol': { content: fs.readFileSync(here('./Mocks.sol'), 'utf8') },
        'Multicall3Min.sol': { content: fs.readFileSync(here('./Multicall3Min.sol'), 'utf8') },
        'Help.sol': { content: HELP },
    },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'shanghai',
                outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } } },
}), { import: (p) => ({ contents: fs.readFileSync(here('../contracts/' + p.replace(/^\.\//, '')), 'utf8') }) }));
for (const e of out.errors ?? []) if (e.severity === 'error') { console.error(e.formattedMessage); process.exit(1); }
const art = {};
for (const [, cs] of Object.entries(out.contracts)) for (const [n, c] of Object.entries(cs))
    art[n] = { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object, runtime: '0x' + c.evm.deployedBytecode.object };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'liqv-'));
process.env.ARB_LEDGER = path.join(tmp, 'ledger.sqlite');

const { MULTICALL3_ADDRESS } = await import('../source/util/multicall.ts');
const { UsdOracle } = await import('../source/liquidation/usd.ts');
const { MorphoVenue, marketId, lifOf, toAssetsUp } = await import('../source/liquidation/morpho.ts');
const { CompoundVenue } = await import('../source/liquidation/compound.ts');
const { LenderBook } = await import('../source/liquidation/lenders.ts');
const { VenueLiquidator, VENUE_LIQUIDATOR_ABI } = await import('../source/liquidation/plan-venues.ts');
const { RouteFinder } = await import('../source/liquidation/plan.ts');
const { LiqDB } = await import('../source/liquidation/watchlist-db.ts');
const { HealthMonitor } = await import('../source/liquidation/health.ts');
const { tailRpc } = await import('../source/liquidation/events.ts');

const PORT = 8558;
// Chain id 10: section 13 runs the real CLI against this node as "optimism".
const anvil = spawn('anvil', ['--port', String(PORT), '--silent', '--disable-code-size-limit', '--gas-limit', '300000000', '--chain-id', '10']);
await new Promise(r => setTimeout(r, 1500));
const provider = new ethers.JsonRpcProvider(`http://127.0.0.1:${PORT}`, undefined, { cacheTimeout: -1, staticNetwork: true });
const owner = new ethers.Wallet('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', provider);
const stranger = new ethers.Wallet('0x59c6995e998f97a5a0044966f0945389dc9c86dae88c7a8412f4603b6b78690d', provider);
const BIG = { gasLimit: 60_000_000n };
const deploy = async (a, ...args) => { const c = await new ethers.ContractFactory(a.abi, a.bytecode, owner).deploy(...args, BIG); await c.waitForDeployment(); return c; };
const send = async (p) => (await p).wait();
const wallet = async () => {
    const w = ethers.Wallet.createRandom().connect(provider);
    await provider.send('anvil_setBalance', [w.address, '0x56BC75E2D63100000']);
    return w;
};
const u = (n, d) => ethers.parseUnits(String(n), d);
const fmt = (v, d) => Number(ethers.formatUnits(v, d)).toFixed(4);
const head = () => provider.getBlockNumber();
const WAD = 10n ** 18n;
const hfNum = (h) => Number(h) / 1e18;
const usdNum = (b) => b == null ? NaN : Number(b) / 1e8;
const revertText = (e) => [e?.reason, e?.shortMessage, e?.message, e?.info?.error?.message].filter(Boolean).join(' ');

try {
    await provider.send('anvil_setCode', [MULTICALL3_ADDRESS, art.Multicall3Min.runtime]);
    await provider.send('anvil_setBalance', [stranger.address, '0x56BC75E2D63100000']);

    // --- tokens, USD oracle, exit pools ---------------------------------------------
    const tok = async (s, d) => { const t = await deploy(art.Tok, s, d); return { c: t, a: (await t.getAddress()).toLowerCase(), d }; };
    const USDC = await tok('USDC', 6), WETH = await tok('WETH', 18), LINK = await tok('LINK', 18);
    const usdFeed = await deploy(art.UsdFeed);
    for (const [t, p] of [[USDC, 1], [WETH, 3000], [LINK, 15]]) await send(usdFeed.set(t.a, BigInt(p * 1e8)));

    const pair = async (a, b, ra, rb) => {
        const p = await deploy(art.MockPair, a.a, b.a, 30);
        const A = await p.getAddress();
        await send(a.c.mint(A, ra)); await send(b.c.mint(A, rb)); await send(p.sync());
        return A;
    };
    const WETH_USDC = await pair(WETH, USDC, u(10_000, 18), u(27_000_000, 6));    // $2,700
    const LINK_USDC = await pair(LINK, USDC, u(1_000_000, 18), u(10_000_000, 6)); // $10
    const dbFile = path.join(tmp, 'pools.sqlite');
    const pdb = new Database(dbFile);
    pdb.exec(`CREATE TABLE pairs (address TEXT, factory TEXT, token0 TEXT, token1 TEXT, blockNumber INTEGER, fee REAL, stable INTEGER, kind TEXT, tickSpacing INTEGER);
              CREATE TABLE reserves (pair TEXT PRIMARY KEY, reserves0 TEXT, reserves1 TEXT, blockNumber INTEGER, updatedAt INTEGER);
              CREATE TABLE pool_state (pool TEXT PRIMARY KEY, sqrtPriceX96 TEXT, tick INTEGER, liquidity TEXT, fee INTEGER, tickSpacing INTEGER, windowLow INTEGER, windowHigh INTEGER, blockNumber INTEGER, updatedAt INTEGER);`);
    const V2F = '0x00000000000000000000000000000000000000f2';
    const sorted = (a, b) => (a < b ? [a, b] : [b, a]);
    const ins = pdb.prepare('INSERT INTO pairs VALUES (?,?,?,?,1,?,?,?,?)');
    ins.run(WETH_USDC.toLowerCase(), V2F, ...sorted(WETH.a, USDC.a), null, null, 'v2', null);
    ins.run(LINK_USDC.toLowerCase(), V2F, ...sorted(LINK.a, USDC.a), null, null, 'v2', null);
    pdb.close();
    const cfg = {
        chain: { id: 31337, label: 'anvil', name: 'Anvil', token: WETH.a },
        factories: [{ address: V2F, group: 'v2', fee: 0.003, name: 'mockv2' }],
        flashloan: undefined,
    };
    const routes = new RouteFinder(cfg, dbFile, [WETH.a, USDC.a]);
    const exec = await deploy(art.LiquidationExecutor);
    const EXEC = (await exec.getAddress());
    const usd = new UsdOracle(provider, await usdFeed.getAddress());
    const balance = (t, a) => t.c.balanceOf(a);
    const ledgerRows = () => { const L = new Database(process.env.ARB_LEDGER, { readonly: true }); const r = L.prepare('SELECT * FROM trades ORDER BY rowid').all(); L.close(); return r; };

    // --- Morpho Blue -----------------------------------------------------------------
    const morpho = await deploy(V.Morpho, owner.address);
    const MORPHO = (await morpho.getAddress()).toLowerCase();
    const irm = await deploy(V.IrmMock);
    const oA = await deploy(V.OracleMock), oB = await deploy(V.OracleMock);
    const LLTV_A = 86n * 10n ** 16n, LLTV_B = 77n * 10n ** 16n;
    await send(morpho.enableIrm(await irm.getAddress()));
    await send(morpho.enableLltv(LLTV_A));
    await send(morpho.enableLltv(LLTV_B));
    const mpA = [USDC.a, WETH.a, (await oA.getAddress()).toLowerCase(), (await irm.getAddress()).toLowerCase(), LLTV_A];
    const mpB = [USDC.a, LINK.a, (await oB.getAddress()).toLowerCase(), (await irm.getAddress()).toLowerCase(), LLTV_B];
    await send(morpho.createMarket(mpA));
    await send(morpho.createMarket(mpB));
    // Morpho prices collateral in loan units at 1e36: $3,000 WETH (18) in USDC (6) = 3000e24.
    const PX = (usdPerColl) => BigInt(Math.round(usdPerColl * 1e6)) * 10n ** 18n;
    await send(oA.setPrice(PX(3000)));
    await send(oB.setPrice(PX(15)));
    await send(USDC.c.mint(owner.address, u(5_000_000, 6)));
    await send(USDC.c.approve(MORPHO, ethers.MaxUint256));
    await send(morpho.supply(mpA, u(1_000_000, 6), 0, owner.address, '0x'));
    await send(morpho.supply(mpB, u(200_000, 6), 0, owner.address, '0x'));

    const morphoBorrow = async (mp, coll, collAmt, borrowAmt) => {
        const w = await wallet();
        await send(coll.c.mint(w.address, collAmt));
        await send(coll.c.connect(w).approve(MORPHO, ethers.MaxUint256));
        const m = morpho.connect(w);
        await send(m.supplyCollateral(mp, collAmt, w.address, '0x'));
        if (borrowAmt > 0n) await send(m.borrow(mp, borrowAmt, 0, w.address, w.address));
        return w.address.toLowerCase();
    };
    const B1 = await morphoBorrow(mpA, WETH, u(10, 18), u(24_000, 6));   // HF 30000 x .86 / 24000 = 1.075
    const B2 = await morphoBorrow(mpB, LINK, u(1000, 18), u(7_000, 6));  // HF 15000 x .77 / 7000 = 1.65
    const S = await morphoBorrow(mpA, WETH, u(1, 18), 0n);               // collateral only

    const mv = new MorphoVenue(provider, MORPHO, usd);
    const idA = marketId({ loanToken: mpA[0], collateralToken: mpA[1], oracle: mpA[2], irm: mpA[3], lltv: mpA[4] });
    const idB = marketId({ loanToken: mpB[0], collateralToken: mpB[1], oracle: mpB[2], irm: mpB[3], lltv: mpB[4] });
    const kB1 = `${B1}:${idA}`, kB2 = `${B2}:${idB}`;

    console.log('1. Morpho: events -> watchlist');
    const mdb = new LiqDB(path.join(tmp, 'morpho.sqlite'), mv.key);
    {
        const p = await morpho.idToMarketParams(idA);
        ok(p[0].toLowerCase() === USDC.a && p[1].toLowerCase() === WETH.a, 'marketId() matches the singleton\'s market id');
        const ev = await tailRpc(provider, mdb, 0, await head(), { source: mv });
        const users = new Set(mdb.accounts().map(a => a.user));
        ok(users.size === 2 && users.has(kB1) && users.has(kB2), 'Borrow tracks `borrower:marketId` in each market', [...users].map(x => x.slice(0, 10) + '…' + x.slice(-6)).join(', '));
        ok(![...users].some(x => x.startsWith(S)), 'a collateral-only user is not tracked');
        ok(ev.touched.has(kB1), 'tailRpc reports the touched accounts');
    }

    console.log('2. Morpho: health math vs Morpho');
    const mon = new HealthMonitor(provider, mv, mdb, { watchEvery: 1000, sweepMs: 1_000_000 }, () => 0);
    {
        await mon.sweep(await head());
        const a = mon.accounts.get(kB1), b = mon.accounts.get(kB2);
        ok(a?.tier === 'watch' && Math.abs(hfNum(a.hf) - 1.075) < 1e-4, 'B1: HF 1.075 (watch)', `${a?.tier} ${hfNum(a?.hf ?? 0n).toFixed(6)}`);
        ok(b?.tier === 'far' && Math.abs(hfNum(b.hf) - 1.65) < 1e-4, 'B2: HF 1.65 (far)', `${b?.tier} ${hfNum(b?.hf ?? 0n).toFixed(6)}`);
        ok(Math.abs(usdNum(a.debtBase) - 24000) < 1 && Math.abs(usdNum(a.collateralBase) - 30000) < 1, 'B1: $24,000 debt, $30,000 collateral (USD via the oracle)',
            `$${usdNum(a.debtBase).toFixed(2)} / $${usdNum(a.collateralBase).toFixed(2)}`);
        const lif = lifOf(LLTV_A);
        ok(lif === WAD * WAD / (WAD - 3n * 10n ** 17n * (WAD - LLTV_A) / WAD), 'LIF(86%) = 1/(1 - 0.3 x 0.14)', (Number(lif) / 1e18).toFixed(6));
        const mp = Number(mon.maxProfitBase(a)) / 1e8;
        ok(Math.abs(mp - 24000 * (Number(lif) / 1e18 - 1)) < 2, 'max payout = debt x (LIF - 1), no close factor', `$${mp.toFixed(2)}`);
        ok(mv.describe({ user: kB1 }).startsWith('WETH → USDC (lltv 86.0%)'), 'describe', mv.describe({ user: kB1 }));

        // Interest: our extrapolation to a block 30 days on == Morpho's own accrual at that timestamp.
        const snap = await provider.send('evm_snapshot', []);
        await provider.send('evm_increaseTime', [30 * 86400]);
        await provider.send('evm_mine', []);
        const blk = await provider.getBlock('latest');
        const r = await mv.readAccounts([kB1], { blockTag: blk.number });
        const st = mv.state.get(idA);
        const pos = await morpho.position(idA, B1);
        const predicted = toAssetsUp(pos[1], st.totalBorrowAssets, st.totalBorrowShares);
        await provider.send('evm_revert', [snap]);
        await provider.send('evm_setNextBlockTimestamp', [blk.timestamp]);
        await send(morpho.accrueInterest(mpA));
        const mk = await morpho.market(idA);
        const actual = toAssetsUp(pos[1], mk[2], mk[3]);
        ok(predicted === actual && actual > u(24_000, 6), 'debt extrapolated 30 days == Morpho accrueInterest at that timestamp (to the wei)', `${fmt(predicted, 6)} vs ${fmt(actual, 6)}`);
        ok(r.accounts[0]?.hf < a.hf, 'HF falls as interest accrues', hfNum(r.accounts[0]?.hf ?? 0n).toFixed(6));

        // Boundary: price where maxBorrow == borrowed, +-0.05%.
        const pos2 = await morpho.position(idA, B1);
        const mk2 = await morpho.market(idA);
        const borrowed = toAssetsUp(pos2[1], mk2[2], mk2[3]);
        const pStar = borrowed * WAD / LLTV_A * 10n ** 36n / pos2[2];
        const healthyNow = async () => {
            try { await morpho.connect(stranger).liquidate.staticCall(mpA, B1, 1n, 0n, '0x'); return false; }
            catch (e) { return /position is healthy/.test(revertText(e)); }
        };
        for (const [mult, label] of [[10005n, 'just above'], [9995n, 'just below']]) {
            await send(oA.setPrice(pStar * mult / 10000n));
            const x = (await mv.readAccounts([kB1])).accounts[0];
            const morphoHealthy = await healthyNow();
            ok((x.hf >= WAD) === morphoHealthy && morphoHealthy === (mult > 10000n), `${label} the threshold: our HF ${hfNum(x.hf).toFixed(6)}, Morpho ${morphoHealthy ? 'healthy' : 'unhealthy'}`);
        }
        await send(oA.setPrice(PX(3000)));
    }

    console.log('3. Morpho: HealthMonitor price trigger');
    {
        let t = await mon.tick(await head());                 // settle on $3,000
        const b2Checked = mon.accounts.get(kB2).checkedBlock;
        await send(oA.setPrice(PX(2700)));                    // HF = 27000 x .86 / 24000 = 0.9675
        const h = await head();
        t = await mon.tick(h);
        const tr = t.transitions.find(x => x.user === kB1);
        ok(tr?.to === 'liquidatable' && t.reasons.price >= 1, 'oracle drop: B1 -> liquidatable on the next tick (price trigger)', `${tr?.from}->${tr?.to} ${JSON.stringify(t.reasons)}`);
        ok(mon.accounts.get(kB2).checkedBlock === b2Checked, 'B2 (other market, other oracle) not re-read');
        ok(t.movedAssets.length === 1 && t.movedAssets[0] === idA, 'one price key moved: market A', t.movedAssets.join(','));
    }

    const lenders = new LenderBook(provider, cfg, null, { morpho: MORPHO });
    const mkVL = (o = {}) => new VenueLiquidator(cfg, provider, routes, lenders, usd, { executor: EXEC, owner: owner.address, signer: owner, live: false, minProfitUsd: 1, ...o });

    console.log('4. Morpho: liquidateMorpho, full repay');
    {
        const dry = await mkVL().attemptMorpho(mv, kB1);
        const sharesBefore = (await morpho.position(idA, B1))[1];
        ok(dry.simulated && !dry.broadcast && dry.tried.length === 2, 'dry run: full-repay and max-seize both simulated, nothing sent', dry.reason ?? `${dry.tried.length} tried`);
        const before = await balance(USDC, EXEC);
        const live = await mkVL({ live: true }).attemptMorpho(mv, kB1);
        const gain = (await balance(USDC, EXEC)) - before;
        ok(live.confirmed, 'live: broadcast and confirmed', live.reason ?? live.txHash);
        ok(live.realisedProfit === gain && gain > 0n, 'realised profit (event) == USDC gained by the executor', fmt(gain, 6));
        // 24,000 x 4.384% = $1,052 incentive; 9.279 WETH sold into a $2,700 10k-WETH pool at 0.3%: ~$954.
        ok(gain > u(930, 6) && gain < u(980, 6), 'profit = LIF incentive less swap fee and slippage (~$954)', fmt(gain, 6));
        ok(Math.abs(Number(dry.best.profit - gain)) < 1e6, 'dry run predicted it', `${fmt(dry.best.profit, 6)} vs ${fmt(gain, 6)}`);
        const pos = await morpho.position(idA, B1);
        ok(pos[1] === 0n && sharesBefore > 0n && live.best.amount > u(24_000, 6), 'full repay: every borrow share gone');
        // Debt includes the 30 days of interest accrued in section 2.
        const expectLeft = u(10, 18) - live.best.amount * lifOf(LLTV_A) / WAD * 10n ** 12n * 10n / 27_000n;
        const dl = pos[2] > expectLeft ? pos[2] - expectLeft : expectLeft - pos[2];
        ok(dl < u(0.0001, 18), 'collateral left = 10 - repaid x LIF / price', `${fmt(pos[2], 18)} vs ${fmt(expectLeft, 18)}`);
        const row = ledgerRows().at(-1);
        ok(row?.type === 'liquidation' && BigInt(row.profitWei) === gain && row.rootTokenSymbol === 'USDC' && Math.abs(row.profitUsd - Number(gain) / 1e6) < 0.01,
            'ledger row: liquidation, realised profit, USD', row ? `${row.profitWei} ${row.rootTokenSymbol} $${row.profitUsd?.toFixed(2)}` : 'none');
        const ev = await tailRpc(provider, mdb, mdb.lastBlock() + 1, await head(), { source: mv });
        const t = await mon.tick(await head(), ev.touched);
        ok(ev.touched.has(kB1) && mon.accounts.get(kB1).tier === 'idle', 'Liquidate event -> re-read -> idle', `${mon.accounts.get(kB1).tier} ${JSON.stringify(t.reasons)}`);
    }

    console.log('5. Morpho: underwater position, max seize only');
    {
        await send(oA.setPrice(PX(3000)));
        const B3 = await morphoBorrow(mpA, WETH, u(1, 18), u(2_550, 6));   // HF 2580 / 2550 = 1.0118
        await send(oA.setPrice(PX(2440)));                                  // collateral $2,440 < debt x LIF $2,662
        const k = `${B3}:${idA}`;
        const r = await mkVL({ live: true }).attemptMorpho(mv, k);
        ok(r.tried.length === 1 && r.tried[0].amount < u(1, 18), 'collateral cannot cover debt x LIF: only the max-seize amount offered', `${r.tried.length} tried`);
        ok(r.confirmed && r.realisedProfit > 0n, 'executed', r.reason ?? fmt(r.realisedProfit, 6));
        const pos = await morpho.position(idA, B3);
        ok(pos[2] > 0n && pos[2] <= u(0.0006, 18) && pos[1] > 0n, 'seized 99.95% of the collateral; the shortfall stays as debt', `${fmt(pos[2], 18)} WETH left`);
    }

    // --- Compound III --------------------------------------------------------------
    const feed = async (p) => deploy(V.SimplePriceFeed, BigInt(Math.round(p * 1e8)), 8);
    const fUSDC = await feed(1), fWETH = await feed(3000), fLINK = await feed(15);
    const setFeed = async (f, p) => send(f.setRoundData(1, BigInt(Math.round(p * 1e8)), 0, 0, 1));
    const alf = await deploy(V.AssetListFactory);
    const ext = await deploy(V.CometExtAssetList, [ethers.encodeBytes32String('Compound USDC'), ethers.encodeBytes32String('cUSDCv3')], await alf.getAddress());
    const E = (x) => BigInt(Math.round(x * 1e6)) * 10n ** 12n;
    const comet = await deploy(V.CometWithExtendedAssetList, [
        owner.address, owner.address, USDC.a, await fUSDC.getAddress(), await ext.getAddress(),
        E(0.8), E(0.05), E(0.5), 0n,                 // supply kink / slopes / base
        E(0.8), E(0.05), E(0.5), E(0.015),           // borrow kink / slopes / base
        E(0.6),                                       // storeFrontPriceFactor
        10n ** 15n, 0n, 0n, 10n ** 6n, 10n ** 6n,     // trackingIndexScale, speeds, baseMinForRewards, baseBorrowMin
        u(5_000_000, 6),                              // targetReserves: buys open
        [
            [WETH.a, await fWETH.getAddress(), 18, E(0.80), E(0.85), E(0.90), u(100_000, 18)],
            [LINK.a, await fLINK.getAddress(), 18, E(0.70), E(0.75), E(0.90), u(10_000_000, 18)],
        ],
    ]);
    const COMET = (await comet.getAddress()).toLowerCase();
    const cometX = new ethers.Contract(COMET, [...V.CometWithExtendedAssetList.abi, ...V.CometExtAssetList.abi.filter(x => x.type !== 'constructor')], owner);
    await send(cometX.initializeStorage());
    await send(USDC.c.approve(COMET, ethers.MaxUint256));
    await send(cometX.supply(USDC.a, u(1_000_000, 6), { gasLimit: 3_000_000n }));
    const cometBorrow = async (coll, collAmt, borrowAmt) => {
        const w = await wallet();
        await send(coll.c.mint(w.address, collAmt));
        await send(coll.c.connect(w).approve(COMET, ethers.MaxUint256));
        const c = cometX.connect(w);
        const why = async (f, ...a) => {
            try { await f.staticCall(...a); } catch (e) { throw new Error(`comet ${f.name}: ${cometX.interface.parseError(e.data ?? '0x')?.name ?? revertText(e)}`); }
            // Explicit gas: an estimate taken in the same second as the last accrual
            // skips Comet's accrue writes, then the mined tx (a second later) runs out.
            await send(f(...a, { gasLimit: 3_000_000n }));
        };
        await why(c.supply, coll.a, collAmt);
        if (borrowAmt > 0n) await why(c.withdraw, USDC.a, borrowAmt);
        return w.address.toLowerCase();
    };
    const C1 = await cometBorrow(WETH, u(10, 18), u(23_000, 6));    // HF 30000 x .85 / 23000 = 1.1087
    const C2 = await cometBorrow(LINK, u(1000, 18), u(8_000, 6));   // HF 15000 x .75 / 8000 = 1.406
    const C3 = await cometBorrow(WETH, u(5, 18), u(5_000, 6));      // HF 2.55
    const cv = new CompoundVenue(provider, { usdc: COMET }, usd, 'anvil');
    const kC1 = `${C1}:${COMET}`, kC2 = `${C2}:${COMET}`, kC3 = `${C3}:${COMET}`;

    console.log('6. Compound: events -> watchlist');
    const cdb = new LiqDB(path.join(tmp, 'comet.sqlite'), cv.key);
    {
        await tailRpc(provider, cdb, 0, await head(), { source: cv });
        const users = new Set(cdb.accounts().map(a => a.user));
        ok(users.size === 3 && [kC1, kC2, kC3].every(k => users.has(k)), 'Withdraw past zero tracks `borrower:comet`', `${users.size} tracked`);
        ok(![...users].some(x => x.startsWith(owner.address.toLowerCase())), 'the base supplier is not tracked');
    }

    console.log('7. Compound: health math vs comet.isLiquidatable');
    const cmon = new HealthMonitor(provider, cv, cdb, { watchEvery: 1000, sweepMs: 1_000_000 }, () => 0);
    {
        await cmon.sweep(await head());
        const a = cmon.accounts.get(kC1), b = cmon.accounts.get(kC2);
        ok(a?.tier === 'watch' && Math.abs(hfNum(a.hf) - 30000 * 0.85 / 23000) < 1e-4, 'C1: HF 1.1087 (watch)', `${a?.tier} ${hfNum(a?.hf ?? 0n).toFixed(6)}`);
        ok(b?.tier === 'far' && Math.abs(hfNum(b.hf) - 15000 * 0.75 / 8000) < 1e-4, 'C2: HF 1.406 (far)', `${b?.tier} ${hfNum(b?.hf ?? 0n).toFixed(6)}`);
        ok(Math.abs(usdNum(a.debtBase) - 23000) < 1 && Math.abs(usdNum(a.collateralBase) - 30000) < 1, 'C1: $23,000 debt, $30,000 collateral',
            `$${usdNum(a.debtBase).toFixed(2)} / $${usdNum(a.collateralBase).toFixed(2)}`);
        const mp = Number(cmon.maxProfitBase(a)) / 1e8;
        ok(Math.abs(mp - 30000 * 0.6 * 0.1) < 1, 'max payout = collateral x storeFront x (1 - liquidationFactor) = 6%', `$${mp.toFixed(2)}`);
        ok(cv.describe(a) === 'WETH → USDC (cUSDCv3)' && cv.describe(b) === 'LINK → USDC (cUSDCv3)', 'describe', `${cv.describe(a)} | ${cv.describe(b)}`);
        const pStar = 23000 / (10 * 0.85);
        for (const [mult, label] of [[1.001, 'just above'], [0.999, 'just below']]) {
            await setFeed(fWETH, pStar * mult);
            const x = (await cv.readAccounts([kC1])).accounts[0];
            const liq = await cometX.isLiquidatable(C1);
            ok((x.hf < WAD) === liq && liq === (mult < 1), `${label} the threshold: our HF ${hfNum(x.hf).toFixed(6)}, Comet ${liq ? 'liquidatable' : 'healthy'}`);
        }
        await setFeed(fWETH, 3000);
    }

    console.log('8. Compound: HealthMonitor price trigger');
    {
        await cmon.tick(await head());
        const c2Checked = cmon.accounts.get(kC2).checkedBlock;
        await setFeed(fWETH, 2650);                           // HF = 26500 x .85 / 23000 = 0.979
        const t = await cmon.tick(await head());
        const tr = t.transitions.find(x => x.user === kC1);
        ok(tr?.to === 'liquidatable' && t.reasons.price + t.reasons.bigMove >= 1, 'WETH feed drop (-12%): C1 -> liquidatable (price trigger)', `${tr?.from}->${tr?.to} ${JSON.stringify(t.reasons)}`);
        ok(cmon.accounts.get(kC2).checkedBlock === c2Checked, 'C2 (LINK only) not re-read');
        ok(t.movedAssets.length === 1 && t.movedAssets[0] === `${COMET}:${WETH.a}`, 'one price key moved: comet:WETH', t.movedAssets.join(','));
    }

    console.log('9. Compound: absorb + buyCollateral with a Morpho flash loan');
    {
        const pick = await lenders.pick(USDC.a, u(25_000, 6));
        ok(pick?.source === 3 && pick.lender.toLowerCase() === MORPHO && pick.feeBps === 0, 'LenderBook: Morpho (free) holds the base asset', pick?.label);
        const dry = await mkVL().attemptComet(cv, kC1);
        ok(dry.simulated && !dry.broadcast, 'dry run simulated', dry.reason ?? fmt(dry.best?.profit ?? 0n, 6));
        const before = await balance(USDC, EXEC), morphoBefore = await balance(USDC, MORPHO);
        const live = await mkVL({ live: true }).attemptComet(cv, kC1);
        const gain = (await balance(USDC, EXEC)) - before;
        ok(live.confirmed, 'live: broadcast and confirmed', live.reason ?? live.txHash);
        ok(live.realisedProfit === gain && gain > 0n, 'realised profit (event) == USDC gained', fmt(gain, 6));
        // 10 WETH at 2650 x (1 - 6%) = $24,910; sold into the ~$2,695 pool at 0.3%: ~$1,930.
        ok(gain > u(1_700, 6) && gain < u(2_100, 6), 'profit = store-front discount + pool premium, less fee and slippage (~$1,930)', fmt(gain, 6));
        ok(Math.abs(Number(dry.best.profit - gain)) < 1e6, 'dry run predicted it', `${fmt(dry.best.profit, 6)} vs ${fmt(gain, 6)}`);
        ok((await balance(USDC, MORPHO)) === morphoBefore, 'flash loan repaid to Morpho in full, no fee');
        ok(!(await cometX.isLiquidatable(C1)) && (await cometX.userCollateral(C1, WETH.a))[0] === 0n, 'C1 absorbed: no collateral left');
        const left = await cometX.getCollateralReserves(WETH.a);
        ok(left < u(0.0001, 18), 'all absorbed WETH bought out of reserves', `${fmt(left, 18)} left`);
        ok(ledgerRows().length === 3, 'ledger: third liquidation row');
    }

    console.log('10. Compound: buy reserves someone else absorbed');
    {
        await setFeed(fLINK, 10);                              // C2 HF = 10000 x .75 / 8000 = 0.9375
        await send(cometX.connect(stranger).absorb(stranger.address, [C2], { gasLimit: 3_000_000n }));   // see `why`: estimates miss accrual
        const buy = await mkVL().buyableReserves(cv);
        const link = buy.find(b => b.asset.asset === LINK.a);
        ok(link?.reserve === u(1000, 18), 'buyableReserves: 1,000 LINK in reserves while buys are open', link ? fmt(link.reserve, 18) : 'none');
        const before = await balance(USDC, EXEC);
        const r = await mkVL({ live: true }).attemptComet(cv, `reserves:${COMET}`, LINK.a);
        const gain = (await balance(USDC, EXEC)) - before;
        // 1,000 LINK for 1000 x $10 x 0.94 = $9,400, sold at ~$10 less 0.3% and slippage: ~$560.
        ok(r.confirmed && r.realisedProfit === gain && gain > u(450, 6) && gain < u(650, 6), 'no borrower: bought at the discount and sold (~$560)', r.reason ?? fmt(gain, 6));
    }

    console.log('11. Compound: refusals');
    {
        const r = await mkVL({ live: true }).attemptComet(cv, kC3);
        ok(!r.simulated && !r.broadcast && /NothingSeized|NotLiquidatable/.test(r.reason ?? ''), 'healthy borrower: every simulation reverts, nothing sent', r.reason?.slice(0, 90));
    }

    console.log('12. contract safety');
    {
        const X = new ethers.Contract(EXEC, VENUE_LIQUIDATOR_ABI, stranger);
        const errName = (e) => {
            for (const d of [e?.data, e?.info?.error?.data, e?.error?.data]) {
                if (typeof d === 'string' && d.length >= 10) { try { return exec.interface.parseError(d)?.name; } catch {} }
            }
            return e?.shortMessage ?? e?.message;
        };
        let e = null;
        try { await X.liquidateMorpho.staticCall([MORPHO, B2, 1n, 0n, 0n], mpB, [[LINK_USDC, LINK.a, 3000, EXEC, 0]]); } catch (x) { e = errName(x); }
        ok(e === 'NotOwner', 'stranger liquidateMorpho -> NotOwner', e);
        e = null;
        try { await X.liquidateComet(3, MORPHO, [COMET, C3, WETH.a, 0n], 1n, [[WETH_USDC, WETH.a, 3000, EXEC, 0]]).then(t => t.wait()); } catch (x) { e = errName(x); }
        ok(e === 'NotOwner', 'stranger liquidateComet -> NotOwner', e);
        e = null;
        try { await exec.onMorphoLiquidate.staticCall(1n, '0x'); } catch (x) { e = errName(x); }
        ok(e === 'NotPool', 'direct onMorphoLiquidate -> NotPool', e);
        e = null;
        try { await exec.onMorphoFlashLoan.staticCall(1n, '0x'); } catch (x) { e = errName(x); }
        ok(e === 'NotPool', 'direct onMorphoFlashLoan -> NotPool', e);
        // The Morpho callback with Morpho as the caller but outside our own liquidate().
        await provider.send('anvil_impersonateAccount', [MORPHO]);
        await provider.send('anvil_setBalance', [MORPHO, '0x56BC75E2D63100000']);
        e = null;
        try { await exec.connect(await provider.getSigner(MORPHO)).onMorphoLiquidate.staticCall(1n, '0x'); } catch (x) { e = errName(x); }
        ok(e === 'NotPool', 'onMorphoLiquidate from Morpho itself, outside our call -> NotPool', e);
    }

    console.log('13. CLI: yarn liq-watch, Morpho + Compound, --live');
    {
        // A scratch project root: a copy of source/ (config.ts finds conf/ and db/
        // relative to itself), node_modules linked, and conf/optimism.json5 = the
        // real one plus a liquidation block pointing at this node's contracts.
        const root = path.join(tmp, 'cli');
        fs.mkdirSync(path.join(root, 'conf'), { recursive: true });
        fs.mkdirSync(path.join(root, 'db'), { recursive: true });
        fs.cpSync(new URL('../source', import.meta.url).pathname, path.join(root, 'source'), { recursive: true });
        fs.symlinkSync(new URL('../node_modules', import.meta.url).pathname, path.join(root, 'node_modules'));
        fs.copyFileSync(new URL('../package.json', import.meta.url).pathname, path.join(root, 'package.json'));
        fs.copyFileSync(new URL('../conf/@chains.json5', import.meta.url).pathname, path.join(root, 'conf/@chains.json5'));
        const JSON5 = require('json5');
        const conf = JSON5.parse(fs.readFileSync(new URL('../conf/optimism.json5', import.meta.url), 'utf8'));
        conf.chain.liquidator = EXEC;
        conf.factories.v2.list.mockv2 = { address: V2F, fee: 0.003 };   // the exit pools' "factory" in the pool DB
        conf.liquidation = { venues: ['morpho', 'compound'], morpho: MORPHO, comets: { usdc: COMET }, usdOracle: await usdFeed.getAddress(), minProfitUsd: 5 };
        fs.writeFileSync(path.join(root, 'conf/optimism.json5'), JSON.stringify(conf, null, 2));
        fs.copyFileSync(dbFile, path.join(root, 'db/optimism.sqlite'));
        // Gas is priced through chain.token (the real WETH address on Optimism).
        await send(usdFeed.set(conf.chain.token, 3000n * 10n ** 8n));

        // Fresh liquidatable positions on each venue.
        await send(oA.setPrice(PX(3000)));
        const B4 = await morphoBorrow(mpA, WETH, u(10, 18), u(24_000, 6));
        await send(oA.setPrice(PX(2700)));
        await setFeed(fWETH, 3000);
        const C4 = await cometBorrow(WETH, u(10, 18), u(23_000, 6));
        await setFeed(fWETH, 2650);
        const rowsBefore = ledgerRows().length;

        const run = (extra) => new Promise((res) => execFile(process.execPath,
            ['--experimental-strip-types', '--no-warnings', path.join(root, 'source/liq-watch.ts'), 'optimism', ...extra],
            { env: { ...process.env, OPTIMISM_RPC: `http://127.0.0.1:${PORT}`, ARB_NO_WS: '1', ARB_LIQ_DB: path.join(root, 'db/liq.sqlite'),
                     PRIVATE_KEY: owner.privateKey, ETHERSCAN_API_KEY: '' }, timeout: 120_000, maxBuffer: 16 << 20 },
            (err, stdout, stderr) => res({ err, out: stdout + stderr })));
        const r = await run(['--rpc-only', '--from', '0', '--live']);
        if (r.err || r.out.split('LIQUIDATED').length < 3) console.log(r.out.split('\n').slice(-40).join('\n'));
        ok(!r.err, 'CLI exits cleanly', r.err?.message?.slice(0, 120) ?? '');
        ok(/Liquidation watch on Optimism: Morpho Blue, Compound III/.test(r.out), 'venues from liquidation.venues; Aave skipped');
        ok(/\[Morpho Blue\] health sweep/.test(r.out) && /\[Compound III\] health sweep/.test(r.out), 'one sweep per venue');
        const liqLines = r.out.split('\n').filter(l => /LIQUIDATED/.test(l));
        ok(liqLines.some(l => l.includes(B4.slice(0, 12)) && /WETH→USDC/.test(l)) && liqLines.some(l => l.includes(C4.slice(0, 12)) && /\[compound\]/.test(l)),
            'both fresh positions liquidated live by the CLI', `${liqLines.length} LIQUIDATED line(s)`);
        ok(ledgerRows().length === rowsBefore + 2, 'two ledger rows', `${ledgerRows().length - rowsBefore}`);
        ok((await morpho.position(idA, B4))[1] === 0n && !(await cometX.isLiquidatable(C4)), 'on-chain: Morpho debt repaid, Comet account absorbed');
        const r2 = await run([]);
        if (r2.err || /LIQUIDATED|backfilling/.test(r2.out) || !/Watchlist: Morpho Blue 4, Compound III 4/.test(r2.out)) console.log(r2.out.split('\n').slice(-40).join('\n'));
        ok(!r2.err && !/backfilling/.test(r2.out) && /Watchlist: Morpho Blue 4, Compound III 4/.test(r2.out) && !/LIQUIDATED/.test(r2.out), 'second (read-only) run resumes the watchlist (no re-seed), nothing sent',
            r2.err?.message?.slice(0, 120) ?? '');
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
