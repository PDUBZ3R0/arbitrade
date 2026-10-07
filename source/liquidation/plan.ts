// -----------------------------------------------------------------------------
// Liquidation planner + executor client (piece 3 of the liquidation module).
//
// Given an account the HealthMonitor says is liquidatable, decide WHAT to
// liquidate, HOW to exit, and WHETHER it pays — then (only with live=true)
// send it through contracts/LiquidationExecutor.sol.
//
//   1. Positions   per-reserve aToken / variable-debt balances from Aave's
//                  ProtocolDataProvider, priced with the Aave oracle.
//   2. Pair        every (collateral, debt) the account holds, ranked by the
//                  payout Aave's rules allow: close factor (100% under HF 0.95
//                  or under $2K per reserve, else 50%), the collateral's bonus
//                  — or the account's eMode bonus — less the protocol's share
//                  of the bonus, capped by the collateral actually there.
//   3. Route       collateral -> debt through pools this bot already knows
//                  (db/<chain>.sqlite from `yarn scan`): direct pools, then
//                  two hops via hub tokens. Same-asset positions need none.
//   4. Simulate    eth_call of liquidate() for every (pair, route, amount):
//                  the contract RETURNS realised profit, so the chain itself
//                  prices Aave's liquidation math, the protocol fee, pool
//                  slippage and transfer taxes. Nothing here re-implements
//                  any of them; the planner only proposes, the chain decides.
//   5. Gas floor   the best route must clear max(minProfitUsd, gas x margin),
//                  gas priced in the debt asset via the Aave oracle and — on
//                  OP-stack chains — including the L1 data fee, which
//                  getFeeData() does not show and which can dominate there.
//   6. Send        only when live; the final simulation and the broadcast use
//                  the same floor as minProfit, enforced on-chain. Realised
//                  profit comes from the LiquidationExecuted event, never the
//                  estimate (same rule as the arb ledger).
// -----------------------------------------------------------------------------

import { Contract, Interface, getAddress, type JsonRpcProvider, type Signer } from 'ethers';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import { multicall3 } from '../util/multicall.ts';
import { flashTermsFor, type ChainConfig } from '../util/config.ts';
import { TradeLedger } from '../util/ledger.ts';
import { ledgerPath } from '../util/config.ts';
import { readPrices, type AaveMarket, type AaveReserve } from './aave-v3.ts';

export const LIQUIDATOR_ABI = [
    'function owner() view returns (address)',
    'function liquidate(uint8 source, address lender, (address pool, address user, address collateral, address debt, uint256 debtToCover, uint256 minProfit) l, (address pair, address tokenIn, uint32 feePpm, address recipient, uint8 kind)[] hops) returns (uint256 profit)',
    'event LiquidationExecuted(address indexed user, address indexed collateral, address indexed debt, uint256 debtRepaid, uint256 collateralSeized, uint256 premium, uint256 profit)',
    'error InsufficientRepay(uint256 balance, uint256 required)',
    'error NothingSeized()',
    'error RouteMismatch()',
    'error NotOwner()',
];

const DATA_PROVIDER_IFACE = new Interface([
    'function getUserReserveData(address asset, address user) view returns (uint256 currentATokenBalance, uint256 currentStableDebt, uint256 currentVariableDebt, uint256 principalStableDebt, uint256 scaledVariableDebt, uint256 stableBorrowRate, uint256 liquidityRate, uint40 stableRateLastUpdated, bool usageAsCollateralEnabled)',
]);

// OP-stack GasPriceOracle predeploy: the L1 data fee is charged on top of
// gasUsed x gasPrice and is invisible to eth_estimateGas / eth_gasPrice.
const OP_GAS_ORACLE = '0x420000000000000000000000000000000000000F';
const OP_ORACLE_IFACE = new Interface([
    'function getL1FeeUpperBound(uint256 unsignedTxSize) view returns (uint256)',
    'function getL1Fee(bytes data) view returns (uint256)',
]);
/** OP-stack chain ids (Optimism, Base, Mode, Ink, Zora, Soneium, Unichain…). */
const OP_STACK = new Set([10, 8453, 34443, 57073, 7777777, 1868, 130, 252, 5000]);

const SOURCE = { 'aave-v3': 0, 'balancer-v2': 1, 'morpho': 3 } as const;
const CLOSE_FACTOR_HF = 95n * 10n ** 16n;

// --- 1. positions ------------------------------------------------------------

export type Position = AaveReserve & {
    /** aToken balance (underlying units). */
    supplied: bigint;
    /** stable + variable debt (underlying units). */
    debt: bigint;
    usedAsCollateral: boolean;
    price: bigint;
};

export async function readPositions(
    provider: JsonRpcProvider, market: AaveMarket, user: string, prices: Map<string, bigint>,
): Promise<Position[]> {
    if (!market.dataProvider) throw new Error('Aave data provider not resolved for this market — cannot read per-reserve balances');
    const res = await multicall3(provider, market.reserves.map(r => ({
        target: market.dataProvider!, allowFailure: true,
        callData: DATA_PROVIDER_IFACE.encodeFunctionData('getUserReserveData', [r.asset, user]),
    })));
    const out: Position[] = [];
    market.reserves.forEach((r, i) => {
        if (!res[i]?.success || res[i].returnData === '0x') return;
        const d = DATA_PROVIDER_IFACE.decodeFunctionResult('getUserReserveData', res[i].returnData);
        const supplied = d[0] as bigint, debt = (d[1] as bigint) + (d[2] as bigint);
        if (supplied === 0n && debt === 0n) return;
        out.push({ ...r, supplied, debt, usedAsCollateral: d[8] as boolean, price: prices.get(r.asset) ?? 0n });
    });
    return out;
}

// --- 2. pair choice ------------------------------------------------------------

export type PairPlan = {
    collateral: Position;
    debt: Position;
    /**
     * Debt amounts to try, best first. [0] is the most Aave allows; [1], when
     * present, is the reduced amount that leaves $1,000 of collateral behind —
     * the only legal partial liquidation when [0] would leave dust (below).
     * Aave caps whatever is offered; the unspent part goes back to the lender.
     */
    amounts: bigint[];
    closeFactor: 50 | 100;
    bonusBps: number;
    /** Estimated liquidator payout for amounts[0], base units (before swap / flash fee / gas). */
    estPayoutBase: bigint;
    /** amounts[0] would trip Aave's MustNotLeaveDust (amounts[1] is the fix). */
    leavesDust: boolean;
};

const valueBase = (amount: bigint, p: Position) => amount * p.price / 10n ** BigInt(p.decimals);
const unitsOf = (base: bigint, p: Position) => p.price === 0n ? 0n : base * 10n ** BigInt(p.decimals) / p.price;

/**
 * Every (collateral, debt) the account holds, best estimated payout first,
 * following Aave v3.3 LiquidationLogic:
 *
 *   max repay   the reserve's whole debt, EXCEPT when the collateral reserve
 *               and the debt reserve are both >= $2,000 and HF > 0.95: then
 *               at most 50% of the account's TOTAL debt
 *   seize       repay x bonus, capped by the collateral there (repay scaled
 *               down to match); the protocol keeps its fee share of the bonus
 *   dust rule   a partial liquidation (debt left AND collateral left) must
 *               leave >= $1,000 of both, else MustNotLeaveDust. If the max
 *               repay would leave a sliver of collateral, the legal move is to
 *               repay LESS so $1,000 stays — offered as amounts[1].
 *
 * `eModeBonusBps` > 10000 replaces the reserve bonus (the account is in eMode).
 */
export function choosePairs(market: AaveMarket, positions: Position[], hf: bigint, eModeBonusBps = 0): PairPlan[] {
    const small = 2000n * market.baseUnit;
    const leftover = 1000n * market.baseUnit;
    const totalDebtBase = positions.reduce((s, p) => s + valueBase(p.debt, p), 0n);
    const plans: PairPlan[] = [];
    for (const c of positions) {
        if (!c.usedAsCollateral || c.supplied === 0n || c.price === 0n) continue;
        for (const d of positions) {
            if (d.debt === 0n || d.price === 0n) continue;
            const collBase = valueBase(c.supplied, c), debtBase = valueBase(d.debt, d);
            const capped = collBase >= small && debtBase >= small && hf > CLOSE_FACTOR_HF;
            let repay = d.debt;
            if (capped && debtBase > totalDebtBase / 2n) repay = unitsOf(totalDebtBase / 2n, d);
            const bonus = BigInt(eModeBonusBps > 10000 ? eModeBonusBps : (c.bonusBps || 10500));

            const seizeFor = (r: bigint) => {
                let seize = valueBase(r, d) * bonus / 10000n, rr = r;
                if (seize > collBase) { seize = collBase; rr = unitsOf(collBase * 10000n / bonus, d); }
                return { seize, repay: rr };
            };
            const primary = seizeFor(repay);
            const partial = primary.repay < d.debt && primary.seize < collBase;
            const leavesDust = partial && (collBase - primary.seize < leftover || debtBase - valueBase(primary.repay, d) < leftover);

            // +0.2% headroom: interest accrues between this read and the block that executes.
            const pad = (x: bigint) => x + x / 500n + 1n;
            const amounts = [pad(primary.repay)];
            let payoutSeize = primary.seize;
            if (leavesDust) {
                // Leave $1,000 (+2% for oracle/rounding drift) of this collateral, if debt leftover allows.
                const target = collBase - leftover * 102n / 100n;
                const r = target > 0n ? unitsOf(target * 10000n / bonus, d) : 0n;
                if (r > 0n && debtBase - valueBase(r, d) >= leftover) {
                    amounts.push(r);   // no headroom: it must stay under the dust line
                    payoutSeize = target;
                }
            }
            const bonusPart = payoutSeize - payoutSeize * 10000n / bonus;
            plans.push({
                collateral: c, debt: d, amounts,
                closeFactor: capped ? 50 : 100, bonusBps: Number(bonus),
                estPayoutBase: bonusPart * BigInt(10000 - c.protocolFeeBps) / 10000n,
                leavesDust,
            });
        }
    }
    return plans.sort((a, b) => (b.estPayoutBase > a.estPayoutBase ? 1 : b.estPayoutBase < a.estPayoutBase ? -1 : 0));
}

// --- 3. routes -----------------------------------------------------------------

export type Hop = { pair: string; tokenIn: string; feePpm: number; recipient: string; kind: 0 | 1 };
export type Route = { hops: Hop[]; label: string };

type PoolRow = { address: string; token0: string; token1: string; kind: string; fee: number | null; stable: number | null; factory: string; depth: number };

/**
 * Exit-route candidates from the arb pipeline's own pool DB. Only pools of
 * factories in the current (non-blacklisted) config, only curves HopEngine
 * prices correctly: V2-style constant product (stable pools excluded) with a
 * known fee, and V3 pools whose swap callback it implements.
 */
export class RouteFinder {
    private readonly db: Database.Database | null;
    private readonly factories: Map<string, ChainConfig['factories'][number]>;
    readonly hubs: string[];

    constructor(cfg: ChainConfig, dbFile: string, hubs: string[]) {
        this.db = fs.existsSync(dbFile) ? new Database(dbFile, { readonly: true, fileMustExist: true }) : null;
        this.factories = new Map(cfg.factories.map(f => [f.address.toLowerCase(), f]));
        this.hubs = [...new Set(hubs.map(h => h.toLowerCase()))];
    }

    get available(): boolean { return this.db != null; }

    close(): void { this.db?.close(); }

    /** Usable pools between a and b, deepest first. */
    pools(a: string, b: string, limit = 4): PoolRow[] {
        if (!this.db) return [];
        const [t0, t1] = a.toLowerCase() < b.toLowerCase() ? [a.toLowerCase(), b.toLowerCase()] : [b.toLowerCase(), a.toLowerCase()];
        const rows = this.db.prepare(`
            SELECT p.address, p.token0, p.token1, p.kind, p.fee, p.stable, p.factory,
                   COALESCE(CAST(r.reserves0 AS REAL) * CAST(r.reserves1 AS REAL), CAST(s.liquidity AS REAL), 0) AS depth
            FROM pairs p
            LEFT JOIN reserves r   ON r.pair = p.address
            LEFT JOIN pool_state s ON s.pool = p.address
            WHERE lower(p.token0) = ? AND lower(p.token1) = ?`).all(t0, t1) as PoolRow[];
        const usable = rows.filter(r => {
            const f = this.factories.get(r.factory.toLowerCase());
            if (!f) return false;                                   // unknown or blacklisted factory
            if (r.kind === 'v3') return f.group === 'v3' && (!f.callback || /^(uniswapV3SwapCallback|pancakeV3SwapCallback)$/.test(f.callback));
            if (r.stable === 1) return false;                       // stable curve: constant-product math would be wrong
            return this.feeOf(r) != null;
        });
        // V2 and V3 depth are not comparable units; interleave the best of each.
        const v2 = usable.filter(r => r.kind !== 'v3').sort((x, y) => y.depth - x.depth);
        const v3 = usable.filter(r => r.kind === 'v3').sort((x, y) => y.depth - x.depth);
        const out: PoolRow[] = [];
        for (let i = 0; out.length < limit && (i < v2.length || i < v3.length); i++) {
            if (v2[i]) out.push(v2[i]);
            if (v3[i] && out.length < limit) out.push(v3[i]);
        }
        return out;
    }

    private feeOf(r: PoolRow): number | null {
        if (r.fee != null) return r.fee;
        const f = this.factories.get(r.factory.toLowerCase());
        return f?.fee ?? null;
    }

    private hopFor(r: PoolRow, tokenIn: string): Hop {
        const fee = this.feeOf(r) ?? 0;
        return {
            pair: getAddress(r.address), tokenIn: getAddress(tokenIn),
            feePpm: Math.round(fee * 1e6), recipient: '', kind: r.kind === 'v3' ? 1 : 0,
        };
    }

    /** Route candidates from -> to, ending at `executor`. */
    routes(from: string, to: string, executor: string, maxRoutes = 10): Route[] {
        const out: Route[] = [];
        for (const p of this.pools(from, to)) out.push({ hops: [this.hopFor(p, from)], label: `direct ${p.kind} ${p.address.slice(0, 10)}` });
        for (const h of this.hubs) {
            if (h === from.toLowerCase() || h === to.toLowerCase()) continue;
            const first = this.pools(from, h, 2), second = this.pools(h, to, 2);
            for (const a of first) for (const b of second) {
                out.push({ hops: [this.hopFor(a, from), this.hopFor(b, h)], label: `via ${h.slice(0, 10)} (${a.kind}/${b.kind})` });
            }
        }
        for (const r of out) setRecipients(r.hops, executor);
        return out.slice(0, maxRoutes);
    }
}

/** Each hop pays the next V2 pair directly, else the executor (FlashArbExecutor's routing rule). */
export function setRecipients(hops: Hop[], executor: string): void {
    for (let i = 0; i < hops.length; i++) {
        const next = hops[i + 1];
        hops[i].recipient = next && next.kind === 0 ? next.pair : getAddress(executor);
    }
}

// --- 4-6. attempt --------------------------------------------------------------

export type LiquidationOptions = {
    /** Deployed LiquidationExecutor. */
    executor: string;
    /** Address to simulate from — must be the executor's owner. */
    owner: string;
    /** Broadcast clean simulations. Default false. */
    live?: boolean;
    signer?: Signer;
    /** Gas cost multiple the profit must clear. Default 3. */
    gasMarginMultiple?: number;
    /** Floor in USD regardless of gas. Default 1. */
    minProfitUsd?: number;
    /** Pair x route x amount simulations to try. Default 24. */
    maxSimulations?: number;
};

export type SimResult = { plan: PairPlan; route: Route; amount: bigint; profit: bigint | null; error?: string };

export type LiquidationAttempt = {
    user: string;
    pairs: PairPlan[];
    tried: SimResult[];
    best: SimResult | null;
    gasUnits?: bigint;
    gasCostDebt?: bigint;
    floorDebt?: bigint;
    profitUsd?: number;
    belowFloor?: boolean;
    simulated: boolean;
    broadcast: boolean;
    confirmed: boolean;
    txHash?: string;
    realisedProfit?: bigint;
    reason?: string;
};

/**
 * Aave V3.2+ custom errors a liquidation can hit (Errors.sol), so a refused
 * attempt says WHY. v3.0/3.1 revert with numeric strings ("45" = health
 * factor not below threshold), which come through as the plain reason.
 */
const AAVE_ERRORS = new Interface([
    'error HealthFactorNotBelowThreshold()',
    'error MustNotLeaveDust()',
    'error CollateralCannotBeLiquidated()',
    'error SpecifiedCurrencyNotBorrowedByUser()',
    'error ReservePaused()',
    'error ReserveInactive()',
    'error InvalidAmount()',
    'error FlashloanDisabled()',
    'error LiquidationGraceSentinelCheckFailed()',
    'error PriceOracleSentinelCheckFailed()',
]);

const errText = (e: unknown, iface: Interface): string => {
    const err = e as any;
    for (const d of [err?.data, err?.info?.error?.data, err?.error?.data, err?.revert?.data]) {
        if (typeof d === 'string' && d.length >= 10) {
            for (const i of [iface, AAVE_ERRORS]) {
                try { const p = i.parseError(d); if (p) return `${p.name}(${p.args.map(String).join(', ')})`; } catch { /* not this one */ }
            }
        }
    }
    return String(err?.shortMessage ?? err?.reason ?? err?.message ?? e).slice(0, 160);
};

export class Liquidator {
    readonly contract: Contract;
    private readonly iface: Interface;
    private readonly cfg: ChainConfig;
    private readonly provider: JsonRpcProvider;
    private readonly market: AaveMarket;
    private readonly routes: RouteFinder;
    private readonly opts: Required<Omit<LiquidationOptions, 'signer'>> & { signer?: Signer };

    constructor(cfg: ChainConfig, provider: JsonRpcProvider, market: AaveMarket, routes: RouteFinder, opts: LiquidationOptions) {
        this.cfg = cfg;
        this.provider = provider;
        this.market = market;
        this.routes = routes;
        if (opts.live && !opts.signer) throw new Error('live liquidation needs a signer (PRIVATE_KEY)');
        this.opts = { live: false, gasMarginMultiple: 3, minProfitUsd: 1, maxSimulations: 24, ...opts };
        this.contract = new Contract(opts.executor, LIQUIDATOR_ABI, provider);
        this.iface = this.contract.interface;
    }

    /** Flash lender for `debt`: the configured Balancer/Morpho source if set for it, else the Aave pool itself. */
    lenderFor(debt: string): { source: number; lender: string } {
        const t = flashTermsFor(this.cfg, debt);
        if (t && (t.provider === 'balancer-v2' || t.provider === 'morpho')) return { source: SOURCE[t.provider], lender: t.lender };
        return { source: SOURCE['aave-v3'], lender: getAddress(this.market.pool) };
    }

    private args(plan: PairPlan, route: Route, amount: bigint, minProfit: bigint, user: string) {
        const { source, lender } = this.lenderFor(plan.debt.asset);
        return [
            source, lender,
            [getAddress(this.market.pool), getAddress(user), getAddress(plan.collateral.asset), getAddress(plan.debt.asset), amount, minProfit],
            route.hops.map(h => [h.pair, h.tokenIn, h.feePpm, h.recipient, h.kind]),
        ] as const;
    }

    private async simulate(plan: PairPlan, route: Route, amount: bigint, user: string, minProfit = 0n): Promise<SimResult> {
        try {
            const profit = await this.contract.liquidate.staticCall(...this.args(plan, route, amount, minProfit, user), { from: this.opts.owner }) as bigint;
            return { plan, route, amount, profit };
        } catch (e) {
            return { plan, route, amount, profit: null, error: errText(e, this.iface) };
        }
    }

    /** Debt-asset units of one unit of the chain's native gas token, via the Aave oracle. Null if the wrapped native is not a reserve. */
    private nativeToDebt(wei: bigint, debt: Position, prices: Map<string, bigint>): bigint | null {
        const native = this.cfg.chain.token ? this.cfg.flashloan?.tokens.find(t => t.symbol === this.cfg.chain.token)?.address : undefined;
        const wrapped = native?.toLowerCase()
            ?? this.market.reserves.find(r => /^W?ETH$/i.test(r.symbol))?.asset;
        const p = wrapped ? prices.get(wrapped.toLowerCase()) : undefined;
        if (!p || debt.price === 0n) return null;
        return wei * p * 10n ** BigInt(debt.decimals) / (10n ** 18n * debt.price);
    }

    private async l1FeeWei(data: string): Promise<bigint> {
        if (!OP_STACK.has(Number(this.cfg.chain.id))) return 0n;
        const size = BigInt((data.length - 2) / 2 + 120);   // calldata + signed-tx envelope
        for (const [fn, args] of [['getL1FeeUpperBound', [size]], ['getL1Fee', [data]]] as const) {
            try {
                const r = await this.provider.call({ to: OP_GAS_ORACLE, data: OP_ORACLE_IFACE.encodeFunctionData(fn, args as any) });
                return OP_ORACLE_IFACE.decodeFunctionResult(fn, r)[0] as bigint;
            } catch { /* older oracle: try the next */ }
        }
        return 0n;
    }

    /**
     * Plan, simulate and (if live) execute a liquidation of `user`. Never
     * throws for an unexecutable account — the attempt carries the reason.
     */
    async attempt(user: string, hf: bigint, eMode: number): Promise<LiquidationAttempt> {
        const out: LiquidationAttempt = { user, pairs: [], tried: [], best: null, simulated: false, broadcast: false, confirmed: false };
        const prices = await readPrices(this.provider, this.market);
        const positions = await readPositions(this.provider, this.market, user, prices);
        const em = eMode ? this.market.eModeBonus.get(eMode) ?? 0 : 0;
        out.pairs = choosePairs(this.market, positions, hf, em).slice(0, 3);
        if (!out.pairs.length) { out.reason = 'no collateral/debt pair with a price'; return out; }

        // Candidates: best pairs first, each with its routes and amounts.
        const jobs: Array<[PairPlan, Route, bigint]> = [];
        for (const plan of out.pairs) {
            const same = plan.collateral.asset === plan.debt.asset;
            const routes = same ? [{ hops: [], label: 'same asset' }]
                : this.routes.routes(plan.collateral.asset, plan.debt.asset, this.opts.executor);
            for (const r of routes) for (const a of plan.amounts) jobs.push([plan, r, a]);
        }
        if (!jobs.length) {
            out.reason = this.routes.available ? 'no exit route between collateral and debt in the pool DB'
                : 'no pool DB (yarn scan) — only same-asset positions can be exited';
            return out;
        }
        const batch = jobs.slice(0, this.opts.maxSimulations);
        out.tried = await Promise.all(batch.map(([p, r, a]) => this.simulate(p, r, a, user)));
        out.best = out.tried.filter(t => t.profit != null).sort((a, b) => (b.profit! > a.profit! ? 1 : -1))[0] ?? null;
        if (!out.best) {
            out.reason = `every simulation reverted (${out.tried[0]?.error ?? '?'})`;
            return out;
        }

        // Gas floor, in the debt asset.
        const best = out.best;
        const args = this.args(best.plan, best.route, best.amount, 0n, user);
        try {
            out.gasUnits = await this.contract.liquidate.estimateGas(...args, { from: this.opts.owner });
        } catch (e) {
            out.reason = `estimateGas failed: ${errText(e, this.iface)}`;
            return out;
        }
        const fee = await this.provider.getFeeData();
        const gasPrice = fee.maxFeePerGas ?? fee.gasPrice ?? 0n;
        const data = this.iface.encodeFunctionData('liquidate', args as any);
        const gasWei = out.gasUnits * gasPrice + await this.l1FeeWei(data);
        const gasDebt = this.nativeToDebt(gasWei, best.plan.debt, prices);
        if (gasDebt == null) { out.reason = 'cannot price gas in the debt asset (no native-token price in the Aave oracle)'; return out; }
        out.gasCostDebt = gasDebt;
        const usdFloorDebt = unitsOf(BigInt(Math.round(this.opts.minProfitUsd * 1e6)) * this.market.baseUnit / 1_000_000n, best.plan.debt);
        const marginDebt = gasDebt * BigInt(Math.round(this.opts.gasMarginMultiple * 100)) / 100n;
        out.floorDebt = marginDebt > usdFloorDebt ? marginDebt : usdFloorDebt;
        out.profitUsd = Number(valueBase(best.profit!, best.plan.debt)) / Number(this.market.baseUnit);
        if (best.profit! < out.floorDebt) { out.belowFloor = true; return out; }

        // Simulate at the floor we would broadcast with.
        const atFloor = await this.simulate(best.plan, best.route, best.amount, user, out.floorDebt);
        if (atFloor.profit == null) { out.reason = `re-simulation at the floor reverted: ${atFloor.error}`; return out; }
        out.simulated = true;
        if (!this.opts.live) return out;

        const signed = this.contract.connect(this.opts.signer!) as Contract;
        const tx = await signed.liquidate(...this.args(best.plan, best.route, best.amount, out.floorDebt, user),
            { gasLimit: out.gasUnits * 13n / 10n });
        out.broadcast = true;
        out.txHash = tx.hash;
        const receipt = await tx.wait();
        if (!receipt || receipt.status !== 1) { out.reason = `broadcast but reverted on-chain (${tx.hash})`; return out; }
        out.confirmed = true;
        out.realisedProfit = this.record(best, tx.hash, receipt, prices);
        return out;
    }

    /** Ledger row from the LiquidationExecuted event — realised, not estimated. */
    private record(best: SimResult, txHash: string, receipt: any, prices: Map<string, bigint>): bigint {
        let profit = best.profit!;
        let realised = false;
        for (const log of receipt.logs) {
            if (log.address.toLowerCase() !== this.opts.executor.toLowerCase()) continue;
            try {
                const p = this.iface.parseLog({ topics: [...log.topics], data: log.data });
                if (p?.name === 'LiquidationExecuted') { profit = p.args.profit as bigint; realised = true; break; }
            } catch { /* not ours */ }
        }
        if (!realised) console.warn(`  [!] ${txHash}: no LiquidationExecuted event — ledger profit is the simulation, not realised`);
        const d = best.plan.debt;
        const price = prices.get(d.asset) ?? 0n;
        const ledger = new TradeLedger(ledgerPath());
        try {
            ledger.recordTrade({
                timestamp: Math.floor(Date.now() / 1000),
                chain: this.cfg.chain.label,
                type: 'liquidation',
                txHash,
                blockNumber: receipt.blockNumber,
                rootToken: d.asset,
                rootTokenSymbol: d.symbol,
                profitWei: profit,
                profitDecimals: d.decimals,
                profitUsd: price ? Number(profit * price / 10n ** BigInt(d.decimals)) / Number(this.market.baseUnit) : null,
                gasCostWei: BigInt(receipt.gasUsed ?? 0) * BigInt(receipt.gasPrice ?? 0),
            });
        } catch (e) {
            console.warn(`  [!] ${txHash}: ledger write failed — ${(e as Error).message}`);
        } finally {
            ledger.close();
        }
        return profit;
    }
}
