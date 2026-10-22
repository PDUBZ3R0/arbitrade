// Copy freshly deployed contract addresses from Hardhat Ignition's record into
// the chain block of conf/<chain>.json5.
//
//   yarn contract-update <chain> [--dry-run] [--deployment <id>]
//   yarn contract-update <chain> --set <field>=<address>   (one field, given explicitly —
//        scripts/deploy.sh uses it to adopt a contract Ignition lost track of)
//
// Ignition writes ignition/deployments/chain-<chainId>/deployed_addresses.json
// ({"<Module>#<Contract>": "0x…"}). This maps those futures onto the chain
// block's fields:
//
//   contract  ← Yo3Module#YoBatches3, else Yo2Module#YoBatches2, else YoModule#YoBatches
//   executor  ← FlashArbModule#FlashArbExecutor
//   probe     ← TokenProbeModule#TokenProbe
//   liquidator ← LiquidationModule#LiquidationExecutor
//
// The newest YoBatches wins because each one keeps every function of the one
// before it. A field whose future was never deployed on this chain is left
// alone.
//
// The edit is textual, not parse-and-reserialize, so comments, key order and
// quoting in the JSON5 file survive. Per field, in order of preference:
//   1. an existing `contract: '0x…'` line in the chain block → value replaced
//   2. a commented-out `// contract: '0x…'` placeholder (what add-chain writes)
//      → uncommented with the address
//   3. neither → a new line after `token:` (or at the top of the block)
// The result is re-parsed and every written field checked before the file is
// replaced, so a botched edit never reaches disk.
//
// Downgrade guard (Ignition path only, not --set): before replacing a field
// whose configured address differs from Ignition's, scripts/deploy-check.ts is
// asked which one holds the current code. If the CONFIGURED one does, the field
// is kept. This is the HyperEVM case: Ignition reports a big-block deploy as
// "dropped", it lands anyway, deploy.sh adopts it with --set — and Ignition's
// deployed_addresses.json still names the older contract, so an unguarded run
// would quietly point the config back at stale code. If the check cannot tell
// (no artifact, RPC down), the field is left alone and the run says so.
//   --trust-ignition   skip the guard and take Ignition's record as-is
//
// Sniper (~/Development/sniper, or SNIPER_DIR) keeps the same two contracts in the same place,
// chain.probe and chain.sniper of its conf/<label>.json5. After this chain's conf is settled, those
// two fields are copied there with the same textual edit, when sniper has a conf for the chain. Before
// that (2026-10-22) sniper kept them under live.*, and a redeployed probe had to be copied by hand.

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import JSON5 from 'json5';
import { resolveChain } from './config.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

type Field = 'contract' | 'executor' | 'probe' | 'liquidator' | 'sniper';

/** Futures per field, most preferred first. */
export const FIELD_FUTURES: Record<Field, string[]> = {
    contract: ['Yo3Module#YoBatches3', 'Yo2Module#YoBatches2', 'YoModule#YoBatches'],
    executor: ['FlashArbModule#FlashArbExecutor'],
    probe:    ['TokenProbeModule#TokenProbe'],
    liquidator: ['LiquidationModule#LiquidationExecutor'],
    sniper:   ['SniperModule#SniperExecutor'],
};

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** Contract name per future, for deploy-check (only futures we still compile). */
const FUTURE_CONTRACT: Record<string, string> = {
    'Yo3Module#YoBatches3': 'YoBatches3',
    'FlashArbModule#FlashArbExecutor': 'FlashArbExecutor',
    'TokenProbeModule#TokenProbe': 'TokenProbe',
    'LiquidationModule#LiquidationExecutor': 'LiquidationExecutor',
    'SniperModule#SniperExecutor': "SniperExecutor"
};

/**
 * Ask scripts/deploy-check.ts which address holds the current code. It tries
 * chain.<field> first, then Ignition's record, and prints
 * "<status> <address|-> <reason>". Returns null when it could not run.
 */
function deployCheck(label: string, field: Field, future: string): { status: string; address: string | null; line: string } | null {
    const contract = FUTURE_CONTRACT[future];
    if (!contract) return null;
    const r = spawnSync(process.execPath, [
        '--experimental-strip-types', '--disable-warning=ExperimentalWarning',
        path.join(PROJECT_ROOT, 'scripts', 'deploy-check.ts'), label, contract, field, future,
    ], { cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 120_000 });
    const line = (r.stdout ?? '').trim().split('\n').pop() ?? '';
    const m = /^(\S+) (\S+) /.exec(line);
    if (!m) return null;
    return { status: m[1], address: ADDRESS_RE.test(m[2]) ? m[2] : null, line };
}

export interface Change {
    field: Field;
    future: string;
    address: string;
    previous?: string;          // the value that was there, when one was
    action: 'unchanged' | 'replaced' | 'uncommented' | 'inserted';
}

/** The fields sniper reads from its own conf's chain block. */
export const SNIPER_FIELDS: Field[] = ['probe', 'sniper'];

/**
 * Copy chain.probe / chain.sniper from arbitrade's settled conf text into sniper's conf for the
 * same chain. Pure on the texts: returns sniper's new text (or null: nothing to copy) and the changes.
 */
export function mirrorFields(arbText: string, sniperText: string): { text: string; changes: Change[] } | null {
    const chain = (JSON5.parse(arbText) as { chain?: Record<string, unknown> }).chain ?? {};
    const updates = SNIPER_FIELDS.filter(f => typeof chain[f] === 'string' && ADDRESS_RE.test(chain[f] as string))
        .map(f => ({ field: f, future: `arbitrade chain.${f}`, address: chain[f] as string }));
    if (!updates.length) return null;
    return applyUpdates(sniperText, updates);
}

function mirrorToSniper(label: string, arbText: string, dryRun: boolean): void {
    const dir = process.env.SNIPER_DIR ?? path.resolve(PROJECT_ROOT, '..', 'sniper');
    const file = path.join(dir, 'conf', `${label}.json5`);
    if (!fs.existsSync(file)) return;
    const original = fs.readFileSync(file, 'utf8');
    const r = mirrorFields(arbText, original);
    if (!r) return;
    const check = (JSON5.parse(r.text) as { chain?: Record<string, unknown> }).chain ?? {};
    for (const c of r.changes) if (check[c.field] !== c.address) throw new Error(`sniper edit check failed: chain.${c.field} reads ${String(check[c.field])}, expected ${c.address} — ${file} NOT written`);
    const changed = r.changes.filter(c => c.action !== 'unchanged');
    if (!changed.length) return;
    console.log(`\nsniper: ${file}${dryRun ? '  (dry run)' : ''}`);
    for (const c of changed) console.log(`  ${c.field.padEnd(9)} ${c.address}  (${c.action === 'replaced' ? `was ${c.previous}` : c.action === 'uncommented' ? 'uncommented placeholder' : 'added'})`);
    if (dryRun) return;
    fs.writeFileSync(file + '.tmp', r.text);
    fs.renameSync(file + '.tmp', file);
}

/** Pick, per field, the most preferred future present in deployed_addresses.json. */
export function pickAddresses(deployed: Record<string, string>): Array<{ field: Field; future: string; address: string }> {
    const out: Array<{ field: Field; future: string; address: string }> = [];
    for (const field of Object.keys(FIELD_FUTURES) as Field[]) {
        for (const future of FIELD_FUTURES[field]) {
            const a = deployed[future];
            if (typeof a === 'string' && ADDRESS_RE.test(a)) { out.push({ field, future, address: a }); break; }
        }
    }
    return out;
}

/**
 * Find the `{…}` span of the top-level `chain:` object. Walks the text once,
 * skipping strings and comments so a brace or "chain:" inside either is never
 * mistaken for structure. Returns [openBraceIndex, closeBraceIndex].
 */
export function findChainBlock(text: string): [number, number] {
    let depth = 0;
    let i = 0;
    let open = -1;
    const n = text.length;
    while (i < n) {
        const c = text[i];
        const d = text[i + 1];
        if (c === '/' && d === '/') { while (i < n && text[i] !== '\n') i++; continue; }
        if (c === '/' && d === '*') { const e = text.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
        if (c === '"' || c === "'" || c === '`') {
            i++;
            while (i < n && text[i] !== c) { if (text[i] === '\\') i++; i++; }
            i++;
            continue;
        }
        if (c === '{') {
            depth++;
            if (depth === 2 && open < 0) {
                // Is this the value of a depth-1 key named chain?
                const before = text.slice(0, i).replace(/\s+$/, '');
                if (/(^|[\s,{])(['"]?)chain\2\s*:$/.test(before)) open = i;
            }
        } else if (c === '}') {
            if (depth === 2 && open >= 0) return [open, i];
            depth--;
        }
        i++;
    }
    throw new Error('no top-level `chain: { … }` block found');
}

/** Split "value-part  // comment" into its code and comment halves (comment kept verbatim, with its leading space). */
function splitComment(line: string): [string, string] {
    let q: string | null = null;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
        if (c === '"' || c === "'") { q = c; continue; }
        if (c === '/' && line[i + 1] === '/') {
            let s = i;
            while (s > 0 && /[ \t]/.test(line[s - 1])) s--;
            return [line.slice(0, s), line.slice(s)];
        }
    }
    return [line, ''];
}

/**
 * Apply the address updates to the JSON5 text. Pure: returns the new text and
 * what happened per field.
 */
export function applyUpdates(text: string, updates: Array<{ field: Field; future: string; address: string }>): { text: string; changes: Change[] } {
    const changes: Change[] = [];
    for (const u of updates) {
        const [open, close] = findChainBlock(text);
        const head = text.slice(0, open + 1);
        const body = text.slice(open + 1, close);
        const tail = text.slice(close);
        const lines = body.split('\n');

        // Indentation of the block's properties: first non-empty, non-comment line.
        const indent = lines.map(l => /^([ \t]*)\S/.exec(l)).find((m, k) => m && !/^\s*\/\//.test(lines[k]))?.[1] ?? '    ';

        const live = new RegExp(`^([ \\t]*)(['"]?)${u.field}\\2([ \\t]*:[ \\t]*)(['"])([^'"]*)\\4(.*)$`);
        const commented = new RegExp(`^([ \\t]*)//[ \\t]*(['"]?)${u.field}\\2[ \\t]*:[ \\t]*(['"])[^'"]*\\3[ \\t]*,?(.*)$`);

        let change: Change | null = null;
        const k = lines.findIndex(l => live.test(l));
        if (k >= 0) {
            const m = live.exec(lines[k])!;
            const prev = m[5];
            if (prev === u.address) {
                change = { field: u.field, future: u.future, address: u.address, previous: prev, action: 'unchanged' };
            } else {
                lines[k] = `${m[1]}${m[2]}${u.field}${m[2]}${m[3]}${m[4]}${u.address}${m[4]}${m[6]}`;
                change = { field: u.field, future: u.future, address: u.address, previous: prev, action: 'replaced' };
            }
        } else {
            const c = lines.findIndex(l => commented.test(l));
            if (c >= 0) {
                const m = commented.exec(lines[c])!;
                const rest = m[4].trimStart();
                lines[c] = `${m[1]}${u.field}: '${u.address}',${rest ? '  ' + rest : ''}`;
                change = { field: u.field, future: u.future, address: u.address, action: 'uncommented' };
            } else {
                // After the last of token/contract/executor/probe (so a run that
                // adds several keeps them together, in order), else after the last
                // live property — making sure the line we follow ends in a comma.
                let at = -1;
                lines.forEach((l, j) => { if (/^[ \t]*(['"]?)(token|contract|executor|probe|liquidator|sniper)\1[ \t]*:/.test(l)) at = j; });
                if (at < 0) {
                    for (let j = lines.length - 1; j >= 0; j--) if (/^[ \t]*[\w'"]+[ \t]*:/.test(lines[j])) { at = j; break; }
                }
                const newLine = `${indent}${u.field}: '${u.address}',`;
                if (at >= 0) {
                    const [code, comment] = splitComment(lines[at]);
                    if (!/,[ \t]*$/.test(code)) lines[at] = code.replace(/[ \t]*$/, ',') + comment;
                    lines.splice(at + 1, 0, newLine);
                } else {
                    lines.splice(1, 0, newLine);   // empty block: right after the brace's line
                }
                change = { field: u.field, future: u.future, address: u.address, action: 'inserted' };
            }
        }
        changes.push(change);
        text = head + lines.join('\n') + tail;
    }
    return { text, changes };
}

// -----------------------------------------------------------------------------

function usage(msg?: string): never {
    if (msg) console.error(msg);
    console.error('Usage: yarn contract-update <chain> [--dry-run] [--deployment <id>]');
    console.error('  --deployment <id>   Ignition deployment id (default chain-<chainId>)');
    console.error('  --set <field>=<0x…> Set one field (contract|executor|probe|liquidator|sniper) to this address instead');
    console.error('  (chain.probe and chain.sniper are copied into sniper\'s conf/<chain>.json5 too, when it has one; SNIPER_DIR to point elsewhere)');
    console.error('  --trust-ignition    Skip the check that refuses to replace current code with Ignition\'s record');
    process.exit(1);
}

async function main() {
    const args = process.argv.slice(2);
    const slug = args.find(a => !a.startsWith('--'));
    if (!slug) usage();
    const dryRun = args.includes('--dry-run');
    const trustIgnition = args.includes('--trust-ignition');
    const di = args.indexOf('--deployment');
    const deploymentArg = di >= 0 ? args[di + 1] : undefined;
    if (di >= 0 && !deploymentArg) usage('--deployment needs an id');
    const si = args.indexOf('--set');
    const setArg = si >= 0 ? args[si + 1] : undefined;
    let setUpdate: { field: Field; future: string; address: string } | null = null;
    if (si >= 0) {
        const m = /^(contract|executor|probe|liquidator|sniper)=(0x[0-9a-fA-F]{40})$/.exec(setArg ?? '');
        if (!m) usage('--set needs <field>=<address>, field one of contract, executor, probe, liquidator, sniper');
        setUpdate = { field: m[1] as Field, future: `--set ${m[1]}`, address: m[2] };
    }

    const meta = resolveChain(slug);
    const confPath = path.join(PROJECT_ROOT, 'conf', `${meta.label}.json5`);
    if (!fs.existsSync(confPath)) usage(`No config at ${path.relative(PROJECT_ROOT, confPath)} — run yarn add-chain first.`);
    const original = fs.readFileSync(confPath, 'utf8');

    // The conf file's chain.id wins over the registry's, as in loadChainConfig.
    const parsed = JSON5.parse(original) as { chain?: { id?: number } };
    const chainId = parsed.chain?.id ?? meta.id;
    const deploymentId = deploymentArg ?? `chain-${chainId}`;
    const addrPath = path.join(PROJECT_ROOT, 'ignition', 'deployments', deploymentId, 'deployed_addresses.json');
    if (!setUpdate && !fs.existsSync(addrPath)) {
        console.error(`No Ignition record for ${meta.name} at ${path.relative(PROJECT_ROOT, addrPath)}.`);
        console.error(`Deploy first: yarn deploy-contract ${meta.label} / yarn deploy-flasharb ${meta.label} / yarn deploy-probe ${meta.label} / yarn deploy-liquidator ${meta.label}`);
        process.exit(1);
    }
    const deployed = setUpdate ? {} : JSON.parse(fs.readFileSync(addrPath, 'utf8')) as Record<string, string>;

    console.log(`${meta.name} (chain ${chainId})`);
    console.log(`  from ${setUpdate ? `--set ${setArg}` : path.relative(PROJECT_ROOT, addrPath)}`);
    console.log(`  into ${path.relative(PROJECT_ROOT, confPath)}${dryRun ? '  (dry run)' : ''}\n`);

    let updates = setUpdate ? [setUpdate] : pickAddresses(deployed);
    const kept = new Set<Field>();

    // Downgrade guard: never replace a configured address that holds the
    // current code with an Ignition record that may not (see header).
    if (!setUpdate && !trustIgnition) {
        const current = (parsed as { chain?: Record<string, unknown> }).chain ?? {};
        updates = updates.filter(u => {
            const have = current[u.field];
            if (typeof have !== 'string' || !ADDRESS_RE.test(have) || have.toLowerCase() === u.address.toLowerCase()) return true;
            const c = deployCheck(meta.label, u.field, u.future);
            if (c && c.status === 'current' && c.address && c.address.toLowerCase() === have.toLowerCase()) {
                console.log(`  ${u.field.padEnd(9)} ${have}  kept: holds the current code; Ignition's ${u.address} would be a downgrade`);
                kept.add(u.field);
                return false;
            }
            if (c && c.status === 'current') return true;   // Ignition's address is the current one
            if (!c || c.status === 'error' || c.status === 'pending') {
                console.log(`  ${u.field.padEnd(9)} ${have}  kept: could not verify which address is current (${c?.line ?? 'deploy-check did not run'}) — --trust-ignition to override`);
                kept.add(u.field);
                return false;
            }
            return true;   // neither is current: Ignition's record is no worse than what is configured
        });
    }
    for (const field of Object.keys(FIELD_FUTURES) as Field[]) {
        if (!setUpdate && !kept.has(field) && !updates.some(u => u.field === field)) {
            console.log(`  ${field.padEnd(9)} — nothing deployed (${FIELD_FUTURES[field].join(' / ')}); left as is`);
        }
    }
    if (updates.length === 0) { console.log('\nNothing to update.'); mirrorToSniper(meta.label, original, dryRun); return; }

    const { text, changes } = applyUpdates(original, updates);

    // Re-parse and check every field before touching the file.
    const check = (JSON5.parse(text) as { chain?: Record<string, unknown> }).chain ?? {};
    for (const c of changes) {
        if (check[c.field] !== c.address) {
            throw new Error(`edit check failed: chain.${c.field} reads ${String(check[c.field])}, expected ${c.address} — file NOT written`);
        }
    }

    for (const c of changes) {
        const what =
            c.action === 'unchanged'   ? 'already set' :
            c.action === 'replaced'    ? `was ${c.previous}` :
            c.action === 'uncommented' ? 'uncommented placeholder' :
                                         'added';
        console.log(`  ${c.field.padEnd(9)} ${c.address}  ← ${c.future}  (${what})`);
        if (c.action === 'replaced' && c.field === 'contract' && c.future !== FIELD_FUTURES.contract[0]) {
            console.log(`  ${''.padEnd(9)} [!] ${FIELD_FUTURES.contract[0]} is not deployed on this chain — yarn deploy-contract ${meta.label}`);
        }
    }

    if (text === original) { console.log('\nNo changes.'); mirrorToSniper(meta.label, original, dryRun); return; }
    if (dryRun) { console.log('\nDry run: file not written.'); mirrorToSniper(meta.label, text, dryRun); return; }

    const tmp = confPath + '.tmp';
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, confPath);
    console.log(`\nUpdated ${path.relative(PROJECT_ROOT, confPath)}.`);
    mirrorToSniper(meta.label, text, dryRun);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((err) => { console.error(`contract-update: ${(err as Error).message}`); process.exit(1); });
}
