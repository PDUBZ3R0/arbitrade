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
import { AttemptFilter } from './select.ts';

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
    /** Candidates passed over because a pair of theirs already failed. See ./select.ts. */
    skippedSharingFailedPair: number;
    attempts: number;
    simulatedClean: number;
    confirmed: number;
    /** Pairs re-read from the chain after an attempt showed the index was wrong. */
    pairsResynced: number;
    /** Candidates passed over because their triangle is muted. */
    skippedMuted: number;
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
    /**
     * Read these pairs' reserves from the chain, for self-healing. Called
     * after an attempt shows the in-memory reserves were wrong: the edge was
     * gone at fresh reserves, or the executor came up short. Without it a
     * pair whose Syncs are not reaching us (an unwatched event, a gap the
     * backfill missed) stays wrong forever, and the same phantom candidate is
     * re-found and re-attempted on every block. Optional: tests may omit it.
     */
    refresh?: (pairs: string[]) => Promise<Array<{ pair: string; reserve0: number; reserve1: number }>>;
    /** Simulation reverts before a triangle is muted. Default 3. */
    muteAfterFailures?: number;
    /** How long a muted triangle is skipped, ms. Default 30 minutes. */
    muteMs?: number;
};

export type HotLoop = {
    onBatch: (updates: SyncUpdate[], toBlock: number) => Promise<void>;
    /**
     * Attempt an externally-supplied candidate list — used for the startup
     * sweep, where candidates come from a full scan rather than from a Sync.
     * Goes through the identical ranking, filter and attempt path as a block,
     * so a sweep cannot behave differently from the loop that follows it.
     */
    sweep: (candidates: IndexedCandidate[]) => Promise<void>;
    stats: () => HotLoopStats;
};

export function createHotLoop(deps: HotLoopDeps): HotLoop {
    const log = deps.log ?? console.log;
    const now = deps.now ?? (() => Date.now());
    const ix = deps.index;

    const stats: HotLoopStats = {
        batches: 0, pairsApplied: 0, pairsUnknown: 0, trianglesRescored: 0,
        candidatesFound: 0, cooldownSkips: 0, skippedSharingFailedPair: 0,
        attempts: 0, simulatedClean: 0, confirmed: 0, pairsResynced: 0, skippedMuted: 0,
    };

    // Set on BROADCAST, not on every attempt: the cooldown exists so we do
    // not race our own pending transaction. Stamping it on every simulation
    // made a dry run skip the rest of a busy block for two seconds after
    // each look.
    let lastAttemptAt = 0;

    // Triangles whose simulation keeps reverting at fresh reserves — a
    // transfer tax, a wrong fee, a pair the executor cannot drive. They score
    // as profitable on every block their pairs move, so without a memory the
    // loop spends its per-block attempts on them forever.
    const muteAfter = deps.muteAfterFailures ?? 3;
    const muteMs = deps.muteMs ?? 30 * 60_000;
    const failures = new Map<number, number>();
    const mutedUntil = new Map<number, number>();
    const isMuted = (id: number) => {
        const until = mutedUntil.get(id);
        if (until === undefined) return false;
        if (now() < until) return true;
        mutedUntil.delete(id);
        failures.delete(id);
        return false;
    };

    /** Re-read a candidate's pairs and write the truth into the index. */
    async function resync(c: IndexedCandidate, why: string): Promise<void> {
        if (!deps.refresh) return;
        try {
            const pairs = [...new Set(c.hops.map(h => h.pair.toLowerCase()))];
            const fresh = await deps.refresh(pairs);
            let moved = 0;
            for (const f of fresh) {
                const pi = ix.pairIdx.get(f.pair.toLowerCase());
                if (pi === undefined) continue;
                const r0 = ix.res0[pi], r1 = ix.res1[pi];
                // A relative change beyond float noise means the index was stale.
                const off = (a: number, b: number) => Math.abs(a - b) > 1e-9 * Math.max(Math.abs(a), Math.abs(b), 1);
                if (off(r0, f.reserve0) || off(r1, f.reserve1)) moved++;
                ix.applySync(f.pair.toLowerCase(), f.reserve0, f.reserve1);
            }
            stats.pairsResynced += fresh.length;
            if (moved > 0) log(`      resynced ${fresh.length} pair(s) after ${why}: ${moved} were stale in the index`);
        } catch (err) {
            log(`      [!] resync after ${why} failed: ${(err as Error).message}`);
        }
    }
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

        log(`[${new Date().toISOString()}] block ${toBlock} — ${movedPairs.length} pair(s) moved` +
            `${unknown ? ` (+${unknown} unknown)` : ''}, ${affected.length} triangle(s) re-scored, ` +
            `${found.length} candidate(s)`);

        await attemptAll(found, 'this block');
    }

    /**
     * Rank, filter and attempt. Shared by onBatch and sweep so the startup
     * sweep cannot drift from the steady-state loop — the ranking, the
     * cooldown, the failed-pair filter and the stop-at-first-clean rule are all
     * decisions about money, and two copies would eventually disagree.
     */
    async function attemptAll(found: IndexedCandidate[], scope: string): Promise<void> {
        found.sort((a, b) => rankValue(b) - rankValue(a));

        // Cooldown. After a broadcast, the chain state we would price from
        // includes our own pending transaction, and racing ourselves into the
        // next block is how one opportunity becomes several reverts.
        const since = now() - lastAttemptAt;
        if (lastAttemptAt > 0 && since < deps.cooldownMs) {
            stats.cooldownSkips++;
            log(`  (cooldown — ${deps.cooldownMs - since}ms left, skipping ${scope})`);
            return;
        }

        // Fresh per batch: a pair that refused us at these reserves may be
        // perfectly fine once it moves again, so the memory must not outlive
        // the reserves it was formed from.
        const filter = new AttemptFilter();

        const live = found.filter(ic => {
            if (!isMuted(ic.triangleId)) return true;
            stats.skippedMuted++;
            return false;
        });
        for (const ic of live.slice(0, deps.candidatesPerBlock)) {
            const blocked = filter.blockedBy(ic as Candidate);
            if (blocked) {
                stats.skippedSharingFailedPair++;
                log(`  #${ic.triangleId} — skipped: routes through ${blocked}, which already failed in ${scope}`);
                continue;
            }

            stats.attempts++;
            // IndexedCandidate is structurally the evaluator's Candidate — the
            // index produces the same field names deliberately, so no mapping.
            const attempt = await deps.attempt(ic as Candidate, deps.db);
            if (attempt.broadcast) lastAttemptAt = now();
            deps.report(attempt);
            if (attempt.simulated) stats.simulatedClean++;
            else filter.noteFailure(ic as Candidate);
            if (attempt.confirmed) stats.confirmed++;

            if (!attempt.simulated) {
                const decayed = attempt.built === null && !attempt.simulationError;
                const shortfall = /InsufficientRepay|0x305792c3/.test(attempt.simulationError ?? '');
                // Either way the index priced this cycle from reserves the
                // chain no longer has (or never had): fix that first.
                if (decayed || shortfall) await resync(ic, decayed ? 'a decayed edge' : 'an InsufficientRepay revert');
                if (attempt.simulationError) {
                    const n = (failures.get(ic.triangleId) ?? 0) + 1;
                    failures.set(ic.triangleId, n);
                    if (n >= muteAfter) {
                        mutedUntil.set(ic.triangleId, now() + muteMs);
                        log(`      muting #${ic.triangleId} for ${Math.round(muteMs / 60_000)}m after ${n} failed simulations`);
                    }
                }
            } else {
                failures.delete(ic.triangleId);
            }
            // Stop at the first candidate that reached a clean simulation, for
            // the same reason the batch pass does: the remaining candidates
            // share pairs with this one, so they are priced off reserves this
            // trade has just invalidated.
            if (attempt.simulated) break;
        }
    }

    async function sweep(candidates: IndexedCandidate[]): Promise<void> {
        stats.candidatesFound += candidates.length;
        await attemptAll(candidates, 'the startup sweep');
    }

    return { onBatch, sweep, stats: () => ({ ...stats }) };
}
