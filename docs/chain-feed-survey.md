# Chain feed survey: who can see a swap before it is mined

Survey date 2026-10-30. Covers every chain in `conf/@chains.json5` plus every chain id
in `conf/provider/*.json` (72 chains). Executor = `chain.executor` set in `conf/<label>.json5`
(11 chains: Optimism, Gnosis, Polygon, Monad, Sonic, HyperEVM, Robinhood, Base, Arbitrum,
Avalanche, Ink).

**The per-chain table was measured from a home 5G connection.** The sequencer feeds,
round-trip times and the mempool chains on the shortlist were then re-measured from a
temporary c7i.large in us-east-1f (same AZ as production) on 2026-10-30. Those numbers are
in [Measured from EC2 us-east-1](#measured-from-ec2-us-east-1) and they change two
conclusions: Robinhood's feed is fine from AWS, and OP/Ink sequencers are far from
us-east-1. Each run covered ~20 blocks (or 150 s on slow chains), so low-volume chains
have tiny samples.

## Method

Per chain, from the endpoints marked reachable in `conf/provider/<id>.json`:

- **ws pending**: `eth_subscribe newPendingTransactions true` on up to 4 ws endpoints
  (falls back to the hash-only form). Records full-tx vs hash-only, message burst in the
  first 2 s, and longest silence.
- **http filter**: `eth_newPendingTransactionFilter` + `eth_getFilterChanges` every 400 ms
  on up to 3 http endpoints.
- **pending block**: `eth_getBlockByNumber('pending')` on 6 endpoints; if one is ahead of
  the highest `latest`, it is polled every 200 ms. OP-stack flashblock endpoints and
  sequencer feeds were measured separately (below).
- **coverage** = share of mined user txs (deposit/system tx types 0x7e, 0x64–0x6a, 0xff
  excluded) whose hash a source showed before the block arrived; **lead** = median of
  (first `newHeads` arrival across endpoints − first sighting). A lead near 0 (or
  negative) means the "feed" only reports txs as they are included.
- **simV1**: `eth_simulateV1` answered / endpoints tried (up to 10).
- **ordering evidence**: across the sampled blocks, the share of adjacent tx pairs with
  non-increasing effective priority fee (`desc%`) and the number of blocks fully sorted by
  tip. ~100% and all blocks sorted means fee-priority; ~50–75% with few sorted blocks
  means arrival order (FCFS) or per-flashblock ordering.

Scripts and raw per-chain JSON are in the session scratchpad
(`/tmp/claude-1000/-home-pdubz3r0-Development/6b9954bf-04ca-4d46-bbc8-db5d7af85302/scratchpad/`:
`probe.cjs`, `seqfeed.cjs`, `pendlead.cjs`, `res/<id>.json`). The repo is unchanged apart
from this file.

## Sequencer / preconfirmation feeds (measured separately)

| Chain | Feed | Coverage | Lead vs RPC newHeads (p10 / p50 / p90) |
|---|---|---|---|
| Base | `wss://mainnet.flashblocks.base.org/ws` (raw flashblocks, brotli) vs publicnode | 100% (2308 tx) | 372 / 1213 / 1674 ms |
| Base | `pending` on `https://mainnet-preconf.base.org` (polled 100 ms) | 99% | 337 / 1173 / 1795 ms |
| OP Mainnet | `pending` on `https://mainnet.optimism.io` (flashblocks, 250 ms) | 92% | 216 / 959 / 1637 ms |
| Ink | `pending` on `https://rpc-gel.inkonchain.com` | 80% | 134 / 421 / 581 ms |
| Ink | `pending` on `https://ink.drpc.org` | 77% | 81 / 334 / 522 ms |
| World Chain | `pending` on `worldchain-mainnet.g.alchemy.com` | 100% (204 tx) | p50 1089 ms |
| Unichain | `wss://mainnet-flashblocks.unichain.org/ws` | 100% (11 tx only) | 248 / 629 / 860 ms |
| MegaETH | `eth_subscribe miniBlocks` on `wss://mainnet.megaeth.com/ws` vs drpc | 99.6% | 72 / 551 / 878 ms |
| Arbitrum One | `wss://arb1-feed.arbitrum.io/feed` vs publicnode | 100% | 21 / 29 / 48 ms |
| Robinhood | `wss://feed.mainnet.chain.robinhood.com` vs publicnode | 0% ahead from home | **behind** by 398–481 ms from home; **12 ms ahead, 98.7%, from EC2** (see below) |
| RISE | `eth_subscribe("shreds")` on `wss://rpc.risechain.com/ws` vs same endpoint's newHeads | 100% (1741 tx) | 261 / 537 / 985 ms |

All of these show txs **after the sequencer has ordered them**; none is a mempool. On
flashblock chains the "lead" is the time between a tx landing in a 200/250 ms flashblock
and the full 2 s block being published, so a reaction can only land in a *later
flashblock of the same block*, behind the victim. MegaETH's lead is mostly drpc's lag
behind the sequencer. Soneium's `rpc.soneium.org` `pending` returned nothing useful
(1 user tx in 20 blocks).

## Per-chain table

Coverage/lead = best source. "–" = nothing seen. tx/blk = user txs per sampled block.

| id | chain | exec | feed type (best source) | cov | lead p50 | simV1 | ordering (docs + evidence) | tx/blk | verdict |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Ethereum | – | public ws mempool, full (publicnode/drpc/pocket); tenderly `pending` builder block | 42% ws; 70% pending blk | 7.5 s / 4.2 s | 7/10 | PBS builders (MEV-Boost); 74% desc, 0/12 sorted | 250 | backrun only via builder bundles (crowded) |
| 10 | Optimism | Y | flashblocks `pending` @ mainnet.optimism.io; ws (tenderly) 13%; filter 54% at ~inclusion | 92% | 0.96 s | 7/10 | priority fee per 250 ms flashblock; 75% desc, 0/20 whole-block sorted | 36 | latency race (next flashblock + tip) |
| 14 | Flare | – | http filter only | 1% | – | 0/7 | fee priority (14/14 sorted) | 7 | nothing |
| 25 | Cronos | – | ws hash (drpc) / filter (publicnode) | 100% (n=3) | 0.6 s | 7/10 | n/a | 0.15 | nothing (no volume) |
| 50 | XDC | – | http filter | 100% (n=19) | 1.8 s | 0/8 | fee (6/6 sorted) | 1 | nothing (volume, no simV1) |
| 56 | BSC | – | ws full (publicnode); filter 28% | 72% | 92 ms | 9/10 | builders/PBS (48 Club, BlockRazor, bloXroute), ~0.45 s blocks; 85% desc | 62 | backrun via builder bundles, not via public race |
| 100 | Gnosis | Y | **`pending` block @ rpc.gnosischain.com** (polled); filter 56%; publicnode ws 6% (587-tx burst, then 32 s silent) | 95% | 2.9 s | 8/10 | strict fee priority (20/20 sorted) | 48 | backrun; known rival pays 237 gwei |
| 130 | Unichain | – | flashblocks ws (separate table); `pending` @ mainnet.unichain.org 18% | 100% (n=11) | 0.63 s | 6/9 | priority fee per 200 ms flashblock (TEE builder) | 0.3 | latency race, but almost no volume |
| 137 | Polygon | Y | ws hashes (drpc) 94%; ws full (publicnode) 90% this run (18% earlier); quiknode `pending` 94% | 94% | 1.0–1.1 s | 7/10 | fee priority (99.7% desc, 16/20 sorted) | 82 | **backrun** |
| 143 | Monad | Y | ws pending subscribe rejected; no filter / pending block | – | – | 0/10 | 90% desc, 0/20 sorted; ~0.3 s blocks | 28 | nothing |
| 146 | Sonic | Y | ws full (publicnode) | 97% | 1.08 s | 8/10 | 82% desc, 3/5 sorted | 1.5 | backrun (executes, earns < gas) |
| 169 | Manta Pacific | – | ws accepted, 0 msgs | – | – | 6/8 | fee (15/15) | 3 | nothing |
| 196 | X Layer | – | ws hash (drpc) | 2% | 1.1 s | 2/5 | 77% desc, 0/20 | 12 | nothing |
| 204 | opBNB | – | ws full (publicnode, pocket, drpc) | 100% | 0.5–0.7 s | 0/10 | fee (16/16 sorted), 0.25 s blocks | 3.5 | backrun possible (no executor, no simV1) |
| 223 | B2 | – | filter / pending block | 100% (n=2) | – | 1/5 | n/a | 0.1 | nothing |
| 239 | TAC | – | none | – | – | 0/4 | n/a | 0 | nothing |
| 252 | Fraxtal | – | ws accepted, 0 msgs | – | – | 5/9 | 83% | 0.7 | nothing |
| 324 | zkSync Era | – | ws hashes (drpc) at sequencing (lead 3 ms) | 100% (n=8) | ~0 | 0/10 | FCFS sequencer | 1 | nothing |
| 369 | PulseChain | – | no reachable endpoint in provider file | – | – | – | – | – | not measured |
| 388 | Cronos zkEVM | – | ws subscribe rejected | – | – | 0/4 | n/a | ~0 | nothing |
| 480 | World Chain | – | flashblocks `pending` (alchemy) | 100% | 1.09 s | 1/6 | priority fee per flashblock + PBH top-of-block lane for verified humans; 77% | 10 | latency race |
| 484 | Camp | – | filter, nothing matched | – | – | 1/2 | n/a | ~0 | nothing |
| 714 | Eden | – | none | – | – | 0/1 | n/a | 0 | nothing |
| 747 | Flow EVM | – | filter at inclusion | 50% (n=4) | ~0 | 0/3 | n/a | 0.2 | nothing |
| 988 | Stable | – | sentio `pending` at inclusion | 73% | 15 ms | 2/4 | n/a | 1 | nothing |
| 999 | HyperEVM | Y | ws accepted, 0 msgs | – | – | 3/9 | 84% desc, 11/17 sorted; priority fees burned | 3 | nothing |
| 1088 | Metis | – | none | – | – | 0/9 | n/a | 1 | nothing |
| 1116 | Core | – | ws full (coredao) | 17% | 1.7 s | 3/6 | fee (3/3) | 1 | nothing |
| 1135 | Lisk | – | none | – | – | 1/5 | n/a | 0 | nothing |
| 1329 | Sei | – | ws rejected / silent | – | – | 0/7 | n/a | 0.15 | nothing |
| 1514 | Story (provider file: "Data Network") | – | `pending` block (itrocket) | 62% | 2.3 s | 9/10 | fee (4/4) | 1.6 | backrun possible, low volume |
| 1672 | Pharos | – | none | – | – | 0/3 | 40% desc | 0.75 | nothing |
| 1776 | Injective | – | ws hash at inclusion | 50% (n=2) | <0 | 0/3 | n/a | 0.1 | nothing |
| 1868 | Soneium | – | ws rejected; `pending` empty | – | – | 3/6 | n/a | 0.05 | nothing |
| 2020 | Ronin | – | `pending` block @ api.roninchain.com | 98% | 1.18 s | 0/4 | fee (93% desc, 13/15) | 2.3 | backrun possible (no executor, no simV1) |
| 2345 | GOAT | – | ws / filter | 100% (n=2) | 2.5 s | 3/4 | n/a | 0.1 | nothing |
| 2741 | Abstract | – | ws rejected | – | – | 0/6 | n/a | 1 | nothing |
| 2818 | Morph | – | ws full | 100% (n=4) | 0.24 s | 0/5 | n/a | 0.2 | nothing |
| 4114 | Citrea | – | none | – | – | 0/1 | n/a | 0 | nothing |
| 4153 | RISE | – | shreds feed `eth_subscribe("shreds")` (standard pending sub silent) | 100% | 0.51–0.54 s | 1/1 | single sequencer; 69% desc, 0/20 | 128 | latency race, but origin ~200 ms RTT from us-east-1 |
| 4200 | Merlin | – | ws rejected | – | – | 0/3 | n/a | 0 | nothing |
| 4217 | Tempo | – | ws full | 100% (n=8) | 0.38 s | 2/3 | n/a | 0.4 | nothing (volume) |
| 4326 | MegaETH | – | `miniBlocks` (separate table); no mempool | 99.6% | 0.55 s vs drpc | 3/5 | single sequencer, 10 ms mini-blocks; 54% desc, 0/20 → arrival order | 24 | latency race |
| 4663 | Robinhood | Y | public sequencer feed: 470 ms *behind* RPC from home, **12 ms ahead (98.7%) from EC2** | 98.7% (EC2) | 12 ms vs publicnode (EC2) | 6/9 | Arbitrum Orbit FCFS (Timeboost status not found); 70% desc | 3.7 | latency race |
| 4689 | IoTeX | – | none | – | – | 0/5 | n/a | 1 | nothing |
| 5000 | Mantle | – | drpc `pending` empty | – | – | 6/9 | n/a | 0.1 | nothing |
| 5042 | Arc | – | ws rejected | – | – | 3/7 | fee (14/14) | 2 | nothing |
| 8217 | Kaia | – | filter (pocket) | 8% | 1.3 s | 0/8 | 95% desc, 7/8 | 2.5 | nothing |
| 8453 | Base | Y | flashblocks (separate table); pocket `pending` only 20% | 99–100% | 1.2 s | 6/10 | priority fee per 200 ms flashblock; 92% desc, 0/20 whole-block | 132 | **latency race** (next flashblock + tip) |
| 9745 | Plasma | – | `pending` block / filter @ rpc.plasma.to | 75% | 0.76 s | 1/5 | fee (97% desc, 18/20) | 6 | backrun possible (no executor) |
| 16661 | 0G | – | filter | 50% (n=2) | 5 s | 1/2 | n/a | 0.1 | nothing |
| 25363 | Fluent | – | none | – | – | 1/2 | n/a | 0.05 | nothing |
| 34443 | Mode | – | ws rejected | – | – | 2/4 | n/a | 0 | nothing |
| 42161 | Arbitrum One | Y | sequencer feed (separate table); ws pending accepted, 0 msgs | 100% | 29 ms vs publicnode | 5/10 | FCFS + Timeboost express lane (non-express txs delayed 200 ms) | 2 (250 ms blocks) | latency race (loses to express-lane holder) |
| 42220 | Celo | – | ws accepted, 0 msgs; no public flashblock feed found | – | – | 4/10 | 87% desc, 1/20 | 11 | nothing |
| 42793 | Etherlink | – | none | – | – | 0/4 | 91% desc, 7/9 | 2 | nothing |
| 43111 | Hemi | – | ws / filter | 75% (n=4) | 4.7 s | 2/4 | n/a | 0.3 | nothing |
| 43114 | Avalanche | Y | ws accepted, 0 msgs this run (~1% earlier) | 0–1% | – | 0/10 | 85% desc, 6/10 | 3 | nothing |
| 48900 | Zircuit | – | none | – | – | 2/3 | n/a | 0 | nothing |
| 57073 | Ink | Y | flashblocks `pending` (rpc-gel / drpc) | 77–80% | 0.33–0.42 s | 5/6 | priority fee per flashblock; 75% desc, 4/20 | 4.6 | latency race |
| 59144 | Linea | – | ws full (publicnode), filter | 100% (n=13) | 1.6 s | 5/9 | sequencer; n/a (1 block with pairs) | 1 | backrun possible, low volume |
| 80094 | Berachain | – | ws (all 4), pocket `pending` | 100% (n=6) | 0.9–1.6 s | 6/10 | n/a | 0.3 | nothing (volume) |
| 81457 | Blast | – | probe got no blocks; ~1 tx/blk by spot check | – | – | 0/6 | n/a | ~1 | nothing |
| 98866 | Plume | – | ws rejected | – | – | 1/4 | n/a | 1 | nothing |
| 200901 | Bitlayer | – | ws full, `pending` block | 89–100% | 4–4.8 s | 0/2 | fee (11/11) | 1.35 | nothing (volume, no simV1) |
| 222222 | Hydration | – | ws hashes (4 endpoints) | 8% | 0.3 s | 0/6 | n/a | 0.6 | nothing |
| 534352 | Scroll | – | ws hash at ~inclusion (49 ms) | 100% (n=6) | ~0 | 2/10 | sequencer | 1 | nothing |
| 685685 | Gensyn Testnet | – | none | – | – | 0/1 | n/a | 0 | nothing |
| 685689 | Gensyn | – | none | – | – | 0/1 | n/a | 0 | nothing |
| 747474 | Katana | – | filter | 100% (n=4) | 0.2–0.6 s | 5/8 | n/a | 0.2 | nothing (volume) |

### Rechecks of the 11 executor chains against earlier numbers

- **Sonic**: 97% seen, 1.08 s ahead (earlier 99%, 1.1 s). Unchanged.
- **Polygon**: drpc 94% (hashes), publicnode 90% full txs this run vs 18% earlier, so
  publicnode quality swings between runs. Quiknode's `pending` block also gave 94%.
- **Gnosis**: publicnode ws gave only 6% this run (587-tx burst, then 32 s silent).
  **New:** polling `pending` on `rpc.gnosischain.com` gave 95% coverage, 2.9 s ahead,
  so it is a much steadier source than the ws.
- **Base**: flashblocks 100%, ~1.2 s median (first-piece lead up to ~1.7 s at p90).
- **OP / Ink**: now measured. OP `mainnet.optimism.io` 92% at 0.96 s; Ink 80% at 0.42 s.
- **Arbitrum**: feed 29 ms ahead of publicnode (earlier 44 ms).
- **Robinhood**: public feed 468 ms behind from home (earlier ~480 ms), but 12 ms
  *ahead* from EC2. The lag was the home link.
- **Monad, HyperEVM, Avalanche**: still nothing usable (Monad rejects the subscription;
  HyperEVM and Avalanche accept it and send nothing that matched).

## Ranked shortlist

### (a) Pre-confirmation backrun (public mempool + fee-priority ordering)

You see the swap ~1 s before inclusion and send a backrun priced just under the victim's
tip, so it sorts right behind the victim in the same block. What decides it is the **bid
(tip) against other backrunners**, not raw latency, as long as you land inside the window.

1. **Polygon**: 94% coverage, ~1 s lead, strict fee ordering, simV1 available, volume.
   Best candidate once the index-bug fix lands.
2. **Gnosis**: 95% via `rpc.gnosischain.com` `pending`, 2.9 s lead, strict fee ordering.
   The edges exist, but a rival already pays 237 gwei, so this is a bid war.
3. **Sonic**: works, but measured profit is below gas.
4. **opBNB** (no executor): 100% coverage, 0.5–0.7 s lead, fee-sorted 0.25 s blocks, but
   low volume and no simV1 (would need `eth_call` with state overrides).
5. **Ronin** (no executor): 98% via the official `pending` block, 1.2 s lead, fee-sorted,
   no simV1.
6. **Plasma** (no executor): 75%, 0.76 s lead, fee-sorted, simV1 on 1/5 endpoints.
7. BSC / Ethereum: visible mempools, but blocks come from builders, so a backrun needs
   builder bundle submission. That is a separate integration, not a feed problem.

### (b) Pure latency race from AWS us-east-1 (no mempool; react to sequenced txs)

The swap is already ordered when you see it, so the backrun lands later in the same 2 s
block (flashblock chains) or in the next mini-block or block. What decides it is
**time from feed to sequencer**, plus the tip on flashblock chains, where each 200/250 ms
flashblock is tip-ordered among the txs that made its cutoff. Ranked using the EC2
round-trip numbers below.

1. **Arbitrum One**: the sequencer sits in AWS us-east-2, **16 ms** POST round trip from
   us-east-1 (53 ms from home). FCFS, with the feed 12 ms ahead of publicnode from EC2.
   Every non-express tx gets the same 200 ms delay, so among non-express senders the race
   is decided by RTT, which us-east-1 is well placed for. The Timeboost express-lane
   holder still beats everyone during rounds it controls.
2. **Base**: highest volume (132 user tx/blk). The sequencer endpoint answers in
   **~20 ms** from us-east-1 (Cloudflare-fronted, origin not identifiable), and
   `mainnet-preconf.base.org` showed 89% of txs ~1.0 s ahead from EC2. Race to the next
   flashblock, then a tip auction among those in time. The raw flashblocks socket worked
   for one connection from EC2 but delivered only 44 messages in 40 s on a second,
   concurrent one, so Base's "infra only" warning about it is real. Use a provider
   preconf endpoint in production.
3. **Robinhood**: FCFS (Arbitrum Orbit). From EC2 the public feed is 12 ms *ahead* of
   publicnode with 98.7% coverage, so no paid relay is needed. The 470 ms lag seen from
   home was the home link: home received the same feed messages 506 ms later than EC2,
   while other feeds differed by only 1–25 ms.
4. **Unichain**: sequencer and flashblocks feed share one IP, **10 ms** TCP RTT from
   us-east-1 (likely a nearby GCP region). Mechanically attractive, but only ~0.3 user
   tx/blk in the samples.
5. **OP Mainnet**: flashblocks visible (88–92%, ~1 s ahead), but the sequencer endpoint
   `mainnet-sequencer.optimism.io` is **~87 ms TCP / 91 ms POST from us-east-1**, a
   regional Google load balancer, not an edge. us-east-1 is not near this sequencer, so
   a bot hosted closer to it would beat us. **Confirmed in Groningen, NL**:
   `mainnet-sequencer.optimism.io` (34.6.124.46) pings at **8.5 ms from the Germany VPS**
   (Paul, 2026-10-30), the same site as Ink. OP belongs on the Germany VPS, not in
   us-east-1.
6. **Ink**: the sequencer side is in **Europe, not the US**. `rpc-gel.inkonchain.com`
   (34.12.204.88) pings at **9.0 ms from the Germany VPS** (Paul, 2026-10-30): GCP
   europe-west4, Groningen NL, the same site as OP's sequencer. From us-east-1 it is
   84 ms TCP. Flashblock
   visibility is 81–83%, ~0.43–0.49 s ahead, and volume is low. Ink belongs on the
   Germany VPS, not in us-east-1.
7. **MegaETH**: 10 ms arrival-ordered mini-blocks, `miniBlocks` feed 99.4%. The origin
   is behind Cloudflare. Cold `eth_blockNumber` timings (Paul, 2026-10-30):

   | From | Cloudflare site | Connect | Total |
   |---|---|---|---|
   | prod EC2 | IAD | ~2 ms | **36–59 ms** |
   | Germany VPS | FRA | ~3 ms | **70–100 ms** |

   us-east-1 is ~30–35 ms closer than Germany, but the origin is **not** next door. A
   Virginia origin would show a ~85 ms gap between the two sites (FRA↔IAD), not ~30 ms.
   So either the origin sits well away from both (US central?), or each site reaches a
   different backend and the floor is mostly processing time. The 193 ms between each
   mini-block's timestamp and its arrival on EC2 (218 ms at home) likewise looks like
   timestamp semantics more than distance. Of the hosts measured, us-east-1 is the best
   for MegaETH, but expect ~35 ms or more per round trip, about 2× Arbitrum's.
8. **RISE**: shreds feed shows 100% of txs ~0.5 s before the block, 128 tx/blk. But
   `rpc.risechain.com` takes **~200 ms** per POST from both EC2 and home (TCP to
   Cloudflare 1.3 ms), so the origin is far from us-east-1.
9. **World Chain**: flashblocks seen at home (100% via Alchemy `pending`). Not re-measured
   from EC2, because the drpc reference socket returned no blocks there.

## Measured from EC2 us-east-1

Temporary `c7i.large` in us-east-1f (same subnet and AZ as production), no instance role,
no inbound ports, terminated after the run. Its clock was synced via Amazon Time Sync to
±0.5 ms. Home was NTP-corrected to about ±12 ms (25 ms RTT to time.google.com).

**Round trip to sequencer / RPC endpoints (median, ms).** TCP = connect to port 443;
POST = warm keep-alive JSON-RPC (`eth_chainId`, or a malformed `eth_sendRawTransaction`
for submit-only sequencer endpoints, which every one rejected at the sequencer with a
decode error).

| Chain | Endpoint | Front | EC2 TCP | EC2 POST | Home TCP | Home POST |
|---|---|---|---|---|---|---|
| Arbitrum | `arb1-sequencer.arbitrum.io` | none, **AWS us-east-2** IP | 12.9 | **15.9** | 44.5 | 53.2 |
| Base | `mainnet-sequencer.base.org` | Cloudflare | 1.7 | **20.7** | 23.7 | 89.9 |
| Base | `mainnet-preconf.base.org` | Cloudflare | 1.5 | 19.5 | 24.0 | 62.4 |
| Unichain | `mainnet.unichain.org` (= flashblocks feed IP) | Google LB | 10.4 | 16.1 | 45.0 | 47.0 |
| OP Mainnet | `mainnet-sequencer.optimism.io` | Google LB (regional, **Groningen NL**: 8.5 ms ping from the Germany VPS) | 86.7 | **91.1** | 115.2 | 129.9 |
| OP Mainnet | `mainnet.optimism.io` | Google LB (anycast) | 2.3 | 101.9 | 41.1 | 157.6 |
| Ink | `rpc-gel.inkonchain.com` | Google LB (regional, **Netherlands**: 9.0 ms ping from the Germany VPS) | 84.3 | 89.5 | 120.1 | 144.9 |
| Ink | `rpc-qnd.inkonchain.com` | Cloudflare | 1.4 | 14.4 | 22.7 | 56.5 |
| MegaETH | `mainnet.megaeth.com/rpc` | Cloudflare (cold `eth_blockNumber`: 36–59 ms from EC2 via IAD, 70–100 ms from the Germany VPS via FRA; origin not adjacent to either) | 1.5 | 14.3 | 24.2 | 33.6 |
| Robinhood | `rpc.mainnet.chain.robinhood.com` | Cloudflare | 1.7 | 25.5 | 25.7 | 69.1 |
| RISE | `rpc.risechain.com` | Cloudflare | 1.3 | **201.5** | 76.1 | 215.7 |
| World Chain | `worldchain-mainnet.g.alchemy.com/public` | Alchemy | 2.3 | 8.9 | 40.1 | 55.5 |
| Polygon | `polygon.drpc.org` | Cloudflare | 1.6 | 38.8 | 24.4 | 59.2 |
| Polygon | `rpc-mainnet.matic.quiknode.pro` | – | 81.6 | 82.7 | 120.4 | 120.3 |
| Gnosis | `rpc.gnosischain.com` | Google LB | 2.5 | 113.8 | 40.2 | 279.2 |
| Sonic | `rpc.soniclabs.com` | – (Hetzner) | 103.3 | 119.8 | 160.1 | 150.1 |
| opBNB | `opbnb-mainnet-rpc.bnbchain.org` | AWS Global Accelerator | 0.7 | 6.1 | 33.5 | 46.4 |
| Ronin | `api.roninchain.com/rpc` | Cloudflare | 1.5 | 57.4 | 25.6 | 134.5 |
| Plasma | `rpc.plasma.to` | – (Oracle Cloud) | 1.2 | **2.0** | 40.4 | 35.6 |

A Cloudflare or anycast front makes TCP time meaningless. For those endpoints, read
POST time as an upper bound on the round trip to the origin.

**Feed arrival, home vs EC2, same messages matched by key** (median of home − EC2 after
clock correction; ±12 ms is noise from the home clock):

| Feed | Matched msgs | home − EC2 p10 / p50 / p90 (ms) |
|---|---|---|
| Arbitrum `arb1-feed` | 319 | −2 / 1 / 9 |
| Base flashblocks | 494 | −161 / 18 / 150 (bursty on the home link) |
| Unichain flashblocks | 540 | 20 / 23 / 30 |
| MegaETH miniBlocks | 8930 | 22 / 25 / 31 |
| RISE shreds | 9102 | −19 / −12 / 129 |
| Robinhood feed | 881 | **504 / 506 / 513** |

**Feed lead vs publicnode/drpc newHeads, from EC2** (compare the home numbers above):
Arbitrum 12 ms (98.5%); Robinhood 12 ms (98.7%); MegaETH 490 ms (99.4%); RISE 508 ms
(100%); Unichain 636 ms (100%, 12 tx). `pending` polling: Base preconf 997 ms (88.6%),
OP 1071 ms (88.3%), Ink 426–487 ms (81–83%).

**Mempool chains from EC2:** essentially the same as home.
- Polygon: publicnode 88%, drpc 88%, ~0.8 s ahead.
- Gnosis: `rpc.gnosischain.com` `pending` 92% at 3.7 s; publicnode ws 1.6% (35k-message burst).
- Sonic: 100% (17 tx), ~1.0–1.15 s ahead.
- opBNB: 100%, 0.54–0.78 s ahead.
- Ronin: `pending` 92.5% at 1.39 s.
- Plasma: `pending` 73% at 0.81 s.
- Avalanche: 4.8%.
- Monad, HyperEVM: nothing.

Raw EC2 output: `ec2res/out/` in the session scratchpad.

## Caveats

- Samples are ~20 blocks per chain on one afternoon. Coverage on rotating public
  endpoints (publicnode on Polygon and Gnosis) varied a lot between runs.
- Lead is measured against the earliest `newHeads` among public endpoints, so it
  overstates the lead against a fast private node by roughly that node's head advantage.
- Ordering evidence is heuristic (tip sortedness). For flashblock chains the whole block
  is not sorted, by design, because sorting is per flashblock.
- Only Arbitrum's sequencer exposes its real IP (AWS us-east-2). The others sit behind
  Cloudflare or Google load balancers, so their origin region is inferred from POST
  round trips, not proven. No real transaction was sent, so time from submission to
  inclusion in a block was not measured; that would need a funded test send.
