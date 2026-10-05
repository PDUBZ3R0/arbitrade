// -----------------------------------------------------------------------------
// End-to-end integration test for the Sync-driven hot loop.
//
// This is the test that matters, because it is the first time these pieces run
// as one thing. Everything below is the REAL code path:
//
//   a real Sync event on a real chain (anvil)
//     -> the real sync-watcher
//       -> the real TriangleIndex.applySync / affectedTriangles / scoreMany
//         -> the real createHotLoop handler (ranking, cooldown, stop-at-clean)
//           -> the real CandidateExecutor (buildHops, estimateGas, gas floor,
//              staticCall, broadcast, ArbExecuted parsing)
//             -> the real FlashArbExecutor.sol, via a real flash loan
//               -> the real TradeLedger (better-sqlite3)
//
// The only fakes are the venue (MockPair / MockToken / MockAavePool) and the
// USD price lookup, which has no network here.
//
// Multicall3 is relocated to its canonical address, because build-hops.ts
// hardcodes 0xcA11... and an eth_call to a codeless address SUCCEEDS returning
// 0x — the exact mechanism that produced a fake "simulated clean" against a
// misconfigured executor earlier in this project. Without the relocation this
// test would pass for the wrong reason.
// -----------------------------------------------------------------------------

import { JsonRpcProvider, Wallet, ContractFactory, Contract } from 'ethers';
import { readFileSync, rmSync, mkdirSync } from 'fs';
import { ArbitradeDB } from '../source/util/db.ts';
import { TriangleIndex } from '../source/orchestrator/triangle-index.ts';
import { watchSync } from '../source/orchestrator/sync-watcher.ts';
import { createHotLoop } from '../source/orchestrator/hot-loop.ts';
import { CandidateExecutor } from '../source/orchestrator/attempt.ts';
import { printAttempt } from '../source/orchestrator/report.ts';
import { TradeLedger } from '../source/util/ledger.ts';
import { ledgerPath } from '../source/util/config.ts';

const art = JSON.parse(readFileSync(new URL('./artifacts.json', import.meta.url), 'utf8'));
const RPC_URL = 'http://127.0.0.1:8545';
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const WORK = process.env.ARB_TEST_WORK ?? '/tmp/arbitrade-hot-test';

rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
// The ledger goes in the scratch dir. Without ARB_LEDGER, ledgerPath() is the
// repo's real db/ledger.sqlite — which the lines below DELETE so the count
// assertion means something. Never let a test run point at the real one.
process.env.ARB_LEDGER = `${WORK}/ledger.sqlite`;
const LEDGER = ledgerPath();
rmSync(LEDGER, { force: true });
rmSync(`${LEDGER}-wal`, { force: true });
rmSync(`${LEDGER}-shm`, { force: true });

const provider = new JsonRpcProvider(RPC_URL, undefined, { cacheTimeout: -1, staticNetwork: true });
const w = new Wallet('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', provider);

const deploy = async (n, ...a) => {
    const f = new ContractFactory(art[n].abi, art[n].bytecode, w);
    const c = await f.deploy(...a);
    await c.waitForDeployment();
    return c;
};
const E = (n) => BigInt(Math.round(n)) * 10n ** 18n;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let fails = 0;
const ok = (c, l, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${l} ${extra}`); if (!c) fails++; };

// --- 0. venue ----------------------------------------------------------------
console.log('0. deploying the venue');

// Relocate Multicall3 to its canonical address.
{
    const mc = await deploy('Multicall3Min');
    const code = await provider.getCode(await mc.getAddress());
    await provider.send('anvil_setCode', [MULTICALL3, code]);
    const atCanonical = await provider.getCode(MULTICALL3);
    ok(atCanonical.length > 2 && atCanonical === code, 'Multicall3 present at the canonical address',
       `${(atCanonical.length - 2) / 2} bytes`);
}

// Three tokens, three pairs: ROOT -> B -> C -> ROOT.
const tRoot = await deploy('MockToken', 'ROOT', 0);
const tB = await deploy('MockToken', 'B', 0);
const tC = await deploy('MockToken', 'C', 0);
const [ROOT, B, C] = [await tRoot.getAddress(), await tB.getAddress(), await tC.getAddress()];

const pAB = await deploy('MockPair', ROOT, B, 30);   // 0.3%
const pBC = await deploy('MockPair', B, C, 30);
const pCA = await deploy('MockPair', C, ROOT, 30);
const [AB, BC, CA] = [await pAB.getAddress(), await pBC.getAddress(), await pCA.getAddress()];

// Balanced to start: no arbitrage exists yet. The test creates the edge later
// by moving ONE pair, which is the whole point — the loop must notice from the
// Sync event alone.
const seed = async (pair, tokenX, amtX, tokenY, amtY) => {
    await (await tokenX.mint(await pair.getAddress(), amtX)).wait();
    await (await tokenY.mint(await pair.getAddress(), amtY)).wait();
    await (await pair.sync()).wait();
};
await seed(pAB, tRoot, E(1_000_000), tB, E(1_000_000));
await seed(pBC, tB, E(1_000_000), tC, E(1_000_000));
await seed(pCA, tC, E(1_000_000), tRoot, E(1_000_000));

const pool = await deploy('MockAavePool', 5n);       // 0.05% premium
const POOL = await pool.getAddress();
await (await tRoot.mint(POOL, E(10_000_000))).wait();

const exec = await deploy('FlashArbExecutor', POOL);
const EXEC = await exec.getAddress();
ok((await exec.owner()).toLowerCase() === w.address.toLowerCase(), 'executor owned by the test wallet');

// --- 1. the DB the index reads from -----------------------------------------
console.log('\n1. seeding the database');
const dbFile = `${WORK}/hot.sqlite`;
const db = new ArbitradeDB(dbFile);
const raw = db.db;
const FACTORY = '0x00000000000000000000000000000000000f4c70';
const now = Math.floor(Date.now() / 1000);

raw.prepare('INSERT INTO factories (address,name,type,fee,deployBlock) VALUES (?,?,?,?,?)')
   .run(FACTORY, 'MockFactory', 'v2', 0.003, 0);
const insPair = raw.prepare('INSERT INTO pairs (address,factory,token0,token1,blockNumber,fee,stable) VALUES (?,?,?,?,?,?,?)');
const insRes = raw.prepare('INSERT INTO reserves (pair,reserves0,reserves1,blockNumber,updatedAt) VALUES (?,?,?,?,?)');
const insTok = raw.prepare('INSERT INTO tokens (address,symbol,name,decimals,fetchStatus,fetchedAt,discoveredAt) VALUES (?,?,?,?,?,?,?)');

for (const [sym, addr] of [['ROOT', ROOT], ['B', B], ['C', C]]) {
    insTok.run(addr.toLowerCase(), sym, sym, 18, 'ok', now, now);
}
for (const p of [pAB, pBC, pCA]) {
    const addr = (await p.getAddress()).toLowerCase();
    const [t0, t1] = [(await p.token0()).toLowerCase(), (await p.token1()).toLowerCase()];
    const [r0, r1] = await p.getReserves();
    insPair.run(addr, FACTORY, t0, t1, 1, 0.003, null);
    insRes.run(addr, r0.toString(), r1.toString(), 1, now);
}

// The canonical key must be rotation-invariant; sorted pair addresses, as
// insertTriangles builds it.
const canonical = [AB, BC, CA].map(a => a.toLowerCase()).sort().join('-');
raw.prepare(`INSERT INTO triangles
    (id,root_token,hop_count,token_a,token_b,token_c,pair_ab,pair_bc,pair_ca,
     factory_ab,factory_bc,factory_ca,canonical,createdAt)
    VALUES (1,?,3,?,?,?,?,?,?,?,?,?,?,?)`)
   .run(ROOT.toLowerCase(), ROOT.toLowerCase(), B.toLowerCase(), C.toLowerCase(),
        AB.toLowerCase(), BC.toLowerCase(), CA.toLowerCase(),
        FACTORY, FACTORY, FACTORY, canonical, now);

ok(db.getPairsForEnumeration({ includeStable: false }).length === 3, 'three pairs visible to enumeration');

// --- 2. the index ------------------------------------------------------------
console.log('\n2. index and config');
const factoriesByAddr = new Map([[FACTORY, { address: FACTORY, fee: 0.003 }]]);
const ix = TriangleIndex.build(db, factoriesByAddr);
ok(ix.triangleCount === 1 && ix.pairCount === 3, 'index built',
   `${ix.triangleCount} triangle, ${ix.pairCount} pairs`);

const cfg = {
    raw: {},
    chain: { name: 'Anvil', label: 'anvil', id: 31337, host: RPC_URL, token: ROOT, executor: EXEC },
    factories: [{ address: FACTORY, fee: 0.003 }],
    flashloan: {
        provider: 'aave-v3',
        pool: POOL,
        premium: 0.0005,
        tokens: [
            { symbol: 'ROOT', address: ROOT, decimals: 18 },
            { symbol: 'B', address: B, decimals: 18 },
            { symbol: 'C', address: C, decimals: 18 },
        ],
    },
    evaluator: { minProfitTokens: 0.01, minLiquidityTokens: 1, minInputTokens: 0.1 },
    scan: {},
};

// ROOT *is* the numeraire here, so priceInNumeraire is 1 — the same value the
// evaluator derives for a root that is the chain's numeraire token.
const pricing = {
    [ROOT.toLowerCase()]: {
        symbol: 'ROOT', priceInNumeraire: 1, sourceLiquidity: 1e24,
        minProfitInRootTokens: 0.01, minInputInRootTokens: 0.1,
    },
};

const decimalsByToken = new Map(ix.tokenAddr.map(a => [a, 18]));
const thresholds = {
    minProfitByRoot: new Map(ix.tokenAddr.map(a => [a, 0.01 * 1e18])),
    minInputByRoot: new Map(ix.tokenAddr.map(a => [a, 0.1 * 1e18])),
    minReserveByToken: Float64Array.from(ix.tokenAddr.map(() => 1 * 1e18)),
    maxRoi: 20,
    flashPremium: 0.0005,
};

// Balanced pools: there must be NO candidate yet. If there is, the venue is
// not actually balanced and everything after this proves nothing.
ok(ix.scoreAll(thresholds).length === 0, 'no arbitrage at balanced reserves');

const executor = new CandidateExecutor(cfg, provider, pricing, {
    ownerAddress: w.address,
    live: true,
    signer: w,
    gasMarginMultiple: 1,     // anvil gas is free-ish; 3x would mask the economics
    minProfitTokens: 0.01,
    gasPriceMaxAgeMs: 1,      // force a refresh per attempt, exercising that path
});

const reports = [];
const hot = createHotLoop({
    index: ix,
    db,
    thresholds: () => thresholds,
    pricing: () => pricing,
    decimalsByToken,
    attempt: (c, d) => executor.attempt(c, d),
    report: (a) => { reports.push(a); printAttempt(cfg, a, (s) => console.log(`    ${s}`)); },
    candidatesPerBlock: 3,
    cooldownMs: 0,
    log: (s) => console.log(`    ${s}`),
});

const watcher = await watchSync(RPC_URL, undefined, {
    isInteresting: (pair) => ix.pairIdx.has(pair),
    onBatch: hot.onBatch,
    onError: (e, ctx) => console.log(`    [feed error] ${ctx}: ${e.message}`),
    pollMs: 200,
});

// --- 3. create an edge by moving ONE pair -----------------------------------
console.log('\n3. a swap on one pair creates an edge; the loop must trade it');
{
    // Push pAB far off the other two pools' implied rate. Nothing tells the
    // loop this happened except the Sync event.
    // Fund the drifter: it is an outside trader, not the pool.
    await (await tRoot.mint(w.address, E(400_000))).wait();
    await (await tRoot.approve(AB, E(400_000))).wait();
    await (await pAB.drift(ROOT, E(300_000))).wait();

    const head = await provider.getBlockNumber();
    for (let i = 0; i < 60 && (watcher.lastBlock() < head || reports.length === 0); i++) await sleep(200);

    const s = hot.stats();
    ok(s.batches > 0, 'the loop saw the Sync batch', `${s.batches} batch(es)`);
    ok(s.pairsApplied > 0 && s.pairsUnknown === 0, 'reserves applied, no unknown pairs',
       `applied ${s.pairsApplied}, unknown ${s.pairsUnknown}`);
    ok(s.trianglesRescored > 0, 'the affected triangle was re-scored', `${s.trianglesRescored}`);
    ok(s.candidatesFound > 0, 'a candidate was found from the Sync alone', `${s.candidatesFound}`);
    ok(s.attempts > 0, 'the candidate was attempted', `${s.attempts}`);

    const confirmed = reports.find(r => r.confirmed);
    ok(confirmed != null, 'a flash-loan arb CONFIRMED on-chain',
       confirmed ? confirmed.txHash : reports.map(r => r.simulationError ?? '(no error)').join(' | '));

    if (confirmed) {
        ok(confirmed.realisedProfit != null && confirmed.realisedProfit > 0n,
           'realised profit came from the ArbExecuted event',
           `${confirmed.realisedProfit}`);
        // The whole point of recording realised rather than estimated: the
        // contract sizes hops from reserves at execution, so the prediction is
        // an upper bound.
        ok(confirmed.realisedProfit <= confirmed.built.expectedProfit,
           'realised <= estimated (the estimate is an upper bound)',
           `${confirmed.realisedProfit} vs ${confirmed.built.expectedProfit}`);
        ok(confirmed.minProfitUsed >= confirmed.built.minProfitWei,
           'the enforced floor was at least the config floor',
           `${confirmed.minProfitUsed} >= ${confirmed.built.minProfitWei}`);
        ok(confirmed.realisedProfit >= confirmed.minProfitUsed,
           'realised profit cleared the floor the contract enforced');

        // And the executor is holding the profit.
        const held = await tRoot.balanceOf(EXEC);
        ok(held >= confirmed.realisedProfit, 'executor holds at least the realised profit',
           `${held}`);
    }
}

// --- 4. the trade reached the ledger ----------------------------------------
console.log('\n4. the confirmed trade is in the ledger');
{
    const confirmed = reports.find(r => r.confirmed);
    if (!confirmed) {
        ok(false, 'skipped — nothing confirmed');
    } else {
        const ledger = new TradeLedger(LEDGER);
        try {
            const rows = ledger.db.prepare('SELECT * FROM trades').all();
            ok(rows.length === 1, 'exactly one trade recorded', `${rows.length}`);
            const t = rows[0];
            ok(t.txHash === confirmed.txHash, 'ledger txHash matches the confirmed trade');
            // THE assertion this ledger change existed for: the recorded number
            // must be what landed, not what we hoped for.
            ok(String(t.profitWei) === String(confirmed.realisedProfit),
               'ledger recorded the REALISED profit, not the estimate',
               `${t.profitWei} (estimate was ${confirmed.built.expectedProfit})`);
            ok(BigInt(t.gasCostWei ?? 0) > 0n, 'gas cost recorded', `${t.gasCostWei}`);
        } finally {
            ledger.close();
        }
    }
}

// --- 5. no edge -> no attempt ------------------------------------------------
console.log('\n5. an unprofitable block costs nothing');
{
    const before = hot.stats();
    // A Sync on a pair the index knows, with reserves that leave no edge: the
    // loop must re-score and then do nothing. If it attempts here, every block
    // on a real chain costs two RPC round trips for no reason.
    await (await tB.mint(BC, E(1))).wait();
    await (await pBC.sync()).wait();
    const head = await provider.getBlockNumber();
    for (let i = 0; i < 40 && watcher.lastBlock() < head; i++) await sleep(200);
    await sleep(300);

    const after = hot.stats();
    ok(after.trianglesRescored > before.trianglesRescored, 'it still re-scored the affected triangle',
       `${before.trianglesRescored} -> ${after.trianglesRescored}`);
    ok(after.attempts === before.attempts || after.candidatesFound > before.candidatesFound,
       'no attempt without a candidate',
       `attempts ${before.attempts} -> ${after.attempts}, candidates ${before.candidatesFound} -> ${after.candidatesFound}`);
}

// --- 6. unknown pairs are counted, not crashed on ---------------------------
console.log('\n6. a pair the index has never seen');
{
    const before = hot.stats();
    await hot.onBatch([{
        pair: '0x000000000000000000000000000000000000dead',
        reserve0: 1e21, reserve1: 1e21, blockNumber: 1, logIndex: 0,
    }], 1);
    const after = hot.stats();
    ok(after.pairsUnknown === before.pairsUnknown + 1, 'counted as unknown');
    ok(after.attempts === before.attempts, 'and nothing was attempted');
}

// --- 7. the gas floor binds --------------------------------------------------
console.log('\n7. a profitable candidate that does not cover gas is skipped');
{
    // The measured reality on Sonic: the best visible candidate covered 0.18x
    // its own gas. That path -- profitable, simulated-clean, and still refused
    // -- is the common case on a real chain, so it needs a test of its own.
    // Forced here with an absurd margin rather than an absurd gas price, since
    // anvil's gas is nearly free.
    await (await tRoot.mint(w.address, E(400_000))).wait();
    await (await tRoot.approve(AB, E(400_000))).wait();
    await (await pAB.drift(ROOT, E(200_000))).wait();
    await (await pAB.sync()).wait();

    // Re-read reserves straight from the chain so this does not depend on the
    // watcher having caught up.
    for (const p of [pAB, pBC, pCA]) {
        const [r0, r1] = await p.getReserves();
        ix.applySync((await p.getAddress()).toLowerCase(), Number(r0), Number(r1));
    }
    const cands = ix.scoreAll(thresholds);
    ok(cands.length > 0, 'there is a profitable candidate to refuse', `${cands.length}`);

    if (cands.length > 0) {
        const greedy = new CandidateExecutor(cfg, provider, pricing, {
            ownerAddress: w.address,
            live: false,
            gasMarginMultiple: 1e9,   // demand a billion times the gas cost
            minProfitTokens: 0.01,
        });
        const a = await greedy.attempt(cands[0], db);
        printAttempt(cfg, a, (x) => console.log(`    ${x}`));
        ok(a.belowGasFloor === true, 'refused for not covering gas');
        ok(a.simulated === false, 'and never simulated (no RPC spent on it)');
        ok(a.gasFloorWei != null && a.gasFloorWei > a.built.minProfitWei,
           'the gas floor, not the config floor, is what bound it',
           `gasFloor=${a.gasFloorWei} configFloor=${a.built.minProfitWei}`);
        ok(a.minProfitUsed === a.gasFloorWei, 'and it is the floor that would have been enforced');

        // Same candidate, sane margin: must go through. Proves the refusal came
        // from the margin and not from something broken about the candidate.
        const sane = new CandidateExecutor(cfg, provider, pricing, {
            ownerAddress: w.address,
            live: false,
            gasMarginMultiple: 1,
            minProfitTokens: 0.01,
        });
        const b = await sane.attempt(cands[0], db);
        ok(b.simulated === true && !b.belowGasFloor,
           'the same candidate simulates clean at a sane margin',
           b.simulationError ?? '');
    }
}

await watcher.stop();
db.close();
provider.destroy();

console.log(fails === 0 ? '\nALL HOT-LOOP CHECKS PASS' : `\n${fails} FAILED`);
process.exit(fails ? 1 : 0);
