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

import { Contract, JsonRpcProvider, type Signer } from 'ethers';
import type { ChainConfig } from '../util/config.ts';
import type { ArbitradeDB } from '../util/db.ts';
import { ledgerPath, flashTermsFor } from '../util/config.ts';
import type { Candidate, EvaluateResult } from '../evaluator/evaluator.ts';
import { buildHops, type BuiltArb } from './build-hops.ts';
import { TradeLedger } from '../util/ledger.ts';
import { fetchUsdPrice } from '../util/usd-price.ts';

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
    'function SOURCE_MORPHO() view returns (uint8)',
    'function HOP_V3() view returns (uint8)',
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
    /** gasEstimate x live gas price x margin, in root-token wei. Null if it couldn't be priced. */
    gasFloorWei?: bigint | null;
    /** max(config floor, gas floor) — what the contract actually enforced. */
    minProfitUsed?: bigint;
    /** True when the candidate was dropped for not covering gas, before simulating. */
    belowGasFloor?: boolean;
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
        if (this.sendProvider) console.log(`  Broadcasting via sequencer ${cfg.chain.sequencer} (reads stay on ${cfg.chain.host.replace(/\/v2\/[^/]+/, '/v2/***')})`);

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
    private async checkExecutorVersion(): Promise<string | null> {
        if (this.executorVersionError !== undefined) return this.executorVersionError;
        try {
            await this.executor.SOURCE_MORPHO();
            this.executorVersionError = null;
        } catch {
            this.executorVersionError =
                `executor at ${this.cfg.chain.executor} predates multi-provider flash loans (no executeArbFrom) — ` +
                `redeploy: yarn deploy-flasharb ${this.cfg.chain.label} --redeploy, then update chain.executor`;
            console.warn(`  [!] ${this.executorVersionError}`);
            return this.executorVersionError;
        }
        try {
            await this.executor.HOP_V3();
            this.executorHasV3 = true;
        } catch {
            this.executorHasV3 = false;
            this.executor = new Contract(this.cfg.chain.executor!, EXECUTOR_ABI_V2_ONLY, this.provider);
            console.warn(
                `  [!] executor at ${this.cfg.chain.executor} predates V3 hops — trading V2-only cycles with it. ` +
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
    minProfitWeiFor(root: string): bigint {
        const lc = root.toLowerCase();
        const tokenCfg = this.cfg.flashloan?.tokens.find(t => t.address.toLowerCase() === lc);
        const decimals = tokenCfg?.decimals ?? 18;
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

        const rootDecimals = this.cfg.flashloan?.tokens.find(
            t => t.address.toLowerCase() === root.toLowerCase()
        )?.decimals ?? 18;

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
        };

        // Where this root is borrowed from. No lender, no trade.
        const terms = flashTermsFor(this.cfg, candidate.rootToken);
        if (!terms) {
            attempt.simulationError = `no flash lender configured for root ${candidate.rootToken} ` +
                `(flashloan.provider / pool / vault / morpho, or the token's own provider+lender in conf/${this.cfg.chain.label}.json5)`;
            return attempt;
        }
        // A V3 pool is locked for the length of its own flash loan, so a
        // cycle that trades through the lending pool cannot execute.
        if (terms.provider === 'uniswap-v3' && candidate.hops.some(h => h.pair.toLowerCase() === terms.lender.toLowerCase())) {
            attempt.simulationError = `cycle trades through its own flash-loan pool ${terms.lender}`;
            return attempt;
        }
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
        // The executor answers two swap callbacks. A pool that calls anything
        // else would revert the swap; say so here instead of paying for an
        // estimateGas to find out.
        for (const h of candidate.hops) {
            if (h.kind !== 'v3') continue;
            const cb = this.cfg.factories.find(f => f.address.toLowerCase() === h.factory.toLowerCase())?.callback;
            if (cb && !EXECUTOR_V3_CALLBACKS.has(cb)) {
                attempt.simulationError = `v3 hop ${h.pair} calls ${cb}, which the executor does not implement`;
                return attempt;
            }
        }

        await this.ensureGasPrice();

        const built = await buildHops(
            this.provider,
            this.cfg.chain.executor!,
            db,
            candidate,
            this.minProfitWeiFor(candidate.rootToken),
            this.cfg.chain.contract,
        );
        attempt.built = built;
        if (!built) return attempt;   // edge decayed since evaluation

        const hopsArg = this.executorHasV3
            ? built.hops.map(h => [h.pair, h.tokenIn, h.feePpm, h.recipient, h.kind])
            : built.hops.map(h => [h.pair, h.tokenIn, h.feePpm, h.recipient]);

        // 1. Measure gas for THIS candidate. estimateGas also reverts if the
        // path is not executable, so it doubles as a first validation.
        let gasUnits: bigint;
        try {
            gasUnits = await this.executor.executeArbFrom.estimateGas(
                terms.source,
                terms.lender,
                candidate.rootToken,
                built.rootAmountIn,
                built.minProfitWei,
                hopsArg,
                { from: this.opts.ownerAddress },
            );
            attempt.gasEstimate = gasUnits;
        } catch (err) {
            attempt.simulationError = (err as Error).message?.slice(0, 300) ?? String(err);
            return attempt;   // would revert on-chain
        }

        // 2. Raise the floor to cover gas. The config floor is a preference;
        // this is the break-even line.
        const gasFloor = this.gasFloorWeiFor(candidate.rootToken, gasUnits);
        attempt.gasFloorWei = gasFloor;
        const effectiveMinProfit = gasFloor != null && gasFloor > built.minProfitWei
            ? gasFloor
            : built.minProfitWei;
        attempt.minProfitUsed = effectiveMinProfit;
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
            await this.executor.executeArbFrom.staticCall(
                terms.source,
                terms.lender,
                candidate.rootToken,
                built.rootAmountIn,
                effectiveMinProfit,
                hopsArg,
                { from: this.opts.ownerAddress },
            );
            attempt.simulated = true;
        } catch (err) {
            attempt.simulationError = (err as Error).message?.slice(0, 300) ?? String(err);
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
            const req = await (this.executor.connect(signer) as Contract).executeArbFrom.populateTransaction(
                terms.source, terms.lender, candidate.rootToken, built.rootAmountIn, effectiveMinProfit, hopsArg,
            );
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
            if (receipt.status !== 1) {
                attempt.simulationError = `transaction broadcast but reverted on-chain (status=0), txHash=${txHash}`;
                return attempt;
            }
            attempt.confirmed = true;
            attempt.realisedProfit = await this.recordTrade(candidate, built, txHash, receipt);
            return attempt;
        }

        const signed = this.executor.connect(signer) as Contract;
        const tx = await signed.executeArbFrom(
            terms.source,
            terms.lender,
            candidate.rootToken,
            built.rootAmountIn,
            effectiveMinProfit,
            hopsArg,
        );
        attempt.broadcast = true;
        attempt.txHash = tx.hash;

        // Wait for confirmation — a clean eth_call simulation doesn't guarantee
        // the tx lands successfully; reserves can move between simulate and
        // inclusion. "Successful" for the trade ledger means status=1
        // confirmed, not just sent.
        const receipt = await tx.wait();
        if (!receipt || receipt.status !== 1) {
            // Broadcast but reverted on-chain — not a trade, not logged to the
            // ledger. Surfaced via simulationError so the CLI print picks it up.
            attempt.simulationError = `transaction broadcast but reverted on-chain (status=0), txHash=${tx.hash}`;
            return attempt;
        }

        attempt.confirmed = true;
        attempt.realisedProfit = await this.recordTrade(candidate, built, tx.hash, receipt);
        return attempt;
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
        const decimals = rootTokenCfg?.decimals ?? 18;

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
                rootTokenSymbol: rootTokenCfg?.symbol,
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
