// -----------------------------------------------------------------------------
// Per-chain factory blacklist.
//
// Factories on the blacklist are excluded from EVERY operation — scanner,
// reserves, triangles, evaluator. The exclusion happens once, in
// loadChainConfig(), so downstream code doesn't have to know about it.
//
// File format: `conf/<chain>-blacklist.json5`
//
//   {
//     factories: [
//       {
//         address: "0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f",
//         reason:  "dead scaffolding — 1/274 pairs with reserves (CREATE2 spoof of mainnet UniV2)",
//         addedAt: "2026-08-31"
//       },
//     ]
//   }
//
// Why per-chain: a factory address that's dead on Polygon might exist and
// be perfectly healthy on another chain. Blacklists don't cross chains.
//
// Why a separate file: it changes independently from the main config, and
// keeping it separate makes reverting a blacklist decision a single-file
// diff. It's also human-editable — you can just remove an entry to bring
// a factory back into scope.
// -----------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSON5 from 'json5';
import { appendToBlacklistText } from './conf-edit.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONF_DIR  = path.resolve(__dirname, '..', '..', 'conf');

export type BlacklistEntry = {
    address: string;
    reason?: string;
    addedAt?: string;
};

export type Blacklist = {
    factories: BlacklistEntry[];
};

/**
 * Load a chain's blacklist. Missing file = empty blacklist (no error).
 * Address matching is case-insensitive.
 */
export function loadBlacklist(chainLabel: string): Blacklist {
    const p = path.join(CONF_DIR, `${chainLabel}-blacklist.json5`);
    if (!fs.existsSync(p)) return { factories: [] };
    let raw: any;
    try {
        raw = JSON5.parse(fs.readFileSync(p, 'utf8'));
    } catch (err) {
        console.warn(`[blacklist] Failed to parse ${p}: ${(err as Error).message} — NO factories are blacklisted until it is fixed`);
        return { factories: [] };
    }
    // One bad entry must not cost the other 1,400: skip it, loudly, and keep
    // the rest. (Polygon, 2026-10-13: a hand-added `addesss:` threw inside the
    // map and the whole file was dropped — every blacklisted factory was back
    // in the config.)
    const factories: BlacklistEntry[] = [];
    const list: unknown[] = Array.isArray(raw?.factories) ? raw.factories : [];
    list.forEach((f: any, i: number) => {
        const addr = typeof f === 'string' ? f : f?.address;
        if (typeof addr !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(addr)) {
            const hint = f && typeof f === 'object'
                ? Object.keys(f).filter(k => k !== 'address' && typeof f[k] === 'string' && /^0x[0-9a-fA-F]{40}$/.test(f[k])).map(k => ` — "${k}" holds an address; did you mean "address"?`).join('')
                : '';
            console.warn(`[blacklist] ${path.basename(p)}: entry #${i} has no valid address, skipped: ${JSON.stringify(f).slice(0, 160)}${hint}`);
            return;
        }
        // Normalize addresses to lowercase for consistent matching
        factories.push(typeof f === 'string' ? { address: addr.toLowerCase() } : { ...f, address: addr.toLowerCase() });
    });
    return { factories };
}

/**
 * Return a Set of blacklisted addresses for fast lookup in config filter.
 */
export function blacklistedAddresses(chainLabel: string): Set<string> {
    const bl = loadBlacklist(chainLabel);
    return new Set(bl.factories.map(f => f.address));
}

/**
 * Append entries to a chain's blacklist file. Creates the file if missing.
 * De-duplicates by address (case-insensitive) — existing entries win.
 *
 * Used by `yarn reserves --blacklist-dead`, `yarn probe` and `yarn verify-fees --apply`.
 * An existing file is edited in place — its comments are kept.
 */
export function appendToBlacklist(chainLabel: string, entries: BlacklistEntry[]): { added: number; skipped: number } {
    if (entries.length === 0) return { added: 0, skipped: 0 };
    if (!fs.existsSync(CONF_DIR)) throw new Error(`no conf directory at ${CONF_DIR}`);

    const p = path.join(CONF_DIR, `${chainLabel}-blacklist.json5`);
    const existing = loadBlacklist(chainLabel);
    const existingAddrs = new Set(existing.factories.map(f => f.address));

    let added = 0;
    let skipped = 0;
    for (const entry of entries) {
        const addr = entry.address.toLowerCase();
        if (existingAddrs.has(addr)) {
            skipped++;
            continue;
        }
        existing.factories.push({
            ...entry,
            address: addr,
            addedAt: entry.addedAt ?? new Date().toISOString().slice(0, 10),
        });
        existingAddrs.add(addr);
        added++;
    }

    const fresh = existing.factories.slice(existing.factories.length - added);
    if (fs.existsSync(p)) {
        // Edit the text, so the file's comments and formatting survive.
        // Throws (file untouched) if the result would not read back right.
        const text = appendToBlacklistText(fs.readFileSync(p, 'utf8'), fresh);
        const tmp = `${p}.tmp-${process.pid}`;
        fs.writeFileSync(tmp, text, 'utf8');
        fs.renameSync(tmp, p);
        return { added, skipped };
    }

    // New file: a stable, human-friendly format (JSON5.stringify quotes everything).
    const lines: string[] = ['{', '    factories: ['];
    for (const f of fresh) {
        lines.push('        {');
        lines.push(`            address: "${f.address}",`);
        if (f.reason)  lines.push(`            reason:  ${JSON.stringify(f.reason)},`);
        if (f.addedAt) lines.push(`            addedAt: "${f.addedAt}",`);
        lines.push('        },');
    }
    lines.push('    ]');
    lines.push('}');
    fs.writeFileSync(p, lines.join('\n') + '\n', 'utf8');

    return { added, skipped };
}
