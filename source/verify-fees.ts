// -----------------------------------------------------------------------------
// CLI: yarn verify-fees <chain> [options]
//
// Retroactive fee audit for already-configured factories. Per factory, up to
// three independent signals, cheapest first:
//
//   1. sevm bytecode decompile + regex (util/decompile-fee.ts) — free, but
//      sevm output can stop before the K-check (observed: Sonic SpookySwap).
//   2. Empirical recovery from real Swap+Sync events (util/empirical-fee.ts)
//      — free; HyperSync when configured, chunked RPC otherwise.
//   3. Claude reading the code (util/source-fee.ts) — Etherscan-verified
//      source if available, else Heimdall decompilation. Opt-in (--claude),
//      since it costs API money. Also identifies the CURVE, which is how a
//      stable-swap pool masquerading as a V2 pair (Sonic's Shadow) gets
//      caught automatically.
//
// Resolution rules:
//   - A Claude answer counts as CONFIRMED only if: every evidence quote was
//     found verbatim in the code, confidence=high, curve=constant-product,
//     feeKind=constant.
//   - Claude confidently reporting a non-constant-product curve -> NON-CP:
//     that factory's pairs must be excluded from triangulation, not re-priced.
//   - Two confirmed signals that disagree -> CONFLICT; no final fee is
//     reported. A contradiction is surfaced, never silently resolved.
//
// Report only by default. With --apply it acts on the verdicts:
//   MISMATCH (v2 group)   conf fee set to the resolved fee — and the pairs
//                         already in the DB too: the scanner stamps the
//                         factory fee onto each v2 pair row, and the evaluator
//                         prefers the row, so a conf edit alone changes nothing
//                         for pairs scanned before it.
//   NON-CP                reconfigured when the chain shows a stable/volatile
//                         hybrid the pipeline models (util/curve-reconfig.ts:
//                         Camelot shape, or Solidly shape with a probed fee
//                         accessor) — moved to v2fee/solidly with the flag, so
//                         stable pairs drop out and volatile ones keep trading;
//                         otherwise blacklisted.
//   UNKNOWN               blacklisted when something WAS read and still made no
//                         sense (swap samples that disagree, or Claude reading
//                         the code). When nothing was read — no swaps in the
//                         searched range, Claude not consulted — it is held
//                         back: a quiet but healthy V2 fork looks exactly like
//                         that (decompile misses real v2-core pairs). Pass
//                         --blacklist-unread to blacklist those too.
//   NO-SWAP               blacklisted (no swap(…) selector: not executable).
//   CONFLICT, NO-SAMPLE   untouched — a human decides.
// Edits are comment-preserving and verified before writing (util/conf-edit.ts).
// -----------------------------------------------------------------------------

import { JsonRpcProvider } from 'ethers';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadChainConfig, dbPath } from './util/config.ts';
import { ArbitradeDB } from './util/db.ts';
import { deriveFeeFromBytecode } from './util/decompile-fee.ts';
import { empiricallyVerifyFee } from './util/empirical-fee.ts';
import { acquireCode, analyzeFeeWithClaude, type ClaudeFeeAnalysis } from './util/source-fee.ts';
import { makeProvider } from './util/rpc.ts';
import { editFactoriesInConf, type FactoryEdit } from './util/conf-edit.ts';
import { appendToBlacklist, type BlacklistEntry } from './util/blacklist.ts';
import { proposeReconfig } from './util/curve-reconfig.ts';

const args = process.argv.slice(2);
const chainArg = args[0];
if (!chainArg || chainArg.startsWith('--')) {
    console.error('Usage: yarn verify-fees <chain> [options]');
    console.error('');
    console.error('  --group v2|v2fee|solidly   Which factory group to audit (default: v2)');
    console.error('  --claude                   Also have Claude read the pair code (verified source via');
    console.error('                             Etherscan, else Heimdall decompile) for factories the free');
    console.error('                             methods could not resolve. Needs ANTHROPIC_API_KEY. Costs');
    console.error('                             API money; results are cached per code hash.');
    console.error('  --claude-all               With --claude: run it on EVERY factory, as a cross-check');
    console.error('                             (catches wrong curves even where a fee was recovered).');
    console.error('  --no-heimdall              With --claude: skip the Heimdall decompile fallback.');
    console.error('  --show-snippets            Write sevm swap() bodies for unresolved factories to');
    console.error('                             log/<chain>/verify-fees-snippets/.');
    console.error('  --apply                    Act on the verdicts: write resolved v2 fees to the conf (and');
    console.error('                             the DB pair rows), reconfigure NON-CP hybrids the chain shows');
    console.error('                             a stable flag for, blacklist UNKNOWN / NO-SWAP / other NON-CP.');
    console.error('                             CONFLICT and NO-SAMPLE are left alone; so is an UNKNOWN');
    console.error('                             where nothing could be read (no swaps, no Claude) —');
    console.error('  --blacklist-unread         — unless this is passed too.');
    console.error('');
    console.error('Without --apply it prints a report and edits nothing.');
    process.exit(1);
}

const getStr = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return (i >= 0 && args[i + 1]) ? args[i + 1] : undefined;
};
const hasFlag = (flag: string): boolean => args.indexOf(flag) >= 0;

const group = (getStr('--group') ?? 'v2') as 'v2' | 'v2fee' | 'solidly';
const showSnippets = hasFlag('--show-snippets');
const useClaude = hasFlag('--claude') || hasFlag('--claude-all');
const claudeAll = hasFlag('--claude-all');
const allowHeimdall = !hasFlag('--no-heimdall');
const apply = hasFlag('--apply');
const blacklistUnread = hasFlag('--blacklist-unread');
const anthropicKey = process.env.ANTHROPIC_API_KEY;
const etherscanKey = process.env.ETHERSCAN_API_KEY;

if (useClaude && !anthropicKey) {
    console.error('--claude requires ANTHROPIC_API_KEY in .env');
    process.exit(1);
}

const cfg = loadChainConfig(chainArg);
const dbFile = dbPath(chainArg);
const db = new ArbitradeDB(dbFile);
const provider = makeProvider(cfg.chain);
const cacheFile = `log/${cfg.chain.label}/fee-analysis-cache.json`;

const factories = cfg.factories.filter(f => f.group === group);

// HyperSync is the preferred transport for empirical fee recovery — it can
// search a pair's FULL swap history with no RPC range caps.
const hypersync = cfg.chain.hypersyncUrl && process.env.ENVIO_API_TOKEN
    ? { url: cfg.chain.hypersyncUrl, apiToken: process.env.ENVIO_API_TOKEN }
    : undefined;

console.log(`Auditing ${factories.length} "${group}" factor(ies) on ${cfg.chain.name}`);
console.log(`  empirical transport: ${hypersync ? 'HyperSync (full history)' : 'RPC (chunked, recent history only)'}`);
console.log(`  Claude analysis:     ${useClaude ? `${claudeAll ? 'all factories' : 'unresolved factories only'}; source = verified${allowHeimdall ? ' → heimdall' : ''}; model ${process.env.CLAUDE_MODEL ?? 'claude-sonnet-5'}` : 'off (pass --claude to enable)'}`);
console.log(apply
    ? `(--apply: verdicts will be written to conf/${cfg.chain.label}.json5, its blacklist and the DB after the report.)\n`
    : `(Report only — nothing is written to conf/${cfg.chain.label}.json5. Pass --apply to act on it.)\n`);

type Status = 'MATCH' | 'MISMATCH' | 'CONFLICT' | 'NON-CP' | 'NO-SAMPLE' | 'NO-SWAP' | 'UNKNOWN';
type Source = 'decompile' | 'empirical' | 'claude' | 'claude+empirical' | 'none';
type Row = {
    name: string;
    address: string;
    assumedFee: number | undefined;
    finalFee: number | null;
    source: Source;
    decompiledFee: number | null;
    decompiledConfidence: string;
    empiricalFee: number | null;
    empiricalConfidence: string;
    empiricalSampleCount: number;
    claude: ClaudeFeeAnalysis | null;
    claudeNote: string;
    status: Status;
    snippet: string;
    detail: string;
    /** Up to 5 of the factory's pairs, most active first — probed by --apply. */
    pairs: string[];
};
const rows: Row[] = [];
let claudeCalls = 0;

const CONFLICT_TOLERANCE = 0.0002;

for (const f of factories) {
    const sample = db.getSamplePairForFactory(f.address);
    if (!sample) {
        rows.push({
            name: f.name, address: f.address, assumedFee: f.fee, finalFee: null, source: 'none',
            decompiledFee: null, decompiledConfidence: '-', empiricalFee: null, empiricalConfidence: '-',
            empiricalSampleCount: 0, claude: null, claudeNote: '', status: 'NO-SAMPLE', snippet: '',
            detail: 'no scanned pairs for this factory in the DB', pairs: [],
        });
        console.log(`  ${f.name.padEnd(32)} NO-SAMPLE (no pairs scanned yet)`);
        continue;
    }

    // Active pairs first (by reserve size) — see db.getPairsForFactory for why
    // lowest-address picks are a poor choice for anything needing real history.
    const candidates = db.getPairsForFactory(f.address, 5);
    const bestPair = candidates[0]?.pair ?? sample.pair;

    // --- 1. sevm decompile (free)
    const decompiled = await deriveFeeFromBytecode(provider, sample.pair);

    // --- 2. empirical (free) — only if sevm didn't settle it
    let empiricalFee: number | null = null;
    let empiricalConfidence = 'not attempted';
    let empiricalSampleCount = 0;
    let empiricalError: string | undefined;
    if (decompiled.confidence !== 'derived' || claudeAll) {
        for (const candidate of candidates) {
            const empirical = await empiricallyVerifyFee(provider, candidate.pair, { hypersync });
            empiricalFee = empirical.fee;
            empiricalConfidence = empirical.confidence;
            empiricalSampleCount = empirical.samples.length;
            empiricalError = empirical.error;
            if (empirical.confidence === 'derived') break;
            if (empirical.confidence === 'ambiguous') break; // real signal about the factory — don't pair-shop
        }
    }

    // --- 3. Claude (paid, opt-in)
    const freeResolved = decompiled.confidence === 'derived' || empiricalConfidence === 'derived';
    let claude: ClaudeFeeAnalysis | null = null;
    let claudeNote = '';
    if (useClaude && (!freeResolved || claudeAll)) {
        try {
            const acquired = await acquireCode({
                chainId: cfg.chain.id,
                rpcUrl: cfg.chain.host,
                address: bestPair,
                etherscanApiKey: etherscanKey,
                allowHeimdall,
            });
            if (acquired.source === 'none') {
                claudeNote = `no readable code (${acquired.note ?? 'unknown reason'})`;
            } else {
                claude = await analyzeFeeWithClaude({ acquired, address: bestPair, cacheFile, apiKey: anthropicKey! });
                if (claude) claudeCalls++; // count only analyses that actually came back
            }
        } catch (err) {
            claudeNote = `claude analysis failed: ${(err as Error).message.slice(0, 160)}`;
        }
    }

    // --- Resolution
    const confirmed: Array<{ src: Source; fee: number }> = [];
    if (empiricalConfidence === 'derived' && empiricalFee !== null) confirmed.push({ src: 'empirical', fee: empiricalFee });
    const claudeTrusted = !!claude && claude.evidenceVerified && claude.confidence === 'high'
        && claude.fee !== null && claude.curve === 'constant-product' && claude.feeKind === 'constant';
    if (claudeTrusted) confirmed.push({ src: 'claude', fee: claude!.fee! });

    // Two independent weak signals that agree: Claude read the code at MEDIUM
    // confidence (evidence verified, but e.g. found in a helper rather than
    // squarely in swap()'s K-check) AND the one real swap we could find implies
    // the same fee. Deliberately narrow: exactly 1 empirical sample means "too
    // little data" — the "samples disagree" case (possible dynamic fee or
    // skimming pair) never qualifies.
    const claudeCorroborated = !claudeTrusted && !!claude && claude.evidenceVerified && claude.confidence === 'medium'
        && claude.fee !== null && claude.curve === 'constant-product' && claude.feeKind === 'constant'
        && empiricalConfidence === 'ambiguous' && empiricalSampleCount === 1 && empiricalFee !== null
        && Math.abs(claude.fee - empiricalFee) <= CONFLICT_TOLERANCE;
    if (claudeCorroborated) confirmed.push({ src: 'claude+empirical', fee: claude!.fee! });
    if (decompiled.confidence === 'derived' && decompiled.fee !== null) confirmed.push({ src: 'decompile', fee: decompiled.fee });

    const claudeSaysNonCp = !!claude && claude.evidenceVerified
        && (claude.confidence === 'high' || claude.confidence === 'medium')
        && (claude.curve === 'stable-solidly' || claude.curve === 'other');

    let status: Status;
    let finalFee: number | null = null;
    let source: Source = 'none';
    let detail = '';

    if (claudeSaysNonCp) {
        status = 'NON-CP';
        detail = `curve=${claude!.curve} — constant-product math is wrong for these pairs; exclude from triangulation. ${claude!.notes}`;
    } else if (confirmed.length >= 2 && Math.max(...confirmed.map(c => c.fee)) - Math.min(...confirmed.map(c => c.fee)) > CONFLICT_TOLERANCE) {
        status = 'CONFLICT';
        detail = confirmed.map(c => `${c.src}=${c.fee}`).join(' vs ');
    } else if (confirmed.length > 0) {
        // Priority: observed behavior > read source > regex over bytecode.
        const pick = confirmed[0];
        finalFee = pick.fee;
        source = pick.src;
        status = f.fee !== undefined && Math.abs(finalFee - f.fee) < 1e-6 ? 'MATCH' : 'MISMATCH';
        if (confirmed.length >= 2) detail = `corroborated by ${confirmed.slice(1).map(c => c.src).join(', ')}`;
    } else {
        status = decompiled.hasSwapFunction ? 'UNKNOWN' : 'NO-SWAP';
        detail = [decompiled.error, empiricalError ? `empirical: ${empiricalError}` : undefined].filter(Boolean).join('; ');
    }
    if (claude && !claudeTrusted && !claudeCorroborated && !claudeSaysNonCp) {
        claudeNote = `claude: fee=${claude.fee} curve=${claude.curve} kind=${claude.feeKind} conf=${claude.confidence}${claude.evidenceVerified ? '' : ' (evidence NOT verified)'} — ${claude.notes}`;
    }
    if (claude && (claude.feeKind === 'per-pair-storage' || claude.feeKind === 'factory-lookup') && group === 'v2') {
        claudeNote += `${claudeNote ? '; ' : ''}fee is ${claude.feeKind} — this factory likely belongs in the v2fee group, not v2`;
    }

    rows.push({
        name: f.name, address: f.address, assumedFee: f.fee, finalFee, source,
        decompiledFee: decompiled.fee, decompiledConfidence: decompiled.confidence,
        empiricalFee, empiricalConfidence, empiricalSampleCount,
        claude, claudeNote, status, snippet: decompiled.snippet, detail,
        pairs: candidates.length ? candidates.map(c => c.pair) : [sample.pair],
    });

    const feeStr = finalFee !== null ? String(finalFee) : '-';
    const srcTag = source !== 'none' ? `[${source}]` : claude ? `[claude:${claude.codeSource}]` : '';
    console.log(`  ${f.name.padEnd(32)} ${status.padEnd(10)} assumed=${String(f.fee ?? '-').padEnd(8)} final=${feeStr.padEnd(10)} ${srcTag}`);
}

// -----------------------------------------------------------------------------
// Report

console.log('\n' + '─'.repeat(80));
console.log('Summary:');
const byStatus: Record<Status, number> = { MATCH: 0, MISMATCH: 0, CONFLICT: 0, 'NON-CP': 0, 'NO-SAMPLE': 0, 'NO-SWAP': 0, UNKNOWN: 0 };
for (const r of rows) byStatus[r.status]++;
for (const [k, v] of Object.entries(byStatus)) console.log(`  ${k.padEnd(12)} ${v}`);
const bySource: Record<Source, number> = { decompile: 0, empirical: 0, claude: 0, 'claude+empirical': 0, none: 0 };
for (const r of rows) if (r.status === 'MATCH' || r.status === 'MISMATCH') bySource[r.source]++;
console.log(`  resolved via decompile: ${bySource.decompile}   empirical: ${bySource.empirical}   claude: ${bySource.claude}   claude+empirical: ${bySource['claude+empirical']}`);
if (useClaude) console.log(`  Claude analyses this run: ${claudeCalls} (cached results reused where code unchanged)`);

const section = (title: string, rs: Row[], render: (r: Row) => string[]) => {
    if (rs.length === 0) return;
    console.log(`\n${title}`);
    for (const r of rs) for (const line of render(r)) console.log(line);
};

section('🚨 MISMATCHES — assumed fee is wrong; fix in config:', rows.filter(r => r.status === 'MISMATCH'), r => [
    `   ${r.name.padEnd(32)} assumed=${r.assumedFee}  final=${r.finalFee} [${r.source}]  ${r.detail}`,
    `     ${r.address}`,
]);
section('⛔ NON-CONSTANT-PRODUCT — exclude these from triangulation (move to blacklist or a stable-swap group):', rows.filter(r => r.status === 'NON-CP'), r => [
    `   ${r.name.padEnd(32)} ${r.detail}`,
    ...(r.claude?.evidence ?? []).map(e => `       evidence: ${e.trim().slice(0, 140)}`),
    `     ${r.address}`,
]);
section('⚠️  CONFLICTS — methods disagree; resolve by hand before trusting either:', rows.filter(r => r.status === 'CONFLICT'), r => [
    `   ${r.name.padEnd(32)} ${r.detail}`,
    ...(r.claude?.evidence ?? []).map(e => `       claude evidence: ${e.trim().slice(0, 140)}`),
    `     ${r.address}`,
]);
section('ℹ️  Unresolved by every method attempted:', rows.filter(r => r.status === 'UNKNOWN' || r.status === 'NO-SWAP'), r => [
    `   ${r.name.padEnd(32)} ${r.status}  decompile=${r.decompiledConfidence}  empirical=${r.empiricalConfidence} (${r.empiricalSampleCount}${r.empiricalFee !== null ? `, fee≈${r.empiricalFee}` : ''})`,
    ...(r.detail ? [`       ${r.detail}`] : []),
    ...(r.claudeNote ? [`       ${r.claudeNote}`] : []),
]);
const notesOnResolved = rows.filter(r => (r.status === 'MATCH' || r.status === 'MISMATCH') && r.claudeNote);
section('📝 Claude notes on resolved factories:', notesOnResolved, r => [`   ${r.name.padEnd(32)} ${r.claudeNote}`]);

const matches = rows.filter(r => r.status === 'MATCH');
if (matches.length > 0) console.log(`\n✓ ${matches.length} factor(ies) confirmed — resolved fee matches the assumed config value.`);

if (showSnippets) {
    const snippetDir = `log/${cfg.chain.label}/verify-fees-snippets`;
    mkdirSync(snippetDir, { recursive: true });
    const toWrite = rows.filter(r => r.snippet && r.status !== 'MATCH');
    for (const r of toWrite) {
        const safeName = r.name.replace(/[^a-zA-Z0-9_-]/g, '_');
        writeFileSync(
            `${snippetDir}/${safeName}_${r.address.slice(2, 10)}.txt`,
            `Factory: ${r.name} (${r.address})\nStatus: ${r.status}\nDetail: ${r.detail}\n${r.claudeNote ? `Claude: ${r.claudeNote}\n` : ''}${'='.repeat(80)}\n\n${r.snippet}`,
        );
    }
    if (toWrite.length > 0) console.log(`\nWrote ${toWrite.length} sevm swap() snippet(s) to ${snippetDir}/`);
}

if (apply) await applyVerdicts();

db.close();

// -----------------------------------------------------------------------------
// --apply

async function applyVerdicts(): Promise<void> {
    const today = new Date().toISOString().slice(0, 10);
    const byAddr = new Map(factories.map(f => [f.address.toLowerCase(), f]));
    const edits: FactoryEdit[] = [];
    const feeRows: Array<{ factory: string; fee: number; name: string; from: number | undefined }> = [];
    const movedRows: Array<{ factory: string; name: string; to: string; basis: string }> = [];
    const black: Array<BlacklistEntry & { name: string; status: string }> = [];
    const leftAlone: string[] = [];
    const clip = (s: string, n: number) => s.replace(/\s+/g, ' ').trim().slice(0, n);
    const pairCount = (r: Row) => db.countPairs(r.address);

    const tryReconfig = async (r: Row) => {
        const f = byAddr.get(r.address.toLowerCase())!;
        return proposeReconfig(cfg.chain.label, provider, { address: f.address, deployBlock: f.deployBlock }, r.pairs, f.name);
    };
    const move = (r: Row, rc: NonNullable<Awaited<ReturnType<typeof tryReconfig>>['reconfig']>, why: string) => {
        edits.push({
            kind: 'move', group: group, key: r.name, address: r.address, to: rc.group, entry: rc.entry,
            comment: `verify-fees ${today}: moved from ${group} — ${why}. ${rc.basis}`,
            note: `${r.name} → factories.${rc.group} (verify-fees ${today})`,
        });
        movedRows.push({ factory: r.address, name: r.name, to: rc.group, basis: rc.basis });
    };

    console.log('\n' + '─'.repeat(80));
    console.log('Applying (--apply):');
    for (const r of rows) {
        const perPairFee = r.claude && (r.claude.feeKind === 'per-pair-storage' || r.claude.feeKind === 'factory-lookup');
        if (r.status === 'MISMATCH') {
            if (group !== 'v2') { leftAlone.push(`${r.name}: MISMATCH in ${group} — fees there come from each pair; not written`); continue; }
            if (perPairFee) {
                const { reconfig, why } = await tryReconfig(r);
                if (reconfig) { move(r, reconfig, `its fee is per pair (${r.claude!.feeKind})`); continue; }
                leftAlone.push(`${r.name}: fee is ${r.claude!.feeKind}, so one factory fee would be wrong, and no per-pair config was found (${why})`);
                continue;
            }
            edits.push({
                kind: 'setFee', group, key: r.name, address: r.address, fee: r.finalFee!,
                comment: `verify-fees ${today}: fee ${r.assumedFee ?? 'unset'} → ${r.finalFee} (${r.source}${r.detail ? `, ${r.detail}` : ''})`,
            });
            feeRows.push({ factory: r.address, fee: r.finalFee!, name: r.name, from: r.assumedFee });
        } else if (r.status === 'NON-CP') {
            const { reconfig, why } = await tryReconfig(r);
            if (reconfig) { move(r, reconfig, `not constant-product throughout (claude: curve=${r.claude?.curve})`); continue; }
            black.push({
                name: r.name, status: r.status, address: r.address,
                reason: clip(`verify-fees ${today} NON-CP (${pairCount(r)} pairs): curve=${r.claude?.curve}; not reconfigurable (${why}). ${r.claude?.notes ?? ''}`, 600),
            });
        } else if (r.status === 'UNKNOWN' || r.status === 'NO-SWAP') {
            if (r.status === 'UNKNOWN' && r.empiricalSampleCount === 0 && !r.claude && !blacklistUnread) {
                leftAlone.push(`${r.name}: UNKNOWN, but nothing was read — no swaps seen${hypersync ? '' : ' in the RPC range'}, ` +
                    `${useClaude ? `no code Claude could read${r.claudeNote ? ` (${r.claudeNote})` : ''}` : 'Claude not consulted'}. ` +
                    `Rerun with --claude${hypersync ? '' : ' or HyperSync'}, or pass --blacklist-unread to blacklist it anyway`);
                continue;
            }
            black.push({
                name: r.name, status: r.status, address: r.address,
                reason: clip(`verify-fees ${today} ${r.status} (${pairCount(r)} pairs): decompile=${r.decompiledConfidence}, empirical=${r.empiricalConfidence} (${r.empiricalSampleCount} samples)${useClaude ? '' : ', Claude not consulted'}. ${r.detail} ${r.claudeNote}`, 600),
            });
        } else if (r.status === 'CONFLICT') {
            leftAlone.push(`${r.name}: CONFLICT (${r.detail}) — resolve by hand`);
        }
    }

    // 1. The conf (verified, atomic). If it throws nothing else is touched.
    const confDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'conf');
    if (edits.length) {
        try {
            editFactoriesInConf(confDir, cfg.chain.label, edits);
        } catch (e) {
            console.log(`  [✗] conf/${cfg.chain.label}.json5 not edited, and nothing else was applied: ${(e as Error).message}`);
            return;
        }
    }
    for (const f of feeRows) console.log(`  fee      ${f.name.padEnd(32)} ${f.from ?? 'unset'} → ${f.fee}`);
    for (const m of movedRows) console.log(`  moved    ${m.name.padEnd(32)} ${group} → ${m.to}  (${m.basis})`);

    // 2. The DB rows that carry a copy of the old config.
    const setFee = db.db.prepare(`UPDATE pairs SET fee = ? WHERE factory = ? AND kind != 'v3'`);
    const clearMeta = db.db.prepare(`UPDATE pairs SET fee = NULL, stable = NULL WHERE factory = ?`);
    let feeRowsUpdated = 0, metaCleared = 0;
    db.db.transaction(() => {
        for (const f of feeRows) feeRowsUpdated += setFee.run(f.fee, f.factory.toLowerCase()).changes;
        for (const m of movedRows) metaCleared += clearMeta.run(m.factory.toLowerCase()).changes;
    })();
    if (feeRows.length) console.log(`           ${feeRowsUpdated} pair row(s) in the DB now carry the new fee`);
    if (movedRows.length) console.log(`           ${metaCleared} pair row(s) of moved factories cleared — the next yarn reserves reads their fee and stable flag`);

    // 3. The blacklist.
    if (black.length) {
        try {
            const { added, skipped } = appendToBlacklist(cfg.chain.label, black.map(({ address, reason }) => ({ address, reason, addedAt: today })));
            for (const b of black) console.log(`  blacklist ${b.name.padEnd(31)} ${b.status}`);
            console.log(`           conf/${cfg.chain.label}-blacklist.json5: ${added} added${skipped ? `, ${skipped} already there` : ''}`);
        } catch (e) {
            console.log(`  [✗] blacklist not written: ${(e as Error).message}`);
        }
    }
    for (const l of leftAlone) console.log(`  left     ${l}`);
    if (!edits.length && !black.length) console.log('  nothing to apply');
    if (movedRows.length || feeRows.length || black.length) {
        console.log(`\nNext: ${movedRows.length ? `yarn reserves ${cfg.chain.label}  (fee + stable flag for moved factories), then ` : ''}yarn triangles ${cfg.chain.label}, and restart the hot loop.`);
    }
}
