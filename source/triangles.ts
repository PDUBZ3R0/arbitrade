// -----------------------------------------------------------------------------
// CLI: yarn triangles <chain> [options]
//
// Enumerate arbitrage triangles rooted at flash-loanable tokens. Reads live
// pair data (pairs joined with reserves) and writes to the triangles table.
// Run this after significant pair changes or after adding/removing factories.
// -----------------------------------------------------------------------------

import { loadChainConfig, dbPath } from './util/config.ts';
import { enumerateTriangles } from './triangles/enumerator.ts';

const args = process.argv.slice(2);
const chainArg = args[0];
if (!chainArg || chainArg.startsWith('--')) {
    console.error('Usage: yarn triangles <chain> [options]');
    console.error('');
    console.error('  --root ADDR         Only enumerate triangles rooted at this token');
    console.error('                      (must be in chain.flashloan.tokens list)');
    console.error('  --include-stable    Include stable pools (constant-product math will');
    console.error('                      give wrong prices for them — dev only)');
    console.error('  --limit N           Cap total triangles emitted (dev sanity)');
    console.error('');
    console.error('Enumerates 2-hop (cross-DEX) and 3-hop (triangular) arb candidates,');
    console.error('rooted at each flash-loan token. Skips zero-reserve pairs, stable pools,');
    console.error('and same-factory-for-all-hops (no arb possible).');
    process.exit(1);
}

const getStr = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return (i >= 0 && args[i + 1]) ? args[i + 1] : undefined;
};
const hasFlag = (flag: string): boolean => args.indexOf(flag) >= 0;

const onlyRoot      = getStr('--root');
const includeStable = hasFlag('--include-stable');
const limitStr      = getStr('--limit');
const limit         = limitStr ? parseInt(limitStr, 10) : undefined;

const cfg = loadChainConfig(chainArg);
const dbFile = dbPath(chainArg);

console.log(`Enumerating triangles for ${cfg.chain.name} (chain id ${cfg.chain.id})`);
console.log(`DB: ${dbFile}`);
console.log(`Flash-loan tokens: ${cfg.flashloan?.tokens.map(t => t.symbol).join(', ') ?? '(none)'}`);
if (onlyRoot) console.log(`Restricting to root: ${onlyRoot}`);
if (includeStable) console.log(`Including stable pools (WARNING: prices will be wrong)`);
if (limit) console.log(`Limit: ${limit}`);
console.log('');

const result = await enumerateTriangles(cfg, dbFile, { onlyRoot, includeStable, limit });

console.log('\n' + '─'.repeat(60));
console.log(`Done in ${(result.elapsedMs / 1000).toFixed(2)}s`);
console.log(`  Pairs used:          ${result.pairsUsed}`);
console.log(`  Triangles inserted:  ${result.trianglesInserted}`);
if (result.duplicatesSkipped > 0) {
    console.log(`  Duplicates skipped:  ${result.duplicatesSkipped}`);
}
console.log(`  2-hop count:         ${result.hops2Count}`);
console.log(`  3-hop count:         ${result.hops3Count}`);
console.log(`  By root token:`);
for (const [root, count] of Object.entries(result.byRoot)) {
    const sym = cfg.flashloan?.tokens.find(t => t.address.toLowerCase() === root)?.symbol ?? '???';
    console.log(`    ${sym.padEnd(6)} ${root}: ${count}`);
}
