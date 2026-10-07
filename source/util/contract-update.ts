// Copy freshly deployed contract addresses from Hardhat Ignition's record into
// the chain block of conf/<chain>.json5.
//
//   yarn contract-update <chain> [--dry-run] [--deployment <id>]
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

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import JSON5 from 'json5';
import { resolveChain } from './config.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

type Field = 'contract' | 'executor' | 'probe' | 'liquidator';

/** Futures per field, most preferred first. */
export const FIELD_FUTURES: Record<Field, string[]> = {
    contract: ['Yo3Module#YoBatches3', 'Yo2Module#YoBatches2', 'YoModule#YoBatches'],
    executor: ['FlashArbModule#FlashArbExecutor'],
    probe:    ['TokenProbeModule#TokenProbe'],
    liquidator: ['LiquidationModule#LiquidationExecutor'],
};

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export interface Change {
    field: Field;
    future: string;
    address: string;
    previous?: string;          // the value that was there, when one was
    action: 'unchanged' | 'replaced' | 'uncommented' | 'inserted';
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
                lines.forEach((l, j) => { if (/^[ \t]*(['"]?)(token|contract|executor|probe|liquidator)\1[ \t]*:/.test(l)) at = j; });
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
    process.exit(1);
}

async function main() {
    const args = process.argv.slice(2);
    const slug = args.find(a => !a.startsWith('--'));
    if (!slug) usage();
    const dryRun = args.includes('--dry-run');
    const di = args.indexOf('--deployment');
    const deploymentArg = di >= 0 ? args[di + 1] : undefined;
    if (di >= 0 && !deploymentArg) usage('--deployment needs an id');

    const meta = resolveChain(slug);
    const confPath = path.join(PROJECT_ROOT, 'conf', `${meta.label}.json5`);
    if (!fs.existsSync(confPath)) usage(`No config at ${path.relative(PROJECT_ROOT, confPath)} — run yarn add-chain first.`);
    const original = fs.readFileSync(confPath, 'utf8');

    // The conf file's chain.id wins over the registry's, as in loadChainConfig.
    const parsed = JSON5.parse(original) as { chain?: { id?: number } };
    const chainId = parsed.chain?.id ?? meta.id;
    const deploymentId = deploymentArg ?? `chain-${chainId}`;
    const addrPath = path.join(PROJECT_ROOT, 'ignition', 'deployments', deploymentId, 'deployed_addresses.json');
    if (!fs.existsSync(addrPath)) {
        console.error(`No Ignition record for ${meta.name} at ${path.relative(PROJECT_ROOT, addrPath)}.`);
        console.error(`Deploy first: yarn deploy-contract ${meta.label} / yarn deploy-flasharb ${meta.label} / yarn deploy-probe ${meta.label} / yarn deploy-liquidator ${meta.label}`);
        process.exit(1);
    }
    const deployed = JSON.parse(fs.readFileSync(addrPath, 'utf8')) as Record<string, string>;

    console.log(`${meta.name} (chain ${chainId})`);
    console.log(`  from ${path.relative(PROJECT_ROOT, addrPath)}`);
    console.log(`  into ${path.relative(PROJECT_ROOT, confPath)}${dryRun ? '  (dry run)' : ''}\n`);

    const updates = pickAddresses(deployed);
    for (const field of Object.keys(FIELD_FUTURES) as Field[]) {
        if (!updates.some(u => u.field === field)) {
            console.log(`  ${field.padEnd(9)} — nothing deployed (${FIELD_FUTURES[field].join(' / ')}); left as is`);
        }
    }
    if (updates.length === 0) { console.log('\nNothing to update.'); return; }

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

    if (text === original) { console.log('\nNo changes.'); return; }
    if (dryRun) { console.log('\nDry run: file not written.'); return; }

    const tmp = confPath + '.tmp';
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, confPath);
    console.log(`\nUpdated ${path.relative(PROJECT_ROOT, confPath)}.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((err) => { console.error(`contract-update: ${(err as Error).message}`); process.exit(1); });
}
