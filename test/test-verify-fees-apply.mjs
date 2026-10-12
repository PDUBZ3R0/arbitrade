// yarn verify-fees <chain> --apply — what it writes, and that it writes nothing
// else.
//
//   1. conf edits on every conf in the repo (pure, no I/O): set a v2 fee
//      (object, one-line and bare-address entries; legacy `list` and flat
//      groups), move an entry to another group with its comments, refuse an
//      address that does not match — and every other factory reads back
//      unchanged.
//   2. blacklist append keeps the file's comments and quoting (it used to be
//      re-serialised, which wiped sonic-blacklist.json5's notes).
//   3. curve-reconfig on anvil: Camelot-shaped pairs (stableSwap + directional
//      token0/token1FeePercent) are reconfigured to v2fee with the flag; a
//      pair with another invariant (BrownFi-like: a `fee` but no flag) is not.
//   4. end to end, in a scratch copy of the repo against anvil: a real
//      UniswapV2 factory configured at the wrong fee gets the right one in the
//      conf AND in the DB pair rows; a factory whose pairs no method can read
//      is blacklisted; the report-only run (no --apply) changes nothing.
//      (NON-CP needs Claude's verdict, so it is covered by 3, not here.)
//
//   node test/test-verify-fees-apply.mjs   (anvil on PATH; own anvil on 8564;
//   needs the one-time `npm i -D @uniswap/v2-core@1.0.1 solc@0.8.24` of test-flash-swap)

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';
import JSON5 from 'json5';
import { editFactoriesInText, appendToBlacklistText } from '../source/util/conf-edit.ts';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fails = 0;
const ok = (c, l, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${l} ${extra}`); if (!c) fails++; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const addrOf = (s, k) => typeof s[k] === 'string' ? s[k] : s[k].address;
const groupEntries = (g) => { const s = g?.list ?? g ?? {}; return [s, Object.keys(s).filter(k => k !== 'abi' && k !== 'list')]; };

// ---------------------------------------------------------------------------
console.log('1. conf edits');
{
    const confs = fs.readdirSync(path.join(ROOT, 'conf')).filter(f => f.endsWith('.json5') && !f.includes('blacklist') && !f.startsWith('@'));
    let tried = 0;
    for (const f of confs) {
        const text = fs.readFileSync(path.join(ROOT, 'conf', f), 'utf8');
        let parsed; try { parsed = JSON5.parse(text); } catch { continue; }   // a stub that is not a config yet
        const [s, keys] = groupEntries(parsed.factories?.v2);
        if (keys.length < 2) continue;
        tried++;
        const [first, last] = [keys[0], keys.at(-1)];
        try {
            const r = editFactoriesInText(text, [
                { kind: 'setFee', group: 'v2', key: last, address: addrOf(s, last), fee: 0.0021, comment: 'test' },
                { kind: 'move', group: 'v2', key: first, address: addrOf(s, first), to: 'v2fee', entry: { address: addrOf(s, first), feeTarget: 'pair', feeFunction: 'fee', feeDivisor: 1000 }, note: 'moved' },
            ]);
            const [s2] = groupEntries(JSON5.parse(r.text).factories.v2);
            const [f2] = groupEntries(JSON5.parse(r.text).factories.v2fee);
            const okAll = s2[last].fee === 0.0021 && !s2[first] && f2[first]?.feeFunction === 'fee'
                && (text.match(/\/\//g) ?? []).length + 2 <= (r.text.match(/\/\//g) ?? []).length;
            ok(okAll, `${f}: fee set on ${last}, ${first} moved to v2fee, comments kept`);
        } catch (e) { ok(false, `${f}: ${e.message}`); }
    }
    ok(tried > 0, `${tried} repo conf(s) exercised`);

    const A = '0x' + '1'.repeat(40), B = '0x' + '2'.repeat(40), C = '0x' + '3'.repeat(40), D = '0x' + '4'.repeat(40);
    const t = `{\n  factories: {\n    v2: {\n      list: {\n        A: '${A}',\n        B: { address: '${B}' },   // note B\n        C: {   // 12 pairs\n          address: '${C}',\n          fee: 0.003,   // assumed\n        },\n      },\n      D: { address: '${D}', fee: 0.003 },\n    },\n  },\n}\n`;
    const r = editFactoriesInText(t, [
        { kind: 'setFee', group: 'v2', key: 'A', address: A, fee: 0.0025 },
        { kind: 'setFee', group: 'v2', key: 'B', address: B, fee: 0.001, comment: 'b' },
        { kind: 'setFee', group: 'v2', key: 'D', address: D, fee: 0.002 },
        { kind: 'move', group: 'v2', key: 'C', address: C, to: 'v2fee', entry: { address: C, hasStableFlag: true, stableFunction: 'stableSwap' }, comment: 'moved', note: 'C → v2fee' },
    ]);
    const j = JSON5.parse(r.text);
    ok(j.factories.v2.list.A.fee === 0.0025 && j.factories.v2.list.A.address === A, "bare address → { address, fee }");
    ok(j.factories.v2.list.B.fee === 0.001 && /note B/.test(r.text), 'one-line entry gains fee, trailing comment kept');
    ok(j.factories.v2.D.fee === 0.002, 'flat entry beside a legacy list');
    ok(!j.factories.v2.list.C && j.factories.v2fee.C.stableFunction === 'stableSwap' && j.factories.v2fee.C.fee === undefined, 'move: out of v2, into a new v2fee group without the flat fee');
    ok(/\/\/ 12 pairs\n\s*\/\/ assumed\n\s*C: \{/.test(r.text.replace(/\/\/ moved\n\s*/, '')), "the moved entry's comments travel with it");
    let threw = '';
    try { editFactoriesInText(t, [{ kind: 'setFee', group: 'v2', key: 'A', address: B, fee: 0.001 }]); } catch (e) { threw = e.message; }
    ok(/not 0x2/.test(threw), 'an address that does not match the key is refused', `(${threw.slice(0, 60)})`);
}

// ---------------------------------------------------------------------------
console.log('\n2. blacklist append');
{
    for (const f of fs.readdirSync(path.join(ROOT, 'conf')).filter(f => f.endsWith('-blacklist.json5'))) {
        const t = fs.readFileSync(path.join(ROOT, 'conf', f), 'utf8');
        const n = appendToBlacklistText(t, [{ address: '0x' + 'a'.repeat(40), reason: 'say "why"', addedAt: '2026-10-11' }]);
        const before = JSON5.parse(t).factories, after = JSON5.parse(n).factories;
        ok(after.length === before.length + 1 && after.at(-1).reason === 'say "why"'
            && (t.match(/\/\//g) ?? []).length === (n.match(/\/\//g) ?? []).length && n.startsWith(t.slice(0, t.lastIndexOf(']') - 20)),
            `${f}: one entry appended, comments and existing text kept`);
    }
    ok(JSON5.parse(appendToBlacklistText('{\n  // none yet\n  factories: [],\n}\n', [{ address: '0x1' }])).factories.length === 1, 'empty array');
}

// ---------------------------------------------------------------------------
const solc = require('solc');
const SRC = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
contract MockCamelotPair {
    bool public stableSwap; uint16 public token0FeePercent; uint16 public token1FeePercent;
    uint256 public constant FEE_DENOMINATOR = 100000;
    constructor(bool s, uint16 f0, uint16 f1) { stableSwap = s; token0FeePercent = f0; token1FeePercent = f1; }
}
contract MockOtherCurvePair { uint32 public fee = 300000; uint32 public constant PRECISION = 1e8; }
contract Sink {}`;
const out = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources: { 'm.sol': { content: SRC } },
    settings: { evmVersion: 'shanghai', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } })));
const mk = (n) => ({ abi: out.contracts['m.sol'][n].abi, bytecode: '0x' + out.contracts['m.sol'][n].evm.bytecode.object });
const art = JSON.parse(fs.readFileSync(new URL('./artifacts.json', import.meta.url), 'utf8'));
const v2 = n => { const j = require(`@uniswap/v2-core/build/${n}.json`); return { abi: j.abi, bytecode: '0x' + j.bytecode.replace(/^0x/, '') }; };

const PORT = 8564, RPC = `http://127.0.0.1:${PORT}`;
const anvil = spawn('anvil', ['--port', String(PORT), '--silent', '--code-size-limit', '100000']);
await sleep(1500);
const provider = new ethers.JsonRpcProvider(RPC, undefined, { staticNetwork: true, cacheTimeout: -1 });
const w = new ethers.Wallet('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', provider);
let nonce = await provider.getTransactionCount(w.address);
const ov = () => ({ nonce: nonce++, gasLimit: 15_000_000n });
const deploy = async (a, ...args) => { const c = await new ethers.ContractFactory(a.abi, a.bytecode, w).deploy(...args, ov()); await c.waitForDeployment(); return c; };
const send = async (p) => (await p).wait();
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-apply-'));

try {
    const mc = await deploy(art.Multicall3Min);
    await provider.send('anvil_setCode', ['0xcA11bde05977b3631167028862bE2a173976CA11', await provider.getCode(await mc.getAddress())]);

    console.log('\n3. curve-reconfig: which non-constant-product factories can be configured');
    {
        process.env.KATANA_RPC = RPC;   // verify-factory (the Solidly fallback) reads the chain through this label
        const { proposeReconfig } = await import('../source/util/curve-reconfig.ts');
        const cam = [await deploy(mk('MockCamelotPair'), false, 300, 300), await deploy(mk('MockCamelotPair'), true, 40, 40), await deploy(mk('MockCamelotPair'), false, 300, 500)];
        const camAddrs = await Promise.all(cam.map(c => c.getAddress()));
        const fac = '0x' + 'c'.repeat(40);
        const r1 = await proposeReconfig('katana', provider, { address: fac, deployBlock: 7 }, camAddrs, 'Hyperswap');
        ok(r1.reconfig?.group === 'v2fee' && r1.reconfig.entry.stableFunction === 'stableSwap' && r1.reconfig.entry.hasStableFlag === true
            && r1.reconfig.entry.feeTarget === 'pair' && r1.reconfig.entry.feeFunction === 'token0FeePercent' && r1.reconfig.entry.feeDivisor === 100000
            && r1.reconfig.entry.deployBlock === 7 && r1.reconfig.entry.fee === undefined,
            'Camelot shape → v2fee, fee from the pair, stable pairs flagged by stableSwap()', `(${r1.why})`);
        ok(/1 stable, 1 with a different token1 fee/.test(r1.why), 'the basis counts stable pairs and directional fees');
        const other = await Promise.all([deploy(mk('MockOtherCurvePair')), deploy(mk('MockOtherCurvePair'))]);
        const r2 = await proposeReconfig('katana', provider, { address: await (await deploy(mk('Sink'))).getAddress() }, await Promise.all(other.map(o => o.getAddress())), 'BrownFi');
        ok(r2.reconfig === null, 'another invariant (no stable flag) is not reconfigured', `(${r2.why})`);
        const mixed = await proposeReconfig('katana', provider, { address: fac }, [camAddrs[0], await other[0].getAddress()], 'Mixed');
        ok(mixed.reconfig === null, 'one sample that is not Camelot-shaped is enough to say no');
    }

    console.log('\n4. end to end: yarn verify-fees <chain> [--apply] in a scratch copy');
    {
        // The real UniswapV2Pair (fee 0.3% in its bytecode) under a factory configured at 0.25%.
        const T = [await deploy(art.MockToken, 'A', 0), await deploy(art.MockToken, 'B', 0), await deploy(art.MockToken, 'C', 0)];
        const ta = await Promise.all(T.map(t => t.getAddress()));
        for (const t of T) await send(t.mint(w.address, 10n ** 30n, ov()));
        const uf = await deploy(v2('UniswapV2Factory'), ethers.ZeroAddress);
        const UF = (await uf.getAddress()).toLowerCase();
        const pairs = [];
        for (const [x, y] of [[0, 1], [1, 2]]) {
            await send(uf.createPair(ta[x], ta[y], ov()));
            const p = await uf.getPair(ta[x], ta[y]);
            await send(T[x].transfer(p, 10n ** 24n, ov())); await send(T[y].transfer(p, 2n * 10n ** 24n, ov()));
            const pc = new ethers.Contract(p, v2('UniswapV2Pair').abi, w);
            await send(pc.mint(w.address, ov()));
            // Real trades at the real 0.3% — the Swap+Sync history the empirical method reads.
            for (const amt of [10n ** 21n, 3n * 10n ** 21n, 7n * 10n ** 20n]) {
                const [r0, r1] = await pc.getReserves();
                const zeroIn = (await pc.token0()).toLowerCase() === ta[x].toLowerCase();
                const [rIn, rOut] = zeroIn ? [r0, r1] : [r1, r0];
                const out = amt * 997n * rOut / (rIn * 1000n + amt * 997n);
                await send(T[x].transfer(p, amt, ov()));
                await send(pc.swap(zeroIn ? 0n : out, zeroIn ? out : 0n, w.address, '0x', ov()));
            }
            pairs.push(p.toLowerCase());
        }
        // A factory whose pair hides its fee in storage and emits no Swap: nothing can resolve it.
        const MF = (await (await deploy(mk('Sink'))).getAddress()).toLowerCase();
        const mp = await deploy(art.MockPair, ta[0], ta[2], 30);
        await send(T[0].transfer(await mp.getAddress(), 10n ** 21n, ov())); await send(T[2].transfer(await mp.getAddress(), 10n ** 21n, ov()));
        await send(mp.sync(ov()));
        const MP = (await mp.getAddress()).toLowerCase();

        // Scratch repo: the sources, the chain registry, node_modules linked.
        fs.cpSync(path.join(ROOT, 'source'), path.join(scratch, 'source'), { recursive: true });
        fs.mkdirSync(path.join(scratch, 'conf'));
        fs.copyFileSync(path.join(ROOT, 'conf/@chains.json5'), path.join(scratch, 'conf/@chains.json5'));
        fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(scratch, 'package.json'));
        fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(scratch, 'node_modules'));
        const confFile = path.join(scratch, 'conf/katana.json5');
        const conf = `{\n  // scratch config for test-verify-fees-apply\n  chain: { host: '${RPC}' },\n  factories: {\n    v2: {\n      Uni: {   // finder said 0.25%\n        address: '${UF}',\n        fee: 0.0025,\n      },\n      Hidden: '${MF}',\n    },\n  },\n}\n`;
        fs.writeFileSync(confFile, conf);
        const blFile = path.join(scratch, 'conf/katana-blacklist.json5');
        fs.writeFileSync(blFile, `{\n  // keep this note\n  factories: [\n    { address:'0x${'e'.repeat(40)}' },\n  ],\n}\n`);
        const bl0 = fs.readFileSync(blFile, 'utf8');

        const { ArbitradeDB } = await import(path.join(scratch, 'source/util/db.ts'));
        fs.mkdirSync(path.join(scratch, 'db'));
        const dbFile = path.join(scratch, 'db/katana.sqlite');
        const db = new ArbitradeDB(dbFile);
        const sorted = (a, b) => a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
        db.insertPairs([
            ...pairs.map((p, i) => { const [t0, t1] = sorted(ta[i], ta[i + 1]); return { address: p, factory: UF, token0: t0, token1: t1, blockNumber: 1, fee: 0.0025 }; }),
            (() => { const [t0, t1] = sorted(ta[0], ta[2]); return { address: MP, factory: MF, token0: t0, token1: t1, blockNumber: 1, fee: 0.003 }; })(),
        ]);
        db.upsertReserves([...pairs, MP].map(p => ({ pair: p, reserves0: 10n ** 24n, reserves1: 10n ** 24n, blockNumber: 1 })));
        db.close();

        const run = (...extra) => {
            try {
                return execFileSync('node', ['--experimental-strip-types', '--no-warnings', path.join(scratch, 'source/verify-fees.ts'), 'katana', ...extra],
                    { cwd: scratch, env: { ...process.env, KATANA_RPC: RPC, ENVIO_API_TOKEN: '' }, encoding: 'utf8', timeout: 240_000 });
            } catch (e) { return `EXIT ${e.status}\n${e.stdout}\n${e.stderr}`; }
        };

        const report = run();
        ok(/Uni\s+MISMATCH\s+assumed=0\.0025\s+final=0\.003/.test(report), 'report: Uni is a MISMATCH, 0.0025 → 0.003', report.match(/Uni .*/)?.[0] ?? report.slice(-400));
        ok(/Hidden\s+(UNKNOWN|NO-SWAP)/.test(report), 'report: Hidden is unresolved', report.match(/Hidden .*/)?.[0] ?? '');
        ok(fs.readFileSync(confFile, 'utf8') === conf && fs.readFileSync(blFile, 'utf8') === bl0, 'without --apply nothing is written');

        const applied = run('--apply');
        const c2 = fs.readFileSync(confFile, 'utf8'), j2 = JSON5.parse(c2);
        ok(j2.factories.v2.Uni.fee === 0.003 && /finder said 0\.25%/.test(c2) && /verify-fees \d{4}-\d\d-\d\d: fee 0\.0025 → 0\.003 \(decompile|empirical/.test(c2),
            'conf: Uni fee is 0.003, with a dated note, old comment kept', applied.match(/fee\s+Uni.*/)?.[0] ?? applied.slice(-600));
        ok(j2.factories.v2.Hidden === MF, 'conf: Hidden is left in place');
        const db2 = new ArbitradeDB(dbFile);
        const rows = db2.db.prepare('SELECT address, fee FROM pairs WHERE factory = ?').all(UF);
        ok(rows.length === 2 && rows.every(r => r.fee === 0.003), 'DB: both Uni pair rows carry 0.003 (the evaluator prefers the row)', JSON.stringify(rows.map(r => r.fee)));
        ok(db2.db.prepare('SELECT fee FROM pairs WHERE address = ?').get(MP).fee === 0.003, 'DB: other factories untouched');
        db2.close();
        ok(fs.readFileSync(blFile, 'utf8') === bl0 && /left\s+Hidden: UNKNOWN, but nothing was read/.test(applied),
            'Hidden: nothing could be read (no swaps, no Claude) — held back, not blacklisted', applied.match(/left\s+Hidden.*/)?.[0]?.slice(0, 120) ?? '');

        const forced = run('--apply', '--blacklist-unread');
        const bl2 = fs.readFileSync(blFile, 'utf8'), b2 = JSON5.parse(bl2).factories;
        ok(b2.length === 2 && b2[1].address === MF && /verify-fees .* (UNKNOWN|NO-SWAP) \(1 pairs\)/.test(b2[1].reason) && /keep this note/.test(bl2),
            '--blacklist-unread: Hidden appended with the reason, the file note kept', b2[1]?.reason?.slice(0, 90) ?? forced.slice(-300));
        ok(/Next: yarn triangles katana/.test(applied) && /Next: yarn triangles katana/.test(forced), 'says what to run next');

        const again = run('--apply');
        ok(/Uni\s+MATCH/.test(again) && JSON5.parse(fs.readFileSync(blFile, 'utf8')).factories.length === 2, 'a second --apply: Uni now matches, Hidden is no longer audited (blacklisted)');
    }
} finally {
    anvil.kill();
    fs.rmSync(scratch, { recursive: true, force: true });
}

console.log(fails === 0 ? '\nALL VERIFY-FEES --APPLY CHECKS PASS' : `\n${fails} FAILED`);
process.exit(fails ? 1 : 0);
