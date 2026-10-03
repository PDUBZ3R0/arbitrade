// -----------------------------------------------------------------------------
// The per-block handler for the Sync-driven hot loop.
//
// Separated from the `yarn hot` CLI for one reason: this is the part that can
// be wrong in ways a type checker cannot see — the dirty-set plumbing, the
// cross-root ranking, the cooldown, the stop-at-first-clean rule — and a
// closure inside a top-level script cannot be driven by a test. Everything
// here is injected, so the integration test runs the real handler against a
// real chain with a real executor.
//
// Deliberately NOT here: candidate execution (../orchestrator/attempt.ts) and
// rendering (./report.ts), both shared with the batch orchestrator.
// -----------------------------------------------------------------------------

import type { ArbitradeDB } from '../util/db.ts';
import type { Candidate } from '../evaluator/evaluator.ts';
import type { CandidateAttempt } from './attempt.ts';
import type { RootPricing } from './attempt.ts';
import { TriangleIndex, type ScoreThresholds, type IndexedCandidate } from './triangle-index.ts';
import type { SyncUpdate } from './sync-watcher.ts';

export type HotLoopStats = {
    /** Sync batches delivered (roughly, blocks that touched a pair we know). */
    batches: number;
    /** Pair updates applied to the in-memory reserves. */
    pairsApplied: number;
    /** Updates for pairs the index has never heard of — a staleness signal. */
    pairsUnknown: number;
    /** Triangles re-scored. Compare against ix.triangleCount to see the saving. */
    trianglesRescored: number;
    candidatesFound: number;
    /** Blocks skipped because a broadcast was too recent. */
    cooldownSkips: number;
    attempts: number;
    simulatedClean: number;
    confirmed: number;
};

export type HotLoopDeps = {
    index: TriangleIndex;
    db: ArbitradeDB;
    /** Live, replaceable: the CLI swaps these when it reprices. */
    thresholds: () => ScoreThresholds;
    pricing: () => RootPricing;
    /** Token decimals by lowercase address, for the cross-root ranking. */
    decimalsByToken: Map<string, number>;
    /** Usually CandidateExecutor.attempt, bound. Injected so tests can fake it. */
    attempt: (c: Candidate, db: ArbitradeDB) => Promise<CandidateAttempt>;
    /** Called once per attempt, after it completes. Usually printAttempt. */
    report: (a: CandidateAttempt) => void;
    /** Max candidates to attempt per block. Each costs two RPC round trips. */
    candidatesPerBlock: number;
    /** Minimum gap between attempts, ms. */
    cooldownMs: number;
    log?: (s: string) => void;
    /** Injectable for tests. */
    now?: () => number;
};

export type HotLoop = {
    onBatch: (updates: SyncUpdate[], toBlock: number) => Promise<void>;
    stats: () => HotLoopStats;
};

export function createHotLoop(deps: HotLoopDeps): HotLoop {
    const log = deps.log ?? console.log;
    const now = deps.now ?? (() => Date.now());
    const ix = deps.index;

    const stats: HotLoopStats = {
        batches: 0, pairsApplied: 0, pairsUnknown: 0, trianglesRescored: 0,
        candidatesFound: 0, cooldownSkips: 0, attempts: 0, simulatedClean: 0, confirmed: 0,
    };

    let lastAttemptAt = 0;
    // Reused across blocks so a hot block allocates nothing for the dirty set.
    const movedPairs: number[] = [];

    /**
     * Rank across roots in a common unit.
     *
     * netProfit is denominated in each candidate's OWN root token, so comparing
     * them directly ranks by the accident of which token the cycle starts in:
     * 0.5 of a cheap token outranks 0.01 WETH. The batch evaluator has this
     * flaw too, but it matters more here, because only the top few candidates
     * per block get a round trip — a bad ranking means the real edge is never
     * looked at at all.
     *
     * A root with no numeraire price sorts last rather than being dropped:
     * unpriceable is not the same as worthless, and if it really cannot be
     * priced the gas floor refuses it later anyway.
     */
    const rankValue = (c: IndexedCandidate): number => {
        const lc = c.rootToken.toLowerCase();
        const price = deps.pricing()[lc]?.priceInNumeraire;
        if (price == null || !(price > 0)) return -Infinity;
        return (c.netProfit / 10 ** (deps.decimalsByToken.get(lc) ?? 18)) * price;
    };

    async function onBatch(updates: SyncUpdate[], toBlock: number): Promise<void> {
        stats.batches++;
        movedPairs.length = 0;
        let unknown = 0;
        for (const u of updates) {
            const pi = ix.applySync(u.pair, u.reserve0, u.reserve1);
            // -1 means a pair the index has never heard of: created after the
            // last `yarn reserves`, or filtered out as unsafe/stable. Not an
            // error — nothing to re-score. Counted because a creeping number is
            // the signal that the index is going stale.
            if (pi < 0) { unknown++; continue; }
            movedPairs.push(pi);
        }
        stats.pairsUnknown += unknown;
        stats.pairsApplied += movedPairs.length;
        if (movedPairs.length === 0) return;

        const affected = ix.affectedTriangles(movedPairs);
        stats.trianglesRescored += affected.length;
        if (affected.length === 0) return;

        const found = ix.scoreMany(affected, deps.thresholds());
        if (found.length === 0) return;
        stats.candidatesFound += found.length;

        found.sort((a, b) => rankValue(b) - rankValue(a));

        log(`[${new Date().toISOString()}] block ${toBlock} — ${movedPairs.length} pair(s) moved` +
            `${unknown ? ` (+${unknown} unknown)` : ''}, ${affected.length} triangle(s) re-scored, ` +
            `${found.length} candidate(s)`);

        // Cooldown. After a broadcast, the chain state we would price from
        // includes our own pending transaction, and racing ourselves into the
        // next block is how one opportunity becomes several reverts.
        const since = now() - lastAttemptAt;
        if (lastAttemptAt > 0 && since < deps.cooldownMs) {
            stats.cooldownSkips++;
            log(`  (cooldown — ${deps.cooldownMs - since}ms left, skipping this block)`);
            return;
        }

        for (const ic of found.slice(0, deps.candidatesPerBlock)) {
            stats.attempts++;
            lastAttemptAt = now();
            // IndexedCandidate is structurally the evaluator's Candidate — the
            // index produces the same field names deliberately, so no mapping.
            const attempt = await deps.attempt(ic as Candidate, deps.db);
            deps.report(attempt);
            if (attempt.simulated) stats.simulatedClean++;
            if (attempt.confirmed) stats.confirmed++;
            // Stop at the first candidate that reached a clean simulation, for
            // the same reason the batch pass does: the remaining candidates
            // share pairs with this one, so they are priced off reserves this
            // trade has just invalidated.
            if (attempt.simulated) break;
        }
    }

    return { onBatch, stats: () => ({ ...stats }) };
}
