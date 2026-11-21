// -----------------------------------------------------------------------------
// Sample pairs for the fee and code audits, with or without a pool DB.
//
// verify-fees, check-fee-config and pair-code only want a factory's busiest
// pairs. The DB answers that by reserve size, but a chain that only liquidates
// has no scan. There, ask the factory for its pools between the chain's hub
// tokens (live-pools.ts) and rank them by live depth: those are the pools an
// exit would swap through, and hub tokens need no `yarn probe` to be trusted
// (see pickFeeSamplePairs). A factory with a DB row keeps the DB's answer.
// -----------------------------------------------------------------------------

import fs from 'node:fs';
import type { JsonRpcProvider } from 'ethers';
import type { ChainConfig, NormalizedFactory } from './config.ts';
import { ArbitradeDB } from './db.ts';
import { defaultAavePool } from './markets.ts';
import { LivePools, type PoolRow } from '../liquidation/live-pools.ts';
import { loadAaveMarket } from '../liquidation/aave-v3.ts';
import type { TokenProbe } from './empirical-fee.ts';

export type Sample = { pair: string; token0: string; token1: string; stable: boolean | null };

const HUB_SYMBOL = /^(W?ETH|WBTC|cbBTC|USDC|USDC\.e|USDbC|USDT|USD₮0|USDT0|DAI|WXDAI|WMATIC|WPOL|WAVAX|WBNB|WS|WHYPE|WMON)$/i;

/** The DB, if this chain has one: ArbitradeDB would create an empty file, which reads as a chain with no pools. */
export function openPoolDb(file: string): ArbitradeDB | null {
    return fs.existsSync(file) ? new ArbitradeDB(file) : null;
}

/** Wrapped native plus the blue chips in flashloan.tokens and the chain's Aave market. */
export async function hubTokens(cfg: ChainConfig, provider: JsonRpcProvider): Promise<string[]> {
    const out = new Set<string>();
    if (/^0x[0-9a-fA-F]{40}$/.test(cfg.chain.token ?? '')) out.add(cfg.chain.token!.toLowerCase());
    for (const t of cfg.flashloan?.tokens ?? []) if (HUB_SYMBOL.test(t.symbol ?? '')) out.add(t.address.toLowerCase());
    const pool = defaultAavePool(Number(cfg.chain.id));
    if (pool) {
        try {
            const market = await loadAaveMarket(provider, pool.address);
            for (const r of market.reserves) if (HUB_SYMBOL.test(r.symbol)) out.add(r.asset.toLowerCase());
        } catch { /* best-effort: the other sources may be enough */ }
    }
    return [...out];
}

export const tokenPairs = (tokens: string[]): Array<[string, string]> =>
    tokens.flatMap((a, i) => tokens.slice(i + 1).map(b => [a, b] as [string, string]));

const asSample = (r: PoolRow): Sample => ({ pair: r.address, token0: r.token0, token1: r.token1, stable: r.stable == null ? null : r.stable === 1 });

export class PairSampler {
    private readonly db: ArbitradeDB | null;
    private readonly live = new Map<string, PoolRow[]>();
    /** How many factories came from the factory lookups, and through how many hub tokens. */
    liveFactories = 0;
    hubs = 0;

    private constructor(db: ArbitradeDB | null) { this.db = db; }

    /** Looks up, in one go, every factory the DB has no sample for. */
    static async open(cfg: ChainConfig, provider: JsonRpcProvider, factories: NormalizedFactory[], db: ArbitradeDB | null): Promise<PairSampler> {
        const s = new PairSampler(db);
        const missing = factories.filter(f => !db?.getSamplePairForFactory(f.address));
        if (!missing.length) return s;
        const tokens = await hubTokens(cfg, provider);
        s.hubs = tokens.length;
        const live = new LivePools(provider, missing);
        await live.load(tokenPairs(tokens));
        for (const [factory, rows] of live.byFactory()) s.live.set(factory, rows.filter(r => r.kind === 'v2'));
        s.liveFactories = s.live.size;
        return s;
    }

    /** Busiest pairs first; `limit` caps either source. */
    pairs(factory: string, limit: number): Sample[] {
        const db = this.db?.getPairsForFactory(factory, limit) ?? [];
        if (db.length) return db.map(p => ({ ...p, stable: this.db!.pairStable(p.pair) }));
        const any = this.db?.getSamplePairForFactory(factory);
        if (any) return [{ ...any, stable: this.db!.pairStable(any.pair) }];
        return (this.live.get(factory.toLowerCase()) ?? []).slice(0, limit).map(asSample);
    }

    tokenProbes(tokens: string[]): Map<string, TokenProbe> { return this.db?.getTokenProbes(tokens) ?? new Map(); }
}
