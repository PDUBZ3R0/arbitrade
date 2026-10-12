// -----------------------------------------------------------------------------
// Swap roots: tokens a cycle may start and end in when it is funded by
// flash-swapping its first hop rather than borrowed from a lender.
//
// A lender can only lend what it holds, so without flash swaps every cycle has
// to start at a configured flash-loan token. A flash swap borrows from the
// cycle's own first pair, so any token can be the start — provided we can say
// what the profit is WORTH, because the gas floor is priced in the numeraire
// and a profit in a token we cannot price is a profit we cannot compare with
// gas. That is the whole admission rule: a swap root is a token with a direct
// V2-style pair against the chain's numeraire holding at least `minLiquidity`
// numeraire, and its price is that pair's reserve ratio.
//
// V2-style (constant-product, non-stable) pairs only: a concentrated-liquidity
// pool's token balances are not its price, and a stable pool's ratio is not
// either. The deepest qualifying pair wins, as in the evaluator's pricing of
// flash tokens, since the deepest pair is the hardest to have been pushed.
//
// Shared by the enumerator (which roots to enumerate from), the evaluator
// (thresholds and rootPricing) and therefore the hot loop and executor, so all
// of them agree on which tokens are roots and what they are worth.
// -----------------------------------------------------------------------------

import type { ArbitradeDB } from './db.ts';
import { flashSwapEnabled, type ChainConfig } from './config.ts';
import { UNSAFE_TOKEN_STATUSES } from './db.ts';

export type SwapRootPrice = {
    /** Numeraire per 1 whole token. */
    price: number;
    /** Numeraire-side depth of the pricing pair, in whole numeraire. */
    liquidity: number;
    decimals: number;
    symbol?: string;
};

/** `flashloan.swapRoots.minLiquidity`, or null when swap roots are off (they need flashSwap). */
export function swapRootsMinLiquidity(cfg: Pick<ChainConfig, 'flashloan'>): number | null {
    if (!flashSwapEnabled(cfg)) return null;
    const v = cfg.flashloan?.swapRoots?.minLiquidity;
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}

type PricingPair = {
    token0: string; token1: string;
    reserves0: number | string | bigint; reserves1: number | string | bigint;
    kind?: string; stable?: boolean | number | null;
};

/**
 * Price every token that has a qualifying direct pair with `numeraire`.
 * Excludes the numeraire itself and anything in `exclude` (the flash tokens,
 * which are priced the way they always were).
 */
export function priceSwapRoots(
    pairs: Iterable<PricingPair>,
    numeraire: string,
    decimalsOf: (addr: string) => number,
    minLiquidity: number,
    exclude: Set<string> = new Set(),
): Map<string, SwapRootPrice> {
    const num = numeraire.toLowerCase();
    const numDec = decimalsOf(num);
    const out = new Map<string, SwapRootPrice>();
    for (const p of pairs) {
        if (p.kind === 'v3' || p.stable) continue;
        const t0 = p.token0.toLowerCase(), t1 = p.token1.toLowerCase();
        let token: string, rToken: number, rNum: number;
        if (t0 === num)      { token = t1; rToken = Number(p.reserves1); rNum = Number(p.reserves0); }
        else if (t1 === num) { token = t0; rToken = Number(p.reserves0); rNum = Number(p.reserves1); }
        else continue;
        if (token === num || exclude.has(token)) continue;
        if (!(rToken > 0 && rNum > 0)) continue;
        const liquidity = rNum / 10 ** numDec;
        if (liquidity < minLiquidity) continue;
        const decimals = decimalsOf(token);
        const prev = out.get(token);
        if (prev && prev.liquidity >= liquidity) continue;
        out.set(token, { price: liquidity / (rToken / 10 ** decimals), liquidity, decimals });
    }
    return out;
}

/**
 * Swap roots straight from the DB — for the enumerator, which does not load
 * reserves for scoring. Tokens the probe marked unsafe (honeypot,
 * fee-on-transfer, …) are never roots: a taxed root underpays the borrowed
 * pair and every attempt reverts. Ordered deepest first.
 */
export function loadSwapRoots(db: ArbitradeDB, cfg: ChainConfig): Map<string, SwapRootPrice> {
    const minLiquidity = swapRootsMinLiquidity(cfg);
    const numeraire = cfg.chain.token?.toLowerCase();
    if (minLiquidity == null || !numeraire) return new Map();

    const rows = db.db.prepare(`
        SELECT p.token0, p.token1, p.kind, p.stable, r.reserves0, r.reserves1
        FROM pairs p JOIN reserves r ON r.pair = p.address
        WHERE (p.token0 = ? OR p.token1 = ?) AND p.kind = 'v2' AND (p.stable IS NULL OR p.stable = 0)
    `).all(numeraire, numeraire) as PricingPair[];

    const tokenRows = db.db.prepare(`SELECT address, symbol, decimals, probeStatus FROM tokens`).all() as
        Array<{ address: string; symbol: string | null; decimals: number | null; probeStatus: string | null }>;
    const meta = new Map(tokenRows.map(t => [t.address.toLowerCase(), t]));
    const unsafe = new Set<string>(UNSAFE_TOKEN_STATUSES as readonly string[]);
    const flash = new Set((cfg.flashloan?.tokens ?? []).map(t => t.address.toLowerCase()));
    for (const t of cfg.flashloan?.tokens ?? []) if (!meta.has(t.address.toLowerCase())) {
        meta.set(t.address.toLowerCase(), { address: t.address, symbol: t.symbol, decimals: t.decimals, probeStatus: null });
    }
    // Unknown decimals: not a root. Guessing 18 for a 6-decimal token misprices
    // it by 10^12, and this price is what the gas floor is computed from.
    const decimalsOf = (a: string) => meta.get(a)?.decimals ?? NaN;

    const priced = priceSwapRoots(rows, numeraire, decimalsOf, minLiquidity, flash);
    const ordered = [...priced.entries()]
        .filter(([a, p]) => Number.isFinite(p.decimals) && !unsafe.has(meta.get(a)?.probeStatus ?? ''))
        .sort((x, y) => y[1].liquidity - x[1].liquidity)
        .map(([a, p]) => [a, { ...p, symbol: meta.get(a)?.symbol ?? undefined }] as const);
    return new Map(ordered);
}
