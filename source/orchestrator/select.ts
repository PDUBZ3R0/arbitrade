// -----------------------------------------------------------------------------
// Which candidates are worth spending a round trip on, within one pass/block.
//
// WHY THIS EXISTS
//
// A real Polygon pass, with 455 candidates to choose from, spent all five of
// its attempts on this:
//
//   #3674954  WPOL -> Dogma -> MegaDoge -> WPOL   OVERFLOW
//   #3732881  WPOL -> Dogma -> MegaDoge -> WPOL   OVERFLOW
//   #3709570  WPOL -> Dogma -> MegaDoge -> WPOL   OVERFLOW
//   #3674800  WPOL -> Dogma -> MegaDoge -> WPOL   OVERFLOW
//   #3732770  WPOL -> Dogma -> MegaDoge -> WPOL   OVERFLOW
//
// Five rows, one idea. Every one of them entered through the same WPOL/Dogma
// pair and failed for the same structural reason, so attempts 2-5 were
// knowably wasted before they were made — and 450 unrelated candidates never
// got looked at.
//
// Candidates are ranked by profit, and near-identical cycles produce
// near-identical profits, so the top of the ranking naturally fills up with
// permutations of whichever cycle is currently most mispriced. That is fine
// when the cycle works. It is pathological when it does not.
//
// The rule here is deliberately narrow: once an attempt on a pair has FAILED,
// skip other candidates that route through that same pair in this pass. It
// does not deduplicate up front — if the first candidate works, its siblings
// were never going to be tried anyway (both callers stop at the first clean
// simulation), so pre-filtering would only risk discarding a good trade on a
// guess. The information that justifies skipping is the failure itself.
// -----------------------------------------------------------------------------

import type { Candidate } from '../evaluator/evaluator.ts';

export class AttemptFilter {
    /** Pairs belonging to candidates that have already failed this pass. */
    private readonly failedPairs = new Set<string>();

    /**
     * If this candidate routes through a pair that already failed, return that
     * pair; otherwise null. Returning the pair rather than a boolean lets the
     * caller log WHY it skipped, which is the difference between a useful log
     * line and a silent omission.
     */
    blockedBy(c: Candidate): string | null {
        for (const h of c.hops) {
            const p = h.pair.toLowerCase();
            if (this.failedPairs.has(p)) return p;
        }
        return null;
    }

    /** Record that this candidate did not execute. */
    noteFailure(c: Candidate): void {
        for (const h of c.hops) this.failedPairs.add(h.pair.toLowerCase());
    }

    /** Distinct pairs currently blocked. Diagnostics only. */
    get blockedCount(): number { return this.failedPairs.size; }
}
