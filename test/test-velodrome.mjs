// Velodrome V2 / Aerodrome V2 support, end to end on a local anvil.
//
// These factories announce pools with
//     PoolCreated(address indexed token0, address indexed token1, bool indexed stable, address pool, uint256)
// — not Solidly's PairCreated — so before this, find-factories never saw
// Aerodrome on Base or Velodrome on Optimism at all. The pools themselves are
// ordinary Solidly pools. Checked here, against mocks that copy the parts of
// velodrome-finance/contracts the bot depends on (test/Mocks.sol):
//
//   1. parseCreationLog reads the event: pool from data[0], stable from topic3.
//   2. scanFactory (group solidly, poolEvent velodrome) stores every pool with
//      its stable flag.
//   3. fetchReserves reads fees with factory.getFee(pool, stable) / 10000:
//      volatile default, stable default, a per-pool custom fee, and the 420
//      zero-fee sentinel. Volatile pools enumerate; stable pools do not.
//   4. The interface probe recognises the factory as the "PoolFactory" pattern.
//   5. FlashArbExecutor trades through a Velodrome pool: uint256 getReserves(),
//      fee moved out of the pool before the K check, no hook call.
//
//   npm i -D solc@0.8.24 ; node test/compile.mjs ; node test/test-velodrome.mjs

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ethers } from 'ethers';
import { parseCreationLog, POOL_CREATED_VELODROME_TOPIC, TOPIC_BY_LAYOUT } from '../source/util/pool-events.ts';
import { scanFactory } from '../source/scanner/pairs.ts';
import { fetchReserves } from '../source/reserves/fetcher.ts';
import { ArbitradeDB } from '../source/util/db.ts';
import { probeFactoryBestMatch } from '../source/util/interface-probe.ts';
import { lookupDexPattern } from '../source/util/dex-patterns.ts';

const require = createRequire(import.meta.url);
let fails = 0;
const ok = (c, l, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${l} ${extra}`); if (!c) fails++; };

const art = JSON.parse(fs.readFileSync(new URL('./artifacts.json', import.meta.url), 'utf8'));
{
    const solc = require('solc');
    const out = JSON.parse(solc.compile(JSON.stringify({
        language: 'Solidity',
        sources: {
            'YoBatches2.sol': { content: fs.readFileSync(new URL('../contracts/YoBatches2.sol', import.meta.url), 'utf8') },
            'YoBatches3.sol': { content: fs.readFileSync(new URL('../contracts/YoBatches3.sol', import.meta.url), 'utf8') },
        },
        settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
    })));
    const c = out.contracts['YoBatches3.sol'].YoBatches3;
    art.YoBatches2 = { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object };
}

const PORT = 8552, URL_ = `http://127.0.0.1:${PORT}`;
const anvil = spawn('anvil', ['--port', String(PORT), '--silent']);
await new Promise(r => setTimeout(r, 1500));
const provider = new ethers.JsonRpcProvider(URL_, undefined, { cacheTimeout: -1, staticNetwork: true });
const signer = await provider.getSigner(0);
let nonce = await provider.getTransactionCount(await signer.getAddress());
const ov = () => ({ nonce: nonce++, gasLimit: 30_000_000n });
const deploy = async (a, ...args) => { const c = await new ethers.ContractFactory(a.abi, a.bytecode, signer).deploy(...args, ov()); await c.waitForDeployment(); return c; };
const send = async (p) => (await p).wait();
const E = (n) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;
const quiet = async (fn) => {
    const w = process.stdout.write.bind(process.stdout), l = console.log;
    process.stdout.write = () => true; console.log = () => {};
    try { return await fn(); } finally { process.stdout.write = w; console.log = l; }
};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'velo-'));
const dbFile = path.join(tmp, 'velo.db');

try {
    // Multicall3 at its canonical address (the fee metadata pass uses it).
    const mc = await deploy(art.Multicall3Min);
    await provider.send('anvil_setCode', ['0xcA11bde05977b3631167028862bE2a173976CA11', await provider.getCode(await mc.getAddress())]);
    const yo = await deploy(art.YoBatches2);

    const toks = [];
    for (const n of ['R', 'A', 'B', 'C', 'D']) toks.push(await deploy(art.MockToken, n, 0));
    const [R, A, B, C, D] = await Promise.all(toks.map(async t => (await t.getAddress()).toLowerCase()));
    const tok = new Map([[R, toks[0]], [A, toks[1]], [B, toks[2]], [C, toks[3]], [D, toks[4]]]);

    const vf = await deploy(art.MockVeloFactory);
    const VF = (await vf.getAddress()).toLowerCase();

    console.log('1. the PoolCreated(…, bool indexed stable, …) event');
    const created = {};
    for (const [name, a, b, stable] of [['RA', R, A, false], ['RC', R, C, true], ['AC', A, C, false], ['AD', A, D, false]]) {
        const rc = await send(vf.createPool(a, b, stable, ov()));
        const lg = rc.logs.find(l => l.topics[0] === POOL_CREATED_VELODROME_TOPIC);
        const p = parseCreationLog([...lg.topics], lg.data, 'velodrome');
        created[name] = { ...p, expectStable: stable };
    }
    const vfIface = new ethers.Interface(art.MockVeloFactory.abi);
    ok(POOL_CREATED_VELODROME_TOPIC === vfIface.getEvent('PoolCreated').topicHash && TOPIC_BY_LAYOUT.velodrome === POOL_CREATED_VELODROME_TOPIC,
       'topic = keccak("PoolCreated(address,address,bool,address,uint256)")');
    const all = await Promise.all([0, 1, 2, 3].map(i => vf.allPools(i)));
    ok(Object.values(created).every((p, i) => p.pair === all[i].toLowerCase() && p.stable === p.expectStable),
       'pool address from data[0], stable from topic3, for all 4 pools');

    // Liquidity: RA volatile 1:2, RC stable 1:1, AC volatile, AD volatile with
    // a custom fee, and a second R/A route through V2 MockPairs for the arb.
    const pool = (n) => new ethers.Contract(created[n].pair, art.MockVeloPool.abi, signer);
    const seed = async (n, x, amtX, y, amtY) => {
        await send(tok.get(x).mint(created[n].pair, E(amtX), ov()));
        await send(tok.get(y).mint(created[n].pair, E(amtY), ov()));
        await send(pool(n).sync(ov()));
    };
    await seed('RA', R, 1000, A, 2000);
    await seed('RC', R, 1000, C, 1000);
    await seed('AC', A, 2000, C, 1000);
    await seed('AD', A, 1000, D, 1000);
    await send(vf.setCustomFee(created.AD.pair, 100, ov()));          // 1%
    await send(vf.setCustomFee(created.AC.pair, 420, ov()));          // zero-fee sentinel

    console.log('\n2. scan: solidly group with poolEvent "velodrome"');
    const factory = {
        group: 'solidly', name: 'PoolFactory_' + VF.slice(2, 10), address: VF, deployBlock: 1,
        fee: undefined, stableFees: undefined, feeTarget: 'factory', feeArgSource: 'pair-address-stable',
        feeFunction: 'getFee', feeDivisor: 10000, hasStableFlag: false, poolEvent: 'velodrome', callback: undefined, abi: [],
    };
    await quiet(async () => {
        const db = new ArbitradeDB(dbFile);
        db.upsertFactory({ address: VF, name: factory.name, type: 'solidly', fee: undefined, deployBlock: 1 });
        await scanFactory(provider, db, factory, { forceTransport: 'rpc', fromBlock: 0 });
        db.close();
    });
    {
        const db = new ArbitradeDB(dbFile);
        const rows = db.db.prepare('SELECT address, stable, kind FROM pairs WHERE factory = ?').all(VF);
        const byAddr = new Map(rows.map(r => [r.address, r]));
        ok(rows.length === 4 && Object.values(created).every(p => byAddr.get(p.pair)?.stable === (p.expectStable ? 1 : 0)),
           'all 4 pools stored, stable flags from the event', `${rows.length} rows`);
        db.close();
    }

    console.log('\n3. reserves: fee = factory.getFee(pool, stable) / 10000');
    const cfg = {
        raw: {}, chain: { name: 'Anvil', label: 'anvil', id: 31337, host: URL_, contract: await yo.getAddress(), token: R, currency: 'R' },
        factories: [factory], flashloan: { premium: 0.0005, tokens: [{ symbol: 'R', address: R, decimals: 18 }] },
        evaluator: {}, reserves: {},
    };
    const fr = await quiet(() => fetchReserves(cfg, dbFile, {}));
    ok(fr.errors.length === 0, 'no fetch errors', fr.errors.join('; '));
    {
        const db = new ArbitradeDB(dbFile);
        const fee = (n) => db.db.prepare('SELECT fee FROM pairs WHERE address = ?').get(created[n].pair).fee;
        ok(fee('RA') === 0.003, 'volatile default 30 bps -> 0.003', String(fee('RA')));
        ok(fee('RC') === 0.0005, 'stable default 5 bps -> 0.0005', String(fee('RC')));
        ok(fee('AD') === 0.01, 'custom fee 100 bps -> 0.01', String(fee('AD')));
        ok(fee('AC') === 0, 'zero-fee sentinel 420 -> 0', String(fee('AC')));
        const live = db.getPairsForEnumeration({}).map(r => r.pair);
        ok(live.includes(created.RA.pair) && !live.includes(created.RC.pair), 'volatile pools enumerate, the stable pool does not');
        db.close();
    }

    console.log('\n4. interface probe recognises the factory');
    {
        const m = await probeFactoryBestMatch(provider, VF,
            ['RA', 'AD', 'RC'].map(n => ({ pair: created[n].pair, stable: created[n].expectStable })), 'solidly');
        ok(m?.patternName === 'PoolFactory' && m.pattern.poolEvent === 'velodrome', 'matched pattern "PoolFactory"',
           m ? `${m.patternName} [${m.confidence}] ${m.sampleFeesAdjusted.join('/')}` : 'no match');
        ok(lookupDexPattern('PoolFactory')?.feeArgSource === 'pair-address-stable', 'pattern carries feeArgSource pair-address-stable');
    }

    console.log('\n5. the executor trades through a Velodrome pool');
    {
        // R -> A on the Velodrome volatile pool (1 R = 2 A), A -> R back on a
        // V2 MockPair priced 5% richer in R.
        const back = await deploy(art.MockPair, A, R, 30);
        const BACK = (await back.getAddress()).toLowerCase();
        await send(tok.get(A).mint(BACK, E(2000), ov()));
        await send(tok.get(R).mint(BACK, E(1050), ov()));
        await send(back.sync(ov()));
        const aave = await deploy(art.MockAavePool, 5n);
        await send(tok.get(R).mint(await aave.getAddress(), E(1e6), ov()));
        const exec = await deploy(art.FlashArbExecutor, ethers.ZeroAddress);
        const EX = await exec.getAddress();
        const BORROW = E(10);
        const hops = [[created.RA.pair, R, 3000, BACK, 0], [BACK, A, 3000, EX, 0]];
        const before = await tok.get(R).balanceOf(EX);
        let rc, err;
        try { rc = await send(exec.executeArbFrom(0, await aave.getAddress(), R, BORROW, 0n, hops, ov())); }
        catch (e) { err = e.shortMessage ?? e.message; nonce = await provider.getTransactionCount(await signer.getAddress()); }
        const after = await tok.get(R).balanceOf(EX);
        ok(!!rc && rc.status === 1 && after > before, 'flash arb through the Velodrome pool settles with a profit',
           rc ? `profit ${ethers.formatEther(after - before)} R` : err);
        const [r0, r1] = await pool('RA').getReserves();
        const [t0] = [await pool('RA').token0()];
        const b0 = await tok.get(t0.toLowerCase()).balanceOf(created.RA.pair);
        ok(r0 === b0, 'pool reserves = balances after the swap (fee moved out before the K check)');
        const feesHeld = await tok.get(R).balanceOf(VF);
        ok(feesHeld > 0n, 'and the input-side fee went to the factory, as on Velodrome', ethers.formatEther(feesHeld));
    }
} finally {
    anvil.kill();
}

console.log(fails === 0 ? '\nALL VELODROME CHECKS PASS' : `\n${fails} FAILED`);
process.exit(fails ? 1 : 0);
