// End-to-end test of the Sync watcher against a real chain (anvil).
//
// Exercises the things that actually break: multiple Syncs for one pair in one
// block (must collapse to the last), blocks that land between polls (must not
// be skipped), uninteresting pairs (must be discarded), and a throwing
// consumer (must not kill the feed).

import { JsonRpcProvider, Wallet, ContractFactory } from 'ethers';
import { readFileSync } from 'fs';
import { watchSync, decodeSync, SYNC_TOPIC } from '../source/orchestrator/sync-watcher.ts';

const art = JSON.parse(readFileSync(new URL('./artifacts.json', import.meta.url), 'utf8'));
const RPC_URL = 'http://127.0.0.1:8545';
const provider = new JsonRpcProvider(RPC_URL, undefined, { cacheTimeout: -1, staticNetwork: true });
const w = new Wallet('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', provider);

const deploy = async (n, ...a) => {
    const f = new ContractFactory(art[n].abi, art[n].bytecode, w);
    const c = await f.deploy(...a); await c.waitForDeployment(); return c;
};
const E = (n) => BigInt(Math.round(n)) * 10n ** 18n;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let fails = 0;
const ok = (c, l, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${l} ${extra}`); if (!c) fails++; };

// --- topic + decoder sanity -------------------------------------------------
console.log('1. topic and decoder');
{
    const { id } = await import('ethers');
    ok(SYNC_TOPIC === id('Sync(uint112,uint112)'), 'SYNC_TOPIC matches keccak of the signature');
    const data = '0x' + (123n).toString(16).padStart(64, '0') + (456n).toString(16).padStart(64, '0');
    const d = decodeSync(data);
    ok(d?.reserve0 === 123 && d?.reserve1 === 456, 'decodes two uint112 words', JSON.stringify(d));
    ok(decodeSync('0x') === null, 'rejects short data');
    ok(decodeSync(undefined) === null, 'rejects undefined');
    // uint112 max must not throw, even though it loses low-digit precision
    const big = '0x' + ((1n << 112n) - 1n).toString(16).padStart(64, '0').repeat(1) + ((1n << 112n) - 1n).toString(16).padStart(64, '0');
    const bd = decodeSync(big);
    ok(bd !== null && bd.reserve0 > 5e33, 'handles uint112 max', bd?.reserve0.toExponential(3));
}

// --- set up two pairs, only one of which we care about ----------------------
const tA = await deploy('MockToken', 'A', 0);
const tB = await deploy('MockToken', 'B', 0);
const [A, B] = [await tA.getAddress(), await tB.getAddress()];
const watched = await deploy('MockPair', A, B, 30);
const ignored = await deploy('MockPair', A, B, 30);
const [WP, IP] = [(await watched.getAddress()).toLowerCase(), (await ignored.getAddress()).toLowerCase()];

for (const [p, addr] of [[watched, WP], [ignored, IP]]) {
    await (await tA.mint(addr, E(1_000_000))).wait();
    await (await tB.mint(addr, E(1_000_000))).wait();
    await (await p.sync()).wait();
}

const batches = [];
const errors = [];
let throwOnce = true;
let slowMs = 0;   // artificial consumer latency, set by the regression test

/** Wait until the watcher has drained up to the current chain head. */
const settle = async (tries = 40) => {
    const head = await provider.getBlockNumber();
    for (let i = 0; i < tries && watcher.lastBlock() < head; i++) await sleep(150);
    return head;
};
const watcher = await watchSync(RPC_URL, undefined, {
    isInteresting: (pair) => pair === WP,
    onBatch: async (updates, toBlock) => {
        batches.push({ updates, toBlock });
        if (throwOnce) { throwOnce = false; throw new Error('consumer blew up on purpose'); }
        if (slowMs) await sleep(slowMs);
    },
    onError: (e, ctx) => {
        // Do NOT swallow these. An earlier version of this test used
        // `onError: () => {}` and the watcher's real bug (a dropped block
        // notification) showed up only as two downstream assertion failures
        // with no explanation. The planted consumer throw is expected, so it
        // is named rather than hidden.
        errors.push({ ctx, msg: e.message });
        if (ctx !== 'onBatch') console.log(`     [watcher error] ${ctx}: ${e.message}`);
    },
    pollMs: 200,
});

console.log('\n2. only interesting pairs reach the consumer');
{
    batches.length = 0;
    await (await tA.mint(IP, E(1000))).wait();
    await (await ignored.sync()).wait();          // Sync on the ignored pair
    await (await tA.mint(WP, E(1000))).wait();
    await (await watched.sync()).wait();          // Sync on the watched pair
    await settle();

    const all = batches.flatMap(b => b.updates);
    ok(all.length > 0, 'received a batch', `${batches.length} batch(es)`);
    ok(all.every(u => u.pair === WP), 'every update is the watched pair');
    ok(!all.some(u => u.pair === IP), 'ignored pair never appears');
    const st = watcher.stats();
    ok(st.updatesSeen > st.updatesKept, 'saw more logs than it kept (filtering works)',
       `seen ${st.updatesSeen}, kept ${st.updatesKept}`);
}

console.log('\n3. a throwing consumer does not kill the feed');
{
    ok(throwOnce === false, 'the planted throw was actually hit');
    batches.length = 0;
    await (await tA.mint(WP, E(500))).wait();
    await (await watched.sync()).wait();
    await settle();
    ok(batches.length > 0, 'still delivering after the consumer threw');
    ok(watcher.stats().errors > 0, 'and the error was counted', `${watcher.stats().errors}`);
    ok(errors.some(e => e.ctx === 'onBatch'), 'the error was attributed to onBatch, not the feed',
       errors.map(e => e.ctx).join(',') || 'none');
}

console.log('\n4. several Syncs on one pair collapse to the latest');
{
    batches.length = 0;
    // Mine many syncs quickly; across however many blocks anvil uses, each
    // pair must appear at most once per delivered batch.
    for (let i = 0; i < 6; i++) {
        await (await tA.mint(WP, E(100))).wait();
        await (await watched.sync()).wait();
    }
    await settle();

    let dupeInBatch = false;
    for (const b of batches) {
        const seen = new Set();
        for (const u of b.updates) { if (seen.has(u.pair)) dupeInBatch = true; seen.add(u.pair); }
    }
    ok(!dupeInBatch, 'no pair appears twice in a single batch');

    // The final reported reserves must equal the chain's current reserves.
    const [r0, r1] = await watched.getReserves();
    const lastForPair = batches.flatMap(b => b.updates).filter(u => u.pair === WP).pop();
    ok(lastForPair != null, 'got a final update for the pair');
    if (lastForPair) {
        ok(lastForPair.reserve0 === Number(r0) && lastForPair.reserve1 === Number(r1),
           'reported reserves match getReserves()',
           `${lastForPair.reserve0.toExponential(4)} vs ${Number(r0).toExponential(4)}`);
    }
}

console.log('\n5. blocks landing between polls are not skipped');
{
    // Mine a burst while the watcher is idle between polls, then confirm the
    // drained block range covers all of them.
    const before = watcher.lastBlock();
    batches.length = 0;
    for (let i = 0; i < 5; i++) {
        await (await tA.mint(WP, E(10))).wait();
        await (await watched.sync()).wait();
    }
    const head = await settle();
    ok(watcher.lastBlock() >= head, 'drained up to the chain head', `last=${watcher.lastBlock()} head=${head}`);
    const st = watcher.stats();
    ok(st.blocksDrained >= head - before, 'no gap in drained blocks',
       `drained ${st.blocksDrained} blocks, chain advanced ${head - before}`);
}

console.log('\n6. a slow consumer does not leave the feed behind (regression)');
{
    // THE bug this watcher had. While a drain was in flight, an incoming block
    // notification was discarded rather than recorded, so nothing re-triggered
    // the catch-up. It only looked healthy because the NEXT block's tick found
    // the watcher idle and swept the backlog forward — on a chain that then
    // went quiet, it sat behind indefinitely.
    //
    // Reproduced by making onBatch slower than several poll intervals, mining a
    // burst underneath it, and then mining NOTHING. With the bug, lastBlock()
    // stays short of head forever because no later tick arrives to rescue it.
    slowMs = 700;
    batches.length = 0;
    for (let i = 0; i < 4; i++) {
        await (await tA.mint(WP, E(5))).wait();
        await (await watched.sync()).wait();
    }
    const head = await provider.getBlockNumber();
    slowMs = 0;                                   // chain is now silent
    for (let i = 0; i < 60 && watcher.lastBlock() < head; i++) await sleep(150);
    ok(watcher.lastBlock() >= head, 'caught up with no further blocks to trigger it',
       `last=${watcher.lastBlock()} head=${head}`);

    // And the reserves it ended on must be the chain's, not a stale snapshot.
    const [r0] = await watched.getReserves();
    const lastSeen = batches.flatMap(b => b.updates).filter(u => u.pair === WP).pop();
    ok(lastSeen && lastSeen.reserve0 === Number(r0), 'final reserves are current, not stale',
       `${lastSeen?.reserve0.toExponential(6)} vs ${Number(r0).toExponential(6)}`);
}

console.log('\n7. stop() is clean');
{
    await watcher.stop();
    const at = watcher.lastBlock();
    await (await tA.mint(WP, E(10))).wait();
    await (await watched.sync()).wait();
    await sleep(800);
    ok(watcher.lastBlock() === at, 'no further drains after stop', `${at}`);
}

console.log(fails === 0 ? '\nALL WATCHER CHECKS PASS' : `\n${fails} FAILED`);
process.exit(fails ? 1 : 0);
