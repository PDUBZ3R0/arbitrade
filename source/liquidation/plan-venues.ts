// -----------------------------------------------------------------------------
// Liquidation planners for Morpho Blue and Compound III — the same contract as
// the Aave planner in plan.ts: propose a few (amount, route) candidates, let
// the chain price each one with an eth_call of LiquidationExecutor (which
// RETURNS realised profit), take the best, require it to clear
// max(minProfitUsd, gas x margin), re-simulate at that floor, and only then —
// with live=true — send it. Realised profit comes from the event.
//
// MORPHO  liquidateMorpho(job, marketParams, hops). No flash loan: Morpho hands
//         over the collateral first and calls back. Two amounts are tried:
//           full repay   repaidShares = the borrower's borrowShares, when the
//                        collateral covers debt x LIF
//           max seize    seizedAssets = collateral (or what debt x LIF buys,
//                        whichever is smaller), 0.05% shy so Morpho's round-up
//                        of the repaid shares cannot exceed the position
// COMET   liquidateComet(source, lender, job, baseAmount, hops): flash-borrow
//         base from the cheapest lender (LenderBook), absorb, buy the asset at
//         the store-front discount, swap back. Also usable with no borrower to
//         buy collateral already sitting in reserves.
// -----------------------------------------------------------------------------

import { Contract, Interface, getAddress, type JsonRpcProvider, type Signer } from 'ethers';
import { multicall3 } from '../util/multicall.ts';
import { TradeLedger } from '../util/ledger.ts';
import { ledgerPath, type ChainConfig } from '../util/config.ts';
import { LIQUIDATOR_ABI, type RouteFinder, type Route, type LiquidationAttempt, type SimResult, type PairPlan } from './plan.ts';
import { MORPHO_IFACE, toAssetsUp, WAD, type MorphoVenue } from './morpho.ts';
import { COMET_IFACE, type CompoundVenue, type CometInfo, type CometAsset } from './compound.ts';
import type { LenderBook } from './lenders.ts';
import type { UsdOracle } from './usd.ts';
import { splitAccount } from './venue.ts';

export const VENUE_LIQUIDATOR_ABI = [
    ...LIQUIDATOR_ABI,
    'function liquidateMorpho((address morpho, address borrower, uint256 seizedAssets, uint256 repaidShares, uint256 minProfit) j, (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv) mp, (address pair, address tokenIn, uint32 feePpm, address recipient, uint8 kind)[] hops) returns (uint256 profit)',
    'function liquidateComet(uint8 source, address lender, (address comet, address borrower, address asset, uint256 minProfit) j, uint256 baseAmount, (address pair, address tokenIn, uint32 feePpm, address recipient, uint8 kind)[] hops) returns (uint256 profit)',
    'error EmptyHops()',
    'error SwapOverpaid(uint256 owed, uint256 maxIn)',
];

/** Morpho / Comet errors worth naming in a refusal (Morpho reverts with strings). */
const COMET_ERRORS = new Interface([
    'error NotLiquidatable()', 'error NotForSale()', 'error InsufficientReserves()', 'error TooMuchSlippage()', 'error Paused()', 'error BadPrice()',
]);
const errText = (e: unknown, iface: Interface): string => {
    const err = e as any;
    for (const d of [err?.data, err?.info?.error?.data, err?.error?.data, err?.revert?.data]) {
        if (typeof d === 'string' && d.length >= 10) {
            for (const i of [iface, COMET_ERRORS]) {
                try { const p = i.parseError(d); if (p) return `${p.name}(${p.args.map(String).join(', ')})`; } catch { /* next */ }
            }
        }
    }
    return String(err?.reason ?? err?.shortMessage ?? err?.message ?? e).slice(0, 160);
};

const OP_GAS_ORACLE = '0x420000000000000000000000000000000000000F';
const OP_ORACLE_IFACE = new Interface(['function getL1FeeUpperBound(uint256) view returns (uint256)']);
const OP_STACK = new Set([10, 8453, 34443, 57073, 7777777, 1868, 130, 252, 5000]);
/** Wrapped native token per chain id, for pricing gas. */
const WRAPPED_NATIVE: Record<number, string> = {
    10: '0x4200000000000000000000000000000000000006',
    8453: '0x4200000000000000000000000000000000000006',
    42161: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    1: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
};

type Token = { asset: string; symbol: string; decimals: number };
type Candidate = { route: Route; send: (minProfit: bigint) => readonly unknown[]; method: 'liquidateMorpho' | 'liquidateComet'; amount: bigint };

export type VenuePlannerOptions = {
    executor: string;
    owner: string;
    live?: boolean;
    signer?: Signer;
    gasMarginMultiple?: number;
    minProfitUsd?: number;
    maxSimulations?: number;
};

export class VenueLiquidator {
    readonly contract: Contract;
    private readonly iface: Interface;
    private readonly cfg: ChainConfig;
    private readonly provider: JsonRpcProvider;
    private readonly routes: RouteFinder;
    private readonly lenders: LenderBook;
    private readonly usd: UsdOracle;
    private readonly opts: Required<Omit<VenuePlannerOptions, 'signer'>> & { signer?: Signer };

    constructor(cfg: ChainConfig, provider: JsonRpcProvider, routes: RouteFinder, lenders: LenderBook, usd: UsdOracle, opts: VenuePlannerOptions) {
        this.cfg = cfg;
        this.provider = provider;
        this.routes = routes;
        this.lenders = lenders;
        this.usd = usd;
        if (opts.live && !opts.signer) throw new Error('live liquidation needs a signer (PRIVATE_KEY)');
        this.opts = { live: false, gasMarginMultiple: 3, minProfitUsd: 1, maxSimulations: 24, ...opts };
        this.contract = new Contract(opts.executor, VENUE_LIQUIDATOR_ABI, provider);
        this.iface = this.contract.interface;
    }

    private exits(from: string, to: string): Route[] {
        return from.toLowerCase() === to.toLowerCase() ? [{ hops: [], label: 'same asset' }] : this.routes.routes(from, to, this.opts.executor);
    }

    private async l1FeeWei(data: string): Promise<bigint> {
        if (!OP_STACK.has(Number(this.cfg.chain.id))) return 0n;
        try {
            const r = await this.provider.call({ to: OP_GAS_ORACLE, data: OP_ORACLE_IFACE.encodeFunctionData('getL1FeeUpperBound', [BigInt((data.length - 2) / 2 + 120)]) });
            return OP_ORACLE_IFACE.decodeFunctionResult('getL1FeeUpperBound', r)[0] as bigint;
        } catch { return 0n; }
    }

    private wrappedNative(): string | null {
        const t = this.cfg.chain.token;
        if (t && /^0x[0-9a-fA-F]{40}$/.test(t)) return t.toLowerCase();
        return WRAPPED_NATIVE[Number(this.cfg.chain.id)]?.toLowerCase() ?? null;
    }

    /**
     * Simulate candidates, pick the best, apply the gas floor (in `token`
     * units, priced through UsdOracle), re-simulate at the floor and send if
     * live. `out` is filled in place.
     */
    private async run(out: LiquidationAttempt, plan: PairPlan, token: Token, cands: Candidate[]): Promise<LiquidationAttempt> {
        if (!cands.length) {
            out.reason = this.routes.available ? 'no exit route between collateral and debt in the pool DB'
                : 'no pool DB (yarn scan) — only same-asset positions can be exited';
            return out;
        }
        const sim = async (c: Candidate, minProfit: bigint): Promise<SimResult> => {
            try {
                const profit = await (this.contract as any)[c.method].staticCall(...c.send(minProfit), { from: this.opts.owner }) as bigint;
                return { plan, route: c.route, amount: c.amount, profit };
            } catch (e) {
                return { plan, route: c.route, amount: c.amount, profit: null, error: errText(e, this.iface) };
            }
        };
        const batch = cands.slice(0, this.opts.maxSimulations);
        out.tried = await Promise.all(batch.map(c => sim(c, 0n)));
        const okIdx = out.tried.map((t, i) => [t, i] as const).filter(([t]) => t.profit != null).sort((a, b) => (b[0].profit! > a[0].profit! ? 1 : -1));
        if (!okIdx.length) { out.reason = `every simulation reverted (${out.tried[0]?.error ?? '?'})`; return out; }
        const [best, bi] = okIdx[0];
        const cand = batch[bi];
        out.best = best;

        try { out.gasUnits = await (this.contract as any)[cand.method].estimateGas(...cand.send(0n), { from: this.opts.owner }); }
        catch (e) { out.reason = `estimateGas failed: ${errText(e, this.iface)}`; return out; }
        const fee = await this.provider.getFeeData();
        const data = this.iface.encodeFunctionData(cand.method, cand.send(0n) as any);
        const gasWei = out.gasUnits! * (fee.maxFeePerGas ?? fee.gasPrice ?? 0n) + await this.l1FeeWei(data);
        const native = this.wrappedNative();
        await this.usd.refresh([token.asset, ...(native ? [native] : [])]);
        const gasUsd = native ? this.usd.value(native, gasWei) : null;
        const gasTok = gasUsd != null ? this.usd.units(token.asset, gasUsd) : null;
        const floorUsdTok = this.usd.units(token.asset, BigInt(Math.round(this.opts.minProfitUsd * 1e6)) * this.usd.unit / 1_000_000n);
        if (gasTok == null || floorUsdTok == null) { out.reason = `cannot price gas in ${token.symbol} (no USD price for it or for the native token)`; return out; }
        out.gasCostDebt = gasTok;
        const margin = gasTok * BigInt(Math.round(this.opts.gasMarginMultiple * 100)) / 100n;
        out.floorDebt = margin > floorUsdTok ? margin : floorUsdTok;
        const pu = this.usd.value(token.asset, best.profit!);
        out.profitUsd = pu == null ? undefined : Number(pu) / Number(this.usd.unit);
        if (best.profit! < out.floorDebt) { out.belowFloor = true; return out; }

        const atFloor = await sim(cand, out.floorDebt);
        if (atFloor.profit == null) { out.reason = `re-simulation at the floor reverted: ${atFloor.error}`; return out; }
        out.simulated = true;
        if (!this.opts.live) return out;

        const signed = this.contract.connect(this.opts.signer!) as any;
        const tx = await signed[cand.method](...cand.send(out.floorDebt), { gasLimit: out.gasUnits! * 13n / 10n });
        out.broadcast = true;
        out.txHash = tx.hash;
        const receipt = await tx.wait();
        if (!receipt || receipt.status !== 1) { out.reason = `broadcast but reverted on-chain (${tx.hash})`; return out; }
        out.confirmed = true;
        out.realisedProfit = this.record(best.profit!, token, tx.hash, receipt);
        return out;
    }

    private record(simulated: bigint, token: Token, txHash: string, receipt: any): bigint {
        let profit = simulated, realised = false;
        for (const log of receipt.logs) {
            if (log.address.toLowerCase() !== this.opts.executor.toLowerCase()) continue;
            try {
                const p = this.iface.parseLog({ topics: [...log.topics], data: log.data });
                if (p?.name === 'LiquidationExecuted') { profit = p.args.profit as bigint; realised = true; break; }
            } catch { /* not ours */ }
        }
        if (!realised) console.warn(`  [!] ${txHash}: no LiquidationExecuted event — ledger profit is the simulation, not realised`);
        const usd = this.usd.value(token.asset, profit);
        const ledger = new TradeLedger(ledgerPath());
        try {
            ledger.recordTrade({
                timestamp: Math.floor(Date.now() / 1000), chain: this.cfg.chain.label, type: 'liquidation', txHash,
                blockNumber: receipt.blockNumber, rootToken: token.asset, rootTokenSymbol: token.symbol,
                profitWei: profit, profitDecimals: token.decimals, profitUsd: usd == null ? null : Number(usd) / Number(this.usd.unit),
                gasCostWei: BigInt(receipt.gasUsed ?? 0) * BigInt(receipt.gasPrice ?? 0),
            });
        } catch (e) {
            console.warn(`  [!] ${txHash}: ledger write failed — ${(e as Error).message}`);
        } finally { ledger.close(); }
        return profit;
    }

    /** A PairPlan-shaped summary so liq-watch's printer works for every venue. */
    private plan(coll: Token, debt: Token, closeFactor: 50 | 100 = 100): PairPlan {
        return { collateral: coll, debt, amounts: [], closeFactor, bonusBps: 0, estPayoutBase: 0n, leavesDust: false } as unknown as PairPlan;
    }

    // --- Morpho Blue -------------------------------------------------------------

    async attemptMorpho(venue: MorphoVenue, key: string): Promise<LiquidationAttempt> {
        const out: LiquidationAttempt = { user: key, pairs: [], tried: [], best: null, simulated: false, broadcast: false, confirmed: false };
        const { user, market } = splitAccount(key);
        await venue.loadMarkets([market]);
        const m = venue.markets.get(market);
        if (!m) { out.reason = 'unknown Morpho market'; return out; }
        const st = (await venue.readMarketState([market])).get(market);
        const [pos] = await multicall3(this.provider, [{ target: venue.morpho, allowFailure: true, callData: MORPHO_IFACE.encodeFunctionData('position', [market, user]) }]);
        if (!st || !pos?.success) { out.reason = 'could not read the position'; return out; }
        const d = MORPHO_IFACE.decodeFunctionResult('position', pos.returnData);
        const borrowShares = d[1] as bigint, collateral = d[2] as bigint;
        if (borrowShares === 0n) { out.reason = 'no debt'; return out; }
        const borrowed = toAssetsUp(borrowShares, st.totalBorrowAssets, st.totalBorrowShares);
        const coll: Token = { asset: m.params.collateralToken, symbol: m.collSymbol, decimals: m.collDecimals };
        const loan: Token = { asset: m.params.loanToken, symbol: m.loanSymbol, decimals: m.loanDecimals };
        const plan = this.plan(coll, loan);
        out.pairs = [plan];

        const scale = 10n ** 36n;
        const seizeForDebt = st.price === 0n ? 0n : borrowed * m.lif / WAD * scale / st.price;
        const jobs: Array<{ seized: bigint; shares: bigint; amount: bigint }> = [];
        if (collateral >= seizeForDebt * 10010n / 10000n) jobs.push({ seized: 0n, shares: borrowShares, amount: borrowed });
        const maxSeize = (collateral < seizeForDebt ? collateral : seizeForDebt) * 9995n / 10000n;
        if (maxSeize > 0n) jobs.push({ seized: maxSeize, shares: 0n, amount: maxSeize });

        const mp = venue.paramsTuple(m);
        const cands: Candidate[] = [];
        for (const route of this.exits(coll.asset, loan.asset)) for (const j of jobs) {
            cands.push({
                route, method: 'liquidateMorpho', amount: j.amount,
                send: (minProfit: bigint) => [[getAddress(venue.morpho), getAddress(user), j.seized, j.shares, minProfit], mp, route.hops.map(h => [h.pair, h.tokenIn, h.feePpm, h.recipient, h.kind])] as const,
            });
        }
        return this.run(out, plan, loan, cands);
    }

    // --- Compound III ------------------------------------------------------------

    /**
     * Absorb `key`'s account (if a borrower is given) and buy its biggest
     * collateral asset; or, with `onlyAsset` and no borrower, buy that asset
     * out of the Comet's reserves.
     */
    async attemptComet(venue: CompoundVenue, key: string, onlyAsset?: string): Promise<LiquidationAttempt> {
        const out: LiquidationAttempt = { user: key, pairs: [], tried: [], best: null, simulated: false, broadcast: false, confirmed: false };
        const { user, market: comet } = splitAccount(key);
        await venue.init();
        const c = venue.comets.get(comet);
        if (!c) { out.reason = 'unknown Comet'; return out; }
        const borrower = user && user !== 'reserves' ? user : null;
        const assets = onlyAsset ? c.assets.filter(a => a.asset === onlyAsset.toLowerCase()) : c.assets;
        // What each asset would leave in reserves for us: the account's balance (once absorbed) + what is already there.
        const calls = assets.flatMap(a => [
            ...(borrower ? [{ target: comet, allowFailure: true, callData: COMET_IFACE.encodeFunctionData('userCollateral', [borrower, a.asset]) }] : []),
            { target: comet, allowFailure: true, callData: COMET_IFACE.encodeFunctionData('getCollateralReserves', [a.asset]) },
            { target: comet, allowFailure: true, callData: COMET_IFACE.encodeFunctionData('quoteCollateral', [a.asset, 10n ** BigInt(c.baseDecimals)]) },
        ]);
        const res = await multicall3(this.provider, calls);
        const per = borrower ? 3 : 2;
        const options: Array<{ a: CometAsset; avail: bigint; baseFor: bigint }> = [];
        assets.forEach((a, i) => {
            const r = res.slice(i * per, i * per + per);
            if (!r.every(x => x?.success)) return;
            const bal = borrower ? COMET_IFACE.decodeFunctionResult('userCollateral', r[0].returnData)[0] as bigint : 0n;
            const reserve = COMET_IFACE.decodeFunctionResult('getCollateralReserves', r[per - 2].returnData)[0] as bigint;
            const perUnitBase = COMET_IFACE.decodeFunctionResult('quoteCollateral', r[per - 1].returnData)[0] as bigint;   // asset per 1 base
            const avail = bal + reserve;
            if (avail === 0n || perUnitBase === 0n) return;
            options.push({ a, avail, baseFor: avail * 10n ** BigInt(c.baseDecimals) / perUnitBase });
        });
        if (!options.length) { out.reason = borrower ? 'no collateral to buy' : 'nothing in reserves'; return out; }
        options.sort((x, y) => (y.baseFor > x.baseFor ? 1 : -1));
        const base: Token = { asset: c.base, symbol: c.baseSymbol, decimals: c.baseDecimals };

        const cands: Candidate[] = [];
        for (const o of options.slice(0, 2)) {
            const coll: Token = { asset: o.a.asset, symbol: o.a.symbol, decimals: this.usd.decimals(o.a.asset) };
            const plan = this.plan(coll, base);
            out.pairs.push(plan);
            // +2% headroom: the contract spends only what reserves can fill and returns the rest.
            const amount = o.baseFor + o.baseFor / 50n + 1n;
            const lender = await this.lenders.pick(c.base, amount);
            if (!lender) continue;
            for (const route of this.exits(o.a.asset, c.base)) {
                cands.push({
                    route, method: 'liquidateComet', amount,
                    send: (minProfit: bigint) => [lender.source, lender.lender, [getAddress(comet), borrower ? getAddress(borrower) : '0x0000000000000000000000000000000000000000', getAddress(o.a.asset), minProfit], amount,
                        route.hops.map(h => [h.pair, h.tokenIn, h.feePpm, h.recipient, h.kind])] as const,
                });
            }
        }
        if (!out.pairs.length) { out.reason = 'no lender for the base asset'; return out; }
        return this.run(out, out.pairs[0], base, cands);
    }

    /** Assets with collateral in reserves while buys are open, per Comet — standing opportunities with no borrower. */
    async buyableReserves(venue: CompoundVenue): Promise<Array<{ comet: CometInfo; asset: CometAsset; reserve: bigint }>> {
        await venue.init();
        const cs = [...venue.comets.values()];
        const calls = cs.flatMap(c => [
            { target: c.comet, allowFailure: true, callData: COMET_IFACE.encodeFunctionData('getReserves', []) },
            ...c.assets.map(a => ({ target: c.comet, allowFailure: true, callData: COMET_IFACE.encodeFunctionData('getCollateralReserves', [a.asset]) })),
        ]);
        const res = await multicall3(this.provider, calls);
        const out: Array<{ comet: CometInfo; asset: CometAsset; reserve: bigint }> = [];
        let k = 0;
        for (const c of cs) {
            const r = res[k++];
            const reserves = r?.success ? COMET_IFACE.decodeFunctionResult('getReserves', r.returnData)[0] as bigint : null;
            const open = reserves != null && (reserves < 0n || reserves < c.targetReserves);
            for (const a of c.assets) {
                const x = res[k++];
                if (!open || !x?.success) continue;
                const v = COMET_IFACE.decodeFunctionResult('getCollateralReserves', x.returnData)[0] as bigint;
                if (v > 0n) out.push({ comet: c, asset: a, reserve: v });
            }
        }
        return out;
    }
}
