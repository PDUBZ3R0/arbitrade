// Step 3 end to end: scan -> reserves -> triangles -> evaluate with real
// Uniswap V3 pools AND real Uniswap V2 pairs on a local anvil.
//
//   1. fetchReserves stores v3 pool state that matches the pool (price, tick,
//      liquidity, fee, every initialized tick in the window) and writes VIRTUAL
//      reserves L/sqrtP, L*sqrtP; V2 pairs still get their balances.
//   2. enumerateTriangles includes v3 pools — including a 2-hop between two
//      fee tiers of the SAME factory, and V2<->V3 mixed cycles.
//   3. evaluateTriangles scores cycles with v3 hops on tick-aware math: the
//      float profit it reports matches an exact BigInt walk (v3_swap_exact,
//      itself bit-exact vs the pool bytecode) at the same size, and the size
//      it picks is the exact optimum within the tolerance of integer rounding.
//   4. Nothing with a v3 hop can reach execution: executableOnly drops them,
//      the hot index drops them, and V2-only candidates are unaffected.
//   5. A pool that empties is written with zero reserves and leaves the graph.
//   6. Reachability prefilter: a v3 pool between two tokens with no root pool,
//      and a root pool holding no root, are never read with getV3State; they
//      get zero reserves. Disabling the prefilter reads them again. A second
//      run takes the root-pool balances from the cache instead of the chain.
//   7. Adaptive V3 batches: a batch the node refuses (gas cap, size limit) is
//      split and re-queued, and every pool still ends up read.
//
//   npm i -D @uniswap/v3-core@1.0.1 @uniswap/v2-core@1.0.1 solc@0.8.24
//   node test/test-v3-pipeline.mjs                 (anvil on PATH)

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ethers } from 'ethers';
import { scanFactory } from '../source/scanner/pairs.ts';
import { fetchReserves } from '../source/reserves/fetcher.ts';
import { enumerateTriangles } from '../source/triangles/enumerator.ts';
import { evaluateTriangles } from '../source/evaluator/evaluator.ts';
import { TriangleIndex } from '../source/orchestrator/triangle-index.ts';
import { ArbitradeDB } from '../source/util/db.ts';
import { fetchV3States } from '../source/reserves/v3-state.ts';
import { v3_swap_exact, getSqrtRatioAtTick } from '../source/util/calculus-v3.js';

const require = createRequire(import.meta.url);
const here = (p) => new URL(p, import.meta.url);
let fails = 0;
const ok = (c, l, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${l} ${extra}`); if (!c) fails++; };

// ---- contracts -------------------------------------------------------------
const solc = require('solc');
const out = JSON.parse(solc.compile(JSON.stringify({
    language: 'Solidity',
    sources: {
        'YoBatches2.sol': { content: fs.readFileSync(here('../contracts/YoBatches2.sol'), 'utf8') },
        'YoBatches3.sol': { content: fs.readFileSync(here('../contracts/YoBatches3.sol'), 'utf8') },
        'V3Harness.sol': { content: fs.readFileSync(here('./v3-golden/V3Harness.sol'), 'utf8') },
    },
    settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
})));
for (const e of out.errors ?? []) if (e.severity === 'error') { console.error(e.formattedMessage); process.exit(1); }
const pick = (f, n) => ({ abi: out.contracts[f][n].abi, bytecode: '0x' + out.contracts[f][n].evm.bytecode.object });
const v3art = n => require(`@uniswap/v3-core/artifacts/contracts/${n}.sol/${n}.json`);
const v2art = n => { const j = require(`@uniswap/v2-core/build/${n}.json`); return { abi: j.abi, bytecode: '0x' + j.evm.bytecode.object }; };
const A = {
    // YoBatches3: the reserves stage below runs through the packed reads
    // (getV3StatePacked, getReservesByPool) exactly as it would in production.
    Yo: pick('YoBatches3.sol', 'YoBatches3'), Tok: pick('V3Harness.sol', 'Tok'), Harness: pick('V3Harness.sol', 'Harness'),
    F3: v3art('UniswapV3Factory'), P3: v3art('UniswapV3Pool'), F2: v2art('UniswapV2Factory'), P2: v2art('UniswapV2Pair'),
};

const PORT = 8550, URL_ = `http://127.0.0.1:${PORT}`;
const anvil = spawn('anvil', ['--port', String(PORT), '--disable-code-size-limit', '--gas-limit', '3000000000', '--silent']);
await new Promise(r => setTimeout(r, 1500));
const provider = new ethers.JsonRpcProvider(URL_, undefined, { cacheTimeout: -1, staticNetwork: true });
const signer = await provider.getSigner(0);
const me = await signer.getAddress();
let nonce = await provider.getTransactionCount(me);
const ov = () => ({ nonce: nonce++, gasLimit: 30_000_000n });
const send = async (p) => (await p).wait();
const deploy = async (a, ...args) => { const c = await new ethers.ContractFactory(a.abi, a.bytecode, signer).deploy(...args, ov()); await c.waitForDeployment(); return c; };

const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'v3pipe-'));
const dbFile = path.join(tmpdir, 'pipe.db');
const quiet = async (fn) => {           // the pipeline is chatty; keep test output readable
    const w = process.stdout.write.bind(process.stdout), l = console.log;
    process.stdout.write = () => true; console.log = () => {};
    try { return await fn(); } finally { process.stdout.write = w; console.log = l; }
};

try {
    const f3 = await deploy(A.F3), f2 = await deploy(A.F2, me);
    const harness = await deploy(A.Harness), yo = await deploy(A.Yo);
    const F3 = (await f3.getAddress()).toLowerCase(), F2 = (await f2.getAddress()).toLowerCase(), H = await harness.getAddress();

    // Tokens: R (root, flash-loanable), A, B — all 18 decimals.
    const toks = [];
    for (let i = 0; i < 5; i++) toks.push(await deploy(A.Tok));
    const [R, TA, TB, TC, TD] = await Promise.all(toks.map(async t => (await t.getAddress()).toLowerCase()));
    const tokC = new Map([[R, toks[0]], [TA, toks[1]], [TB, toks[2]], [TC, toks[3]], [TD, toks[4]]]);
    const sort = (x, y) => BigInt(x) < BigInt(y) ? [x, y] : [y, x];

    // V3 pool at a given price of `quote` per `base` (human units, same decimals).
    async function v3Pool(base, quote, fee, price, liq) {
        const [t0, t1] = sort(base, quote);
        const p01 = t0 === base ? price : 1 / price;        // token1 per token0
        await send(f3.createPool(t0, t1, fee, ov()));
        const addr = (await f3.getPool(t0, t1, fee)).toLowerCase();
        const pool = new ethers.Contract(addr, A.P3.abi, signer);
        const spacing = Number(await pool.tickSpacing());
        const tick = Math.floor(Math.log(p01) / Math.log(1.0001));
        await send(pool.initialize(getSqrtRatioAtTick(tick) + 1n, ov()));
        const c = Math.floor(tick / spacing) * spacing;
        // a wide band plus a narrow concentrated one, so swaps cross ticks
        await send(harness.mint(addr, c - 400 * spacing, c + 400 * spacing, liq, ov()));
        await send(harness.mint(addr, c - 3 * spacing, c + 3 * spacing, liq * 4n, ov()));
        return addr;
    }
    async function v2Pair(base, quote, price, baseAmt) {
        await send(f2.createPair(base, quote, ov()));
        const addr = (await f2.getPair(base, quote)).toLowerCase();
        const e18 = 10n ** 18n;
        await send(tokC.get(base).mint(addr, baseAmt * e18, ov()));
        await send(tokC.get(quote).mint(addr, BigInt(Math.round(Number(baseAmt) * price)) * e18, ov()));
        await send(new ethers.Contract(addr, A.P2.abi, signer).mint(me, ov()));
        return addr;
    }

    // Prices: 1 R = 2 A, 1 A = 3 B, so 1 B = 1/6 R. Mispricings:
    //   R/A 0.05% pool at 2.00, R/A 0.30% pool at 2.06  -> same-factory 2-hop
    //   R/A V2 pair at 1.97                              -> V2<->V3 2-hop
    const L = 10n ** 21n;
    const pRA05 = await v3Pool(R, TA, 500, 2.00, L);
    const pRA30 = await v3Pool(R, TA, 3000, 2.06, L);
    const pAB30 = await v3Pool(TA, TB, 3000, 3.00, L);
    const qRA   = await v2Pair(R, TA, 1.97, 5000n);
    const qBR   = await v2Pair(TB, R, 1 / 6, 60000n);
    const qAB   = await v2Pair(TA, TB, 3.0, 20000n);
    // Unreachable: C has no pool with the root, so C/D can never be in a cycle
    // (D does have one, but it holds no root: initialized, never minted).
    const pCD   = await v3Pool(TC, TD, 3000, 1.5, L);
    const qCD   = await v2Pair(TC, TD, 1.5, 1000n);      // unreachable V2 pair
    const [d0, d1] = sort(R, TD);
    await send(f3.createPool(d0, d1, 3000, ov()));
    const pRD = (await f3.getPool(d0, d1, 3000)).toLowerCase();
    await send(new ethers.Contract(pRD, A.P3.abi, signer).initialize(getSqrtRatioAtTick(0), ov()));

    const base = { deployBlock: 1, stableFees: undefined, feeTarget: 'factory', feeArgSource: 'pair-address',
                   feeFunction: 'pairFee', feeDivisor: 10000, hasStableFlag: false, abi: [] };
    const factories = [
        { ...base, group: 'v3', name: 'UniV3', address: F3, fee: undefined, poolEvent: 'uniswap', callback: 'uniswapV3SwapCallback' },
        { ...base, group: 'v2', name: 'UniV2', address: F2, fee: 0.003, poolEvent: undefined, callback: undefined },
    ];
    const cfg = {
        raw: {}, chain: { name: 'Anvil', label: 'anvil', id: 31337, host: URL_, contract: await yo.getAddress(), token: R, currency: 'R' },
        factories, flashloan: { premium: 0.0005, tokens: [{ symbol: 'R', address: R, decimals: 18 }] },
        evaluator: {}, reserves: { v3Words: 2, v3BatchSize: 50 },
        scan: { chunkStart: 1000, chunkMin: 10, chunkMax: 50000, chunkDelayMs: 0 },
    };

    // ---- scan ---------------------------------------------------------------
    await quiet(async () => {
        const db = new ArbitradeDB(dbFile);
        for (const f of factories) {
            db.upsertFactory({ address: f.address, name: f.name, type: f.group, fee: f.fee, deployBlock: 1 });
            await scanFactory(provider, db, f, { forceTransport: 'rpc', fromBlock: 0 });
        }
        db.close();
    });

    console.log('1. reserves: v3 state stored exactly, virtual reserves written');
    const fr = await quiet(() => fetchReserves(cfg, dbFile, {}));
    ok(fr.errors.length === 0, 'no fetch errors', fr.errors.join('; '));
    {
        const db = new ArbitradeDB(dbFile);
        const states = db.loadV3States();
        let exact = 0;
        for (const addr of [pRA05, pRA30, pAB30]) {
            const pool = new ethers.Contract(addr, A.P3.abi, provider);
            const [s0, liq, fee] = await Promise.all([pool.slot0(), pool.liquidity(), pool.fee()]);
            const st = states.get(addr);
            if (st && st.sqrtPriceX96 === s0[0] && st.tick === Number(s0[1]) && st.liquidity === liq && st.fee === Number(fee)
                && st.ticks.length === 4) exact++;
        }
        ok(exact === 3, 'pool_state = slot0/liquidity/fee, all 4 initialized ticks per pool stored');
        const r = db.db.prepare('SELECT reserves0, reserves1 FROM reserves WHERE pair = ?').get(pRA05);
        const st = states.get(pRA05);
        const Q96 = 1n << 96n;
        ok(BigInt(r.reserves0) === st.liquidity * Q96 / st.sqrtPriceX96 && BigInt(r.reserves1) === st.liquidity * st.sqrtPriceX96 / Q96,
           'reserves row = virtual reserves (L*2^96/sqrtP, L*sqrtP/2^96)');
        const fee = db.db.prepare('SELECT fee FROM pairs WHERE address = ?').get(pRA30).fee;
        ok(Math.abs(fee - 0.003) < 1e-12, 'pairs.fee refreshed from pool.fee()');
        const v2r = db.db.prepare('SELECT reserves0, reserves1 FROM reserves WHERE pair = ?').get(qRA);
        const [b0, b1] = await Promise.all([...sort(R, TA)].map(t => tokC.get(t).balanceOf(qRA)));
        ok(BigInt(v2r.reserves0) === b0 && BigInt(v2r.reserves1) === b1, 'V2 pair reserves still = token balances');
        // 6. prefilter
        const stC = states.get(pCD), stD = states.get(pRD);
        const rz = (a) => db.db.prepare('SELECT reserves0, reserves1 FROM reserves WHERE pair = ?').get(a);
        // No row and a zero row both keep a pool out of enumeration.
        const zero = (a) => { const x = rz(a); return !x || (x.reserves0 === '0' && x.reserves1 === '0'); };
        ok(!stC && !stD && zero(pCD) && zero(pRD),
           'prefilter: unreachable C/D pool and root-less R/D pool skipped, no reserves');
        ok(!rz(qCD), 'v2 prefilter: the unreachable C/D V2 pair is not read either');
        db.close();
    }
    {
        // Same DB, prefilter off: the C/D pool is read (it has liquidity).
        await quiet(() => fetchReserves({ ...cfg, reserves: { ...cfg.reserves, v3Prefilter: false, v2Prefilter: false } }, dbFile, {}));
        const db = new ArbitradeDB(dbFile);
        const st = db.loadV3States().get(pCD);
        ok(!!st && st.liquidity > 0n, 'v3Prefilter: false reads every pool again');
        const r2 = db.db.prepare('SELECT reserves0 FROM reserves WHERE pair = ?').get(qCD);
        ok(r2 && r2.reserves0 !== '0', 'v2Prefilter: false reads the V2 pair again');
        db.close();
        // back to the default so the rest of the test sees the filtered graph;
        // the root-pool balances read by the first run are reused, not re-read.
        const lines = [];
        const l = console.log, w = process.stdout.write.bind(process.stdout);
        console.log = (...a) => lines.push(a.join(' ')); process.stdout.write = (x) => { lines.push(String(x)); return true; };
        try { await fetchReserves(cfg, dbFile, {}); } finally { console.log = l; process.stdout.write = w; }
        const hit = lines.find(x => /root pool\(s\) from cache, 0 to read/.test(x));
        ok(!!hit, 'second run: every root-pool balance from the cache, none read', hit?.trim() ?? lines.filter(x => /prefilter/.test(x)).join(' | '));
        const db2 = new ArbitradeDB(dbFile);
        const rCD = db2.db.prepare('SELECT reserves0 FROM reserves WHERE pair = ?').get(pCD);
        ok(rCD?.reserves0 === '0', 'and the cached verdict still drops the unreachable pool (zero reserves)');
        const qr = db2.db.prepare('SELECT reserves0 FROM reserves WHERE pair = ?').get(qCD);
        ok(qr?.reserves0 === '0', 'and the stale V2 reserves from the unfiltered run are zeroed');
        db2.close();
    }

    console.log('\n7. a refused V3 batch is split, not lost');
    {
        const db = new ArbitradeDB(dbFile);
        const pools = db.getPairsForReservesFetch({ kinds: ['v3'] }).map(p => ({ pair: p.pair, factory: p.factory }));
        const yoIface = new ethers.Interface(A.Yo.abi);
        let refused = 0, served = 0;
        // A node that refuses any getV3State over 2 pools (e.g. an eth_call gas cap).
        const capped = { call: async (tx) => {
            const call = yoIface.parseTransaction({ data: tx.data });
            const n = call.name === 'getV3StatePacked' ? (call.args[0].length - 2) / 40 : call.args[0].length;
            if (n > 2) { refused++; throw new Error('out of gas: eth_call gas cap'); }
            served++;
            return provider.call(tx);
        } };
        const YO = await yo.getAddress();
        const st = await quiet(() => fetchV3States(capped, db, YO, pools, { batchSize: 50, words: 2, concurrency: 3 }));
        ok(refused > 0 && st.errors.length === 0 && st.live + st.empty + st.unreadable === pools.length,
           'every pool read after the oversized batches were split', `${pools.length} pools, ${refused} refused, ${served} served`);
        db.close();
    }

    console.log('\n2. triangles include v3 pools');
    await quiet(() => enumerateTriangles(cfg, dbFile, {}));
    let triRows;
    {
        const db = new ArbitradeDB(dbFile);
        triRows = db.db.prepare('SELECT * FROM triangles').all();
        db.close();
    }
    const has = (pairs) => triRows.some(t => {
        const s = new Set([t.pair_ab, t.pair_bc, t.pair_ca]);
        return pairs.every(p => s.has(p)) && s.size === pairs.length;
    });
    ok(has([pRA05, pRA30]), 'same-factory fee-tier 2-hop (0.05% vs 0.30%)');
    ok(has([pRA05, qRA]) && has([pRA30, qRA]), 'V2<->V3 2-hops');
    ok(has([pRA05, pAB30, qBR]) && has([qRA, qAB, qBR]), 'mixed 3-hop and pure-V2 3-hop');

    console.log('\n3. evaluate: v3 cycles scored on exact-matching, tick-aware math');
    const ev = await quiet(() => evaluateTriangles(cfg, dbFile, { minProfitTokens: 0, minInputTokens: 0, maxRoiPct: 1e9 }));
    const v3c = ev.topCandidates.filter(c => c.hops.some(h => h.kind === 'v3'));
    const v2c = ev.topCandidates.filter(c => c.hops.every(h => h.kind !== 'v3'));
    ok(v3c.length > 0 && v2c.length > 0, 'both v3 and V2-only candidates found', `v3=${v3c.length} v2=${v2c.length}`);
    const tierArb = v3c.find(c => c.hopCount === 2 && new Set(c.hops.map(h => h.pair)).size === 2
                                  && c.hops.every(h => h.pair === pRA05 || h.pair === pRA30));
    ok(!!tierArb, 'the 0.05%/0.30% fee-tier arb is a candidate',
       tierArb ? `in=${(tierArb.inputAmount / 1e18).toFixed(3)} R net=${(tierArb.netProfit / 1e18).toFixed(5)} R` : '');

    // Exact BigInt walk of a candidate, on the stored state / balances.
    const db = new ArbitradeDB(dbFile);
    const states = db.loadV3States();
    const resOf = new Map(db.db.prepare('SELECT pair, reserves0, reserves1 FROM reserves').all().map(r => [r.pair, [BigInt(r.reserves0), BigInt(r.reserves1)]]));
    const tok0Of = new Map(db.db.prepare('SELECT address, token0 FROM pairs').all().map(r => [r.address, r.token0]));
    db.close();
    function exactCycle(c, xIn) {
        let amt = xIn;
        for (const h of c.hops) {
            const zf = tok0Of.get(h.pair) === h.tokenIn;
            if (h.kind === 'v3') {
                const r = v3_swap_exact(states.get(h.pair), zf, amt);
                if (!r.complete) return null;
                amt = zf ? -r.amount1 : -r.amount0;
            } else {
                const [r0, r1] = resOf.get(h.pair);
                const [rin, rout] = zf ? [r0, r1] : [r1, r0];
                const inFee = amt * 997n;
                amt = inFee * rout / (rin * 1000n + inFee);
            }
        }
        return amt - xIn;
    }
    let worstRel = 0, notOptimal = 0, checked = 0;
    for (const c of v3c) {
        const x = BigInt(Math.floor(c.inputAmount));
        const pe = exactCycle(c, x);
        if (pe === null) continue;
        checked++;
        worstRel = Math.max(worstRel, Math.abs(Number(pe) - c.grossProfit) / c.grossProfit);
        // the chosen size is a maximum: neither side of it does better by more than rounding
        for (const f of [0.98, 1.02]) {
            const pf = exactCycle(c, BigInt(Math.floor(c.inputAmount * f)));
            if (pf !== null && Number(pf) > Number(pe) * (1 + 1e-9) + 1e3) notOptimal++;
        }
    }
    ok(checked === v3c.length && checked > 0, 'every v3 candidate is priceable exactly', `${checked}/${v3c.length}`);
    ok(worstRel < 1e-9, 'float gross profit = exact BigInt walk', `worst rel diff ${worstRel.toExponential(2)}`);
    ok(notOptimal === 0, 'chosen size beats ±2% on the exact walk');

    console.log('\n4. nothing with a v3 hop reaches execution');
    const evx = await quiet(() => evaluateTriangles(cfg, dbFile, { minProfitTokens: 0, minInputTokens: 0, maxRoiPct: 1e9, executableOnly: true }));
    ok(evx.topCandidates.every(c => c.hops.every(h => h.kind !== 'v3')), 'executableOnly: no v3 candidates');
    ok(evx.topCandidates.length === v2c.length && evx.skipReasons.v3NotExecutable > 0,
       'and the V2-only candidates are exactly the same set', `v3 skipped=${evx.skipReasons.v3NotExecutable}`);
    {
        const db2 = new ArbitradeDB(dbFile);
        const ix = TriangleIndex.build(db2, new Map(factories.map(f => [f.address, f])));
        const v3set = new Set([pRA05, pRA30, pAB30]);
        ok(ix.pairAddr.every(p => !v3set.has(p)), 'hot index: no v3 pools interned');
        const pureV2 = triRows.filter(t => ![t.pair_ab, t.pair_bc, t.pair_ca].some(p => v3set.has(p))).length;
        ok(ix.triangleCount === pureV2, 'hot index: exactly the pure-V2 triangles', `${ix.triangleCount}/${triRows.length}`);
        db2.close();
    }

    console.log('\n5. an emptied pool leaves the graph');
    {
        // Burn every position in the 0.05% pool -> in-range liquidity 0.
        const pool = new ethers.Contract(pRA05, A.P3.abi, provider);
        const spacing = Number(await pool.tickSpacing());
        const t = Number((await pool.slot0())[1]);
        const c = Math.floor(t / spacing) * spacing;
        await send(harness.burn(pRA05, c - 400 * spacing, c + 400 * spacing, L, ov()));
        await send(harness.burn(pRA05, c - 3 * spacing, c + 3 * spacing, L * 4n, ov()));
        await quiet(() => fetchReserves(cfg, dbFile, {}));
        const db3 = new ArbitradeDB(dbFile);
        const r = db3.db.prepare('SELECT reserves0, reserves1 FROM reserves WHERE pair = ?').get(pRA05);
        const live = db3.getPairsForEnumeration().some(p => p.pair === pRA05);
        ok(r.reserves0 === '0' && r.reserves1 === '0' && !live, 'zero reserves written, pool no longer enumerable');
        db3.close();
    }
} finally {
    anvil.kill();
    fs.rmSync(tmpdir, { recursive: true, force: true });
}

console.log(fails === 0 ? '\nALL V3 PIPELINE CHECKS PASS' : `\n${fails} FAILED`);
process.exit(fails ? 1 : 0);
