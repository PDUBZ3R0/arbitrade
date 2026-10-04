// makeProvider / WsFirstProvider against a local anvil.
//
//   1. With a websocket configured, reads go over the socket (no HTTP).
//   2. Revert data from eth_call survives the socket path unchanged — the
//      executor decodes custom errors from it.
//   3. A signed transaction sends and confirms over the socket.
//   4. A dead websocket URL falls back to HTTP immediately, not after a timeout.
//   5. A socket that drops mid-run: the next request is served over HTTP, and
//      the socket comes back by itself once the endpoint is reachable again.
//   6. A raw tx that already reached the node ("already known") is reported as
//      sent, with its hash, when it has to be retried over HTTP.
//   7. A CLI that never calls destroy() still exits promptly.
//   8. Without a websocket, makeProvider is a plain JsonRpcProvider.
//
//   node test/test-rpc.mjs                 (anvil on PATH)

import { spawn } from 'node:child_process';
import net from 'node:net';
import { ethers } from 'ethers';
import { makeProvider, WsFirstProvider } from '../source/util/rpc.ts';

let fails = 0;
const ok = (c, l, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${l} ${extra}`); if (!c) fails++; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const PORT = 8555, PROXY = 8556;
const HTTP = `http://127.0.0.1:${PORT}`;
const anvil = spawn('anvil', ['--port', String(PORT), '--silent']);
await sleep(1500);

// A TCP proxy in front of anvil's websocket that can be cut and restored.
let sockets = new Set(), proxy = null;
function proxyUp() {
    proxy = net.createServer(c => {
        const u = net.connect(PORT, '127.0.0.1');
        sockets.add(c); sockets.add(u);
        c.pipe(u); u.pipe(c);
        const drop = () => { c.destroy(); u.destroy(); sockets.delete(c); sockets.delete(u); };
        c.on('error', drop); u.on('error', drop); c.on('close', drop); u.on('close', drop);
    });
    return new Promise(r => proxy.listen(PROXY, '127.0.0.1', r));
}
function proxyDown() {
    for (const s of sockets) s.destroy();
    sockets.clear();
    return new Promise(r => proxy.close(() => r()));
}

const KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
try {
    await proxyUp();
    const WS = `ws://127.0.0.1:${PROXY}`;

    console.log('1. reads go over the socket');
    const p = makeProvider({ host: HTTP, ws: WS, id: 31337 });
    ok(p instanceof WsFirstProvider, 'makeProvider returns the websocket-first provider when ws is set');
    const bn = await p.getBlockNumber();
    const bal = await p.getBalance(new ethers.Wallet(KEY).address);
    ok(bn >= 0 && bal > 0n && p.stats.ws >= 2 && p.stats.http === 0, 'served by the socket', JSON.stringify(p.stats));

    console.log('\n2. revert data survives the socket path');
    {
        // Deploy:  revert with custom error Nope(42) on any call.
        const sel = ethers.id('Nope(uint256)').slice(2, 10);
        // runtime: mstore(0, sel<<224); mstore(4, 42); revert(0, 36)
        const runtime = '0x63' + sel + '60e01b' + '600052' + '602a' + '600452' + '6024' + '6000' + 'fd';
        const len = (runtime.length - 2) / 2;
        const init = '0x' + '60' + len.toString(16).padStart(2, '0') + '600c600039' + '60' + len.toString(16).padStart(2, '0') + '6000f3' + runtime.slice(2);
        const w = new ethers.Wallet(KEY, p);
        const tx = await w.sendTransaction({ data: init });
        const rc = await tx.wait();
        let wsData = null, httpData = null;
        try { await p.call({ to: rc.contractAddress, data: '0x12345678' }); } catch (e) { wsData = e.data; }
        const plain = new ethers.JsonRpcProvider(HTTP);
        try { await plain.call({ to: rc.contractAddress, data: '0x12345678' }); } catch (e) { httpData = e.data; }
        plain.destroy();
        const iface = new ethers.Interface(['error Nope(uint256)']);
        ok(wsData && wsData === httpData && iface.parseError(wsData)?.args[0] === 42n,
           'same revert data as plain HTTP, decodes to Nope(42)', wsData);

        console.log('\n3. a transaction sends and confirms over the socket');
        ok(rc.status === 1 && p.stats.http === 0, 'deploy tx confirmed with zero HTTP requests', JSON.stringify(p.stats));
    }

    console.log('\n4. dead websocket URL -> HTTP at once');
    {
        const dead = makeProvider({ host: HTTP, ws: 'ws://127.0.0.1:1', id: 31337 });
        const t = Date.now();
        const n = await dead.getBlockNumber();
        const ms = Date.now() - t;
        ok(n >= 0 && dead.stats.http >= 1 && ms < 3000, 'answered over HTTP', `${ms}ms ${JSON.stringify(dead.stats)}`);
        dead.destroy();
    }

    console.log('\n5. socket drops mid-run, then recovers');
    {
        const before = { ...p.stats };
        await proxyDown();
        // p.send, not getBlockNumber: ethers caches the block number briefly.
        const n = Number(await p.send('eth_blockNumber', []));
        ok(n >= 0 && p.stats.http > before.http, 'request after the drop served over HTTP', JSON.stringify(p.stats));
        await proxyUp();
        // backoff starts at 1s
        let back = false;
        for (let i = 0; i < 20 && !back; i++) {
            await sleep(500);
            const w0 = p.stats.ws;
            await p.getBlockNumber();
            back = p.stats.ws > w0;
        }
        ok(back && p.usingWebsocket, 'socket reconnected by itself', JSON.stringify(p.stats));
    }

    console.log('\n6. "already known" on HTTP retry = sent');
    {
        const w = new ethers.Wallet(KEY);
        const plain = new ethers.JsonRpcProvider(HTTP);
        const nonce = await plain.getTransactionCount(w.address, 'pending');
        const raw = await w.signTransaction({ to: w.address, value: 1n, nonce, gasLimit: 21000n, gasPrice: 2_000_000_000n, chainId: 31337n });
        await anvilRpc('anvil_setAutomine', [false]);
        await plain.send('eth_sendRawTransaction', [raw]);              // the node already has it
        await proxyDown();                                               // socket "times out"
        const fresh = makeProvider({ host: HTTP, ws: WS, id: 31337 });
        let hash, err;
        try { hash = await fresh.send('eth_sendRawTransaction', [raw]); } catch (e) { err = e.shortMessage ?? e.message; }
        ok(hash === ethers.keccak256(raw), 'returns the tx hash instead of an error', hash ?? err);
        await anvilRpc('anvil_setAutomine', [true]);
        await anvilRpc('evm_mine', []);
        fresh.destroy(); plain.destroy();
        await proxyUp();
    }

    console.log('\n7. a CLI that never destroys the provider still exits');
    {
        const script = `import { makeProvider } from ${JSON.stringify(new URL('../source/util/rpc.ts', import.meta.url).href)};
            const p = makeProvider({ host: '${HTTP}', ws: '${WS}', id: 31337 });
            console.log(await p.getBlockNumber());`;
        // Async spawn: the ws proxy lives in THIS process, and spawnSync would
        // block its event loop, stalling the child's handshake.
        const t = Date.now();
        const r = await new Promise(res => {
            const c = spawn(process.execPath, ['--input-type=module', '-e', script]);
            let stderr = '';
            c.stderr.on('data', d => { stderr += d; });
            const kill = setTimeout(() => c.kill(), 15000);
            c.on('exit', status => { clearTimeout(kill); res({ status, stderr }); });
        });
        const ms = Date.now() - t;
        ok(r.status === 0 && ms < 5000, 'process exited on its own', `${ms}ms status=${r.status} ${r.stderr.split('\n').find(l => /Error/.test(l)) ?? ''}`);
    }

    console.log('\n8. no websocket -> plain JsonRpcProvider');
    {
        const h = makeProvider({ host: HTTP });
        ok(h instanceof ethers.JsonRpcProvider && !(h instanceof WsFirstProvider) && (await h.getBlockNumber()) >= 0, 'unchanged behaviour');
        h.destroy();
        process.env.ARB_NO_WS = '1';
        ok(!(makeProvider({ host: HTTP, ws: WS }) instanceof WsFirstProvider), 'ARB_NO_WS=1 forces HTTP');
        delete process.env.ARB_NO_WS;
    }
    p.destroy();
} finally {
    try { await proxyDown(); } catch {}
    anvil.kill();
}

async function anvilRpc(method, params) {
    const r = await fetch(HTTP, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    return (await r.json()).result;
}

console.log(fails === 0 ? '\nALL RPC CHECKS PASS' : `\n${fails} FAILED`);
process.exit(fails ? 1 : 0);
