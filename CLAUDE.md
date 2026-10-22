# arbitrade

Multi-chain DeFi bot in TypeScript and Solidity. It does two jobs:

- **Arbitrage:** flash-loan-funded triangular arbitrage across DEX pairs and pools (V2, Solidly volatile/stable, V3, Algebra).
- **Liquidations:** watches Aave V3, Morpho Blue, Compound III, Compound V2 forks, Euler V2 and Fluid, and liquidates positions that go underwater.

It runs one process per chain. Owner: Paul (GitHub PDUBZ3R0). Public repo `PDUBZ3R0/arbitrade`.

## Runtime and conventions

- Node ≥ 22.6, run with `node --experimental-strip-types`. **There is no build step.** TypeScript is stripped at load, so:
  - **No constructor parameter properties** (`constructor(private x: T)`), enums, or namespaces. They typecheck fine and then throw `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` at import.
  - Imports use the `.ts` extension.
  - A typecheck is not proof that the code runs. Import or run the module.
- ethers v6, better-sqlite3 (one SQLite DB per chain in `db/`), json5 configs.
- `yarn <stage> <chain>` runs through `scripts/log.sh`. That script already tees output to `log/<chain>/<stage>.log` and propagates the exit code, so never add `| tee` to commands. It is POSIX `sh` (dash on Mint): no `==` in `[ ]`, no arrays, no `PIPESTATUS`.
- Validate numeric CLI flags with `Number.isFinite`. `??` does not catch NaN.
- Comments explain *why*, often with the incident that taught it. Keep that style. When fixing a bug, say what it did in the comment.

## Pipeline (per chain)

```
yarn add-chain <chainId> [slug]   # registry entry, conf skeleton, hardhat network, ignition params
yarn provider <chain>             # rate the chain's public RPCs -> conf/provider/<chainId>.json (vetted-provider)
yarn deploy all <chain>           # scripts/deploy.sh: YoBatches3, FlashArbExecutor, TokenProbe, LiquidationExecutor
yarn configure <chain>            # scripts/init.sh: deploy + find factories + the manual pipeline with fee fixes
yarn factories <chain> --add      # find + verify DEX factories into conf/<chain>.json5
yarn manual <chain>               # scan -> reserves -> cleanup -> tokens -> probe -> triangles -> evaluate
yarn arbitrage <chain>            # hot loop (source/hot.ts), Sync/Swap-driven
yarn liquidator <chain>           # liq-watch (source/liq-watch.ts)
yarn all <chain>                  # manual + arbitrage
```

Other tools:

| Command | What it does |
|---|---|
| `yarn verify-fees` / `yarn check-fees` | find wrong fee accessors and fix them with `--apply` |
| `yarn cleanup` | db-clean; `--empty --prune-conf` |
| `yarn market aave\|morpho <chain> <addr>` | verify a lender and print its flashloan block |
| `yarn verify-markets <aave-v3\|morpho-blue\|compound-v3\|all> [--write]` | check `conf/markets/*` on-chain and fill deploy blocks |
| `yarn contract-update` | point the config at deployed addresses; also copies `chain.probe` / `chain.sniper` into `../sniper/conf/<chain>.json5` (or `SNIPER_DIR`) |

## Layout

- `source/` holds the CLIs, one per stage: `scan`, `reserves`, `tokens`, `probe`, `triangles`, `evaluate`, `hot`, `orchestrator`, `liq-watch`, `add-chain`, `verify-*`, …
  - `scanner/`, `reserves/`, `triangles/`, `evaluator/`: the pipeline stages.
  - `orchestrator/`: hot loop, `sync-watcher.ts`, `triangle-index.ts`, `attempt.ts`, `build-hops.ts`, `report.ts`.
  - `liquidation/`: one venue per protocol (`aave-v3.ts`, `morpho.ts`, `compound.ts`, `compound-v2.ts`, `euler.ts`, `fluid.ts`), plus `health.ts`, `plan.ts`, `plan-venues.ts`, `lenders.ts`.
  - `util/`: `config.ts`, `rpc.ts` (makeProvider), `db.ts`, `calculus.js` / `calculus-v3.js` (swap math), `dex-patterns.ts` (fee-accessor registry), `bytecode.ts`, `markets.ts`, `market-checks.ts`, `instance-lock.ts`.
- `contracts/`: `FlashArbExecutor.sol`, `LiquidationExecutor.sol`, `HopEngine.sol`, `TokenProbe.sol`, `YoBatches{,2,3}.sol`.
- `conf/` holds the configuration:
  - `@chains.json5`: registry of id, name, currency and explorer. No RPCs.
  - `<label>.json5`: one per chain: factories, flashloan, liquidation, evaluator.
  - `<label>-blacklist.json5`: factories to drop.
  - `provider/<chainId>.json`: RPC ratings.
  - `markets/{aave-v3,morpho-blue,compound-v3}.json`: lending markets keyed by chain id.
- `test/`: anvil-backed integration suites (see `test/README.md`).
- `scripts/`: deploy, container entry, AWS, probes.
- `docs/aws-deployment.md`: EC2 runbook.

## RPC

`makeProvider(cfg.chain)` (in `source/util/rpc.ts`) returns a **VettedProvider** pool of rated public endpoints. The config has no host and no websocket for real chains.

- `<LABEL>_RPC` / `<LABEL>_WS` in `.env` are the private fallback.
- `chain.sequencer` (or `<LABEL>_SEQUENCER`) is where transactions are sent.
- `ARB_NO_POOL=1` forces the single-endpoint providers, which need `<LABEL>_RPC`.
- HyperSync is no longer on the main path. All containers share one free key, and its rate limit is too low.

## Rules that protect money. Don't regress these

- The trade ledger records **realised** profit from the `ArbExecuted` event, never the pre-trade estimate.
- Profit floor = `max(config, gas × live gas price × margin)`. Predicted profit **must include the lender's flash-loan fee.**
- Candidate execution is shared between `orchestrator` and `hot` (`orchestrator/attempt.ts`, `report.ts`). Never fork it.
- Swap math: `(xNet*b)/(a+xNet)`, never `b*(1 - a/(a+xNet))`. The subtractive form flips signs in float64. uint112 checks need a float margin and must be exact in BigInt.
- When unsure of a fee, guess it high. A fee set too low makes trades revert; one set too high only shrinks profit.
- Fee accessors are per deployment, not per DEX family. Prefer `pair.fee()` over factory mirrors.
- Blacklisting a factory does not remove its pairs from the DB. Purge with `yarn cleanup <chain> --yes`.
- `eth_call` to an address with no code succeeds with `0x`. Check for code first.
- Bytecode selector checks go through `util/bytecode.ts` `hasSelector`, which handles zero-led selectors that solc pushes as PUSH3.
- ethers v6 throws on status-0 receipts and re-estimates gas unless `gasLimit` is set.
- Run only one hot process per chain (`instance-lock.ts`).

## Testing

```
anvil --silent &
node test/compile.mjs                              # compiles the real contracts + mocks
node --experimental-strip-types test/<suite>.mjs   # e.g. test-hot.mjs, test-liq-venues.mjs
```

- `test-liq-venues.mjs` needs `node test/vendor.mjs` once: it compiles real Morpho Blue and Comet into the git-ignored `test/vendor/`. It also needs the `solc0819` / `solc0815` dev dependencies.
- Run the relevant suites after any change to the executor, watcher, index, evaluator sizing, or the liquidation venues. Syntax checks have repeatedly passed on code that crashed or lost money.
- `test-hot.mjs` deletes `db/ledger.sqlite`. Don't run it where the ledger matters.

## Contracts and deploys

- `yarn deploy <flasharb|liquidator|contract|probe|all> <chain> [--check|--force]` (`scripts/deploy.sh`):
  - It compares the deployed bytecode with the bytecode in `contracts/` and redeploys only when they differ.
  - It adopts "dropped" Ignition deploys that actually landed.
  - On HyperEVM it turns big blocks off again on every exit path.
- Ignition keys deploys on the future id, not the bytecode. Never trust "Nothing new to deploy" after editing a `.sol`.

## Production

- AWS EC2 us-east-1, one container per chain (`Containerfile` `ARG CHAIN`, `compose.aws.yaml`). The container copies `conf/@chains.json5`, `conf/<chain>*.json5`, `conf/provider/` and `conf/markets/`.
- Secrets live in SSM. A ~$20/mo VPS in Germany runs chains that don't need co-location.
- Not pursued: BSC and Ethereum mainnet.

## Working with Paul

- Paul commits and pushes himself. **Don't commit or push.** Do remind him occasionally when a lot of work is uncommitted, but check `git status` first, because he often commits without saying so.
- He pastes terminal output and log files and expects root-cause fixes with tests, not lists of options. Read the actual logs and configs before reasoning from memory.
- His dev box is on 5G with limited throughput. Long RPC-bound runs (Polygon reserves) are slow locally.
