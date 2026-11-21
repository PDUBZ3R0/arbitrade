// -----------------------------------------------------------------------------
// DefiLlama, for naming a discovered factory.
//
// Its API has no factory lookup: /protocols gives names, chains and TVL, and
// nothing about contracts. But each protocol names its TVL adapter, and
// DefiLlama-Adapters is public, and a DEX's adapter usually holds its factory
// addresses. On Base, 28 of the conf's factories matched that way (Uniswap V2,
// Aerodrome Slipstream, Quickswap Dex, …). An address in an adapter is evidence;
// a shared contract name is not: every fork is called UniswapV2Factory, so only
// DexScreener's dexId is used as a name hint.
//
// Cached a day in log/<label>/llama-dex.json. Best-effort, like DexScreener: no
// answer never blocks a factory.
// -----------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';

const PROTOCOLS = 'https://api.llama.fi/protocols';
const ADAPTERS = 'https://raw.githubusercontent.com/DefiLlama/DefiLlama-Adapters/main/projects/';
const CACHE_MS = 24 * 3600_000;
const CONCURRENCY = 16;
const ADDRESS = /0x[0-9a-fA-F]{40}/g;

// conf/@chains.json5 name -> DefiLlama's, where they differ.
const LLAMA_CHAIN: Record<string, string> = {
    'Binance Smart Chain': 'Binance', Gnosis: 'xDai', opBNB: 'Op_Bnb', Hyperliquid: 'Hyperliquid L1',
    'Arbitrum One': 'Arbitrum', 'Avalanche C-Chain': 'Avalanche', Robinhood: 'Robinhood Chain',
    Hydration: 'HydraDX', katana: 'Katana', 'Metis Andromeda': 'Metis',
};

type Protocol = { name: string; slug: string; parent: string | null; tvl: number; module: string | null };
export type LlamaIndex = { at: number; chain: string; protocols: Protocol[]; byAddress: Record<string, string[]> };
export type LlamaMatch = { name: string; via: 'adapter' | 'dexscreener'; tvl: number; slug: string };

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Exact name, slug or parent match only: "uniswap" must not find "Uniswap Fork Of A Fork". */
export function identifyDex(index: LlamaIndex, address: string, dexId?: string | null): LlamaMatch | null {
    const of = (p: Protocol, via: LlamaMatch['via']): LlamaMatch => ({ name: p.name, via, tvl: p.tvl, slug: p.slug });
    const names = index.byAddress[address.toLowerCase()];
    if (names?.length) {
        const hits = index.protocols.filter(p => names.includes(p.name)).sort((a, b) => b.tvl - a.tvl);
        if (hits.length) return of(hits[0], 'adapter');
    }
    if (dexId) {
        const want = squash(dexId);
        const hits = index.protocols.filter(p => [p.name, p.slug, p.parent ?? ''].some(n => squash(n) === want)).sort((a, b) => b.tvl - a.tvl);
        if (hits.length) return of(hits[0], 'dexscreener');
    }
    return null;
}

/** The DEXes DefiLlama lists on a chain, from raw `/protocols` rows and their adapter sources. */
export function buildIndex(chain: string, rows: any[], sources: Map<string, string>, at = Date.now()): LlamaIndex {
    const protocols: Protocol[] = rows.filter(p => p.category === 'Dexs' && p.chains?.includes(chain)).map(p => ({
        name: p.name, slug: p.slug, parent: p.parentProtocol?.replace(/^parent#/, '') ?? null, tvl: p.tvl ?? 0, module: p.module ?? null,
    }));
    const byAddress: Record<string, string[]> = {};
    for (const p of protocols) {
        for (const a of new Set((sources.get(p.module ?? '') ?? '').match(ADDRESS)?.map(x => x.toLowerCase()) ?? [])) (byAddress[a] ??= []).push(p.name);
    }
    return { at, chain, protocols, byAddress };
}

async function fetchOk(url: string): Promise<Response | null> {
    try {
        const r = await fetch(url, { signal: AbortSignal.timeout(30_000) });
        return r.ok ? r : null;
    } catch { return null; }
}

export async function loadLlamaIndex(chainName: string, cacheFile: string, now = Date.now()): Promise<LlamaIndex | null> {
    const chain = LLAMA_CHAIN[chainName] ?? chainName;
    try {
        const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as LlamaIndex;
        if (cached.chain === chain && now - cached.at < CACHE_MS) return cached;
    } catch { /* no cache yet */ }

    const res = await fetchOk(PROTOCOLS);
    if (!res) return null;
    const rows = await res.json() as any[];
    const modules = [...new Set(rows.filter(p => p.category === 'Dexs' && p.chains?.includes(chain) && p.module).map(p => p.module as string))];
    const sources = new Map<string, string>();
    let next = 0;
    await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
        while (next < modules.length) {
            const m = modules[next++];
            // Many are 404s: a module can be a directory or live with the dimension adapters.
            const r = await fetchOk(ADAPTERS + m);
            if (r) sources.set(m, await r.text());
        }
    }));
    const index = buildIndex(chain, rows, sources, now);
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(index));
    return index;
}
