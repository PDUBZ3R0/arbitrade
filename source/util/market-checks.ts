// -----------------------------------------------------------------------------
// "Is this address what we think it is?" — on-chain identity checks for
// lending markets, shared by yarn aave-market / morpho-market (one address,
// then the reserve or holdings report) and yarn verify-markets (every address
// in conf/markets/, one table).
//
// Plain eth_calls and getCode, no Multicall3: verify-markets runs on chains
// arbitrade has never been set up on, and Multicall3 is not on every one.
//
// Each check returns a list of findings rather than throwing, so a caller can
// print all of them; `ok` is false when any finding is a failure. Warnings
// (`warn: true`) do not fail the market.
// -----------------------------------------------------------------------------

import { Interface, getAddress, id, type JsonRpcProvider } from 'ethers';
import { hasSelector, selectorOf } from './bytecode.ts';

export type Finding = { ok: boolean; warn?: boolean; msg: string };
export type CheckResult = { ok: boolean; findings: Finding[] };

/** EIP-1967 implementation slot (Aave's and Compound's proxies both use it). */
const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';

const ZERO = '0x0000000000000000000000000000000000000000';

class Collector {
    readonly findings: Finding[] = [];
    pass(msg: string) { this.findings.push({ ok: true, msg }); }
    warn(msg: string) { this.findings.push({ ok: true, warn: true, msg }); }
    fail(msg: string) { this.findings.push({ ok: false, msg }); }
    get ok() { return this.findings.every(f => f.ok); }
}

async function view(provider: JsonRpcProvider, target: string, iface: Interface, fn: string, args: unknown[] = []): Promise<any[] | null> {
    try {
        const raw = await provider.call({ to: target, data: iface.encodeFunctionData(fn, args) });
        if (!raw || raw === '0x') return null;
        return [...iface.decodeFunctionResult(fn, raw)];
    } catch { return null; }
}

async function code(provider: JsonRpcProvider, address: string): Promise<string> {
    return (await provider.getCode(address)).toLowerCase();
}

/** Runtime code of the EIP-1967 implementation behind `proxy`, or the proxy's own code when it has none. */
async function logicCode(provider: JsonRpcProvider, proxy: string, own: string): Promise<{ code: string; impl: string | null }> {
    try {
        const slot = await provider.getStorage(proxy, IMPL_SLOT);
        const impl = '0x' + slot.slice(-40);
        if (impl !== ZERO && !/^0x0+$/.test(slot)) return { code: await code(provider, impl), impl: getAddress(impl) };
    } catch { /* no storage access: fall through */ }
    return { code: own, impl: null };
}

/** Any byte-aligned occurrence of the selector: outgoing calls are not in the dispatcher (see morpho-market). */
function mentions(codeHex: string, signature: string): boolean {
    const sel = id(signature).slice(2, 10);
    for (let i = codeHex.indexOf(sel, 2); i >= 0; i = codeHex.indexOf(sel, i + 1)) if (i % 2 === 0) return true;
    return false;
}

// ---- Aave V3 (and forks) -----------------------------------------------------

const POOL = new Interface([
    'function ADDRESSES_PROVIDER() view returns (address)',
    'function getReservesList() view returns (address[])',
    'function FLASHLOAN_PREMIUM_TOTAL() view returns (uint128)',
]);
const AP = new Interface([
    'function getPool() view returns (address)',
    'function getMarketId() view returns (string)',
    'function getPriceOracle() view returns (address)',
    'function getPoolDataProvider() view returns (address)',
]);
const ORACLE = new Interface(['function getAssetPrice(address) view returns (uint256)']);

export type AaveIdentity = CheckResult & {
    addressesProvider?: string;
    marketId?: string;
    /** FLASHLOAN_PREMIUM_TOTAL as a fraction (0.0005 = 5 bps); null when unreadable. */
    premium?: number | null;
    premiumRaw?: bigint | null;
    reserves?: string[];
    oracle?: string;
    dataProvider?: string;
    /** The implementation has liquidationCall — a drop-in for AaveVenue / LiquidationExecutor. */
    liquidatable?: boolean;
};

export async function checkAavePool(
    provider: JsonRpcProvider,
    poolAddr: string,
    expect: { addressesProvider?: string; dataProvider?: string } = {},
): Promise<AaveIdentity> {
    const c = new Collector();
    const pool = getAddress(poolAddr);
    const out: AaveIdentity = { ok: false, findings: c.findings };

    const own = await code(provider, pool);
    if (own === '0x') { c.fail(`no contract at ${pool} — wrong address, or wrong chain`); return out; }

    const ap = (await view(provider, pool, POOL, 'ADDRESSES_PROVIDER'))?.[0] as string | undefined;
    if (!ap) { c.fail(`has code but no ADDRESSES_PROVIDER() — not an Aave V3 Pool`); return out; }
    const back = (await view(provider, ap, AP, 'getPool'))?.[0] as string | undefined;
    if (!back || getAddress(back) !== pool) { c.fail(`AddressesProvider ${ap} says its pool is ${back ?? '(nothing)'} — stale or wrong address`); return out; }
    out.addressesProvider = getAddress(ap);
    out.marketId = (await view(provider, ap, AP, 'getMarketId'))?.[0] as string | undefined;
    c.pass(`AddressesProvider ${out.addressesProvider} confirms the Pool${out.marketId ? ` (market "${out.marketId}")` : ''}`);
    if (expect.addressesProvider) {
        if (getAddress(expect.addressesProvider) === out.addressesProvider) c.pass('matches the expected AddressesProvider');
        else c.fail(`AddressesProvider is ${out.addressesProvider}, not the expected ${expect.addressesProvider}`);
    }

    const premiumRaw = (await view(provider, pool, POOL, 'FLASHLOAN_PREMIUM_TOTAL'))?.[0] as bigint | undefined;
    out.premiumRaw = premiumRaw ?? null;
    out.premium = premiumRaw != null ? Number(premiumRaw) / 10_000 : null;
    if (out.premium != null) c.pass(`flash-loan premium ${(out.premium * 100).toFixed(4)}%`);
    else c.warn('FLASHLOAN_PREMIUM_TOTAL unreadable');

    const list = (await view(provider, pool, POOL, 'getReservesList'))?.[0] as string[] | undefined;
    if (!list) c.fail('getReservesList() failed');
    else {
        out.reserves = [...list].map(a => getAddress(a));
        if (out.reserves.length) c.pass(`${out.reserves.length} reserves`);
        else c.warn('no reserves listed — an empty market');
    }

    const oracle = (await view(provider, ap, AP, 'getPriceOracle'))?.[0] as string | undefined;
    if (!oracle || oracle === ZERO) c.fail('AddressesProvider has no price oracle — liquidations cannot be priced');
    else {
        out.oracle = getAddress(oracle);
        const price = out.reserves?.length ? (await view(provider, oracle, ORACLE, 'getAssetPrice', [out.reserves[0]]))?.[0] as bigint | undefined : undefined;
        if (price != null && price > 0n) c.pass(`oracle ${out.oracle} prices reserves`);
        else if (out.reserves?.length) c.warn(`oracle ${out.oracle} did not price ${out.reserves[0]}`);
    }

    const dp = (await view(provider, ap, AP, 'getPoolDataProvider'))?.[0] as string | undefined;
    if (dp && dp !== ZERO) out.dataProvider = getAddress(dp);
    if (expect.dataProvider) {
        if (out.dataProvider && getAddress(expect.dataProvider) === out.dataProvider) c.pass('matches the expected data provider');
        else c.fail(`data provider is ${out.dataProvider ?? '(none)'}, not the expected ${expect.dataProvider}`);
    }

    const logic = await logicCode(provider, pool, own);
    // liquidationCall's selector is 0x00a718a9 — solc pushes it as PUSH3 (hasSelector
    // handles that); the aligned-bytes scan is the fallback for other encodings.
    const LC = 'liquidationCall(address,address,address,uint256,bool)';
    out.liquidatable = hasSelector(logic.code, selectorOf(LC)) || mentions(logic.code, LC);
    if (out.liquidatable) c.pass(`liquidationCall(address,address,address,uint256,bool) in the ${logic.impl ? `implementation ${logic.impl}` : 'Pool'}`);
    else c.warn(`no Aave liquidationCall in the ${logic.impl ? `implementation ${logic.impl}` : 'Pool'} — a fork with its own liquidation; AaveVenue cannot liquidate here`);

    out.ok = c.ok;
    return out;
}

// ---- Morpho Blue ---------------------------------------------------------------

export type MorphoIdentity = CheckResult & {
    /** 0..3 Morpho Blue market selectors present (2+ = Morpho Blue, fewer = a fork). */
    marketSurface?: number;
    liquidatable?: boolean;
};

export async function checkMorpho(provider: JsonRpcProvider, addr: string): Promise<MorphoIdentity> {
    const c = new Collector();
    const morpho = getAddress(addr);
    const out: MorphoIdentity = { ok: false, findings: c.findings };
    const own = await code(provider, morpho);
    if (own === '0x') { c.fail(`no contract at ${morpho} — wrong address, or wrong chain`); return out; }
    const has = (sig: string) => hasSelector(own, selectorOf(sig));

    if (!has('flashLoan(address,uint256,bytes)')) { c.fail('no flashLoan(address,uint256,bytes) — not a Morpho Blue singleton'); return out; }
    c.pass('flashLoan(address token, uint256 assets, bytes data) in its dispatcher');
    if (mentions(own, 'onMorphoFlashLoan(uint256,bytes)')) c.pass('calls back onMorphoFlashLoan(uint256,bytes) — FlashArbExecutor\'s SOURCE_MORPHO callback');
    else c.fail('does not call onMorphoFlashLoan(uint256,bytes) — FlashArbExecutor\'s Morpho callback would never run');

    out.marketSurface = ['idToMarketParams(bytes32)', 'createMarket((address,address,address,address,uint256))', 'feeRecipient()'].filter(has).length;
    if (out.marketSurface >= 2) c.pass(`Morpho Blue market surface present (${out.marketSurface}/3 selectors)`);
    else c.warn(`only ${out.marketSurface}/3 Morpho Blue market selectors — a fork`);

    out.liquidatable = has('liquidate((address,address,address,address,uint256),address,uint256,uint256,bytes)');
    if (out.liquidatable) c.pass('liquidate(MarketParams,…) present — MorphoVenue can liquidate here');
    else c.warn('no Morpho Blue liquidate() — flash loans only');

    out.ok = c.ok;
    return out;
}

// ---- Compound III (Comet) ------------------------------------------------------

const COMET = new Interface([
    'function baseToken() view returns (address)',
    'function baseTokenPriceFeed() view returns (address)',
    'function numAssets() view returns (uint8)',
    'function getAssetInfo(uint8 i) view returns ((uint8 offset, address asset, address priceFeed, uint64 scale, uint64 borrowCollateralFactor, uint64 liquidateCollateralFactor, uint64 liquidationFactor, uint128 supplyCap))',
    'function getPrice(address priceFeed) view returns (uint256)',
    'function isLiquidatable(address account) view returns (bool)',
]);
const ERC20 = new Interface(['function symbol() view returns (string)']);

export type CometIdentity = CheckResult & { base?: string; baseSymbol?: string; numAssets?: number; liquidatable?: boolean };

export async function checkComet(provider: JsonRpcProvider, addr: string): Promise<CometIdentity> {
    const c = new Collector();
    const comet = getAddress(addr);
    const out: CometIdentity = { ok: false, findings: c.findings };
    const own = await code(provider, comet);
    if (own === '0x') { c.fail(`no contract at ${comet} — wrong address, or wrong chain`); return out; }

    const base = (await view(provider, comet, COMET, 'baseToken'))?.[0] as string | undefined;
    if (!base) { c.fail('no baseToken() — not a Comet'); return out; }
    out.base = getAddress(base);
    out.baseSymbol = (await view(provider, base, ERC20, 'symbol'))?.[0] as string | undefined;
    c.pass(`base ${out.baseSymbol ?? '?'} ${out.base}`);

    const n = (await view(provider, comet, COMET, 'numAssets'))?.[0];
    if (n == null) c.fail('numAssets() failed');
    else {
        out.numAssets = Number(n);
        const a0 = out.numAssets > 0 ? (await view(provider, comet, COMET, 'getAssetInfo', [0]))?.[0] : null;
        if (out.numAssets === 0) c.warn('no collateral assets');
        else if (a0) c.pass(`${out.numAssets} collateral asset(s); getAssetInfo decodes`);
        else c.fail(`getAssetInfo(0) did not decode — a Comet with a different AssetInfo layout`);
    }

    const feed = (await view(provider, comet, COMET, 'baseTokenPriceFeed'))?.[0] as string | undefined;
    const price = feed ? (await view(provider, comet, COMET, 'getPrice', [feed]))?.[0] as bigint | undefined : undefined;
    if (price != null && price > 0n) c.pass('base price feed answers');
    else c.fail('getPrice(baseTokenPriceFeed) failed — health cannot be computed');

    const liq = await view(provider, comet, COMET, 'isLiquidatable', ['0x0000000000000000000000000000000000000001']);
    if (liq) c.pass('isLiquidatable(account) answers');
    else c.fail('isLiquidatable(account) failed');

    const logic = await logicCode(provider, comet, own);
    out.liquidatable = hasSelector(logic.code, selectorOf('absorb(address,address[])'))
        && hasSelector(logic.code, selectorOf('buyCollateral(address,uint256,uint256,address)'));
    if (out.liquidatable) c.pass('absorb / buyCollateral present');
    else c.warn(`absorb / buyCollateral not found in the ${logic.impl ? 'implementation' : 'Comet'} bytecode`);

    out.ok = c.ok;
    return out;
}
