# test/

Integration tests that run against a real EVM, not mocks of the EVM. They exist
because the parts of this bot that lose money are the parts a type checker
cannot see: reserve drift, the K invariant, transfer taxes, event decoding, and
whether a candidate found off-chain is still executable on-chain.

## Prerequisites

Foundry's `anvil` on PATH (`curl -L https://foundry.paradigm.xyz | bash`,
then `foundryup`), plus `solc` as a dev dependency:

    npm i -D solc
    anvil --silent &          # leave running; the suites reuse it
    node test/compile.mjs     # writes test/artifacts.json

`compile.mjs` compiles the REAL contracts/FlashArbExecutor.sol together with
the mock venue, so a contract change is picked up with no extra step.

## Suites

Run with `node --experimental-strip-types`:

| file | what it covers |
|---|---|
| `test.mjs` | `FlashArbExecutor.executeArb` against a real constant-product K check: on-chain hop sizing, reserve drift mid-trade, transfer-tax tokens, `minProfit` enforcement, `ArbExecuted` accuracy, access control. 16 checks. |
| `test-watcher.mjs` | `sync-watcher.ts`: topic/decoder, pair filtering, a throwing consumer, multiple Syncs per block collapsing, blocks landing between polls, and the coalescing regression (a slow consumer must not leave the feed permanently behind). |
| `test-index.mjs` | `triangle-index.ts` against a real chain DB: incremental re-scoring must produce byte-identical candidates to a full scan, for every pair. Set `ARB_TEST_DB=db/<chain>.sqlite`. |
| `test-overflow.mjs` | The uint112 feasibility filter (`cycle_overflows`). Pure arithmetic, no chain: the mock pair stores reserves as `uint112` and would silently truncate a reserve near the ceiling, so anvil cannot reproduce the real revert, and no Sonic token is anywhere near 2^112 so `test-index.mjs` never reaches the branch. |
| `test-transport.mjs` | The three Sync transports: `subscribe` (eth_subscribe over ws), `topic` (address-less eth_getLogs) and `chunked` (address filters, for providers that answer -32701). Spins up a local proxy that refuses address-less getLogs the way publicnode does, and checks that a restricted RPC with no address list fails loudly rather than looking like a quiet chain. |
| `test-reconnect.mjs` | A websocket log subscription dying silently, which is what publicnode did to the Sonic run after ~3 minutes with zero errors. Routes the socket through a killable proxy, severs it, trades *during* the outage, and requires the recovered reserves to match the chain — proving the gap was backfilled rather than skipped. Needs the `ws` package (ethers already depends on it). |
| `test-sync-topics.mjs` | Fixes from the Sonic hot run: Solidly-family `Sync(uint256,uint256)` is watched alongside the V2 event (subscribe and getLogs); one block's pushed logs reach the consumer as one batch, last Sync per pair winning; the hot loop re-reads a cycle's pairs after a decayed edge or `InsufficientRepay`, mutes a triangle after 3 reverting simulations, and only starts the cooldown on a broadcast. |
| `test-velodrome.mjs` | Velodrome V2 / Aerodrome V2 factories: the `PoolCreated(…, bool indexed stable, …)` event is parsed and scanned (solidly group, `poolEvent: "velodrome"`); fees come from `factory.getFee(pool, stable) / 10000` including per-pool custom fees and the 420 zero-fee sentinel; the interface probe matches the `PoolFactory` pattern; and the executor completes a flash arb through a Velodrome-shaped pool (uint256 `getReserves`, fee moved out of the pool before the K check). Own anvil on 8552. |
| `test-v3-exec.mjs` | `FlashArbExecutor` V3 hops against real v3-core pools: V2→V3→V2, V3→V2→V2 and V3→V3→V2 cycles close with on-chain profit equal to `buildHops`' prediction to the wei; the PancakeV3 callback spelling; profit measured from the pre-loan balance (unswept profit cannot rescue a losing cycle); swap-callback safety (direct calls, a pool overbilling, calling back twice, or relaying the callback); bad routes and hop kinds refused. Own anvil on 8553. |
| `test-yobatches-v3.mjs` | `getV3State` against real v3-core pools (fields, window ticks, bit-exact swaps from the decoded state, junk entries, gas per pool) — run through YoBatches3, so the packed reads are what is exercised — plus packed = ABI equivalence for `getV3StatePacked`, `getReservesPacked` (0 / 255 / 256 / >2^128 balances, junk tokens) and `getReservesByPool`, with the byte savings printed. Own anvil on 8548. |
| `test-hot.mjs` | The whole hot loop end to end — a real Sync event drives the real index, the real handler, the real executor contract, a real flash loan, and the real ledger. Also asserts the gas floor refuses a profitable-but-uneconomic candidate. |
| `test-hot-v3.mjs` | The hot loop with a real Uniswap V3 pool in the triangle: the index (`build({ v3: true })`) scores the mixed cycle identically to `yarn evaluate`; a V3 `Swap` — no `Sync` — reaches the watcher (`watchV3`), the loop re-reads the pool through YoBatches3 and trades the cycle to a confirmed flash arb through the executor's V3 hop; a `Mint` also re-reads; self-healing sends V3 pools to `refreshV3`. Own anvil on 8554; ledger in a scratch dir (`ARB_LEDGER`). |
| `test-scan-incremental.mjs` | `scanChain` incremental mode against real Uniswap V2/V3 factories: factories already scanned to near the head catch up together in one shared `eth_getLogs` (no per-factory or HyperSync request), new pairs/pools stored with the right kind and fee, per-factory resume points respected (no double count); never-scanned or far-behind factories still get the per-factory scan; `incrementalMaxBlocks: 0` turns it off. Own anvil on 8555. |
| `test-liq-watch.mjs` | The Aave V3 liquidation watcher (`source/liquidation/`) against a mock lending pool that emits Aave's exact events, keeps the real `UserConfiguration` bitmap, and computes HF from live oracle prices: reserve ids from `getReserveData` (not list position, after a dropped reserve); Borrow tracks the debtor (`onBehalfOf`), supply-only accounts are not tracked, progress is durable; HyperSync-shaped logs decode identically; tiers match Aave's HF; an oracle drop makes an exposed account liquidatable on the next tick while unexposed accounts are not re-read; safe accounts skip small moves but not >10% ones; new Borrows and full repays are picked up from events; a reverting account read is omitted, never zero-filled; the rolling sweep (a slice per tick, every account with debt once per period) and the dust floor (accounts whose liquidation could pay under `minProfitUsd` — eMode bonus, 50% close factor over $2K, bad debt counted as worthless — skip per-tick and price re-reads, still read on their own events); and the subgraph seed against a local fake of The Graph's gateway (id_gt pagination pinned to `_meta`'s block, 429 retry, a subgraph for another pool refused, the RPC tail resuming from the snapshot block, stale seeded accounts reading idle on-chain); and an `eth_call` gas cap ("missing revert data" above N accounts, as on Optimism's public RPC) learned by bisection with every account still read, a batch-breaking account isolated, and a dead endpoint failing fast, and a pruned pinned block (Arbitrum's "historical state … not available") dropping the pin instead of bisecting. Own anvil on 8556; DB in a scratch dir (`ARB_LIQ_DB`). |
| `test-liquidate.mjs` | `LiquidationExecutor` (with the shared `HopEngine`) and the planner (`source/liquidation/plan.ts`) end to end, against a mock Aave pool that follows v3.3 LiquidationLogic where money is decided (HF < 1; 50% of total debt when both reserves ≥ $2K and HF > 0.95, else 100%; reserve or eMode bonus; protocol fee share of the bonus; collateral cap; `MustNotLeaveDust`), real constant-product pairs and a real Uniswap V3 pool: cross-asset liquidation broadcast with realised profit == simulated == ledger row; same-asset eMode with no route; a V3 exit; a two-hop exit via a hub (stable pool ignored, recipients chained); the dust rule — max amount reverts, the reduced amount leaving $1K is found; refusals (healthy account, below the gas floor, no route); contract safety (NotOwner, NotPool, RouteMismatch, InsufficientRepay, unswept balance cannot rescue a losing call). Own anvil on 8557; ledger in a scratch dir. Needs `@uniswap/v3-core@1.0.1`. |
| `test-liq-venues.mjs` | Morpho Blue and Compound III as liquidation venues, against the REAL protocols (compiled from source by `vendor.mjs`): Morpho — `borrower:marketId` tracked from Borrow events (collateral-only users not); HF/debt/collateral; interest extrapolated 30 days equal to Morpho's own `accrueInterest` to the wei; our HF < 1 exactly when `_isHealthy` fails (±0.05% of the threshold); an oracle drop re-reads only that market; `liquidateMorpho` full repay by shares (collateral swapped inside `onMorphoLiquidate`) with realised == executor gain == ledger == dry run, and an underwater position where only the max-seize amount is offered. Compound — `borrower:comet` tracked from Withdraw-past-zero (suppliers not); our HF < 1 exactly when `isLiquidatable`; a feed drop re-reads only accounts holding that asset; `liquidateComet` absorb + `buyCollateral` funded by a free Morpho flash loan the LenderBook picked, reserves emptied, loan repaid; a reserves-only buy after someone else absorbed (`buyableReserves`); a healthy borrower refused. Safety: NotOwner on both entry points, NotPool on direct Morpho callbacks. Finally the real `liq-watch` CLI (as "optimism", chain id 10) seeds both venues from events and liquidates one fresh position on each with `--live` (shared nonce manager), then resumes without re-seeding. Own anvil on 8558. Needs `node test/vendor.mjs` once (and `npm i -D solc0819@npm:solc@0.8.19 solc0815@npm:solc@0.8.15`). |
| `gas.mjs` | Gas measurement for `executeArb`, 2-hop and 3-hop. |

| `bench-yobatches.mjs` | Gas and returndata per pair for `YoBatches` vs the candidate `YoBatches2`, with every account access cold (240 freshly deployed tokens — reusing a few tokens measures the warm path and flatters the result by ~25x). Prints the max pairs per `eth_call` at common node gas caps. |

## Notes

`test-hot.mjs` relocates a minimal Multicall3 to the canonical
`0xcA11bde05977b3631167028862bE2a173976CA11` with `anvil_setCode`, because
`build-hops.ts` hardcodes that address and `eth_call` to a codeless address
SUCCEEDS returning `0x`. Without the relocation the test would pass for the
wrong reason — which is exactly how a misconfigured executor address once
produced a fake "simulated clean" in this project.

`test-hot.mjs` writes to `ledgerPath()` (`db/ledger.sqlite`) and deletes it
first. Do not run it on a machine whose ledger you care about.

`test-liq-venues.mjs` runs against Morpho Blue (GPL-2.0) and Comet (BUSL-1.1)
built from their own repositories at pinned commits. `node test/vendor.mjs`
clones and compiles them into `test/vendor/`, which is git-ignored: this repo is
public, and neither project's source or bytecode belongs in it.
