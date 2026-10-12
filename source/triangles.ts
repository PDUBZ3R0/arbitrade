// -----------------------------------------------------------------------------
// CLI: yarn triangles <chain> [options]
//
// Enumerate arbitrage triangles rooted at flash-loanable tokens. Reads live
// pair data (pairs joined with reserves) and writes to the triangles table.
// Run this after significant pair changes or after adding/removing factories.
// -----------------------------------------------------------------------------

import { loadChainConfig, dbPath } from './util/config.ts';
import { enumerateTriangles } from './triangles/enumerator.ts';
import { ArbitradeDB } from './util/db.ts';

const args = process.argv.slice(2);
const chainArg = args[0];
if (!chainArg || chainArg.startsWith('--')) {
    console.error('Usage: yarn triangles <chain> [options]');
    console.error('');
    console.error('  --root ADDR         Only enumerate triangles rooted at this token');
    console.error('                      (a flash-loan token, or a swap root when flashloan.swapRoots is set)');
    console.error('  --include-stable    Include stable pools (constant-product math will');
    console.error('                      give wrong prices for them — dev only)');
    console.error('  --prune-same-factory  Skip 3-hop cycles whose three pairs share a factory');
    console.error('                      (old default; a memory lever, not a correctness one)');
    console.error('  --limit N           Cap total triangles emitted (dev sanity)');
    console.error('  --all-roots         List every root in the summary, including those with 0 cycles');
    console.error('');
    console.error('Enumerates 2-hop (cross-DEX) and 3-hop (triangular) arb candidates,');
    console.error('rooted at each flash-loan token. Skips zero-reserve pairs and stable pools.');
    console.error('Same-factory cycles ARE kept: V3 fee tiers and Solidly stable/volatile pairs');
    console.error('are distinct pools from one factory, and one DEX\'s pairs drift like any others.');
    process.exit(1);
}

const getStr = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return (i >= 0 && args[i + 1]) ? args[i + 1] : undefined;
};
const hasFlag = (flag: string): boolean => args.indexOf(flag) >= 0;

const onlyRoot      = getStr('--root');
const includeStable = hasFlag('--include-stable');
const pruneSameFactory3 = hasFlag('--prune-same-factory');
const allRoots      = hasFlag('--all-roots');
const limitStr      = getStr('--limit');
const limit         = limitStr ? parseInt(limitStr, 10) : undefined;

const cfg = loadChainConfig(chainArg);
const dbFile = dbPath(chainArg);

console.log(`Enumerating triangles for ${cfg.chain.name} (chain id ${cfg.chain.id})`);
console.log(`DB: ${dbFile}`);
console.log(`Flash-loan tokens: ${cfg.flashloan?.tokens.map(t => t.symbol).join(', ') ?? '(none)'}`);
if (onlyRoot) console.log(`Restricting to root: ${onlyRoot}`);
if (includeStable) console.log(`Including stable pools (WARNING: prices will be wrong)`);
if (pruneSameFactory3) console.log(`Pruning 3-hop cycles whose pairs all share a factory`);
if (limit) console.log(`Limit: ${limit}`);
console.log('');

const result = await enumerateTriangles(cfg, dbFile, { onlyRoot, includeStable, pruneSameFactory3, limit });

console.log('\n' + '─'.repeat(60));
console.log(`Done in ${(result.elapsedMs / 1000).toFixed(2)}s`);
console.log(`  Pairs used:          ${result.pairsUsed}`);
console.log(`  Triangles inserted:  ${result.trianglesInserted}`);
if (result.duplicatesSkipped > 0) {
    console.log(`  Duplicates skipped:  ${result.duplicatesSkipped}`);
}
console.log(`  2-hop count:         ${result.hops2Count}`);
console.log(`  3-hop count:         ${result.hops3Count}`);
if (result.swapRoots > 0) {
    console.log(`  swap roots:          ${result.swapRoots} (${result.swapRootCycles} cycles only a flash swap can fund)`);
}
console.log(`  same-factory 2-hop:  ${result.sameFactory2}   (fee tiers / stable+volatile — previously dropped)`);
console.log(`  same-factory 3-hop:  ${result.sameFactory3}   ${pruneSameFactory3 ? '(pruned)' : '(previously dropped)'}`);
// Symbols: the configured flash token's, else the tokens table (yarn tokens fills it).
const roots = Object.entries(result.byRoot);
const symbols = (() => {
    const out = new Map<string, string>();
    for (const t of cfg.flashloan?.tokens ?? []) out.set(t.address.toLowerCase(), t.symbol);
    try {
        const db = new ArbitradeDB(dbFile);
        for (const [addr, t] of db.getTokens(roots.map(([r]) => r).filter(r => !out.has(r)))) if (t.symbol) out.set(addr.toLowerCase(), t.symbol);
        db.close();
    } catch { /* symbols are cosmetic */ }
    return out;
})();
const shown = allRoots ? roots : roots.filter(([, n]) => n > 0);
const symOf = (r: string) => (symbols.get(r) ?? '???').replace(/\s+/g, ' ').slice(0, 14);
const w = Math.max(6, ...shown.map(([r]) => symOf(r).length));
console.log(`  By root token:`);
for (const [root, count] of shown) console.log(`    ${symOf(root).padEnd(w)} ${root}: ${count}`);
const hidden = roots.length - shown.length;
if (hidden > 0) console.log(`    (${hidden} root${hidden === 1 ? '' : 's'} with 0 cycles not shown — --all-roots lists them)`);
if ([...shown].some(([r]) => !symbols.has(r))) console.log(`    (??? = not in the tokens table yet — yarn tokens ${cfg.chain.label})`);
