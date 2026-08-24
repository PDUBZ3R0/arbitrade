// -----------------------------------------------------------------------------
// Triangle enumerator.
//
// Given the pairs on a chain, enumerate arb cycles that start and end at a
// flash-loanable token. These become candidates for the profit evaluator
// (piece 5) to score at each poll cycle.
//
// Design:
//   - We enumerate ONCE and cache in the triangles table. The graph is stable;
//     reserves change every block but the topology doesn't. Rebuild is cheap
//     (a few seconds even on 26K pairs) so `yarn triangles <chain>` is called
//     after significant pair changes or config edits.
//
//   - We only enumerate cycles rooted at flash-loan tokens. On Sonic that's
//     4 tokens out of 26K pairs — a huge reduction from general triangle
//     enumeration.
//
//   - 2-hop cycles: two pairs (R,T) from different factories — classic
//     cross-DEX arb.
//   - 3-hop cycles: R → B → C → R where all three pairs exist. Any factory
//     mix is a distinct candidate (but same-factory-for-all-3 is pruned).
//
//   - Stable pools excluded by default (constant-product math is wrong for
//     x³y+xy³=k curves; add stable-swap support later as an opt-in).
//
//   - Zero-reserve pairs excluded (nothing to arb against).
//
//   - Canonical dedup: cycle A→B→C→A ≡ B→C→A→B ≡ C→A→B→C. We normalize by
//     sorting the pair addresses and using their concatenation as a unique
//     key.
// -----------------------------------------------------------------------------

import { ArbitradeDB } from '../util/db.ts';
import type { ChainConfig } from '../util/config.ts';

export type EnumerateOptions = {
    /** If set, only enumerate triangles rooted at this token address (lowercase). */
    onlyRoot?: string;
    /** If true, include stable pools (constant-product math will be wrong for them). */
    includeStable?: boolean;
    /** Max triangles to emit; helpful during dev to bound explosion. Default: unlimited. */
    limit?: number;
    /** Callback fired periodically with progress info. */
    onProgress?: (info: {
        pairsLoaded: number;
        rootsProcessed: number;
        rootsTotal: number;
        trianglesFound: number;
    }) => void;
};

export type EnumerateResult = {
    trianglesInserted: number;
    duplicatesSkipped: number;
    hops2Count: number;
    hops3Count: number;
    byRoot: Record<string, number>;
    pairsUsed: number;
    elapsedMs: number;
};

// -----------------------------------------------------------------------------

type Pair = {
    pair:    string;   // pair contract address, lowercase
    factory: string;
    token0:  string;   // sorted lexicographically per V2 convention
    token1:  string;
};

/**
 * Canonical dedup key for a triangle. Since an undirected triangle has both
 * a rotational symmetry (start at any pair) AND a reversal symmetry (cycle
 * A→B→C ≡ A→C→B for scoring purposes — the evaluator tries both directions
 * anyway), we sort the three pair addresses lexicographically. Any traversal
 * of the same three pairs produces the same key.
 */
function canonicalKey(pairAB: string, pairBC: string, pairCA: string): string {
    return [pairAB, pairBC, pairCA].sort().join('|');
}

/**
 * Canonical dedup key for a 2-hop cycle. Two pairs share the same two tokens
 * from different factories — order between them doesn't matter.
 */
function canonical2HopKey(pair1: string, pair2: string): string {
    return pair1 < pair2 ? `${pair1}|${pair2}` : `${pair2}|${pair1}`;
}

// -----------------------------------------------------------------------------

/**
 * Enumerate triangles for a chain. Reads pairs from DB, writes triangles to DB.
 *
 * Returns stats about what was inserted. Skips zero-reserve pairs entirely
 * (via getPairsForEnumeration's inner join with reserves).
 */
export async function enumerateTriangles(
    cfg: ChainConfig,
    dbFilePath: string,
    opts: EnumerateOptions = {},
): Promise<EnumerateResult> {
    const t0 = Date.now();

    const flashLoanTokens = (cfg.flashloan?.tokens ?? []).map(t => t.address.toLowerCase());
    if (flashLoanTokens.length === 0) {
        throw new Error(`No flash-loan tokens configured for ${cfg.chain.name}. Set flashloan.tokens in the chain config.`);
    }

    const rootTokens = opts.onlyRoot
        ? [opts.onlyRoot.toLowerCase()].filter(r => flashLoanTokens.includes(r))
        : flashLoanTokens;

    if (rootTokens.length === 0) {
        throw new Error(`No matching root tokens. Provided onlyRoot=${opts.onlyRoot} not in flash-loan set.`);
    }

    const db = new ArbitradeDB(dbFilePath);
    const result: EnumerateResult = {
        trianglesInserted: 0,
        duplicatesSkipped: 0,
        hops2Count: 0,
        hops3Count: 0,
        byRoot: {},
        pairsUsed: 0,
        elapsedMs: 0,
    };

    try {
        // 1. Load all live, non-stable pairs into memory. On Sonic this is
        //    ~26K rows; on Gnosis ~8K. Trivial for in-memory processing.
        const rawPairs = db.getPairsForEnumeration({ includeStable: opts.includeStable });
        result.pairsUsed = rawPairs.length;
        console.log(`Loaded ${rawPairs.length} live pairs (excluding zero-reserve${opts.includeStable ? '' : ' and stable'})`);

        if (rawPairs.length === 0) {
            console.log('No pairs to enumerate. Have you run `yarn reserves <chain>` yet?');
            return { ...result, elapsedMs: Date.now() - t0 };
        }

        // 2. Build the adjacency indexes we'll need:
        //    - byToken:      token address → list of pairs containing that token
        //    - byTokenPair:  "tokenA|tokenB" (sorted) → list of pairs (from any factory)
        const byToken     = new Map<string, Pair[]>();
        const byTokenPair = new Map<string, Pair[]>();
        for (const r of rawPairs) {
            const p: Pair = { pair: r.pair, factory: r.factory, token0: r.token0, token1: r.token1 };
            (byToken.get(p.token0) ?? byToken.set(p.token0, []).get(p.token0)!).push(p);
            (byToken.get(p.token1) ?? byToken.set(p.token1, []).get(p.token1)!).push(p);
            const tk = p.token0 < p.token1 ? `${p.token0}|${p.token1}` : `${p.token1}|${p.token0}`;
            (byTokenPair.get(tk) ?? byTokenPair.set(tk, []).get(tk)!).push(p);
        }
        console.log(`Adjacency: ${byToken.size} distinct tokens, ${byTokenPair.size} distinct token-pairs`);

        // 3. Enumerate rooted triangles. Both 2-hop and 3-hop cycles emitted
        //    into `pending`; we bulk-insert at the end.
        const pending: Parameters<typeof db.insertTriangles>[0] = [];
        const seenCanonical = new Set<string>();

        // For 2-hop, we need to detect multi-factory duplicates of the same
        // token pair. `seen2Hop` tracks pair-of-pairs canonical keys.
        const seen2Hop = new Set<string>();

        let rootsProcessed = 0;
        for (const root of rootTokens) {
            const rootPairs = byToken.get(root) ?? [];
            if (rootPairs.length === 0) {
                console.log(`  root ${root}: no pairs found — skipping`);
                rootsProcessed++;
                continue;
            }

            let rootTriangles = 0;

            // --- 2-hop cycles: two pairs with the same token pair, different factories ---
            // For each unique token pair involving root, if there's more than one pair,
            // every pair-of-pairs (with different factories) is a 2-hop candidate.
            const rootTokenPairs = new Set<string>();
            for (const p of rootPairs) {
                const other = p.token0 === root ? p.token1 : p.token0;
                const tk = root < other ? `${root}|${other}` : `${other}|${root}`;
                rootTokenPairs.add(tk);
            }

            for (const tk of rootTokenPairs) {
                const pairs = byTokenPair.get(tk) ?? [];
                if (pairs.length < 2) continue;
                for (let i = 0; i < pairs.length; i++) {
                    for (let j = i + 1; j < pairs.length; j++) {
                        const p1 = pairs[i];
                        const p2 = pairs[j];
                        if (p1.factory === p2.factory) continue;  // no arb same-factory

                        const key = canonical2HopKey(p1.pair, p2.pair);
                        if (seen2Hop.has(key)) continue;
                        seen2Hop.add(key);

                        // Cycle: root → other (via p1) → root (via p2)
                        const other = p1.token0 === root ? p1.token1 : p1.token0;
                        pending.push({
                            root_token: root,
                            hop_count: 2,
                            token_a: root,
                            token_b: other,
                            token_c: root,
                            pair_ab: p1.pair,
                            pair_bc: p2.pair,
                            pair_ca: p2.pair,  // for 2-hop, ca is same as bc (unused conceptually)
                            factory_ab: p1.factory,
                            factory_bc: p2.factory,
                            factory_ca: p2.factory,
                            canonical: `2h|${key}`,
                        });
                        rootTriangles++;
                        result.hops2Count++;
                        if (opts.limit && pending.length >= opts.limit) break;
                    }
                    if (opts.limit && pending.length >= opts.limit) break;
                }
                if (opts.limit && pending.length >= opts.limit) break;
            }

            // --- 3-hop cycles: root → B → C → root, all three edges must exist ---
            if (!opts.limit || pending.length < opts.limit) {
                for (const pAB of rootPairs) {
                    const tokenB = pAB.token0 === root ? pAB.token1 : pAB.token0;
                    const bPairs = byToken.get(tokenB) ?? [];

                    for (const pBC of bPairs) {
                        if (pBC.pair === pAB.pair) continue;
                        const tokenC = pBC.token0 === tokenB ? pBC.token1 : pBC.token0;
                        if (tokenC === root) continue;  // that would be a 2-hop, already handled

                        // Need a pair between tokenC and root
                        const cRootKey = tokenC < root ? `${tokenC}|${root}` : `${root}|${tokenC}`;
                        const closingPairs = byTokenPair.get(cRootKey) ?? [];
                        if (closingPairs.length === 0) continue;

                        for (const pCA of closingPairs) {
                            if (pCA.pair === pAB.pair || pCA.pair === pBC.pair) continue;

                            // Prune: same factory for all three = no arb possible
                            if (pAB.factory === pBC.factory && pBC.factory === pCA.factory) continue;

                            const canon = `3h|${canonicalKey(pAB.pair, pBC.pair, pCA.pair)}`;
                            if (seenCanonical.has(canon)) continue;
                            seenCanonical.add(canon);

                            pending.push({
                                root_token: root,
                                hop_count: 3,
                                token_a: root,
                                token_b: tokenB,
                                token_c: tokenC,
                                pair_ab: pAB.pair,
                                pair_bc: pBC.pair,
                                pair_ca: pCA.pair,
                                factory_ab: pAB.factory,
                                factory_bc: pBC.factory,
                                factory_ca: pCA.factory,
                                canonical: canon,
                            });
                            rootTriangles++;
                            result.hops3Count++;
                            if (opts.limit && pending.length >= opts.limit) break;
                        }
                        if (opts.limit && pending.length >= opts.limit) break;
                    }
                    if (opts.limit && pending.length >= opts.limit) break;
                }
            }

            result.byRoot[root] = rootTriangles;
            rootsProcessed++;
            console.log(`  root ${root}: ${rootTriangles} candidate triangles`);
            opts.onProgress?.({
                pairsLoaded: rawPairs.length,
                rootsProcessed,
                rootsTotal: rootTokens.length,
                trianglesFound: pending.length,
            });
            if (opts.limit && pending.length >= opts.limit) {
                console.log(`  limit ${opts.limit} reached — stopping enumeration`);
                break;
            }
        }

        // 4. Bulk insert. Duplicates (from re-runs) collapse via ON CONFLICT.
        console.log(`\nInserting ${pending.length} triangles into DB...`);
        // Only clear the roots we're regenerating — preserves other roots when
        // running with --root filter.
        if (opts.onlyRoot) {
            db.clearTrianglesByRoot(opts.onlyRoot);
        } else {
            db.clearTriangles();
        }
        const inserted = db.insertTriangles(pending);
        result.trianglesInserted = inserted;
        result.duplicatesSkipped = pending.length - inserted;
    } finally {
        db.close();
    }

    result.elapsedMs = Date.now() - t0;
    return result;
}
