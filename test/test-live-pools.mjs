// Exit pools read from the factories (source/liquidation/live-pools.ts), so a
// liquidator-only chain needs no scan: every lookup shape, fees, depth ranking
// and refresh, the merge with a pool DB, and an RPC failure. Starts its own anvil.
//
//   node test/compile.mjs   (once)
//   node --experimental-strip-types test/test-live-pools.mjs

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { ethers } from 'ethers';
import { LivePools } from '../source/liquidation/live-pools.ts';
import { RouteFinder } from '../source/liquidation/plan.ts';

const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (cond, what, got) => {
    if (cond) { pass++; console.log(`  ok   ${what}`); }
    else { fail++; console.log(`  FAIL ${what}${got !== undefined ? `  got ${JSON.stringify(got)}` : ''}`); }
};

const art = JSON.parse(fs.readFileSync(new URL('./artifacts.json', import.meta.url), 'utf8'));
const PORT = 8567, RPC = `http://127.0.0.1:${PORT}`;
const anvil = spawn('anvil', ['--port', String(PORT), '--silent']);
await sleep(1500);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-pools-'));

const provider = new ethers.JsonRpcProvider(RPC, undefined, { staticNetwork: true, cacheTimeout: -1 });
const signer = new ethers.NonceManager(new ethers.Wallet('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', provider));
const deploy = async (name, ...args) => {
    const c = await new ethers.ContractFactory(art[name].abi, art[name].bytecode, signer).deploy(...args);
    await c.waitForDeployment();
    return c;
};
const addr = c => c.target.toLowerCase();
const fac = (group, address, extra = {}) => ({
    group, name: group, address, deployBlock: 0, fee: undefined, stableFees: undefined, feeTarget: 'factory', feeArgSource: 'pair-address',
    feeFunction: 'pairFee', feeDivisor: 1e6, hasStableFlag: false, stableFunction: 'stable', poolEvent: undefined, callback: undefined, algebraVariant: undefined, abi: [], ...extra,
});
const A = '0x00000000000000000000000000000000000000a1', B = '0x00000000000000000000000000000000000000b2', C = '0x00000000000000000000000000000000000000c3';
const EXEC = '0x00000000000000000000000000000000000000e4';
const byAddress = (rows, a) => rows.find(r => r.address === a.toLowerCase());

try {
    const lookup = await deploy('MockLookupFactory');
    const F = await lookup.getAddress();
    const pair = (a, b, stable = false) => deploy('MockFlaggedPair', stable, a, b);
    const cl = l => deploy('MockLiquidityPool', l);

    console.log('\nevery lookup shape');
    {
        const v2 = await pair(1000n, 1000n), v2fee = await pair(2000n, 2000n), shadowStable = await pair(3000n, 3000n, true);
        const solVol = await pair(4000n, 4000n), solSt = await pair(5000n, 5000n, true);
        const velo = await pair(6000n, 6000n), v3 = await cl(7000n), spaced = await cl(8000n), alg = await cl(9000n);
        const sets = [
            lookup.setPair(A, B, v2), lookup.setSolidly(A, B, false, solVol), lookup.setSolidly(A, B, true, solSt),
            lookup.setVelo(A, B, false, velo), lookup.setTier(A, B, 500, v3), lookup.setSpacing(A, B, 200, spaced), lookup.setAlgebra(A, B, alg),
        ];
        for (const s of sets) await (await s).wait();
        const each = async (f, n) => { const l = new LivePools(provider, [f]); await l.load([[A, B]]); ok(l.rows(A, B).length === n, `${f.group}${f.poolEvent ? `/${f.poolEvent}` : ''}: ${n} pool(s)`, l.rows(A, B)); return l.rows(A, B); };
        const r2 = await each(fac('v2', F, { fee: 0.003 }), 1);
        ok(r2[0].address === addr(v2) && r2[0].kind === 'v2' && r2[0].fee === 0.003 && r2[0].depth === 1e6, 'v2: address, kind, conf fee, reserve product', r2[0]);
        const sol = await each(fac('solidly', F), 2);
        ok(byAddress(sol, solSt.target).stable === 1 && byAddress(sol, solVol.target).stable === 0, 'solidly: stable flag from the lookup', sol);
        ok(byAddress(sol, solVol.target).fee === 0.0025, 'solidly: per-pair fee from the factory, through feeDivisor', sol);
        const whale = await each(fac('solidly', F, { stableFees: { stable: 0.0004, volatile: 0.0025 } }), 2);
        ok(byAddress(whale, solSt.target).fee === 0.0004 && byAddress(whale, solVol.target).fee === 0.0025, 'solidly: stableFees applied by pool type', whale);
        await each(fac('solidly', F, { poolEvent: 'velodrome', fee: 0.003 }), 1);
        const r3 = await each(fac('v3', F), 1);
        ok(r3[0].kind === 'v3' && r3[0].fee === 0.0005 && r3[0].depth === 7000, 'v3: tier as the fee, liquidity as depth', r3[0]);
        const rs = await each(fac('v3', F, { poolEvent: 'tickspacing' }), 1);
        ok(rs[0].address === addr(spaced), 'v3/tickspacing: the int24 getPool', rs[0]);
        await each(fac('algebra', F), 1);
        const shadow = await lookupShadow(v2fee, shadowStable);
        ok(byAddress(shadow, shadowStable.target)?.stable === 1 && byAddress(shadow, v2fee.target)?.stable === 0, 'v2fee + hasStableFlag: stable() read from the pair', shadow);
    }
    async function lookupShadow(vol, st) {
        const f2 = await deploy('MockLookupFactory');
        await (await f2.setPair(A, C, vol)).wait();
        await (await f2.setSolidly(A, C, true, st)).wait();
        const l = new LivePools(provider, [fac('v2fee', await f2.getAddress(), { hasStableFlag: true })]);
        await l.load([[A, C]]);
        return l.rows(A, C);
    }

    console.log('\nwhat gets left out');
    {
        const empty = new LivePools(provider, [fac('v2', F, { fee: 0.003 })]);
        await empty.load([[B, C]]);
        ok(empty.rows(B, C).length === 0, 'no pool: the zero address is not a pool');
        const missing = new LivePools(provider, [fac('v2', '0x00000000000000000000000000000000000000d5', { fee: 0.003 })]);
        await missing.load([[A, B]]);
        ok(missing.rows(A, B).length === 0, 'a factory address with no code finds nothing, without an error');
        const f = await deploy('MockLookupFactory');
        const drained = await pair(0n, 0n);
        await (await f.setPair(A, B, drained)).wait();
        const l = new LivePools(provider, [fac('v2', await f.getAddress(), { fee: 0.003 })]);
        await l.load([[A, B]]);
        ok(l.rows(A, B).length === 0, 'a drained pool is not an exit', l.rows(A, B));
        const noFee = await deploy('MockLookupFactory');
        const p = await pair(10n, 10n);
        await (await noFee.setPair(A, B, p)).wait();
        const cfg = { chain: {}, factories: [fac('v2fee', await noFee.getAddress(), { feeFunction: 'noSuchFee' })] };
        const live = new LivePools(provider, cfg.factories);
        const rf = new RouteFinder(cfg, path.join(dir, 'none.sqlite'), [], { live });
        ok((await rf.routes(A, B, EXEC)).length === 0, 'an unknown V2 fee keeps the pool out of the routes');
    }

    console.log('\nroutes with no DB');
    const deep = await pair(10n ** 24n, 10n ** 24n), dust = await pair(10n ** 6n, 10n ** 6n), hubLeg = await pair(10n ** 21n, 10n ** 21n);
    const f = await deploy('MockLookupFactory'), f2 = await deploy('MockLookupFactory');
    await (await f.setPair(A, B, dust)).wait();
    await (await f2.setPair(A, B, deep)).wait();
    await (await f.setPair(A, C, hubLeg)).wait();
    await (await f.setPair(C, B, await pair(10n ** 21n, 10n ** 21n))).wait();
    const factories = [fac('v2', await f.getAddress(), { fee: 0.003 }), fac('v2', await f2.getAddress(), { fee: 0.003 })];
    const cfg = { chain: {}, factories };
    {
        const live = new LivePools(provider, factories);
        const rf = new RouteFinder(cfg, path.join(dir, 'none.sqlite'), [C], { live });
        ok(rf.available, 'available with no DB');
        const routes = await rf.routes(A, B, EXEC);
        ok(routes[0].hops[0].pair.toLowerCase() === addr(deep), 'deepest pool first, by live depth', routes.map(r => r.label));
        ok(routes[0].hops[0].feePpm === 3000 && routes[0].hops[0].kind === 0, 'hop carries the fee and kind', routes[0].hops[0]);
        const two = routes.find(r => r.hops.length === 2);
        ok(two && two.hops[0].recipient.toLowerCase() === two.hops[1].pair.toLowerCase(), 'two hops via the hub, chained', two);

        await (await deep.setReserves(1000n, 1000n)).wait();
        await (await dust.setReserves(10n ** 24n, 10n ** 24n)).wait();
        const cached = await rf.routes(A, B, EXEC);
        ok(cached[0].hops[0].pair.toLowerCase() === addr(deep), 'depth is kept for its window', cached[0].label);
        const quick = new LivePools(provider, factories, { depthMs: 0 });
        await quick.load([[A, B]]);
        await (await dust.setReserves(10n ** 6n, 10n ** 6n)).wait();
        await (await deep.setReserves(10n ** 24n, 10n ** 24n)).wait();
        await quick.load([[A, B]]);
        ok(byAddress(quick.rows(A, B), deep.target).depth > byAddress(quick.rows(A, B), dust.target).depth, 'and re-read after it: ranking follows the pools', quick.rows(A, B));
    }

    console.log('\nwith a pool DB');
    {
        const dbFile = path.join(dir, 'chain.sqlite');
        const db = new Database(dbFile);
        db.exec(`CREATE TABLE pairs (address TEXT, factory TEXT, token0 TEXT, token1 TEXT, kind TEXT, fee REAL, stable INTEGER);
                 CREATE TABLE reserves (pair TEXT, reserves0 TEXT, reserves1 TEXT);
                 CREATE TABLE pool_state (pool TEXT, liquidity TEXT);`);
        const old = '0x00000000000000000000000000000000000000f6';    // only the DB knows it
        db.prepare('INSERT INTO pairs VALUES (?,?,?,?,?,?,?)').run(old, factories[0].address, A, B, 'v2', 0.003, 0);
        db.prepare('INSERT INTO pairs VALUES (?,?,?,?,?,?,?)').run(addr(deep), factories[1].address, A, B, 'v2', 0.0035, 0);
        db.prepare('INSERT INTO reserves VALUES (?,?,?)').run(addr(deep), '1', '1');     // stale: live says deep
        db.close();
        const live = new LivePools(provider, factories);
        const rf = new RouteFinder(cfg, dbFile, [], { live });
        const routes = await rf.routes(A, B, EXEC);
        const pools = routes.map(r => r.hops[0].pair.toLowerCase());
        ok(pools.includes(old) && pools.includes(addr(dust)) && pools.includes(addr(deep)), 'pools from both sources', pools);
        ok(pools[0] === addr(deep), 'a pool in both ranks by its live depth, not the stale DB reserves', pools);
        ok(routes[0].hops[0].feePpm === 3500, 'and keeps the DB fee (verify-fees / conf raises)', routes[0].hops[0]);
    }

    console.log('\nRPC failure');
    {
        let down = false;
        const flaky = new Proxy(provider, { get(t, k) {
            if (k === 'call' && down) return async () => { throw new Error('connection refused'); };
            const v = t[k]; return typeof v === 'function' ? v.bind(t) : v;
        } });
        const live = new LivePools(flaky, factories, { discoveryMs: 0, depthMs: 0 });
        await live.load([[A, B]]);
        const before = live.rows(A, B).length;
        down = true;
        await live.load([[A, B]]);
        ok(before === 2 && live.rows(A, B).length === 2, 'a failed refresh does not throw and keeps what it knew', live.rows(A, B));
        const fresh = new LivePools(flaky, factories);
        await fresh.load([[A, B]]);
        ok(fresh.rows(A, B).length === 0, 'a failed first lookup finds nothing');
        down = false;
        await fresh.load([[A, B]]);
        ok(fresh.rows(A, B).length === 2, 'and is not remembered as "no pools"', fresh.rows(A, B));
    }

    console.log('\nsimultaneous attempts');
    {
        let calls = 0;
        const counted = new Proxy(provider, { get(t, k) {
            if (k === 'call') return (...a) => { calls++; return t.call(...a); };
            const v = t[k]; return typeof v === 'function' ? v.bind(t) : v;
        } });
        const live = new LivePools(counted, factories);
        await Promise.all(Array.from({ length: 5 }, () => live.load([[A, B]])));
        const n = calls;
        await live.load([[A, B]]);
        ok(n === 4 && calls === n, 'five at once cost one discovery (2 lookups, 2 depth reads, no Multicall3 here); a repeat costs none', { n, calls });
    }
    console.log('\nmixed-case and warm');
    {
        const live = new LivePools(provider, factories);
        await live.load([[A.replace('a1', 'A1'), B.replace('b2', 'B2')]]);     // a bad checksum, as ethers sees it
        ok(live.rows(A, B).length === 2, 'mixed-case addresses with a bad checksum still load', live.rows(A, B));

        let calls = 0;
        const counted = new Proxy(provider, { get(t, k) {
            if (k === 'call') return (...a) => { calls++; return t.call(...a); };
            const v = t[k]; return typeof v === 'function' ? v.bind(t) : v;
        } });
        const rf = new RouteFinder(cfg, path.join(dir, 'none.sqlite'), [C, B], { live: new LivePools(counted, factories) });
        await rf.warm([A, C]);
        const n = calls;
        const routes = await rf.routes(A, C, EXEC);
        ok(routes.length > 0 && calls === n, 'warmed legs cost an attempt no reads at all', { routes: routes.length, extra: calls - n });
    }
    provider.destroy();
} finally {
    anvil.kill();
    fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${fail ? `${fail} FAILED, ` : ''}${pass} ok`);
if (fail) process.exit(1);
console.log('all passed');
