// -----------------------------------------------------------------------------
// CLI: yarn evaluate <chain> [options]
//
// Score all cached triangles for a chain using current reserves + fees.
// Prints profitable candidates sorted by net profit.
// -----------------------------------------------------------------------------

import { ArbitradeDB } from './util/db.ts';
import { loadChainConfig, dbPath } from './util/config.ts';
import { evaluateTriangles } from './evaluator/evaluator.ts';

const args = process.argv.slice(2);
const chainArg = args[0];
if (!chainArg || chainArg.startsWith('--')) {
    console.error('Usage: yarn evaluate <chain> [options]');
    console.error('');
    console.error('  --root ADDR              Only evaluate triangles rooted at this token');
    console.error('  --hops 2|3               Only evaluate 2-hop or 3-hop cycles');
    console.error('  --min-profit N           Minimum profit in root-token wei (default 0)');
    console.error('  --min-profit-tokens N    Minimum profit as fraction of root token');
    console.error('                           (default 0.001 = 0.001 root tokens; set 0 to disable)');
    console.error('  --min-input-tokens N     Minimum optimal input as fraction of root token');
    console.error('                           (default 0.001; filters dust-input phantoms)');
    console.error('  --min-liquidity N        Skip pairs where either side has < N wei reserves');
    console.error('                           (default 1e18 = 1 token for 18-dec)');
    console.error('                           NOTE: for 6-dec tokens like USDC, override to ~1e6');
    console.error('  --max-roi-pct N          Skip candidates with ROI above N%. Real arb is under');
    console.error('                           a few percent; default 20 catches phantoms while');
    console.error('                           keeping legitimate opportunities. Set 100 for raw.');
    console.error('  --limit N                Show top N candidates only (default 20)');
    console.error('  --verbose                Show hop details for each candidate');
    console.error('');
    console.error('Reads triangles table (built by `yarn triangles`) and reserves');
    console.error('(refreshed by `yarn reserves`), computes optimal input and profit.');
    process.exit(1);
}

const getStr = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return (i >= 0 && args[i + 1]) ? args[i + 1] : undefined;
};
const hasFlag = (flag: string): boolean => args.indexOf(flag) >= 0;

const onlyRoot   = getStr('--root');
const hopsStr    = getStr('--hops');
const onlyHops   = hopsStr === '2' ? 2 : hopsStr === '3' ? 3 : undefined;
const minProfitStr = getStr('--min-profit');
const minProfitWei = minProfitStr ? BigInt(minProfitStr) : undefined;
const minProfitTokensStr = getStr('--min-profit-tokens');
const minProfitTokens = minProfitTokensStr ? parseFloat(minProfitTokensStr) : undefined;  // undefined → default 0.001
const minInputTokensStr = getStr('--min-input-tokens');
const minInputTokens = minInputTokensStr ? parseFloat(minInputTokensStr) : undefined;
const minLiqStr = getStr('--min-liquidity');
// Default: 1 whole 18-decimal token. Filters most math phantoms from dust
// pools. Override for USDC-rooted work (~1e6 = 1 USDC).
const minPairReservesWei = minLiqStr ? BigInt(minLiqStr) : 1_000_000_000_000_000_000n;
const maxRoiStr = getStr('--max-roi-pct');
// Default 20% — real arb rarely exceeds a few percent; anything above 20%
// on Sonic/Gnosis/Base/etc is almost always a math phantom. Bump higher
// (--max-roi-pct 100) if debugging.
const maxRoiPct = maxRoiStr ? parseFloat(maxRoiStr) : 20;
const limitStr   = getStr('--limit');
const limit      = limitStr ? parseInt(limitStr, 10) : 20;
const verbose    = hasFlag('--verbose');

const cfg = loadChainConfig(chainArg);
const dbFile = dbPath(chainArg);

console.log(`Evaluating triangles for ${cfg.chain.name} (chain id ${cfg.chain.id})`);
console.log(`DB: ${dbFile}`);
if (onlyRoot) console.log(`Root filter: ${onlyRoot}`);
if (onlyHops) console.log(`Hop filter: ${onlyHops}`);
if (minProfitWei != null) console.log(`Min profit: ${minProfitWei} wei`);
console.log(`Min liquidity:      ${minPairReservesWei} wei`);
console.log(`Max ROI cap:        ${maxRoiPct}%`);
if (minProfitTokens != null)  console.log(`Min profit tokens:  ${minProfitTokens}`);
if (minInputTokens  != null)  console.log(`Min input tokens:   ${minInputTokens}`);
console.log('');

const result = await evaluateTriangles(cfg, dbFile, {
    onlyRoot, onlyHops, minProfitWei, limit, minPairReservesWei, maxRoiPct,
    minProfitTokens, minInputTokens,
});

console.log('\n' + '─'.repeat(60));
console.log(`Done in ${(result.elapsedMs / 1000).toFixed(2)}s`);
console.log(`  Triangles scored:    ${result.trianglesScored}`);
console.log(`  Triangles skipped:   ${result.trianglesSkipped} (dust or missing reserves)`);
console.log(`  Candidates found:    ${result.candidatesFound}`);
console.log(`  Profitable:          ${result.profitableCount}`);

if (result.topCandidates.length === 0) {
    console.log('\nNo profitable candidates.');
    process.exit(0);
}

// Look up symbols / decimals for pretty-print.
// Two-source lookup: config flashloan.tokens (curated) wins; the `tokens`
// table (fetched via `yarn tokens`) fills in everything else.
const tokenBySym = new Map<string, { symbol: string; decimals: number }>();
for (const t of cfg.flashloan?.tokens ?? []) {
    tokenBySym.set(t.address.toLowerCase(), { symbol: t.symbol, decimals: t.decimals });
}

// Collect all token addresses appearing in the top candidates (both root and
// hop-touched) and merge with tokens-table metadata for any we don't already
// have from the flashloan config.
const allTokenAddrs = new Set<string>();
for (const c of result.topCandidates) {
    allTokenAddrs.add(c.rootToken.toLowerCase());
    for (const h of c.hops) {
        allTokenAddrs.add(h.tokenIn.toLowerCase());
        allTokenAddrs.add(h.tokenOut.toLowerCase());
    }
}
const tokensTableMeta = (() => {
    const db = new ArbitradeDB(dbFile);
    try { return db.getTokens(Array.from(allTokenAddrs)); }
    finally { db.close(); }
})();
let tokensTableHits = 0;
for (const [addr, row] of tokensTableMeta) {
    if (tokenBySym.has(addr)) continue;  // config wins
    if (row.symbol && row.decimals !== null) {
        tokenBySym.set(addr, { symbol: row.symbol, decimals: row.decimals });
        tokensTableHits++;
    }
}
if (tokensTableHits > 0) {
    console.log(`  (loaded ${tokensTableHits} additional token symbol(s) from tokens table)`);
}

// Also look up factory names for hop display
const factoryByAddr = new Map<string, string>();
for (const f of cfg.factories) factoryByAddr.set(f.address.toLowerCase(), f.name);

const symOf = (addr: string) => tokenBySym.get(addr.toLowerCase())?.symbol ?? addr.slice(0, 10);
const decOf = (addr: string) => tokenBySym.get(addr.toLowerCase())?.decimals ?? 18;

console.log(`\nTop ${result.topCandidates.length} candidates:\n`);

for (const c of result.topCandidates) {
    const decimals = decOf(c.rootToken);
    const divisor = 10 ** decimals;
    const sym = symOf(c.rootToken);
    const inTokens  = c.inputAmount / divisor;
    const netTokens = c.netProfit / divisor;
    const roi = c.inputAmount > 0 ? (c.netProfit / c.inputAmount) * 100 : 0;
    console.log(
        `  #${c.triangleId.toString().padStart(6)} [${c.hopCount}h ${c.direction.padEnd(7)}] ` +
        `${sym.padEnd(5)}  in=${inTokens.toFixed(6).padStart(14)}  ` +
        `net=+${netTokens.toFixed(6).padStart(12)}  ROI=${roi.toFixed(3).padStart(7)}%`
    );
    if (verbose) {
        for (const h of c.hops) {
            const dex = factoryByAddr.get(h.factory.toLowerCase()) ?? h.factory.slice(0, 10);
            console.log(`         ${symOf(h.tokenIn).padEnd(5)} → ${symOf(h.tokenOut).padEnd(5)}  ${dex.padEnd(14)}  fee=${(h.fee*100).toFixed(3)}%  pair=${h.pair.slice(0,10)}`);
        }
    }
}
