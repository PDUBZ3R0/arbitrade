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
| `test-hot.mjs` | The whole hot loop end to end — a real Sync event drives the real index, the real handler, the real executor contract, a real flash loan, and the real ledger. Also asserts the gas floor refuses a profitable-but-uneconomic candidate. |
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
