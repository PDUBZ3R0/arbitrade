# AWS deployment & RPC setup

Running `arbitrade` (hot loop + liq-watch) on AWS for the single-sequencer
rollups: **Base, Optimism, Arbitrum, Ink**. These chains have no public pending
mempool, so the game is **latency to the sequencer**, not MEV/private relays
(that's Polygon/BSC/L1 — see "Why no private relay" below).

> One-liner: **paid Alchemy for reads+WS, sequencer-direct submission, on a
> compute-optimized us-east-1 box.** In that priority order — reads first
> (that's what starves the loop today), then sequencer-direct + region.

---

## 1. Architecture

| Choice | Decision | Why |
|---|---|---|
| Compute | **EC2**, not Fargate | SQLite needs persistent local disk; Fargate's ephemeral storage loses the DBs on restart |
| State | **SQLite on EBS (gp3)**, not DynamoDB | Dynamo is too write-heavy/costly (~$400+/mo/chain for the reserve churn); SQLite is free and local |
| Secrets | **SSM Parameter Store** (SecureString) | `PRIVATE_KEY`, Alchemy keys — never baked into the image or `.env` on disk |
| Access | **SSM Session Manager**, no inbound ports | No SSH, no open security group; shell in via `aws ssm start-session` |
| Logs | **CloudWatch** | `log/<chain>/*.log` also tee'd to disk by `scripts/log.sh` |
| Layout | **one container per chain** (`Containerfile` `ARG CHAIN`) | restart independence; `compose.aws.yaml` brings them up together |

Container boot (`scripts/container-entry.sh`): seed DB → `manual.sh` (scan →
reserves → triangles) → start `hot` + `liq-watch` under supervision.

### Instance type — the one trap to avoid

- **Use compute-optimized: `c7i` (x86) or `c7g` (Graviton).**
- **Do NOT use burstable `t3`/`t4g`.** The hot loop is single-threaded,
  CPU-bound Node (triangle re-scoring / pricing). CPU-credit throttling will
  starve it exactly when the market is busy — the most common self-inflicted
  wound here.
- RAM: 4–8 GB covers every chain's index with room to spare (Polygon's ~1.1M
  triangles is the heaviest at ~52 MB). A single box comfortably runs all four
  chains' containers.

### Region

- **`us-east-1` (N. Virginia)** is the pragmatic single home — the OP/Arbitrum
  sequencers run US-east-ish, so this minimizes submit latency for all four.
- Caveat: exact sequencer regions aren't officially published. Treat us-east-1
  as "start here and measure round-trip to each sequencer," not gospel. If one
  chain's sequencer turns out elsewhere, a second box in that region is the fix.

---

## 2. RPC strategy

### Reads + websocket feed → paid Alchemy (first-order fix)

This is what actually starves the loop on the free tier: the hot loop keeps pace
with blocks but its `getV3States` / reserve reads get rate-limited, so candidates
decay on stale prices. A paid tier with real rate limits and a WS subscription
that keeps up fixes that. Alchemy supports all four, including Ink.

| Chain | HTTPS (reads) | WebSocket (feed) |
|---|---|---|
| Base | `https://base-mainnet.g.alchemy.com/v2/<KEY>` | `wss://base-mainnet.g.alchemy.com/v2/<KEY>` |
| Optimism | `https://opt-mainnet.g.alchemy.com/v2/<KEY>` | `wss://opt-mainnet.g.alchemy.com/v2/<KEY>` |
| Arbitrum | `https://arb-mainnet.g.alchemy.com/v2/<KEY>` | `wss://arb-mainnet.g.alchemy.com/v2/<KEY>` |
| Ink | `https://ink-mainnet.g.alchemy.com/v2/<KEY>` | `wss://ink-mainnet.g.alchemy.com/v2/<KEY>` (chain id 57073) |

(QuickNode works equally well; the choice barely matters for reads. What matters
is the rate limit and a WS that keeps up.)

### Transaction submission → direct to the sequencer (the latency win)

On a single-sequencer rollup, whoever's tx reaches the sequencer first wins.
Routing the broadcast through Alchemy adds a hop (you → Alchemy → sequencer).
Posting the signed tx straight to the sequencer shaves that hop.

This is wired via the **`chain.sequencer`** config field (added
`source/util/config.ts`). When it's set **and** running `--live`, `attempt.ts`
signs locally and POSTs the raw tx straight to the sequencer, then confirms on
the read provider. Reads, gas estimation and receipts never touch it — a
sequencer endpoint typically speaks only `eth_sendRawTransaction`. Unset = the
normal public-broadcast path (unchanged).

| Chain | Sequencer submit endpoint | Notes |
|---|---|---|
| Base | `https://mainnet-sequencer.base.org` | submit-only; **verify with a curl before trusting in prod** |
| Optimism | `https://mainnet-sequencer.optimism.io` | submit-only; **verify** |
| Arbitrum One | `https://arb1-sequencer.arbitrum.io/rpc` | confirmed in Arbitrum docs; accepts only `eth_sendRawTransaction[Conditional]`; 12s queue timeout → `context deadline exceeded` = not accepted, safe to retry |
| Ink | *(none published)* | leave unset; send through Alchemy/public RPC. Ink is quiet — latency barely matters there; its prize is the Tydro liquidation book |

---

## 3. Per-chain `.env`

The config reads `<LABEL>_RPC`, `<LABEL>_WS`, and `<LABEL>_SEQUENCER` as
overrides (label uppercased, `-` → `_`). Store these in SSM, not on disk.

```sh
# reads + feed (paid Alchemy)
BASE_RPC=https://base-mainnet.g.alchemy.com/v2/<KEY>
BASE_WS=wss://base-mainnet.g.alchemy.com/v2/<KEY>
OPTIMISM_RPC=https://opt-mainnet.g.alchemy.com/v2/<KEY>
OPTIMISM_WS=wss://opt-mainnet.g.alchemy.com/v2/<KEY>
ARBITRUM_RPC=https://arb-mainnet.g.alchemy.com/v2/<KEY>
ARBITRUM_WS=wss://arb-mainnet.g.alchemy.com/v2/<KEY>
INK_RPC=https://ink-mainnet.g.alchemy.com/v2/<KEY>
INK_WS=wss://ink-mainnet.g.alchemy.com/v2/<KEY>

# sequencer-direct submission (leave a chain's line out to use the normal path)
BASE_SEQUENCER=https://mainnet-sequencer.base.org
OPTIMISM_SEQUENCER=https://mainnet-sequencer.optimism.io
ARBITRUM_SEQUENCER=https://arb1-sequencer.arbitrum.io/rpc
# (no INK_SEQUENCER — Ink sends go through INK_RPC)

# signer (SSM SecureString)
PRIVATE_KEY=0x...
ENVIO_API_TOKEN=...   # HyperSync seed; paid tier speeds the one-time backfill
```

On startup, `yarn hot <chain> --live` prints `Broadcasting via sequencer …`
when the direct path is active — confirm it took.

---

## 4. Deploy steps

Scripts live in `scripts/aws/`.

1. **Provision** — `scripts/aws/setup-instance.sh`: launches the EC2 instance
   (c7i/c7g, us-east-1), attaches the gp3 EBS volume, attaches the IAM role
   (`instance-policy.json`: SSM + CloudWatch + Parameter Store read).
2. **Secrets** — `scripts/aws/push-env.sh`: writes the `.env` values into SSM
   Parameter Store (the container pulls them at boot).
3. **Seed data** — `scripts/aws/push-db.sh`: copies pre-built `db/<chain>.sqlite`
   up so the box doesn't re-scan from scratch on first boot (big time saver on
   Polygon/Base-sized graphs).
4. **Bring up** — `compose.aws.yaml` builds `Containerfile` per chain and starts
   `hot` + `liq-watch`. First boot runs `manual.sh` to catch the DB up.
5. **Shell in** — `aws ssm start-session --target <instance-id>` (no SSH/ports).
6. **Logs** — CloudWatch, or `log/<chain>/{hot,liq-watch}.log` on the box.

To pick up code changes (e.g. this session's crash fixes, V3 read retry/heal,
sequencer-direct submission): rebuild the image and restart the containers.
Redeploy the on-chain executors too if the selectors changed
(`yarn deploy-flasharb`/`deploy-liquidator` + `yarn contract-update <chain>`).

---

## 5. Why no private relay on these chains

Private submission (bloXroute / FastLane / Flashbots) is a **public-mempool**
fix — it stops front-running where pending txs are gossiped and ordered by gas
auction (Polygon, BSC, Ethereum L1). Base/OP/Arbitrum/Ink have a **single
sequencer and no public pending mempool**: nobody sees your tx before inclusion,
so there's nothing to front-run and a relay buys ~nothing. The levers here are:

1. **Reads that keep up** (paid Alchemy) — so you see the edge.
2. **Latency to the sequencer** (direct submit + us-east-1) — so you land it.
3. On **Arbitrum**, if it ever matters, **Timeboost** (its express-lane auction)
   is the paid-priority mechanism — not a relay.

---

## 6. Caveats before going live

- **Verify the Base/OP sequencer URLs** with a quick `curl` — they're the
  canonical hostnames but aren't in official docs the way Arbitrum's is.
- **Nonce on a not-landed direct send:** `liq-watch` uses a `NonceManager` and
  resets on a not-accepted/timeout send. The hot loop uses a plain `Wallet`
  (re-reads pending nonce each send) — generally fine, but a
  sequencer-accepted-then-dropped tx is the one edge where a gap could appear.
  Watch the first live session.
- **This is the live money-send path.** Sequencer-direct is gated off until you
  set `<CHAIN>_SEQUENCER`, so nothing changes until you opt a chain in. **Turn
  it on one chain first** and watch a session before rolling it everywhere.
- **Expectations:** this moves you from "edge decays before I can read it" to
  "in the race." It won't flip contested arb to reliably profitable on its own,
  but it should meaningfully help the simpler first-to-land **liquidation**
  races on all four.
