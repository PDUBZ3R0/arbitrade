// `yarn hot` start-up, end to end (the real source/hot.ts as a process): the
// index is built from the DB snapshot, and a pair that moved after the last
// `yarn reserves` and then went quiet must not stay stale until it trades.
//
//   1. DB snapshot: three balanced pairs, no arbitrage. On chain, one pair is
//      then moved (no further Syncs) so a real edge exists.
//   2. --no-startup-refresh: the old behaviour — "no candidates at current
//      reserves", the standing edge is invisible.
//   3. default: "Startup refresh … 1/3 pair(s) … had moved", and the startup
//      sweep finds the candidate.
//
//   npm i -D solc@0.8.24                (one-time)
//   node test/test-hot-startup.mjs      (anvil on PATH; own anvil on 8567)

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';

const require = createRequire(import.meta.url);
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fails = 0;
const ok = (c, l, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${l} ${extra}`); if (!c) fails++; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const solc = require('solc');
const out = JSON.parse(solc.compile(JSON.stringify({
    language: 'Solidity',
    sources: {
        'FlashArbExecutor.sol': { content: fs.readFileSync(path.join(ROOT_DIR, 'contracts/FlashArbExecutor.sol'), 'utf8') },
        'YoBatches3.sol': { content: fs.readFileSync(path.join(ROOT_DIR, 'contracts/YoBatches3.sol'), 'utf8') },
        'YoBatches2.sol': { content: fs.readFileSync(path.join(ROOT_DIR, 'contracts/YoBatches2.sol'), 'utf8') },
        'Mocks.sol': { content: fs.readFileSync(path.join(ROOT_DIR, 'test/Mocks.sol'), 'utf8') },
        'Multicall3Min.sol': { content: fs.readFileSync(path.join(ROOT_DIR, 'test/Multicall3Min.sol'), 'utf8') },
    },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'shanghai',
                outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
})));
for (const e of out.errors ?? []) if (e.severity === 'error') { console.error(e.formattedMessage); process.exit(1); }
const art = {};
for (const [, cs] of Object.entries(out.contracts)) for (const [n, c] of Object.entries(cs)) art[n] = { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object };

const PORT = 8567, RPC = `http://127.0.0.1:${PORT}`;
const anvil = spawn('anvil', ['--port', String(PORT), '--silent', '--code-size-limit', '100000']);
await sleep(1500);
const provider = new ethers.JsonRpcProvider(RPC, undefined, { staticNetwork: true, cacheTimeout: -1 });
const w = new ethers.Wallet('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', provider);
let nonce = await provider.getTransactionCount(w.address);
const ov = () => ({ nonce: nonce++, gasLimit: 15_000_000n });
const deploy = async (a, ...args) => { const c = await new ethers.ContractFactory(a.abi, a.bytecode, w).deploy(...args, ov()); await c.waitForDeployment(); return c; };
const send = async (p) => (await p).wait();
const E = (n) => BigInt(n) * 10n ** 18n;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'hot-startup-'));

/** Run hot.ts until it starts watching, then stop it. */
function runHot(extra = []) {
    return new Promise((resolve) => {
        const p = spawn('node', ['--experimental-strip-types', '--no-warnings', path.join(scratch, 'source/hot.ts'), 'katana', '--owner', w.address, ...extra],
            { cwd: scratch, env: { ...process.env, KATANA_RPC: RPC, ARB_LEDGER: path.join(scratch, 'ledger.sqlite') } });
        let text = '';
        const done = () => { try { p.kill('SIGKILL'); } catch {} resolve(text); };
        const onData = (d) => { text += d; if (/Ctrl\+C to stop|not starting|Error/.test(text)) setTimeout(done, 300); };
        p.stdout.on('data', onData); p.stderr.on('data', onData);
        p.on('exit', () => resolve(text));
        setTimeout(done, 90_000);
    });
}

try {
    console.log('1. venue on anvil; DB snapshot balanced; then one pair moves on chain');
    const mc = await deploy(art.Multicall3Min);
    await provider.send('anvil_setCode', ['0xcA11bde05977b3631167028862bE2a173976CA11', await provider.getCode(await mc.getAddress())]);
    const yo = await deploy(art.YoBatches3);
    const [tR, tB, tC] = [await deploy(art.MockToken, 'ROOT', 0), await deploy(art.MockToken, 'B', 0), await deploy(art.MockToken, 'C', 0)];
    const [R, B, C] = await Promise.all([tR, tB, tC].map(t => t.getAddress()));
    const pairs = [];
    for (const [x, y, tx, ty] of [[R, B, tR, tB], [B, C, tB, tC], [C, R, tC, tR]]) {
        const p = await deploy(art.MockPair, x, y, 30);
        await send(tx.mint(await p.getAddress(), E(1_000_000), ov())); await send(ty.mint(await p.getAddress(), E(1_000_000), ov()));
        await send(p.sync(ov()));
        pairs.push(p);
    }
    const aave = await deploy(art.MockAavePool, 5);
    await send(tR.mint(await aave.getAddress(), E(10_000_000), ov()));
    const exec = await deploy(art.FlashArbExecutor, await aave.getAddress());

    fs.cpSync(path.join(ROOT_DIR, 'source'), path.join(scratch, 'source'), { recursive: true });
    fs.mkdirSync(path.join(scratch, 'conf')); fs.mkdirSync(path.join(scratch, 'db'));
    fs.copyFileSync(path.join(ROOT_DIR, 'conf/@chains.json5'), path.join(scratch, 'conf/@chains.json5'));
    fs.copyFileSync(path.join(ROOT_DIR, 'package.json'), path.join(scratch, 'package.json'));
    fs.symlinkSync(path.join(ROOT_DIR, 'node_modules'), path.join(scratch, 'node_modules'));
    const FACTORY = '0x00000000000000000000000000000000000f4c70';
    fs.writeFileSync(path.join(scratch, 'conf/katana.json5'), `{
  chain: { host: '${RPC}', token: '${R}', contract: '${await yo.getAddress()}', executor: '${await exec.getAddress()}' },
  factories: { v2: { list: { Mock: { address: '${FACTORY}', fee: 0.003 } } } },
  flashloan: { provider: 'aave-v3', pool: '${await aave.getAddress()}', premium: 0.0005,
    tokens: [ { symbol: 'ROOT', address: '${R}', decimals: 18 } ] },
  evaluator: { minProfitTokens: 0.01, minLiquidityTokens: 1, minInputTokens: 0.1 },
}\n`);

    const { ArbitradeDB } = await import(path.join(scratch, 'source/util/db.ts'));
    const db = new ArbitradeDB(path.join(scratch, 'db/katana.sqlite'));
    const raw = db.db, now = Math.floor(Date.now() / 1000);
    raw.prepare('INSERT INTO factories (address,name,type,fee,deployBlock) VALUES (?,?,?,?,?)').run(FACTORY, 'Mock', 'v2', 0.003, 0);
    for (const [s, a] of [['ROOT', R], ['B', B], ['C', C]]) raw.prepare('INSERT INTO tokens (address,symbol,name,decimals,fetchStatus,fetchedAt,discoveredAt) VALUES (?,?,?,?,?,?,?)').run(a.toLowerCase(), s, s, 18, 'ok', now, now);
    const addrs = [];
    for (const p of pairs) {
        const a = (await p.getAddress()).toLowerCase(); addrs.push(a);
        const [r0, r1] = await p.getReserves();
        raw.prepare('INSERT INTO pairs (address,factory,token0,token1,blockNumber,fee,stable) VALUES (?,?,?,?,?,?,?)').run(a, FACTORY, (await p.token0()).toLowerCase(), (await p.token1()).toLowerCase(), 1, 0.003, null);
        raw.prepare('INSERT INTO reserves (pair,reserves0,reserves1,blockNumber,updatedAt) VALUES (?,?,?,?,?)').run(a, r0.toString(), r1.toString(), 1, now);
    }
    raw.prepare(`INSERT INTO triangles (id,root_token,hop_count,token_a,token_b,token_c,pair_ab,pair_bc,pair_ca,factory_ab,factory_bc,factory_ca,canonical,createdAt)
        VALUES (1,?,3,?,?,?,?,?,?,?,?,?,?,?)`).run(R.toLowerCase(), R.toLowerCase(), B.toLowerCase(), C.toLowerCase(), addrs[0], addrs[1], addrs[2], FACTORY, FACTORY, FACTORY, [...addrs].sort().join('-'), now);
    db.close();

    // The move: 6% more ROOT in C/ROOT, after the snapshot. No Sync will follow.
    await send(tR.mint(await pairs[2].getAddress(), E(60_000), ov()));
    await send(pairs[2].sync(ov()));
    for (let i = 0; i < 3; i++) await provider.send('evm_mine', []);

    console.log('\n2. --no-startup-refresh: scored on the snapshot');
    const old = await runHot(['--no-startup-refresh']);
    ok(/Startup sweep: no candidates at current reserves/.test(old), 'the standing edge is invisible', (old.match(/Startup sweep.*/)?.[0] ?? old.slice(-500)));

    console.log('\n3. default: every pair re-read at start-up');
    const now2 = await runHot();
    ok(/Startup refresh \(every pair and pool, from chain\)\.\.\. \d+ms — 1\/3 pair\(s\) and 0\/0 v3 pool\(s\) had moved since the DB snapshot/.test(now2),
        'refresh reports the one moved pair', now2.match(/Startup refresh.*/)?.[0] ?? now2.slice(-600));
    ok(/Startup sweep: 1 candidate\(s\) already profitable/.test(now2), 'the startup sweep finds the edge', now2.match(/Startup sweep.*/)?.[0] ?? '');
} finally {
    anvil.kill();
    fs.rmSync(scratch, { recursive: true, force: true });
}

console.log(fails === 0 ? '\nALL HOT-STARTUP CHECKS PASS' : `\n${fails} FAILED`);
process.exit(fails ? 1 : 0);
