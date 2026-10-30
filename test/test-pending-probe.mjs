// -----------------------------------------------------------------------------
// Integration test for the pending-swap probe (source/orchestrator/pending-probe.ts).
//
// Real path end to end, on anvil with automine OFF so transactions genuinely
// sit in the mempool:
//
//   anvil's newPendingTransactions(true) websocket
//     -> subscribePending -> prefilter
//       -> eth_simulateV1 on latest (rpcBackend) -> Sync logs
//         -> shadow score on the real TriangleIndex, restored afterwards
//           -> receipt, the next tx in the block, still-open re-score
//
// The things that would quietly break the measurement, and are checked:
//   - the shadow state must never leak into the live index (the hot loop
//     shares it and would trade on a swap that has not happened);
//   - a swap too small to matter is gated, plain token ops and unrelated
//     calls never cost a simulation;
//   - a cycle that already scored before the victim is not credited to it;
//   - the ordering evidence: the tx right after the victim touching the
//     cycle's pools is recorded;
//   - phase 2: our REAL executor call, built on the victim's post-swap
//     reserves, executes behind it in a bundle simulation — realising exactly
//     the profit the exact walk predicted — while the same call at latest
//     (no victim) reverts, and nothing is ever sent.
// -----------------------------------------------------------------------------

import { JsonRpcProvider, Wallet, ContractFactory } from 'ethers';
import { readFileSync, rmSync, mkdirSync } from 'fs';
import { ArbitradeDB } from '../source/util/db.ts';
import { TriangleIndex } from '../source/orchestrator/triangle-index.ts';
import { createPendingProbe, rpcBackend, subscribePending } from '../source/orchestrator/pending-probe.ts';
import { CandidateExecutor } from '../source/orchestrator/attempt.ts';

const art = JSON.parse(readFileSync(new URL('./artifacts.json', import.meta.url), 'utf8'));
const RPC_URL = 'http://127.0.0.1:8545';
const WS_URL = 'ws://127.0.0.1:8545';
const WORK = process.env.ARB_TEST_WORK ?? '/tmp/arbitrade-pending-test';
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });

const provider = new JsonRpcProvider(RPC_URL, undefined, { cacheTimeout: -1, staticNetwork: true });
const w = new Wallet('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', provider);
const E = (n) => BigInt(Math.round(n)) * 10n ** 18n;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const deploy = async (n, ...a) => {
    const c = await new ContractFactory(art[n].abi, art[n].bytecode, w).deploy(...a);
    await c.waitForDeployment();
    return c;
};
let fails = 0;
const ok = (c, l, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${l} ${extra}`); if (!c) fails++; };
const until = async (pred, ms = 8000) => { const t = Date.now(); while (!pred() && Date.now() - t < ms) await sleep(50); return pred(); };

await provider.send('evm_setAutomine', [true]);

// --- venue: ROOT -> B -> C -> ROOT, balanced ---------------------------------
console.log('0. venue');
// Multicall3 at its canonical address: buildHops reads through it, and a call
// to a codeless address "succeeds" with 0x (see test-hot.mjs).
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
{
    const mc = await deploy('Multicall3Min');
    await provider.send('anvil_setCode', [MULTICALL3, await provider.getCode(await mc.getAddress())]);
}
const tRoot = await deploy('MockToken', 'ROOT', 0);
const tB = await deploy('MockToken', 'B', 0);
const tC = await deploy('MockToken', 'C', 0);
const [ROOT, B, C] = [await tRoot.getAddress(), await tB.getAddress(), await tC.getAddress()];
const pAB = await deploy('MockPair', ROOT, B, 30);
const pBC = await deploy('MockPair', B, C, 30);
const pCA = await deploy('MockPair', C, ROOT, 30);
const [AB, BC, CA] = [await pAB.getAddress(), await pBC.getAddress(), await pCA.getAddress()];
const seed = async (pair, tx, ax, ty, ay) => {
    await (await tx.mint(await pair.getAddress(), ax)).wait();
    await (await ty.mint(await pair.getAddress(), ay)).wait();
    await (await pair.sync()).wait();
};
await seed(pAB, tRoot, E(1_000_000), tB, E(1_000_000));
await seed(pBC, tB, E(1_000_000), tC, E(1_000_000));
await seed(pCA, tC, E(1_000_000), tRoot, E(1_000_000));
const lender = await deploy('MockAavePool', 5n);       // 0.05% premium
const POOL = await lender.getAddress();
await (await tRoot.mint(POOL, E(10_000_000))).wait();
const exec = await deploy('FlashArbExecutor', POOL);
const EXEC = await exec.getAddress();
await (await tRoot.mint(w.address, E(1_000_000))).wait();
await (await tRoot.approve(AB, E(1_000_000))).wait();
// CA never calls back. The profitable direction behind the victim is
// ROOT -> C (CA) -> B -> ROOT (AB), so CA is the flash-swapped first hop: it reverts, and the
// probe must retry through the lender exactly as attempt() would.
await (await pCA.setFlashOff(true)).wait();

// --- DB + index --------------------------------------------------------------
console.log('\n1. index');
const db = new ArbitradeDB(`${WORK}/pending.sqlite`);
const raw = db.db;
const FACTORY = '0x00000000000000000000000000000000000f4c70';
const now = Math.floor(Date.now() / 1000);
raw.prepare('INSERT INTO factories (address,name,type,fee,deployBlock) VALUES (?,?,?,?,?)').run(FACTORY, 'MockFactory', 'v2', 0.003, 0);
const insPair = raw.prepare('INSERT INTO pairs (address,factory,token0,token1,blockNumber,fee,stable) VALUES (?,?,?,?,?,?,?)');
const insRes = raw.prepare('INSERT INTO reserves (pair,reserves0,reserves1,blockNumber,updatedAt) VALUES (?,?,?,?,?)');
const insTok = raw.prepare('INSERT INTO tokens (address,symbol,name,decimals,fetchStatus,fetchedAt,discoveredAt) VALUES (?,?,?,?,?,?,?)');
for (const [sym, addr] of [['ROOT', ROOT], ['B', B], ['C', C]]) insTok.run(addr.toLowerCase(), sym, sym, 18, 'ok', now, now);
for (const p of [pAB, pBC, pCA]) {
    const [r0, r1] = await p.getReserves();
    insPair.run((await p.getAddress()).toLowerCase(), FACTORY, (await p.token0()).toLowerCase(), (await p.token1()).toLowerCase(), 1, 0.003, null);
    insRes.run((await p.getAddress()).toLowerCase(), r0.toString(), r1.toString(), 1, now);
}
raw.prepare(`INSERT INTO triangles (id,root_token,hop_count,token_a,token_b,token_c,pair_ab,pair_bc,pair_ca,
    factory_ab,factory_bc,factory_ca,canonical,createdAt) VALUES (1,?,3,?,?,?,?,?,?,?,?,?,?,?)`)
   .run(ROOT.toLowerCase(), ROOT.toLowerCase(), B.toLowerCase(), C.toLowerCase(), AB.toLowerCase(), BC.toLowerCase(), CA.toLowerCase(),
        FACTORY, FACTORY, FACTORY, [AB, BC, CA].map(a => a.toLowerCase()).sort().join('-'), now);
const ix = TriangleIndex.build(db, new Map([[FACTORY, { address: FACTORY, fee: 0.003 }]]));
const pricing = { [ROOT.toLowerCase()]: { symbol: 'ROOT', priceInNumeraire: 1, sourceLiquidity: 1e24, minProfitInRootTokens: 0.01, minInputInRootTokens: 0.1 } };
const thresholds = {
    minProfitByRoot: new Map(ix.tokenAddr.map(a => [a, 0.01 * 1e18])),
    minInputByRoot: new Map(ix.tokenAddr.map(a => [a, 0.1 * 1e18])),
    minReserveByToken: Float64Array.from(ix.tokenAddr.map(() => 1e18)),
    maxRoi: 20, flashPremium: 0.0005,
};
ok(ix.triangleCount === 1 && ix.scoreAll(thresholds).length === 0, 'one triangle, nothing profitable at balanced reserves');

const cfg = {
    raw: {},
    chain: { name: 'Anvil', label: 'anvil', id: 31337, host: RPC_URL, token: ROOT, executor: EXEC },
    factories: [{ address: FACTORY, fee: 0.003 }],
    flashloan: { provider: 'aave-v3', pool: POOL, premium: 0.0005, flashSwap: true,
        tokens: [ROOT, B, C].map((a, i) => ({ symbol: ['ROOT', 'B', 'C'][i], address: a, decimals: 18 })) },
    evaluator: { minProfitTokens: 0.01, minLiquidityTokens: 1, minInputTokens: 0.1 },
    scan: {},
};
const executor = new CandidateExecutor(cfg, provider, pricing, {
    ownerAddress: w.address, live: false, gasMarginMultiple: 1, minProfitTokens: 0.01, gasPriceMaxAgeMs: 1,
});

// --- probe -------------------------------------------------------------------
console.log('\n2. probe on the mempool');
const records = [];
const plans = [];
const logs = [];
let indexed = await provider.getBlockNumber();
const backend = rpcBackend(RPC_URL);
const probe = createPendingProbe({
    index: ix, thresholds: () => thresholds, pricing: () => pricing,
    decimalsByToken: new Map(ix.tokenAddr.map(a => [a, 18])),
    ...backend,
    indexedBlock: () => indexed,
    backrun: {
        prepare: async (c, post) => { const p = await executor.prepareBackrun(c, db, post); plans.push(p); return p; },
        bundle: backend.bundle,
        profitOf: (l) => executor.arbExecutedProfit(l),
    },
    minMoveBps: 10,
    receiptPollMs: 100,
    landWaitMs: 15_000,
    record: (o) => records.push(o),
    log: (s) => { logs.push(s); console.log(`    ${s}`); },
});
const feed = subscribePending([WS_URL], probe.onPending, { log: (s) => console.log(`    ${s}`) });
ok(await until(() => feed.stats().connected === 1), 'subscribed to anvil\'s pending feed');

await provider.send('evm_setAutomine', [false]);
const abBefore = [ix.res0[ix.pairIdx.get(AB.toLowerCase())], ix.res1[ix.pairIdx.get(AB.toLowerCase())]];

// Noise first: an approve (token op), a mint naming no pair and one token, a tiny swap.
let nonce = await provider.getTransactionCount(w.address, 'pending');
const gas = { gasLimit: 300_000n, maxFeePerGas: 10n ** 10n, maxPriorityFeePerGas: 10n ** 9n };
await tB.approve(AB, 1n, { ...gas, nonce: nonce++ });
await tC.mint(w.address, 1n, { ...gas, nonce: nonce++ });
await pAB.drift(ROOT, E(10), { ...gas, nonce: nonce++ });           // ~0.1bps on a 1M pool
await until(() => probe.stats().seen >= 3);
await probe.idle();
let s = probe.stats();
ok(s.notASwap >= 1, 'approve skipped as a token op, no simulation', JSON.stringify({ notASwap: s.notASwap }));
ok(s.filteredOut >= 1, 'mint naming none of our pairs skipped', JSON.stringify({ filteredOut: s.filteredOut }));
ok(s.simulated === 1 && s.touchedOurPools === 1 && s.belowGate === 1 && s.opportunities === 0 && s.backrunsTried === 0,
   'tiny swap simulated, touches AB, gated below 10bps — no backrun built', JSON.stringify(s));
await provider.send('evm_mine', []);
// The noise block lands; bring the index up to it as the Sync feed would.
for (const p of [pAB]) { const [r0, r1] = await p.getReserves(); ix.applySync((await p.getAddress()), Number(r0), Number(r1)); }
indexed = await provider.getBlockNumber();
const abMid = [ix.res0[ix.pairIdx.get(AB.toLowerCase())], ix.res1[ix.pairIdx.get(AB.toLowerCase())]];

// The victim: a big swap that opens ROOT -> B -> C -> ROOT. Then, at the same
// fee, a tx touching CA — standing in for a backrunner.
const nonceBeforeVictim = await provider.getTransactionCount(w.address, 'latest');
const victim = await pAB.drift(ROOT, E(100_000), { ...gas, nonce: nonce++ });
const after = await pCA.sync({ ...gas, nonce: nonce++ });
ok(await until(() => probe.stats().opportunities === 1), 'victim seen pending, simulated, and opens a cycle', JSON.stringify(probe.stats()));

const pi = ix.pairIdx.get(AB.toLowerCase());
ok(ix.res0[pi] === abMid[0] && ix.res1[pi] === abMid[1] && ix.scoreAll(thresholds).length === 0,
   'live index untouched by the shadow score (no candidate before the victim lands)');
ok(abMid[0] !== abBefore[0] || abMid[1] !== abBefore[1], '(sanity) the tiny swap did move AB in the index');
ok(logs.some(l => l.includes(victim.hash.slice(0, 12)) && /new cycle/.test(l)), 'detection logged with the victim hash');

// Phase 2, checked while the victim is still pending.
// Not idle(): that would also wait out the landing check for a victim not yet mined.
await until(() => probe.stats().backrunClean + probe.stats().backrunReverted + probe.stats().backrunDecayed + probe.stats().backrunRefused >= 1);
s = probe.stats();
ok(s.backrunsTried === 1 && s.backrunClean === 1 && s.backrunClearsFloor === 1,
   'backrun built on the post-swap reserves executes behind the victim and clears the gas floor', JSON.stringify({
       tried: s.backrunsTried, decayed: s.backrunDecayed, refused: s.backrunRefused, reverted: s.backrunReverted, clean: s.backrunClean, clears: s.backrunClearsFloor }));
ok(logs.some(l => /\[backrun\].*WOULD SEND/.test(l)), 'backrun verdict logged');
// The same call at latest — the victim still pending — has no edge to take:
// proof that the victim's state, not something already on chain, is what it trades.
{
    const tx = plans.find(p => p.tx)?.tx;
    let reverted = false;
    try { await provider.call({ from: tx.from, to: tx.to, data: tx.data }); } catch { reverted = true; }
    ok(tx && reverted, 'the same call without the victim reverts at latest');
}
ok(await provider.getTransactionCount(w.address, 'latest') === nonceBeforeVictim, 'nothing of ours was sent (the owner nonce is unchanged on chain)');

await provider.send('evm_mine', []);
const minedAt = await provider.getBlockNumber();
// Apply the victim's block to the index, as the Sync feed would, then let the outcome check run.
{ const [r0, r1] = await pAB.getReserves(); ix.applySync(AB, Number(r0), Number(r1)); }
indexed = minedAt;
await probe.idle();

s = probe.stats();
const rec = records.find(r => r.hash === victim.hash);
ok(s.landed === 1 && rec?.landed === true && rec.block === minedAt && rec.index === 0, 'victim landed, block and position recorded',
   JSON.stringify({ block: rec?.block, index: rec?.index }));
ok(rec?.lateSim === false && s.lateSim === 0, 'simulation ran on the block before the victim\'s');
ok(rec?.next?.hash === after.hash && rec.next.touchedCyclePools === true && rec.next.sameGasPrice === true && s.nextTouchedPools === 1,
   'the tx after the victim is recorded as touching the cycle, at the same gas price');
ok(rec?.stillOpenAfter === true && s.stillOpen === 1, 'nobody arbitraged it: still open once the index has the block');
ok(rec?.cycles?.[0]?.netProfit > 0 && rec.moves.some(m => m.pair === AB.toLowerCase() && m.bps > 10), 'record carries the cycle profit and the move',
   JSON.stringify(rec?.cycles?.[0]));
const b = rec?.cycles?.[0]?.backrun;
// flashFeeFor rounds the lender's fee UP (safe direction), so the prediction may sit a wei under.
ok(b?.funding === 'aave-v3' && typeof b.flashSwapError === 'string', 'the flash swap through CA reverted and the backrun fell back to the lender', JSON.stringify({ funding: b?.funding, flashSwapError: b?.flashSwapError }));
ok(b?.result === 'clears-floor' && BigInt(b.profit) - BigInt(b.expectedProfit) >= 0n && BigInt(b.profit) - BigInt(b.expectedProfit) <= 1n && BigInt(b.gasUsed) > 0n,
   'ArbExecuted profit in the bundle equals the exact walk on the post-swap reserves (to the fee\'s 1-wei round-up)', JSON.stringify(b));
// A standing cycle is not credited to the next swap through it.
console.log('\n3. standing edge');
await pAB.drift(ROOT, E(5_000), { ...gas, nonce: nonce++ });   // ~100bps: clears the gate, but the cycle already scores
ok(await until(() => probe.stats().simulated >= 4), 'the swap was simulated (4th: the CA sync above was the 3rd)', JSON.stringify(probe.stats()));
await probe.idle();
s = probe.stats();
ok(s.opportunities === 1 && s.standingSkipped >= 1, 'a swap through an already-open cycle is not counted as opening it',
   JSON.stringify({ opportunities: s.opportunities, standing: s.standingSkipped }));
await provider.send('evm_mine', []);

feed.stop();
backend.destroy();
await provider.send('evm_setAutomine', [true]);
db.close();
provider.destroy();
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
