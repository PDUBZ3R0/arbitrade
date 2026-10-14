// -----------------------------------------------------------------------------
// The candidate execution path, shared by every caller that trades.
//
// WHY THIS IS ITS OWN MODULE
//
// This logic used to live inside runOrchestratorPass, where it was reachable
// only by running a full evaluator pass first. The Sync-driven hot loop needs
// exactly the same sequence — build at fresh reserves, measure gas, raise the
// profit floor to cover it, simulate at that floor, broadcast, record the
// REALISED profit — but arrives at its candidates a completely different way.
//
// Copying it would have been the obvious move and the wrong one. Every rule
// enforced below is a rule about not losing money, and a second copy means
// every future correction has to be made twice, with a silent loss of money as
// the penalty for forgetting. This session has already produced that exact bug
// twice over in a much more harmless place (maxRoiPct existed as four
// divergent literals; the one that actually ran was not the one displayed), so
// the pattern is not hypothetical.
//
// The order of operations here is load-bearing and is documented inline.
// -----------------------------------------------------------------------------

import { Contract, Interface, JsonRpcProvider, id, type Signer } from 'ethers';
import type { ChainConfig } from '../util/config.ts';
import type { ArbitradeDB } from '../util/db.ts';
import { ledgerPath, flashTermsFor, flashSwapEnabled, type FlashTerms } from '../util/config.ts';
import type { Candidate, EvaluateResult } from '../evaluator/evaluator.ts';
import { buildHops, flashFeeFor, HOP_V3, type BuiltArb } from './build-hops.ts';
import { TradeLedger } from '../util/ledger.ts';
import { fetchUsdPrice } from '../util/usd-price.ts';
import { redactUrl } from '../util/rpc.ts';
import { extractRevertData, decodeRevertReason, probePair, UNSAFE_TOKEN_VERDICTS } from '../util/token-probe.ts';
import fs from 'node:fs';
import path from 'node:path';

export const EXECUTOR_ABI = [
    // Hops carry no output amounts: the contract sizes each swap from live
    // state and the amount that actually arrived. minProfit is the on-chain
    // floor enforced against the real closing balance. `kind` is 0 for a
    // V2-style pair, 1 for a Uniswap/PancakeV3 pool.
    'function executeArb(address asset, uint256 amount, uint256 minProfit, (address pair, address tokenIn, uint32 feePpm, address recipient, uint8 kind)[] hops) external',
    // Same, from any supported lender: source = FLASH_SOURCES[provider]
    // (0 Aave V3, 1 Balancer V2, 2 Uniswap V3 pool flash, 3 Morpho Blue).
    // This is what the orchestrator calls; see flashTermsFor in config.ts.
    'function executeArbFrom(uint8 source, address lender, address asset, uint256 amount, uint256 minProfit, (address pair, address tokenIn, uint32 feePpm, address recipient, uint8 kind)[] hops) external',
    // Funded by the cycle's own first hop (a V2 flash swap): no lender, no
    // premium. Hop 0's recipient must be the executor — see buildHops.
    'function executeFlashSwap(uint256 amountIn, uint256 minProfit, (address pair, address tokenIn, uint32 feePpm, address recipient, uint8 kind)[] hops) external',
    'function SOURCE_MORPHO() view returns (uint8)',
    'function HOP_V3() view returns (uint8)',
    'function FLASH_SWAP() view returns (bool)',
    'function HOP_STABLE() view returns (uint8)',
    // Carries the REALISED profit. The off-chain prediction is an upper bound,
    // so the ledger records this rather than what we expected.
    'event ArbExecuted(address indexed asset, uint256 amountBorrowed, uint256 premium, uint256 profit)',
];

/** Swap callbacks FlashArbExecutor implements for HOP_V3 hops. */
export const EXECUTOR_V3_CALLBACKS = new Set(['uniswapV3SwapCallback', 'pancakeV3SwapCallback']);

/**
 * The executor before V3 hops: same functions, 4-field Hop (no `kind`), so a
 * different selector. Still driven for V2-only cycles, so an existing
 * deployment keeps trading until it is redeployed.
 */
export const EXECUTOR_ABI_V2_ONLY = [
    'function executeArbFrom(uint8 source, address lender, address asset, uint256 amount, uint256 minProfit, (address pair, address tokenIn, uint32 feePpm, address recipient)[] hops) external',
    'function SOURCE_MORPHO() view returns (uint8)',
    'event ArbExecuted(address indexed asset, uint256 amountBorrowed, uint256 premium, uint256 profit)',
];

/** The evaluator's per-root threshold/pricing table. See EvaluateResult. */
export type RootPricing = EvaluateResult['rootPricing'];

export type CandidateAttempt = {
    candidate: Candidate;
    built: BuiltArb | null;
    simulated: boolean;
    simulationError?: string;
    /** True once a transaction was actually sent (regardless of outcome). */
    broadcast: boolean;
    txHash?: string;
    /**
     * True only once the transaction's receipt confirmed with status=1 —
     * this is what "successful" means for the trade ledger. A broadcast tx
     * that reverted on-chain (status=0, can still happen despite a clean
     * eth_call simulation — reserves can move between simulate and land)
     * has broadcast=true, confirmed=false, and is NOT written to the ledger.
     */
    confirmed: boolean;
    /**
     * Profit as measured on-chain by the contract's ArbExecuted event. Set
     * only on a confirmed trade. Differs from built.expectedProfit whenever
     * reserves moved or a token taxed a transfer — the prediction is an upper
     * bound, this is what actually landed.
     */
    realisedProfit?: bigint;
    /** eth_estimateGas for this exact candidate, in gas units. */
    gasEstimate?: bigint;
    /**
     * Where the time went on a broadcast attempt, and how far behind the
     * quote the transaction landed: "quoted @B, landed @L (+n blocks);
     * build 40ms, estimate 120ms, simulate 90ms, send 110ms".
     */
    latency?: string;
    /** gasEstimate x live gas price x margin, in root-token wei. Null if it couldn't be priced. */
    gasFloorWei?: bigint | null;
    /** max(config floor, gas floor) — what the contract actually enforced. */
    minProfitUsed?: bigint;
    /** True when the candidate was dropped for not covering gas, before simulating. */
    belowGasFloor?: boolean;
    /** Refused before any RPC: a pair that refuses the executor or a token measured unsafe (CandidateExecutor.knownBad). */
    knownBad?: boolean;
    /** How it was (or would be) funded: 'flash-swap', or the lender's provider ('aave-v3', …). */
    funding?: string;
    /** The root's decimals/symbol, for rendering a swap root (not in the flash-token config). */
    rootMeta?: { decimals: number; symbol?: string };
};

export type ExecutorOptions = {
    /**
     * Address to simulate `from`. executeArb is onlyOwner, so eth_call needs
     * this to match the deployed contract's owner or it reverts on the
     * access-control check before we even learn if the trade itself works.
     * Required for both dry-run and live (live also needs a matching signer).
     */
    ownerAddress: string;
    /** If true, broadcast candidates that simulate clean. Default false (simulate only). */
    live?: boolean;
    /** Required when live=true — must control ownerAddress. */
    signer?: Signer;
    /**
     * Safety multiple applied to the measured gas cost when deriving the
     * on-chain profit floor. 3 means "only trade if the edge is at least 3x
     * what the block space costs", which absorbs a gas spike between
     * simulation and inclusion. 1 is break-even and leaves no room for the
     * price to move; below 1 is a choice to lose money on some trades.
     * Default 3.
     */
    gasMarginMultiple?: number;
    /** Fallback profit floor, in root-token units, for roots absent from pricing. Default 0.001. */
    minProfitTokens?: number;
    /**
     * How long a fetched gas price may be reused, in ms. Default 12s, roughly
     * a block or two on these chains.
     *
     * A batch pass fetches once and finishes in seconds, so this changes
     * nothing there. It exists for the hot loop, which runs for hours: a gas
     * price captured at startup and never refreshed is not merely stale, it is
     * stale in the dangerous direction. If gas has risen since, every floor
     * derived from it is too low, and the loop cheerfully broadcasts trades
     * that cannot cover their own block space. Polygon moves ~26-265 gwei
     * within a day, so this is a 10x error, not a rounding one.
     */
    gasPriceMaxAgeMs?: number;
};

/**
 * Carries everything an attempt needs that does not change per candidate: the
 * executor contract, the gas-price snapshot, the per-root pricing table.
 *
 * Construct once per pass (batch) or once per process (hot loop), then call
 * `attempt()` per candidate. Deciding whether to keep going after a winner is
 * the caller's business, not this class's.
 */
export class CandidateExecutor {
    private executor: Contract;
    private readonly gasMarginMultiple: number;
    private readonly minProfitTokens: number;
    private readonly gasPriceMaxAgeMs: number;
    private readonly numeraireDecimals: number;

    private gasPriceWei: bigint | null = null;
    private gasPriceFetchedAt = 0;
    private gasFloorUnavailableReason: string | null = null;
    private warnedNoGasFloor = false;

    // Explicit fields, NOT constructor parameter properties. The project runs
    // TypeScript through `node --experimental-strip-types`, which only erases
    // type annotations — it cannot synthesise the assignments a parameter
    // property implies, and throws ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX at import
    // time. `tsc --noEmit` is perfectly happy with them, so this is invisible
    // to a typecheck and only shows up when the file is actually loaded.
    private readonly cfg: ChainConfig;
    private readonly provider: JsonRpcProvider;
    private rootPricing: RootPricing;
    private readonly opts: ExecutorOptions;
    /**
     * Where signed transactions are POSTED (not read from). When chain.sequencer
     * is set, this is a bare provider pointed at it so broadcasts skip the extra
     * hop through the read provider and land faster on single-sequencer rollups.
     * Reads, gas estimation and receipts always stay on `this.provider` — a
     * sequencer endpoint typically speaks only eth_sendRawTransaction.
     */
    private readonly sendProvider: JsonRpcProvider | null;

    constructor(
        cfg: ChainConfig,
        provider: JsonRpcProvider,
        rootPricing: RootPricing,
        opts: ExecutorOptions,
    ) {
        this.cfg = cfg;
        this.provider = provider;
        this.rootPricing = rootPricing;
        this.opts = opts;

        if (!cfg.chain.executor) {
            throw new Error(
                `No executor deployed for ${cfg.chain.name} (chain.executor is unset in config). ` +
                `Run \`yarn deploy-flasharb ${cfg.chain.label}\` first, then add the deployed address ` +
                `as "executor" under the chain block in conf/${cfg.chain.label}.json5.`
            );
        }
        if (opts.live && !opts.signer) {
            throw new Error('live=true requires a signer (set PRIVATE_KEY and pass a Wallet).');
        }

        this.executor = new Contract(cfg.chain.executor, EXECUTOR_ABI, provider);

        // Submit-only provider for direct-to-sequencer broadcast. staticNetwork
        // avoids a chainId round-trip to an endpoint that may not answer reads.
        this.sendProvider = opts.live && cfg.chain.sequencer
            ? new JsonRpcProvider(cfg.chain.sequencer, cfg.chain.id, { staticNetwork: true })
            : null;
        if (this.sendProvider) console.log(`  Broadcasting via sequencer ${redactUrl(cfg.chain.sequencer)} (reads stay on ${redactUrl(cfg.chain.host)})`);

        // `?? 3` alone is not enough: a CLI typo yields NaN, which is not
        // undefined, so it would sail through and blow up in the BigInt
        // conversion mid-pass. Validate the value, not just its presence.
        const raw = opts.gasMarginMultiple ?? 3;
        this.gasMarginMultiple = Number.isFinite(raw) && raw > 0 ? raw : 3;
        this.minProfitTokens = opts.minProfitTokens ?? 0.001;
        const age = opts.gasPriceMaxAgeMs ?? 12_000;
        this.gasPriceMaxAgeMs = Number.isFinite(age) && age >= 0 ? age : 12_000;

        // Gas is paid in the chain's native token; the numeraire is its wrapped
        // form (WPOL / wS / WXDAI), same unit and same decimals, so native wei
        // and numeraire wei are interchangeable in gasFloorWeiFor.
        const numeraireAddr = cfg.chain.token?.toLowerCase();
        this.numeraireDecimals = cfg.flashloan?.tokens.find(
            t => t.address.toLowerCase() === numeraireAddr
        )?.decimals ?? 18;
        if (this.numeraireDecimals !== 18) {
            // Native gas tokens are 18-decimal; a non-18 numeraire means the
            // native<->numeraire shortcut doesn't hold and the conversion would
            // be wrong by orders of magnitude. Refuse rather than guess.
            this.gasFloorUnavailableReason =
                `numeraire has ${this.numeraireDecimals} decimals; native-token conversion assumes 18`;
        }
    }

    /**
     * The deployed executor must have executeArbFrom (multi-provider). An
     * older deployment would revert every call with EMPTY revert data, which
     * reads like a liquidity problem; say what it actually is, once, instead.
     * Checked by calling views only the newer contracts have; cached.
     *
     * Also settles which ABI to speak: an executor with HOP_V3 takes the
     * 5-field Hop and can trade V3 hops; one without it takes the 4-field Hop
     * and is still used for V2-only cycles.
     */
    private executorVersionError: string | null | undefined;
    private executorHasV3 = false;
    private executorHasFlashSwap = false;
    /** HOP_STABLE: trades Solidly stable pools through the pair's own getAmountOut. */
    private executorHasStable = false;
    /** The executor answers algebraSwapCallback (Algebra pools call that, not uniswapV3SwapCallback). */
    private executorHasAlgebra = false;
    /** executeFlashSwap takes a V3 / Algebra first hop (V3_FLASH_SWAP). */
    private executorHasV3Flash = false;
    /** The executor's fallback pays a V3-shaped callback under any name (V3_ANY_CALLBACK). */
    private executorHasAnyCallback = false;
    private warnedNoFlashSwap = false;
    /**
     * Factories whose pairs failed a flash swap that the lender path then
     * accepted for the same cycle — a fork whose swap() does not call back,
     * or calls back with a different argument shape. Later candidates starting
     * on one of these go straight to the lender. In-memory: a restart retries
     * them once, which costs one estimateGas.
     */
    private readonly noFlashFactories = new Set<string>();

    /**
     * Pairs whose swap() refuses this executor — permissioned forks that only
     * serve their own router ("UniswapV2: caller is not verified", "TOMI
     * PAIR : FORBIDDEN", "UniswapV2: UNAUTHORISED", "ConveyorV2: FORBIDDEN!").
     * Polygon, 2026-10-13: five such pairs caused 1,900 of 1,939 simulation
     * reverts in 90 minutes, because the failed-pair memory only lasts one
     * block. A refusal does not depend on reserves, so it is remembered for
     * the run (and in the DB as pair-restricted, which the next `yarn
     * triangles` drops).
     */
    private readonly gatedPairs = new Map<string, string>();
    /** Tokens a QUOTE MISMATCH led us to probe and find unsafe (transfer tax, …). */
    private readonly unsafeTokens = new Map<string, string>();
    private readonly probedAfterMismatch = new Set<string>();
    /** The DB of the attempt in progress, for the diagnostics that write to it. */
    private attemptDb: ArbitradeDB | null = null;

    /** Seed the known-bad sets from what the DB already knows (earlier runs, `yarn probe`). */
    seedKnownBad(db: ArbitradeDB): { pairs: number; tokens: number } {
        const kb = db.getKnownBad();
        for (const r of kb.pairs) this.gatedPairs.set(r.address, r.reason ?? 'pair-restricted');
        for (const r of kb.tokens) this.unsafeTokens.set(r.address, r.status);
        return { pairs: kb.pairs.length, tokens: kb.tokens.length };
    }

    /**
     * Why this candidate cannot trade, known without a round trip: a pair
     * that refuses the executor, or a token measured unsafe. Null when nothing
     * is known against it.
     */
    knownBad(c: Candidate): string | null {
        for (const h of c.hops) {
            const r = this.gatedPairs.get(h.pair.toLowerCase());
            if (r) return `pair ${h.pair} refuses the executor (${r})`;
        }
        for (const h of c.hops) {
            const r = this.unsafeTokens.get(h.tokenOut.toLowerCase());
            if (r) return `token ${h.tokenOut} is ${r}`;
        }
        return null;
    }
    private async checkExecutorVersion(): Promise<string | null> {
        if (this.executorVersionError !== undefined) return this.executorVersionError;
        // Read the code and look for each entry point's selector in the
        // dispatcher (PUSH4 <selector>), rather than calling the functions
        // and treating any failure as "missing". A call can fail because the
        // RPC refused it — on HyperEVM's public endpoint a rate-limited
        // SOURCE_MORPHO() was reported as "executor predates multi-provider
        // flash loans", which also switched off every V3 pool on the chain.
        // An RPC that never answers is an RPC problem, and is reported as one
        // (and NOT cached, so the next attempt tries again).
        const addr = this.cfg.chain.executor!;
        let code: string | null = null, lastErr = '';
        for (let i = 0; i < 4 && code == null; i++) {
            try { code = (await this.provider.getCode(addr)).toLowerCase(); }
            catch (e) { lastErr = (e as Error).message?.slice(0, 120) ?? String(e); await new Promise(r => setTimeout(r, 1000 * 2 ** i)); }
        }
        if (code == null) return `could not read the executor's code at ${addr} (RPC: ${lastErr}) — will retry`;
        if (code === '0x') {
            this.executorVersionError = `no contract at chain.executor ${addr} on ${this.cfg.chain.name} — wrong address, or not deployed here`;
            console.warn(`  [!] ${this.executorVersionError}`);
            return this.executorVersionError;
        }
        const has = (sig: string) => code!.includes('63' + id(sig).slice(2, 10));
        if (!has('SOURCE_MORPHO()')) {
            this.executorVersionError =
                `executor at ${addr} predates multi-provider flash loans (no executeArbFrom) — ` +
                `redeploy: yarn deploy-flasharb ${this.cfg.chain.label} --redeploy, then update chain.executor`;
            console.warn(`  [!] ${this.executorVersionError}`);
            return this.executorVersionError;
        }
        this.executorVersionError = null;
        this.executorHasV3 = has('HOP_V3()');
        this.executorHasFlashSwap = this.executorHasV3 && has('FLASH_SWAP()');
        this.executorHasStable = this.executorHasV3 && has('HOP_STABLE()');
        this.executorHasAlgebra = this.executorHasV3 && has('algebraSwapCallback(int256,int256,bytes)');
        this.executorHasV3Flash = this.executorHasFlashSwap && has('V3_FLASH_SWAP()');
        this.executorHasAnyCallback = this.executorHasV3 && has('V3_ANY_CALLBACK()');
        if (!this.executorHasV3) {
            this.executor = new Contract(addr, EXECUTOR_ABI_V2_ONLY, this.provider);
            console.warn(
                `  [!] executor at ${addr} predates V3 hops — trading V2-only cycles with it. ` +
                `For V3: yarn deploy-flasharb ${this.cfg.chain.label} --redeploy, then yarn contract-update ${this.cfg.chain.label}`);
        }
        return null;
    }

    /**
     * Whether the deployed executor can trade V3 hops. Callers ask the
     * evaluator for V2-only cycles when it cannot, so V3 cycles do not take
     * the attempt slots only to be refused here.
     */
    async supportsV3(): Promise<boolean> {
        return (await this.checkExecutorVersion()) === null && this.executorHasV3;
    }

    /**
     * Whether the deployed executor can trade Solidly stable pools
     * (HOP_STABLE). Callers build the index and run the evaluator with stable
     * pools only when it can.
     */
    async supportsStable(): Promise<boolean> {
        return (await this.checkExecutorVersion()) === null && this.executorHasStable;
    }

    /** Whether executeFlashSwap takes a V3 / Algebra first hop (the pool's swap is the loan). */
    async supportsV3FlashSwap(): Promise<boolean> {
        return (await this.checkExecutorVersion()) === null && this.executorHasV3Flash;
    }

    /** Whether the deployed executor can swap through Algebra pools (algebraSwapCallback). */
    async supportsAlgebra(): Promise<boolean> {
        return (await this.checkExecutorVersion()) === null && this.executorHasAlgebra;
    }

    /** Replace the pricing table, e.g. after the hot loop re-runs the evaluator. */
    setRootPricing(p: RootPricing): void { this.rootPricing = p; }

    get contract(): Contract { return this.executor; }

    /** Current gas price snapshot, in wei. Null until the first successful fetch. */
    get lastGasPriceWei(): bigint | null { return this.gasPriceWei; }

    private async ensureGasPrice(): Promise<void> {
        if (this.gasPriceWei != null && Date.now() - this.gasPriceFetchedAt < this.gasPriceMaxAgeMs) return;
        try {
            const feeData = await this.provider.getFeeData();
            // Prefer maxFeePerGas: it's a ceiling rather than an expectation,
            // which errs toward a HIGHER floor and so toward skipping marginal
            // trades. That's the safe direction — a missed trade costs nothing.
            const px = feeData.maxFeePerGas ?? feeData.gasPrice;
            if (px == null) {
                this.gasFloorUnavailableReason ??= 'provider returned no gas price';
                return;
            }
            this.gasPriceWei = px;
            this.gasPriceFetchedAt = Date.now();
        } catch (err) {
            // Keep the previous price rather than dropping gas protection
            // entirely on one failed RPC call. A slightly stale price is a far
            // smaller problem than no floor at all; if it never succeeds,
            // gasPriceWei stays null and the floor reports unavailable.
            this.gasFloorUnavailableReason ??= `getFeeData failed: ${(err as Error).message?.slice(0, 120)}`;
        }
    }

    /**
     * Profit floor from config/pricing, in root-token wei.
     *
     * Reads the threshold the evaluator ACTUALLY used to select candidates
     * (rootPricing — numeraire-converted per root), rather than recomputing a
     * flat fraction here. Recomputing independently would silently diverge the
     * moment the evaluator's pricing logic changes.
     */
    /**
     * A root's decimals: the flash-token config, else what the evaluator
     * resolved (swap roots carry theirs from the token table), else 18. For a
     * swap root the 18 fallback never applies — the evaluator does not price
     * a root with unknown decimals, so its cycles never reach here.
     */
    private decimalsOf(root: string): number {
        const lc = root.toLowerCase();
        return this.cfg.flashloan?.tokens.find(t => t.address.toLowerCase() === lc)?.decimals
            ?? this.rootPricing[lc]?.decimals
            ?? 18;
    }

    /** True for a swap root: not a flash-loan token, so only a flash swap can fund it. */
    private isSwapOnly(root: string): boolean {
        const lc = root.toLowerCase();
        return !(this.cfg.flashloan?.tokens ?? []).some(t => t.address.toLowerCase() === lc);
    }

    minProfitWeiFor(root: string): bigint {
        const lc = root.toLowerCase();
        const decimals = this.decimalsOf(lc);
        const rootUnits = this.rootPricing[lc]?.minProfitInRootTokens ?? this.minProfitTokens;
        return BigInt(Math.round(rootUnits * 10 ** decimals));
    }

    /**
     * Gas cost for `gasUnits`, expressed in ROOT-token wei and multiplied by
     * the safety margin. Null when it can't be computed — the caller then falls
     * back to the config floor alone and says so, rather than silently trading
     * with no gas protection.
     *
     * minProfitTokens is a "don't bother below this" preference. It is NOT a
     * solvency check, because the contract cannot see gas: a trade can be
     * profitable on-chain and net-negative once you pay for the block space.
     * Only the caller can enforce that, and only against the live gas price —
     * a static config number cannot, since any value low enough to trade at the
     * bottom of the day's range loses money at the top.
     */
    gasFloorWeiFor(root: string, gasUnits: bigint): bigint | null {
        if (this.gasPriceWei == null || this.numeraireDecimals !== 18) return null;
        // priceInNumeraire: numeraire units per 1 root unit. 1 when the root IS
        // the numeraire; null when no direct pair was found, in which case we
        // cannot price gas in this root at all.
        const price = this.rootPricing[root.toLowerCase()]?.priceInNumeraire;
        if (price == null || !(price > 0)) return null;

        const rootDecimals = this.decimalsOf(root);

        const gasCostNumeraire = Number(gasUnits * this.gasPriceWei) / 1e18;
        const gasCostRootUnits = gasCostNumeraire / price;
        // Apply the margin in float math, before the BigInt conversion, so a
        // fractional multiple like 1.5 works. Ceil, not round: a floor that
        // rounds down is a floor that lets a break-even trade past.
        const wei = Math.ceil(gasCostRootUnits * this.gasMarginMultiple * 10 ** rootDecimals);
        if (!Number.isFinite(wei) || wei <= 0) return null;
        return BigInt(wei);
    }

    /**
     * Whether this cycle should be funded by flash-swapping its first hop.
     * Same rule as cyclePremium (the evaluator's premium), plus the
     * factories that have already proven unable to flash swap.
     */
    private wantsFlashSwap(candidate: Candidate): boolean {
        const first = candidate.hops[0];
        return flashSwapEnabled(this.cfg)
            && candidate.hops.length >= 2
            && (first.kind !== 'v3' || this.executorHasV3Flash)
            && !this.noFlashFactories.has(first.factory.toLowerCase());
    }

    /** Why the root's lender cannot fund this cycle, or null if it can. */
    private lenderUnusable(candidate: Candidate, terms: FlashTerms | null): string | null {
        if (!terms) {
            return `no flash lender configured for root ${candidate.rootToken} ` +
                `(flashloan.provider / pool / vault / morpho, or the token's own provider+lender in conf/${this.cfg.chain.label}.json5)`;
        }
        // A V3 pool is locked for the length of its own flash loan, so a
        // cycle that trades through the lending pool cannot execute.
        if (terms.provider === 'uniswap-v3' && candidate.hops.some(h => h.pair.toLowerCase() === terms.lender.toLowerCase())) {
            return `cycle trades through its own flash-loan pool ${terms.lender}`;
        }
        return null;
    }

    /**
     * The executor call for one funding choice. `args(minProfit)` because the
     * same call is estimated at the config floor and then simulated and sent
     * at the gas-adjusted one.
     */
    private callFor(useFlash: boolean, terms: FlashTerms | null, root: string, built: BuiltArb) {
        const hopsArg = this.executorHasV3
            ? built.hops.map(h => [h.pair, h.tokenIn, h.feePpm, h.recipient, h.kind])
            : built.hops.map(h => [h.pair, h.tokenIn, h.feePpm, h.recipient]);
        const name = useFlash ? 'executeFlashSwap' : 'executeArbFrom';
        const args = (minProfit: bigint): unknown[] => useFlash
            ? [built.rootAmountIn, minProfit, hopsArg]
            : [terms!.source, terms!.lender, root, built.rootAmountIn, minProfit, hopsArg];
        return { name, fn: this.executor.getFunction(name), args };
    }

    /**
     * Build, gas-check, simulate and (if live) broadcast one candidate.
     *
     * Never throws for an unexecutable candidate — a revert, a decayed edge or
     * an uncoverable gas cost all come back as a populated CandidateAttempt
     * with `simulated: false`. A thrown error means something structurally
     * wrong (RPC down, signer rejected), which the caller should surface.
     */
    async attempt(candidate: Candidate, db: ArbitradeDB): Promise<CandidateAttempt> {
        const attempt: CandidateAttempt = {
            candidate, built: null, simulated: false, broadcast: false, confirmed: false,
            rootMeta: { decimals: this.decimalsOf(candidate.rootToken), symbol: this.rootPricing[candidate.rootToken.toLowerCase()]?.symbol },
        };
        this.attemptDb = db;
        const bad = this.knownBad(candidate);
        if (bad) { attempt.simulationError = `known bad: ${bad}`; attempt.knownBad = true; return attempt; }

        const t0 = Date.now();
        const marks: Array<[string, number]> = [];
        const mark = (label: string) => marks.push([label, Date.now()]);
        const versionError = await this.checkExecutorVersion();
        if (versionError) {
            attempt.simulationError = versionError;
            return attempt;
        }
        if (!this.executorHasV3 && candidate.hops.some(h => h.kind === 'v3')) {
            attempt.simulationError =
                `cycle has a v3 hop and the executor at ${this.cfg.chain.executor} predates V3 hops — ` +
                `yarn deploy-flasharb ${this.cfg.chain.label} --redeploy`;
            return attempt;
        }

        if (!this.executorHasStable && candidate.hops.some(h => h.stable)) {
            attempt.simulationError =
                `cycle has a stable-pool hop and the executor at ${this.cfg.chain.executor} predates HOP_STABLE — ` +
                `yarn deploy flasharb ${this.cfg.chain.label}`;
            return attempt;
        }

        // Funding. A cycle whose first hop is a V2-style pair is funded by
        // flash-swapping that pair (no lender, no premium — the evaluator
        // scored it that way, see cyclePremium). Anything else borrows the
        // root from its lender.
        const terms = flashTermsFor(this.cfg, candidate.rootToken);
        let useFlash = this.wantsFlashSwap(candidate);
        if (useFlash && !this.executorHasFlashSwap) {
            if (!this.warnedNoFlashSwap) {
                this.warnedNoFlashSwap = true;
                console.warn(
                    `  [!] flashloan.flashSwap is on but the executor at ${this.cfg.chain.executor} has no executeFlashSwap — ` +
                    `borrowing instead, and the evaluator's zero-premium scores overstate those cycles. ` +
                    `yarn deploy-flasharb ${this.cfg.chain.label} --redeploy, then yarn contract-update ${this.cfg.chain.label}`);
            }
            useFlash = false;
        }
        if (!useFlash) {
            const why = this.lenderUnusable(candidate, terms);
            if (why) { attempt.simulationError = why; return attempt; }
        }

        // The executor answers two swap callbacks. A pool that calls anything
        // else would revert the swap; say so here instead of paying for an
        // estimateGas to find out.
        const algebraPools = new Set<string>();
        for (const h of candidate.hops) {
            if (h.kind !== 'v3') continue;
            const f = this.cfg.factories.find(x => x.address.toLowerCase() === h.factory.toLowerCase());
            // Algebra pools (V1 and Integral) call algebraSwapCallback, whatever
            // the conf says; their state is read with getAlgebraState.
            const algebra = f?.group === 'algebra';
            const cb = algebra ? 'algebraSwapCallback' : f?.callback;
            if (algebra) algebraPools.add(h.pair.toLowerCase());
            // Every callback the verifier records is (int256,int256,bytes)-shaped;
            // an executor with V3_ANY_CALLBACK pays it under whatever name.
            if (cb && !EXECUTOR_V3_CALLBACKS.has(cb) && !this.executorHasAnyCallback
                && !(cb === 'algebraSwapCallback' && this.executorHasAlgebra)) {
                attempt.simulationError = cb === 'algebraSwapCallback'
                    ? `v3 hop ${h.pair} is an Algebra pool and the executor at ${this.cfg.chain.executor} predates algebraSwapCallback — yarn deploy flasharb ${this.cfg.chain.label}`
                    : `v3 hop ${h.pair} calls ${cb}, which the executor at ${this.cfg.chain.executor} does not answer (predates V3_ANY_CALLBACK) — yarn deploy flasharb ${this.cfg.chain.label}`;
                return attempt;
            }
        }

        await this.ensureGasPrice();

        let built: BuiltArb | null;
        try {
            built = await buildHops(
                this.provider,
                this.cfg.chain.executor!,
                db,
                candidate,
                this.minProfitWeiFor(candidate.rootToken),
                this.cfg.chain.contract,
                { flashSwap: useFlash, premium: useFlash ? 0 : (terms?.premium ?? 0), algebraPools },
            );
        } catch (err) {
            // Reading the path failed (an unreadable pair, an RPC error): a
            // failed attempt the caller can count and mute — never a crash.
            attempt.simulationError = `could not read the path: ${(err as Error).message?.slice(0, 240) ?? String(err)}`;
            return attempt;
        }
        attempt.built = built;
        if (!built) return attempt;   // edge decayed since evaluation
        mark('build');

        // 1. Measure gas for THIS candidate. estimateGas also reverts if the
        // path is not executable, so it doubles as a first validation.
        let call = this.callFor(useFlash, terms, candidate.rootToken, built);
        let gasUnits: bigint;
        try {
            gasUnits = await call.fn.estimateGas(...call.args(built.minProfitWei), { from: this.opts.ownerAddress });
        } catch (err) {
            const msg = (err as Error).message?.slice(0, 300) ?? String(err);
            // A pair whose swap() never calls back (or calls back with a
            // different argument shape) fails a flash swap here and nowhere
            // else. If the root has a usable lender, try the same cycle
            // through it — same amounts, only hop 0's routing differs, so no
            // re-read is needed. If THAT estimates, the factory is the problem:
            // remember it so later candidates go straight to the lender.
            if (!useFlash || this.lenderUnusable(candidate, terms)) {
                attempt.simulationError = msg + await this.diagnoseRepay(err, call, built, built.minProfitWei, candidate) + await this.diagnoseGated(err, candidate);
                return attempt;   // would revert on-chain
            }
            // Same amounts, but now the lender charges its fee: profit shrinks by it.
            const lenderFee = flashFeeFor(built.rootAmountIn, terms?.premium ?? 0);
            const viaLender = { ...built, flashFee: lenderFee, expectedProfit: built.expectedProfit + built.flashFee - lenderFee,
                hops: built.hops.map((h, i) =>
                i === 0 && built!.hops[1].kind !== HOP_V3 ? { ...h, recipient: built!.hops[1].pair } : h) };
            const lenderCall = this.callFor(false, terms, candidate.rootToken, viaLender);
            try {
                gasUnits = await lenderCall.fn.estimateGas(...lenderCall.args(built.minProfitWei), { from: this.opts.ownerAddress });
            } catch {
                attempt.simulationError = msg + await this.diagnoseRepay(err, call, built, built.minProfitWei, candidate) + await this.diagnoseGated(err, candidate);   // the flash error: it is the one that ran first
                return attempt;
            }
            const factory = candidate.hops[0].factory.toLowerCase();
            this.noFlashFactories.add(factory);
            console.warn(`  [!] factory ${factory}: flash swap reverted where ${terms!.provider} did not — borrowing for its pairs from now on (${msg.slice(0, 120)})`);
            useFlash = false;
            built = viaLender;
            attempt.built = built;
            call = lenderCall;
        }
        attempt.gasEstimate = gasUnits;
        mark('estimate');
        attempt.funding = useFlash ? 'flash-swap' : terms!.provider;

        // 2. Raise the floor to cover gas. The config floor is a preference;
        // this is the break-even line.
        const gasFloor = this.gasFloorWeiFor(candidate.rootToken, gasUnits);
        attempt.gasFloorWei = gasFloor;
        const effectiveMinProfit = gasFloor != null && gasFloor > built.minProfitWei
            ? gasFloor
            : built.minProfitWei;
        attempt.minProfitUsed = effectiveMinProfit;
        // A swap root has no config floor anyone chose for it — its floor is a
        // numeraire threshold converted at its own pair's price. If gas cannot
        // be priced in it, nothing says the trade pays for itself: refuse.
        // (A flash token keeps the old behaviour: config floor, with a warning.)
        if (gasFloor == null && this.isSwapOnly(candidate.rootToken)) {
            attempt.simulationError = `gas cannot be priced in swap root ${candidate.rootToken} — refusing rather than trading on the config floor alone`;
            return attempt;
        }
        if (gasFloor == null && this.gasFloorUnavailableReason && !this.warnedNoGasFloor) {
            this.warnedNoGasFloor = true;
            console.warn(`  [!] gas-derived profit floor unavailable (${this.gasFloorUnavailableReason}); using the config floor only — trades may not cover gas`);
        }

        // Predicted profit has to clear the gas-adjusted floor before we spend
        // anything else on this candidate.
        if (built.expectedProfit < effectiveMinProfit) {
            attempt.belowGasFloor = true;
            return attempt;
        }

        // 3. Simulate at the floor we would actually broadcast with, so
        // "simulated clean" means clean under the real constraint.
        try {
            await call.fn.staticCall(...call.args(effectiveMinProfit), { from: this.opts.ownerAddress });
            attempt.simulated = true;
            mark('simulate');
        } catch (err) {
            attempt.simulationError = ((err as Error).message?.slice(0, 300) ?? String(err))
                + await this.diagnoseRepay(err, call, built, effectiveMinProfit, candidate) + await this.diagnoseGated(err, candidate);
            return attempt;
        }

        if (!this.opts.live) return attempt;

        // 4. Broadcast. effectiveMinProfit, NOT built.minProfitWei — the whole
        // point of the gas floor is that it binds the broadcast, not just the
        // simulation.
        const signer = this.opts.signer!;

        if (this.sendProvider) {
            // Direct-to-sequencer submission. Sign locally — nonce, fees and
            // chainId come from the READ provider via the signer — and set an
            // explicit gasLimit (the step-1 estimate + 30% headroom) so nothing
            // is re-estimated against the submit-only endpoint. Then POST the raw
            // tx straight to the sequencer, and confirm on the read provider: a
            // sequencer endpoint speaks only eth_sendRawTransaction, and once
            // mined the tx is visible to any RPC.
            const req = await (this.executor.connect(signer) as Contract)
                .getFunction(call.name).populateTransaction(...call.args(effectiveMinProfit));
            req.gasLimit = (gasUnits * 13n) / 10n;
            const prepared = await signer.populateTransaction(req);
            const raw = await signer.signTransaction(prepared);
            let txHash: string;
            try {
                txHash = await this.sendProvider.send('eth_sendRawTransaction', [raw]);
            } catch (err) {
                // The sequencer did not accept it (e.g. "context deadline
                // exceeded" at the 12s queue timeout). Nothing entered ordering,
                // so drop any locally-advanced nonce and move on.
                (signer as { reset?: () => void }).reset?.();
                attempt.simulationError = `sequencer did not accept the tx: ${(err as Error).message?.slice(0, 160)}`;
                return attempt;
            }
            mark('send');
            attempt.broadcast = true;
            attempt.txHash = txHash;

            // A direct send can silently not land (dropped from ordering), so
            // bound the wait and treat a timeout as not-landed rather than hang.
            const receipt = await this.provider.waitForTransaction(txHash, 1, 60_000);
            if (!receipt) {
                (signer as { reset?: () => void }).reset?.();
                attempt.simulationError = `broadcast but not mined within 60s, txHash=${txHash}`;
                return attempt;
            }
            attempt.latency = latencyNote(built.blockTag, receipt.blockNumber, t0, marks);
            if (receipt.status !== 1) {
                attempt.simulationError = `transaction broadcast but reverted on-chain (status=0)${gasSpent(receipt)}, txHash=${txHash}`;
                return attempt;
            }
            attempt.confirmed = true;
            attempt.realisedProfit = await this.recordTrade(candidate, built, txHash, receipt);
            return attempt;
        }

        // Explicit gasLimit: without it ethers re-runs eth_estimateGas before
        // sending — a whole extra round trip after a simulation that just
        // passed, while the edge ages (Sonic: ~3 blocks a second). The same
        // estimate + 30% headroom as the sequencer path.
        const signed = this.executor.connect(signer) as Contract;
        let tx: any;
        try {
            tx = await signed.getFunction(call.name)(...call.args(effectiveMinProfit), { gasLimit: (gasUnits * 13n) / 10n });
        } catch (err) {
            // Refused before it was sent (nonce, funds, a node-side check):
            // nothing went on-chain, so it is a failed attempt, not a crash.
            attempt.simulationError = `not sent: ${String((err as any)?.shortMessage ?? (err as Error)?.message ?? err).slice(0, 200)}`;
            return attempt;
        }
        mark('send');
        attempt.broadcast = true;
        attempt.txHash = tx.hash;

        // Wait for confirmation — a clean eth_call simulation doesn't guarantee
        // the tx lands successfully; reserves can move between simulate and
        // inclusion. "Successful" for the trade ledger means status=1
        // confirmed, not just sent.
        //
        // ethers v6's wait() does not return a status=0 receipt: it THROWS
        // CALL_EXCEPTION with the receipt attached. Left uncaught, a mined
        // revert surfaced as "attempt threw … transaction execution reverted"
        // with no hash, and the attempt was never reported as a broadcast
        // (Sonic hot run, 2026-10-12, #13814).
        let receipt: any;
        try {
            receipt = await tx.wait();
        } catch (err: any) {
            if (err?.receipt) receipt = err.receipt;
            else {
                attempt.simulationError = `broadcast, but waiting for the receipt failed: ${String(err?.shortMessage ?? err?.message ?? err).slice(0, 160)}, txHash=${tx.hash}`;
                return attempt;
            }
        }
        attempt.latency = latencyNote(built.blockTag, receipt?.blockNumber, t0, marks);
        if (!receipt || receipt.status !== 1) {
            // Broadcast but reverted on-chain — not a trade, not logged to the
            // ledger. Surfaced via simulationError so the CLI print picks it up.
            attempt.simulationError = `transaction broadcast but reverted on-chain (status=0)${gasSpent(receipt)}, txHash=${tx.hash}`;
            return attempt;
        }

        attempt.confirmed = true;
        attempt.realisedProfit = await this.recordTrade(candidate, built, tx.hash, receipt);
        return attempt;
    }

    /**
     * An InsufficientRepay means the cycle returned less than predicted. Two
     * very different causes look identical in the log:
     *   - STALE: the path moved between the read block and the simulation —
     *     normal on a fast chain, nothing to fix;
     *   - QUOTE MISMATCH: at the very block the prediction was computed from,
     *     the executor still gets less — the off-chain math (a V3 fork's swap,
     *     a stable curve, a fee) disagrees with the pool. A bug.
     * Re-run the same call pinned to built.blockTag and say which. Mismatches
     * are appended to log/<chain>/quote-mismatch.jsonl with the full path.
     * Returns a suffix for simulationError ('' when it cannot tell).
     */
    private async diagnoseRepay(err: unknown, call: { fn: any; args: (m: bigint) => unknown[] }, built: BuiltArb, minProfit: bigint, candidate: Candidate): Promise<string> {
        try {
            const data = extractRevertData(err);
            if (!data || !data.toLowerCase().startsWith(INSUFFICIENT_REPAY)) return '';
            if (built.blockTag == null) return ' [all-V2 path, reads not pinned to a block — cannot tell stale from mismatch]';
            const B = built.blockTag;
            let atB: string | null = null;
            try {
                await call.fn.staticCall(...call.args(minProfit), { from: this.opts.ownerAddress, blockTag: B });
                return ` [stale: clean at block ${B}, where the quote was read — the path moved after it]`;
            } catch (e2) { atB = extractRevertData(e2); }
            if (!atB || !atB.toLowerCase().startsWith(INSUFFICIENT_REPAY)) {
                return ` [at block ${B} it reverts differently: ${(atB ?? 'no data').slice(0, 74)}]`;
            }
            const got = BigInt('0x' + atB.slice(10, 74));
            const required = BigInt('0x' + atB.slice(74, 138));
            const want = built.expectedAmountOut;
            const ppm = want > 0n ? Number(((want - got) * 1_000_000n) / want) : 0;
            // The swaps delivered what we predicted: the gap is on the other
            // side — what we thought the contract would require (loan + fee +
            // minProfit). An accounting bug, not swap math.
            const kind = got >= want ? 'accounting' : 'quote';
            const rec = {
                at: new Date().toISOString(), chain: this.cfg.chain.label, block: B, triangleId: candidate.triangleId, kind,
                required: required.toString(), flashFee: built.flashFee?.toString(),
                rootToken: candidate.rootToken, amountIn: built.rootAmountIn.toString(),
                predictedOut: want.toString(), executorOut: got.toString(), shortPpm: ppm,
                hops: candidate.hops.map((h: any, i: number) => ({
                    pair: h.pair, factory: h.factory, kind: h.kind ?? 'v2', stable: !!h.stable, fee: h.fee,
                    tokenIn: h.tokenIn, tokenOut: h.tokenOut, builtKind: built.hops[i]?.kind, feePpm: built.hops[i]?.feePpm,
                })),
            };
            try {
                const dir = path.join('log', this.cfg.chain.label);
                fs.mkdirSync(dir, { recursive: true });
                fs.appendFileSync(path.join(dir, 'quote-mismatch.jsonl'), JSON.stringify(rec) + '\n');
            } catch { /* diagnostics must never break the loop */ }
            if (kind === 'accounting') {
                return ` [ACCOUNTING at block ${B}: the swaps returned exactly the prediction (${got}) but the contract required ${required} — loan + fee + minProfit was underestimated; logged to log/${this.cfg.chain.label}/quote-mismatch.jsonl]`;
            }
            return ` [QUOTE MISMATCH at block ${B}: predicted ${want}, executor got ${got} (${ppm} ppm short) — logged to log/${this.cfg.chain.label}/quote-mismatch.jsonl]`
                + await this.probeAfterMismatch(candidate);
        } catch {
            return '';
        }
    }

    /**
     * A revert with a reason string that is not ours: find out whether one of
     * the path's V2/stable pairs refuses the executor outright. Each such pair
     * is asked directly — swap(1, 0, executor, "") from the executor's address.
     * An ordinary pair answers with its own input check (INSUFFICIENT_INPUT_
     * AMOUNT, K, …); a permissioned one fails its access check first, with the
     * same reason the cycle hit. Only an exact match convicts a pair.
     */
    private async diagnoseGated(err: unknown, candidate: Candidate): Promise<string> {
        try {
            const data = extractRevertData(err);
            if (!data || !data.toLowerCase().startsWith('0x08c379a0')) return '';
            const reason = decodeRevertReason(data);
            if (!reason) return '';
            const exec = this.cfg.chain.executor!;
            const swapData = V2_SWAP_IFACE.encodeFunctionData('swap', [1n, 0n, exec, '0x']);
            for (const h of candidate.hops as any[]) {
                if (h.kind === 'v3') continue;
                const pair = h.pair.toLowerCase();
                let got = '';
                try { await this.provider.call({ from: exec, to: pair, data: swapData }); continue; }
                catch (e) { got = decodeRevertReason(extractRevertData(e)); }
                if (got !== reason) continue;
                this.gatedPairs.set(pair, `swap() reverts "${reason}" for any caller but its router`);
                let saved = '';
                try { this.attemptDb?.setPairProbe(pair, 'pair-restricted', `hot loop: swap() from the executor reverts "${reason}"`); saved = '; marked pair-restricted in the DB — `yarn triangles` drops it'; }
                catch { /* read-only DB: the in-memory ban still holds for this run */ }
                return ` [permissioned pair ${pair} (factory ${h.factory}): its swap() refuses the executor — skipped for the rest of the run${saved}]`;
            }
            return '';
        } catch {
            return '';
        }
    }

    /**
     * A QUOTE MISMATCH that is not staleness: the executor received less than
     * exact pool math predicts, at the very block the quote was read. The
     * usual cause is a transfer tax the probe has not measured (its token was
     * never probed, or the probe errored). Probe each non-root token of the
     * path once, through a V2 hop that pairs it with a flash-loan root, and
     * ban it if it is unsafe.
     */
    private async probeAfterMismatch(candidate: Candidate): Promise<string> {
        const probe = this.cfg.chain.probe;
        if (!probe) return '';
        const roots = new Set((this.cfg.flashloan?.tokens ?? []).map(t => t.address.toLowerCase()));
        const found: string[] = [];
        for (const h of candidate.hops as any[]) {
            if (h.kind === 'v3' || h.stable) continue;
            const a = h.tokenIn.toLowerCase(), b = h.tokenOut.toLowerCase();
            const [root, token] = roots.has(a) && !roots.has(b) ? [a, b] : roots.has(b) && !roots.has(a) ? [b, a] : [null, null];
            if (!root || !token || this.probedAfterMismatch.has(token)) continue;
            this.probedAfterMismatch.add(token);
            try {
                const pair = new Contract(h.pair, ['function getReserves() view returns (uint112, uint112, uint32)', 'function token0() view returns (address)'], this.provider);
                const [[r0, r1], t0] = await Promise.all([pair.getReserves(), pair.token0()]);
                const rootReserve = (t0 as string).toLowerCase() === root ? BigInt(r0) : BigInt(r1);
                const out = await probePair(this.provider, probe, root, h.pair, rootReserve * 5n / 1000n);
                if (!(UNSAFE_TOKEN_VERDICTS as readonly string[]).includes(out.status)) continue;
                const what = `${out.status}${out.buyTaxBps != null ? ` (buy ${out.buyTaxBps} bps / sell ${out.sellTaxBps} bps)` : ''}`;
                this.unsafeTokens.set(token, what);
                try { this.attemptDb?.setTokenProbe(token, { status: out.status, buyTaxBps: out.buyTaxBps, sellTaxBps: out.sellTaxBps, reason: `hot loop after a quote mismatch: ${out.reason}`, pair: h.pair }); }
                catch { /* read-only DB */ }
                found.push(`${token} ${what}`);
            } catch { /* probing is best effort */ }
        }
        return found.length ? ` [probed: ${found.join(', ')} — excluded from now on and recorded in the DB]` : '';
    }

    /**
     * Write a confirmed trade to the ledger and return the REALISED profit.
     *
     * built.expectedProfit is a prediction made at pre-trade reserves and is an
     * upper bound — reserve drift and transfer taxes can only reduce what
     * actually lands. Recording the prediction would make the ledger
     * systematically optimistic, which is the one thing a P&L record must not
     * be. Falls back to the prediction only if the event can't be found, and
     * says so loudly.
     */
    private async recordTrade(candidate: Candidate, built: BuiltArb, txHash: string, receipt: any): Promise<bigint> {
        const rootTokenCfg = this.cfg.flashloan?.tokens.find(
            t => t.address.toLowerCase() === candidate.rootToken.toLowerCase()
        );
        const decimals = this.decimalsOf(candidate.rootToken);

        let realisedProfit = built.expectedProfit;
        let profitIsRealised = false;
        for (const log of receipt.logs) {
            if (log.address.toLowerCase() !== this.cfg.chain.executor!.toLowerCase()) continue;
            try {
                const parsed = this.executor.interface.parseLog({ topics: [...log.topics], data: log.data });
                if (parsed?.name === 'ArbExecuted') {
                    realisedProfit = parsed.args[3] as bigint;
                    profitIsRealised = true;
                    break;
                }
            } catch { /* not our event */ }
        }
        if (!profitIsRealised) {
            console.warn(`  [!] ${txHash}: no ArbExecuted event found — ledger profit is the pre-trade estimate, not realised`);
        }

        // Awaited, not fire-and-forget. Deferring this to keep the hot loop
        // responsive was tempting and wrong: the batch CLI runs one pass and
        // exits, and a pending write at exit is a trade that happened and was
        // never recorded. A few hundred ms of latency is cheap; a hole in the
        // P&L is not. The USD price is cosmetic by contrast, so a failure there
        // must not take the trade record with it.
        let profitUsd: number | null = null;
        try {
            const usdPrice = await fetchUsdPrice(this.cfg.chain.label, candidate.rootToken);
            if (usdPrice != null) profitUsd = (Number(realisedProfit) / 10 ** decimals) * usdPrice;
        } catch { /* price lookup is cosmetic */ }

        const ledger = new TradeLedger(ledgerPath());
        try {
            ledger.recordTrade({
                timestamp: Math.floor(Date.now() / 1000),
                chain: this.cfg.chain.label,
                type: 'arbitrage',
                txHash,
                blockNumber: receipt.blockNumber,
                rootToken: candidate.rootToken,
                rootTokenSymbol: rootTokenCfg?.symbol ?? this.rootPricing[candidate.rootToken.toLowerCase()]?.symbol,
                profitWei: realisedProfit,
                profitDecimals: decimals,
                profitUsd,
                // Explicit BigInt(): `receipt` comes off an untyped Contract
                // call, so both operands are `any` and TS types `any * any`
                // as number — which isn't assignable to gasCostWei. It worked
                // at runtime (they really are bigints) but the annotation was a
                // lie, and this file is never typechecked in CI.
                gasCostWei: BigInt(receipt.gasUsed ?? 0) * BigInt(receipt.gasPrice ?? 0),
            });
        } catch (err) {
            // The trade is real whether or not we managed to write it down.
            // Report loudly and keep the realised number so the caller still
            // prints the truth.
            console.warn(`  [!] ${txHash}: ledger write failed — ${(err as Error).message}`);
        } finally {
            ledger.close();
        }

        return realisedProfit;
    }
}

/** ", gas 412,331 (0.0207 native)" for a mined receipt — what a revert cost. */
function gasSpent(receipt: any): string {
    try {
        const used = BigInt(receipt?.gasUsed ?? 0);
        const price = BigInt(receipt?.gasPrice ?? receipt?.effectiveGasPrice ?? 0);
        if (used === 0n) return '';
        const cost = price > 0n ? ` (${(Number(used * price) / 1e18).toFixed(6)} native)` : '';
        return `, gas ${used.toLocaleString('en-US')}${cost}`;
    } catch { return ''; }
}

/** InsufficientRepay(uint256,uint256) — FlashArbExecutor's "the cycle came back short". */
const INSUFFICIENT_REPAY = id('InsufficientRepay(uint256,uint256)').slice(0, 10);
const V2_SWAP_IFACE = new Interface(['function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes data)']);

/**
 * "quoted @80922919, landed @80922925 (+6 blocks); build 35ms, estimate 140ms,
 * simulate 95ms, send 120ms". The block lag is how stale the edge was by the
 * time it executed — the number to watch when broadcasts revert on a fast chain.
 */
function latencyNote(quoteBlock: number | undefined, landedBlock: number | undefined, t0: number, marks: Array<[string, number]>): string {
    const parts: string[] = [];
    let prev = t0;
    for (const [label, t] of marks) { parts.push(`${label} ${t - prev}ms`); prev = t; }
    const blocks = quoteBlock != null && landedBlock != null
        ? `quoted @${quoteBlock}, landed @${landedBlock} (+${landedBlock - quoteBlock} block${landedBlock - quoteBlock === 1 ? '' : 's'}); `
        : landedBlock != null ? `landed @${landedBlock}; ` : '';
    return blocks + parts.join(', ');
}
