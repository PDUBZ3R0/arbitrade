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
import { createPendingProbe, rpcBackend, subscribePending, victimGasPrice, competitorVerdict } from '../source/orchestrator/pending-probe.ts';
import { CandidateExecutor } from '../source/orchestrator/attempt.ts';
import { SYNC_TOPIC } from '../source/orchestrator/sync-watcher.ts';

import fs from 'node:fs';

// The executor records confirmed trades through ledgerPath(); without this it
// writes into the repo's real db/ledger.sqlite (2026-11-01: test-stable left
// two 'anvil' DAI trades there).
process.env.ARB_LEDGER ??= `${fs.mkdtempSync('/tmp/arbitrade-ledger-')}/ledger.sqlite`;

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
const prepareArgs = [];
const logs = [];
let indexed = await provider.getBlockNumber();
const backend = rpcBackend(RPC_URL);
const probe = createPendingProbe({
    index: ix, thresholds: () => thresholds, pricing: () => pricing,
    decimalsByToken: new Map(ix.tokenAddr.map(a => [a, 18])),
    ...backend,
    indexedBlock: () => indexed,
    backrun: {
        prepare: async (c, post) => { prepareArgs.push({ c, post }); const p = await executor.prepareBackrun(c, db, post); plans.push(p); return p; },
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
ok(s.phantomMoves === 0 && s.confirmErrors === 0, 'the victim\'s move is confirmed by reading AB before and after it',
   JSON.stringify({ phantom: s.phantomMoves, confirmErrors: s.confirmErrors }));
// The same call at latest — the victim still pending — has no edge to take:
// proof that the victim's state, not something already on chain, is what it trades.
{
    const tx = plans.find(p => p.tx)?.tx;
    let reverted = false;
    try { await provider.call({ from: tx.from, to: tx.to, data: tx.data }); } catch { reverted = true; }
    ok(tx && reverted, 'the same call without the victim reverts at latest');
}
ok(await provider.getTransactionCount(w.address, 'latest') === nonceBeforeVictim, 'nothing of ours was sent (the owner nonce is unchanged on chain)');

// Trims (Sonic VPS, 2026-11-02: seen→ready 193–666ms against a ~274ms window).
{
    // The path's other pools are read at the victim's simulation block, in one round.
    const { c, post } = prepareArgs[0] ?? {};
    const simBase = Number(logs.find(l => l.includes(victim.hash.slice(0, 12)) && /simulated in \d+ms on block/.test(l))?.match(/on block (\d+)/)?.[1]);
    ok(post?.block === simBase && Number.isFinite(simBase), 'the backrun is built at the victim\'s simulation block', JSON.stringify({ post: post?.block, simBase }));
    ok(plans[0]?.built?.blockTag === simBase, 'its path was read at that block', JSON.stringify({ blockTag: plans[0]?.built?.blockTag }));
    // An endpoint that can't serve the block (one behind in the pool): read again, unpinned.
    const p = await executor.prepareBackrun(c, db, { ...post, block: 1e9 });
    ok(p.tx && p.built.expectedProfit === plans[0].built.expectedProfit && p.stages?.some(([l]) => l === 'build (pinned, failed)'),
       'a pinned read that fails is retried unpinned, and builds the same', JSON.stringify({ tx: !!p.tx, stages: p.stages, error: p.error }));
    // A stale gas price is refreshed without waiting, when one is already held.
    const held = executor.gasPriceWei;
    executor.gasPriceFetchedAt = 0;
    await executor.ensureGasPrice({ background: true });
    const inFlight = executor.gasPriceRefresh;
    ok(held != null && inFlight != null && executor.gasPriceFetchedAt === 0 && executor.gasPriceWei === held,
       'background: the held gas price is used now, the refresh runs behind it');
    await inFlight;
    ok(executor.gasPriceFetchedAt > 0 && executor.gasPriceRefresh === null, 'background: the refresh lands, and only one ran');
}

// The same victim seen by a probe told its sender is two nonces behind:
// queued behind a gap, not next to land — no backrun is built for it.
{
    const gapRecords = [];
    const order = [];
    let prepared = 0;
    const gapped = createPendingProbe({
        index: ix, thresholds: () => thresholds, pricing: () => pricing,
        decimalsByToken: new Map(ix.tokenAddr.map(a => [a, 18])),
        ...backend,
        nonceOf: async () => { order.push('nonce asked'); return victim.nonce - 2; },
        readPools: async (...a) => { const r = await backend.readPools(...a); order.push('read-back done'); return r; },
        backrun: { prepare: async () => { prepared++; return {}; }, bundle: backend.bundle, profitOf: () => null },
        minMoveBps: 10, landWaitMs: 1, record: (o) => gapRecords.push(o), log: () => {},
    });
    const raw = await provider.send('eth_getTransactionByHash', [victim.hash]);
    gapped.onPending(raw);
    await gapped.idle();
    const g = gapped.stats();
    ok(g.opportunities === 1 && g.nonceGapped === 1 && g.backrunsTried === 0 && prepared === 0 && gapRecords[0]?.nonceGap === 2,
       'a victim queued behind a nonce gap is recorded, not backrun', JSON.stringify({ opp: g.opportunities, gapped: g.nonceGapped, tried: g.backrunsTried, rec: gapRecords[0]?.nonceGap }));
    ok(probe.stats().nonceGapped === 0, '(sanity) the real probe saw the victim as next to land');
    ok(order.join() === 'nonce asked,read-back done', 'the nonce is asked alongside the read-back, not after it', order.join());
}
// A bundle simulated on a block that already holds the victim (Sonic,
// 2026-11-01: 15 of 22 reverts) is relabelled 'late' once the victim's block
// is known, and leaves the reverted count.
const lateRecords = [];
const lateProbe = createPendingProbe({
    index: ix, thresholds: () => thresholds, pricing: () => pricing,
    decimalsByToken: new Map(ix.tokenAddr.map(a => [a, 18])),
    ...backend,
    backrun: {
        prepare: (c, post) => executor.prepareBackrun(c, db, post),
        bundle: async () => ({ victimOk: true, ok: false, error: 'execution reverted', gasUsed: 1n, logs: [], baseBlock: 1e9 }),
        profitOf: () => null,
    },
    minMoveBps: 10, receiptPollMs: 100, landWaitMs: 15_000, record: (o) => lateRecords.push(o), log: () => {},
});
lateProbe.onPending(await provider.send('eth_getTransactionByHash', [victim.hash]));
ok(await until(() => lateProbe.stats().backrunReverted === 1), '(late) the stubbed bundle first counts as a revert', JSON.stringify(lateProbe.stats()));

// Reach: the real backrun clears the floor, but only counts as in time if it
// was ready before the victim's block was produced (Sonic VPS, 2026-11-02:
// 22 of 22 sends landed a block late). anvil has no ms block times, so the
// receipt is stubbed with one: before the probe even saw the victim, and well after.
const timedProbe = (blockAtMs) => {
    const records = [];
    const probe = createPendingProbe({
        index: ix, thresholds: () => thresholds, pricing: () => pricing,
        decimalsByToken: new Map(ix.tokenAddr.map(a => [a, 18])),
        ...backend,
        receipt: async (h) => { const r = await backend.receipt(h); return r && { ...r, timestampMs: blockAtMs }; },
        backrun: { prepare: (c, post) => executor.prepareBackrun(c, db, post), bundle: backend.bundle, profitOf: (l) => executor.arbExecutedProfit(l) },
        minMoveBps: 10, receiptPollMs: 100, landWaitMs: 15_000, record: (o) => records.push(o), log: () => {},
    });
    return { probe, records };
};
const tooLate = timedProbe(Date.now() - 1_000), inTime = timedProbe(Date.now() + 60_000);
for (const t of [tooLate, inTime]) t.probe.onPending(await provider.send('eth_getTransactionByHash', [victim.hash]));
ok(await until(() => tooLate.probe.stats().backrunClearsFloor === 1 && inTime.probe.stats().backrunClearsFloor === 1),
   '(reach) both timed probes see the backrun clear the floor', JSON.stringify([tooLate.probe.stats().backrunClearsFloor, inTime.probe.stats().backrunClearsFloor]));

// Sonic, 2026-11-01: a bot's tx that swaps and undoes it in a try/catch
// changes nothing, but Sonic's eth_simulateV1 returns the undone Sync. Here a
// simulation that reports a big AB Sync for a tx that touches nothing: the
// read-back of AB before and after it shows no change, and nothing is built.
{
    let prepared = 0;
    const fakeSync = { address: AB, topics: [SYNC_TOPIC],
        data: '0x' + [abMid[0] * 2, abMid[1] / 2].map(x => BigInt(Math.round(x)).toString(16).padStart(64, '0')).join('') };
    const phantom = createPendingProbe({
        index: ix, thresholds: () => thresholds, pricing: () => pricing,
        decimalsByToken: new Map(ix.tokenAddr.map(a => [a, 18])),
        ...backend,
        simulate: async () => ({ ok: true, logs: [fakeSync], baseBlock: await provider.getBlockNumber() }),
        backrun: { prepare: async () => { prepared++; return {}; }, bundle: backend.bundle, profitOf: () => null },
        minMoveBps: 10, landWaitMs: 1, log: () => {},
    });
    phantom.onPending({ hash: '0x' + 'ab'.repeat(32), from: w.address, to: '0x000000000000000000000000000000000000dEaD',
        input: '0x12345678' + AB.slice(2).toLowerCase().padStart(64, '0'), value: '0x0', gas: '0x30000', nonce: '0x0' });
    await phantom.idle();
    const ph = phantom.stats();
    ok(ph.simulated === 1 && ph.phantomMoves === 1 && ph.opportunities === 0 && prepared === 0,
       'a Sync the pool\'s state does not show is dropped: no opportunity, no backrun', JSON.stringify({ sim: ph.simulated, phantom: ph.phantomMoves, opp: ph.opportunities, filtered: ph.filteredOut, notASwap: ph.notASwap }));
    ok(ix.res0[pi] === abMid[0] && ix.res1[pi] === abMid[1], '(sanity) the live index still holds AB as it was');
}
// A custom error by name, not "execution reverted" (the probe's revert reasons).
{
    const data = executor.executor.interface.encodeErrorResult('InsufficientRepay', [5n, 7n]);
    ok(executor.describeRevert(data) === 'InsufficientRepay(5, 7)', 'describeRevert names the executor\'s custom error', executor.describeRevert(data));
}
await provider.send('evm_mine', []);
const minedAt = await provider.getBlockNumber();
// Apply the victim's block to the index, as the Sync feed would, then let the outcome check run.
{ const [r0, r1] = await pAB.getReserves(); ix.applySync(AB, Number(r0), Number(r1)); }
indexed = minedAt;
await probe.idle();
await lateProbe.idle();
{
    const ls = lateProbe.stats(), lb = lateRecords.find(r => r.hash === victim.hash)?.cycles?.[0]?.backrun;
    ok(ls.backrunLate === 1 && ls.backrunReverted === 0 && lb?.result === 'late' && lb.lateResult === 'reverted',
       'a bundle on a block at or after the victim\'s is relabelled late, not reverted', JSON.stringify({ late: ls.backrunLate, reverted: ls.backrunReverted, rec: lb }));
}
ok(probe.stats().backrunLate === 0, '(sanity) the real bundle ran before the victim\'s block: not late');
await tooLate.probe.idle();
await inTime.probe.idle();
{
    const l = tooLate.probe.stats(), lr = tooLate.records.find(r => r.hash === victim.hash);
    ok(l.backrunTooLate === 1 && l.backrunInTime === 0 && lr?.reach?.inTime === false && lr.reach.leadMs < 0,
       'a block produced before the backrun was ready: TOO LATE, though it cleared the floor', JSON.stringify({ stats: [l.backrunInTime, l.backrunTooLate], reach: lr?.reach }));
    ok(l.competitorSeen === 1 && l.beatsCompetitor === 0, 'too late, it is not counted as able to outbid the competitor');
    const i = inTime.probe.stats(), ir = inTime.records.find(r => r.hash === victim.hash);
    ok(i.backrunInTime === 1 && i.backrunTooLate === 0 && ir?.reach?.inTime === true && ir.reach.leadMs >= ir.reach.marginMs,
       'a block well after the backrun was ready: in time', JSON.stringify({ stats: [i.backrunInTime, i.backrunTooLate], reach: ir?.reach }));
    ok(probe.stats().backrunInTime + probe.stats().backrunTooLate === 0 && records.find(r => r.hash === victim.hash)?.reach === undefined,
       'without ms block times (anvil) nothing is claimed either way');
}

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
// Per-stage timings (Sonic VPS, 2026-11-02: seen→sent ran 825ms median
// against a ~210ms window). The stages are serial, so they must account for
// seen→ready, give or take the probe's own bookkeeping between them.
{
    const br = rec?.cycles?.[0]?.backrun ?? {};
    const want = ['sim', 'read-back', 'score', 'nonce check', 'base fee'];
    ok(want.every(k => typeof rec?.stages?.[k] === 'number') && ['preflight', 'gas price', 'build', 'bundle'].every(k => typeof br.stages?.[k] === 'number'),
       'the record times every stage from seeing the victim to a simulated backrun', JSON.stringify({ victim: rec?.stages, backrun: br.stages }));
    const sum = Object.values(rec?.stages ?? {}).reduce((x, y) => x + y, 0) + Object.values(br.stages ?? {}).reduce((x, y) => x + y, 0);
    ok(typeof br.readyMs === 'number' && sum <= br.readyMs + 2 && br.readyMs - sum < 100,
       'the stages add up to seen→ready (nothing slow goes untimed)', JSON.stringify({ readyMs: br.readyMs, sum }));
    const st = s.stageMs;
    ok(st['seen→ready']?.n === 1 && st.sim?.n >= 1 && st.bundle?.n >= 1 && st['seen→ready'].p50 === br.readyMs,
       'stats carry the stage percentiles', JSON.stringify(st));
    ok(logs.some(l => l.includes(victim.hash.slice(0, 12)) && /seen→ready \d+ms: sim \d+, read-back \d+, score/.test(l)), 'the breakdown is logged for a floor-clearing backrun');
}
const b = rec?.cycles?.[0]?.backrun;
// flashFeeFor rounds the lender's fee UP (safe direction), so the prediction may sit a wei under.
ok(b?.funding === 'aave-v3' && typeof b.flashSwapError === 'string', 'the flash swap through CA reverted and the backrun fell back to the lender', JSON.stringify({ funding: b?.funding, flashSwapError: b?.flashSwapError }));
ok(b?.result === 'clears-floor' && BigInt(b.profit) - BigInt(b.expectedProfit) >= 0n && BigInt(b.profit) - BigInt(b.expectedProfit) <= 1n && BigInt(b.gasUsed) > 0n,
   'ArbExecuted profit in the bundle equals the exact walk on the post-swap reserves (to the fee\'s 1-wei round-up)', JSON.stringify(b));
// The floor is priced at the victim's gas price — the bid that lands directly
// behind it under fee ordering — not at the market price.
{
    const base = (await provider.getBlock(b.bundleBaseBlock)).baseFeePerGas;
    ok(BigInt(b.bidGasPrice) === base + gas.maxPriorityFeePerGas && b.floorAtMarket != null,
       'the bid is what the victim pays on the base block (base fee + its tip)', JSON.stringify({ bid: b.bidGasPrice, base: base.toString() }));
    const plan = plans.find(p => p.tx);
    const px = 1n << 40n, g = BigInt(b.gasUsed);
    const f = plan.floorFor(g, px);
    // Margin 1, ROOT is the numeraire: the floor is gas x bid, to float rounding.
    ok(Math.abs(Number(f) / Number(g * px) - 1) < 1e-9 && plan.floorFor(g, 1n) === plan.floorFor(g, 2n),
       'floorFor prices gas at the bid it is given, and the config floor still holds under a cheap bid', JSON.stringify({ f: f.toString(), want: (g * px).toString() }));
}
ok(rec?.competitor?.hash === after.hash && rec.competitor.offset === 1 && rec.competitor.belowVictim === false && s.competitorSeen === 1,
   'the tx that took the cycle\'s pools after the victim is recorded as the competitor, with its gas price', JSON.stringify(rec?.competitor));
// The CA sync after the victim paid the victim's own price — as Polygon's
// backrunner did: no bid beats it from behind the victim.
ok(rec.competitor.tiedVictim === true && b?.tiedAtVictimPrice === true && b.beatsCompetitor === false && b.floorToBeatCompetitor === b.floor
   && s.competitorTiedVictim === 1 && s.beatsCompetitor === 0,
   'a competitor at the victim\'s own price is a tie, not something to outbid', JSON.stringify({ floor: b?.floor, toBeat: b?.floorToBeatCompetitor, tied: b?.tiedAtVictimPrice }));
{
    // Below the victim: bid one wei over the competitor. Margin-free floor = gas x price for the check.
    const f = { floorFor: (g, px) => g * px, gasUsed: 100n, profit: 1_000n };
    const under = competitorVerdict(f, 5n, 20n), over = competitorVerdict({ ...f, profit: 500n }, 5n, 20n), tie = competitorVerdict(f, 20n, 20n);
    ok(under.beats && under.floor === 600n && !under.tied && !over.beats && !tie.beats && tie.tied && tie.floor === 2_000n,
       'competitorVerdict: outbid below the victim when profit allows; at the victim\'s price, a tie priced at the victim', JSON.stringify({ under, over, tie }, (k, v) => typeof v === 'bigint' ? String(v) : v));
}
// victimGasPrice: legacy pays gasPrice; 1559 pays min(cap, base + tip); no base fee -> the cap (errs high).
ok(victimGasPrice({ gasPrice: 7n }, 100n) === 7n
   && victimGasPrice({ maxFeePerGas: 50n, maxPriorityFeePerGas: 3n }, 10n) === 13n
   && victimGasPrice({ maxFeePerGas: 50n, maxPriorityFeePerGas: 45n }, 10n) === 50n
   && victimGasPrice({ maxFeePerGas: 50n, maxPriorityFeePerGas: 3n }, null) === 50n,
   'victimGasPrice: legacy, 1559 below the cap, 1559 at the cap, unknown base fee');
// A standing cycle is not credited to the next swap through it.
console.log('\n3. standing edge');
await pAB.drift(ROOT, E(5_000), { ...gas, nonce: nonce++ });   // ~100bps: clears the gate, but the cycle already scores
ok(await until(() => probe.stats().simulated >= 4), 'the swap was simulated (4th: the CA sync above was the 3rd)', JSON.stringify(probe.stats()));
await probe.idle();
s = probe.stats();
ok(s.opportunities === 1 && s.standingSkipped >= 1, 'a swap through an already-open cycle is not counted as opening it',
   JSON.stringify({ opportunities: s.opportunities, standing: s.standingSkipped }));
await provider.send('evm_mine', []);

// A socket that goes silent without closing is retired and reopened, and the
// connected count stays one per URL across reconnects.
console.log('\n4. silent feed');
{
    const quiet = subscribePending([WS_URL], () => {}, { stallMs: 1_000, log: (s) => console.log(`    ${s}`) });
    ok(await until(() => quiet.stats().connected === 1), 'second feed subscribed');
    ok(await until(() => quiet.stats().stalls >= 2 && quiet.stats().connected === 1, 15_000),
       'silence (no pending txs) retires the socket and resubscribes, still one feed up', JSON.stringify(quiet.stats()));
    quiet.stop();
    ok(await until(() => quiet.stats().connected === 0), 'stop() leaves nothing connected');
}

// Phase 3: --live-backruns. Its own venue, where one victim swap opens TWO
// cycles (ROOT -> B2 -> C2 and ROOT -> B2 -> D2, both through AB2), and the
// victim comes from another wallet, so nothing orders our tx behind it but
// the chain.
console.log('\n5. live backruns');
{
    await provider.send('evm_setAutomine', [true]);
    const v1 = new Wallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d', provider);
    const tB2 = await deploy('MockToken', 'B2', 0), tC2 = await deploy('MockToken', 'C2', 0), tD2 = await deploy('MockToken', 'D2', 0);
    const [B2, C2, D2] = [await tB2.getAddress(), await tC2.getAddress(), await tD2.getAddress()];
    const qAB = await deploy('MockPair', ROOT, B2, 30), qBC = await deploy('MockPair', B2, C2, 30), qCA = await deploy('MockPair', C2, ROOT, 30);
    const qBD = await deploy('MockPair', B2, D2, 30), qDA = await deploy('MockPair', D2, ROOT, 30);
    const qs = [qAB, qBC, qCA, qBD, qDA];
    await seed(qAB, tRoot, E(1_000_000), tB2, E(1_000_000));
    await seed(qBC, tB2, E(1_000_000), tC2, E(1_000_000));
    await seed(qCA, tC2, E(1_000_000), tRoot, E(1_000_000));
    await seed(qBD, tB2, E(1_000_000), tD2, E(1_000_000));
    await seed(qDA, tD2, E(1_000_000), tRoot, E(1_000_000));
    const QAB = await qAB.getAddress();
    await (await tRoot.mint(v1.address, E(1_000_000))).wait();
    await (await tRoot.connect(v1).approve(QAB, E(1_000_000))).wait();

    const db2 = new ArbitradeDB(`${WORK}/live.sqlite`);
    const r2 = db2.db;
    r2.prepare('INSERT INTO factories (address,name,type,fee,deployBlock) VALUES (?,?,?,?,?)').run(FACTORY, 'MockFactory', 'v2', 0.003, 0);
    const ins2Pair = r2.prepare('INSERT INTO pairs (address,factory,token0,token1,blockNumber,fee,stable) VALUES (?,?,?,?,?,?,?)');
    const ins2Res = r2.prepare('INSERT INTO reserves (pair,reserves0,reserves1,blockNumber,updatedAt) VALUES (?,?,?,?,?)');
    const ins2Tok = r2.prepare('INSERT INTO tokens (address,symbol,name,decimals,fetchStatus,fetchedAt,discoveredAt) VALUES (?,?,?,?,?,?,?)');
    for (const [sym, addr] of [['ROOT', ROOT], ['B2', B2], ['C2', C2], ['D2', D2]]) ins2Tok.run(addr.toLowerCase(), sym, sym, 18, 'ok', now, now);
    for (const p of qs) {
        const [r0, r1] = await p.getReserves();
        ins2Pair.run((await p.getAddress()).toLowerCase(), FACTORY, (await p.token0()).toLowerCase(), (await p.token1()).toLowerCase(), 1, 0.003, null);
        ins2Res.run((await p.getAddress()).toLowerCase(), r0.toString(), r1.toString(), 1, now);
    }
    const insTri = r2.prepare(`INSERT INTO triangles (id,root_token,hop_count,token_a,token_b,token_c,pair_ab,pair_bc,pair_ca,
        factory_ab,factory_bc,factory_ca,canonical,createdAt) VALUES (?,?,3,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const [id, X, pBX, pXA] of [[1, C2, qBC, qCA], [2, D2, qBD, qDA]]) {
        const ps = [QAB, await pBX.getAddress(), await pXA.getAddress()].map(a => a.toLowerCase());
        insTri.run(id, ROOT.toLowerCase(), ROOT.toLowerCase(), B2.toLowerCase(), X.toLowerCase(), ...ps, FACTORY, FACTORY, FACTORY, [...ps].sort().join('-'), now);
    }
    const ix2 = TriangleIndex.build(db2, new Map([[FACTORY, { address: FACTORY, fee: 0.003 }]]));
    const th2 = {
        minProfitByRoot: new Map(ix2.tokenAddr.map(a => [a, 0.01 * 1e18])),
        minInputByRoot: new Map(ix2.tokenAddr.map(a => [a, 0.1 * 1e18])),
        minReserveByToken: Float64Array.from(ix2.tokenAddr.map(() => 1e18)),
        maxRoi: 20, flashPremium: 0.0005,
    };
    ok(ix2.triangleCount === 2 && ix2.scoreAll(th2).length === 0, 'two triangles through AB2, nothing profitable yet');
    const syncAll = async () => { for (const p of qs) { const [r0, r1] = await p.getReserves(); ix2.applySync(await p.getAddress(), Number(r0), Number(r1)); } };

    const liveExec = new CandidateExecutor(cfg, provider, pricing, {
        ownerAddress: w.address, liveBackruns: true, signer: w, gasMarginMultiple: 1, minProfitTokens: 0.01, gasPriceMaxAgeMs: 1,
    });
    let indexed2 = await provider.getBlockNumber();
    const liveRecords = [], livePlans = [];
    const liveProbe = createPendingProbe({
        index: ix2, thresholds: () => th2, pricing: () => pricing,
        decimalsByToken: new Map(ix2.tokenAddr.map(a => [a, 18])),
        ...backend,
        // anvil has whole-second block times only; a block well after we were ready.
        receipt: async (h) => { const r = await backend.receipt(h); return r && { ...r, timestampMs: Date.now() + 60_000 }; },
        indexedBlock: () => indexed2,
        backrun: {
            prepare: async (c, post) => { const p = await liveExec.prepareBackrun(c, db2, post); livePlans.push(p); return p; },
            bundle: backend.bundle,
            profitOf: (l) => liveExec.arbExecutedProfit(l),
            describeRevert: (d) => liveExec.describeRevert(d),
            // 1 wei: the first reverted send stops sending.
            live: { bid: 'market', maxLossWei: 1n },
        },
        minMoveBps: 10, receiptPollMs: 100, landWaitMs: 4_000,
        record: (o) => liveRecords.push(o), log: (s) => { console.log(`    ${s}`); },
    });
    const vGas = { gasLimit: 300_000n, maxFeePerGas: 10n ** 10n, maxPriorityFeePerGas: 2n * 10n ** 9n };   // tips over our market bid: lands first
    // A different amount each time: the third victim reuses the dropped second
    // one's nonce, and with the same calldata it would be the same hash (a duplicate).
    let victims = 0;
    const sendVictim = async () => {
        // 'latest': every earlier victim is mined or dropped, and a dropped one can linger in anvil's pending count.
        const v = await qAB.connect(v1).drift(ROOT, E(100_000 + victims++), { ...vGas, nonce: await provider.getTransactionCount(v1.address, 'latest') });
        liveProbe.onPending(await provider.send('eth_getTransactionByHash', [v.hash]));
        return v;
    };
    const sentRecs = (rec) => (rec?.cycles ?? []).filter(c => c.backrun?.sent);
    await provider.send('evm_setAutomine', [false]);

    // a. A victim: one backrun sent, behind it in its block, confirmed, in the ledger.
    const va = await sendVictim();
    ok(await until(() => liveProbe.stats().backrunsSent + liveProbe.stats().backrunSendFailed >= 1 && liveProbe.stats().backrunClean === 2),
       'the victim opens both cycles and both execute behind it in the bundle', JSON.stringify(liveProbe.stats()));
    await provider.send('evm_mine', []);
    await syncAll();
    indexed2 = await provider.getBlockNumber();
    ok(await until(() => liveRecords.some(r => r.hash === va.hash), 20_000), 'the victim\'s outcome is recorded once our send settles');
    {
        const ls = liveProbe.stats(), rec = liveRecords.find(r => r.hash === va.hash), sent = sentRecs(rec);
        ok(ls.backrunsSent === 1 && sent.length === 1, 'one backrun sent for the victim, not one per cycle (they share AB2)', JSON.stringify({ sent: ls.backrunsSent, recs: sent.length }));
        const s0 = sent[0]?.backrun?.sent;
        const txr = s0?.txHash ? await provider.getTransactionReceipt(s0.txHash) : null;
        const vr = await provider.getTransactionReceipt(va.hash);
        ok(txr?.status === 1 && txr.blockNumber === vr.blockNumber && txr.index === vr.index + 1,
           'mined directly behind the victim, status 1', JSON.stringify({ block: txr?.blockNumber, index: txr?.index, victimIndex: vr?.index }));
        ok(s0?.minedBlock === vr.blockNumber && s0.inVictimBlock === true && ls.backrunsInVictimBlock === 1 && ls.backrunInTime === 1,
           'recorded as mined in the victim\'s block, and as ready in time', JSON.stringify({ minedBlock: s0?.minedBlock, inVictimBlock: s0?.inVictimBlock, n: ls.backrunsInVictimBlock }));
        ok(s0?.result === 'confirmed' && BigInt(s0.realisedProfit ?? 0) > 0n && ls.backrunsConfirmed === 1, 'recorded confirmed at its realised profit', JSON.stringify(s0));
        const cs = sent[0]?.backrun?.stages;
        ok(typeof cs?.['nonce+fees'] === 'number' && typeof cs.send === 'number' && ls.stageMs['seen→sent']?.n === 1 && ls.stageMs['seen→sent'].p50 === s0.msFromSeen,
           'the send\'s own stages are timed, and seen→sent is sampled', JSON.stringify({ stages: cs, seenToSent: ls.stageMs['seen→sent'] }));
        // The market bid: minProfit is the floor at the market price, not the victim's 2-gwei-tip price.
        const plan = livePlans.find(p => p.send);
        const cyc = sent[0]?.backrun;
        ok(cyc && BigInt(s0.minProfit) === plan.floorFor(BigInt(cyc.gasUsed)), 'minProfit enforced on-chain is the floor at the market gas price', JSON.stringify({ minProfit: s0?.minProfit, floorAtMarket: cyc?.floorAtMarket }));
        const { TradeLedger } = await import('../source/util/ledger.ts');
        const led = new TradeLedger(process.env.ARB_LEDGER);
        const row = led.getTrades({ limit: 50 }).find(t => t.txHash === s0?.txHash);
        led.close();
        ok(row && String(row.profitWei) === s0.realisedProfit, 'the ledger has the trade at the realised profit', JSON.stringify(row ?? null));
        ok(!ix2.scoreAll(th2).some(c => c.triangleId === sent[0]?.triangleId), '(sanity) our backrun closed the cycle it took');
    }

    // b. A victim that never lands: our backrun mines alone, reverts on its
    // on-chain floor, and its gas trips the 1-wei loss cap.
    const vb = await sendVictim();
    ok(await until(() => liveProbe.stats().backrunsSent === 2), 'second victim: a backrun sent');
    await provider.send('anvil_dropTransaction', [vb.hash]);
    await provider.send('evm_mine', []);
    indexed2 = await provider.getBlockNumber();
    ok(await until(() => liveProbe.stats().sendingStopped, 20_000), 'the reverted send stops sending', JSON.stringify(liveProbe.stats(), (k, v) => typeof v === 'bigint' ? String(v) : v));
    {
        const ls = liveProbe.stats();
        ok(ls.backrunsRevertedOnChain === 1 && ls.backrunGasLost > 0, 'counted as reverted on-chain, its gas as lost', `(${ls.backrunGasLost} native)`);
    }
    ok(await until(() => liveRecords.some(r => r.hash === vb.hash), 20_000), 'the dropped victim is recorded (not landed)');
    ok(sentRecs(liveRecords.find(r => r.hash === vb.hash))[0]?.backrun?.sent?.result === 'reverted', 'its record says our backrun reverted');

    // c. Past the cap: the next victim still simulates, nothing is sent.
    const cleanBefore = liveProbe.stats().backrunClean;
    const vc = await sendVictim();
    ok(await until(() => liveProbe.stats().backrunClean > cleanBefore), 'third victim: its backrun still simulated', JSON.stringify({ gapped: liveProbe.stats().nonceGapped }));
    {
        const ls = liveProbe.stats();
        ok(ls.backrunsSent === 2, 'nothing sent past the loss cap', JSON.stringify({ sent: ls.backrunsSent }));
    }
    await provider.send('evm_mine', []);
    await syncAll();
    indexed2 = await provider.getBlockNumber();
    ok(await until(() => liveRecords.some(r => r.hash === vc.hash), 20_000), 'third victim recorded');
    ok(liveRecords.find(r => r.hash === vc.hash).cycles.some(c => c.backrun?.notSent === 'loss cap reached'), 'its record says why it was not sent');
    await liveProbe.idle();

    // d. Two sends at once from one executor get consecutive nonces, not the
    // same one: the send lock (the hot loop's trade and a backrun race this way).
    {
        const plan = livePlans.find(p => p.send);
        const [a1, a2] = await Promise.all([plan.send(E(1_000_000), 400_000n), plan.send(E(1_000_000), 400_000n)]);
        const [t1, t2] = await Promise.all([a1, a2].map(a => a.txHash ? provider.getTransaction(a.txHash) : null));
        ok(a1.broadcast && a2.broadcast && t1 && t2 && Math.abs(t1.nonce - t2.nonce) === 1,
           'both sent, on consecutive nonces', JSON.stringify({ n1: t1?.nonce, n2: t2?.nonce, e1: a1.simulationError, e2: a2.simulationError }));
        await provider.send('evm_mine', []);
        await Promise.all([a1.settled, a2.settled].filter(Boolean));   // both revert on a 1M-ROOT floor; nothing else to see
    }
    await provider.send('evm_setAutomine', [true]);
    db2.close();
}

feed.stop();
backend.destroy();
await provider.send('evm_setAutomine', [true]);
db.close();
provider.destroy();
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
