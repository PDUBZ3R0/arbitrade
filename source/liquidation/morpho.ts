// -----------------------------------------------------------------------------
// Morpho Blue as a liquidation Venue.
//
// One singleton per chain holds every market. A market is
//   MarketParams { loanToken, collateralToken, oracle, irm, lltv }
// identified by Id = keccak256(abi.encode(params)). An ACCOUNT here is a
// (borrower, market) pair, keyed `${borrower}:${marketId}` — a borrower in two
// markets is two independent positions with independent health.
//
// HEALTH — exactly Morpho's _isHealthy (src/Morpho.sol), with interest accrued
// to the read block the way _accrueInterest would:
//
//   borrowed  = borrowShares.toAssetsUp(totalBorrowAssets + interest, totalBorrowShares)
//   maxBorrow = collateral x oracle.price() / 1e36 x lltv / 1e18
//   HF        = maxBorrow / borrowed            (liquidatable when < 1)
//
//   interest  = totalBorrowAssets x wTaylorCompounded(irm.borrowRateView(), elapsed)
//
// LIQUIDATION has no close factor and no flash loan: liquidate() sends the
// seized collateral FIRST, calls onMorphoLiquidate(repaidAssets, data) on the
// liquidator, THEN pulls the repayment. LiquidationExecutor swaps the
// collateral to the loan token inside that callback. The incentive is
//
//   LIF = min(1.15, 1 / (1 - 0.3 x (1 - lltv)))      (ConstantsLib)
//
// e.g. lltv 86% -> LIF 1.0438 (4.4%), 94.5% -> 1.0168, 77% -> 1.074.
// There is no protocol fee on liquidation.
//
// Addresses and deploy blocks: @morpho-org/morpho-ts addresses.ts.
// -----------------------------------------------------------------------------

import { Interface, AbiCoder, keccak256, getAddress, type JsonRpcProvider } from 'ethers';
import { multicall3 } from '../util/multicall.ts';
import { readBatched } from './batch.ts';
import type { UsdOracle } from './usd.ts';
import {
    accountKey, splitAccount, topicAddr,
    type Venue, type VenueAccount, type VenueEvent, type ReadResult, type ReadOptions, type RawLog,
} from './venue.ts';

/** Morpho Blue singletons, from @morpho-org/morpho-ts (chain id -> address, deploy block). */
export const MORPHO_BLUE: Record<number, { address: string; deployBlock: number }> = {
    1:     { address: '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb', deployBlock: 18883124 },
    8453:  { address: '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb', deployBlock: 13977148 },
    42161: { address: '0x6c247b1F6182318877311737BaC0844bAa518F5e', deployBlock: 296446593 },
    10:    { address: '0xce95AfbB8EA029495c66020883F87aaE8864AF92', deployBlock: 130770075 },
};

export const MORPHO_IFACE = new Interface([
    'function position(bytes32 id, address user) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)',
    'function market(bytes32 id) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)',
    'function idToMarketParams(bytes32 id) view returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)',
    'function liquidate((address loanToken, address collateralToken, address oracle, address irm, uint256 lltv) marketParams, address borrower, uint256 seizedAssets, uint256 repaidShares, bytes data) returns (uint256, uint256)',
    'event Borrow(bytes32 indexed id, address caller, address indexed onBehalf, address indexed receiver, uint256 assets, uint256 shares)',
    'event Repay(bytes32 indexed id, address indexed caller, address indexed onBehalf, uint256 assets, uint256 shares)',
    'event SupplyCollateral(bytes32 indexed id, address indexed caller, address indexed onBehalf, uint256 assets)',
    'event WithdrawCollateral(bytes32 indexed id, address caller, address indexed onBehalf, address indexed receiver, uint256 assets)',
    'event Liquidate(bytes32 indexed id, address indexed caller, address indexed borrower, uint256 repaidAssets, uint256 repaidShares, uint256 seizedAssets, uint256 badDebtAssets, uint256 badDebtShares)',
]);
const IRM_IFACE = new Interface([
    'function borrowRateView((address loanToken, address collateralToken, address oracle, address irm, uint256 lltv) marketParams, (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee) market) view returns (uint256)',
]);
const ORACLE_IFACE = new Interface(['function price() view returns (uint256)']);

const T = (name: string) => MORPHO_IFACE.getEvent(name)!.topicHash.toLowerCase();
export const MORPHO_TOPIC = {
    Borrow: T('Borrow'), Repay: T('Repay'), SupplyCollateral: T('SupplyCollateral'),
    WithdrawCollateral: T('WithdrawCollateral'), Liquidate: T('Liquidate'),
};
/** topic0 -> topic slot holding the borrower. */
const BORROWER_SLOT: Record<string, number> = {
    [MORPHO_TOPIC.Borrow]: 2,              // onBehalf
    [MORPHO_TOPIC.Repay]: 3,               // onBehalf
    [MORPHO_TOPIC.SupplyCollateral]: 3,    // onBehalf
    [MORPHO_TOPIC.WithdrawCollateral]: 2,  // onBehalf
    [MORPHO_TOPIC.Liquidate]: 3,           // borrower
};

export const WAD = 10n ** 18n;
const MAX_UINT = (1n << 256n) - 1n;
const ORACLE_PRICE_SCALE = 10n ** 36n;
const VIRTUAL_SHARES = 10n ** 6n, VIRTUAL_ASSETS = 1n;
const MAX_LIF = 115n * 10n ** 16n, CURSOR = 3n * 10n ** 17n;

const mulDivUp = (x: bigint, y: bigint, d: bigint) => (x * y + d - 1n) / d;
export const toAssetsUp = (shares: bigint, totalAssets: bigint, totalShares: bigint) =>
    mulDivUp(shares, totalAssets + VIRTUAL_ASSETS, totalShares + VIRTUAL_SHARES);
export const toAssetsDown = (shares: bigint, totalAssets: bigint, totalShares: bigint) =>
    shares * (totalAssets + VIRTUAL_ASSETS) / (totalShares + VIRTUAL_SHARES);
/** Morpho's liquidation incentive factor for a market (WAD). */
export const lifOf = (lltv: bigint): bigint => {
    const v = WAD * WAD / (WAD - CURSOR * (WAD - lltv) / WAD);
    return v < MAX_LIF ? v : MAX_LIF;
};
const wTaylor = (x: bigint, n: bigint) => {
    const first = x * n, second = first * first / (2n * WAD), third = second * first / (3n * WAD);
    return first + second + third;
};

export type MorphoParams = { loanToken: string; collateralToken: string; oracle: string; irm: string; lltv: bigint };
export type MorphoMarket = {
    id: string;
    index: number;
    params: MorphoParams;
    lif: bigint;
    loanSymbol: string;
    collSymbol: string;
    loanDecimals: number;
    collDecimals: number;
};
export type MarketState = { totalBorrowAssets: bigint; totalBorrowShares: bigint; price: bigint };

export const marketId = (p: MorphoParams): string => keccak256(AbiCoder.defaultAbiCoder().encode(
    ['address', 'address', 'address', 'address', 'uint256'], [p.loanToken, p.collateralToken, p.oracle, p.irm, p.lltv])).toLowerCase();

export class MorphoVenue implements Venue {
    readonly kind = 'morpho-blue' as const;
    readonly label = 'Morpho Blue';
    readonly key: string;
    readonly baseUnit: bigint;
    readonly eventAddresses: string[];
    readonly eventTopics = Object.values(MORPHO_TOPIC);
    readonly deployBlock?: number;
    readonly morpho: string;
    readonly markets = new Map<string, MorphoMarket>();
    /** Latest per-market state from a read (for the planner). */
    readonly state = new Map<string, MarketState>();
    private readonly provider: JsonRpcProvider;
    readonly usd: UsdOracle;

    constructor(provider: JsonRpcProvider, morpho: string, usd: UsdOracle, deployBlock?: number) {
        this.provider = provider;
        this.morpho = morpho.toLowerCase();
        this.key = this.morpho;
        this.usd = usd;
        this.baseUnit = usd.unit;
        this.eventAddresses = [this.morpho];
        this.deployBlock = deployBlock;
    }

    async init(): Promise<void> { /* markets load lazily, as positions in them are seen */ }

    decodeEvent(log: RawLog): VenueEvent | null {
        const t0 = String(log.topics[0] ?? '').toLowerCase();
        const slot = BORROWER_SLOT[t0];
        if (slot == null) return null;
        const id = String(log.topics[1] ?? '').toLowerCase(), user = topicAddr(log.topics[slot]);
        if (id.length !== 66 || !user) return null;
        return { account: accountKey(user, id), isBorrow: t0 === MORPHO_TOPIC.Borrow, blockNumber: Number(log.blockNumber) };
    }

    /** Load params + token metadata for market ids not seen yet. */
    async loadMarkets(ids: string[]): Promise<void> {
        const want = [...new Set(ids.map(i => i.toLowerCase()))].filter(i => !this.markets.has(i));
        if (!want.length) return;
        const res = await multicall3(this.provider, want.map(id => ({
            target: this.morpho, allowFailure: true, callData: MORPHO_IFACE.encodeFunctionData('idToMarketParams', [id]),
        })));
        const loaded: MorphoMarket[] = [];
        want.forEach((id, i) => {
            if (!res[i]?.success || res[i].returnData === '0x') return;
            const d = MORPHO_IFACE.decodeFunctionResult('idToMarketParams', res[i].returnData);
            const params: MorphoParams = { loanToken: (d[0] as string).toLowerCase(), collateralToken: (d[1] as string).toLowerCase(), oracle: (d[2] as string).toLowerCase(), irm: (d[3] as string).toLowerCase(), lltv: d[4] as bigint };
            if (params.loanToken === '0x0000000000000000000000000000000000000000') return;   // not a market
            loaded.push({ id, index: this.markets.size + loaded.length, params, lif: lifOf(params.lltv), loanSymbol: '?', collSymbol: '?', loanDecimals: 18, collDecimals: 18 });
        });
        await this.usd.tokenMeta(loaded.flatMap(m => [m.params.loanToken, m.params.collateralToken]));
        for (const m of loaded) {
            m.loanSymbol = this.usd.symbol(m.params.loanToken); m.loanDecimals = this.usd.decimals(m.params.loanToken);
            m.collSymbol = this.usd.symbol(m.params.collateralToken); m.collDecimals = this.usd.decimals(m.params.collateralToken);
            this.markets.set(m.id, m);
        }
    }

    /** Oracle price of every market with tracked positions (key = market id). */
    async readPrices(blockTag?: number): Promise<Map<string, bigint>> {
        const ms = [...this.markets.values()];
        const out = new Map<string, bigint>();
        if (!ms.length) return out;
        const r = await readBatched(this.provider, ms,
            m => [{ target: m.params.oracle, allowFailure: true, callData: ORACLE_IFACE.encodeFunctionData('price', []) }],
            (m, [p]) => p?.success && p.returnData !== '0x' ? [m.id, ORACLE_IFACE.decodeFunctionResult('price', p.returnData)[0] as bigint] as const : null,
            { blockTag, batchSize: 100 }, 'oracle');
        for (const [id, p] of r.out) out.set(id, p);
        await this.usd.refresh(ms.map(m => m.params.loanToken));
        return out;
    }

    priceMask(id: string): bigint {
        const m = this.markets.get(id);
        return m ? 1n << BigInt(m.index) : 0n;
    }

    /** Totals with interest accrued to `blockTag`, and the oracle price, per market. */
    async readMarketState(ids: string[], blockTag?: number): Promise<Map<string, MarketState>> {
        const ms = ids.map(id => this.markets.get(id)).filter((m): m is MorphoMarket => !!m);
        const block = await this.provider.getBlock(blockTag ?? 'latest');
        const now = BigInt(block?.timestamp ?? Math.floor(Date.now() / 1000));
        const tuple = (p: MorphoParams) => [p.loanToken, p.collateralToken, p.oracle, p.irm, p.lltv];
        // Round 1: totals + price.
        const r1 = await readBatched(this.provider, ms,
            m => [
                { target: this.morpho, allowFailure: true, callData: MORPHO_IFACE.encodeFunctionData('market', [m.id]) },
                { target: m.params.oracle, allowFailure: true, callData: ORACLE_IFACE.encodeFunctionData('price', []) },
            ],
            (m, [a, p]) => {
                if (!a?.success || !p?.success || p.returnData === '0x') return null;
                return { m, mk: MORPHO_IFACE.decodeFunctionResult('market', a.returnData), price: ORACLE_IFACE.decodeFunctionResult('price', p.returnData)[0] as bigint };
            },
            { blockTag, batchSize: 50 }, 'market');
        // Round 2: borrow rate, to accrue interest since lastUpdate (Morpho's own _accrueInterest).
        const withIrm = r1.out.filter(x => x.m.params.irm !== '0x0000000000000000000000000000000000000000');
        const r2 = await readBatched(this.provider, withIrm,
            x => [{ target: x.m.params.irm, allowFailure: true, callData: IRM_IFACE.encodeFunctionData('borrowRateView', [tuple(x.m.params), [...x.mk]]) }],
            (x, [r]) => r?.success && r.returnData !== '0x' ? [x.m.id, IRM_IFACE.decodeFunctionResult('borrowRateView', r.returnData)[0] as bigint] as const : null,
            { blockTag, batchSize: 50 }, 'irm');
        const rate = new Map(r2.out);
        const out = new Map<string, MarketState>();
        for (const { m, mk, price } of r1.out) {
            let tba = mk[2] as bigint;
            const elapsed = now - (mk[4] as bigint);
            const br = rate.get(m.id);
            if (br != null && elapsed > 0n) tba += tba * wTaylor(br, elapsed) / WAD;
            const st = { totalBorrowAssets: tba, totalBorrowShares: mk[3] as bigint, price };
            out.set(m.id, st);
            this.state.set(m.id, st);
        }
        return out;
    }

    async readAccounts(accounts: string[], opts: ReadOptions = {}): Promise<ReadResult> {
        const parts = accounts.map(a => ({ key: a.toLowerCase(), ...splitAccount(a.toLowerCase()) }));
        await this.loadMarkets(parts.map(p => p.market));
        const state = await this.readMarketState([...new Set(parts.map(p => p.market))], opts.blockTag);
        await this.usd.refresh([...this.markets.values()].map(m => m.params.loanToken));
        const known = parts.filter(p => state.has(p.market));
        const r = await readBatched(this.provider, known,
            p => [{ target: this.morpho, allowFailure: true, callData: MORPHO_IFACE.encodeFunctionData('position', [p.market, p.user]) }],
            (p, [x]) => {
                if (!x?.success || x.returnData === '0x') return null;
                const d = MORPHO_IFACE.decodeFunctionResult('position', x.returnData);
                return this.account(p.key, this.markets.get(p.market)!, state.get(p.market)!, d[1] as bigint, d[2] as bigint);
            },
            opts, 'account');
        return { accounts: r.out, failed: r.failed + (parts.length - known.length), calls: r.calls, batchSize: r.batchSize, errors: r.errors, unpinned: r.unpinned };
    }

    /** One position's health, Morpho's math. */
    account(key: string, m: MorphoMarket, st: MarketState, borrowShares: bigint, collateral: bigint): VenueAccount {
        const borrowed = toAssetsUp(borrowShares, st.totalBorrowAssets, st.totalBorrowShares);
        const collInLoan = collateral * st.price / ORACLE_PRICE_SCALE;
        const maxBorrow = collInLoan * m.params.lltv / WAD;
        const hf = borrowShares === 0n ? MAX_UINT : borrowed === 0n ? MAX_UINT : maxBorrow * WAD / borrowed;
        return {
            user: key,
            debtBase: borrowShares === 0n ? 0n : this.usd.value(m.params.loanToken, borrowed),
            collateralBase: this.usd.value(m.params.loanToken, collInLoan),
            liqThresholdBps: Number(m.params.lltv / 10n ** 14n),
            hf, config: 1n << BigInt(m.index), eMode: 0,
        };
    }

    /**
     * Most one liquidation can pay: no close factor, so the whole position;
     * seized = min(collateral, debt x LIF); payout = seized x (LIF - 1) / LIF.
     */
    maxProfitBase(a: Pick<VenueAccount, 'debtBase' | 'collateralBase'> & { user?: string }): bigint | null {
        if (a.debtBase == null || a.collateralBase == null || !a.user) return null;
        const m = this.markets.get(splitAccount(a.user).market);
        if (!m) return null;
        const byDebt = a.debtBase * m.lif / WAD;
        const seized = a.collateralBase < byDebt ? a.collateralBase : byDebt;
        return seized * (m.lif - WAD) / m.lif;
    }

    describe(a: Pick<VenueAccount, 'user'>): string {
        const m = this.markets.get(splitAccount(a.user).market);
        return m ? `${m.collSymbol} → ${m.loanSymbol} (lltv ${(Number(m.params.lltv) / 1e16).toFixed(1)}%)` : '?';
    }

    paramsTuple(m: MorphoMarket) {
        const p = m.params;
        return [getAddress(p.loanToken), getAddress(p.collateralToken), getAddress(p.oracle), getAddress(p.irm), p.lltv] as const;
    }
}
