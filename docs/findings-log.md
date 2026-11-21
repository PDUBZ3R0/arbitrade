# Findings log

The master list of anything odd we find in other people's contracts, and whether it can earn a bounty.
Add new findings at the top of the table, and never delete one. Mark it rejected and say why instead.

## Does it pay? Decide before writing it up

A finding pays only if **all three** of these are true:

1. **There's a program for it.** The contract is listed as in scope by an Immunefi, Cantina, HackenProof or Sherlock bug bounty, or by the protocol's own `SECURITY.md`. Search the program for the exact contract address, not just the protocol's name.
2. **There's real impact.** Someone other than us can lose funds, have funds frozen, or create bad debt, or the protocol is made insolvent. "It made our bot revert" or "a view function returns the wrong number" is informational at best, and most programs pay $0 for that.
3. **It's new and not by design.** It isn't in the docs, an audit report or the program's known-issues list, and the deployer didn't build it on purpose. Scam backdoors are by design.

If any of the three fails, record it here as `no-program`, `no-impact` or `by-design` and move on. Before submitting, have a working proof of concept on an anvil fork (`anvil --fork-url … --fork-block-number …`). Every platform requires one, and submitting without one gets you ranked down or banned.

**Statuses:** `candidate` (impact still unchecked) · `poc` (proof of concept in progress) · `submitted` (add the platform and report ID) · `paid` / `rejected` (add the amount or the reason) · `no-program` · `no-impact` · `by-design`

## Log

| Date found | What | Where | Impact on others | Status | Notes |
|---|---|---|---|---|---|
| 2026-10-30 | A hidden token function `0xff37fcaa(holder, 0xdead, amount)` moves any holder's balance without emitting Transfer. One wallet uses it to wipe bot buyers one block after they buy, then the deployer drains the pool. | BSC launch tokens from one deployer origin, including 0x18757181, 0x4a2094e9, 0xc2d6df5b and 0xe7a11ae5. Wiper wallet 0xAf946655 (90 or more calls on 51 tokens). | Theft from buyers, but deliberate | `by-design` | A scam, not a bug, so no bounty. You can report the wallet and tokens for free to Chainabuse or as a BscScan label, which pays nothing. Already blocked in sniper through `banSelectors`. |
| 2026-11-01 | Trap pair code in 13 Polygon factories (227 pairs). Examples: `swap()` reads its fee from a hard-coded outside contract (30%), checks `tx.origin`, or asks `isStaked(caller)`, `isRouter(caller)` or `isAllowedToSwap()`, or reads `paused()` from a fee manager. | Polygon. Factories `7e48de0a`, `6064d55b`, `3cb48176`, `9e2b21cf`, `5bbef554` (Brewlabs), `7125d2b9`, `f36f0be0`, UnifiV2, `3ed75aff`, `ebe141de`, `150396e3`, `d18fea9f`, `3a99262d` | Bots and traders who don't read the code | `by-design` | Permissioned or fee-skimming on purpose. Useful as data for the pair-safety API (idea 6A), not for a bounty. Found by `yarn pair-code`. |
| 2026-10 | Euler V2 on Sonic: 39 accounts show as liquidatable, but their collateral is worth $0 (exUSD, ewmetaS and eyUSD vaults) | Sonic, Euler V2 | Bad debt that already happened | `no-impact` | Public: it followed the xUSD collapse. Nothing new to report. The bot skips these accounts as structural. |
| 2026-10-06 | Aave V3 on Optimism: about 3,150 accounts below health factor 1 are bad debt or crumbs, and two USDC/sUSD positions can't be liquidated because sUSD is retired | Optimism, Aave V3 | Bad debt that already happened | `no-impact` | A frozen asset and dust debt that Aave governance already tracks. It isn't a code flaw, and the Aave program excludes known governance states. |
| 2026-10-14 | A pair passes a 0.3% K check but delivers 0.05% less output (a hidden skim) | Polygon, factory 0x3ed75aff, pair 0xeefe518d (WETH/USDC.e) | Traders get 0.05% less than quoted | `by-design` | Same factory as the `feeManager()` trap below. An unofficial fork with no program. |
| 2026-10-14 | Token LGNS 0xeb51d9a3 takes a 5% transfer tax that the probe missed | Polygon, through QuickSwap pair 0x882df4b0 | Disclosed tokenomics | `by-design` | A tax token. Banned in our known-bad set. |
| 2026-10-03 | Permissioned pairs that serve only their own router: "caller is not verified" (factory 0x14fb5abe), "TOMI PAIR : FORBIDDEN" (0x074581e3), "UNAUTHORISED" (0x7fb37e8f), "ConveyorV2: FORBIDDEN!" (0x5f801762) | Polygon | None. Access control working as intended | `by-design` | They look like big edges only because nobody else can trade them. Caused about 1,900 of 1,939 simulation reverts. |
| 2026-09-02 | Launchpad pairs with a per-pair `FEE()` out of 100,000, an extra creator `TAX()`, and a virtual ETH reserve, so `getReserves()` overstates real depth | Sonic, factory 0x0534a76a | Generic V2 quoters misprice these pairs | `by-design` | Documented launchpad design. Input for idea 5 (launchpad graduation arb). |
| 2026-11-01 | Algebra V1 pools charge a dynamic fee recomputed at swap time. `globalState.fee` is the stale fee from the last swap, and the true next fee (`dataStorageOperator().getFee`) answers only when the caller is the pool. | Polygon, 8,096 Algebra V1 pools, e.g. 0x1a8a985d | None to the protocol. Anyone pricing off `globalState.fee` misprices. | `by-design` | Documented Algebra behavior. Our fix: read the next fee with the pool as sender. |
| 2026-10 | V2 factories whose real fee differs from the family default, e.g. 0xca143ce3 (PancakeSwap V2) measured 0.25% | Many chains | None | `no-impact` | Our default guess was wrong, not their contract. `verify-fees` handles it. |
| 2026-10 | Tokens with absurd supply push V2 pairs against the uint112 reserve ceiling, so swaps revert with `UniswapV2: OVERFLOW` | V2 forks, many chains | None. The overflow check is working as designed | `no-impact` | A guard in our own math (`UINT112_SAFE`). |
| 2026-10-15 | On Arbitrum and Orbit chains (including Robinhood), Solidity `block.number` returns the L1 block number. YoBatches and Multicall3 reported it, and `build-hops` pinned reads to it, which gave stale prices. | Arbitrum, Robinhood | None to others. It was our bug, now fixed | `no-impact` | Documented Arbitrum behavior (the L2 number comes from `ArbSys.arbBlockNumber()`). Could become a lead: a lending or vesting contract on Arbitrum that uses `block.number` for interest, cooldowns or auctions *could* be a real bug. That would mean an audit, not this finding. |

## Sources searched (2026-11-20)

- The 11 local Claude Code sessions in `~/.claude/projects/-home-pdubz3r0-Development/` (Oct 16 – Nov 18). No bounty-eligible finding was found.
- Incident comments in this repo's code (`source/`, `contracts/`).
- The claude.ai export from 2026-11-20 (189 conversations): the 8 DeFi conversations (orchestrator build, V3 pool math, Aave liquidations, flash swap optimization, flash loan strategies, token sniper, and the two contract-ideas chats) plus the 10 documents in the Defi project. That added the six rows dated 2026-09-02 to 2026-10-14. None of them is bounty-eligible.
- None of these sources discusses bounties or audit contests, so the line in IDEAS.txt that says "you keep finding exactly the kinds of bugs they pay for" has no finding behind it.
