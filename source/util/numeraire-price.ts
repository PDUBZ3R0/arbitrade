// -----------------------------------------------------------------------------
// Numeraire pricing, DB-backed variant.
//
// The ratio of reserves in a direct DEX pair between two tokens IS the
// exchange rate, so no price oracle is needed to convert "0.10
// numeraire-token-worth" into "how much of THIS token is that". This module
// is for callers that don't hold every pair+reserve in memory (the reserves
// fetcher processes factory-by-factory to keep memory flat on chains with
// 100k+ pairs), so it queries the DB directly instead — via indexed lookups
// on pairs(token0)/pairs(token1), which already exist in the schema.
//
// Two entry points:
//   - findBestDirectPriceFromDb: single-hop only, one token at a time.
//   - buildPriceGraph: multi-hop widest-path search from the numeraire,
//     covering every token reachable within maxHops in ONE traversal. Use
//     this when pricing many tokens over a run (e.g. reserves fetcher's dust
//     filter) — it's both more correct (resolves tokens with no DIRECT
//     numeraire pair but a real path through an intermediate token) and
//     faster than repeated single-hop queries.
//
// Caveat shared by both: this only sees pairs that ALREADY have a reserves
// row in the DB. On a chain's very first `yarn reserves` run, the numeraire's
// own pairs may not be populated yet if they haven't been processed before
// the token being priced — callers should treat a missing/null result as "no
// price available right now" (fall back gracefully), not "no real path
// exists" (though for buildPriceGraph, after a couple of full runs have
// populated most of the DB, a token still missing usually does mean there's
// genuinely no path within maxHops).
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

export type PriceGraphResult = {
    /** token address (lowercase) -> resolved price info. Numeraire itself is included with price=1. */
    prices: Map<string, PriceResult & { hops: number }>;
    nodesExpanded: number;
    hitNodeCap: boolean;
};

const DEFAULT_MAX_HOPS = 3;
const DEFAULT_MAX_NODES = 2000;

/**
 * Multi-hop widest-path price search, starting from `numeraire` and walking
 * outward through DB-known pairs. "Widest path" = at each step, prefer
 * continuing through whichever reachable token has the best liquidity
 * bottleneck so far — this naturally explores well-established, high-
 * liquidity tokens first and pushes genuinely thin/dust tokens to the back
 * of the queue, which is exactly the priority order we want: real tokens
 * get priced before the node cap is hit, marginal ones may not (and
 * probably shouldn't be trusted even if a path existed).
 *
 * A token's price via a 2-hop path (token -> X -> numeraire) is:
 *   price[X] * (reserveX_in_tokenXpair / reserveToken_in_tokenXpair)
 * i.e. chain the pool ratios, using each hop's own reserves — no reliance on
 * any single pool being "correct" beyond its own ratio.
 *
 * Bottleneck liquidity for a path is the MINIMUM of each hop's edge
 * liquidity (weakest link) — a path is only as trustworthy as its thinnest
 * pool, even if other hops are deep.
 *
 * Implementation note: uses a plain array + full sort as the priority queue.
 * Simple, and fine at this scale (capped at maxNodes expansions, typically
 * ≤2000) — a binary heap would be faster but isn't necessary here.
 */
export function buildPriceGraph(
    db: ArbitradeDB,
    numeraire: string,
    decimalsOf: (addr: string) => number,
    opts: { maxHops?: number; maxNodes?: number } = {},
): PriceGraphResult {
    const maxHops = opts.maxHops ?? DEFAULT_MAX_HOPS;
    const maxNodes = opts.maxNodes ?? DEFAULT_MAX_NODES;
    const numeraireLower = numeraire.toLowerCase();

    const prices = new Map<string, PriceResult & { hops: number }>();
    prices.set(numeraireLower, { price: 1, liquidity: Infinity, hops: 0 });

    type QueueItem = { token: string; bottleneck: number; hops: number };
    let queue: QueueItem[] = [{ token: numeraireLower, bottleneck: Infinity, hops: 0 }];
    const visited = new Set<string>();
    let nodesExpanded = 0;

    const getNeighborsStmt = db.db.prepare(`
        SELECT p.token0, p.token1, r.reserves0, r.reserves1
        FROM pairs p
        JOIN reserves r ON r.pair = p.address
        WHERE p.token0 = ? OR p.token1 = ?
    `);

    let hitNodeCap = false;

    while (queue.length > 0) {
        if (nodesExpanded >= maxNodes) { hitNodeCap = true; break; }

        // Pop the highest-bottleneck item (widest path so far).
        queue.sort((a, b) => b.bottleneck - a.bottleneck);
        const current = queue.shift()!;
        if (visited.has(current.token)) continue;
        visited.add(current.token);
        nodesExpanded++;

        if (current.hops >= maxHops) continue; // reached hop limit — don't expand further

        const currentPrice = prices.get(current.token);
        if (!currentPrice) continue;

        const neighbors = getNeighborsStmt.all(current.token, current.token) as Array<{
            token0: string; token1: string; reserves0: string; reserves1: string;
        }>;

        for (const row of neighbors) {
            const currentIsToken0 = row.token0.toLowerCase() === current.token;
            const neighborToken = (currentIsToken0 ? row.token1 : row.token0).toLowerCase();
            if (visited.has(neighborToken)) continue;

            const rCurrent  = Number(currentIsToken0 ? row.reserves0 : row.reserves1);
            const rNeighbor = Number(currentIsToken0 ? row.reserves1 : row.reserves0);
            if (rCurrent <= 0 || rNeighbor <= 0) continue;

            const dCurrent  = decimalsOf(current.token);
            const dNeighbor = decimalsOf(neighborToken);
            const humanCurrent  = rCurrent  / 10 ** dCurrent;
            const humanNeighbor = rNeighbor / 10 ** dNeighbor;
            if (humanNeighbor <= 0) continue;

            // Edge liquidity in numeraire-equivalent terms, anchored on the
            // already-priced side (`current`).
            const edgeLiquidity = humanCurrent * currentPrice.price;
            const neighborPrice = currentPrice.price * (humanCurrent / humanNeighbor);
            const bottleneck = Math.min(current.bottleneck, edgeLiquidity);

            const existing = prices.get(neighborToken);
            if (!existing || bottleneck > existing.liquidity) {
                prices.set(neighborToken, { price: neighborPrice, liquidity: bottleneck, hops: current.hops + 1 });
                queue.push({ token: neighborToken, bottleneck, hops: current.hops + 1 });
            }
        }
    }

    return { prices, nodesExpanded, hitNodeCap };
}
