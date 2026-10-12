// yarn check-fee-config <chain> [--apply] — per-pair fee accessors that do
// not answer, found before `yarn reserves` stops on them.
//
// The case that prompted it (monad, 2026-10-11): find-factories --add saw the
// explorer name "PairFactory", took the Retro-degen pattern's accessor
// (factory.getFee(bool stable, bool degen)) on trust, and reserves then failed
// with "Metadata fetch is failing for PairFactory_932cabaa: 3/3 pairs".
//
//   1. find-factories' patternConfirmed: a name-matched pattern with a fee
//      function is trusted only when the probe answered through the same
//      accessor; name-only patterns (flat fee, hardcoded) still are.
//   2. Against anvil, in a scratch copy of the repo:
//        PairFactory_…  a Velodrome-style factory (getFee(pool, stable)) keyed
//                       like the monad one, so config.ts fills in the degen
//                       accessor from the key → FIX to PoolFactory's accessor
//        Velo           the same kind of factory configured right → OK
//        Dead           a factory nothing answers for → UNREADABLE
//      Report-only writes nothing; --apply rewrites PairFactory_…'s fee fields
//      (explicitly, so the key's pattern cannot fill them back in), clears its
//      pairs' fees in the DB, blacklists Dead; a re-check is all OK.
//
//   node test/test-check-fee-config.mjs   (anvil on PATH; own anvil on 8565)

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';
import JSON5 from 'json5';
import { patternConfirmed } from '../source/util/find-factories.ts';
import { DEX_PATTERNS } from '../source/util/dex-patterns.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fails = 0;
const ok = (c, l, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${l} ${extra}`); if (!c) fails++; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

console.log('1. a contract name is a hint, not proof of the fee accessor');
{
    ok(!patternConfirmed(DEX_PATTERNS.PairFactory, { probedPattern: undefined }), 'PairFactory by name, probe found nothing → not trusted');
    ok(!patternConfirmed(DEX_PATTERNS.PairFactory, { probedPattern: 'PoolFactory' }), 'PairFactory by name, probe found PoolFactory → not trusted');
    ok(patternConfirmed(DEX_PATTERNS.PairFactory, { probedPattern: 'PairFactory' }), 'PairFactory by name, probe agrees → trusted');
    const flat = Object.entries(DEX_PATTERNS).find(([, p]) => p.fee !== undefined || p.stableFees);
    ok(!!flat && patternConfirmed(flat[1], { probedPattern: undefined }), `name-only pattern (${flat?.[0]}) → trusted, there is nothing to call`);
}

const art = JSON.parse(fs.readFileSync(new URL('./artifacts.json', import.meta.url), 'utf8'));
const PORT = 8565, RPC = `http://127.0.0.1:${PORT}`;
const anvil = spawn('anvil', ['--port', String(PORT), '--silent']);
await sleep(1500);
const provider = new ethers.JsonRpcProvider(RPC, undefined, { staticNetwork: true, cacheTimeout: -1 });
const w = new ethers.Wallet('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', provider);
let nonce = await provider.getTransactionCount(w.address);
const ov = () => ({ nonce: nonce++, gasLimit: 15_000_000n });
const deploy = async (a, ...args) => { const c = await new ethers.ContractFactory(a.abi, a.bytecode, w).deploy(...args, ov()); await c.waitForDeployment(); return c; };
const send = async (p) => (await p).wait();
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cfc-'));

try {
    console.log('\n2. yarn check-fee-config katana [--apply] against anvil');
    const mc = await deploy(art.Multicall3Min);
    await provider.send('anvil_setCode', ['0xcA11bde05977b3631167028862bE2a173976CA11', await provider.getCode(await mc.getAddress())]);
    const T = []; for (const n of ['A', 'B', 'C']) T.push(await deploy(art.MockToken, n, 0));
    const ta = await Promise.all(T.map(t => t.getAddress()));

    const veloPools = async (f) => {
        const out = [];
        for (const [x, y, stable] of [[0, 1, false], [1, 2, false], [0, 2, true]]) {
            const rc = await send(f.createPool(ta[x], ta[y], stable, ov()));
            const ev = rc.logs.map(l => { try { return f.interface.parseLog(l); } catch { return null; } }).find(e => e?.name === 'PoolCreated');
            out.push({ pair: ev.args.pool.toLowerCase(), token0: ev.args.token0.toLowerCase(), token1: ev.args.token1.toLowerCase(), stable });
        }
        return out;
    };
    const misF = await deploy(art.MockVeloFactory), goodF = await deploy(art.MockVeloFactory);
    const MIS = (await misF.getAddress()).toLowerCase(), GOOD = (await goodF.getAddress()).toLowerCase();
    const misPools = await veloPools(misF), goodPools = await veloPools(goodF);
    const DEAD = (await (await deploy(art.MockToken, 'X', 0)).getAddress()).toLowerCase();   // no fee function of any kind
    const deadPairs = [];
    for (const [x, y] of [[0, 1], [1, 2]]) {
        const p = await deploy(art.MockPair, ta[x], ta[y], 30);
        const [t0, t1] = ta[x].toLowerCase() < ta[y].toLowerCase() ? [ta[x], ta[y]] : [ta[y], ta[x]];
        deadPairs.push({ pair: (await p.getAddress()).toLowerCase(), token0: t0.toLowerCase(), token1: t1.toLowerCase() });
    }

    fs.cpSync(path.join(ROOT, 'source'), path.join(scratch, 'source'), { recursive: true });
    fs.mkdirSync(path.join(scratch, 'conf'));
    fs.copyFileSync(path.join(ROOT, 'conf/@chains.json5'), path.join(scratch, 'conf/@chains.json5'));
    fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(scratch, 'package.json'));
    fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(scratch, 'node_modules'));
    const misKey = `PairFactory_${MIS.slice(2, 10)}`;
    const confFile = path.join(scratch, 'conf/katana.json5');
    const conf = `{\n  chain: { host: '${RPC}' },\n  factories: {\n    solidly: {\n      // find-factories --add: explorer "PairFactory"; registered DEX pattern\n      ${misKey}: {\n        address: '${MIS}',\n        poolEvent: 'velodrome',\n      },\n      Velo: {\n        address: '${GOOD}',\n        poolEvent: 'velodrome',\n        feeTarget: 'factory',\n        feeArgSource: 'pair-address-stable',\n        feeFunction: 'getFee',\n        feeDivisor: 10000,\n      },\n    },\n    v2fee: {\n      Dead: '${DEAD}',\n    },\n  },\n}\n`;
    fs.writeFileSync(confFile, conf);

    const { ArbitradeDB } = await import(path.join(scratch, 'source/util/db.ts'));
    fs.mkdirSync(path.join(scratch, 'db'));
    const dbFile = path.join(scratch, 'db/katana.sqlite');
    const db = new ArbitradeDB(dbFile);
    db.insertPairs([
        ...misPools.map(p => ({ address: p.pair, factory: MIS, token0: p.token0, token1: p.token1, blockNumber: 1, stable: p.stable, fee: 0.009 })),
        ...goodPools.map(p => ({ address: p.pair, factory: GOOD, token0: p.token0, token1: p.token1, blockNumber: 1, stable: p.stable })),
        ...deadPairs.map(p => ({ address: p.pair, factory: DEAD, token0: p.token0, token1: p.token1, blockNumber: 1 })),
    ]);
    db.upsertReserves([...misPools, ...goodPools, ...deadPairs].map(p => ({ pair: p.pair, reserves0: 10n ** 21n, reserves1: 10n ** 21n, blockNumber: 1 })));
    db.close();

    const run = (...extra) => {
        try {
            return execFileSync('node', ['--experimental-strip-types', '--no-warnings', path.join(scratch, 'source/check-fee-config.ts'), 'katana', ...extra],
                { cwd: scratch, env: { ...process.env, KATANA_RPC: RPC }, encoding: 'utf8', timeout: 120_000 });
        } catch (e) { return `EXIT ${e.status}\n${e.stdout}\n${e.stderr}`; }
    };
    const line = (out, name) => out.split('\n').find(l => l.trim().startsWith(name)) ?? '';

    const report = run();
    ok(/FIX\s+configured factory\.getFee\(pair-stable-degen\) \/ 10000 returned nothing.*PoolFactory answers: factory\.getFee\(pair-address-stable\) \/ 10000 → 0\.3\/0\.05%/.test(line(report, misKey)),
        `${misKey}: the key's degen accessor fails, PoolFactory's answers → FIX`, line(report, misKey).slice(0, 170));
    ok(/^Velo\s+OK\s+factory\.getFee\(pair-address-stable\) \/ 10000 → 0\.3\/0\.05% on 3\/3/.test(line(report, 'Velo').trim()), 'Velo: configured right → OK (0.3% volatile, 0.05% stable)', line(report, 'Velo').trim().slice(0, 120));
    ok(/^Dead\s+UNREADABLE/.test(line(report, 'Dead').trim()), 'Dead: nothing answers → UNREADABLE', line(report, 'Dead').trim().slice(0, 120));
    ok(fs.readFileSync(confFile, 'utf8') === conf && !fs.existsSync(path.join(scratch, 'conf/katana-blacklist.json5')), 'report only: nothing written');

    const applied = run('--apply');
    const c2 = fs.readFileSync(confFile, 'utf8'), e2 = JSON5.parse(c2).factories.solidly[misKey];
    ok(e2.feeTarget === 'factory' && e2.feeArgSource === 'pair-address-stable' && e2.feeFunction === 'getFee' && e2.feeDivisor === 10000 && e2.poolEvent === 'velodrome',
        `conf: ${misKey} has every accessor field explicit`, JSON.stringify(e2));
    ok(/registered DEX pattern/.test(c2) && /check-fee-config \d{4}-\d\d-\d\d: .*degen.* did not answer; PoolFactory does/.test(c2), 'conf: old note kept, dated note added');
    const db2 = new ArbitradeDB(dbFile);
    const fees = db2.db.prepare('SELECT fee FROM pairs WHERE factory = ?').all(MIS).map(r => r.fee);
    ok(fees.length === 3 && fees.every(f => f === null), 'DB: its pairs\' fees cleared for the next reserves run', JSON.stringify(fees));
    db2.close();
    const bl = JSON5.parse(fs.readFileSync(path.join(scratch, 'conf/katana-blacklist.json5'), 'utf8')).factories;
    ok(bl.length === 1 && bl[0].address === DEAD && /UNREADABLE \(2 pairs, v2fee\)/.test(bl[0].reason), 'blacklist: Dead, with the reason', bl[0]?.reason?.slice(0, 80));

    const again = run();
    ok(/OK 2\s+FIX 0\s+REVIEW 0\s+UNREADABLE 0/.test(again), 're-check: both remaining factories OK', again.match(/OK \d.*/)?.[0] ?? again.slice(-300));
} finally {
    anvil.kill();
    fs.rmSync(scratch, { recursive: true, force: true });
}

console.log(fails === 0 ? '\nALL CHECK-FEE-CONFIG CHECKS PASS' : `\n${fails} FAILED`);
process.exit(fails ? 1 : 0);
