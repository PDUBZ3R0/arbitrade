// -----------------------------------------------------------------------------
// yarn tokens <chain> [options]
//
// Populates the `tokens` table with symbol / name / decimals for every token
// referenced by any pair on the given chain. Uses Multicall3 (batched).
//
// Defaults are opinionated toward "the fast, useful case":
//   - Only fetch tokens that appear in a pair with non-zero reserves. This
//     skips scam / dead-scaffold tokens and cuts the working set roughly
//     in half without losing anything useful. Override with --all.
//   - Skip tokens already in the table with a terminal status (ok / reverted
//     / nocode). Override with --refresh to re-fetch everything.
//
// After running, evaluator output shows real symbols instead of 0x-addresses.
// -----------------------------------------------------------------------------

import 'dotenv/config';
import { JsonRpcProvider } from 'ethers';
import { loadChainConfig, dbPath, resolveChain } from './util/config.ts';
import { ArbitradeDB } from './util/db.ts';
import { populateTokenMetadata } from './util/token-metadata.ts';

const args = process.argv.slice(2);
const chainArg = args[0];

if (!chainArg || chainArg.startsWith('--')) {
    console.error('Usage: yarn tokens <chain> [options]');
    console.error('');
    console.error('  --all           Fetch metadata for ALL tokens (default: only those in pairs with reserves)');
    console.error('  --refresh       Re-fetch tokens already in the table');
    console.error('  --batch-size N  Multicall3 batch size (default: 30, drop to 10 on flaky RPCs)');
    console.error('');
    console.error('Reads pairs + reserves (populated by yarn scan / yarn reserves) to discover');
    console.error('which token addresses to look up. Persists to the `tokens` table for use by');
    console.error('evaluator display, discovery.json, and the phase-2 classifier.');
    process.exit(1);
}

const hasFlag = (f: string) => args.includes(f);
const getNum = (f: string, def: number) => {
    const i = args.indexOf(f);
    return (i >= 0 && args[i + 1]) ? Number(args[i + 1]) : def;
};

const useAll     = hasFlag('--all');
const refresh    = hasFlag('--refresh');
const batchSize  = getNum('--batch-size', 30);

const cfg  = loadChainConfig(chainArg);
const meta = resolveChain(chainArg);
const dbFile = dbPath(chainArg);

console.log(`=== tokens (${meta.label}) ===`);
console.log(`Chain:      ${cfg.chain.name} (id ${cfg.chain.id})`);
console.log(`DB:         ${dbFile}`);
console.log(`RPC:        ${cfg.chain.host}`);
console.log(`Filter:     ${useAll ? 'ALL pair tokens' : 'only tokens in pairs with reserves'}${refresh ? ' + refreshing already-fetched' : ''}`);
console.log(`Batch size: ${batchSize}\n`);

const provider = new JsonRpcProvider(cfg.chain.host);
const db = new ArbitradeDB(dbFile);

try {
    // If --refresh, wipe existing status so the discovery query picks them back up.
    if (refresh) {
        const cleared = db.db.prepare("DELETE FROM tokens").run().changes;
        console.log(`  Cleared ${cleared} existing token row(s) for full re-fetch\n`);
    }

    const t0 = Date.now();
    const result = await populateTokenMetadata(provider, db, {
        withReservesOnly: !useAll,
        batchSize,
        onProgress: (info) => {
            const pct = ((info.done / info.total) * 100).toFixed(1);
            process.stdout.write(
                `\r  ${pct.padStart(5)}% — ${info.done}/${info.total} tokens (${info.okSoFar} ok, ${info.revertedSoFar} bad)`
            );
        },
    });
    process.stdout.write('\n\n');

    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`${'─'.repeat(60)}`);
    console.log(`Done in ${secs}s`);
    console.log(`  Tokens fetched:  ${result.fetched}`);
    console.log(`  With metadata:   ${result.ok}`);
    console.log(`  Reverted:        ${result.reverted} (non-standard / no code)`);
    console.log('');

    // Show the current state of the tokens table
    const stats = db.tokenStats();
    console.log(`Tokens table totals: ${stats.total} rows (ok=${stats.ok}, reverted=${stats.reverted}, nocode=${stats.nocode}, pending=${stats.pending})`);

    // Show a couple of well-known tokens as sanity check
    if (result.ok > 0) {
        const flashTokens = cfg.flashloan?.tokens ?? [];
        if (flashTokens.length > 0) {
            const rows = db.getTokens(flashTokens.map(t => t.address));
            const hits = flashTokens
                .map(t => rows.get(t.address.toLowerCase()))
                .filter(r => r && r.fetchStatus === 'ok');
            if (hits.length > 0) {
                console.log(`\nSanity check — flashloan tokens successfully fetched:`);
                for (const r of hits.slice(0, 5)) {
                    console.log(`  ${r!.address}  ${r!.symbol} (${r!.name}) decimals=${r!.decimals}`);
                }
            }
        }
    }
} finally {
    db.close();
}
