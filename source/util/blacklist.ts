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
    try {
        const raw = JSON5.parse(fs.readFileSync(p, 'utf8'));
        // Normalize addresses to lowercase for consistent matching
        const factories = (raw.factories ?? []).map((f: BlacklistEntry) => ({
            ...f,
            address: f.address.toLowerCase(),
        }));
        return { factories };
    } catch (err) {
        console.warn(`[blacklist] Failed to parse ${p}: ${(err as Error).message}`);
        return { factories: [] };
    }
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
 * Used by `yarn reserves --blacklist-dead` after the run's summary.
 */
export function appendToBlacklist(chainLabel: string, entries: BlacklistEntry[]): { added: number; skipped: number } {
    if (entries.length === 0) return { added: 0, skipped: 0 };

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

    // Serialize in a stable, human-friendly format. JSON5's built-in stringify
    // adds a lot of quoting; roll a simple emitter for readability.
    const lines: string[] = ['{', '    factories: ['];
    for (const f of existing.factories) {
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
