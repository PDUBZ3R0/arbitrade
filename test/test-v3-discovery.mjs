// V3 factory discovery, verification and scanning, against the real
// UniswapV3Factory / UniswapV3Pool bytecode (v3-core 1.0.0) on a local anvil.
//
//   1. parseCreationLog decodes real PoolCreated logs to exactly the pool
//      factory.getPool() reports, with the right fee tier and tick spacing.
//   2. The tick-spacing-keyed and Algebra event shapes decode too (emitted by
//      stub factories pointing at real pools).
//   3. verifyV3Factory, by measurement: finds the event shape, reads pool
//      state, checks the ticks() layout, finds uniswapV3SwapCallback in the
//      pool bytecode, and confirms YoBatches2.getV3State reads the pool.
//      Algebra-shaped and event-less addresses are refused.
//   4. scanFactory with a v3-group factory stores every pool as kind 'v3'
//      with fee and tick spacing, for both event shapes, and the default
//      reserves query (balanceOf-based) does NOT return them.
//
//   npm i -D @uniswap/v3-core@1.0.1 solc@0.8.24     (one-time)
//   node test/test-v3-discovery.mjs                 (anvil on PATH)

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ethers } from 'ethers';
import { parseCreationLog, POOL_CREATED_V3_TOPIC } from '../source/util/pool-events.ts';
import { verifyV3Factory, findCallbackSelectors } from '../source/util/verify-v3-factory.ts';
import { scanFactory } from '../source/scanner/pairs.ts';
import { ArbitradeDB } from '../source/util/db.ts';
import { getSqrtRatioAtTick } from '../source/util/calculus-v3.js';

const require = createRequire(import.meta.url);
const here = (p) => new URL(p, import.meta.url);
let fails = 0;
const ok = (c, l, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${l} ${extra}`); if (!c) fails++; };

const STUBS = `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
contract TsFactoryStub {
    event PoolCreated(address indexed token0, address indexed token1, int24 indexed tickSpacing, address pool);
    function emitPool(address a, address b, int24 ts, address p) external { emit PoolCreated(a, b, ts, p); }
}
contract AlgebraFactoryStub {
    event Pool(address indexed token0, address indexed token1, address pool);
    function emitPool(address a, address b, address p) external { emit Pool(a, b, p); }
}`;
const solc = require('solc');
const out = JSON.parse(solc.compile(JSON.stringify({
    language: 'Solidity',
    sources: {
        'Stubs.sol': { content: STUBS },
        'YoBatches2.sol': { content: fs.readFileSync(here('../contracts/YoBatches2.sol'), 'utf8') },
        'V3Harness.sol': { content: fs.readFileSync(here('./v3-golden/V3Harness.sol'), 'utf8') },
    },
    settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
})));
for (const e of out.errors ?? []) if (e.severity === 'error') { console.error(e.formattedMessage); process.exit(1); }
const pick = (f, n) => ({ abi: out.contracts[f][n].abi, bytecode: '0x' + out.contracts[f][n].evm.bytecode.object });
const art = n => require(`@uniswap/v3-core/artifacts/contracts/${n}.sol/${n}.json`);
const A = {
    Ts: pick('Stubs.sol', 'TsFactoryStub'), Alg: pick('Stubs.sol', 'AlgebraFactoryStub'),
    Yo: pick('YoBatches2.sol', 'YoBatches2'), Tok: pick('V3Harness.sol', 'Tok'), Harness: pick('V3Harness.sol', 'Harness'),
    F: art('UniswapV3Factory'), P: art('UniswapV3Pool'),
};

const PORT = 8549;
const anvil = spawn('anvil', ['--port', String(PORT), '--disable-code-size-limit', '--gas-limit', '3000000000', '--silent']);
await new Promise(r => setTimeout(r, 1500));
const provider = new ethers.JsonRpcProvider(`http://127.0.0.1:${PORT}`, undefined, { cacheTimeout: -1, staticNetwork: true });
const signer = await provider.getSigner(0);
let nonce = await provider.getTransactionCount(await signer.getAddress());
const ov = () => ({ nonce: nonce++, gasLimit: 30_000_000n });
const send = async (p) => (await p).wait();
const deploy = async (a) => { const c = await new ethers.ContractFactory(a.abi, a.bytecode, signer).deploy(ov()); await c.waitForDeployment(); return c; };

const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'v3disc-'));
try {
    const factory = await deploy(A.F);
    const FA = (await factory.getAddress()).toLowerCase();
    await send(factory.enableFeeAmount(100, 1, ov()));
    const harness = await deploy(A.Harness);
    const yo = await deploy(A.Yo);
    const tsStub = await deploy(A.Ts), algStub = await deploy(A.Alg);

    // Pools: three token pairs x several fee tiers, so one token pair has
    // several pools from ONE factory (the case the enumerator fix is for).
    const TIERS = [[100, 1], [500, 10], [3000, 60], [10000, 200]];
    const pools = [];
    for (let k = 0; k < 3; k++) {
        const ta = await deploy(A.Tok), tb = await deploy(A.Tok);
        let [t0, t1] = [(await ta.getAddress()).toLowerCase(), (await tb.getAddress()).toLowerCase()];
        if (BigInt(t0) > BigInt(t1)) [t0, t1] = [t1, t0];
        for (const [fee, spacing] of TIERS.slice(0, 2 + k)) {
            await send(factory.createPool(t0, t1, fee, ov()));
            const addr = (await factory.getPool(t0, t1, fee)).toLowerCase();
            const pool = new ethers.Contract(addr, A.P.abi, signer);
            const tick = 1000 * (k + 1);
            const s0 = getSqrtRatioAtTick(tick);
            await send(pool.initialize(s0 + 12345n, ov()));
            const c = Math.floor(tick / spacing) * spacing;
            await send(harness.mint(addr, c - 50 * spacing, c + 50 * spacing, 10n ** 18n, ov()));
            await send(harness.mint(addr, c - 5 * spacing, c + 8 * spacing, 10n ** 17n, ov()));
            pools.push({ addr, t0, t1, fee, spacing });
        }
    }
    // Stub factories re-announce real pools in the other two shapes.
    for (const p of pools.slice(0, 4)) await send(tsStub.emitPool(p.t0, p.t1, p.spacing, p.addr, ov()));
    for (const p of pools.slice(0, 2)) await send(algStub.emitPool(p.t0, p.t1, p.addr, ov()));

    console.log('1. real PoolCreated logs decode to the factory\'s own pools');
    {
        const logs = await provider.getLogs({ address: FA, topics: [POOL_CREATED_V3_TOPIC], fromBlock: 0 });
        const parsed = logs.map(l => parseCreationLog([...l.topics], l.data, 'v3'));
        ok(logs.length === pools.length, 'one log per pool', `n=${logs.length}`);
        const byAddr = new Map(pools.map(p => [p.addr, p]));
        const good = parsed.filter(x => {
            const p = byAddr.get(x.pair);
            return p && x.token0 === p.t0 && x.token1 === p.t1 && x.feePips === p.fee && x.tickSpacing === p.spacing;
        });
        ok(good.length === pools.length, 'pool, tokens, fee tier and tick spacing all match getPool()');
    }

    console.log('\n2. the other shapes decode too');
    {
        const tsLogs = await provider.getLogs({ address: await tsStub.getAddress(), fromBlock: 0 });
        const ts = tsLogs.map(l => parseCreationLog([...l.topics], l.data, 'v3ts'));
        ok(ts.every((x, i) => x.pair === pools[i].addr && x.tickSpacing === pools[i].spacing && x.feePips === null),
           'tick-spacing-keyed PoolCreated: pool + spacing, fee left to the pool');
        const algLogs = await provider.getLogs({ address: await algStub.getAddress(), fromBlock: 0 });
        const al = algLogs.map(l => parseCreationLog([...l.topics], l.data, 'algebra'));
        ok(al.every((x, i) => x.pair === pools[i].addr), 'Algebra Pool(): pool address');
        ok(parseCreationLog([POOL_CREATED_V3_TOPIC, '0x' + '0'.repeat(64)], '0x', 'v3') === null,
           'a truncated log is rejected, not decoded to a garbage address');
    }

    const chain = { id: 31337, contract: await yo.getAddress() };

    console.log('\n3. verifyV3Factory, by measurement');
    {
        const v = await verifyV3Factory('anvil', FA, undefined, { provider, chain });
        for (const n of v.notes) console.log('       ' + n);
        ok(v.usable, 'UniswapV3Factory is usable');
        ok(v.poolEvent === 'uniswap' && v.callback === 'uniswapV3SwapCallback', 'poolEvent uniswap, callback uniswapV3SwapCallback',
           `(${v.poolEvent}, ${v.callback})`);
        ok(v.lensChecked, 'YoBatches2.getV3State reads its pools');
        ok(v.configSnippet.includes('factories["v3"]') && v.configSnippet.includes('callback: "uniswapV3SwapCallback"'),
           'emits a v3 config snippet');

        const vts = await verifyV3Factory('anvil', await tsStub.getAddress(), undefined, { provider, chain });
        ok(vts.usable && vts.poolEvent === 'tickspacing', 'tick-spacing-keyed factory: usable, poolEvent tickspacing');

        const valg = await verifyV3Factory('anvil', await algStub.getAddress(), undefined, { provider, chain });
        ok(!valg.usable && valg.family === 'algebra', 'Algebra-shaped factory: recognised, refused');

        const vnone = await verifyV3Factory('anvil', await harness.getAddress(), undefined, { provider, chain });
        ok(!vnone.usable && vnone.layout === null, 'a contract with no creation events: refused');

        const poolCode = await provider.getCode(pools[0].addr);
        ok(JSON.stringify(findCallbackSelectors(poolCode)) === '["uniswapV3SwapCallback"]',
           'pool bytecode: exactly one known callback selector');
        // (Not the factory: it embeds the pool's creation code, selector and all.)
        ok(findCallbackSelectors(await provider.getCode(await yo.getAddress())).length === 0, 'unrelated contract (YoBatches2): none');
    }

    console.log('\n4. scanFactory stores v3 pools as kind v3');
    {
        const db = new ArbitradeDB(path.join(tmpdir, 'scan.db'));
        const base = { deployBlock: 1, fee: undefined, stableFees: undefined, feeTarget: 'factory', feeArgSource: 'pair-address',
                       feeFunction: 'pairFee', feeDivisor: 10000, hasStableFlag: false, callback: 'uniswapV3SwapCallback', abi: [] };
        const quiet = { forceTransport: 'rpc', fromBlock: 0, chunkSize: 1000 };
        const n1 = await scanFactory(provider, db, { ...base, group: 'v3', name: 'UniV3', address: FA, poolEvent: 'uniswap' }, quiet);
        const n2 = await scanFactory(provider, db, { ...base, group: 'v3', name: 'TsStub', address: (await tsStub.getAddress()).toLowerCase(), poolEvent: 'tickspacing' }, quiet);
        ok(n1 === pools.length && n2 === 4, 'every pool found', `uniswap=${n1} tickspacing=${n2}`);

        const rows = db.db.prepare(`SELECT address, factory, token0, token1, fee, kind, tickSpacing FROM pairs WHERE factory = ?`).all(FA);
        const byAddr = new Map(pools.map(p => [p.addr, p]));
        ok(rows.every(r => r.kind === 'v3' && byAddr.get(r.address)?.spacing === r.tickSpacing
                          && Math.abs(r.fee - byAddr.get(r.address).fee / 1e6) < 1e-12),
           'kind v3, fee as a fraction of the tier, tickSpacing stored');
        const tsRows = db.db.prepare(`SELECT fee, kind, tickSpacing FROM pairs WHERE factory = ?`).all((await tsStub.getAddress()).toLowerCase());
        ok(tsRows.every(r => r.kind === 'v3' && r.fee === null && r.tickSpacing > 0),
           'tick-spacing shape: fee NULL until reserves time reads pool.fee()');

        ok(db.getPairsForReservesFetch().length === 0, 'default reserves query excludes v3 pools (balanceOf would misprice them)');
        ok(db.getPairsForReservesFetch({ kinds: ['v3'] }).length === pools.length + 4, 'and returns them when asked for kind v3');

        const again = await scanFactory(provider, db, { ...base, group: 'v3', name: 'UniV3', address: FA, poolEvent: 'uniswap' }, quiet);
        ok(again === 0, 'rescan is idempotent');
        db.close();
    }

    console.log('\n5. existing databases migrate in place');
    {
        const legacy = path.join(tmpdir, 'legacy.db');
        const Database = require('better-sqlite3');
        const raw = new Database(legacy);
        raw.exec(`CREATE TABLE pairs (address TEXT NOT NULL, factory TEXT NOT NULL, token0 TEXT NOT NULL, token1 TEXT NOT NULL,
                  blockNumber INTEGER NOT NULL, PRIMARY KEY (factory, address));
                  INSERT INTO pairs VALUES ('0xaa', '0xff', '0x01', '0x02', 5);`);
        raw.close();
        const db = new ArbitradeDB(legacy);
        const r = db.db.prepare('SELECT kind, tickSpacing FROM pairs').get();
        ok(r.kind === 'v2' && r.tickSpacing === null, 'old rows become kind v2');
        db.close();
    }
} finally {
    anvil.kill();
    fs.rmSync(tmpdir, { recursive: true, force: true });
}

console.log(fails === 0 ? '\nALL V3 DISCOVERY CHECKS PASS' : `\n${fails} FAILED`);
process.exit(fails ? 1 : 0);
