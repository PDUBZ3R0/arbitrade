// TokenProbe borrows from every lender FlashArbExecutor can (probeFrom), so
// `yarn probe` works on chains without Aave — Robinhood's Longbow is Morpho Blue.
//
//   1. probeFrom through each source — Aave V3 (mock), Balancer V2 (mock
//      vault), a REAL Uniswap V3 pool's flash() (v3-core 1.0.0), Morpho Blue
//      (mock) — classifies a clean token as clean and a 5% tax token as
//      fee-on-transfer with the right buy/sell tax.
//   2. The legacy probe() still borrows from the constructor's Aave pool, and
//      a probe deployed with address(0) refuses it (NoLender) cleanly.
//   3. Callback safety: a direct call to any callback reverts NotPool; a bad
//      source and a root the V3 pool does not hold are reported as lender
//      config errors, not as token verdicts.
//   4. probeSupportsLenders reads probeFrom from the dispatcher.
//   5. Nothing persists: every probe reverts, so the lenders' balances are
//      untouched afterwards.
//   6. yarn probe end to end on a Robinhood-shaped chain: no Aave (probe
//      deployed with address(0)), flashloan provider morpho. Roots borrow from
//      Morpho; the taxed token is flagged, the clean one passes. A probe
//      without probeFrom is refused with the redeploy hint.
//
//   npm i -D @uniswap/v3-core@1.0.1 solc@0.8.24     (one-time)
//   node test/test-probe-lenders.mjs                (anvil on PATH; own anvil on 8566)

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { ethers } from 'ethers';
import { probePair, probeSupportsLenders, PROBE_ABI } from '../source/util/token-probe.ts';

const require = createRequire(import.meta.url);
const here = (p) => new URL(p, import.meta.url);
let fails = 0;
const ok = (c, l, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${l} ${extra}`); if (!c) fails++; };

const solc = require('solc');
const out = JSON.parse(solc.compile(JSON.stringify({
    language: 'Solidity',
    sources: {
        'TokenProbe.sol': { content: fs.readFileSync(here('../contracts/TokenProbe.sol'), 'utf8') },
        'Mocks.sol': { content: fs.readFileSync(here('./Mocks.sol'), 'utf8') },
        'V3Harness.sol': { content: fs.readFileSync(here('./v3-golden/V3Harness.sol'), 'utf8') },
    },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'shanghai',
                outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
})));
for (const e of out.errors ?? []) if (e.severity === 'error') { console.error(e.formattedMessage); process.exit(1); }
const art = {};
for (const [, cs] of Object.entries(out.contracts)) for (const [n, c] of Object.entries(cs)) art[n] = { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object };
const v3 = n => require(`@uniswap/v3-core/artifacts/contracts/${n}.sol/${n}.json`);

const PORT = 8566;
const anvil = spawn('anvil', ['--port', String(PORT), '--disable-code-size-limit', '--gas-limit', '3000000000', '--silent']);
await new Promise(r => setTimeout(r, 1500));
const provider = new ethers.JsonRpcProvider(`http://127.0.0.1:${PORT}`, undefined, { cacheTimeout: -1, staticNetwork: true });
const signer = await provider.getSigner(0);
let nonce = await provider.getTransactionCount(await signer.getAddress());
const ov = () => ({ nonce: nonce++, gasLimit: 30_000_000n });
const deploy = async (a, ...args) => { const c = await new ethers.ContractFactory(a.abi, a.bytecode, signer).deploy(...args, ov()); await c.waitForDeployment(); return c; };
const send = async (p) => (await p).wait();
const E = (n) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;
const SRC = { aave: 0, balancer: 1, univ3: 2, morpho: 3 };
const PI = new ethers.Interface(PROBE_ABI);
const errName = (e) => {
    for (const d of [e?.data, e?.info?.error?.data, e?.error?.data, e?.revert?.data]) {
        if (typeof d === 'string' && d.length >= 10) { try { return PI.parseError(d)?.name ?? d.slice(0, 10); } catch { return d.slice(0, 10); } }
    }
    return String(e?.shortMessage ?? e?.message ?? e).slice(0, 90);
};

try {
    const root = await deploy(art.MockToken, 'ROOT', 0);
    const R = await root.getAddress();
    const clean = await deploy(art.MockToken, 'CLEAN', 0), taxed = await deploy(art.MockToken, 'TAX', 500);
    const pairs = {};
    for (const [name, t] of [['clean', clean], ['taxed', taxed]]) {
        const p = await deploy(art.MockPair, R, await t.getAddress(), 30);
        const P = await p.getAddress();
        await send(root.mint(P, E(1e6), ov())); await send(t.mint(P, E(1e6), ov())); await send(p.sync(ov()));
        pairs[name] = P;
    }

    const aave = await deploy(art.MockAavePool, 5);
    const vault = await deploy(art.MockBalancerVault, 0);
    const morpho = await deploy(art.MockMorpho);
    const factory = await deploy(v3('UniswapV3Factory'));
    const harness = await deploy(art.Harness);
    const x = await deploy(art.MockToken, 'X', 0);
    await send(factory.createPool(R, await x.getAddress(), 500, ov()));
    const v3pool = new ethers.Contract(await factory.getPool(R, await x.getAddress(), 500), v3('UniswapV3Pool').abi, signer);
    await send(v3pool.initialize(1n << 96n, ov()));
    await send(harness.mint(await v3pool.getAddress(), -887270, 887270, E(1e6), ov()));
    const lenders = {
        aave: await aave.getAddress(), balancer: await vault.getAddress(),
        univ3: await v3pool.getAddress(), morpho: await morpho.getAddress(),
    };
    for (const k of ['aave', 'balancer', 'morpho']) await send(root.mint(lenders[k], E(1e6), ov()));

    const probe = await deploy(art.TokenProbe, lenders.aave);
    const PROBE = await probe.getAddress();
    const AMOUNT = E(1000);
    const before = Object.fromEntries(await Promise.all(Object.entries(lenders).map(async ([k, a]) => [k, await root.balanceOf(a)])));

    console.log('1. probeFrom through every lender');
    for (const k of ['aave', 'balancer', 'univ3', 'morpho']) {
        const via = { source: SRC[k], lender: lenders[k] };
        const c = await probePair(provider, PROBE, R, pairs.clean, AMOUNT, 200, via);
        ok(c.status === 'clean', `${k.padEnd(8)} clean token → clean`, `(${c.status}: ${c.reason})`);
        const t = await probePair(provider, PROBE, R, pairs.taxed, AMOUNT, 200, via);
        ok(t.status === 'fee-on-transfer' && Math.abs(t.buyTaxBps - 500) <= 1 && Math.abs(t.sellTaxBps - 500) <= 1,
            `${k.padEnd(8)} 5% tax token → fee-on-transfer, buy/sell 5%`, `(${t.status} ${t.buyTaxBps}/${t.sellTaxBps})`);
    }

    console.log('\n2. legacy probe() — the constructor\'s Aave pool');
    const legacy = await probePair(provider, PROBE, R, pairs.taxed, AMOUNT, 200);
    ok(legacy.status === 'fee-on-transfer', 'probe() via Aave → fee-on-transfer', `(${legacy.status})`);
    const noAave = await deploy(art.TokenProbe, ethers.ZeroAddress);
    const na = await probePair(provider, await noAave.getAddress(), R, pairs.clean, AMOUNT, 200);
    ok(na.status === 'error' && /NoLender/.test(na.reason), 'deployed without Aave: probe() → lender config error, not a verdict', `(${na.reason})`);
    const nm = await probePair(provider, await noAave.getAddress(), R, pairs.clean, AMOUNT, 200, { source: SRC.morpho, lender: lenders.morpho });
    ok(nm.status === 'clean', 'deployed without Aave: probeFrom(morpho) still works', `(${nm.status})`);

    console.log('\n3. callback safety and bad lender config');
    const enc = ethers.AbiCoder.defaultAbiCoder().encode(['address', 'address', 'uint16'], [R, pairs.clean, 200]);
    const direct = [
        ['executeOperation', () => probe.executeOperation.staticCall(R, AMOUNT, 0, PROBE, enc)],
        ['receiveFlashLoan', () => probe.receiveFlashLoan.staticCall([R], [AMOUNT], [0], enc)],
        ['uniswapV3FlashCallback', () => probe.uniswapV3FlashCallback.staticCall(0, 0, enc)],
        ['onMorphoFlashLoan', () => probe.onMorphoFlashLoan.staticCall(AMOUNT, enc)],
    ];
    for (const [n, f] of direct) {
        let e = null; try { await f(); } catch (err) { e = errName(err); }
        ok(e === 'NotPool', `direct ${n} → NotPool`, `(${e})`);
    }
    const bad = await probePair(provider, PROBE, R, pairs.clean, AMOUNT, 200, { source: 7, lender: lenders.morpho });
    ok(bad.status === 'error' && /BadSource/.test(bad.reason), 'unknown source → lender config error', `(${bad.reason})`);
    const notIn = await probePair(provider, PROBE, await clean.getAddress(), pairs.clean, AMOUNT, 200, { source: SRC.univ3, lender: lenders.univ3 });
    ok(notIn.status === 'error' && /TokenNotInLender/.test(notIn.reason), 'root not in the V3 pool → lender config error', `(${notIn.reason})`);
    const wrongLender = await probePair(provider, PROBE, R, pairs.clean, AMOUNT, 200, { source: SRC.morpho, lender: lenders.balancer });
    ok(wrongLender.status === 'error', 'Morpho source pointed at a Balancer vault → error, never a token verdict', `(${wrongLender.reason.slice(0, 60)})`);

    console.log('\n4. probeSupportsLenders');
    ok(await probeSupportsLenders(provider, PROBE), 'new TokenProbe → has probeFrom');
    ok(!(await probeSupportsLenders(provider, lenders.morpho)), 'some other contract → no');

    console.log('\n5. nothing persists');
    const after = Object.fromEntries(await Promise.all(Object.entries(lenders).map(async ([k, a]) => [k, await root.balanceOf(a)])));
    ok(Object.keys(before).every(k => before[k] === after[k]), 'every lender\'s root balance unchanged');
    ok((await root.balanceOf(PROBE)) === 0n, 'probe holds nothing');

    console.log('\n6. yarn probe on a Morpho-only chain (Robinhood / Longbow shape)');
    const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-lenders-'));
    try {
        fs.cpSync(path.join(ROOT, 'source'), path.join(scratch, 'source'), { recursive: true });
        fs.mkdirSync(path.join(scratch, 'conf')); fs.mkdirSync(path.join(scratch, 'db'));
        fs.copyFileSync(path.join(ROOT, 'conf/@chains.json5'), path.join(scratch, 'conf/@chains.json5'));
        fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(scratch, 'package.json'));
        fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(scratch, 'node_modules'));
        const FACTORY = '0x00000000000000000000000000000000000fac70';
        const writeConf = (probeAddr) => fs.writeFileSync(path.join(scratch, 'conf/katana.json5'), `{
  chain: { host: 'http://127.0.0.1:${PORT}', probe: '${probeAddr}' },
  factories: { v2: { Mock: '${FACTORY}' } },
  flashloan: { provider: 'morpho', morpho: '${lenders.morpho}', premium: 0,
    tokens: [ { symbol: 'ROOT', address: '${R}', decimals: 18 } ] },
}\n`);
        const { ArbitradeDB } = await import(path.join(scratch, 'source/util/db.ts'));
        const dbFile = path.join(scratch, 'db/katana.sqlite');
        const db = new ArbitradeDB(dbFile);
        const lc = (a) => a.toLowerCase();
        const rows = [];
        for (const [P, t] of [[pairs.clean, clean], [pairs.taxed, taxed]]) {
            const T = lc(await t.getAddress()), r = lc(R);
            const [t0, t1] = r < T ? [r, T] : [T, r];
            rows.push({ address: lc(P), factory: FACTORY, token0: t0, token1: t1, blockNumber: 1 });
        }
        db.insertPairs(rows);
        db.upsertReserves(rows.map(p => ({ pair: p.address, reserves0: E(1e6), reserves1: E(1e6), blockNumber: 1 })));
        db.close();
        const run = () => {
            try { return execFileSync('node', ['--experimental-strip-types', '--no-warnings', path.join(scratch, 'source/probe.ts'), 'katana', '--refresh'],
                { cwd: scratch, env: { ...process.env, KATANA_RPC: `http://127.0.0.1:${PORT}` }, encoding: 'utf8', timeout: 120_000 }); }
            catch (e) { return `EXIT ${e.status}\n${e.stdout}\n${e.stderr}`; }
        };

        writeConf(await noAave.getAddress());
        const o = run();
        ok(/root ROOT\s+borrowed from morpho 0x/i.test(o), 'ROOT is borrowed from Morpho', o.match(/root ROOT.*/)?.[0] ?? o.slice(-400));
        const db2 = new ArbitradeDB(dbFile);
        const st = (t) => db2.db.prepare('SELECT probeStatus, buyTaxBps FROM tokens WHERE address = ?').get(t);
        const sc = st(lc(await clean.getAddress())), stx = st(lc(await taxed.getAddress()));
        ok(sc?.probeStatus === 'clean', 'DB: clean token → clean', JSON.stringify(sc));
        ok(stx?.probeStatus === 'fee-on-transfer' && Math.abs(stx.buyTaxBps - 500) <= 1, 'DB: taxed token → fee-on-transfer 5%', JSON.stringify(stx));
        db2.close();

        // An Aave-only TokenProbe (no probeFrom): stand in with a contract whose
        // dispatcher lacks the selector — the old probe's shape.
        writeConf(lenders.aave);
        const old = run();
        ok(/EXIT 1/.test(old) && /only borrows from Aave — redeploy it: yarn deploy probe katana/.test(old), 'old probe + Morpho lender → refused with the redeploy hint', (old.match(/\[!\].*/)?.[0] ?? old.slice(-300)).slice(0, 140));
    } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
    }
} finally {
    anvil.kill();
}

console.log(fails === 0 ? '\nALL PROBE-LENDER CHECKS PASS' : `\n${fails} FAILED`);
process.exit(fails ? 1 : 0);
