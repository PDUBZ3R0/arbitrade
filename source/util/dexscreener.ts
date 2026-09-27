// -----------------------------------------------------------------------------
// DexScreener lookup.
//
// Surfaces raw DEX-identity/liquidity data for a sample pair, so a newly-
// discovered factory during `find-factories` can be eyeballed for red flags
// the way Polygon's Panaromaswap factory was identified — DexScreener
// labeled it "Unknown DEX", and separately, Token Sniffer / Quick Intel
// flagged the token — without a manual web search every time.
//
// SCOPE NOTE, read before trusting this too much: this uses DexScreener's
// own public REST API (api.dexscreener.com, no key needed; confirmed fields
// are chainId, dexId, labels, liquidity.usd, pairCreatedAt, url). It does
// NOT integrate Token Sniffer or Quick Intel — those are separate
// third-party services embedded in DexScreener's website UI, not exposed
// through DexScreener's own API. This surfaces DexScreener's raw data for a
// human to judge, and flags an unrecognized dexId as "worth a manual look"
// — it is NOT a verified scam/honeypot detector on its own. Panaromaswap's
// actual confirmation came from the on-chain UNAUTHORISED revert plus the
// third-party scores, not from DexScreener's dexId alone.
// -----------------------------------------------------------------------------

// Chain label -> DexScreener chainId slug. Only chains actually confirmed
// against DexScreener (dexscreener.com/<chainId>/... resolving, or their own
// published examples) are included — add more only once verified. A wrong
// slug here wouldn't error, it would just silently return "no pair found"
// for every lookup on that chain, which is worse than an honest gap.
const CHAIN_ID_MAP: Record<string, string> = {
    polygon: 'polygon',
    base: 'base',
    sonic: 'sonic',
    ink: 'ink'
    // gnosis, sonic: not yet confirmed against DexScreener's own chainId
    // slugs in this codebase — add once verified.
};

export type DexScreenerPairInfo = {
    chainId: string;
    dexId: string;
    labels: string[];
    liquidityUsd: number | null;
    pairCreatedAt: number | null;   // unix ms
    url: string;
    baseSymbol: string;
    quoteSymbol: string;
};

/**
 * Look up a single pair on DexScreener. Returns null if the chain isn't
 * mapped, the request fails, or DexScreener has no listing for this pair
 * (common for a very new or very thin factory that's never been indexed).
 */
export async function lookupPairOnDexScreener(
    chainLabel: string,
    pairAddress: string,
): Promise<DexScreenerPairInfo | null> {
    const chainId = CHAIN_ID_MAP[chainLabel.toLowerCase()];
    if (!chainId) return null;

    const url = `https://api.dexscreener.com/latest/dex/pairs/${chainId}/${pairAddress.toLowerCase()}`;
    try {
        const res = await fetch(url);
        if (!res.ok) return null;
        const data = await res.json() as { pairs?: Array<{
            chainId: string; dexId: string; labels?: string[];
            liquidity?: { usd?: number }; pairCreatedAt?: number; url: string;
            baseToken?: { symbol?: string }; quoteToken?: { symbol?: string };
        }> };
        const pair = data.pairs?.[0];
        if (!pair) return null;
        return {
            chainId: pair.chainId,
            dexId: pair.dexId,
            labels: pair.labels ?? [],
            liquidityUsd: pair.liquidity?.usd ?? null,
            pairCreatedAt: pair.pairCreatedAt ?? null,
            url: pair.url,
            baseSymbol: pair.baseToken?.symbol ?? '?',
            quoteSymbol: pair.quoteToken?.symbol ?? '?',
        };
    } catch {
        return null;
    }
}

// A short, deliberately non-exhaustive list of well-established DEX ids.
// Absence from this list does NOT mean a DEX is bad — only that it's worth
// the same kind of manual glance an unrecognized one would get.
const WELL_KNOWN_DEX_IDS = new Set([
    'uniswap', 'quickswap', 'sushiswap', 'pancakeswap', 'curve', 'balancer',
    'apeswap', 'spookyswap', 'velodrome', 'aerodrome', 'camelot', 'shadow-exchange',
]);

export function isWellKnownDex(dexId: string): boolean {
    return WELL_KNOWN_DEX_IDS.has(dexId.toLowerCase());
}
