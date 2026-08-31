-- Quick sanity check: fee value distribution for DXSwap on Gnosis.
-- Run with:
--   sqlite3 db/gnosis.sqlite < scripts/inspect-dxswap-fees.sql

.mode column
.headers on

SELECT '--- DXSwap fee distribution ---' AS section;
SELECT fee, COUNT(*) AS pair_count
FROM pairs
WHERE factory = '0x5d48c95adffd4b40c1aaadc4e08fc44117e02179'
GROUP BY fee
ORDER BY pair_count DESC
LIMIT 10;

SELECT '--- DXSwap sample rows ---' AS section;
SELECT address, fee, stable
FROM pairs
WHERE factory = '0x5d48c95adffd4b40c1aaadc4e08fc44117e02179'
LIMIT 5;
