// -----------------------------------------------------------------------------
// CLI: yarn db-clean <chain> [--yes]
//
// Deletes orphan pairs — pairs whose factory address is no longer in the
// current config. Dry-run by default; pass --yes to actually delete.
//
// Common cause of orphans: a prior scan ran with a config that included
// factories which have since been removed (renamed, moved to a different
// chain file, or excluded because they weren't useful).
// -----------------------------------------------------------------------------

import { loadChainConfig, dbPath } from './util/config.ts';
import { ArbitradeDB } from './util/db.ts';

const args = process.argv.slice(2);
const chainArg = args[0];
if (!chainArg || chainArg.startsWith('--')) {
    console.error('Usage: yarn db-clean <chain> [--yes]');
    console.error('');
    console.error('  --yes    Actually delete the orphan pairs (default: dry-run only)');
    console.error('');
    console.error('Shows pairs whose factory is not in the current config.');
    console.error('Also deletes any reserves rows for those pairs (cascade).');
    process.exit(1);
}

const cfg = loadChainConfig(chainArg);
const dbFile = dbPath(chainArg);
const doDelete = args.includes('--yes');

console.log(`Scanning ${cfg.chain.name} database for orphan pairs`);
console.log(`DB: ${dbFile}`);
console.log(`Current config has ${cfg.factories.length} factor${cfg.factories.length === 1 ? 'y' : 'ies'}:`);
for (const f of cfg.factories) console.log(`  ${f.address.toLowerCase()}  ${f.name} (${f.group})`);
console.log('');

const db = new ArbitradeDB(dbFile);
const currentFactoryAddrs = cfg.factories.map(f => f.address);
const orphans = db.countOrphanPairs(currentFactoryAddrs);

if (orphans.length === 0) {
    console.log('No orphan pairs found. DB is clean.');
    db.close();
    process.exit(0);
}

const totalPairs = orphans.reduce((n, o) => n + o.count, 0);
console.log(`Found ${totalPairs} orphan pair(s) across ${orphans.length} factor${orphans.length === 1 ? 'y' : 'ies'}:\n`);
for (const o of orphans) {
    console.log(`  ${o.factory}  →  ${o.count} pair(s)`);
}
console.log('');

if (!doDelete) {
    console.log('This is a DRY RUN. To actually delete, re-run with --yes:');
    console.log(`  yarn db-clean ${chainArg} --yes`);
    db.close();
    process.exit(0);
}

console.log('Deleting orphan pairs and their reserves rows...');
const deleted = db.deleteOrphanPairs(currentFactoryAddrs);
console.log(`Deleted ${deleted} pair(s).`);
db.close();
