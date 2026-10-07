// -----------------------------------------------------------------------------
// Euler V2 (EVK vaults behind the Ethereum Vault Connector) as a liquidation
// Venue. Each vault is an ERC-4626-style lending vault; a borrower's position
// is one controller (liability) vault plus a set of collateral vaults enabled
// on the EVC. An ACCOUNT here is `${evcAccount}:${liabilityVault}` — the vault
// that emitted the Borrow IS the account's controller.
//
// HEALTH — the liability vault's own accountLiquidity(account, liquidation):
//
//   (collateralValue, liabilityValue) = liability.accountLiquidity(account, true)
//   HF = collateralValue / liabilityValue          (< 1 = liquidatable)
//
// both sides are risk-adjusted values in the vault's unitOfAccount (18-dp).
// Most Euler vaults quote USD (unitOfAccount = the 0x..0348 sentinel); for a
// token unit-of-account we convert through UsdOracle.
//
// LIQUIDATION — liability.liquidate(violator, collateralVault, repay, minYield)
// through the EVC: the liquidator assumes `repay` of the violator's debt and
// receives the seized collateral-vault shares, at a health-dependent discount.
// The executor does it in one EVC batch (checks deferred), redeems the seized
// shares to their underlying, swaps back, and repays the assumed debt. The
// planner reads checkLiquidation() for the exact (maxRepay, maxYield).
//
// Vaults are enumerated from the GenericFactory's proxy list. Addresses:
// euler-xyz/euler-interfaces addresses/<chainId>/CoreAddresses.json.
// -----------------------------------------------------------------------------

import { Interface, getAddress, type JsonRpcProvider } from 'ethers';
import { multicall3 } from '../util/multicall.ts';
import { readBatched } from './batch.ts';
import type { UsdOracle } from './usd.ts';
import {
    accountKey, splitAccount, topicAddr,
    type Venue, type VenueAccount, type VenueEvent, type ReadResult, type ReadOptions, type RawLog,
} from './venue.ts';

/** EVC + GenericFactory per chain (euler-interfaces CoreAddresses.json). */
export const EULER: Record<number, { evc: string; factory: string; deployBlock?: number }> = {
    1:     { evc: '0x0C9a3dd6b8F28529d72d7f9cE918D493519EE383', factory: '0x29a56a1b8214D9Cf7c5561811750D5cBDb45CC8e' },
    8453:  { evc: '0x5301c7dD20bD945D2013b48ed0DEE3A284ca8989', factory: '0x7F321498A801A191a93C840750ed637149dDf8D0' },
    42161: { evc: '0x6302ef0F34100CDDFb5489fbcB6eE1AA95CD1066', factory: '0x78Df1CF5bf06a7f27f2ACc580B934238C1b80D50' },
    143:   { evc: '0x7a9324E8f270413fa2E458f5831226d99C7477CD', factory: '0xba4Dd672062dE8FeeDb665DD4410658864483f1E' },
    146:   { evc: '0x4860C903f6Ad709c3eDA46D3D502943f184D4315', factory: '0xF075cC8660B51D0b8a4474e3f47eDAC5fA034cFB' },
    43114: { evc: '0xddcbe30A761Edd2e19bba930A977475265F36Fa1', factory: '0xaf4B4c18B17F6a2B32F6c398a3910bdCD7f26181' },
    137:   { evc: '0x90811DacA4BD23Fc79A87FBdff7522bED2d24B4B', factory: '0xB1771a13e2a13fCafA89B00335915E732B9466b7' },
    59144: { evc: '0xd8CeCEe9A04eA3d941a959F68fb4486f23271d09', factory: '0x84711986Fd3BF0bFe4a8e6d7f4E22E67f7f27F04' },
    56:    { evc: '0xb2E5a73CeE08593d1a076a2AE7A6e02925a640ea', factory: '0x7F53E2755eB3c43824E162F7F6F087832B9C9Df6' },
};

export const EVAULT_IFACE = new Interface([
    'function asset() view returns (address)',
    'function symbol() view returns (string)',
    'function unitOfAccount() view returns (address)',
    'function accountLiquidity(address account, bool liquidation) view returns (uint256 collateralValue, uint256 liabilityValue)',
    'function checkLiquidation(address liquidator, address violator, address collateral) view returns (uint256 maxRepay, uint256 maxYield)',
    'function debtOf(address account) view returns (uint256)',
    'function convertToAssets(uint256 shares) view returns (uint256)',
    'event Borrow(address indexed account, uint256 assets)',
    'event Liquidate(address indexed liquidator, address indexed violator, address collateral, uint256 repayAssets, uint256 yieldBalance)',
]);
const FACTORY_IFACE = new Interface([
    'function getProxyListLength() view returns (uint256)',
    'function getProxyListSlice(uint256 start, uint256 end) view returns (address[])',
]);
const EVC_IFACE = new Interface([
    'function getCollaterals(address account) view returns (address[])',
]);

const BORROW_TOPIC = EVAULT_IFACE.getEvent('Borrow')!.topicHash.toLowerCase();
const LIQUIDATE_TOPIC = EVAULT_IFACE.getEvent('Liquidate')!.topicHash.toLowerCase();
/** ISO-4217 840 (USD) as an address — Euler's USD unit-of-account sentinel. */
const USD_SENTINEL = '0x0000000000000000000000000000000000000348';

export const WAD = 10n ** 18n;
const MAX_UINT = (1n << 256n) - 1n;
/** Euler's maxLiquidationDiscount is per-vault (≤ 1); 0.2 is the common cap, used only for the dust upper bound. */
const DUST_DISCOUNT = 20n;   // percent

export type EVault = {
    address: string;
    asset: string;
    symbol: string;
    assetDecimals: number;
    unitOfAccount: string;
    bit: number;
};

export class EulerVenue implements Venue {
    readonly kind = 'euler-v2' as const;
    readonly label = 'Euler V2';
    readonly key: string;
    readonly baseUnit: bigint;
    readonly eventAddresses: string[] = [];
    readonly eventTopics = [BORROW_TOPIC, LIQUIDATE_TOPIC];
    readonly deployBlock?: number;
    readonly evc: string;
    readonly factory: string;
    readonly vaults = new Map<string, EVault>();
    /** (collateralValue, liabilityValue) from the latest read, by account key. */
    readonly liquidity = new Map<string, { coll: bigint; liab: bigint }>();
    private readonly provider: JsonRpcProvider;
    readonly usd: UsdOracle;
    private loaded = false;

    constructor(provider: JsonRpcProvider, evc: string, factory: string, usd: UsdOracle, deployBlock?: number) {
        this.provider = provider;
        this.evc = evc.toLowerCase();
        this.factory = factory.toLowerCase();
        this.key = `euler-v2:${this.evc}`;
        this.usd = usd;
        this.baseUnit = usd.unit;
        this.deployBlock = deployBlock;
    }

    async init(): Promise<void> {
        if (this.loaded) return;
        const [lenRes] = await multicall3(this.provider, [{ target: this.factory, allowFailure: true, callData: FACTORY_IFACE.encodeFunctionData('getProxyListLength', []) }]);
        if (!lenRes?.success) { this.loaded = true; return; }
        const n = Number(FACTORY_IFACE.decodeFunctionResult('getProxyListLength', lenRes.returnData)[0]);
        const vaults: string[] = [];
        for (let i = 0; i < n; i += 500) {
            const [s] = await multicall3(this.provider, [{ target: this.factory, allowFailure: true, callData: FACTORY_IFACE.encodeFunctionData('getProxyListSlice', [i, Math.min(i + 500, n)]) }]);
            if (s?.success) vaults.push(...(FACTORY_IFACE.decodeFunctionResult('getProxyListSlice', s.returnData)[0] as string[]).map(a => a.toLowerCase()));
        }
        const r = await multicall3(this.provider, vaults.flatMap(v => [
            { target: v, allowFailure: true, callData: EVAULT_IFACE.encodeFunctionData('asset', []) },
            { target: v, allowFailure: true, callData: EVAULT_IFACE.encodeFunctionData('symbol', []) },
            { target: v, allowFailure: true, callData: EVAULT_IFACE.encodeFunctionData('unitOfAccount', []) },
        ]));
        let bit = 0;
        const assets: string[] = [];
        vaults.forEach((v, i) => {
            const a = r[i * 3];
            if (!a?.success || a.returnData === '0x') return;
            const asset = (EVAULT_IFACE.decodeFunctionResult('asset', a.returnData)[0] as string).toLowerCase();
            let symbol = '?'; try { if (r[i * 3 + 1]?.success) symbol = EVAULT_IFACE.decodeFunctionResult('symbol', r[i * 3 + 1].returnData)[0] as string; } catch { /* keep */ }
            let uoa = USD_SENTINEL; try { if (r[i * 3 + 2]?.success) uoa = (EVAULT_IFACE.decodeFunctionResult('unitOfAccount', r[i * 3 + 2].returnData)[0] as string).toLowerCase(); } catch { /* usd */ }
            this.vaults.set(v, { address: v, asset, symbol, assetDecimals: 18, unitOfAccount: uoa, bit: bit++ });
            assets.push(asset);
        });
        await this.usd.tokenMeta(assets);
        for (const vt of this.vaults.values()) vt.assetDecimals = this.usd.decimals(vt.asset);
        this.eventAddresses.splice(0, this.eventAddresses.length, ...this.vaults.keys());
        this.loaded = true;
    }

    decodeEvent(log: RawLog): VenueEvent | null {
        const t0 = String(log.topics[0] ?? '').toLowerCase();
        if (t0 !== BORROW_TOPIC && t0 !== LIQUIDATE_TOPIC) return null;
        const vault = String(log.address ?? '').toLowerCase();
        if (!this.vaults.has(vault)) return null;
        // Borrow(account): account = topic[1]; the emitting vault is the controller.
        // Liquidate(liquidator, violator): violator = topic[2].
        const who = topicAddr(log.topics[t0 === BORROW_TOPIC ? 1 : 2]);
        if (!who) return null;
        return { account: accountKey(who, vault), isBorrow: t0 === BORROW_TOPIC, blockNumber: Number(log.blockNumber) };
    }

    /** Euler reads health from the vault directly; there is no shared price vector to diff. */
    async readPrices(): Promise<Map<string, bigint>> { await this.init(); return new Map(); }
    /** Exposure can't be reduced to a per-key bit without the oracle graph, so every tracked account re-reads on a price tick (handled by the sweep). */
    priceMask(): bigint { return 0n; }

    private uoaToBase(uoa: string, value18: bigint): bigint | null {
        if (uoa === USD_SENTINEL) return value18 / 10n ** 10n;        // USD 1e18 -> 1e8
        const usd = this.usd.value(uoa, value18 * 10n ** BigInt(this.usd.decimals(uoa)) / WAD);
        return usd;                                                   // value18 is in uoa (18dp); scale to uoa units, then USD
    }

    async readAccounts(accounts: string[], opts: ReadOptions = {}): Promise<ReadResult> {
        await this.init();
        const parts = accounts.map(a => ({ key: a.toLowerCase(), ...splitAccount(a.toLowerCase()) })).filter(p => this.vaults.has(p.market));
        await this.usd.refresh([...this.vaults.values()].map(v => v.unitOfAccount).filter(u => u !== USD_SENTINEL));
        const r = await readBatched(this.provider, parts,
            p => [
                { target: p.market, allowFailure: true, callData: EVAULT_IFACE.encodeFunctionData('accountLiquidity', [getAddress(p.user), true]) },
                { target: p.market, allowFailure: true, callData: EVAULT_IFACE.encodeFunctionData('debtOf', [getAddress(p.user)]) },
            ],
            (p, [al, d]) => {
                const vt = this.vaults.get(p.market)!;
                if (!d?.success) return null;
                const debt = EVAULT_IFACE.decodeFunctionResult('debtOf', d.returnData)[0] as bigint;
                if (debt === 0n) return { user: p.key, debtBase: 0n, collateralBase: 0n, liqThresholdBps: 0, hf: MAX_UINT, config: 1n << BigInt(vt.bit), eMode: 0 };
                // accountLiquidity reverts when there is no controller/odd state; treat as unknown, not idle.
                if (!al?.success || al.returnData === '0x') return null;
                const q = EVAULT_IFACE.decodeFunctionResult('accountLiquidity', al.returnData);
                const coll = q[0] as bigint, liab = q[1] as bigint;
                this.liquidity.set(p.key, { coll, liab });
                const hf = liab === 0n ? MAX_UINT : coll * WAD / liab;
                return { user: p.key, debtBase: this.uoaToBase(vt.unitOfAccount, liab), collateralBase: this.uoaToBase(vt.unitOfAccount, coll),
                         liqThresholdBps: 0, hf, config: 1n << BigInt(vt.bit), eMode: 0 };
            }, opts, 'account');
        return { accounts: r.out, failed: r.failed, calls: r.calls, batchSize: r.batchSize, errors: r.errors, unpinned: r.unpinned };
    }

    /** Upper bound: the whole liability repaid at the max discount. */
    maxProfitBase(a: Pick<VenueAccount, 'debtBase'> & { user?: string }): bigint | null {
        if (a.debtBase == null) return null;
        return a.debtBase * DUST_DISCOUNT / 100n;
    }

    describe(a: Pick<VenueAccount, 'user'>): string {
        const vt = this.vaults.get(splitAccount(a.user).market);
        return vt ? `${vt.symbol} liability (Euler)` : '?';
    }

    /** Collateral vaults the account has enabled — the planner tries the most valuable. */
    async collateralsOf(account: string): Promise<string[]> {
        const [r] = await multicall3(this.provider, [{ target: this.evc, allowFailure: true, callData: EVC_IFACE.encodeFunctionData('getCollaterals', [getAddress(account)]) }]);
        if (!r?.success) return [];
        return (EVC_IFACE.decodeFunctionResult('getCollaterals', r.returnData)[0] as string[]).map(a => a.toLowerCase());
    }
}
