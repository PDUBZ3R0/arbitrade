// -----------------------------------------------------------------------------
// Aave V3 market reads for the liquidation watcher.
//
// Everything here is an eth_call through Multicall3 — free, no signer.
//
// WHY getUserConfiguration ALONGSIDE getUserAccountData
//
// getUserAccountData gives the health factor directly (we never reimplement
// Aave's collateral/threshold/eMode math). getUserConfiguration gives a bitmap
// of WHICH reserves the user borrows and uses as collateral:
//
//     bit 2*id     borrowing reserve `id`
//     bit 2*id+1   using reserve `id` as collateral
//
// (aave-v3-origin UserConfiguration.sol.) That bitmap is what lets a price
// move re-check only the accounts exposed to the moved asset, instead of the
// whole watchlist. Reading it live is exact; reconstructing exposure from
// Supply/Borrow events would miss aToken transfers and credit delegation.
//
// RESERVE ID IS NOT THE LIST POSITION
//
// getReservesList() skips dropped reserves, so position i in the list is not
// necessarily reserve id i. The id comes from getReserveData(asset).id — word
// 7 of ReserveData / ReserveDataLegacy, which is the same layout in v3.0
// through v3.4. We decode words directly rather than via a struct ABI so a
// trailing field added in a later revision cannot break the decode.
// -----------------------------------------------------------------------------

import { Interface, AbiCoder, getAddress, type JsonRpcProvider } from 'ethers';
import { multicall3, type Multicall3Call } from '../util/multicall.ts';
import { readBatched, type BatchOptions } from './batch.ts';
import type { Venue, VenueAccount, VenueEvent, ReadResult, ReadOptions } from './venue.ts';

// --- ABIs --------------------------------------------------------------------

export const POOL_IFACE = new Interface([
    'function ADDRESSES_PROVIDER() view returns (address)',
    'function getReservesList() view returns (address[])',
    'function getReserveData(address asset) view returns (uint256)',   // decoded by word, see header
    'function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)',
    'function getUserConfiguration(address user) view returns (uint256)',  // UserConfigurationMap { uint256 data } encodes identically
    'function getUserEMode(address user) view returns (uint256)',
    // Present in every v3 revision (v3.2+ keeps it as "Legacy" alongside getEModeCategoryCollateralConfig).
    'function getEModeCategoryData(uint8 id) view returns ((uint16 ltv, uint16 liquidationThreshold, uint16 liquidationBonus, address priceSource, string label))',
]);

const PROVIDER_IFACE = new Interface([
    'function getPriceOracle() view returns (address)',
    'function getPoolDataProvider() view returns (address)',
]);

const ORACLE_IFACE = new Interface([
    'function BASE_CURRENCY_UNIT() view returns (uint256)',
    'function getAssetsPrices(address[] assets) view returns (uint256[])',
]);

const ERC20_IFACE = new Interface([
    'function symbol() view returns (string)',
    'function decimals() view returns (uint8)',
]);

// --- events ------------------------------------------------------------------
//
// Verified against aave-v3-origin src/contracts/interfaces/IPool.sol.
// InterestRateMode is an enum, which is uint8 in the canonical signature.

export const POOL_EVENTS = new Interface([
    'event Supply(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint16 indexed referralCode)',
    'event Withdraw(address indexed reserve, address indexed user, address indexed to, uint256 amount)',
    'event Borrow(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint8 interestRateMode, uint256 borrowRate, uint16 indexed referralCode)',
    'event Repay(address indexed reserve, address indexed user, address indexed repayer, uint256 amount, bool useATokens)',
    'event LiquidationCall(address indexed collateralAsset, address indexed debtAsset, address indexed user, uint256 debtToCover, uint256 liquidatedCollateralAmount, address liquidator, bool receiveAToken)',
    'event ReserveUsedAsCollateralEnabled(address indexed reserve, address indexed user)',
    'event ReserveUsedAsCollateralDisabled(address indexed reserve, address indexed user)',
    'event UserEModeSet(address indexed user, uint8 categoryId)',
]);

const topicOf = (name: string): string => POOL_EVENTS.getEvent(name)!.topicHash.toLowerCase();

export const TOPIC = {
    Supply: topicOf('Supply'),
    Withdraw: topicOf('Withdraw'),
    Borrow: topicOf('Borrow'),
    Repay: topicOf('Repay'),
    LiquidationCall: topicOf('LiquidationCall'),
    CollateralEnabled: topicOf('ReserveUsedAsCollateralEnabled'),
    CollateralDisabled: topicOf('ReserveUsedAsCollateralDisabled'),
    UserEModeSet: topicOf('UserEModeSet'),
} as const;

/** Every topic the watcher subscribes to, for one getLogs / HyperSync filter. */
export const WATCH_TOPICS: string[] = Object.values(TOPIC);

/** Topic -> index of the topic slot holding the ACCOUNT whose position changed. */
const ACCOUNT_TOPIC_SLOT: Record<string, number> = {
    [TOPIC.Supply]: 2,               // onBehalfOf
    [TOPIC.Withdraw]: 2,             // user
    [TOPIC.Borrow]: 2,               // onBehalfOf — the debtor, not the caller (credit delegation)
    [TOPIC.Repay]: 2,                // user whose debt shrank
    [TOPIC.LiquidationCall]: 3,      // user
    [TOPIC.CollateralEnabled]: 2,
    [TOPIC.CollateralDisabled]: 2,
    [TOPIC.UserEModeSet]: 1,
};

export type RawLog = { address?: string; topics: readonly string[]; data: string; blockNumber: number };

export type PoolEvent = {
    /** Account whose position changed, lowercase. */
    account: string;
    /** Borrow is the only event that ADDS an account to the watchlist. */
    isBorrow: boolean;
    blockNumber: number;
};

/**
 * Pull the affected account out of a Pool log. Topic-only — none of these
 * events needs `data` to identify the account, so this cannot be broken by a
 * data-layout change. Returns null for logs that are not one of WATCH_TOPICS.
 */
export function decodePoolEvent(log: RawLog): PoolEvent | null {
    const t0 = String(log.topics[0] ?? '').toLowerCase();
    const slot = ACCOUNT_TOPIC_SLOT[t0];
    if (slot == null) return null;
    const word = log.topics[slot];
    if (!word || word.length !== 66) return null;
    return {
        account: ('0x' + word.slice(26)).toLowerCase(),
        isBorrow: t0 === TOPIC.Borrow,
        blockNumber: Number(log.blockNumber),
    };
}

// --- market ------------------------------------------------------------------

export type AaveReserve = {
    asset: string;       // lowercase
    id: number;
    symbol: string;
    decimals: number;
    /** Liquidation bonus as Aave stores it: 10500 = collateral seized at a 5% premium. */
    bonusBps: number;
    /** Share of the BONUS Aave keeps as a protocol fee, bps (1000 = 10% of the bonus). */
    protocolFeeBps: number;
};

export type AaveMarket = {
    pool: string;        // lowercase
    oracle: string;      // lowercase
    /** AaveProtocolDataProvider (per-reserve user balances), lowercase. Null if unresolved. */
    dataProvider: string | null;
    /** Base-currency unit of every *Base value and price (1e8 = USD with 8 decimals on Aave V3). */
    baseUnit: bigint;
    reserves: AaveReserve[];
    byAsset: Map<string, AaveReserve>;
    byId: Map<number, AaveReserve>;
    /**
     * eMode category -> liquidation bonus (bps, 10100 = 1%). Filled lazily by
     * loadEModeBonuses as accounts in new categories are seen. An account in
     * eMode is liquidated at its CATEGORY's bonus, not the reserve's — for
     * ETH-correlated loops that is ~1% instead of 5-7.5%.
     */
    eModeBonus: Map<number, number>;
};

const word = (hex: string, i: number): bigint => BigInt('0x' + hex.slice(2 + 64 * i, 2 + 64 * (i + 1)));

function decodeSymbol(data: string): string {
    try { return ERC20_IFACE.decodeFunctionResult('symbol', data)[0] as string; } catch { /* bytes32 symbol (MKR-style) */ }
    try {
        const raw = AbiCoder.defaultAbiCoder().decode(['bytes32'], data)[0] as string;
        return Buffer.from(raw.slice(2), 'hex').toString('utf8').replace(/\0+$/, '') || '?';
    } catch { return '?'; }
}

/**
 * Resolve the oracle and every listed reserve (id, symbol, decimals).
 * Startup work: three multicalls. Re-run if governance lists a reserve.
 */
export async function loadAaveMarket(provider: JsonRpcProvider, pool: string): Promise<AaveMarket> {
    const [ap, list] = await multicall3(provider, [
        { target: pool, allowFailure: true, callData: POOL_IFACE.encodeFunctionData('ADDRESSES_PROVIDER', []) },
        { target: pool, allowFailure: true, callData: POOL_IFACE.encodeFunctionData('getReservesList', []) },
    ]);
    if (!ap?.success || ap.returnData === '0x' || !list?.success || list.returnData === '0x') {
        throw new Error(`${pool} does not look like an Aave V3 Pool (ADDRESSES_PROVIDER / getReservesList failed). ` +
            `Pass the Pool proxy, not the PoolAddressesProvider or the data provider.`);
    }
    const addressesProvider = POOL_IFACE.decodeFunctionResult('ADDRESSES_PROVIDER', ap.returnData)[0] as string;
    const assets = (POOL_IFACE.decodeFunctionResult('getReservesList', list.returnData)[0] as string[]).map(a => a.toLowerCase());

    const [or, dp] = await multicall3(provider, [
        { target: addressesProvider, allowFailure: true, callData: PROVIDER_IFACE.encodeFunctionData('getPriceOracle', []) },
        { target: addressesProvider, allowFailure: true, callData: PROVIDER_IFACE.encodeFunctionData('getPoolDataProvider', []) },
    ]);
    if (!or?.success || or.returnData === '0x') throw new Error(`getPriceOracle() failed on addresses provider ${addressesProvider}`);
    const oracle = (PROVIDER_IFACE.decodeFunctionResult('getPriceOracle', or.returnData)[0] as string).toLowerCase();
    const dataProvider = dp?.success && dp.returnData !== '0x'
        ? (PROVIDER_IFACE.decodeFunctionResult('getPoolDataProvider', dp.returnData)[0] as string).toLowerCase() : null;

    const calls: Multicall3Call[] = [
        { target: oracle, allowFailure: true, callData: ORACLE_IFACE.encodeFunctionData('BASE_CURRENCY_UNIT', []) },
    ];
    for (const a of assets) {
        calls.push({ target: pool, allowFailure: true, callData: POOL_IFACE.encodeFunctionData('getReserveData', [a]) });
        calls.push({ target: a, allowFailure: true, callData: ERC20_IFACE.encodeFunctionData('symbol', []) });
        calls.push({ target: a, allowFailure: true, callData: ERC20_IFACE.encodeFunctionData('decimals', []) });
    }
    const res = await multicall3(provider, calls);
    const baseUnit = res[0]?.success && res[0].returnData !== '0x'
        ? (ORACLE_IFACE.decodeFunctionResult('BASE_CURRENCY_UNIT', res[0].returnData)[0] as bigint)
        : 10n ** 8n;

    const reserves: AaveReserve[] = [];
    assets.forEach((asset, i) => {
        const rd = res[1 + 3 * i], sy = res[2 + 3 * i], de = res[3 + 3 * i];
        if (!rd?.success || rd.returnData.length < 2 + 64 * 8) {
            throw new Error(`getReserveData(${asset}) failed — cannot map reserve ids, refusing to guess`);
        }
        const id = Number(word(rd.returnData, 7));
        // ReserveConfigurationMap (word 0) bits 32-47: liquidation bonus.
        const bonusBps = Number((word(rd.returnData, 0) >> 32n) & 0xffffn);
        // Bits 152-167: liquidation protocol fee, a share of the bonus (ReserveConfiguration.sol).
        const protocolFeeBps = Number((word(rd.returnData, 0) >> 152n) & 0xffffn);
        const decimals = de?.success && de.returnData !== '0x'
            ? Number(ERC20_IFACE.decodeFunctionResult('decimals', de.returnData)[0]) : 18;
        reserves.push({ asset, id, symbol: sy?.success ? decodeSymbol(sy.returnData) : '?', decimals, bonusBps, protocolFeeBps });
    });

    return {
        pool: pool.toLowerCase(), oracle, dataProvider, baseUnit, reserves,
        byAsset: new Map(reserves.map(r => [r.asset, r])),
        byId: new Map(reserves.map(r => [r.id, r])),
        eModeBonus: new Map(),
    };
}

/** Fetch the liquidation bonus of eMode categories not yet in market.eModeBonus. */
export async function loadEModeBonuses(provider: JsonRpcProvider, market: AaveMarket, ids: Iterable<number>): Promise<void> {
    const want = [...new Set(ids)].filter(id => id > 0 && id < 256 && !market.eModeBonus.has(id));
    if (!want.length) return;
    const res = await multicall3(provider, want.map(id => ({
        target: market.pool, allowFailure: true, callData: POOL_IFACE.encodeFunctionData('getEModeCategoryData', [id]),
    })));
    want.forEach((id, i) => {
        let bonus = 0;
        try {
            if (res[i]?.success && res[i].returnData !== '0x') {
                bonus = Number((POOL_IFACE.decodeFunctionResult('getEModeCategoryData', res[i].returnData)[0] as any).liquidationBonus);
            }
        } catch { /* leave 0: caller falls back to reserve bonuses */ }
        market.eModeBonus.set(id, bonus);
    });
}

/** All reserve prices in one call, keyed by asset (lowercase). Base-currency units. */
export async function readPrices(provider: JsonRpcProvider, market: AaveMarket, blockTag?: number): Promise<Map<string, bigint>> {
    const assets = market.reserves.map(r => getAddress(r.asset));
    const [r] = await multicall3(provider, [{
        target: market.oracle, allowFailure: false,
        callData: ORACLE_IFACE.encodeFunctionData('getAssetsPrices', [assets]),
    }], blockTag);
    const prices = ORACLE_IFACE.decodeFunctionResult('getAssetsPrices', r.returnData)[0] as bigint[];
    return new Map(market.reserves.map((res, i) => [res.asset, prices[i]]));
}

// --- accounts ----------------------------------------------------------------

export type AccountData = {
    user: string;
    collateralBase: bigint;
    debtBase: bigint;
    /** Weighted average liquidation threshold, bps. */
    liqThresholdBps: number;
    /** WAD. type(uint256).max when the account has no debt. */
    hf: bigint;
    /** UserConfigurationMap.data — exposure bitmap, see header. */
    config: bigint;
    /** eMode category, 0 = none. */
    eMode: number;
};

/** Bits of the user configuration touched by reserve `id` (borrowing | collateral). */
export const exposureBits = (id: number): bigint => 3n << BigInt(id * 2);

/** Assets the account borrows and uses as collateral, from its config bitmap. */
export function positionAssets(market: AaveMarket, config: bigint): { collateral: AaveReserve[]; debt: AaveReserve[] } {
    const collateral: AaveReserve[] = [], debt: AaveReserve[] = [];
    for (const r of market.reserves) {
        const b = BigInt(r.id * 2);
        if ((config >> b) & 1n) debt.push(r);
        if ((config >> (b + 1n)) & 1n) collateral.push(r);
    }
    return { collateral, debt };
}

/**
 * getUserAccountData + getUserConfiguration + getUserEMode for `users`, through
 * the shared batch reader (gas-cap bisection, pruned-state unpinning, retries —
 * see liquidation/batch.ts).
 */
export { STATE_RE } from './batch.ts';

export async function readAccounts(
    provider: JsonRpcProvider,
    pool: string,
    users: string[],
    opts: BatchOptions = {},
): Promise<{ accounts: AccountData[]; failed: number; calls: number; batchSize: number; errors: string[]; unpinned: boolean }> {
    const r = await readBatched<string, AccountData>(provider, users,
        u => [
            { target: pool, allowFailure: true, callData: POOL_IFACE.encodeFunctionData('getUserAccountData', [u]) },
            { target: pool, allowFailure: true, callData: POOL_IFACE.encodeFunctionData('getUserConfiguration', [u]) },
            { target: pool, allowFailure: true, callData: POOL_IFACE.encodeFunctionData('getUserEMode', [u]) },
        ],
        (user, [a, c, m]) => {
            if (!a?.success || a.returnData === '0x' || !c?.success || c.returnData === '0x') return null;
            const d = POOL_IFACE.decodeFunctionResult('getUserAccountData', a.returnData);
            return {
                user: user.toLowerCase(),
                collateralBase: d[0] as bigint,
                debtBase: d[1] as bigint,
                liqThresholdBps: Number(d[3]),
                hf: d[5] as bigint,
                config: POOL_IFACE.decodeFunctionResult('getUserConfiguration', c.returnData)[0] as bigint,
                // getUserEMode failing (a fork without eMode) is not an account failure.
                eMode: m?.success && m.returnData !== '0x' ? Number(POOL_IFACE.decodeFunctionResult('getUserEMode', m.returnData)[0]) : 0,
            };
        },
        opts, 'account');
    return { accounts: r.out, failed: r.failed, calls: r.calls, batchSize: r.batchSize, errors: r.errors, unpinned: r.unpinned };
}

// --- the Venue -----------------------------------------------------------------

const CLOSE_FACTOR_HF = 95n * 10n ** 16n;

/** Aave V3 as a liquidation Venue (see venue.ts). Account = borrower address. */
export class AaveVenue implements Venue {
    readonly kind = 'aave-v3' as const;
    readonly label: string;
    readonly key: string;
    readonly baseUnit: bigint;
    readonly eventAddresses: string[];
    readonly eventTopics = WATCH_TOPICS;
    readonly market: AaveMarket;
    private readonly provider: JsonRpcProvider;

    constructor(provider: JsonRpcProvider, market: AaveMarket, label = 'Aave V3') {
        this.provider = provider;
        this.market = market;
        this.label = label;
        this.key = market.pool;
        this.baseUnit = market.baseUnit;
        this.eventAddresses = [market.pool];
    }

    static async load(provider: JsonRpcProvider, pool: string, label?: string): Promise<AaveVenue> {
        return new AaveVenue(provider, await loadAaveMarket(provider, pool), label);
    }

    async init(): Promise<void> { /* the market is loaded by load() */ }

    decodeEvent(log: RawLog): VenueEvent | null { return decodePoolEvent(log); }

    readPrices(blockTag?: number): Promise<Map<string, bigint>> { return readPrices(this.provider, this.market, blockTag); }

    priceMask(asset: string): bigint {
        const r = this.market.byAsset.get(asset.toLowerCase());
        return r ? exposureBits(r.id) : 0n;
    }

    async readAccounts(accounts: string[], opts: ReadOptions = {}): Promise<ReadResult> {
        const r = await readAccounts(this.provider, this.market.pool, accounts, opts);
        // Bonuses of eMode categories seen for the first time (one call, rarely).
        try { await loadEModeBonuses(this.provider, this.market, r.accounts.map(a => a.eMode)); }
        catch { /* estimates fall back to reserve bonuses */ }
        return r;
    }

    /**
     * Estimated most that ONE liquidation call on `a` could pay, in base
     * units, before gas / swap / flash-loan costs. Null if never read.
     *
     *   bonus      the account's eMode category bonus when it is in eMode
     *              (ETH-correlated loops: ~1%), else the highest reserve bonus
     *              among its collateral assets
     *   close      Aave v3.3+: a liquidator may repay 100% of the debt when
     *   factor     HF < 0.95 or the position is under $2,000 (collateral or
     *              debt), otherwise 50%. Evaluated at liquidation time, when
     *              HF has just crossed 1, so a big near-tier position gets 50%.
     *
     *   payout = min(collateral, debt x closeFactor x bonus) x (bonus - 1) / bonus
     *
     * Aave applies the close-factor test per reserve, not to totals, and the
     * liquidator picks one collateral/debt pair per call, so this stays an
     * upper bound for a single call — the right side to err on for a filter.
     */
    maxProfitBase(a: Pick<VenueAccount, 'debtBase' | 'collateralBase' | 'config' | 'eMode'> & { hf: bigint | null }): bigint | null {
        if (a.debtBase == null || a.collateralBase == null) return null;
        let bonus = 0n;
        const em = a.eMode ? this.market.eModeBonus.get(a.eMode) : undefined;
        if (em && em > 10000) bonus = BigInt(em);
        else {
            for (const r of this.market.reserves) {
                if ((a.config >> BigInt(r.id * 2 + 1)) & 1n) {
                    const b = BigInt(r.bonusBps || 10500);
                    if (b > bonus) bonus = b;
                }
            }
        }
        if (bonus <= 10000n) bonus = 10500n;   // no collateral flagged / unset: assume 5%
        const small = 2000n * this.market.baseUnit;
        const fullClose = (a.hf != null && a.hf < CLOSE_FACTOR_HF) || a.debtBase < small || a.collateralBase < small;
        const repayable = fullClose ? a.debtBase : a.debtBase / 2n;
        const byDebt = repayable * bonus / 10000n;
        const seizable = a.collateralBase < byDebt ? a.collateralBase : byDebt;
        return seizable * (bonus - 10000n) / bonus;
    }

    describe(a: Pick<VenueAccount, 'config'>): string {
        const p = positionAssets(this.market, a.config);
        return `${p.collateral.map(r => r.symbol).join('+') || '—'} → ${p.debt.map(r => r.symbol).join('+') || '—'}`;
    }
}
