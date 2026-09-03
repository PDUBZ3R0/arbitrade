// -----------------------------------------------------------------------------
// Numeraire pricing, DB-backed variant.
//
// Same idea as evaluator.ts's in-memory findBestDirectPrice: the ratio of
// reserves in a direct DEX pair between two tokens IS the exchange rate, so
// no price oracle is needed to convert "0.10 numeraire-token-worth" into
// "how much of THIS token is that". evaluator.ts has its own in-memory
// version because it already holds every pair+reserve in a Map for the
// whole run — this module is for callers that DON'T hold that (the reserves
// fetcher processes factory-by-factory specifically to keep memory flat on
// chains with 100k+ pairs), so it queries the DB directly instead.
//
// Caveat: this only sees pairs that ALREADY have a reserves row in the DB.
// On a chain's very first `yarn reserves` run, the numeraire's own pairs may
// not be populated yet if they haven't been processed before the token being
// priced — callers should treat a null result as "no price available right
// now" (fall back gracefully), not "this token has no real pair".
// -----------------------------------------------------------------------------

import type { ArbitradeDB } from './db.ts';

export type PriceResult = { price: number; liquidity: number };

/**
 * Find the best DB-known direct pair between `token` and `numeraire`, and
 * return the implied price (numeraire units per 1 unit of token) plus the
 * numeraire-side liquidity of the pair it came from (for trust-assessment).
 * Returns null if no direct pair with non-zero reserves exists in the DB yet.
 */
export function findBestDirectPriceFromDb(
    db: ArbitradeDB,
    token: string,
    numeraire: string,
    decimalsOf: (addr: string) => number,
): PriceResult | null {
    const tokenLower = token.toLowerCase();
    const numeraireLower = numeraire.toLowerCase();
    if (tokenLower === numeraireLower) return { price: 1, liquidity: Infinity };

    const rows = db.db.prepare(`
        SELECT p.token0, p.token1, r.reserves0, r.reserves1
        FROM pairs p
        JOIN reserves r ON r.pair = p.address
        WHERE (p.token0 = ? AND p.token1 = ?) OR (p.token1 = ? AND p.token0 = ?)
    `).all(tokenLower, numeraireLower, tokenLower, numeraireLower) as Array<{
        token0: string; token1: string; reserves0: string; reserves1: string;
    }>;

    let best: PriceResult | null = null;
    for (const row of rows) {
        const tokenIsToken0 = row.token0.toLowerCase() === tokenLower;
        const rToken     = Number(tokenIsToken0 ? row.reserves0 : row.reserves1);
        const rNumeraire = Number(tokenIsToken0 ? row.reserves1 : row.reserves0);
        if (rToken <= 0 || rNumeraire <= 0) continue;

        const dToken     = decimalsOf(token);
        const dNumeraire = decimalsOf(numeraire);
        const humanToken     = rToken / 10 ** dToken;
        const humanNumeraire = rNumeraire / 10 ** dNumeraire;
        const price = humanNumeraire / humanToken;
        const liquidity = humanNumeraire;

        if (!best || liquidity > best.liquidity) best = { price, liquidity };
    }
    return best;
}
