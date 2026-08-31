-- One-shot cleanup for the v2fee/solidly fee-defaulting bug.
--
-- Before the config-normalizer fix, every v2fee/solidly factory had `fee`
-- defaulted to 0.003, which caused the reserves fetcher's flat-fee fast path
-- to write `fee=0.003` for every pair (bypassing the per-pair multicall).
--
-- This script identifies factories whose group is v2fee/solidly and clears
-- their pairs' fee column so the next `yarn reserves polygon` re-fetches
-- via the multicall path.
--
-- Note: SQLite doesn't have the group info directly (that's config-only),
-- so we clear fee on ALL pairs — the reserves fetcher will re-derive fee
-- for v2 pairs from the config default (0.003, no multicall) and re-fetch
-- for v2fee/solidly (via the multicall now that flat-fee mode is off).
--
-- Run with:
--   sqlite3 db/polygon.sqlite < scripts/reset-fees-for-refetch.sql
--
-- ...then:
--   yarn reserves polygon

UPDATE pairs SET fee = NULL;

SELECT 'Cleared fee on ' || changes() || ' pair(s). Re-run yarn reserves polygon.' AS status;
