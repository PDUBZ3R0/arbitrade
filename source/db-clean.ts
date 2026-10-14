// -----------------------------------------------------------------------------
// CLI: yarn db-clean <chain> [--empty] [--yes]
//
// Default: deletes orphan pairs — pairs whose factory address is no longer in
// the current config. Common cause: a prior scan ran with a config that
// included factories which have since been removed (renamed, moved to a
// different chain file, or excluded because they weren't useful).
//
// --empty: also finds configured factories with NO pairs in the DB that were
// genuinely scanned for nothing, blacklists them (conf/<chain>-blacklist.json5)
// and forgets them in the DB (factories row + scan progress). "Genuinely" is
// the whole point — 0 pairs is also what a factory looks like when it was
// never scanned, scanned for the wrong creation event (Sonic's SwapX Algebra
// and Atlantis, 2026-10-13: 0 pools, progress at the head), or only part-way
// scanned. A factory is only eligible when:
//   - its scan progress is recorded FOR THE CREATION EVENT IT IS CONFIGURED
//     WITH (legacy rows without a topic are not trusted), and
//   - that progress is within --window blocks (default 200,000) of the most
//     advanced factory's, i.e. the scan reached (near) the head.
// Everything else is listed with the reason it was left alone.
//
// --prune-conf: removes every blacklisted factory (the file's, plus any
// --empty just added) from conf/<chain>.json5 itself. The blacklist already
// keeps them out of every stage; this is tidiness — a shorter conf, and
// find-factories no longer sees them as configured. The edit is to the text,
// so the file's other comments survive; each removed entry leaves a one-line
// `// removed <key> (<address>) — blacklisted …` note where it was. The
// blacklist entry stays, so a later find-factories --add won't re-add it.
//
// Dry-run by default; pass --yes to delete / blacklist / edit. Blacklisting is
// the reversible part: remove the entry from the blacklist file and the next
// `yarn scan` rescans the factory from its deploy block (after --prune-conf,
// put its conf entry back too).
// -----------------------------------------------------------------------------

import { loadChainConfig, dbPath } from './util/config.ts';
import { ArbitradeDB } from './util/db.ts';
import { appendToBlacklist, loadBlacklist } from './util/blacklist.ts';
import { removalsFor, editFactoriesInConf } from './util/conf-edit.ts';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { layoutOf } from './scanner/pairs.ts';
import { TOPIC_BY_LAYOUT } from './util/pool-events.ts';

const args = process.argv.slice(2);
const chainArg = args[0];
if (!chainArg || chainArg.startsWith('--')) {
    console.error('Usage: yarn db-clean <chain> [--empty [--window <blocks>]] [--prune-conf] [--yes]');
    console.error('');
    console.error('  --yes      Actually delete / blacklist (default: dry-run only)');
    console.error('  --empty    Also blacklist configured factories that were scanned (for their');
    console.error('             configured creation event, to near the head) and have no pairs');
    console.error('  --window   How close to the most-scanned factory a scan must be to count as');
    console.error('             complete (default 200000 blocks)');
    console.error('  --prune-conf  Remove blacklisted factories from conf/<chain>.json5 (comments kept;');
    console.error('             a one-line note marks each removal)');
    console.error('');
    console.error('Without --empty: shows pairs whose factory is not in the current config, and');
    console.error('deletes them and their reserves rows with --yes.');
    process.exit(1);
}
const flagValue = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
};

const cfg = loadChainConfig(chainArg);
const dbFile = dbPath(chainArg);
const doDelete = args.includes('--yes');
const doEmpty = args.includes('--empty');
const doPrune = args.includes('--prune-conf');
const window = Number(flagValue('--window') ?? 200_000);
if (!Number.isFinite(window) || window < 0) { console.error(`--window must be a block count, got ${flagValue('--window')}`); process.exit(1); }

console.log(`Scanning ${cfg.chain.name} database for orphan pairs${doEmpty ? ' and empty factories' : ''}`);
console.log(`DB: ${dbFile}`);
console.log(`Current config has ${cfg.factories.length} factor${cfg.factories.length === 1 ? 'y' : 'ies'}:`);
for (const f of cfg.factories) console.log(`  ${f.address.toLowerCase()}  ${f.name} (${f.group})`);
console.log('');

const db = new ArbitradeDB(dbFile);
let pending = false;

// ---- orphan pairs ------------------------------------------------------------
const currentFactoryAddrs = cfg.factories.map(f => f.address);
const orphans = db.countOrphanPairs(currentFactoryAddrs);
if (orphans.length === 0) {
    console.log('No orphan pairs found.');
} else {
    const totalPairs = orphans.reduce((n, o) => n + o.count, 0);
    console.log(`Found ${totalPairs} orphan pair(s) across ${orphans.length} factor${orphans.length === 1 ? 'y' : 'ies'}:\n`);
    for (const o of orphans) console.log(`  ${o.factory}  →  ${o.count} pair(s)`);
    console.log('');
    if (doDelete) {
        console.log('Deleting orphan pairs and their reserves rows...');
        console.log(`Deleted ${db.deleteOrphanPairs(currentFactoryAddrs)} pair(s).`);
    } else {
        pending = true;
    }
}

// ---- empty factories ---------------------------------------------------------
if (doEmpty) {
    console.log('');
    const counts = db.pairCountsByFactory();
    const progress = db.getAllScanProgress();
    const configured = new Set(cfg.factories.map(f => f.address.toLowerCase()));
    // "The head", as far as this DB knows: the most advanced configured factory.
    let head = 0;
    for (const [a, p] of progress) if (configured.has(a) && p.lastBlock > head) head = p.lastBlock;

    const empty: Array<{ address: string; name: string; group: string; lastBlock: number; topic: string }> = [];
    const leftAlone: Array<{ address: string; name: string; why: string }> = [];
    for (const f of cfg.factories) {
        const a = f.address.toLowerCase();
        if ((counts.get(a) ?? 0) > 0) continue;
        const topic = TOPIC_BY_LAYOUT[layoutOf(f)].toLowerCase();
        const p = progress.get(a);
        if (!p) { leftAlone.push({ address: a, name: f.name, why: 'never scanned — run yarn scan first' }); continue; }
        if (!p.topic) { leftAlone.push({ address: a, name: f.name, why: `scanned to ${p.lastBlock} before creation events were recorded — confirm with: yarn scan ${chainArg} --rescan ${a}` }); continue; }
        if (p.topic !== topic) { leftAlone.push({ address: a, name: f.name, why: `scanned for a different creation event (${p.topic.slice(0, 10)}, configured ${topic.slice(0, 10)}) — the next yarn scan rescans it` }); continue; }
        if (p.lastBlock < head - window) { leftAlone.push({ address: a, name: f.name, why: `scan incomplete: at block ${p.lastBlock}, ${head - p.lastBlock} behind — finish yarn scan first` }); continue; }
        empty.push({ address: a, name: f.name, group: f.group, lastBlock: p.lastBlock, topic });
    }

    if (empty.length === 0) {
        console.log('No scanned-and-empty factories.');
    } else {
        console.log(`${empty.length} configured factor${empty.length === 1 ? 'y has' : 'ies have'} no pairs after a complete scan for ${empty.length === 1 ? 'its' : 'their'} configured creation event:\n`);
        for (const e of empty) console.log(`  ${e.address}  ${e.name} (${e.group}) — scanned to ${e.lastBlock}`);
        console.log('');
        if (doDelete) {
            const today = new Date().toISOString().slice(0, 10);
            const r = appendToBlacklist(cfg.chain.label, empty.map(e => ({
                address: e.address,
                reason: `${e.name} (${e.group}): no pairs after a scan to block ${e.lastBlock} for event ${e.topic.slice(0, 10)} — db-clean --empty`,
                addedAt: today,
            })));
            for (const e of empty) db.forgetFactory(e.address);
            console.log(`Blacklisted ${r.added} factor${r.added === 1 ? 'y' : 'ies'} in conf/${cfg.chain.label}-blacklist.json5` +
                (r.skipped ? ` (${r.skipped} already there)` : '') + `, and removed ${empty.length === 1 ? 'it' : 'them'} from the DB.`);
            console.log('  To bring one back: delete its entry from the blacklist file; the next yarn scan rescans it from its deploy block.');
        } else {
            pending = true;
        }
    }
    if (leftAlone.length) {
        console.log(`\nLeft alone — no pairs, but not proven empty (${leftAlone.length}):`);
        for (const l of leftAlone) console.log(`  ${l.address}  ${l.name}: ${l.why}`);
    }
}

// ---- prune blacklisted factories from the conf ------------------------------
if (doPrune) {
    console.log('');
    const confDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'conf');
    const confFile = path.join(confDir, `${cfg.chain.label}.json5`);
    const bl = loadBlacklist(cfg.chain.label).factories;
    const why = new Map(bl.map(b => [b.address, `blacklisted${b.addedAt ? ` ${b.addedAt}` : ''}${b.reason ? `: ${b.reason}` : ''}`]));
    const removals = removalsFor(fs.readFileSync(confFile, 'utf8'), why)
        .map(r => ({ ...r, note: `removed ${r.key} (${r.address}) — ${(why.get(r.address) ?? 'blacklisted').slice(0, 200)}` }));
    if (removals.length === 0) {
        console.log(`No blacklisted factories left in conf/${cfg.chain.label}.json5.`);
    } else {
        console.log(`${removals.length} blacklisted factor${removals.length === 1 ? 'y is' : 'ies are'} still in conf/${cfg.chain.label}.json5:\n`);
        for (const r of removals) console.log(`  factories.${r.group}.${r.key}  ${r.address}`);
        if (doDelete) {
            try {
                editFactoriesInConf(confDir, cfg.chain.label, removals);
                console.log(`\nRemoved ${removals.length} from conf/${cfg.chain.label}.json5 (a note marks each; other comments kept). The blacklist entries stay.`);
            } catch (err) {
                console.error(`\n[!] conf/${cfg.chain.label}.json5 not changed: ${(err as Error).message}`);
                process.exitCode = 1;
            }
        } else {
            pending = true;
        }
    }
}
if (doPrune && doEmpty && !doDelete) {
    console.log('  (factories --empty would blacklist are not counted above until it runs with --yes)');
}

if (pending) {
    console.log('\nThis is a DRY RUN. To apply, re-run with --yes:');
    console.log(`  yarn db-clean ${chainArg}${doEmpty ? ' --empty' : ''}${flagValue('--window') ? ` --window ${window}` : ''}${doPrune ? ' --prune-conf' : ''} --yes`);
} else if (orphans.length === 0 && !doEmpty && !doPrune) {
    console.log('DB is clean.');
}
db.close();
