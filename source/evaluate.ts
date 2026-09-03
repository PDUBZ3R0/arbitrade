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
    console.error('  --min-profit-tokens N    Minimum profit, denominated in the chain\'s numeraire');
    console.error('                           token (cfg.chain.token — e.g. WXDAI on Gnosis, wS on');
    console.error('                           Sonic, WETH on Base). Converted per-root via the best-');
    console.error('                           liquidity direct DEX pair between that root and the');
    console.error('                           numeraire. Default comes from conf/<chain>.json5\'s');
    console.error('                           "evaluator" block if set, else falls back to 0.001.');
    console.error('                           Set 0 to disable.');
    console.error('  --min-input-tokens N     Minimum optimal input, same numeraire conversion as');
    console.error('                           above (chain-tuned default, else 0.001; filters');
    console.error('                           dust-input phantoms)');
    console.error('  --min-liquidity-tokens N Skip pairs where either side has < N WHOLE TOKENS of');
    console.error('                           reserves (default 0.001). Decimals-aware — uses the');
    console.error('                           tokens table / flashloan config per-token, so this is');
    console.error('                           correct for mixed-decimal chains (e.g. USDC 6-dec next');
    console.error('                           to an 18-dec token). Use this, not --min-liquidity.');
    console.error('  --min-liquidity N        DEPRECATED: flat wei threshold applied on top of');
    console.error('                           --min-liquidity-tokens, decimal-BLIND (1e18 wei is "1');
    console.error('                           token" for 18-dec but "1 trillion" for 6-dec like USDC —');
    console.error('                           silently kills every pair on that token). Default 0 (off).');
    console.error('  --max-roi-pct N          Skip candidates with ROI above N%. Real arb is under');
    console.error('                           a few percent; default 20 catches phantoms while');
    console.error('                           keeping legitimate opportunities. Set 100 for raw.');
    console.error('  --limit N                Show top N candidates only (default 20)');
    console.error('  --verbose                Show hop details for each candidate');
    console.error('  --debug                  Print per-triangle detail (reserves, decimals, fee,');
    console.error('                           computed ROI) for a sample of FILTERED triangles — use');
    console.error('                           this to audit whether a filter is behaving correctly');
    console.error('                           against real numbers instead of trusting it blind.');
    console.error('  --debug-limit N          Cap on triangles printed in --debug mode (default 25)');
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

const cfg = loadChainConfig(chainArg);
const dbFile = dbPath(chainArg);

// Chain-tuned defaults from conf/<chain>.json5's `evaluator` block (falls
// back to the old global defaults if a chain hasn't set one). See
// config.ts's RawChainConfig.evaluator doc for why a single global number
// doesn't work well across chains with wildly different root-token prices.
const chainDefaults = cfg.evaluator ?? {};

const onlyRoot   = getStr('--root');
const hopsStr    = getStr('--hops');
const onlyHops   = hopsStr === '2' ? 2 : hopsStr === '3' ? 3 : undefined;
const minProfitStr = getStr('--min-profit');
const minProfitWei = minProfitStr ? BigInt(minProfitStr) : undefined;
const minProfitTokensStr = getStr('--min-profit-tokens');
const minProfitTokens = minProfitTokensStr ? parseFloat(minProfitTokensStr) : (chainDefaults.minProfitTokens ?? 0.001);
const minInputTokensStr = getStr('--min-input-tokens');
const minInputTokens = minInputTokensStr ? parseFloat(minInputTokensStr) : (chainDefaults.minInputTokens ?? 0.001);

// Decimals-aware liquidity filter, in whole tokens. Chain-tuned default (see
// above), falling back to 0.001 if the chain hasn't set one. See
// evaluator.ts's EvaluateOptions doc for why the old --min-liquidity (flat
// wei) was silently wrong for non-18-decimal tokens.
const minLiquidityTokensStr = getStr('--min-liquidity-tokens');
const minLiquidityTokens = minLiquidityTokensStr ? parseFloat(minLiquidityTokensStr) : (chainDefaults.minLiquidityTokens ?? 0.001);

// DEPRECATED flat-wei floor. Default 0 (off) — the old 1e18 default is what
// caused mixed-decimal chains (Gnosis: USDC/USDCe alongside 18-dec tokens)
// to silently lose most/all candidates. Only applies if explicitly passed.
const minLiqStr = getStr('--min-liquidity');
const minPairReservesWei = minLiqStr ? BigInt(minLiqStr) : undefined;
if (minLiqStr) {
    console.log(`[!] --min-liquidity is deprecated and decimal-blind. Consider --min-liquidity-tokens instead.`);
}

const maxRoiStr = getStr('--max-roi-pct');
// Default 20% — real arb rarely exceeds a few percent; anything above 20%
// on Sonic/Gnosis/Base/etc is almost always a math phantom. Bump higher
// (--max-roi-pct 100) if debugging.
const maxRoiPct = maxRoiStr ? parseFloat(maxRoiStr) : 20;
const limitStr   = getStr('--limit');
const limit      = limitStr ? parseInt(limitStr, 10) : 20;
const verbose    = hasFlag('--verbose');
const debug      = hasFlag('--debug');
const debugLimitStr = getStr('--debug-limit');
const debugLimit = debugLimitStr ? parseInt(debugLimitStr, 10) : 25;

console.log(`Evaluating triangles for ${cfg.chain.name} (chain id ${cfg.chain.id})`);
console.log(`DB: ${dbFile}`);
if (onlyRoot) console.log(`Root filter: ${onlyRoot}`);
if (onlyHops) console.log(`Hop filter: ${onlyHops}`);
if (minProfitWei != null) console.log(`Min profit: ${minProfitWei} wei`);
console.log(`Min liquidity (tokens, decimals-aware): ${minLiquidityTokens}${minLiquidityTokensStr ? '' : (chainDefaults.minLiquidityTokens != null ? '  (from conf/' + cfg.chain.label + '.json5)' : '  (global default)')}`);
if (minPairReservesWei != null) console.log(`Min liquidity (LEGACY flat wei):        ${minPairReservesWei}`);
console.log(`Max ROI cap:        ${maxRoiPct}%`);
console.log(`Min profit tokens:  ${minProfitTokens}${minProfitTokensStr ? '' : (chainDefaults.minProfitTokens != null ? '  (from conf/' + cfg.chain.label + '.json5)' : '  (global default)')}`);
console.log(`Min input tokens:   ${minInputTokens}${minInputTokensStr ? '' : (chainDefaults.minInputTokens != null ? '  (from conf/' + cfg.chain.label + '.json5)' : '  (global default)')}`);
console.log('');

const result = await evaluateTriangles(cfg, dbFile, {
    onlyRoot, onlyHops, minProfitWei, limit,
    minLiquidityTokens, minPairReservesWei, maxRoiPct,
    minProfitTokens, minInputTokens,
    debug, debugLimit,
});

// Show exactly how each root token's threshold was resolved — a root priced
// via a real DEX pair vs one that fell back to the flat-fraction default are
// very different levels of trust, worth seeing before trusting the results.
const pricedRoots = Object.entries(result.rootPricing);
if (pricedRoots.length > 0) {
    console.log('Root token thresholds:');
    for (const [addr, p] of pricedRoots) {
        const sym = p.symbol ?? addr.slice(0, 10);
        if (p.priceInNumeraire != null) {
            const via = p.sourceLiquidity != null
                ? ` (via direct pair, numeraire-side liquidity ≈ ${p.sourceLiquidity.toFixed(4)})`
                : ' (this is the numeraire itself)';
            console.log(`  ${sym.padEnd(8)} price=${p.priceInNumeraire.toFixed(8)} numeraire/token${via}  minProfit=${p.minProfitInRootTokens.toFixed(8)} ${sym}`);
        } else {
            console.log(`  ${sym.padEnd(8)} NO PRICE PATH — using flat fraction directly: minProfit=${p.minProfitInRootTokens.toFixed(8)} ${sym}`);
        }
    }
    console.log('');
}

console.log('\n' + '─'.repeat(60));
console.log(`Done in ${(result.elapsedMs / 1000).toFixed(2)}s`);
console.log(`  Triangles scored:    ${result.trianglesScored}`);
console.log(`  Triangles skipped:   ${result.trianglesSkipped}`);
console.log(`    missing pair:        ${result.skipReasons.missingPair}`);
console.log(`    missing reserves:    ${result.skipReasons.missingReserves}`);
console.log(`    dust liquidity:      ${result.skipReasons.dustLiquidity}`);
console.log(`    below min profit:    ${result.skipReasons.belowMinProfit}`);
console.log(`    below min input:     ${result.skipReasons.belowMinInput}`);
console.log(`    ROI cap exceeded:    ${result.skipReasons.roiCapExceeded}`);
console.log(`  (not counted as "skipped" — no positive spread at all: ${result.skipReasons.notProfitable})`);
if (result.tokensWithUnknownDecimals > 0) {
    console.log(`  [!] ${result.tokensWithUnknownDecimals} token(s) had unknown decimals (defaulted to 18) — run \`yarn tokens ${cfg.chain.label}\``);
}
console.log(`  Candidates found:    ${result.candidatesFound}`);
console.log(`  Profitable:          ${result.profitableCount}`);

if (result.topCandidates.length === 0) {
    console.log('\nNo profitable candidates.');
    if (result.skipReasons.dustLiquidity > result.trianglesScored) {
        console.log(`Most triangles were dropped by the liquidity filter (${result.skipReasons.dustLiquidity}).`);
        console.log(`Re-run with --debug to see exact reserves/decimals for a sample, or --min-liquidity-tokens 0 to disable it entirely and check whether that's the cause.`);
    }
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
