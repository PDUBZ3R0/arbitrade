# Factory Investigator — Design Spec

**Purpose:** given a chain, produce an authoritative list of V2-compatible factories to feed into `conf/{chain}.json5`. Extends the existing DEX router investigator (which is swap-execution focused) with a probe suite specifically for the discovery pathway (event scanning + reserve reading + fee assumption).

**Status:** design only, not built. Deferred until the base scanner → reserves → triangles → evaluator pipeline is working end-to-end.

---

## Compatibility requirements

For a factory to be included in the pair scanner, three things must all be true:

1. It emits `PairCreated`-style events with enumerable historical logs
2. The pairs it creates hold token balances directly (so `token.balanceOf(pair)` returns reserves)
3. The AMM curve is `x*y=k` with a knowable, constant fee (so `calculus.js` is valid)

Any factory failing any of these is either:
- **Incompatible** (skip; add to exclusion list with reason)
- **Deferred** (V3-style — needs the separate V3 scanner + Quoter path)
- **Compatible-with-adapter** (needs custom fee handling, output-shape wrapping, etc.)

---

## Probe suite

Run these in order, short-circuit on failure.

### Probe A — Factory exists and has bytecode
```
eth_getCode(factory_address, latest)
→ if '0x' or empty, factory doesn't exist. FAIL.
```

### Probe B — Emits PairCreated events
```
eth_getLogs({
    address: factory,
    topics: [keccak256("PairCreated(address,address,address,uint256)")],
    fromBlock: 0,
    toBlock: latest,
    // in practice: sample recent 100k blocks to keep it cheap
})
→ if empty, try:
  - PoolCreated (V3): keccak256("PoolCreated(address,address,uint24,int24,address)")
  - Solidly PairCreated: keccak256("PairCreated(address,address,bool,address,uint256)")
  - Algebra: keccak256("Pool(address,address,address)")
  - Beethoven / Balancer: usually no factory event at all
→ record which shape matched
```

### Probe C — Sample pairs implement getReserves()
```
For 3 random pairs from the event log sample:
    result = eth_call(pair, "getReserves()")
    if result returns 3 words (uint112, uint112, uint32) → V2-style
    else if result returns slot0 shape (uint160, int24, ...) → V3-style
    else if reverts → custom, needs manual review
```

### Probe D — token.balanceOf(pair) matches getReserves()
This is the killer test for "does YoBatches work here?"
```
For each sample pair:
    token0 = pair.token0()
    token1 = pair.token1()
    (r0, r1, _) = pair.getReserves()
    b0 = ERC20(token0).balanceOf(pair)
    b1 = ERC20(token1).balanceOf(pair)
    
    if abs(b0 - r0) / max(r0, 1) < 0.001 && abs(b1 - r1) / max(r1, 1) < 0.001:
        YoBatches will work here ✓
    else:
        Tokens held elsewhere (vault design), or fee-on-transfer weirdness ✗
```

Small deltas (< 0.1%) between reserves and balances are normal — donations, fee-on-transfer tokens accumulating small dust. Big deltas (>10x) mean the token isn't held in the pair contract.

### Probe E — Fee determination
```
Standard V2 forks: fee is hardcoded in the pair's swap() function.
Some expose it via:
    - fee() returns uint256
    - swapFee() returns uint256
    - getFee() returns uint256
    - MINIMUM_LIQUIDITY / etc (not fee-related but sometimes hardcoded)

Try each. If none:
    - Sample 3 pairs' fee via forward simulation:
      - Read (r0, r1)
      - Compute expected output for 1e18 input using formula with fee=0.003
      - eth_call swap() or getAmountsOut() on the router
      - Compare — if match within 0.01%, fee is 0.003
      - Otherwise, binary search fee ∈ [0, 0.05]
```

### Probe F — Verified source (optional bonus)
```
If ETHERSCAN_API_KEY is configured (per chain):
    Fetch verified source for the sample pair
    Hash the swap() function's bytecode body
    Compare against known-safe hashes:
        - Uniswap V2 canonical
        - SushiSwap variants
        - Solidly-style
    If match: confidence ↑↑
    If not: flag for manual review
```

---

## Classification output

Each factory ends up in one of these buckets:

```typescript
type FactoryClassification =
    | { kind: 'v2-strict', fee: number, source: 'known' | 'derived' }
    | { kind: 'v2-compatible', fee: number, notes: string }
    | { kind: 'v3-family' }                    // defer to V3 scanner
    | { kind: 'solidly-family' }                // may or may not include
    | { kind: 'incompatible', reason: string }
    | { kind: 'needs-manual-review', notes: string };
```

Output is written per-chain as `investigator-output/{chain}.factories.json5`:

```json5
{
    "recommended_for_scanning": [
        { name: "SomeDEX", address: "0x...", fee: 0.003, kind: "v2-strict" },
        ...
    ],
    "deferred_v3": [ ... ],
    "incompatible": [
        { name: "Curve", address: "0x...", reason: "stableswap curve, not x*y=k" }
    ],
    "needs_review": [ ... ]
}
```

User then copies the `recommended_for_scanning` entries into their `conf/{chain}.json5`.

---

## Data source: DefiLlama

`https://api.llama.fi/protocols` returns all tracked protocols. Filter:
- `category === "Dexes"`
- `chains` includes our target chain
- Sort by TVL descending — investigate biggest fish first

For each candidate, extract:
- `name`, `slug`, `url`, `github`
- `forkedFrom` (huge hint! if forked from Uniswap V2, probably V2-strict)

We also need to find the factory address for each, which DefiLlama doesn't provide. Sources:
1. Project's own docs (parse from HTML — brittle)
2. GitHub repos (look for `factory` or `deployments` in code)
3. Manually curated registry (what we do now)

The pragmatic answer: DefiLlama gives us the *list* of DEXs, our registry gives us their *addresses*. The registry grows as we investigate.

---

## Sequencing

This investigator is deferred until we have:
- ✅ Pair scanner working with the 5 known-good Polygon factories
- ⬜ Reserves fetcher (calls YoBatches, updates DB)
- ⬜ Triangle enumerator (rooted at flash-loanable tokens)
- ⬜ Profit evaluator (composes triangle + reserves + calculus)
- ⬜ End-to-end run producing candidate triangles

At that point:
- Extend `investigator.js` with the probe suite above
- Run against Polygon → get 10-30 more factories
- Add them to `conf/polygon.json5`
- Re-run scanner (existing factories skip; new ones scan from genesis)
- Opportunity universe grows without any code changes to the bot itself

This ordering also protects against wasted work: if the base pipeline reveals that (say) our triangle enumerator's search space is already too big with 5 factories, we'll know we need to prune before adding more, rather than making the problem worse.
