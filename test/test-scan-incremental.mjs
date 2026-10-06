// scanChain's incremental mode, on anvil, against real Uniswap V2 and V3
// factories.
//
//   1. A first scan (nothing saved yet) goes factory by factory, as before.
//   2. A re-run with every factory near the head catches up ALL of them in one
//      eth_getLogs call — no per-factory request (and so no HyperSync request)
//      — and stores the new pairs/pools with the right kind and fee.
//   3. Each factory keeps its own resume point: a factory already further
//      along does not re-insert or double count, and progress lands on head.
//   4. A factory never scanned, or further behind than incrementalMaxBlocks,
//      still gets the per-factory scan; incrementalMaxBlocks = 0 turns the
//      mode off.
//
//   node --experimental-strip-types test/test-scan-incremental.mjs   (anvil on PATH)

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ethers } from 'ethers';
import { scanChain } from '../source/scanner/pairs.ts';
import { ArbitradeDB } from '../source/util/db.ts';

const require = createRequire(import.meta.url);
let fails = 0;
const ok = (c, l, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${l} ${extra}`); if (!c) fails++; };
const v3art = n => require(`@uniswap/v3-core/artifacts/contracts/${n}.sol/${n}.json`);
const v2art = n => { const j = require(`@uniswap/v2-core/build/${n}.json`); return { abi: j.abi, bytecode: '0x' + j.evm.bytecode.object }; };

const PORT = 8555, URL_ = `http://127.0.0.1:${PORT}`;
const anvil = spawn('anvil', ['--port', String(PORT), '--disable-code-size-limit', '--gas-limit', '3000000000', '--silent']);
await new Promise(r => setTimeout(r, 1500));
const provider = new ethers.JsonRpcProvider(URL_, undefined, { cacheTimeout: -1, staticNetwork: true });
const signer = await provider.getSigner(0);
const me = await signer.getAddress();
let nonce = await provider.getTransactionCount(me);
const ov = () => ({ nonce: nonce++, gasLimit: 30_000_000n });
const send = async (p) => (await p).wait();
const deploy = async (a, ...args) => { const c = await new ethers.ContractFactory(a.abi, a.bytecode, signer).deploy(...args, ov()); await c.waitForDeployment(); return c; };
const addr = (i) => ethers.getAddress('0x' + (0x1000 + i).toString(16).padStart(40, '0'));

/** Run fn with console.log captured; returns [result, lines]. */
async function capture(fn) {
    const lines = [], orig = console.log, origW = process.stdout.write.bind(process.stdout);
    console.log = (...a) => lines.push(a.join(' '));
    process.stdout.write = (s) => { lines.push(String(s)); return true; };
    try { return [await fn(), lines]; } finally { console.log = orig; process.stdout.write = origW; }
}
/** Count eth_getLogs calls the provider makes during fn. */
async function countGetLogs(fn) {
    let n = 0;
    const orig = ethers.JsonRpcProvider.prototype.send;
    ethers.JsonRpcProvider.prototype.send = function (m, p) { if (m === 'eth_getLogs') n++; return orig.call(this, m, p); };
    try { const r = await fn(); return [r, n]; } finally { ethers.JsonRpcProvider.prototype.send = orig; }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-incr-'));
const dbFile = path.join(dir, 'anvil.sqlite');
try {
    const f2 = await deploy(v2art('UniswapV2Factory'), me), f3 = await deploy(v3art('UniswapV3Factory'));
    const f2b = await deploy(v2art('UniswapV2Factory'), me);
    const [F2, F3, F2B] = await Promise.all([f2, f3, f2b].map(async f => (await f.getAddress()).toLowerCase()));
    let k = 0;
    const pair = async (f) => send(f.createPair(addr(k++), addr(k++), ov()));
    const pool = async (fee) => send(f3.createPool(addr(k++), addr(k++), fee, ov()));
    for (let i = 0; i < 3; i++) await pair(f2);
    await pool(3000); await pool(500);

    const base = { deployBlock: 1, stableFees: undefined, feeTarget: 'factory', feeArgSource: 'pair-address',
                   feeFunction: 'pairFee', feeDivisor: 10000, hasStableFlag: false, abi: [] };
    const V2 = { ...base, group: 'v2', name: 'UniV2', address: F2, fee: 0.003 };
    const V3 = { ...base, group: 'v3', name: 'UniV3', address: F3, fee: undefined, poolEvent: 'uniswap', callback: 'uniswapV3SwapCallback' };
    const V2B = { ...base, group: 'v2', name: 'LateV2', address: F2B, fee: 0.003 };
    const cfg = (factories, extra = {}) => ({
        raw: {}, chain: { name: 'Anvil', label: 'anvil', id: 31337, host: URL_, currency: 'ETH' },
        factories, flashloan: { tokens: [] }, evaluator: {}, reserves: {},
        scan: { chunkStart: 1000, chunkMin: 10, chunkMax: 50000, chunkDelayMs: 0, ...extra },
    });
    const progress = (a) => { const db = new ArbitradeDB(dbFile); try { return db.getScanProgress(a); } finally { db.close(); } };
    const count = (a, kind) => { const db = new ArbitradeDB(dbFile); try { return db.db.prepare('SELECT COUNT(*) n FROM pairs WHERE factory = ? AND kind = ?').get(a, kind).n; } finally { db.close(); } };

    console.log('1. first scan: factory by factory');
    {
        const [[r], lines] = await capture(() => countGetLogs(() => scanChain(cfg([V2, V3]), dbFile)));
        ok(!lines.some(l => /Incremental:/.test(l)), 'no saved progress -> no incremental pass');
        ok(r.UniV2 === 3 && r.UniV3 === 2, 'all pairs and pools found', JSON.stringify(r));
    }

    console.log('\n2. re-run near the head: one shared getLogs');
    for (let i = 0; i < 2; i++) await pair(f2);
    await pool(10000);
    {
        const [[r, calls], lines] = await capture(() => countGetLogs(() => scanChain(cfg([V2, V3]), dbFile)));
        ok(lines.some(l => /Incremental: 2 factories/.test(l)), 'both factories took the incremental path');
        ok(calls === 1, 'caught up in ONE eth_getLogs for both factories', `${calls} call(s)`);
        ok(r.UniV2 === 2 && r.UniV3 === 1, 'the new pair and pool were found', JSON.stringify(r));
        ok(count(F2, 'v2') === 5 && count(F3, 'v3') === 3, 'stored with the right kind', `${count(F2, 'v2')} v2, ${count(F3, 'v3')} v3`);
        const db = new ArbitradeDB(dbFile);
        const fees = db.db.prepare("SELECT fee FROM pairs WHERE factory = ? ORDER BY blockNumber").all(F3).map(x => x.fee);
        db.close();
        ok(fees.at(-1) === 0.01, 'v3 fee tier taken from the event', `${fees.join(', ')}`);
        const head = await provider.getBlockNumber();
        ok(progress(F2) === head && progress(F3) === head, 'progress saved at the head for both');
    }

    console.log('\n3. resume points are per factory');
    {
        await pair(f2);                                  // only V2 moves
        const db = new ArbitradeDB(dbFile);
        db.setScanProgress(F3, (await provider.getBlockNumber()) - 3);   // V3 slightly behind, nothing new in that span
        db.close();
        const [[r]] = await capture(() => countGetLogs(() => scanChain(cfg([V2, V3]), dbFile)));
        ok(r.UniV2 === 1 && r.UniV3 === 0, 'no double count of already-scanned pools', JSON.stringify(r));
        ok(count(F3, 'v3') === 3, 'v3 pool count unchanged');
    }

    console.log('\n4. per-factory fallbacks');
    {
        await send(f2b.createPair(addr(k++), addr(k++), ov()));
        const [r, lines] = await capture(() => scanChain(cfg([V2, V3, V2B]), dbFile));
        ok(lines.some(l => /Incremental: 2 factories/.test(l)) && lines.some(l => /Scanning LateV2/.test(l)),
           'a never-scanned factory is scanned on its own, the others incrementally');
        ok(r.LateV2 === 1, 'and its pair is found', JSON.stringify(r));

        const db = new ArbitradeDB(dbFile);
        db.setScanProgress(F2, 1);                       // far behind
        db.close();
        const [, lines2] = await capture(() => scanChain(cfg([V2, V3], { incrementalMaxBlocks: 5 }), dbFile));
        ok(lines2.some(l => /Incremental: 1 factory/.test(l)) && lines2.some(l => /Scanning UniV2/.test(l)),
           'a factory further behind than incrementalMaxBlocks gets the per-factory scan');
        const [, lines3] = await capture(() => scanChain(cfg([V2, V3], { incrementalMaxBlocks: 0 }), dbFile));
        ok(!lines3.some(l => /Incremental:/.test(l)), 'incrementalMaxBlocks = 0 turns it off');
    }
} catch (e) {
    console.error(e); fails++;
} finally {
    provider.destroy();
    anvil.kill();
    fs.rmSync(dir, { recursive: true, force: true });
}
console.log(fails === 0 ? '\nALL INCREMENTAL SCAN CHECKS PASS' : `\n${fails} FAILED`);
process.exit(fails ? 1 : 0);
