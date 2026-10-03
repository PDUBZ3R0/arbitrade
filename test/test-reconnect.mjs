// Does the subscribe transport survive a dead socket, and does it backfill?
//
// The bug this covers, observed on Sonic via publicnode: the websocket log
// subscription stopped delivering after ~3 minutes with ZERO errors raised.
// Nothing reconnected it, so the loop sat there looking healthy and blind —
// 19 batches, then silence, while the chain kept producing blocks.
//
// anvil won't drop a socket on request, so the connection runs through a proxy
// this test can kill. The interesting assertion is not "it reconnected" but
// "it did not lose the Syncs emitted while it was down": a bare reconnect
// resumes the feed and silently leaves the in-memory reserves stale for every
// pair that traded during the gap.

import { JsonRpcProvider, Wallet, ContractFactory } from 'ethers';
import { readFileSync } from 'fs';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { watchSync } from '../source/orchestrator/sync-watcher.ts';

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

// --- a websocket proxy whose connections we can sever ----------------------
function startKillableWsProxy(port) {
    const http = createServer();
    const wss = new WebSocketServer({ server: http });
    const live = new Set();
    wss.on('connection', (down) => {
        const up = new WebSocket('ws://127.0.0.1:8545');
        const pair = { down, up };
        live.add(pair);
        const queue = [];
        up.on('open', () => { for (const m of queue) up.send(m); queue.length = 0; });
        down.on('message', (m) => (up.readyState === WebSocket.OPEN ? up.send(m.toString()) : queue.push(m.toString())));
        up.on('message', (m) => { if (down.readyState === WebSocket.OPEN) down.send(m.toString()); });
        const shut = () => {
            live.delete(pair);
            try { up.close(); } catch {}
            try { down.close(); } catch {}
        };
        down.on('close', shut); up.on('close', shut);
        down.on('error', shut); up.on('error', shut);
    });
    return new Promise(r => http.listen(port, '127.0.0.1', () => r({
        kill() { for (const { down, up } of [...live]) { try { down.terminate(); } catch {} try { up.terminate(); } catch {} } },
        close() { try { wss.close(); } catch {} try { http.close(); } catch {} },
    })));
}

// --- venue ------------------------------------------------------------------
const tA = await deploy('MockToken', 'A', 0);
const tB = await deploy('MockToken', 'B', 0);
const pair = await deploy('MockPair', await tA.getAddress(), await tB.getAddress(), 30);
const WP = (await pair.getAddress()).toLowerCase();
await (await tA.mint(WP, E(1_000_000))).wait();
await (await tB.mint(WP, E(1_000_000))).wait();
await (await pair.sync()).wait();

const bump = async (amt) => {
    await (await tA.mint(WP, E(amt))).wait();
    await (await pair.sync()).wait();
};

const proxy = await startKillableWsProxy(8547);

const batches = [];
const errors = [];
const watcher = await watchSync(RPC_URL, 'ws://127.0.0.1:8547', {
    isInteresting: (p) => p === WP,
    onBatch: (u, b) => batches.push({ u, b }),
    onError: (e, ctx) => { errors.push(`${ctx}: ${e.message.slice(0, 120)}`); },
    addresses: () => [WP],
    addressChunkSize: 1,
    staleAfterMs: 2_000,          // the real default is 45s
    overlapBlocks: 3,
});

console.log('1. healthy before the kill');
{
    ok(watcher.transport() === 'subscribe', 'subscribe transport', watcher.transport());
    await bump(100);
    for (let i = 0; i < 40 && batches.length === 0; i++) await sleep(100);
    ok(batches.length > 0, 'delivering', `${batches.length} batch(es)`);
    ok(watcher.headBlock() > 0, 'headBlock tracks the chain', `${watcher.headBlock()}`);
}

console.log('\n2. kill the socket, then trade DURING the outage');
const beforeKill = watcher.lastBlock();
let reservesDuringGap;
{
    proxy.kill();
    await sleep(300);
    // Three Syncs the subscription cannot possibly have seen.
    await bump(500); await bump(500); await bump(500);
    [reservesDuringGap] = await pair.getReserves();
    batches.length = 0;
    ok(true, 'three Syncs emitted while the feed was down',
       `reserves now ${Number(reservesDuringGap).toExponential(6)}`);
}

console.log('\n3. it must notice, reconnect, and BACKFILL the gap');
{
    for (let i = 0; i < 100 && watcher.stats().reconnects === 0; i++) await sleep(100);
    ok(watcher.stats().reconnects > 0, 'reconnected on its own', `${watcher.stats().reconnects} reconnect(s)`);
    ok(errors.some(e => e.startsWith('reconnect:')), 'and said so rather than doing it silently',
       errors.find(e => e.startsWith('reconnect:'))?.slice(0, 100) ?? 'none');

    for (let i = 0; i < 100 && batches.length === 0; i++) await sleep(100);
    ok(batches.length > 0, 'the gap was re-delivered', `${batches.length} batch(es)`);

    // THE assertion: post-recovery reserves must equal the chain's, which is
    // only true if the missed Syncs were recovered rather than skipped.
    const seen = batches.flatMap(b => b.u).filter(u => u.pair === WP).pop();
    ok(seen != null, 'got an update for the pair');
    ok(seen && seen.reserve0 === Number(reservesDuringGap),
       'recovered reserves match the chain (no silent staleness)',
       `${seen?.reserve0.toExponential(6)} vs ${Number(reservesDuringGap).toExponential(6)}`);
    ok(watcher.lastBlock() >= beforeKill, 'the Sync cursor advanced past the gap',
       `${beforeKill} -> ${watcher.lastBlock()}`);
}

console.log('\n4. still live afterwards');
{
    batches.length = 0;
    await bump(25);
    for (let i = 0; i < 60 && batches.length === 0; i++) await sleep(100);
    ok(batches.length > 0, 'new Syncs arrive on the rebuilt subscription', `${batches.length}`);
    const [r0] = await pair.getReserves();
    const seen = batches.flatMap(b => b.u).filter(u => u.pair === WP).pop();
    ok(seen && seen.reserve0 === Number(r0), 'and are current');
}

await watcher.stop();
proxy.close();
provider.destroy();
console.log(fails === 0 ? '\nALL RECONNECT CHECKS PASS' : `\n${fails} FAILED`);
process.exit(fails ? 1 : 0);
