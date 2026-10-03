// The three Sync transports, each against a real chain.
//
// Exists because a design assumption in sync-watcher.ts turned out to be a
// provider capability, not a universal: publicnode answers address-less
// eth_getLogs with -32701 "Please specify an address in your request". The
// watcher now probes and picks a strategy, so each strategy needs a test, and
// the restricted provider needs simulating — anvil itself is permissive.

import { JsonRpcProvider, Wallet, ContractFactory } from 'ethers';
import { readFileSync } from 'fs';
import { createServer } from 'http';
import { watchSync } from '../source/orchestrator/sync-watcher.ts';

const art = JSON.parse(readFileSync(new URL('./artifacts.json', import.meta.url), 'utf8'));
const RPC_URL = 'http://127.0.0.1:8545';
const WS_URL = 'ws://127.0.0.1:8545';
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

// --- a proxy that rejects address-less eth_getLogs, like publicnode does ----
function startRestrictedProxy(port) {
    const server = createServer((req, res) => {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', async () => {
            let parsed;
            try { parsed = JSON.parse(body); } catch { res.writeHead(400).end('{}'); return; }
            const calls = Array.isArray(parsed) ? parsed : [parsed];
            const offending = calls.find(c =>
                c.method === 'eth_getLogs' &&
                !(c.params?.[0]?.address && c.params[0].address.length));
            if (offending) {
                // Verbatim shape of the real refusal.
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({
                    jsonrpc: '2.0', id: offending.id,
                    error: { code: -32701, message: 'Please specify an address in your request or, to remove restrictions, order a dedicated full node here: https://www.allnodes.com/s/host' },
                }));
                return;
            }
            const upstream = await fetch(RPC_URL, {
                method: 'POST', headers: { 'content-type': 'application/json' }, body,
            });
            const text = await upstream.text();
            res.writeHead(upstream.status, { 'content-type': 'application/json' });
            res.end(text);
        });
    });
    return new Promise(r => server.listen(port, '127.0.0.1', () => r(server)));
}

// --- venue -----------------------------------------------------------------
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
const bump = async () => {
    await (await tA.mint(WP, E(100))).wait();
    await (await watched.sync()).wait();
};

async function collect(label, http, ws, extraOpts = {}) {
    const batches = [];
    const errors = [];
    const watcher = await watchSync(http, ws, {
        isInteresting: (pair) => pair === WP,
        onBatch: (u, b) => { batches.push({ u, b }); },
        onError: (e, ctx) => errors.push(`${ctx}: ${e.message.slice(0, 90)}`),
        pollMs: 200,
        ...extraOpts,
    });
    return { watcher, batches, errors };
}

// --- 1. subscribe ----------------------------------------------------------
console.log('1. subscribe transport (websocket, eth_subscribe logs)');
{
    const { watcher, batches, errors } = await collect('sub', RPC_URL, WS_URL);
    ok(watcher.transport() === 'subscribe', 'picked the subscribe transport', watcher.transport());
    ok(watcher.ready() === true, 'ready() true with zero drained blocks',
       `blocksDrained=${watcher.stats().blocksDrained}`);
    await bump();
    for (let i = 0; i < 40 && batches.length === 0; i++) await sleep(150);
    ok(batches.length > 0, 'a pushed log reached the consumer', `${batches.length} batch(es)`);
    ok(batches.every(b => b.u.every(x => x.pair === WP)), 'only the watched pair');
    const st = watcher.stats();
    ok(st.logsPushed > 0, 'counted as pushed, not drained',
       `pushed=${st.logsPushed} drained=${st.blocksDrained}`);
    ok(watcher.lastBlock() > 0, 'lastBlock advanced from the pushed log', `${watcher.lastBlock()}`);

    // Reserves must match the chain, same as the ranged path.
    const [r0] = await watched.getReserves();
    const lastSeen = batches.flatMap(b => b.u).filter(x => x.pair === WP).pop();
    ok(lastSeen && lastSeen.reserve0 === Number(r0), 'pushed reserves match getReserves()',
       `${lastSeen?.reserve0.toExponential(4)} vs ${Number(r0).toExponential(4)}`);
    ok(errors.length === 0, 'no errors', errors.join(' | '));
    await watcher.stop();
}

// --- 2. topic (permissive HTTP) --------------------------------------------
console.log('\n2. topic transport (HTTP, address-less getLogs allowed)');
{
    const { watcher, batches, errors } = await collect('topic', RPC_URL, undefined);
    ok(watcher.transport() === 'topic', 'picked the topic transport', watcher.transport());
    ok(watcher.ready() === true, 'ready() after the priming drain');
    await bump();
    for (let i = 0; i < 40 && batches.length === 0; i++) await sleep(150);
    ok(batches.length > 0, 'delivered', `${batches.length} batch(es)`);
    ok(watcher.stats().blocksDrained > 0, 'blocks were drained (not pushed)',
       `drained=${watcher.stats().blocksDrained} pushed=${watcher.stats().logsPushed}`);
    ok(errors.length === 0, 'no errors', errors.join(' | '));
    await watcher.stop();
}

// --- 3. chunked (restricted HTTP, addresses supplied) ----------------------
console.log('\n3. chunked transport (RPC answers -32701 to address-less getLogs)');
const proxy = await startRestrictedProxy(8546);
{
    const { watcher, batches, errors } = await collect('chunked', 'http://127.0.0.1:8546', undefined, {
        addresses: () => [WP, IP],
        addressChunkSize: 1,     // force more than one chunk
    });
    ok(watcher.transport() === 'chunked', 'downgraded to chunked after the refusal', watcher.transport());
    ok(errors.some(e => /chunked address filters/.test(e)),
       'the downgrade was reported, not silent', errors[0] ?? 'none');
    ok(watcher.ready() === true, 'ready() once a chunked range drained');
    await bump();
    for (let i = 0; i < 40 && batches.length === 0; i++) await sleep(150);
    ok(batches.length > 0, 'delivered through chunked filters', `${batches.length} batch(es)`);
    ok(batches.every(b => b.u.every(x => x.pair === WP)), 'still filters out the ignored pair');
    const [r0] = await watched.getReserves();
    const lastSeen = batches.flatMap(b => b.u).filter(x => x.pair === WP).pop();
    ok(lastSeen && lastSeen.reserve0 === Number(r0), 'chunked reserves match getReserves()',
       `${lastSeen?.reserve0.toExponential(4)} vs ${Number(r0).toExponential(4)}`);
    await watcher.stop();
}

// --- 4. restricted RPC with NO address list = loud failure, not silence -----
console.log('\n4. restricted RPC and no address list — must fail loudly');
{
    const { watcher, batches, errors } = await collect('noaddr', 'http://127.0.0.1:8546', undefined);
    ok(watcher.ready() === false, 'ready() stays false — caller can refuse to trade');
    ok(errors.some(e => /no address list was supplied|refuses eth_getLogs/.test(e)),
       'and said why', errors[0] ?? 'none');
    ok(batches.length === 0, 'delivered nothing (rather than pretending the chain is quiet)');
    await watcher.stop();
}
proxy.close();

console.log(fails === 0 ? '\nALL TRANSPORT CHECKS PASS' : `\n${fails} FAILED`);
process.exit(fails ? 1 : 0);
