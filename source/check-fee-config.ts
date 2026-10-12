// -----------------------------------------------------------------------------
// CLI: yarn check-fee-config <chain> [--apply] [--factory <address|name>]
//
// Does every per-pair-fee factory (v2fee / solidly groups) answer its configured
// fee call? `yarn reserves` makes exactly that call for every pair, and stops
// the whole run when a factory's first batch comes back empty ("Metadata fetch
// is failing for …"). This finds those factories up front, for all of them at
// once, and says what does answer.
//
// Per factory, on up to 3 of its pairs from the DB (most active first):
//   1. The configured accessor — feeTarget / feeArgSource / feeFunction /
//      feeDivisor as config.ts resolves them, pattern defaults included —
//      called the way reserves calls it (util/interface-probe.ts tryPattern).
//      Plausible fees (0.005%–5%) on at least half the samples → OK. (A wide
//      spread is fine: stable and volatile pools differ by 10x and more.)
//   2. Otherwise every registered DEX pattern of the factory's family is
//      probed. A high/medium-confidence match → FIX (the fields to set);
//      only low-confidence matches → REVIEW (shown, never applied).
//   3. Nothing answers → UNREADABLE: reserves cannot price these pairs.
// Flat-fee entries (fee / stableFees) make no call and are not checked.
//
// Typical cause: find-factories --add trusted a contract NAME ("PairFactory",
// "PoolFactory" — what half of all Solidly forks are called) as proof of a
// pattern's fee accessor. It no longer does; this repairs entries it added.
//
// --apply  FIX: rewrite the entry's fee fields in conf/<chain>.json5 (comment-
//          preserving, verified before writing) and clear the fee of its pairs
//          in the DB, so the next `yarn reserves` reads them through the new
//          accessor. UNREADABLE: blacklist (conf/<chain>-blacklist.json5).
// Free: eth_calls only.
// -----------------------------------------------------------------------------

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadChainConfig, dbPath, type NormalizedFactory } from './util/config.ts';
import { ArbitradeDB } from './util/db.ts';
import { makeProvider } from './util/rpc.ts';
import { tryPattern, probeFactoryInterface, type SamplePair } from './util/interface-probe.ts';
import type { DexPattern } from './util/dex-patterns.ts';
import { editFactoriesInConf, type FactoryEdit } from './util/conf-edit.ts';
import { appendToBlacklist } from './util/blacklist.ts';

const args = process.argv.slice(2);
const chainArg = args[0];
if (!chainArg || chainArg.startsWith('--')) {
    console.error('Usage: yarn check-fee-config <chain> [--apply] [--factory <address|name>]');
    console.error('');
    console.error('  Calls each v2fee/solidly factory\'s configured per-pair fee accessor the way');
    console.error('  `yarn reserves` does, and probes the known patterns when it does not answer.');
    console.error('  --apply   rewrite broken entries to the accessor that answers (and clear their');
    console.error('            pairs\' fees in the DB); blacklist factories nothing answers for.');
    process.exit(1);
}
const apply = args.includes('--apply');
const only = (() => { const i = args.indexOf('--factory'); return i >= 0 ? args[i + 1]?.toLowerCase() : undefined; })();

const cfg = loadChainConfig(chainArg);
const provider = makeProvider(cfg.chain);
const db = new ArbitradeDB(dbPath(chainArg));
const today = new Date().toISOString().slice(0, 10);

const perPair = cfg.factories.filter(f =>
    (f.group === 'v2fee' || f.group === 'solidly') && f.fee == null && !f.stableFees
    && (!only || f.address.toLowerCase() === only || f.name.toLowerCase() === only));

/** The accessor config.ts resolved for this factory, as a probe pattern. */
const asPattern = (f: NormalizedFactory): DexPattern => ({
    family: f.group as 'v2fee' | 'solidly',
    feeTarget: f.feeTarget, feeArgSource: f.feeArgSource, feeFunction: f.feeFunction, feeDivisor: f.feeDivisor,
} as DexPattern);
const describe = (p: Pick<DexPattern, 'feeTarget' | 'feeArgSource' | 'feeFunction' | 'feeDivisor'>) =>
    `${p.feeTarget === 'pair' ? 'pair' : 'factory'}.${p.feeFunction}(${p.feeTarget === 'pair' ? '' : p.feeArgSource ?? 'pair-address'}) / ${p.feeDivisor}`;
const fmtFees = (xs: number[]) => [...new Set(xs.map(x => +(x * 100).toFixed(4)))].join('/') + '%';

type Verdict = { f: NormalizedFactory; status: 'OK' | 'FIX' | 'REVIEW' | 'UNREADABLE' | 'NO-SAMPLE'; detail: string; fix?: { name: string; pattern: DexPattern } };
const verdicts: Verdict[] = [];

console.log(`${cfg.chain.name}: checking the fee accessor of ${perPair.length} per-pair-fee factor${perPair.length === 1 ? 'y' : 'ies'}\n`);
for (const f of perPair) {
    const picks = db.getPairsForFactory(f.address, 3);
    if (picks.length === 0) {
        verdicts.push({ f, status: 'NO-SAMPLE', detail: 'no pairs in the DB yet (run yarn scan first)' });
        continue;
    }
    const stableOf = db.db.prepare('SELECT stable FROM pairs WHERE address = ?');
    const samples: SamplePair[] = picks.map(p => {
        const s = (stableOf.get(p.pair.toLowerCase()) as { stable: number | null } | undefined)?.stable;
        return { pair: p.pair, stable: s == null ? null : s === 1 };
    });

    const mine = await tryPattern(provider, f.address, samples, 'configured', asPattern(f));
    if (mine && mine.sampleFeesAdjusted.length * 2 >= samples.length) {
        verdicts.push({ f, status: 'OK', detail: `${describe(f)} → ${fmtFees(mine.sampleFeesAdjusted)} on ${mine.sampleFeesAdjusted.length}/${samples.length}` });
        continue;
    }
    const why = mine ? `configured ${describe(f)} answered on only ${mine.sampleFeesAdjusted.length}/${samples.length} pairs`
        : `configured ${describe(f)} returned nothing plausible on ${samples.length}/${samples.length} pairs`;
    const matches = await probeFactoryInterface(provider, f.address, samples, f.group as 'v2fee' | 'solidly');
    const rank = { high: 0, medium: 1, low: 2 };
    matches.sort((a, b) => rank[a.confidence] - rank[b.confidence]);
    const best = matches[0];
    if (best) {
        verdicts.push({
            f, status: best.confidence === 'low' ? 'REVIEW' : 'FIX',
            detail: `${why}; ${best.patternName} answers: ${describe(best.pattern)} → ${fmtFees(best.sampleFeesAdjusted)} [${best.confidence}: ${best.reason}]`,
            fix: { name: best.patternName, pattern: best.pattern },
        });
    } else {
        verdicts.push({ f, status: 'UNREADABLE', detail: `${why}; no registered pattern answers either` });
    }
}

const width = Math.max(10, ...verdicts.map(v => v.f.name.length));
for (const v of verdicts) console.log(`  ${v.f.name.padEnd(width)} ${v.status.padEnd(10)} ${v.detail}`);
const count = (s: Verdict['status']) => verdicts.filter(v => v.status === s).length;
console.log(`\n  OK ${count('OK')}   FIX ${count('FIX')}   REVIEW ${count('REVIEW')}   UNREADABLE ${count('UNREADABLE')}   NO-SAMPLE ${count('NO-SAMPLE')}`);

const fixes = verdicts.filter(v => v.status === 'FIX');
const dead = verdicts.filter(v => v.status === 'UNREADABLE');
if (!apply) {
    if (fixes.length || dead.length) console.log(`\nReport only. --apply rewrites the ${fixes.length} FIX entr${fixes.length === 1 ? 'y' : 'ies'} and blacklists the ${dead.length} UNREADABLE.`);
    db.close();
    process.exit(0);
}

// --- apply ------------------------------------------------------------------
if (fixes.length) {
    const edits: FactoryEdit[] = fixes.map(v => {
        const p = v.fix!.pattern;
        // Every accessor field explicit: config.ts fills gaps from a pattern
        // named like the KEY, which is how the wrong accessor got here.
        const fields: Record<string, string | number | boolean> = {
            feeTarget: p.feeTarget ?? 'factory',
            feeArgSource: p.feeArgSource ?? 'pair-address',
            feeFunction: p.feeFunction!,
            feeDivisor: p.feeDivisor!,
        };
        if (v.f.group === 'v2fee') fields.hasStableFlag = !!(p.hasStableFlag || v.f.hasStableFlag);
        return {
            kind: 'setFields', group: v.f.group as FactoryEdit['group'], key: v.f.name, address: v.f.address, fields,
            comment: `check-fee-config ${today}: ${describe(asPattern(v.f))} did not answer; ${v.fix!.name} does (${describe(p)})`,
        };
    });
    const confDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'conf');
    try {
        editFactoriesInConf(confDir, cfg.chain.label, edits);
    } catch (e) {
        console.log(`\n[✗] conf/${cfg.chain.label}.json5 not edited, nothing applied: ${(e as Error).message}`);
        db.close();
        process.exit(1);
    }
    const clear = db.db.prepare('UPDATE pairs SET fee = NULL WHERE factory = ?');
    let cleared = 0;
    db.db.transaction(() => { for (const v of fixes) cleared += clear.run(v.f.address.toLowerCase()).changes; })();
    for (const v of fixes) console.log(`  fixed     ${v.f.name.padEnd(width)} → ${v.fix!.name}: ${describe(v.fix!.pattern)}`);
    console.log(`            ${cleared} pair fee(s) cleared in the DB — the next yarn reserves reads them through the new accessor`);
}
if (dead.length) {
    const { added, skipped } = appendToBlacklist(cfg.chain.label, dead.map(v => ({
        address: v.f.address,
        reason: `check-fee-config ${today} UNREADABLE (${db.countPairs(v.f.address)} pairs, ${v.f.group}): ${v.detail}`.slice(0, 600),
        addedAt: today,
    })));
    for (const v of dead) console.log(`  blacklist ${v.f.name}`);
    console.log(`            conf/${cfg.chain.label}-blacklist.json5: ${added} added${skipped ? `, ${skipped} already there` : ''}`);
}
for (const v of verdicts.filter(v => v.status === 'REVIEW')) console.log(`  left      ${v.f.name}: only a low-confidence match (${v.fix!.name}) — check it by hand`);
if (fixes.length || dead.length) console.log(`\nNext: yarn reserves ${cfg.chain.label}, then yarn triangles ${cfg.chain.label}.`);
db.close();
