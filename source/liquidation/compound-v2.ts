// -----------------------------------------------------------------------------
// Compound V2 and its forks (Benqi, Moonwell, Sonne, Iron Bank, Ionic, Tender,
// WePiggy, …) as a liquidation Venue. One Comptroller per market cluster; an
// ACCOUNT is `${borrower}:${comptroller}` — a borrower's whole cross-collateral
// position under that comptroller, since Compound V2 is pooled, not isolated.
//
// HEALTH — Comptroller's own accounting:
//
//   for each cToken the account is in (getAssetsIn):
//     (err, cTokenBal, borrowBal, exRate) = cToken.getAccountSnapshot(user)
//     underlying      = cTokenBal x exRate / 1e18
//     price           = oracle.getUnderlyingPrice(cToken)   // scaled 1e(36-dec), USD
//     collateralValue = underlying x price / 1e18            // USD x 1e18
//     weighted       += collateralValue x collateralFactor / 1e18
//     borrowValue    += borrowBal x price / 1e18
//   HF = weighted / borrowValue            (shortfall > 0, i.e. HF < 1 = liquidatable)
//
// LIQUIDATION — cTokenBorrowed.liquidateBorrow(borrower, repay, cTokenCollateral):
// repay up to closeFactor x borrow of ONE borrowed asset, seize the chosen
// collateral cToken at liquidationIncentive. The executor flash-borrows the
// repay, redeems the seized cTokens to the underlying, swaps back, repays.
// Both the repaid and the seized underlying must be ERC20 here — native-gas
// markets (cETH / qiAVAX / mGLMR) are priced for health but skipped as the
// repay or seize leg (noted in describe), since redeeming them yields native
// coin the HopEngine can't route.
//
// Addresses: each fork's Comptroller (its docs / deployment). Underlyings,
// collateral factors, close factor and incentive are all read on-chain.
// -----------------------------------------------------------------------------

import { Interface, type JsonRpcProvider } from 'ethers';
import { multicall3 } from '../util/multicall.ts';
import { readBatched } from './batch.ts';
import type { UsdOracle } from './usd.ts';
import {
    accountKey, splitAccount, topicAddr,
    type Venue, type VenueAccount, type VenueEvent, type ReadResult, type ReadOptions, type RawLog,
} from './venue.ts';

/** Comptrollers per chain (fork name -> Comptroller/Unitroller address). */
export const COMPTROLLERS: Record<number, Record<string, string>> = {
    43114: { benqi: '0x486Af39519B4Dc9a7fCcd318217352830E8AD9b4' },           // Avalanche
    8453:  { moonwell: '0xfBb21d0380beE3312B33c4353c8936a0F13EF26C' },          // Base
    10:    { sonne: '0x60CF091cD3f50420d50fD7f707414d0DF4751C58' },             // Optimism (Sonne)
    // Add more forks per chain in conf/<chain>.json5 liquidation.comptrollers.
};

export const CTOKEN_IFACE = new Interface([
    'function underlying() view returns (address)',
    'function symbol() view returns (string)',
    'function decimals() view returns (uint8)',
    'function exchangeRateStored() view returns (uint256)',
    'function getAccountSnapshot(address) view returns (uint256,uint256,uint256,uint256)',
    'function liquidateBorrow(address borrower, uint256 repayAmount, address cTokenCollateral) returns (uint256)',
    'function redeem(uint256 redeemTokens) returns (uint256)',
    'event Borrow(address indexed borrower, uint256 borrowAmount, uint256 accountBorrows, uint256 totalBorrows)',
    'event LiquidateBorrow(address liquidator, address borrower, uint256 repayAmount, address cTokenCollateral, uint256 seizeTokens)',
]);
export const COMPTROLLER_IFACE = new Interface([
    'function getAllMarkets() view returns (address[])',
    'function oracle() view returns (address)',
    'function closeFactorMantissa() view returns (uint256)',
    'function liquidationIncentiveMantissa() view returns (uint256)',
    'function markets(address) view returns (bool isListed, uint256 collateralFactorMantissa)',
    'function getAssetsIn(address) view returns (address[])',
]);
const ORACLE_IFACE = new Interface(['function getUnderlyingPrice(address) view returns (uint256)']);

const BORROW_TOPIC = CTOKEN_IFACE.getEvent('Borrow')!.topicHash.toLowerCase();
const LIQUIDATE_TOPIC = CTOKEN_IFACE.getEvent('LiquidateBorrow')!.topicHash.toLowerCase();

export const WAD = 10n ** 18n;
const MAX_UINT = (1n << 256n) - 1n;
const ZERO = '0x0000000000000000000000000000000000000000';

export type CMarket = {
    cToken: string;
    underlying: string | null;   // null = native-coin market (cETH-style)
    underlyingDecimals: number;
    symbol: string;
    collateralFactor: bigint;     // WAD
    bit: number;                  // exposure bit, venue-wide
};
export type CComptroller = {
    address: string;
    name: string;
    oracle: string;
    closeFactor: bigint;          // WAD
    incentive: bigint;            // WAD (e.g. 1.08e18)
    markets: Map<string, CMarket>;   // by cToken
};

export class CompoundV2Venue implements Venue {
    readonly kind = 'compound-v2' as const;
    readonly label = 'Compound V2';
    readonly key: string;
    readonly baseUnit: bigint;
    readonly eventAddresses: string[] = [];
    readonly eventTopics = [BORROW_TOPIC, LIQUIDATE_TOPIC];
    readonly deployBlock?: number;
    readonly comptrollers = new Map<string, CComptroller>();
    /** cToken -> its comptroller, for decoding events. */
    private readonly cTokenTo = new Map<string, string>();
    /** Underlying price (WAD-ish, oracle scale) by `${comptroller}:${cToken}`. */
    readonly prices = new Map<string, bigint>();
    private readonly provider: JsonRpcProvider;
    readonly usd: UsdOracle;
    private readonly names: Record<string, string>;
    private nextBit = 0;
    private loaded = false;

    constructor(provider: JsonRpcProvider, comptrollers: Record<string, string>, usd: UsdOracle, chainLabel = '', deployBlock?: number) {
        this.provider = provider;
        this.names = Object.fromEntries(Object.entries(comptrollers).map(([n, a]) => [a.toLowerCase(), n]));
        this.key = `compound-v2${chainLabel ? ':' + chainLabel : ''}`;
        this.usd = usd;
        this.baseUnit = usd.unit;
        this.deployBlock = deployBlock;
    }

    async init(): Promise<void> {
        if (this.loaded) return;
        const addrs = Object.keys(this.names);
        // Round 1: per-comptroller config + market list.
        const fields = ['oracle', 'closeFactorMantissa', 'liquidationIncentiveMantissa', 'getAllMarkets'] as const;
        const r1 = await multicall3(this.provider, addrs.flatMap(c => fields.map(f => ({ target: c, allowFailure: true, callData: COMPTROLLER_IFACE.encodeFunctionData(f, []) }))));
        const heads = addrs.map((address, i) => {
            const v = (k: number) => r1[i * fields.length + k];
            if (!v(0)?.success || v(0).returnData === '0x' || !v(3)?.success) return null;
            const dec = (k: number) => COMPTROLLER_IFACE.decodeFunctionResult(fields[k], v(k).returnData)[0];
            return { address, oracle: (dec(0) as string).toLowerCase(), closeFactor: dec(1) as bigint,
                     incentive: dec(2) as bigint, cTokens: (dec(3) as string[]).map(x => x.toLowerCase()) };
        }).filter(x => x != null) as Array<{ address: string; oracle: string; closeFactor: bigint; incentive: bigint; cTokens: string[] }>;
        // Round 2: each cToken's underlying, decimals, symbol, collateral factor.
        const jobs = heads.flatMap(h => h.cTokens.map(c => ({ h, c })));
        const r2 = await multicall3(this.provider, jobs.flatMap(({ h, c }) => [
            { target: c, allowFailure: true, callData: CTOKEN_IFACE.encodeFunctionData('underlying', []) },
            { target: c, allowFailure: true, callData: CTOKEN_IFACE.encodeFunctionData('symbol', []) },
            { target: h.address, allowFailure: true, callData: COMPTROLLER_IFACE.encodeFunctionData('markets', [c]) },
        ]));
        const byComp = new Map<string, CComptroller>();
        for (const h of heads) byComp.set(h.address, { address: h.address, name: this.names[h.address] ?? h.address.slice(0, 8), oracle: h.oracle, closeFactor: h.closeFactor, incentive: h.incentive, markets: new Map() });
        const underlyings: string[] = [];
        jobs.forEach(({ h, c }, i) => {
            const u = r2[i * 3], s = r2[i * 3 + 1], m = r2[i * 3 + 2];
            if (!m?.success) return;   // not a listed market
            let underlying: string | null = null;
            if (u?.success && u.returnData !== '0x') { try { const a = (CTOKEN_IFACE.decodeFunctionResult('underlying', u.returnData)[0] as string).toLowerCase(); if (a !== ZERO) underlying = a; } catch { /* native */ } }
            let symbol = '?';
            try { if (s?.success) symbol = CTOKEN_IFACE.decodeFunctionResult('symbol', s.returnData)[0] as string; } catch { /* keep */ }
            const cf = COMPTROLLER_IFACE.decodeFunctionResult('markets', m.returnData)[1] as bigint;
            const mk: CMarket = { cToken: c, underlying, underlyingDecimals: 18, symbol, collateralFactor: cf, bit: this.nextBit++ };
            byComp.get(h.address)!.markets.set(c, mk);
            this.cTokenTo.set(c, h.address);
            if (underlying) underlyings.push(underlying);
        });
        await this.usd.tokenMeta(underlyings);
        for (const comp of byComp.values()) {
            for (const mk of comp.markets.values()) if (mk.underlying) mk.underlyingDecimals = this.usd.decimals(mk.underlying);
            this.comptrollers.set(comp.address, comp);
        }
        this.eventAddresses.splice(0, this.eventAddresses.length, ...this.cTokenTo.keys());
        this.loaded = true;
    }

    decodeEvent(log: RawLog): VenueEvent | null {
        const t0 = String(log.topics[0] ?? '').toLowerCase();
        if (t0 !== BORROW_TOPIC && t0 !== LIQUIDATE_TOPIC) return null;
        const comp = this.cTokenTo.get(String(log.address ?? '').toLowerCase());
        if (!comp) return null;
        // Borrow: borrower is topic[1]. LiquidateBorrow is non-indexed; its borrower
        // is data word 1 — but a liquidation only ever REMOVES risk, so we need it
        // only to re-read, and an existing account re-reads on any of its events.
        const user = t0 === BORROW_TOPIC ? topicAddr(log.topics[1]) : ('0x' + log.data.slice(2 + 64 + 24, 2 + 128)).toLowerCase();
        if (!user || user === ZERO) return null;
        return { account: accountKey(user, comp), isBorrow: t0 === BORROW_TOPIC, blockNumber: Number(log.blockNumber) };
    }

    async readPrices(blockTag?: number): Promise<Map<string, bigint>> {
        await this.init();
        const jobs: Array<{ key: string; comp: CComptroller; cToken: string }> = [];
        for (const comp of this.comptrollers.values()) for (const mk of comp.markets.values()) jobs.push({ key: `${comp.address}:${mk.cToken}`, comp, cToken: mk.cToken });
        const r = await readBatched(this.provider, jobs,
            j => [{ target: j.comp.oracle, allowFailure: true, callData: ORACLE_IFACE.encodeFunctionData('getUnderlyingPrice', [j.cToken]) }],
            (j, [x]) => x?.success && x.returnData !== '0x' ? [j.key, ORACLE_IFACE.decodeFunctionResult('getUnderlyingPrice', x.returnData)[0] as bigint] as const : null,
            { blockTag, batchSize: 100 }, 'oracle');
        const out = new Map<string, bigint>();
        for (const [k, p] of r.out) { out.set(k, p); this.prices.set(k, p); }
        await this.usd.refresh([...this.comptrollers.values()].flatMap(c => [...c.markets.values()].map(m => m.underlying).filter((u): u is string => !!u)));
        return out;
    }

    priceMask(key: string): bigint {
        const { user: comp, market: cToken } = splitAccount(key);
        const m = this.comptrollers.get(comp)?.markets.get(cToken);
        return m ? 1n << BigInt(m.bit) : 0n;
    }

    async readAccounts(accounts: string[], opts: ReadOptions = {}): Promise<ReadResult> {
        await this.init();
        const parts = accounts.map(a => ({ key: a.toLowerCase(), ...splitAccount(a.toLowerCase()) })).filter(p => this.comptrollers.has(p.market));
        await this.readPrices(opts.blockTag);
        // Round 1: which markets each account is in.
        const r1 = await readBatched(this.provider, parts,
            p => [{ target: p.market, allowFailure: true, callData: COMPTROLLER_IFACE.encodeFunctionData('getAssetsIn', [p.user]) }],
            (p, [x]) => {
                if (!x?.success || x.returnData === '0x') return null;
                const assets = (COMPTROLLER_IFACE.decodeFunctionResult('getAssetsIn', x.returnData)[0] as string[]).map(a => a.toLowerCase());
                return { p, assets: assets.filter(a => this.comptrollers.get(p.market)!.markets.has(a)) };
            }, opts, 'assetsIn');
        // Round 2: a snapshot per (account, market).
        const flat = r1.out.flatMap(x => x.assets.map(cToken => ({ x, cToken })));
        const r2 = await readBatched(this.provider, flat,
            ({ x, cToken }) => [{ target: cToken, allowFailure: true, callData: CTOKEN_IFACE.encodeFunctionData('getAccountSnapshot', [x.p.user]) }],
            ({ x, cToken }, [s]) => {
                if (!s?.success) return null;
                const d = CTOKEN_IFACE.decodeFunctionResult('getAccountSnapshot', s.returnData);
                return { key: x.p.key, comp: x.p.market, cToken, cTokenBal: d[1] as bigint, borrowBal: d[2] as bigint, exRate: d[3] as bigint };
            }, { ...opts, batchSize: Math.max(1, Math.floor((opts.batchSize ?? 100) / 2)) }, 'snapshot');
        const byAcct = new Map<string, Array<(typeof r2.out)[number]>>();
        for (const s of r2.out) (byAcct.get(s.key) ?? byAcct.set(s.key, []).get(s.key)!).push(s);
        const out: VenueAccount[] = [];
        for (const [key, snaps] of byAcct) out.push(this.account(key, snaps));
        // Accounts with no markets / all-empty snapshots: idle.
        for (const x of r1.out) if (!byAcct.has(x.p.key)) out.push({ user: x.p.key, debtBase: 0n, collateralBase: 0n, liqThresholdBps: 0, hf: MAX_UINT, config: 0n, eMode: 0 });
        return { accounts: out, failed: r1.failed + r2.failed, calls: r1.calls + r2.calls, batchSize: r1.batchSize, errors: [...r1.errors, ...r2.errors], unpinned: r1.unpinned || r2.unpinned };
    }

    /** Comptroller liquidity math as an HF (WAD) plus USD values (via the oracle's USD prices). */
    account(key: string, snaps: Array<{ comp: string; cToken: string; cTokenBal: bigint; borrowBal: bigint; exRate: bigint }>): VenueAccount {
        const comp = this.comptrollers.get(splitAccount(key).market)!;
        let weighted = 0n, collVal = 0n, borrowVal = 0n, mask = 0n;
        for (const s of snaps) {
            const mk = comp.markets.get(s.cToken); if (!mk) continue;
            const price = this.prices.get(`${comp.address}:${s.cToken}`) ?? 0n;
            const underlying = s.cTokenBal * s.exRate / WAD;
            const cv = underlying * price / WAD;            // USD x 1e18
            const bv = s.borrowBal * price / WAD;
            collVal += cv; weighted += cv * mk.collateralFactor / WAD; borrowVal += bv;
            if (s.cTokenBal > 0n || s.borrowBal > 0n) mask |= 1n << BigInt(mk.bit);
        }
        const hf = borrowVal === 0n ? MAX_UINT : weighted * WAD / borrowVal;
        const to8 = (v18: bigint) => v18 / 10n ** 10n;      // oracle USD 1e18 -> baseUnit 1e8
        return { user: key, debtBase: to8(borrowVal), collateralBase: to8(collVal), liqThresholdBps: 0, hf, config: mask, eMode: 0 };
    }

    /**
     * Most one liquidation can pay: repay up to closeFactor x debt of one asset,
     * seize collateral x incentive; payout = seized x (incentive - 1) / incentive.
     * Upper bound across the account (ERC20 legs only).
     */
    maxProfitBase(a: Pick<VenueAccount, 'debtBase' | 'collateralBase'> & { user?: string }): bigint | null {
        if (a.debtBase == null || a.collateralBase == null || !a.user) return null;
        const comp = this.comptrollers.get(splitAccount(a.user).market);
        if (!comp) return null;
        const repay = a.debtBase * comp.closeFactor / WAD;
        const byColl = a.collateralBase * WAD / comp.incentive;
        const seizeRepay = repay < byColl ? repay : byColl;      // repay USD actually coverable
        return seizeRepay * (comp.incentive - WAD) / WAD;
    }

    describe(a: Pick<VenueAccount, 'user' | 'config'>): string {
        const comp = this.comptrollers.get(splitAccount(a.user).market);
        if (!comp) return '?';
        const held = [...comp.markets.values()].filter(m => (a.config >> BigInt(m.bit)) & 1n);
        const sym = (m: CMarket) => (m.underlying ? '' : '⟡') + m.symbol.replace(/^[a-z]+/, '');   // ⟡ = native leg, skipped for liquidation
        return `${held.map(sym).join('+') || '—'} (c${comp.name.toUpperCase()}v2)`;
    }
}
