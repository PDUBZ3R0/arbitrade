// Our envio indexer as a source for find-factories and scan (util/envio-rest.ts),
// against a mock of its Hasura REST endpoints. No chain.
//
//   EnvioRest     processed() refuses a chain it doesn't index or hasn't started;
//                 pools() pages by block (a boundary block's pools are neither
//                 lost nor doubled), parses Hasura's stringified numbers, and
//                 refuses a full page out of block order (paging past it would
//                 skip pools) or a single block holding a whole page.
//   scanEnvio     stores each factory's pools and sets its progress to the
//                 block the indexer had PROCESSED, never past it; a factory the
//                 indexer has under another event is reported and left alone;
//                 a non-address entry (conf/sonic.json5's 'Uniswap v2': '.') is
//                 skipped, not fatal; a re-run asks only from progress + 1.
//   find-factories --new   the real CLI in a scratch copy of the project: a full
//                 envio sweep saves the processed block; --new then asks for
//                 factories from one past it and reports only the new one;
//                 --new refuses --lookback.
//
//   node --experimental-strip-types test/test-envio-rest.mjs

import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { EnvioRest } = await import(path.join(ROOT_DIR, 'source/util/envio-rest.ts'));
const { scanEnvio } = await import(path.join(ROOT_DIR, 'source/scanner/pairs.ts'));
const { ArbitradeDB } = await import(path.join(ROOT_DIR, 'source/util/db.ts'));
const { TOPIC_BY_LAYOUT } = await import(path.join(ROOT_DIR, 'source/util/pool-events.ts'));

let fails = 0;
const ok = (c, l, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${l} ${extra}`); if (!c) fails++; };
const throwsLike = async (fn, re, l) => {
    try { await fn(); ok(false, l, '(did not throw)'); } catch (e) { ok(re.test(e.message), l, re.test(e.message) ? '' : e.message); }
};
const A = (c) => '0x' + c.repeat(40);
const P = (n) => '0x' + n.toString(16).padStart(40, '0');

// ---------------------------------------------------------------- mock Hasura
const CHAIN = 747474;   // katana in conf/@chains.json5
const SECRET = 'sekret';
const state = {
    processed: { [CHAIN]: 1000, 2: -1 },
    factories: [],          // Factory rows (all chains)
    pools: {},              // table -> rows
    unordered: false,
    requests: [],
};
const TABLES = ['UniswapV2Factory_PairCreated', 'Solidly_PairCreated', 'Velodrome_PoolCreated',
                'UniswapV3Factory_PoolCreated', 'Aerodrome_PoolCreated', 'Algebra_Pool'];
for (const t of TABLES) state.pools[t] = [];
const addFactory = (factory, family, firstBlock, lastBlock, pairCount) =>
    state.factories.push({ id: `${CHAIN}_${family}_${factory}`, chainId: CHAIN, factory, family, firstBlock, lastBlock, pairCount });
const addPools = (table, factory, blocks, extra = () => ({})) => {
    for (const [i, b] of blocks.entries()) {
        const n = state.pools[table].length + 1;
        // Checksummed-looking mixed case, like the indexer returns.
        state.pools[table].push({ id: `${CHAIN}_${b}_${i}`, chainId: CHAIN, factory, blockNumber: b,
            token0: A('1').replace('0x1', '0xA'), token1: A('2'), [table.includes('Pair') ? 'pair' : 'pool']: P(n * 7 + 0xabc), ...extra(i) });
    }
};

const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    state.requests.push(url.pathname + url.search);
    const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.headers['x-hasura-admin-secret'] !== SECRET) return send(401, { error: 'bad secret' });
    let m;
    const block = Number(url.searchParams.get('block') ?? 0);
    const limit = Number(url.searchParams.get('limit') ?? 10000);
    if ((m = url.pathname.match(/^\/api\/rest\/chain\/(\d+)\/processed$/))) {
        const p = state.processed[m[1]];
        return send(200, { chain_metadata: p === undefined ? [] : [{ latest_processed_block: p }] });
    }
    if ((m = url.pathname.match(/^\/api\/rest\/chain\/(\d+)\/factories$/))) {
        return send(200, { Factory: state.factories.filter(f => f.chainId === Number(m[1]) && f.firstBlock >= block) });
    }
    if ((m = url.pathname.match(/^\/api\/rest\/chain\/(\d+)\/factory\/([^/]+)$/))) {
        const [, , f] = m;
        const out = { Factory: state.factories.filter(x => x.chainId === Number(m[1]) && x.factory === f) };
        for (const t of TABLES) {
            let rows = state.pools[t].filter(r => r.factory === f && r.blockNumber >= block);
            rows = state.unordered ? rows.slice().reverse() : rows.slice().sort((a, b) => a.blockNumber - b.blockNumber);
            // Hasura stringifies numeric columns.
            out[t] = rows.slice(0, limit).map(r => ({ ...r, ...(r.fee != null ? { fee: String(r.fee) } : {}),
                                                     ...(r.tickSpacing != null ? { tickSpacing: String(r.tickSpacing) } : {}) }));
        }
        return send(200, out);
    }
    send(404, { error: 'Endpoint not found' });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}/api/rest`;
const rest = new EnvioRest(BASE + '/', SECRET);

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'envio-rest-'));
try {
    // ------------------------------------------------------------ EnvioRest
    console.log('EnvioRest');
    ok(await rest.processed(CHAIN) === 1000, 'processed() reads latest_processed_block');
    await throwsLike(() => rest.processed(999), /does not index chain 999/, 'a chain the indexer lacks is refused, not read as "no pools"');
    await throwsLike(() => rest.processed(2), /not processed any block/, 'a chain at -1 (not started) is refused');
    await throwsLike(() => new EnvioRest(BASE, 'wrong').processed(CHAIN), /HTTP 401.*ENVIO_REST_SECRET/, 'a wrong secret surfaces the HTTP status');

    // V: 25 v2 pairs over blocks 10..34, with 3 in block 19 straddling the page edge at limit 10.
    const V = A('a');
    const vBlocks = [10, 11, 12, 13, 14, 15, 16, 19, 19, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34];
    addFactory(V, 'v2', 10, 34, vBlocks.length);
    addPools('UniswapV2Factory_PairCreated', V, vBlocks);
    state.requests = [];
    const got = await rest.pools(CHAIN, V.toUpperCase().replace('0X', '0x'), 0, 10);
    ok(got.length === 25 && new Set(got.map(p => p.pool)).size === 25, 'paged 25 pools at 10 per page: none lost, none doubled', `(got ${got.length})`);
    ok(state.requests.every(r => r.includes(`/factory/${V}?`)), 'the factory address goes lowercase in the URL');
    ok(state.requests.some(r => r.includes('block=19&')), 'the next page starts AT the last block reached (gte), not past it', `(${state.requests.join(' ')})`);
    ok(got.every(p => p.layout === 'v2' && p.pool === p.pool.toLowerCase() && p.token0 === p.token0.toLowerCase()), 'rows are tagged v2 and lowercased');

    const S = A('5');   // a long-lived factory: samples are its newest pools, then its earliest
    addFactory(S, 'v2', 10, 500_000, 8);
    addPools('UniswapV2Factory_PairCreated', S, [10, 11, 12, 13, 400_000, 490_000, 499_000, 500_000]);
    const sam = await rest.samplePools(CHAIN, S, 2);
    ok(sam.layout === 'v2' && sam.firstBlock === 10, 'samplePools: layout and first block', sam);
    ok(sam.pools[0].blockNumber > sam.pools[1].blockNumber && sam.pools.at(-1).blockNumber === 11 && sam.pools.length === 4, 'recent pools first, then the earliest', sam.pools.map(p => p.blockNumber));
    ok(await rest.samplePools(CHAIN, A('6')) === null, 'a factory the indexer has no pools for is null, so the verifier asks the chain');
    state.factories = state.factories.filter(f => f.factory !== S);

    const W = A('b');   // fee-keyed V3 with stringified numbers
    addFactory(W, 'v3', 50, 52, 3);
    addPools('UniswapV3Factory_PoolCreated', W, [50, 51, 52], i => ({ fee: [500, 3000, 10000][i], tickSpacing: [10, 60, -200][i] }));
    const w = await rest.pools(CHAIN, W);
    ok(w.map(p => p.feePips).join() === '500,3000,10000' && w.map(p => p.tickSpacing).join() === '10,60,-200', 'Hasura\'s stringified fee / tickSpacing come back as numbers');

    state.unordered = true;
    await throwsLike(() => rest.pools(CHAIN, V, 0, 10), /not in block order.*order_by/, 'a full page out of block order is refused (paging past it would skip pools)');
    ok((await rest.pools(CHAIN, W, 0, 10)).length === 3, 'an unordered page that is NOT full is fine (nothing to page past)');
    state.unordered = false;

    const Z = A('c');   // 12 pools in one block
    addPools('UniswapV2Factory_PairCreated', Z, Array(12).fill(77));
    await throwsLike(() => rest.pools(CHAIN, Z, 0, 10), /10\+ pools in block 77 alone/, 'a single block holding a whole page is refused, not looped on');

    // ------------------------------------------------------------ scanEnvio
    console.log('scanEnvio');
    const T = A('d');   // a tick-spacing factory configured as such
    addFactory(T, 'aerodrome', 60, 61, 2);
    addPools('Aerodrome_PoolCreated', T, [60, 61], i => ({ tickSpacing: [1, 200][i] }));
    const M = A('e');   // the indexer has it as tick-spacing; the config says fee-keyed v3
    addFactory(M, 'aerodrome', 70, 70, 1);
    addPools('Aerodrome_PoolCreated', M, [70], () => ({ tickSpacing: 100 }));
    const N = A('f');   // configured, but the indexer never saw it create a pool
    const base = { deployBlock: 0, fee: 0.003 };
    const cfg = {
        chain: { id: CHAIN, name: 'katana', label: 'katana' },
        factories: [
            { ...base, group: 'v2', name: 'V', address: V },
            { ...base, group: 'v3', name: 'W', address: W, fee: undefined },
            { ...base, group: 'v3', name: 'T', address: T, fee: undefined, poolEvent: 'tickspacing' },
            { ...base, group: 'v3', name: 'M', address: M, fee: undefined },
            { ...base, group: 'v2', name: 'N', address: N },
            { ...base, group: 'v2', name: 'Dot', address: '.' },
        ],
    };
    const db = new ArbitradeDB(path.join(scratch, 'scan.sqlite'));
    const lines = [];
    const r1 = await scanEnvio(cfg, db, rest, s => lines.push(s));
    const all = lines.join('\n');
    ok(r1.processed === 1000 && r1.found.V === 25 && r1.found.W === 3 && r1.found.T === 2, 'stores V, W and T', JSON.stringify(r1.found));
    ok(db.getScanProgressRow(V)?.lastBlock === 1000 && db.getScanProgressRow(N)?.lastBlock === 1000,
        'progress = the processed block (also for a factory with no pools yet)');
    ok(db.getScanProgressRow(T)?.topic === TOPIC_BY_LAYOUT.aerodrome.toLowerCase(), 'progress records the event it was scanned for');
    const wRows = db.db.prepare('SELECT fee, tickSpacing, kind FROM pairs WHERE factory = ? ORDER BY blockNumber').all(W);
    ok(wRows.map(r => r.fee).join() === '0.0005,0.003,0.01' && wRows.every(r => r.kind === 'v3'), 'v3 rows: fee tier from the event, kind v3');
    const tRows = db.db.prepare('SELECT fee, tickSpacing FROM pairs WHERE factory = ? ORDER BY blockNumber').all(T);
    ok(tRows.map(r => r.tickSpacing).join() === '1,200' && tRows.every(r => r.fee === null), 'tick-spacing rows: spacing stored, no fee');
    ok(r1.found.M === 0 && db.countPairs(M) === 0 && db.getScanProgressRow(M) === null && /M: the indexer has 1 pool\(s\) from its aerodrome event, but the config scans it for v3/.test(all),
        'a factory the indexer has under another event: nothing stored, progress untouched, said why');
    ok(/Dot: "\." is not an address — skipped/.test(all), 'a non-address entry is skipped, and the rest still ran');

    state.requests = [];
    const r2 = await scanEnvio(cfg, db, rest, () => {});
    ok(Object.values(r2.found).every(n => n === 0), 're-run: nothing new');
    ok(!state.requests.some(r => r.includes(`/factory/${V}`)), 're-run: a factory already at the processed block is not asked again');

    state.processed[CHAIN] = 1200;
    addPools('UniswapV2Factory_PairCreated', V, [1100, 1150]);
    addPools('UniswapV2Factory_PairCreated', V, [1300]);   // past processed: may land, must not move progress past 1200
    state.requests = [];
    const r3 = await scanEnvio(cfg, db, rest, () => {});
    ok(state.requests.some(r => r.includes(`/factory/${V}?block=1001&`)), 'catching up asks from progress + 1', `(${state.requests.filter(r => r.includes(V)).join(' ')})`);
    ok(r3.found.V >= 2 && db.getScanProgressRow(V)?.lastBlock === 1200, 'stores the new pairs; progress = the new processed block, not the last pool seen');
    db.close();

    // ------------------------------------------------- find-factories --new (real CLI)
    console.log('find-factories --new');
    const proj = path.join(scratch, 'proj');
    fs.mkdirSync(proj);
    fs.cpSync(path.join(ROOT_DIR, 'source'), path.join(proj, 'source'), { recursive: true });
    fs.mkdirSync(path.join(proj, 'conf')); fs.mkdirSync(path.join(proj, 'db'));
    fs.copyFileSync(path.join(ROOT_DIR, 'conf/@chains.json5'), path.join(proj, 'conf/@chains.json5'));
    fs.copyFileSync(path.join(ROOT_DIR, 'package.json'), path.join(proj, 'package.json'));
    fs.symlinkSync(path.join(ROOT_DIR, 'node_modules'), path.join(proj, 'node_modules'));
    fs.writeFileSync(path.join(proj, 'conf/katana.json5'), `{
  chain: { host: 'http://127.0.0.1:1', token: '${A('9')}' },
  factories: { v2: { list: { V: { address: '${V}', fee: 0.003 } } } },
}`);
    const env = { ...process.env, ENVIO_REST_URL: BASE, ENVIO_REST_SECRET: SECRET, ETHERSCAN_API_KEY: '', ENVIO_API_TOKEN: '' };
    // Async, not spawnSync: the mock server lives in this process, and a
    // blocked event loop can't answer the CLI's requests.
    const run = (...args) => new Promise(resolve => {
        const child = spawn(process.execPath, ['--experimental-strip-types', 'source/util/find-factories.ts', 'katana', '--verify-limit', '0', ...args],
            { cwd: proj, env });
        let stdout = '', stderr = '';
        child.stdout.on('data', d => { stdout += d; });
        child.stderr.on('data', d => { stderr += d; });
        const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
        child.on('close', status => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
    });
    const swept = () => {
        const d = new ArbitradeDB(path.join(proj, 'db/katana.sqlite'));
        try { return d.getMeta('find-factories.lastBlock'); } finally { d.close(); }
    };

    const full = await run();
    ok(full.status === 0, 'full sweep exits 0', full.status === 0 ? '' : (full.stdout + full.stderr).slice(-600));
    ok(/Transport: envio \(auto\)/.test(full.stdout), 'auto picks envio when ENVIO_REST_URL is set');
    ok(swept() === '1200', 'the full sweep saves the processed block', `(${swept()})`);
    const disc = JSON.parse(fs.readFileSync(path.join(proj, 'log/katana/discovery.json'), 'utf8'));
    ok(disc.candidates.length === 4 && disc.candidates.find(c => c.address === V)?.status === 'known', 'discovery.json: every factory the indexer has (V, W, T, M), V known', `(${disc.candidates.length})`);

    const F = A('7');
    state.processed[CHAIN] = 1500;
    addFactory(F, 'velodrome', 1400, 1450, 4);
    state.requests = [];
    const fresh = await run('--new');
    const freshOk = fresh.status === 0 && /the last sweep reached block 1200 — sweeping from 1201/.test(fresh.stdout);
    ok(freshOk, '--new starts one past the saved block', freshOk ? '' : (fresh.stdout + fresh.stderr).slice(-400));
    ok(state.requests.some(r => r.includes(`/chain/${CHAIN}/factories?block=1201`)), '--new asks the indexer for factories from saved + 1');
    const disc2 = JSON.parse(fs.readFileSync(path.join(proj, 'log/katana/discovery.json'), 'utf8'));
    ok(disc2.candidates.length === 1 && disc2.candidates[0].address === F, '--new reports only the factory that is new', `(${disc2.candidates.map(c => c.address).join()})`);
    ok(swept() === '1500', '--new moves the saved block to the new processed block');

    const again = await run('--new');
    ok(again.status === 0 && /Nothing to sweep: already swept to block 1500/.test(again.stdout), '--new with nothing new is not an error');

    const bad = await run('--new', '--lookback', '100');
    ok(bad.status === 1 && /--new picks its own range/.test(bad.stderr), '--new refuses --lookback');
} finally {
    server.close();
    fs.rmSync(scratch, { recursive: true, force: true });
}
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
