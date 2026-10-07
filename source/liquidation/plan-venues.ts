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
import { CTOKEN_IFACE, COMPTROLLER_IFACE, type CompoundV2Venue } from './compound-v2.ts';
import { EVAULT_IFACE, type EulerVenue } from './euler.ts';
import { type FluidScanner, type FluidOpportunity } from './fluid.ts';
import { getAddress as checksum } from 'ethers';
import type { LenderBook } from './lenders.ts';
import type { UsdOracle } from './usd.ts';
import { splitAccount } from './venue.ts';

export const VENUE_LIQUIDATOR_ABI = [
    ...LIQUIDATOR_ABI,
    'function liquidateMorpho((address morpho, address borrower, uint256 seizedAssets, uint256 repaidShares, uint256 minProfit) j, (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv) mp, (address pair, address tokenIn, uint32 feePpm, address recipient, uint8 kind)[] hops) returns (uint256 profit)',
    'function liquidateComet(uint8 source, address lender, (address comet, address borrower, address asset, uint256 minProfit) j, uint256 baseAmount, (address pair, address tokenIn, uint32 feePpm, address recipient, uint8 kind)[] hops) returns (uint256 profit)',
    'function liquidateCompoundV2(uint8 source, address lender, (address cTokenBorrowed, address cTokenCollateral, address collateral, address repayUnderlying, address borrower, uint256 repayAmount, uint256 minProfit) j, (address pair, address tokenIn, uint32 feePpm, address recipient, uint8 kind)[] hops) returns (uint256 profit)',
    'function liquidateEuler((address evc, address liability, address collateralVault, address collateral, address repayUnderlying, address violator, uint256 repayAssets, uint256 minProfit) j, (address pair, address tokenIn, uint32 feePpm, address recipient, uint8 kind)[] hops) returns (uint256 profit)',
    'function liquidateFluid(uint8 source, address lender, (address vault, address collateral, address repayUnderlying, uint256 debtAmt, uint256 colPerUnitDebt, bool absorb, uint256 minProfit) j, (address pair, address tokenIn, uint32 feePpm, address recipient, uint8 kind)[] hops) returns (uint256 profit)',
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
type Candidate = { route: Route; send: (minProfit: bigint) => readonly unknown[]; method: 'liquidateMorpho' | 'liquidateComet' | 'liquidateCompoundV2' | 'liquidateEuler' | 'liquidateFluid'; amount: bigint };

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

    // --- Compound V2 forks -------------------------------------------------------

    async attemptCompoundV2(venue: CompoundV2Venue, key: string): Promise<LiquidationAttempt> {
        const out: LiquidationAttempt = { user: key, pairs: [], tried: [], best: null, simulated: false, broadcast: false, confirmed: false };
        const { user, market: comptroller } = splitAccount(key);
        await venue.init();
        const comp = venue.comptrollers.get(comptroller);
        if (!comp) { out.reason = 'unknown comptroller'; return out; }
        await venue.readPrices();
        // Which markets the account is in, then a snapshot of each.
        const [ai] = await multicall3(this.provider, [{ target: comptroller, allowFailure: true, callData: COMPTROLLER_IFACE.encodeFunctionData('getAssetsIn', [user]) }]);
        if (!ai?.success) { out.reason = 'could not read assetsIn'; return out; }
        const cTokens = (COMPTROLLER_IFACE.decodeFunctionResult('getAssetsIn', ai.returnData)[0] as string[]).map(a => a.toLowerCase()).filter(a => comp.markets.has(a));
        const snaps = await multicall3(this.provider, cTokens.map(c => ({ target: c, allowFailure: true, callData: CTOKEN_IFACE.encodeFunctionData('getAccountSnapshot', [user]) })));
        type M = { cToken: string; underlying: string; symbol: string; dec: number; price: bigint; coll: bigint; collUsd: bigint; borrowBal: bigint; borrowUsd: bigint; cf: bigint };
        const ms: M[] = [];
        cTokens.forEach((cToken, i) => {
            if (!snaps[i]?.success) return;
            const mk = comp.markets.get(cToken)!;
            if (!mk.underlying) return;                                   // native leg: can't route the redeem
            const d = CTOKEN_IFACE.decodeFunctionResult('getAccountSnapshot', snaps[i].returnData);
            const price = venue.prices.get(`${comptroller}:${cToken}`) ?? 0n;
            const underlying = (d[1] as bigint) * (d[3] as bigint) / WAD;
            ms.push({ cToken, underlying: mk.underlying, symbol: mk.symbol, dec: mk.underlyingDecimals, price,
                coll: underlying, collUsd: underlying * price / WAD, borrowBal: d[2] as bigint, borrowUsd: (d[2] as bigint) * price / WAD, cf: mk.collateralFactor });
        });
        const borrow = ms.filter(m => m.borrowBal > 0n).sort((a, b) => (b.borrowUsd > a.borrowUsd ? 1 : -1))[0];
        const colls = ms.filter(m => m.coll > 0n && m.cf > 0n).sort((a, b) => (b.collUsd > a.collUsd ? 1 : -1)).slice(0, 2);
        if (!borrow || !colls.length) { out.reason = borrow ? 'no ERC20 collateral to seize' : 'no ERC20 debt to repay'; return out; }

        const debtTok: Token = { asset: borrow.underlying, symbol: borrow.symbol.replace(/^[a-z]+/, ''), decimals: borrow.dec };
        const cands: Candidate[] = [];
        for (const c of colls) {
            const collTok: Token = { asset: c.underlying, symbol: c.symbol.replace(/^[a-z]+/, ''), decimals: c.dec };
            out.pairs.push(this.plan(collTok, debtTok, Number(comp.closeFactor / 10n ** 16n) as 50 | 100));
            // repay capped by close factor AND by what the collateral can cover at the incentive, 0.1% shy.
            const repayCF = borrow.borrowBal * comp.closeFactor / WAD;
            const repayByColl = borrow.price === 0n ? 0n : (c.collUsd * WAD / comp.incentive) * WAD / borrow.price;
            const repay = (repayCF < repayByColl ? repayCF : repayByColl) * 999n / 1000n;
            if (repay === 0n) continue;
            const lender = await this.lenders.pick(borrow.underlying, repay);
            if (!lender) continue;
            for (const route of this.exits(c.underlying, borrow.underlying)) {
                cands.push({
                    route, method: 'liquidateCompoundV2', amount: repay,
                    send: (minProfit: bigint) => [lender.source, lender.lender,
                        [checksum(borrow.cToken), checksum(c.cToken), checksum(c.underlying), checksum(borrow.underlying), checksum(user), repay, minProfit],
                        route.hops.map(h => [h.pair, h.tokenIn, h.feePpm, h.recipient, h.kind])] as const,
                });
            }
        }
        if (!cands.length) { out.reason = 'no lender or no exit route'; return out; }
        return this.run(out, out.pairs[0], debtTok, cands);
    }

    // --- Euler V2 ----------------------------------------------------------------

    async attemptEuler(venue: EulerVenue, key: string): Promise<LiquidationAttempt> {
        const out: LiquidationAttempt = { user: key, pairs: [], tried: [], best: null, simulated: false, broadcast: false, confirmed: false };
        const { user: account, market: liability } = splitAccount(key);
        await venue.init();
        const vt = venue.vaults.get(liability);
        if (!vt) { out.reason = 'unknown Euler vault'; return out; }
        const repayTok: Token = { asset: vt.asset, symbol: vt.symbol, decimals: vt.assetDecimals };
        const collateralVaults = (await venue.collateralsOf(account)).filter(c => venue.vaults.has(c));
        if (!collateralVaults.length) { out.reason = 'no collateral vaults enabled'; return out; }
        // checkLiquidation per collateral: (maxRepay in liability assets, maxYield in collateral shares).
        const res = await multicall3(this.provider, collateralVaults.map(c => ({
            target: liability, allowFailure: true, callData: EVAULT_IFACE.encodeFunctionData('checkLiquidation', [getAddress(this.opts.executor), getAddress(account), getAddress(c)]),
        })));
        const opts = collateralVaults.map((c, i) => {
            if (!res[i]?.success || res[i].returnData === '0x') return null;
            const d = EVAULT_IFACE.decodeFunctionResult('checkLiquidation', res[i].returnData);
            return { cv: c, maxRepay: d[0] as bigint, maxYield: d[1] as bigint };
        }).filter((x): x is { cv: string; maxRepay: bigint; maxYield: bigint } => !!x && x.maxRepay > 0n && x.maxYield > 0n)
          .sort((a, b) => (b.maxRepay > a.maxRepay ? 1 : -1)).slice(0, 2);
        if (!opts.length) { out.reason = 'checkLiquidation offered nothing (already healthy, or no yield)'; return out; }

        const cands: Candidate[] = [];
        for (const o of opts) {
            const cvt = venue.vaults.get(o.cv)!;
            const collTok: Token = { asset: cvt.asset, symbol: cvt.symbol, decimals: cvt.assetDecimals };
            out.pairs.push(this.plan(collTok, repayTok));
            const repay = o.maxRepay;
            for (const route of this.exits(cvt.asset, vt.asset)) {
                cands.push({
                    route, method: 'liquidateEuler', amount: repay,
                    send: (minProfit: bigint) => [[getAddress(venue.evc), getAddress(liability), getAddress(o.cv), getAddress(cvt.asset), getAddress(vt.asset), getAddress(account), repay, minProfit],
                        route.hops.map(h => [h.pair, h.tokenIn, h.feePpm, h.recipient, h.kind])] as const,
                });
            }
        }
        if (!cands.length) { out.reason = 'no exit route between collateral and debt'; return out; }
        return this.run(out, out.pairs[0], repayTok, cands);
    }

    // --- Fluid -------------------------------------------------------------------

    /** Liquidate one Fluid vault opportunity (from FluidScanner). No borrower — a vault-level tick liquidation. */
    async attemptFluid(scanner: FluidScanner, o: FluidOpportunity): Promise<LiquidationAttempt> {
        const key = `${o.vault}:${o.collateral}`;
        const out: LiquidationAttempt = { user: key, pairs: [], tried: [], best: null, simulated: false, broadcast: false, confirmed: false };
        const debtTok: Token = { asset: o.debt, symbol: this.usd.symbol(o.debt), decimals: this.usd.decimals(o.debt) };
        const collTok: Token = { asset: o.collateral, symbol: this.usd.symbol(o.collateral), decimals: this.usd.decimals(o.collateral) };
        out.pairs.push(this.plan(collTok, debtTok));
        const lender = await this.lenders.pick(o.debt, o.inAmt);
        if (!lender) { out.reason = 'no lender for the debt asset'; return out; }
        const colPerUnitDebt = scanner.colPerUnitDebt(o);
        const cands: Candidate[] = [];
        for (const route of this.exits(o.collateral, o.debt)) {
            cands.push({
                route, method: 'liquidateFluid', amount: o.inAmt,
                send: (minProfit: bigint) => [lender.source, lender.lender,
                    [getAddress(o.vault), getAddress(o.collateral), getAddress(o.debt), o.inAmt, colPerUnitDebt, o.withAbsorb, minProfit],
                    route.hops.map(h => [h.pair, h.tokenIn, h.feePpm, h.recipient, h.kind])] as const,
            });
        }
        if (!cands.length) { out.reason = 'no exit route between collateral and debt'; return out; }
        return this.run(out, out.pairs[0], debtTok, cands);
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
