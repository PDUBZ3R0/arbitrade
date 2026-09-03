// -----------------------------------------------------------------------------
// CLI: yarn reserves <chain> [options]
//
// Refreshes reserves (and Solidly metadata where applicable) for pairs in the
// per-chain SQLite database. Skips zero-reserve pairs. Fetches Solidly per-pair
// fee/stable only for pairs that don't already have them, unless --refresh-metadata.
// -----------------------------------------------------------------------------

import { loadChainConfig, dbPath } from './util/config.ts';
import { fetchReserves } from './reserves/fetcher.ts';

const args = process.argv.slice(2);
const chainArg = args[0];
if (!chainArg || chainArg.startsWith('--')) {
    console.error('Usage: yarn reserves <chain> [options]');
    console.error('');
    console.error('  --max-age N            Only refresh pairs with reserves older than N seconds');
    console.error('                         (also includes pairs that have never been fetched)');
    console.error('  --factory ADDR         Only refresh pairs from this factory');
    console.error('  --refresh-metadata     Refetch v2fee/solidly fee (and stable, where applicable)');
    console.error('                         even if already populated');
    console.error('  --strict               Skip pairs whose factory is not in the current config');
    console.error('                         (use yarn db-clean <chain> to delete them permanently)');
    console.error('  --dust N               Treat pairs with < N numeraire-token-worth on either');
    console.error('                         side as dust, converted per-token via the best DB-known');
    console.error('                         direct pair against cfg.chain.token (requires `yarn');
    console.error('                         tokens <chain>` to have been run; reasonable values:');
    console.error('                         0.001, 0.01, 0.1). Default comes from conf/<chain>.json5\'s');
    console.error('                         "reserves.dust" if set, else 0 (off).');
    console.error('  --blacklist-dead       Auto-append DEAD factories to conf/<chain>-blacklist.json5');
    console.error('                         after the summary. Idempotent — existing entries preserved.');
    console.error('  --concurrency N        Parallel batches per factory (default: chain.threads or 4)');
    console.error('                         HyperRPC handles 8-16 easily; low-tier public RPCs may throttle at 4+');
    console.error('');
    console.error('Default: full refresh, fetch missing per-pair metadata only.');
    process.exit(1);
}

const getStr = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return (i >= 0 && args[i + 1]) ? args[i + 1] : undefined;
};
const hasFlag = (flag: string): boolean => args.indexOf(flag) >= 0;

const cfg = loadChainConfig(chainArg);
const dbFile = dbPath(chainArg);

const maxAgeStr = getStr('--max-age');
const maxAge = maxAgeStr ? parseInt(maxAgeStr, 10) : undefined;
const factory = getStr('--factory');
const refreshMetadata = hasFlag('--refresh-metadata');
const strict = hasFlag('--strict');
const dustStr = getStr('--dust');
// Chain-tuned default from conf/<chain>.json5's `reserves.dust` (same
// numeraire-conversion source as evaluate.ts's `evaluator` block), falling
// back to 0 (off) if the chain hasn't set one.
const dustThreshold = dustStr ? Number(dustStr) : (cfg.reserves?.dust ?? 0);
const autoBlacklistDead = hasFlag('--blacklist-dead');
const concurrencyStr = getStr('--concurrency');
const concurrency = concurrencyStr ? Number(concurrencyStr) : undefined;

console.log(`Refreshing reserves for ${cfg.chain.currency} (chain id ${cfg.chain.id})`);
console.log(`DB:  ${dbFile}`);
if (maxAge !== undefined) console.log(`Max age filter: ${maxAge}s`);
if (factory) console.log(`Factory filter: ${factory}`);
if (refreshMetadata) console.log(`Refreshing per-pair metadata even for already-populated pairs`);
if (strict) console.log(`Strict mode: skipping pairs from factories not in current config`);
if (dustThreshold > 0) {
    const src = dustStr ? '' : (cfg.reserves?.dust != null ? `  (from conf/${cfg.chain.label}.json5)` : '  (default)');
    console.log(`Dust threshold: ${dustThreshold}${src}`);
}
if (autoBlacklistDead) console.log(`Auto-blacklist DEAD factories: ON (will write to conf/<chain>-blacklist.json5)`);

const t0 = Date.now();
const result = await fetchReserves(cfg, dbFile, { maxAgeSeconds: maxAge, factory, refreshMetadata, strict, dustThreshold, autoBlacklistDead, concurrency });

console.log('\n' + '─'.repeat(60));
console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(`  Reserves upserted:  ${result.reservesUpdated}`);
console.log(`  Zero-reserve skips: ${result.reservesSkipped}`);
console.log(`  Metadata updated:   ${result.metadataUpdated}`);
if (result.errors.length > 0) {
    console.log(`  Errors (${result.errors.length}):`);
    for (const err of result.errors.slice(0, 5)) console.log(`    - ${err}`);
    if (result.errors.length > 5) console.log(`    ... and ${result.errors.length - 5} more`);
}
