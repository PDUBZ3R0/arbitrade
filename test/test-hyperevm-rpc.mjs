// What HyperEVM's public RPC (rpc.hyperliquid.xyz/evm) did to the pipeline,
// reproduced against a local anvil behind a misbehaving proxy:
//
//   1. Rate limits: `{"code":-32005,"message":"rate limited"}`, inside a batch
//      with `id: null` — ethers cannot match that to a request and reported
//      "missing response for request", which killed `yarn reserves` on its
//      first eth_getCode. makeProvider now waits it out: single calls and
//      batches succeed, and the retries are counted.
//   2. A NON-rate-limit -32005 ("query returned more than 10000 results",
//      Infura's meaning of the code) is returned at once, not retried — scan
//      relies on seeing it to shrink its block range.
//   3. The executor version probe through that same rate limiting: it used to
//      read a refused SOURCE_MORPHO() call as "executor predates multi-provider
//      flash loans" and switch off every V3 pool. Now it reads the bytecode
//      (retried) and finds executeArbFrom, V3 hops and flash swaps; an address
//      with no code is reported as exactly that.
//   4. A websocket endpoint that refuses the upgrade (HTTP 405, as HyperEVM's
//      does): the hot loop crashed on an unhandled 'error' event. The watcher
//      now falls back to HTTP polling, says so, and still delivers Syncs.
//
//   node test/test-hyperevm-rpc.mjs        (anvil on PATH; own anvil on 8561)

import { spawn } from 'node:child_process';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { ethers } from 'ethers';
import { makeProvider } from '../source/util/rpc.ts';
import { CandidateExecutor } from '../source/orchestrator/attempt.ts';
import { watchSync } from '../source/orchestrator/sync-watcher.ts';

let fails = 0;
const ok = (c, l, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${l} ${extra}`); if (!c) fails++; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const art = JSON.parse(readFileSync(new URL('./artifacts.json', import.meta.url), 'utf8'));

const PORT = 8561, PROXY = 8562, WS405 = 8563;
const UP = `http://127.0.0.1:${PORT}`;
const anvil = spawn('anvil', ['--port', String(PORT), '--silent']);
await sleep(1500);

// --- the misbehaving proxy ---------------------------------------------------
// mode 'limit':  refuse every other request (whole batch) with -32005 "rate limited", id null
// mode 'toomany': answer eth_getLogs with -32005 "query returned more than 10000 results"
let mode = 'off', seen = 0, refused = 0, rawAtHost = 0;
const proxy = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const msg = JSON.parse(body);
    seen++;
    const reply = (obj) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (mode === 'limit' && seen % 2 === 1) {
        refused++;
        const err = { jsonrpc: '2.0', id: null, error: { code: -32005, message: 'rate limited' } };
        return reply(Array.isArray(msg) ? [err] : err);
    }
    if (mode === 'readonly') {
        const list = Array.isArray(msg) ? msg : [msg];
        if (list.some(m => m.method === 'eth_sendRawTransaction')) {
            rawAtHost++;
            const err = (m) => ({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'method eth_sendRawTransaction not supported' } });
            return reply(Array.isArray(msg) ? msg.map(err) : err(msg));
        }
    }
    if (mode === 'toomany') {
        const one = (m) => m.method === 'eth_getLogs' ? { jsonrpc: '2.0', id: m.id, error: { code: -32005, message: 'query returned more than 10000 results' } } : null;
        const r = Array.isArray(msg) ? msg.map(one) : one(msg);
        if (Array.isArray(r) ? r.every(Boolean) : r) return reply(r);
    }
    const up = await fetch(UP, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    reply(await up.json());
}).listen(PROXY);
// An endpoint that answers every websocket upgrade with 405, like HyperEVM's.
const refuser = http.createServer((req, res) => { res.writeHead(405); res.end('Method Not Allowed'); }).listen(WS405);
refuser.on('upgrade', (req, socket) => { socket.end('HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\n\r\n'); });

const direct = new ethers.JsonRpcProvider(UP, undefined, { staticNetwork: true, cacheTimeout: -1 });
const w = new ethers.Wallet('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', direct);
let nonce = await direct.getTransactionCount(w.address);
const deploy = async (n, ...a) => { const c = await new ethers.ContractFactory(art[n].abi, art[n].bytecode, w).deploy(...a, { nonce: nonce++ }); await c.waitForDeployment(); return c; };

try {
    const exec = await deploy('FlashArbExecutor', ethers.ZeroAddress);
    const EXEC = await exec.getAddress();

    console.log('1. rate-limited replies are waited out');
    {
        mode = 'limit'; seen = 0; refused = 0;
        const p = makeProvider({ host: `http://127.0.0.1:${PROXY}` });
        const code = await p.getCode(EXEC);
        const [bn, bal] = await Promise.all([p.getBlockNumber(), p.getBalance(w.address)]);   // batched by ethers
        ok(code.length > 2 && bn > 0 && bal > 0n, 'getCode and a batched pair of calls all answered', `retries=${p.rateLimitRetries} refused=${refused}`);
        ok(p.rateLimitRetries > 0 && refused > 0, 'the proxy did refuse, and the provider retried rather than failing');
        p.destroy();
    }

    console.log('\n2. a -32005 that is not a rate limit is returned at once');
    {
        mode = 'toomany';
        const p = makeProvider({ host: `http://127.0.0.1:${PROXY}` });
        const t = Date.now();
        let msg = '';
        try { await p.getLogs({ fromBlock: 0, toBlock: 'latest' }); } catch (e) { msg = e?.error?.message ?? e?.message ?? String(e); }
        ok(/more than 10000 results/.test(msg) && Date.now() - t < 1500 && p.rateLimitRetries === 0,
           'surfaced immediately, no retries', `${Date.now() - t}ms "${msg.slice(0, 60)}"`);
        p.destroy();
    }

    console.log('\n3. executor version probe through the rate limiting');
    {
        mode = 'limit'; seen = 0;
        const cfg = { chain: { name: 'Anvil', label: 'anvil', id: 31337, host: `http://127.0.0.1:${PROXY}`, executor: EXEC }, factories: [], flashloan: { provider: 'aave-v3', premium: 0.0005, tokens: [] } };
        const p = makeProvider({ host: `http://127.0.0.1:${PROXY}` });
        const ex = new CandidateExecutor(cfg, p, {}, { ownerAddress: w.address });
        ok(await ex.supportsV3() === true, 'executeArbFrom and V3 hops detected (not "predates multi-provider")');
        ok(ex['executorHasFlashSwap'] === true, 'flash swaps detected');
        const ghost = new CandidateExecutor({ ...cfg, chain: { ...cfg.chain, executor: '0x000000000000000000000000000000000000dEaD' } }, p, {}, { ownerAddress: w.address });
        const err = await ghost['checkExecutorVersion']();
        ok(/no contract at chain\.executor/.test(err ?? ''), 'an address with no code says so', `(${err?.slice(0, 50)})`);
        p.destroy();
        mode = 'off';
    }

    console.log('\n4. a websocket that refuses the upgrade (405): fall back to HTTP polling');
    {
        const ta = await deploy('MockToken', 'A', 0), tb = await deploy('MockToken', 'B', 0);
        const pair = await deploy('MockPair', await ta.getAddress(), await tb.getAddress(), 30);
        const PAIR = (await pair.getAddress()).toLowerCase();
        const errors = [], batches = [];
        const watcher = await watchSync(UP, `ws://127.0.0.1:${WS405}`, {
            isInteresting: (a) => a === PAIR,
            onBatch: (u) => { batches.push(u); },
            onError: (e, ctx) => errors.push(`${ctx}: ${e.message}`),
            pollMs: 200,
            wsConnectTimeoutMs: 3000,
        });
        ok(watcher.transport() !== 'subscribe', 'not subscribed over the dead socket', `(transport ${watcher.transport()})`);
        ok(errors.some(e => /^connect: websocket .* unusable .* falling back to HTTP polling/.test(e)), 'said why', errors[0] ?? '(no error reported)');
        await (await pair.sync({ nonce: nonce++ })).wait();
        for (let i = 0; i < 40 && batches.length === 0; i++) await sleep(150);
        ok(batches.some(b => b.some(u => u.pair === PAIR)), 'a Sync on the watched pair was still delivered');
        await watcher.stop();
    }
} finally {
    proxy.close(); refuser.close();
    direct.destroy();
    anvil.kill();
}

console.log(fails === 0 ? '\nALL HYPEREVM RPC CHECKS PASS' : `\n${fails} FAILED`);
process.exit(fails ? 1 : 0);
