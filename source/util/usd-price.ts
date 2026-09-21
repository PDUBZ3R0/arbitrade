// -----------------------------------------------------------------------------
// USD price lookup via CoinGecko's free token_price API.
//
// Used ONLY for the trade ledger's profitUsd column — this is NOT part of
// the trading/evaluation pipeline itself (piece 5's evaluator and piece 6's
// build-hops.ts both stay on-chain reserve-ratio pricing against the chain's
// own numeraire token, with no external dependency — see evaluator.ts's
// findBestDirectPrice doc). A missing or failed USD price here doesn't block
// a trade or a ledger write; it just means profitUsd is null for that row
// until reconciled later.
//
// Free tier: no API key required, ~10-30 req/min. Set COINGECKO_API_KEY in
// .env to use a demo/pro key instead (higher rate limits) — the header name
// differs between demo and pro keys; this uses the demo header since that's
// what a free CoinGecko account provides.
// -----------------------------------------------------------------------------

// CoinGecko "asset platform" IDs — verified against CoinGecko's own docs
// (docs.coingecko.com), NOT guessed. Only add a chain here once its platform
// ID is actually confirmed; an unmapped chain just returns null (logged),
// not a wrong price.
const PLATFORM_BY_CHAIN: Record<string, string> = {
    polygon: 'polygon-pos',
    gnosis: 'xdai',
    base: 'base',
    sonic: 'sonic',
    ethereum: 'ethereum',
};

/**
 * Fetch the current USD price for a token by contract address. Returns null
 * (never throws) if the chain isn't mapped, the request fails, or the token
 * isn't listed on CoinGecko — all non-fatal for the ledger write.
 */
export async function fetchUsdPrice(chainLabel: string, tokenAddress: string): Promise<number | null> {
    const platform = PLATFORM_BY_CHAIN[chainLabel.toLowerCase()];
    if (!platform) {
        console.log(`[usd-price] No CoinGecko platform mapped for chain "${chainLabel}" — profitUsd will be null. Add it to PLATFORM_BY_CHAIN once confirmed on docs.coingecko.com.`);
        return null;
    }

    const addr = tokenAddress.toLowerCase();
    const url = `https://api.coingecko.com/api/v3/simple/token_price/${platform}` +
        `?contract_addresses=${addr}&vs_currencies=usd`;

    const headers: Record<string, string> = {};
    if (process.env.COINGECKO_API_KEY) {
        headers['x-cg-demo-api-key'] = process.env.COINGECKO_API_KEY;
    }

    try {
        const res = await fetch(url, { headers });
        if (!res.ok) {
            console.log(`[usd-price] CoinGecko request failed (${res.status}) for ${chainLabel}:${addr}`);
            return null;
        }
        const data = await res.json() as Record<string, { usd?: number }>;
        const price = data[addr]?.usd;
        return typeof price === 'number' ? price : null;
    } catch (err) {
        console.log(`[usd-price] CoinGecko request errored for ${chainLabel}:${addr}: ${(err as Error).message}`);
        return null;
    }
}
