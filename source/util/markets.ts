// -----------------------------------------------------------------------------
// Lending-market address book: conf/markets/<protocol>.json.
//
// One file per protocol, keyed by chain id, so add-chain, liq-watch, the
// lender book and verify-markets all read the same addresses:
//
//   {
//     "_doc": "…",                         keys that are not chain ids are ignored
//     "8453": {
//       "chain": "base",                   a label for logs; the id is the key
//       "markets": [
//         { "name": "aave", "address": "0x…", "deployBlock": 2357108 }
//       ]
//     }
//   }
//
//   aave-v3       one entry per Pool; name 'aave' is Aave's own market, any
//                 other name is a fork (SparkLend, HyperLend, …). Optional
//                 addressesProvider / dataProvider, cross-checked on-chain.
//   morpho-blue   the chain's singleton (one entry).
//   compound-v3   one entry per Comet; name optional (base symbol otherwise).
//
// deployBlock is optional everywhere; `yarn verify-markets all --blocks` finds
// the missing ones and writes them back. Nothing here is trusted blindly:
// `yarn verify-markets` checks every address on its chain.
// -----------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROTOCOLS = ['aave-v3', 'morpho-blue', 'compound-v3'] as const;
export type Protocol = typeof PROTOCOLS[number];

export type MarketEntry = {
    /** 'aave' / 'morpho' / a fork's name / a Comet's base ('usdc'). */
    name?: string;
    address: string;
    deployBlock?: number;
    /** Another brand for the same contract (Tydro = Aave on Ink). */
    aka?: string;
    addressesProvider?: string;
    dataProvider?: string;
};
export type ChainMarkets = { chain: string; markets: MarketEntry[] };
export type MarketBook = Map<number, ChainMarkets>;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const MARKETS_DIR = path.join(ROOT, 'conf', 'markets');
export const marketsFile = (p: Protocol) => path.join(MARKETS_DIR, `${p}.json`);

const cache = new Map<Protocol, MarketBook>();

/** Every chain's markets for one protocol. A missing file is an empty book. */
export function loadMarkets(protocol: Protocol, opts: { fresh?: boolean } = {}): MarketBook {
    if (!opts.fresh && cache.has(protocol)) return cache.get(protocol)!;
    const book: MarketBook = new Map();
    const file = marketsFile(protocol);
    if (fs.existsSync(file)) {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
        for (const [key, v] of Object.entries(raw)) {
            if (!/^\d+$/.test(key)) continue;                 // _doc and friends
            const id = Number(key);
            const entry = v as Partial<ChainMarkets>;
            const seen = new Set<string>();
            const markets: MarketEntry[] = [];
            for (const m of entry.markets ?? []) {
                if (!m?.address || !/^0x[0-9a-fA-F]{40}$/.test(m.address)) {
                    throw new Error(`${path.relative(ROOT, file)}: chain ${id} has a market without a valid address (${JSON.stringify(m)})`);
                }
                const a = m.address.toLowerCase();
                if (seen.has(a)) { console.warn(`[markets] ${protocol} chain ${id}: ${m.address} listed twice — using the first`); continue; }
                seen.add(a);
                markets.push(m);
            }
            book.set(id, { chain: entry.chain ?? String(id), markets });
        }
    } else {
        console.warn(`[markets] ${path.relative(ROOT, file)} not found — no ${protocol} addresses`);
    }
    cache.set(protocol, book);
    return book;
}

/** One chain's markets for one protocol (empty when it has none). */
export function marketsFor(protocol: Protocol, chainId: number): MarketEntry[] {
    return loadMarkets(protocol).get(Number(chainId))?.markets ?? [];
}

/**
 * The Aave V3 Pool a chain should use by default: Aave's own market when it
 * has one, else the first fork listed.
 */
export function defaultAavePool(chainId: number): MarketEntry | undefined {
    const ms = marketsFor('aave-v3', chainId);
    return ms.find(m => m.name === 'aave') ?? ms[0];
}

/** Write a book back, keeping the file's non-chain keys (_doc). */
export function saveMarkets(protocol: Protocol, book: MarketBook): void {
    const file = marketsFile(protocol);
    let extra: Record<string, unknown> = {};
    try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
        extra = Object.fromEntries(Object.entries(raw).filter(([k]) => !/^\d+$/.test(k)));
    } catch { /* new file */ }
    // Built by hand: a JS object always lists integer keys first, which would
    // move _doc to the bottom of the file.
    const parts = [
        ...Object.entries(extra).map(([k, v]) => [k, v] as const),
        ...[...book.keys()].sort((a, b) => a - b).map(id => [String(id), book.get(id)] as const),
    ].map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v, null, 2).replace(/\n/g, '\n  ')}`);
    fs.writeFileSync(file, `{\n${parts.join(',\n')}\n}\n`);
    cache.set(protocol, book);
}
