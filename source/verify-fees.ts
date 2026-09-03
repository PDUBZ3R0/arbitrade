// -----------------------------------------------------------------------------
// CLI: yarn verify-fees <chain> [options]
//
// Retroactive fee audit for already-configured factories. For each factory
// in the target group (default "v2" — the pure-flat-fee group where every
// entry is currently an unverified assumption), decompiles ONE sample pair's
// swap() bytecode via sevm and compares the derived fee against what
// conf/<chain>.json5 currently assumes.
//
// Report only — does NOT edit config. Fee correctness feeds directly into
// every downstream profit calculation; an unattended auto-patch is the wrong
// trade for a script that can be wrong (ambiguous decompiles happen — see
// util/decompile-fee.ts). You review the report and apply fixes by hand.
// -----------------------------------------------------------------------------

import { JsonRpcProvider } from 'ethers';
import { mkdirSync, writeFileSync } from 'node:fs';
import { loadChainConfig, dbPath } from './util/config.ts';
import { ArbitradeDB } from './util/db.ts';
import { deriveFeeFromBytecode } from './util/decompile-fee.ts';

const args = process.argv.slice(2);
const chainArg = args[0];
if (!chainArg || chainArg.startsWith('--')) {
    console.error('Usage: yarn verify-fees <chain> [options]');
    console.error('');
    console.error('  --group v2|v2fee|solidly   Which factory group to audit (default: v2)');
    console.error('  --show-snippets            Write the decompiled swap() body for every');
    console.error('                             MISMATCH/UNKNOWN/AMBIGUOUS factory to a separate');
    console.error('                             file under log/<chain>/verify-fees-snippets/ —');
    console.error('                             NOT inlined into the console/log output, since a');
    console.error('                             real UniswapV2Pair swap() body (with full ERC20');
    console.error('                             callback logic) can be tens of KB; dozens of them');
    console.error('                             in one log file blow past readable/tool size limits.');
    console.error('');
    console.error('Decompiles one sample pair per factory via sevm and compares the recovered');
    console.error('fee constant against what conf/<chain>.json5 currently assumes. Prints a');
    console.error('report — does not edit config. Fix mismatches by hand.');
    process.exit(1);
}

const getStr = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return (i >= 0 && args[i + 1]) ? args[i + 1] : undefined;
};
const hasFlag = (flag: string): boolean => args.indexOf(flag) >= 0;

const group = (getStr('--group') ?? 'v2') as 'v2' | 'v2fee' | 'solidly';
const showSnippets = hasFlag('--show-snippets');

const cfg = loadChainConfig(chainArg);
const dbFile = dbPath(chainArg);
const db = new ArbitradeDB(dbFile);
const provider = new JsonRpcProvider(cfg.chain.host);

const factories = cfg.factories.filter(f => f.group === group);
console.log(`Auditing ${factories.length} "${group}" factor(ies) on ${cfg.chain.name} via sevm decompile...`);
console.log(`(Report only — nothing is written to conf/${cfg.chain.label}.json5.)\n`);

type Status = 'MATCH' | 'MISMATCH' | 'NO-SAMPLE' | 'NO-SWAP' | 'UNKNOWN';
type Row = {
    name: string;
    address: string;
    assumedFee: number | undefined;
    decompiledFee: number | null;
    confidence: string;
    status: Status;
    snippet: string;
    detail: string;
};
const rows: Row[] = [];

for (const f of factories) {
    const sample = db.getSamplePairForFactory(f.address);
    if (!sample) {
        rows.push({ name: f.name, address: f.address, assumedFee: f.fee, decompiledFee: null, confidence: '-', status: 'NO-SAMPLE', snippet: '', detail: 'no scanned pairs for this factory in the DB' });
        console.log(`  ${f.name.padEnd(32)} NO-SAMPLE (no pairs scanned yet)`);
        continue;
    }

    const decompiled = await deriveFeeFromBytecode(provider, sample.pair);
    let status: Status;
    let detail = decompiled.error ?? '';

    if (!decompiled.hasSwapFunction) {
        status = 'NO-SWAP';
    } else if (decompiled.confidence === 'unknown') {
        status = 'UNKNOWN';
    } else if (decompiled.fee !== null && f.fee !== undefined) {
        status = Math.abs(decompiled.fee - f.fee) < 1e-6 ? 'MATCH' : 'MISMATCH';
        if (decompiled.confidence === 'ambiguous') {
            detail = `ambiguous decompile — best guess only, ${decompiled.matches.length} candidates found`;
        }
    } else {
        status = 'UNKNOWN';
    }

    rows.push({
        name: f.name, address: f.address, assumedFee: f.fee,
        decompiledFee: decompiled.fee, confidence: decompiled.confidence,
        status, snippet: decompiled.snippet, detail,
    });

    const feeStr = decompiled.fee !== null ? decompiled.fee.toString() : '-';
    console.log(`  ${f.name.padEnd(32)} ${status.padEnd(10)} assumed=${String(f.fee ?? '-').padEnd(8)} decompiled=${feeStr.padEnd(10)} sample=${sample.pair.slice(0,10)}`);
}

console.log('\n' + '─'.repeat(80));
console.log('Summary:');
const byStatus: Record<Status, number> = { MATCH: 0, MISMATCH: 0, 'NO-SAMPLE': 0, 'NO-SWAP': 0, UNKNOWN: 0 };
for (const r of rows) byStatus[r.status]++;
for (const [k, v] of Object.entries(byStatus)) console.log(`  ${k.padEnd(12)} ${v}`);

const mismatches = rows.filter(r => r.status === 'MISMATCH');
if (mismatches.length > 0) {
    console.log(`\n🚨 MISMATCHES — assumed fee is wrong. Every profit calc touching these factories is currently inaccurate:`);
    for (const r of mismatches) {
        console.log(`   ${r.name.padEnd(32)} assumed=${r.assumedFee}  decompiled=${r.decompiledFee} (${r.confidence})  ${r.detail}`);
        console.log(`     ${r.address}`);
    }
    console.log(`\n   Fix by hand in conf/${cfg.chain.label}.json5 — set "fee": <decompiledFee> on each entry above.`);
    console.log(`   For 'ambiguous' confidence, check the snippet file before trusting the number —`);
    console.log(`   the heuristic found more than one candidate and picked its best guess.`);
}

const unresolved = rows.filter(r => r.status === 'UNKNOWN' || r.status === 'NO-SWAP');
if (unresolved.length > 0) {
    console.log(`\nℹ️  ${unresolved.length} factor(ies) couldn't be resolved automatically:`);
    for (const r of unresolved) {
        console.log(`   ${r.name.padEnd(32)} ${r.status}  ${r.detail}`);
    }
    console.log(`   NO-SWAP likely means this factory isn't actually a standard V2-shaped pair`);
    console.log(`   (worth double-checking it belongs in the "${group}" group at all).`);
}

const matches = rows.filter(r => r.status === 'MATCH');
if (matches.length > 0) {
    console.log(`\n✓ ${matches.length} factor(ies) confirmed — decompiled fee matches the assumed config value.`);
}

if (showSnippets) {
    const snippetDir = `log/${cfg.chain.label}/verify-fees-snippets`;
    mkdirSync(snippetDir, { recursive: true });
    const toWrite = rows.filter(r => r.snippet && (r.status === 'MISMATCH' || r.status === 'UNKNOWN' || r.confidence === 'ambiguous'));
    for (const r of toWrite) {
        const safeName = r.name.replace(/[^a-zA-Z0-9_-]/g, '_');
        const path = `${snippetDir}/${safeName}_${r.address.slice(2, 10)}.txt`;
        const header =
            `Factory: ${r.name} (${r.address})\n` +
            `Status: ${r.status}  Confidence: ${r.confidence}\n` +
            `Assumed fee: ${r.assumedFee}  Decompiled fee: ${r.decompiledFee}\n` +
            `Detail: ${r.detail}\n` +
            `${'='.repeat(80)}\n\n`;
        writeFileSync(path, header + r.snippet);
    }
    if (toWrite.length > 0) {
        console.log(`\nWrote ${toWrite.length} decompiled swap() snippet(s) to ${snippetDir}/ (one file per factory).`);
    }
}

db.close();
