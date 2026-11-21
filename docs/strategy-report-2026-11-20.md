# Strategy report, 2026-11-20

## Bottom line

- **The bot works, but it isn't winning.** Across the hot-loop runs logged locally (Oct 7 – Nov 7, 12 chains), it made about **8,000 execution attempts and 0 confirmed trades**. The only realised profit in the ledger is one Sonic arbitrage worth **$0.005**. The liquidator has logged **0 liquidations**.
- **Why it loses: other bots get there first.** Most candidates die as "decayed": by the time we act, someone else has already closed the gap. On Polygon the competitor landed first at the *same* gas price, so they were closer to the block producer, not paying more. But these runs were made from home (limited CPU, RAM and 5G bandwidth) or on old code on AWS. With the right location, Flashblocks and our own nodes, it's **untested, not disproven**. Part 2 has the plan.
- **The plan favors things that run on their own and need no selling.** Part 1 is ranked by fit (earns without you, no clients, quick wins you can verify), not by dollars per hour. Freelance and liquidator-for-hire are deferred, not dropped.
- **Production right now:** the AWS `arbitrade` instance (c7i.xlarge) was **stopped on purpose**. It was running old code and burning through the trial. An unnamed **t3.micro is still running (since Nov 2)**, and the Nov 18 session found a node admin UI open to the internet, so check whether that's this box. If not, stop it too. I couldn't reach the Germany VPS (`ssh arb` timed out), so its current state is unknown.
- **Flashblocks support was never built,** so Base, OP and Ink were never run with it. Combined with the Germany VPS's 8.5–9 ms to the OP and Ink sequencers, it's the cheapest untested lever (Part 2).

All dollar figures below are **my estimates**, not measurements. Where I could measure something, I say so.

---

## Part 1: What to pursue

### What this plan is built for

The ranking follows three needs, not the most dollars per hour:

1. **It runs without you.** It keeps earning on bad weeks, and nobody is waiting on you.
2. **No selling, and no clients to trust.** You can work under a pseudonym and never get on a call.
3. **Early wins you can see and verify.** A confirmed transaction or a judged finding is proof that can't be argued with, and each one is also a portfolio piece.

A fourth constraint comes from your finances: **risk gas, not capital.** Flash-loan execution means a failed trade costs only gas, and that should stay the rule.

### Ranked

| # | What | Why it fits | Setup | First milestone | Revenue once running (my estimate) |
|---|---|---|---|---|---|
| ~~1~~ | ~~**Keeper bounties**~~ **Measured 2026-11-21: not viable.** | Beefy is the main open bounty. Its TVL is down to about $56M across all chains. On Base, a simulated `harvest()` paid the caller 0.0000119 ETH (~$0.04) for 3.8M gas, which costs more than that. Arbitrum, Optimism, Monad, BSC, Avalanche and Fraxtal show pending caller rewards at or near zero. | — | — | $0 |
| 2 | **Arbitrage on the right infrastructure** (OP and Ink on the Germany VPS first, then Flashblocks; see Part 2) | Your own system, already 90% built. | 1–2 days for the first test, 2–4 wks for the rest | **First confirmed profitable trade** on a chain with a nearby sequencer | $0–50/day across chains, minus $20–300/mo infrastructure. Unknown until tested. |
| 3 | **liq-watch running constantly** on the VPS | Runs on its own. One good day can pay for months. | 1–3 days (fork-test each venue first) | Every venue passes on a fork, then the first live liquidation | $0–5k/yr, mostly on crash days |
| 4 | **Audit contests** (Code4rena, Sherlock, Cantina) | No clients, no calls, and pseudonymous accounts are normal. You pick contests and can skip a bad week. Each finding is judged on its merits, which is about as fair a measure as exists. | ~1 wk to the first contest | First valid finding, Medium or above | $0–1.5k in months 1–3, then $500–5k/mo if it clicks. Payouts lag 3–8 weeks. |
| 5 | **Mint and redeem edges** (Sonic stS first) | It feeds the same executor, and it's the one trading idea with a structural edge. | 1–2 days to replay, 1–2 wks to build | The replay shows enough profit to clear its bar | $0–20/day |
| 6 | **Ecosystem grants** | Written applications, though some want a call at the end. | 3–5 days each | One application sent | $5k–50k one-off. Low odds per application, and decisions take months. |
| 7 | **Bot-trap write-up or detector**, under a pseudonym if you like | A portfolio piece without selling anything. People who need it come to you. | 2 days for a write-up | Published | Little direct money |

### Deferred for now, not ruled out

| Idea | Why it's deferred |
|---|---|
| Freelance and contract work | It pays the most and the most steadily, but it means selling yourself and trusting clients, which is the opposite of what you need right now. It's still there once a few wins are under your belt. If you try it, a single fixed-scope job with a loose deadline is the gentlest version. |
| Liquidator for hire | It needs outreach and an uptime promise to a protocol. Revisit once liq-watch has a live record you can point to. |
| Intent filling, mainnet auctions, launchpad arb, LP vault, reserves feed, sniper live trading | Same reasons as before: crowded, custodial, or the recorded results were negative. |

### Expectations, stated plainly

Passive doesn't mean guaranteed. The first trade may earn cents. That still counts: it proves the whole path works, and it's the part that was missing. Measure progress by milestones (first confirmed trade, first bounty, first valid finding) rather than dollars per day for the first month. The kill rule in Part 2 keeps infrastructure from eating money that the household needs.

---

## Part 2: Arbitrage, chain by chain

### What the zero actually measured

The 0 confirmed out of about 8,000 attempts came from **handicapped setups**, so it says less about the chains than Part 1's bottom line implies:

- **Home runs** (most of `log/<chain>/`): limited CPU, RAM and 5G bandwidth. Monad fell 61 blocks behind and Plasma 70. Robinhood's feed reached home **506 ms later** than it reached EC2, and every sequencer is 30–130 ms further away from home.
- **AWS runs** (`log/aws/`, Oct 12): **old code**, from before the index fix, the known-bad seeding and the trap-pair blacklists. Base ran with no Flashblocks: 236 attempts, 9,888 simulation reverts, 0 confirmed.
- **Not run at all:** Flashblocks, OP and Ink from the Germany VPS (their sequencers are 8.5–9 ms from it), our own node on a mempool chain, and a send-to-inclusion test with real money.

- **Germany VPS, current code (as of Nov 21, 3 days up):** Polygon made 69,161 attempts and Sonic 13,293, with 0 sent. Over the last 24 hours on Polygon, 27,920 candidates were "profitable but does not cover gas". At true break-even (1× gas) only 147 cleared, worth about 5.9 WPOL ($0.43) a day. Sonic was similar, at pennies. So on those two chains the blocker is **edge size against gas**, not latency. Our trades use **430k–1.2M gas**. Halving that would let about 782 Polygon candidates a day clear, roughly $3.80 a day. That's still small, but it's the lever there.

So what's proven is narrower: *the generic loop, run from the wrong place or on old code, doesn't win.* What happens with the right location and current code is **untested, not disproven**. The plan from `docs/chain-feed-survey.md` still stands; it was just never run.

### The levers, and which chains each one helps

| Lever | Helps | What it buys | Cost |
|---|---|---|---|
| **Germany VPS** (already paid for) | OP Mainnet, Ink | Sequencers 8.5–9 ms away, against 87–91 ms from us-east-1 | $0 extra. It may need more RAM or cores than the $20 plan (see below). |
| **Flashblocks and preconf feeds** | Base, OP, Ink, Unichain | See ordered transactions about 0.4–1.2 s before the block and land in the *next flashblock of the same block* | 3–5 days of code: consume the feed and treat each flashblock as a Sync batch |
| **us-east-1 location** | Arbitrum (sequencer 16 ms away), Robinhood (feed 12 ms early), Base (sequencer about 20 ms), MegaETH, Unichain | Wins first-come-first-served races against bots hosted further away | The cheapest instance that keeps up. A c7i.xlarge on demand is about $125/mo, so look at a spot instance or a Hetzner or OVH box in Ashburn instead. |
| **Our own node** (mempool chains) | Polygon, Sonic, Gnosis | Fills the 5–12% of transactions public endpoints miss, sees transactions about 100 ms or more earlier through direct peers, and gets our transactions to validators faster. That matters most for **ties at the same gas price**, which is exactly how we lost on Polygon. | A dedicated server, not a VPS. Sonic: about €50–80/mo (Hetzner AX-class, 1–2 TB NVMe, 64 GB). Polygon (Bor + Heimdall): about €120–200/mo (4 TB+ NVMe). **Not at home:** 5G bandwidth and latency rule it out. |
| **More CPU and RAM on the VPS** | Monad, Plasma (both fell behind), and any chain with a large index | The loop keeps up with the chain head, so prices aren't stale | Upgrade the VPS plan, about $30–60/mo |

**Limits no lever removes:** Arbitrum's Timeboost express-lane holder still gets about 200 ms ahead during the rounds it wins. On fee-priority chains (Polygon, Gnosis, Sonic, Base flashblocks), once you're inside the window the **tip auction** decides who wins, so infrastructure gets you into the auction but doesn't win it. Sonic's measured edges were **below gas**, which a node won't fix.

### Chain by chain

| Chain | Last run (where) | Result | Lever to try | Verdict |
|---|---|---|---|---|
| **Polygon** | Nov 7 (home) | 856 attempts, 0 confirmed. Lost a tie at the same gas price. | Our own Bor node near the validators, plus backruns (strict fee ordering, about 1 s lead). Best candidate in the survey. | **Try with a node.** About €150/mo. A bid war against established backrunners. |
| **Base** | Oct 12 (AWS, old code, no Flashblocks) | 236 attempts, 9,888 simulation reverts, 0 confirmed | Flashblocks or preconf feed plus us-east-1, then win the tip auction within the next flashblock | **Try once Flashblocks is built.** Highest volume, and also the most spam competition. |
| **OP Mainnet** | Oct 7 (home) | 6 attempts | Germany VPS (8.5 ms) plus Flashblocks | **Try on the VPS.** Cheap to do. |
| **Ink** | Oct 12 (home) | 0 candidates | Germany VPS (9 ms) plus Flashblocks | **Try alongside OP**, at no extra cost. Low volume. |
| **Robinhood** | Oct 15 (home) | 549 attempts, 0 confirmed | us-east-1: the feed arrives 12 ms early there, against 494 ms late at home | **Try.** Replay 30 days of volume first (1–2 days). |
| **Arbitrum One** | Oct 12 (AWS, old code) | 1,004 simulation reverts, 0 confirmed | us-east-1 (16 ms) with current code | **Low.** Timeboost takes the best opportunities. Run it only if us-east-1 is already paid for by Robinhood or Base. |
| **Monad** | Oct 14 (home) | 3,069 attempts, 0 confirmed, 61 blocks behind | More CPU and RAM (VPS) plus fixing the index lag. No public mempool. | **Try on a bigger VPS.** Young chain. |
| **Sonic** | Nov 7 (home) | 45 attempts; one $0.005 trade ever | Our own node (the RPC is on Hetzner, likely near the VPS), plus **stS mint and redeem** | **Node only if mint and redeem pays.** Backrun edges measured below gas. |
| **Gnosis** | Nov 2 (home) | 5 attempts. Mempool visible, 2.9 s lead. | Own node, or `rpc.gnosischain.com` pending | **Low.** A rival already bids 237 gwei. |
| **Plasma** | Nov 6 (home) | 882 attempts, 70 behind | More CPU and RAM, plus stable and PSM mint and redeem. The RPC is 2 ms from us-east-1 (Oracle Cloud). | **Maybe.** Fix the lag, then rerun from us-east-1. |
| **HyperEVM** | Oct 14 (home) | 4 attempts | HyperCore precompile cross-venue arbitrage | **Measure, then build.** |
| **MegaETH / Unichain** | never run | — | us-east-1 plus miniBlocks or Flashblocks feeds | **Later.** Unichain had about 0.3 user transactions per block. |
| **Celo, Avalanche, opBNB** | Nov 2026 (home) | 0 confirmed; edges below gas, or no volume | None that fixes volume | **Stop.** |
| **Ronin** | measured | about $3/day upper bound | — | **Stop.** |
| **13 skeleton configs** | never | — | — | Launch-day templates. |

### A sensible order (cheapest test first)

1. **Germany VPS: OP and Ink with the current code** (1–2 days). Prove the full path to inclusion with a few real sends. This is the first test with a nearby sequencer and current code.
2. **Flashblocks** (3–5 days). It unlocks OP, Ink and Base together.
3. **Bigger VPS plan** for Monad and Plasma (1 day plus the lag fix).
4. **us-east-1 box** for Robinhood and Base, *after* the Robinhood replay says it's worth it.
5. **Own node:** Polygon first (best backrun data), and Sonic only if mint and redeem pays. Pay for a node only after steps 1–2 show the loop can land trades at all, or the node just makes losing faster.

**Revenue estimate for arbitrage with the right infrastructure:** unknown until steps 1–2 run. My guess is $0–50/day across all chains, with infrastructure costing $60–300/mo depending on how many levers you pull. Set a kill rule: if after 3–4 weeks the realised ledger doesn't cover infrastructure costs, stop paying for the node and the us-east-1 box.

---

## Part 3: Other DeFi ideas worth your attention

These are ideas beyond IDEAS.txt, filtered for one person with little capital and the code you already have.

1. **Liquidator for hire.** The strongest new idea on money, but it needs outreach, so it's deferred (Part 1). Once liq-watch has a live record, a short written pitch by email to a few young lending markets is the low-contact way in.
2. **Bot-trap intelligence** (#6). This is the one detection capability that isn't common. Most scam checkers can't see a wipe that happens after the buy. Sell it to sniper-bot operators, or use it as a calling card.
3. **New-chain launch playbook.** Generic arbitrage is crowded everywhere except in the first days after a chain launches. Keep `add-chain → provider → deploy → configure` scripted and fast, watch for announced mainnet dates, and run for the first 1–2 weeks only. The revenue is episodic and unknown, perhaps $0–500 per launch.
4. **HyperEVM ↔ HyperCore cross-venue arbitrage.** The one arbitrage idea with an edge that pool-only bots can't copy without new plumbing. Measure it before building.
5. **Across-style relayer** (filling cross-chain transfers with your own money). It's permissionless and the bot is open source, and it fits your multi-chain RPC setup. Returns scale with the capital you put in, and that capital is at risk (bridge and chain risk), so it's only worth it if you have spare capital and accept that risk. I'm not sizing it for you.
6. **Risk monitoring for DAOs and protocols.** Oracle-deviation, liquidation-risk and bad-debt dashboards are things DAOs pay vendors for. It's a harder sale than #1. Treat it as an upsell once you're running someone's liquidations.
7. **Writing in public.** Post-mortems people would read: the bot-only backdoor, a taxonomy of permissioned and trap pairs, and an honest "8,000 attempts, 0 fills: where generic arbitrage stands in 2026". It earns nothing directly, but it brings in freelance and audit work, and it's 1–2 days each.

**Not worth your time:** airdrop and points farming (speculative, and not a skill edge), MEV on BSC or Ethereum (already ruled out, heavily professionalized), copy-trading and signal products, and live sniper trading.

---

## Suggested next 30 days

Each week has one or two **wins you can verify**, sized so a rough week doesn't break the plan.

| Week | Build | Win to check off |
|---|---|---|
| 1 | ✅ The t3.micro is your Mysterium node, and 4449 is now open only to your IP. ✅ Keeper bounties measured: not viable. Get OP and Ink running with current code on the Germany VPS, and fix the liquidator's `getLogs` failures there (Polygon's liquidator has been blind for days). | OP or Ink sends a real trade that lands on-chain, profitable or not. |
| 2 | Fork-test each liq-watch venue, then run it 24/7 on the VPS. Start Flashblocks. | liq-watch passes on a fork and is live. |
| 3 | Finish Flashblocks (OP, Ink, Base). Run the Sonic stS mint/redeem replay. Pick one audit contest that matches what you know and just read the code. | **First confirmed profitable arbitrage**, or a clear answer why not. |
| 4 | Bigger VPS plan for Monad and Plasma if week 3 justifies it. Submit to the contest. Run the Robinhood replay. | First contest submission. A go/no-go on us-east-1 and a node. |

Anything that slips just moves a week. The order matters more than the dates.
