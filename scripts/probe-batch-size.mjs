// What batch size and concurrency actually move reserves fastest on THIS RPC?
//
//   node --experimental-strip-types scripts/probe-batch-size.mjs <chain>
//   node --experimental-strip-types scripts/probe-batch-size.mjs polygon --pairs 6000
//
// WHY THIS EXISTS
//
// `yarn reserves polygon` took 407s for 203,832 pairs. 94% of that was three
// factories, and their 20-way concurrency delivered 557 pairs/s against 315
// pairs/s for the serial small ones — 20x the parallelism for 1.8x the
// throughput. That is a round-trip-bound workload, so the lever is requests,
// not compute.
//
// Measured on anvil, YoBatches costs ~16.6k gas per pair with every account
// access cold. At 200 pairs/batch that is 3.3M gas — about 7% of a typical 50M
// eth_call cap. So the current batch size leaves roughly 15x on the table.
//
// But the largest batch that WORKS is not necessarily the fastest: per-request
// latency grows with batch size, response size grows linearly, and public
// endpoints rate-limit on requests, bytes, or compute depending on the vendor.
// Guessing 2000 would be replacing one arbitrary number with another, so this
// measures both the ceiling and the throughput curve, against real pairs from
// the chain's own DB.
//
// Read-only: eth_call and eth_estimateGas, nothing written anywhere.

import { JsonRpcProvider, Interface } from 'ethers';
import { loadChainConfig, dbPath } from '../source/util/config.ts';
import { ArbitradeDB } from '../source/util/db.ts';

const args = process.argv.slice(2);
const chainArg = args[0];
if (!chainArg || chainArg.startsWith('--')) {
    console.error('Usage: node --experimental-strip-types scripts/probe-batch-size.mjs <chain> [options]');
    console.error('');
    console.error('  --rpc URL        Override the chain config host.');
    console.error('  --pairs N        Pairs to move per throughput sample (default 4000).');
    console.error('  --max N          Largest batch size to try when finding the ceiling (default 5000).');
    console.error('  --skip-ceiling   Only run the throughput sweep.');
    process.exit(1);
}
const getStr = (f) => { const i = args.indexOf(f); return (i >= 0 && args[i + 1]) ? args[i + 1] : undefined; };
const num = (f, d) => { const s = getStr(f); if (s == null) return d; const v = parseInt(s, 10); if (!Number.isFinite(v) || v <= 0) { console.error(`${f} must be a positive integer`); process.exit(1); } return v; };

const cfg = loadChainConfig(chainArg);
const rpc = getStr('--rpc') ?? cfg.chain.host;
const samplePairs = num('--pairs', 4000);
const maxTry = num('--max', 5000);

if (!cfg.chain.contract) {
    console.error(`chain.contract (YoBatches2) is unset in conf/${cfg.chain.label}.json5 — nothing to probe.`);
    process.exit(1);
}

const iface = new Interface([
    'function getReserves(address[3][] args) view returns (uint256[])',   // YoBatches2
]);

const db = new ArbitradeDB(dbPath(chainArg));
const rows = db.db.prepare(
    'SELECT address, token0, token1 FROM pairs WHERE token0 IS NOT NULL AND token1 IS NOT NULL LIMIT ?'
).all(Math.max(samplePairs, maxTry) + 10);
db.close();

if (rows.length < 100) {
    console.error(`Only ${rows.length} pairs in the DB — run \`yarn scan ${chainArg}\` first.`);
    process.exit(1);
}
const triples = rows.map(r => [r.address, r.token0, r.token1]);

const provider = new JsonRpcProvider(rpc, undefined, { staticNetwork: true });
console.log(`chain:     ${cfg.chain.name} (${cfg.chain.id})`);
console.log(`rpc:       ${rpc}`);
console.log(`yobatches: ${cfg.chain.contract}`);
console.log(`pairs available in DB sample: ${triples.length.toLocaleString()}`);

try {
    console.log(`block:     ${await provider.getBlockNumber()}  (transport OK)`);
} catch (err) {
    console.error(`\n[!] Cannot reach the RPC: ${err.message}`);
    process.exit(1);
}

const callBatch = async (n, offset = 0) => {
    const slice = triples.slice(offset, offset + n);
    const data = iface.encodeFunctionData('getReserves', [slice]);
    const raw = await provider.call({ to: cfg.chain.contract, data });
    const decoded = iface.decodeFunctionResult('getReserves', raw)[0];
    if (decoded.length !== slice.length * 2) {
        throw new Error(`returned ${decoded.length} words for ${slice.length} pairs (old YoBatches at chain.contract?)`);
    }
    return { bytes: (raw.length - 2) / 2, rows: slice.length };
};

// --- gas per pair, from this chain's own node -------------------------------
console.log('\n--- gas ---');
let gasPerPair = null;
try {
    const probe = async (n) => Number(await provider.estimateGas({
        to: cfg.chain.contract,
        data: iface.encodeFunctionData('getReserves', [triples.slice(0, n)]),
    }));
    const [g50, g200] = [await probe(50), await probe(200)];
    gasPerPair = (g200 - g50) / 150;
    console.log(`  ${gasPerPair.toFixed(0)} gas/pair measured here (YoBatches v1 on anvil, all-cold, was 16,583)`);
    for (const cap of [10e6, 30e6, 50e6]) {
        console.log(`    a ${(cap / 1e6)}M eth_call cap would fit ~${Math.floor(cap / gasPerPair).toLocaleString()} pairs`);
    }
} catch (e) {
    console.log(`  estimateGas unavailable (${(e.shortMessage ?? e.message).slice(0, 70)}) — skipping`);
}

// --- ceiling: largest batch the node actually accepts -----------------------
let ceiling = null;
if (!args.includes('--skip-ceiling')) {
    console.log('\n--- ceiling (doubling until it breaks, then bisecting) ---');
    let good = 0, bad = null;
    for (let n = 200; n <= maxTry; n *= 2) {
        if (n > triples.length) { console.log(`  ${n}: not enough pairs in the DB sample to try`); break; }
        try {
            const t = Date.now();
            const r = await callBatch(n);
            console.log(`  ${String(n).padStart(5)}: ok   ${((Date.now() - t) / 1000).toFixed(2)}s, ${(r.bytes / 1024).toFixed(0)} KiB response`);
            good = n;
        } catch (e) {
            console.log(`  ${String(n).padStart(5)}: FAIL ${(e.shortMessage ?? e.message).replace(/\s+/g, ' ').slice(0, 95)}`);
            bad = n; break;
        }
    }
    if (bad != null && good > 0) {
        let lo = good, hi = bad;
        while (hi - lo > Math.max(50, Math.floor(lo * 0.1))) {
            const mid = Math.floor((lo + hi) / 2);
            try { await callBatch(mid); lo = mid; console.log(`  ${String(mid).padStart(5)}: ok`); }
            catch { hi = mid; console.log(`  ${String(mid).padStart(5)}: FAIL`); }
        }
        ceiling = lo;
    } else {
        ceiling = good;
    }
    console.log(`  => largest accepted batch: ${ceiling.toLocaleString()} pairs`);
}

// --- throughput: the number that actually matters ---------------------------
console.log(`\n--- throughput (${samplePairs.toLocaleString()} pairs per sample) ---`);
console.log('  batch | conc |    wall |   pairs/s | vs now');
console.log('  ' + '-'.repeat(52));

const runSample = async (batchSize, concurrency) => {
    const total = Math.min(samplePairs, triples.length);
    const nBatches = Math.ceil(total / batchSize);
    let next = 0, failed = 0;
    const t0 = Date.now();
    const worker = async () => {
        for (;;) {
            const i = next++;
            if (i >= nBatches) return;
            try { await callBatch(Math.min(batchSize, total - i * batchSize), i * batchSize); }
            catch { failed++; }
        }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, nBatches) }, worker));
    const secs = (Date.now() - t0) / 1000;
    return { secs, rate: total / secs, failed, nBatches };
};

const CANDIDATES = [[200, 20], [500, 10], [1000, 6], [1000, 10], [2000, 4], [2000, 8]];
let baseline = null;
const results = [];
for (const [bs, conc] of CANDIDATES) {
    if (ceiling != null && bs > ceiling) { console.log(`  ${String(bs).padStart(5)} | ${String(conc).padStart(4)} | skipped — above the measured ceiling`); continue; }
    try {
        const r = await runSample(bs, conc);
        if (baseline == null) baseline = r.rate;
        results.push({ bs, conc, ...r });
        console.log(`  ${String(bs).padStart(5)} | ${String(conc).padStart(4)} | ` +
            `${r.secs.toFixed(1).padStart(6)}s | ${r.rate.toFixed(0).padStart(9)} | ` +
            `${(r.rate / baseline).toFixed(2)}x` + (r.failed ? `  (${r.failed} batch failure(s))` : ''));
    } catch (e) {
        console.log(`  ${String(bs).padStart(5)} | ${String(conc).padStart(4)} | FAILED ${(e.shortMessage ?? e.message).slice(0, 50)}`);
    }
}

// --- recommendation --------------------------------------------------------
const clean = results.filter(r => r.failed === 0);
if (clean.length > 0) {
    const best = clean.reduce((a, b) => (b.rate > a.rate ? b : a));
    const totalPairs = 203832;
    console.log('\n--- recommendation ---');
    console.log(`  fastest clean combo: ${best.bs} pairs/batch at concurrency ${best.conc} ` +
        `(${best.rate.toFixed(0)} pairs/s, ${(best.rate / baseline).toFixed(2)}x the current 200/20)`);
    console.log(`  RESERVES_BATCH_SIZE in source/reserves/fetcher.ts is currently 200;`);
    console.log(`  threads in conf/${cfg.chain.label}.json5 sets the concurrency.`);
    console.log(`\n  Caveat worth keeping: this samples ${samplePairs.toLocaleString()} pairs from one`);
    console.log(`  factory's worth of the DB in DB order. A full run touches more distinct`);
    console.log(`  tokens and may be slower per pair, and a public endpoint's rate limiter`);
    console.log(`  can behave differently over 400s than over a 30s sample.`);
} else {
    console.log('\n--- no clean result; every combo had batch failures ---');
}
provider.destroy();
