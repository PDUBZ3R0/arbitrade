// -----------------------------------------------------------------------------
// Compound III (Comet) as a liquidation Venue.
//
// Each Comet is one market: a single BASE asset that is lent and borrowed
// (USDC, WETH, USDT, …) and several collateral assets. This venue covers every
// Comet on the chain; an ACCOUNT is `${borrower}:${comet}`.
//
// HEALTH — Comet's isLiquidatable (CometWithExtendedAssetList.sol), with debt
// from borrowBalanceOf (interest accrued to now, as absorb() accrues before it
// checks):
//
//   debtValue = borrowBalance x basePrice / baseScale
//   liqValue  = sum_i  collateral_i x price_i / scale_i x liquidateCollateralFactor_i / 1e18
//   HF        = liqValue / debtValue           (absorbable when < 1)
//
// Prices are the Comet's own feeds (8 decimals) in the Comet's numeraire — USD
// for USDC markets, ETH for the WETH market — converted to USD via UsdOracle
// only for reports / dust.
//
// LIQUIDATION is two protocol steps, done in one transaction by
// LiquidationExecutor.liquidateComet:
//   absorb(account)   — permissionless; the protocol takes ALL the account's
//                       collateral into reserves and forgives its debt. Pays the
//                       caller nothing (only "liquidator points").
//   buyCollateral()   — anyone buys reserve collateral for base at a discount
//                       storeFrontPriceFactor x (1 - liquidationFactor_i), while
//                       the Comet's base reserves are below targetReserves.
// The PROFIT is that discount, after swapping the bought collateral back to
// base. Collateral sitting in reserves (absorbed by someone else, not yet
// bought) can be bought with no account at all.
//
// Addresses: compound-finance/comet deployments/<network>/<market>/roots.json.
// -----------------------------------------------------------------------------

import { Interface, type JsonRpcProvider } from 'ethers';
import { multicall3 } from '../util/multicall.ts';
import { readBatched } from './batch.ts';
import type { UsdOracle } from './usd.ts';
import {
    accountKey, splitAccount, topicAddr,
    type Venue, type VenueAccount, type VenueEvent, type ReadResult, type ReadOptions, type RawLog,
} from './venue.ts';

/** Comets per chain (compound-finance/comet deployments, roots.json). */
export const COMETS: Record<number, Record<string, string>> = {
    8453: {
        usdc: '0xb125E6687d4313864e53df431d5425969c15Eb2F',
        usdbc: '0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf',
        weth: '0x46e6b214b524310239732D51387075E0e70970bf',
        aero: '0x784efeB622244d2348d4F2522f8860B96fbEcE89',
        usds: '0x2c776041CCFe903071AF44aa147368a9c8EEA518',
    },
    42161: {
        usdc: '0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf',
        'usdc.e': '0xA5EDBDD9646f8dFF606d7448e414884C7d905dCA',
        usdt: '0xd98Be00b5D27fc98112BdE293e487f8D4cA57d07',
        weth: '0x6f7D514bbD4aFf3BcD1140B7344b32f063dEe486',
    },
    10: {
        usdc: '0x2e44e174f7D53F0212823acC11C01A11d58c5bCB',
        usdt: '0x995E394b8B2437aC8Ce61Ee0bC610D617962B214',
        weth: '0xE36A30D249f7761327fd973001A32010b521b6Fd',
    },
};

export const COMET_IFACE = new Interface([
    'function baseToken() view returns (address)',
    'function baseTokenPriceFeed() view returns (address)',
    'function baseScale() view returns (uint256)',
    'function numAssets() view returns (uint8)',
    'function storeFrontPriceFactor() view returns (uint256)',
    'function targetReserves() view returns (uint256)',
    'function getReserves() view returns (int256)',
    'function getAssetInfo(uint8 i) view returns ((uint8 offset, address asset, address priceFeed, uint64 scale, uint64 borrowCollateralFactor, uint64 liquidateCollateralFactor, uint64 liquidationFactor, uint128 supplyCap))',
    'function getPrice(address priceFeed) view returns (uint256)',
    'function getCollateralReserves(address asset) view returns (uint256)',
    'function quoteCollateral(address asset, uint256 baseAmount) view returns (uint256)',
    'function userBasic(address account) view returns (int104 principal, uint64 baseTrackingIndex, uint64 baseTrackingAccrued, uint16 assetsIn, uint8 _reserved)',
    'function userCollateral(address account, address asset) view returns (uint128 balance, uint128 _reserved)',
    'function borrowBalanceOf(address account) view returns (uint256)',
    'function isLiquidatable(address account) view returns (bool)',
    'function absorb(address absorber, address[] accounts)',
    'function buyCollateral(address asset, uint256 minAmount, uint256 baseAmount, address recipient)',
    'event Withdraw(address indexed src, address indexed to, uint256 amount)',
    'event Supply(address indexed from, address indexed dst, uint256 amount)',
    'event Transfer(address indexed from, address indexed to, uint256 amount)',
    'event SupplyCollateral(address indexed from, address indexed dst, address indexed asset, uint256 amount)',
    'event WithdrawCollateral(address indexed src, address indexed to, address indexed asset, uint256 amount)',
    'event TransferCollateral(address indexed from, address indexed to, address indexed asset, uint256 amount)',
    'event AbsorbDebt(address indexed absorber, address indexed borrower, uint256 basePaidOut, uint256 usdValue)',
]);
const T = (n: string) => COMET_IFACE.getEvent(n)!.topicHash.toLowerCase();
export const COMET_TOPIC = {
    Withdraw: T('Withdraw'), Supply: T('Supply'), Transfer: T('Transfer'), SupplyCollateral: T('SupplyCollateral'),
    WithdrawCollateral: T('WithdrawCollateral'), TransferCollateral: T('TransferCollateral'), AbsorbDebt: T('AbsorbDebt'),
};
/** topic0 -> [slot of the account, does this event possibly CREATE a borrow]. */
const SLOT: Record<string, [number, boolean]> = {
    [COMET_TOPIC.Withdraw]: [1, true],            // src: withdrawing base past zero is borrowing
    [COMET_TOPIC.Transfer]: [1, true],            // from: transferring base past zero is borrowing too
    [COMET_TOPIC.Supply]: [2, false],             // dst: repays
    [COMET_TOPIC.SupplyCollateral]: [2, false],   // dst
    [COMET_TOPIC.WithdrawCollateral]: [1, false], // src
    [COMET_TOPIC.TransferCollateral]: [1, false], // from (the side that loses collateral)
    [COMET_TOPIC.AbsorbDebt]: [2, false],         // borrower
};

export const WAD = 10n ** 18n;
const MAX_UINT = (1n << 256n) - 1n;
const ZERO = '0x0000000000000000000000000000000000000000';

export type CometAsset = {
    asset: string; offset: number; priceFeed: string; scale: bigint;
    liquidateCF: bigint; liquidationFactor: bigint; symbol: string;
};
export type CometInfo = {
    comet: string;
    name: string;
    base: string;
    baseSymbol: string;
    baseDecimals: number;
    basePriceFeed: string;
    baseScale: bigint;
    storeFront: bigint;
    targetReserves: bigint;
    assets: CometAsset[];
    /** Bit in the venue-wide exposure mask: base price, then one per asset. */
    baseBit: number;
    assetBit: Map<string, number>;
};

export class CompoundVenue implements Venue {
    readonly kind = 'compound-v3' as const;
    readonly label = 'Compound III';
    readonly key: string;
    readonly baseUnit: bigint;
    readonly eventAddresses: string[];
    readonly eventTopics = Object.values(COMET_TOPIC);
    readonly deployBlock?: number;
    readonly comets = new Map<string, CometInfo>();
    /** Price feed values from the latest readPrices / readAccounts, key `${comet}:${feed}`. */
    readonly feedPrices = new Map<string, bigint>();
    private readonly provider: JsonRpcProvider;
    readonly usd: UsdOracle;
    private readonly names: Record<string, string>;
    private nextBit = 0;

    constructor(provider: JsonRpcProvider, comets: Record<string, string>, usd: UsdOracle, chainLabel = '', deployBlock?: number) {
        this.provider = provider;
        this.names = Object.fromEntries(Object.entries(comets).map(([n, a]) => [a.toLowerCase(), n]));
        this.eventAddresses = Object.values(comets).map(a => a.toLowerCase());
        this.key = `compound-v3${chainLabel ? ':' + chainLabel : ''}`;
        this.usd = usd;
        this.baseUnit = usd.unit;
        this.deployBlock = deployBlock;
    }

    async init(): Promise<void> {
        const want = this.eventAddresses.filter(c => !this.comets.has(c));
        if (!want.length) return;
        const fields = ['baseToken', 'baseTokenPriceFeed', 'baseScale', 'numAssets', 'storeFrontPriceFactor', 'targetReserves'] as const;
        const r1 = await multicall3(this.provider, want.flatMap(c => fields.map(f => ({ target: c, allowFailure: true, callData: COMET_IFACE.encodeFunctionData(f, []) }))));
        const heads = want.map((comet, i) => {
            const v = (k: number) => r1[i * fields.length + k];
            if (!v(0)?.success || v(0).returnData === '0x') return null;
            const dec = (k: number) => COMET_IFACE.decodeFunctionResult(fields[k], v(k).returnData)[0];
            return { comet, base: (dec(0) as string).toLowerCase(), basePriceFeed: (dec(1) as string).toLowerCase(), baseScale: dec(2) as bigint,
                     n: Number(dec(3)), storeFront: dec(4) as bigint, targetReserves: dec(5) as bigint };
        }).filter(x => x != null) as Array<{ comet: string; base: string; basePriceFeed: string; baseScale: bigint; n: number; storeFront: bigint; targetReserves: bigint }>;
        const r2 = await multicall3(this.provider, heads.flatMap(h => Array.from({ length: h.n }, (_, i) => ({
            target: h.comet, allowFailure: true, callData: COMET_IFACE.encodeFunctionData('getAssetInfo', [i]),
        }))));
        let k = 0;
        const infos: CometInfo[] = [];
        for (const h of heads) {
            const assets: CometAsset[] = [];
            for (let i = 0; i < h.n; i++, k++) {
                if (!r2[k]?.success) continue;
                const a = COMET_IFACE.decodeFunctionResult('getAssetInfo', r2[k].returnData)[0] as any;
                assets.push({ asset: String(a.asset).toLowerCase(), offset: Number(a.offset), priceFeed: String(a.priceFeed).toLowerCase(),
                              scale: a.scale as bigint, liquidateCF: a.liquidateCollateralFactor as bigint, liquidationFactor: a.liquidationFactor as bigint, symbol: '?' });
            }
            const info: CometInfo = { comet: h.comet, name: this.names[h.comet] ?? h.comet.slice(0, 8), base: h.base, baseSymbol: '?', baseDecimals: 18,
                basePriceFeed: h.basePriceFeed, baseScale: h.baseScale, storeFront: h.storeFront, targetReserves: h.targetReserves, assets,
                baseBit: this.nextBit++, assetBit: new Map() };
            for (const a of assets) info.assetBit.set(a.asset, this.nextBit++);
            infos.push(info);
        }
        await this.usd.tokenMeta(infos.flatMap(i => [i.base, ...i.assets.map(a => a.asset)]));
        for (const i of infos) {
            i.baseSymbol = this.usd.symbol(i.base); i.baseDecimals = this.usd.decimals(i.base);
            for (const a of i.assets) a.symbol = this.usd.symbol(a.asset);
            this.comets.set(i.comet, i);
        }
        await this.usd.refresh(infos.map(i => i.base));
    }

    decodeEvent(log: RawLog): VenueEvent | null {
        const t0 = String(log.topics[0] ?? '').toLowerCase();
        const s = SLOT[t0];
        const comet = String(log.address ?? '').toLowerCase();
        if (!s || !comet) return null;
        const user = topicAddr(log.topics[s[0]]);
        if (!user || user === ZERO || user === comet) return null;
        return { account: accountKey(user, comet), isBorrow: s[1], blockNumber: Number(log.blockNumber) };
    }

    /** Every feed of every Comet; key `${comet}:${asset or base}`. */
    async readPrices(blockTag?: number): Promise<Map<string, bigint>> {
        const jobs: Array<{ key: string; comet: string; feed: string }> = [];
        for (const c of this.comets.values()) {
            jobs.push({ key: `${c.comet}:${c.base}`, comet: c.comet, feed: c.basePriceFeed });
            for (const a of c.assets) jobs.push({ key: `${c.comet}:${a.asset}`, comet: c.comet, feed: a.priceFeed });
        }
        const r = await readBatched(this.provider, jobs,
            j => [{ target: j.comet, allowFailure: true, callData: COMET_IFACE.encodeFunctionData('getPrice', [j.feed]) }],
            (j, [x]) => x?.success && x.returnData !== '0x' ? [j, COMET_IFACE.decodeFunctionResult('getPrice', x.returnData)[0] as bigint] as const : null,
            { blockTag, batchSize: 100 }, 'feed');
        const out = new Map<string, bigint>();
        for (const [j, p] of r.out) { out.set(j.key, p); this.feedPrices.set(`${j.comet}:${j.feed}`, p); }
        await this.usd.refresh([...this.comets.values()].map(c => c.base));
        return out;
    }

    priceMask(key: string): bigint {
        const { user: comet, market: asset } = splitAccount(key);
        const c = this.comets.get(comet);
        if (!c) return 0n;
        if (asset === c.base) return 1n << BigInt(c.baseBit);
        const b = c.assetBit.get(asset);
        return b == null ? 0n : 1n << BigInt(b);
    }

    async readAccounts(accounts: string[], opts: ReadOptions = {}): Promise<ReadResult> {
        await this.init();
        const parts = accounts.map(a => ({ key: a.toLowerCase(), ...splitAccount(a.toLowerCase()) })).filter(p => this.comets.has(p.market));
        await this.readPrices(opts.blockTag);
        // Round 1: debt and which collateral each account holds.
        const r1 = await readBatched(this.provider, parts,
            p => [
                { target: p.market, allowFailure: true, callData: COMET_IFACE.encodeFunctionData('userBasic', [p.user]) },
                { target: p.market, allowFailure: true, callData: COMET_IFACE.encodeFunctionData('borrowBalanceOf', [p.user]) },
            ],
            (p, [b, d]) => {
                if (!b?.success || !d?.success) return null;
                const u = COMET_IFACE.decodeFunctionResult('userBasic', b.returnData);
                const c = this.comets.get(p.market)!;
                const held = c.assets.filter(a => a.offset < 16 ? (Number(u[3]) >> a.offset) & 1 : (Number(u[4]) >> (a.offset - 16)) & 1);
                return { p, borrow: COMET_IFACE.decodeFunctionResult('borrowBalanceOf', d.returnData)[0] as bigint, held };
            },
            opts, 'account');
        // Round 2: collateral balances, for accounts that borrow.
        const borrowers = r1.out.filter(x => x.borrow > 0n && x.held.length);
        const r2 = await readBatched(this.provider, borrowers,
            x => x.held.map(a => ({ target: x.p.market, allowFailure: true, callData: COMET_IFACE.encodeFunctionData('userCollateral', [x.p.user, a.asset]) })),
            (x, res) => res.every(r => r?.success) ? { x, bal: res.map(r => COMET_IFACE.decodeFunctionResult('userCollateral', r.returnData)[0] as bigint) } : null,
            { ...opts, batchSize: Math.max(1, Math.floor((opts.batchSize ?? 100) / 2)) }, 'account');
        const accountsOut: VenueAccount[] = [];
        for (const x of r1.out) {
            if (x.borrow === 0n) accountsOut.push({ user: x.p.key, debtBase: 0n, collateralBase: 0n, liqThresholdBps: 0, hf: MAX_UINT, config: 0n, eMode: 0 });
        }
        for (const { x, bal } of r2.out) accountsOut.push(this.account(x.p.key, x.borrow, x.held, bal));
        // Borrowers with no collateral at all: debt, nothing to seize.
        for (const x of r1.out) if (x.borrow > 0n && !x.held.length) accountsOut.push(this.account(x.p.key, x.borrow, [], []));
        return { accounts: accountsOut, failed: r1.failed + r2.failed, calls: r1.calls + r2.calls, batchSize: r1.batchSize,
                 errors: [...r1.errors, ...r2.errors], unpinned: r1.unpinned || r2.unpinned };
    }

    private feed(c: CometInfo, feed: string): bigint | null { return this.feedPrices.get(`${c.comet}:${feed}`) ?? null; }

    /** Comet's isLiquidatable math, as an HF (WAD) plus USD values. */
    account(key: string, borrow: bigint, held: CometAsset[], balances: bigint[]): VenueAccount {
        const c = this.comets.get(splitAccount(key).market)!;
        const basePrice = this.feed(c, c.basePriceFeed) ?? 0n;
        const debtValue = borrow * basePrice / c.baseScale;
        let liqValue = 0n, collValue = 0n, mask = borrow > 0n ? 1n << BigInt(c.baseBit) : 0n;
        held.forEach((a, i) => {
            const v = balances[i] * (this.feed(c, a.priceFeed) ?? 0n) / a.scale;
            collValue += v;
            liqValue += v * a.liquidateCF / WAD;
            if (balances[i] > 0n) mask |= 1n << BigInt(c.assetBit.get(a.asset)!);
        });
        const hf = borrow === 0n ? MAX_UINT : debtValue === 0n ? MAX_UINT : liqValue * WAD / debtValue;
        // Feed values are in the Comet's numeraire; base's USD price converts them.
        const toUsd = (v: bigint) => basePrice === 0n ? null : this.usd.value(c.base, v * c.baseScale / basePrice);
        return {
            user: key, debtBase: borrow === 0n ? 0n : this.usd.value(c.base, borrow), collateralBase: toUsd(collValue),
            liqThresholdBps: 0, hf, config: mask, eMode: 0,
        };
    }

    /** Store-front discount of `a` in this Comet: storeFront x (1 - liquidationFactor), WAD. */
    discount(c: CometInfo, a: CometAsset): bigint { return c.storeFront * (WAD - a.liquidationFactor) / WAD; }

    /**
     * Most one liquidation can pay: absorb takes all collateral; the buyer then
     * gets the store-front discount on it. Upper bound: the biggest discount of
     * the account's collateral assets applied to all of its collateral.
     */
    maxProfitBase(a: Pick<VenueAccount, 'collateralBase' | 'config'> & { user?: string }): bigint | null {
        if (a.collateralBase == null || !a.user) return null;
        const c = this.comets.get(splitAccount(a.user).market);
        if (!c) return null;
        let d = 0n;
        for (const x of c.assets) if ((a.config >> BigInt(c.assetBit.get(x.asset)!)) & 1n) { const v = this.discount(c, x); if (v > d) d = v; }
        return a.collateralBase * d / WAD;
    }

    describe(a: Pick<VenueAccount, 'user' | 'config'>): string {
        const c = this.comets.get(splitAccount(a.user).market);
        if (!c) return '?';
        const coll = c.assets.filter(x => (a.config >> BigInt(c.assetBit.get(x.asset)!)) & 1n).map(x => x.symbol);
        return `${coll.join('+') || '—'} → ${c.baseSymbol} (c${c.name.toUpperCase()}v3)`;
    }
}
