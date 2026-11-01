// -----------------------------------------------------------------------------
// CLI: yarn pair-code <chain> [--group v2|v2fee|solidly|all] [--again]
//
// Report-only sweep of the pair code behind every configured factory: one pair
// per factory (the most active), the implementation behind it if it is a proxy,
// decompiled once per code hash by heimdall and classified by util/pair-code.ts
// (trap / watch / ok / unclassified). Nothing is written to the conf or the DB.
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
import { keccak256 } from 'ethers';
import { loadChainConfig, dbPath } from './util/config.ts';
import { makeProvider } from './util/rpc.ts';
import { ArbitradeDB } from './util/db.ts';
import { classifyPairCode, decompilePairCode, type PairCodeReport } from './util/pair-code.ts';

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
const db = new ArbitradeDB(dbPath(chainArg));
const provider = makeProvider(cfg.chain);
const cacheFile = `log/${cfg.chain.label}/pair-code-cache.json`;
const cache: Record<string, { sol?: string; error?: string }> = fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, 'utf8')) : {};
const saveCache = () => fs.writeFileSync(cacheFile, JSON.stringify(cache));

const EIP1967_IMPL = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const EIP1967_ADMIN = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103';
const word = (w: string) => (w && w !== '0x' && BigInt(w) !== 0n ? '0x' + w.slice(-40).toLowerCase() : null);
// Solidity's CBOR metadata tail differs between identical builds; cut it before hashing.
// Only when a CBOR map header (a1..a5) sits where the tail would start, as ../sniper does.
const stripMetadata = (code: string) => {
    const hex = code.toLowerCase().replace(/^0x/, '');
    const len = parseInt(hex.slice(-4), 16);
    const start = hex.length - 4 - len * 2;
    return len > 0 && len < 256 && start > 0 && /^a[1-5]$/.test(hex.slice(start, start + 2)) ? '0x' + hex.slice(0, start) : '0x' + hex;
};

const retry = async <T>(f: () => Promise<T>): Promise<T> => {
    for (let i = 0; ; i++) { try { return await f(); } catch (e) { if (i >= 3) throw e; await new Promise(r => setTimeout(r, 500 * (i + 1))); } }
};

const factories = cfg.factories.filter(f => group === 'all' || f.group === group);
const pairCount = new Map((db.db.prepare('SELECT factory, count(*) n FROM pairs GROUP BY factory').all() as Array<{ factory: string; n: number }>).map(r => [r.factory, r.n]));
const samplePair = db.db.prepare(`
    SELECT p.address, p.token0, p.token1 FROM pairs p LEFT JOIN reserves r ON r.pair = p.address
    WHERE p.factory = ? ORDER BY MAX(CAST(COALESCE(r.reserves0, 0) AS REAL), CAST(COALESCE(r.reserves1, 0) AS REAL)) DESC LIMIT 1`);

console.log(`Pair-code sweep: ${factories.length} factor(ies) on ${cfg.chain.name} (group ${group}); report only\n`);

type Row = { name: string; factory: string; group: string; pairs: number; pair: string | null; hash: string | null; report: PairCodeReport; note: string };
const rows: Row[] = [];
const work: Array<() => Promise<void>> = [];

for (const f of factories) work.push(async () => {
    const a = f.address.toLowerCase();
    const row: Row = { name: f.name, factory: a, group: f.group, pairs: pairCount.get(a) ?? 0, pair: null, hash: null, report: { verdict: 'unclassified', findings: [] }, note: '' };
    rows.push(row);
    const sample = samplePair.get(a) as { address: string; token0: string; token1: string } | undefined;
    if (!sample) { row.note = 'no pairs in the DB'; return; }
    const pair = sample.address;
    row.pair = pair;
    try {
        let code = await retry(() => provider.getCode(pair));
        if (code === '0x') { row.note = 'pair has no code'; return; }
        let proxy: string | null = null;
        const clone = /^0x363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3/i.exec(code);
        const impl = clone ? '0x' + clone[1].toLowerCase() : word(await retry(() => provider.getStorage(pair, EIP1967_IMPL)));
        if (impl) {
            const admin = clone ? null : word(await retry(() => provider.getStorage(pair, EIP1967_ADMIN)));
            proxy = clone ? `EIP-1167 clone of ${impl}` : `EIP-1967 proxy to ${impl}${admin ? `, admin ${admin}` : ''}`;
            code = await retry(() => provider.getCode(impl));
        }
        const hash = keccak256(stripMetadata(code));
        row.hash = hash;
        if (again || !cache[hash]) { cache[hash] = await decompilePairCode(code); saveCache(); }
        const d = cache[hash];
        if (!d.sol) { row.note = d.error ?? 'no decompilation'; return; }
        row.report = classifyPairCode(d.sol, { proxy: clone ? null : proxy, factory: a, tokens: [sample.token0, sample.token1] });
        if (row.report.verdict === 'unclassified') row.note = 'no V2 swap(uint256,uint256,address,bytes)';
    } catch (e) {
        row.note = `read failed: ${String((e as Error).message ?? e).slice(0, 120)}`;
    }
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
db.close();
provider.destroy();
process.exit(0);
