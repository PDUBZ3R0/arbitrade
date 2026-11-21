// -----------------------------------------------------------------------------
// CLI: yarn pair-code <chain> [--group v2|v2fee|solidly|all] [--again]
//
// Report-only sweep of the pair code behind every configured factory: one pair
// per factory (the most active), the implementation behind it if it is a proxy,
// decompiled once per code hash by heimdall and classified by util/pair-code.ts
// (trap / watch / ok / unclassified). Nothing is written to the conf or the DB.
// With no pool DB the pair comes from the factory itself (util/sample-pairs.ts).
//
// Why: the 30% pair on Polygon (2026-10-31) came from a factory that looked
// like a UniswapV2 copy; the fee lived in a contract its swap() calls. Fees
// measured from swaps (verify-fees) catch what a pair charged, not what its
// owner can make it charge, and not a pair that refuses some callers.
//
// Decompilations are cached in log/<chain>/pair-code-cache.json by code hash;
// --again re-decompiles.
// -----------------------------------------------------------------------------

import fs from 'node:fs';
import { loadChainConfig, dbPath } from './util/config.ts';
import { makeProvider } from './util/rpc.ts';
import { openPoolDb, PairSampler } from './util/sample-pairs.ts';
import { readPairCode, type PairCodeReport } from './util/pair-code.ts';

const args = process.argv.slice(2);
const chainArg = args[0];
if (!chainArg || chainArg.startsWith('--')) {
    console.error('Usage: yarn pair-code <chain> [--group v2|v2fee|solidly|all] [--again] [--jobs N]');
    process.exit(1);
}
const getStr = (flag: string) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
const group = getStr('--group') ?? 'all';
const again = args.includes('--again');
const jobs = Number(getStr('--jobs') ?? 4);
if (!Number.isFinite(jobs) || jobs < 1) { console.error('--jobs must be a positive number'); process.exit(1); }

const cfg = loadChainConfig(chainArg);
const db = openPoolDb(dbPath(chainArg));
const provider = makeProvider(cfg.chain);
const cacheFile = `log/${cfg.chain.label}/pair-code-cache.json`;
const cache: Record<string, { sol?: string; error?: string }> = fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, 'utf8')) : {};
const saveCache = () => fs.writeFileSync(cacheFile, JSON.stringify(cache));

const factories = cfg.factories.filter(f => group === 'all' || f.group === group);
const pairCount = new Map((db?.db.prepare('SELECT factory, count(*) n FROM pairs GROUP BY factory').all() as Array<{ factory: string; n: number }> | undefined ?? []).map(r => [r.factory, r.n]));
const sampler = await PairSampler.open(cfg, provider, factories.filter(f => f.group !== 'v3' && f.group !== 'algebra'), db);

console.log(`Pair-code sweep: ${factories.length} factor(ies) on ${cfg.chain.name} (group ${group}); report only\n`);

type Row = { name: string; factory: string; group: string; pairs: number; pair: string | null; hash: string | null; report: PairCodeReport; note: string };
const rows: Row[] = [];
const work: Array<() => Promise<void>> = [];

for (const f of factories) work.push(async () => {
    const a = f.address.toLowerCase();
    const row: Row = { name: f.name, factory: a, group: f.group, pairs: pairCount.get(a) ?? 0, pair: null, hash: null, report: { verdict: 'unclassified', findings: [] }, note: '' };
    rows.push(row);
    const sample = sampler.pairs(a, 1)[0];
    if (!sample) { row.note = 'no pairs in the DB or among hub tokens'; return; }
    row.pair = sample.pair;
    Object.assign(row, await readPairCode(provider, { address: sample.pair, token0: sample.token0, token1: sample.token1 }, a, cache, { again, save: saveCache }));
});

let next = 0, done = 0;
await Promise.all(Array.from({ length: jobs }, async () => {
    while (next < work.length) {
        await work[next++]();
        if (++done % 25 === 0) console.log(`  … ${done}/${work.length}`);
    }
}));

const order = { trap: 0, watch: 1, unclassified: 2, ok: 3 } as const;
rows.sort((a, b) => order[a.report.verdict] - order[b.report.verdict] || b.pairs - a.pairs);
for (const v of ['trap', 'watch'] as const) {
    const these = rows.filter(r => r.report.verdict === v);
    console.log(`\n${v.toUpperCase()} (${these.length})`);
    for (const r of these) {
        console.log(`  ${r.name.padEnd(34)} ${r.group.padEnd(8)} ${String(r.pairs).padStart(6)} pairs  pair ${r.pair}  code ${r.hash?.slice(0, 10)}`);
        for (const x of r.report.findings) console.log(`      ${x.level === 'trap' ? '!!' : ' -'} ${x.what}`);
    }
}
const un = rows.filter(r => r.report.verdict === 'unclassified');
const why = new Map<string, number>();
for (const r of un) why.set(r.note || '?', (why.get(r.note || '?') ?? 0) + 1);
console.log(`\nUNCLASSIFIED (${un.length}): ${[...why].map(([k, n]) => `${n} ${k}`).join('; ')}`);
console.log(`OK (${rows.filter(r => r.report.verdict === 'ok').length})`);
const codes = new Set(rows.map(r => r.hash).filter(Boolean));
console.log(`\n${rows.length} factories, ${codes.size} distinct pair codes. Nothing written.`);
db?.close();
provider.destroy();
process.exit(0);
