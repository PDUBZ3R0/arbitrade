// -----------------------------------------------------------------------------
// Aave V3 reserve state for flash-loan root tokens.
//
// WHY THIS EXISTS
//
// conf/<chain>.json5 lists flashloan.tokens by hand. Two things about that list
// are not static, and both fail silently:
//
//   1. Whether a reserve can be flash-borrowed at all. Aave governance flips
//      these flags. A hand-maintained (or hand-commented) list goes stale in
//      BOTH directions — you keep roots that were paused, and you lose roots
//      that were un-paused.
//
//   2. How much of it can be borrowed. A reserve can be flash-loan-enabled and
//      still hold almost nothing.
//
// Both matter more than they look, because of how triangle enumeration assigns
// roots. `seenCanonical` in triangles/enumerator.ts spans the whole run, so a
// triangle is stored exactly ONCE, rooted at whichever flashloan token the loop
// reached first — i.e. by position in the config file. On Sonic 71.5% of 3-hop
// triangles have more than one loanable vertex, so a dead or shallow token
// sitting early in the list does not merely waste its own slot: it claims the
// root slot for every triangle that had a live alternative, and those triangles
// are then only ever evaluated in a denomination we cannot actually borrow.
//
// So the fix is not to comment entries out. It is to order the list by live
// borrowable depth, so first-come dedup naturally prefers the best root.
//
// WHAT DISQUALIFIES A RESERVE
//
// From Aave V3 ValidationLogic.validateFlashloanSimple:
//
//     require(!configuration.getPaused(),          Errors.ReservePaused());
//     require(configuration.getActive(),           Errors.ReserveInactive());
//     require(configuration.getFlashLoanEnabled(), Errors.FlashloanDisabled());
//     require(IERC20(reserve.aTokenAddress).totalSupply() >= amount,
//                                                  Errors.InvalidAmount());
//
// Note what is NOT there: `frozen`. Freezing blocks supply and borrow; it has
// never gated flash loans. Aave's UI shows frozen reserves as locked, which is
// misleading for our purposes — a frozen reserve is still a perfectly good
// flash-loan root. We record `frozen` for visibility but never exclude on it.
//
// THE REAL CEILING
//
// The require above compares against aToken.totalSupply(), which counts supply
// that has since been borrowed out. The transfer itself comes from the aToken
// contract's underlying balance. So the largest flash loan that can actually
// succeed is min(aToken.totalSupply(), underlying.balanceOf(aToken)), and in
// practice the balance is the binding one. We report both and take the min.
// -----------------------------------------------------------------------------

import { JsonRpcProvider, Interface } from 'ethers';
import { multicall3, type Multicall3Call } from './multicall.ts';
import type { ChainConfig } from './config.ts';

// --- ABIs --------------------------------------------------------------------

const POOL_IFACE = new Interface([
    'function ADDRESSES_PROVIDER() view returns (address)',
    'function getConfiguration(address asset) view returns (uint256)',
]);

const PROVIDER_IFACE = new Interface([
    'function getPoolDataProvider() view returns (address)',
    'function getPriceOracle() view returns (address)',
]);

const DATA_PROVIDER_IFACE = new Interface([
    'function getReserveTokensAddresses(address asset) view returns (address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress)',
]);

const ORACLE_IFACE = new Interface([
    'function getAssetPrice(address asset) view returns (uint256)',
    'function BASE_CURRENCY_UNIT() view returns (uint256)',
]);

const ERC20_IFACE = new Interface([
    'function totalSupply() view returns (uint256)',
    'function balanceOf(address account) view returns (uint256)',
]);

// --- ReserveConfigurationMap bit layout --------------------------------------
//
// Verified against aave-v3-origin
// src/contracts/protocol/libraries/configuration/ReserveConfiguration.sol.
// These positions are frozen by storage-upgrade compatibility — Aave cannot
// move them without breaking every existing pool — so decoding the bitmask
// directly is more version-robust than calling a helper whose signature may
// change between revisions.

const BIT_DECIMALS = 48n;   // bits 48-55
const BIT_ACTIVE = 56n;
const BIT_FROZEN = 57n;
const BIT_BORROWING = 58n;
const BIT_PAUSED = 60n;
const BIT_FLASHLOAN = 63n;

const bit = (config: bigint, pos: bigint): boolean => ((config >> pos) & 1n) === 1n;

// --- types -------------------------------------------------------------------

export type AaveReserveState = {
    symbol: string;
    /** Underlying asset, lowercase. */
    address: string;
    /** Decimals as Aave records them. */
    decimals: number | null;
    /** Decimals as OUR config records them — a mismatch silently corrupts all sizing for this root. */
    configuredDecimals: number;
    decimalsMismatch: boolean;

    active: boolean | null;
    frozen: boolean | null;
    paused: boolean | null;
    borrowingEnabled: boolean | null;
    flashLoanEnabled: boolean | null;

    /**
     * Passes the three FLAG checks in validateFlashloanSimple. `frozen` is
     * deliberately not a disqualifier — see the module header.
     */
    flashLoanable: boolean;
    /** Which flag(s) disqualified it, for reporting. Empty when borrowable. */
    blockedBy: string[];

    aToken: string | null;
    /** What validateFlashloanSimple compares `amount` against. */
    aTokenTotalSupply: bigint | null;
    /** underlying.balanceOf(aToken) — what can actually be transferred. */
    availableLiquidity: bigint | null;
    /** min(totalSupply, availableLiquidity): the largest loan that can really succeed. */
    maxFlashLoan: bigint | null;

    /** Aave oracle price, in base-currency units. */
    priceBase: bigint | null;
    /** maxFlashLoan valued at the oracle price. Null if price or liquidity unknown. */
    maxFlashLoanUsd: number | null;

    error?: string;
};

export type AaveReserveSnapshot = {
    blockNumber: number;
    pool: string;
    dataProvider: string | null;
    priceOracle: string | null;
    baseCurrencyUnit: bigint | null;
    reserves: AaveReserveState[];
    /** Borrowable reserves, deepest first. This is the order flashloan.tokens should be in. */
    borrowableByDepth: AaveReserveState[];
    /** Configured tokens that cannot be flash-borrowed right now. */
    blocked: AaveReserveState[];
};

// --- fetch -------------------------------------------------------------------

/**
 * Read live Aave V3 reserve state for every token in cfg.flashloan.tokens.
 *
 * Four multicall round-trips (addresses provider -> data provider + oracle ->
 * per-asset config/aToken/price -> per-asset balances). This is startup-time
 * work, not per-block work; call it once and cache, or re-call on a TTL if the
 * orchestrator runs long enough for governance to act (hours, not seconds).
 *
 * Never throws for per-asset problems — a reserve that errors comes back with
 * `error` set and `flashLoanable: false`, so one bad entry in the config cannot
 * take down the run.
 */
export async function fetchAaveReserves(
    provider: JsonRpcProvider,
    cfg: ChainConfig,
): Promise<AaveReserveSnapshot> {
    const fl = cfg.flashloan;
    if (!fl) throw new Error(`No flashloan config for ${cfg.chain.name}`);
    if (fl.provider !== 'aave-v3') {
        throw new Error(`fetchAaveReserves only supports aave-v3; ${cfg.chain.name} is ${fl.provider}`);
    }
    const pool = fl.pool;
    if (!pool) throw new Error(`flashloan.pool is required for aave-v3 on ${cfg.chain.name}`);

    const tokens = fl.tokens ?? [];
    const blockNumber = await provider.getBlockNumber();

    // --- round 1: the addresses provider ------------------------------------
    let addressesProvider: string | null = fl.addressesProvider ?? null;
    if (!addressesProvider) {
        const [r] = await multicall3(provider, [{
            target: pool, allowFailure: true,
            callData: POOL_IFACE.encodeFunctionData('ADDRESSES_PROVIDER', []),
        }]);
        if (r?.success) {
            addressesProvider = POOL_IFACE.decodeFunctionResult('ADDRESSES_PROVIDER', r.returnData)[0] as string;
        }
    }

    // --- round 2: data provider + price oracle + base currency unit ---------
    let dataProvider: string | null = null;
    let priceOracle: string | null = null;
    let baseCurrencyUnit: bigint | null = null;

    if (addressesProvider) {
        const res = await multicall3(provider, [
            { target: addressesProvider, allowFailure: true, callData: PROVIDER_IFACE.encodeFunctionData('getPoolDataProvider', []) },
            { target: addressesProvider, allowFailure: true, callData: PROVIDER_IFACE.encodeFunctionData('getPriceOracle', []) },
        ]);
        if (res[0]?.success) dataProvider = PROVIDER_IFACE.decodeFunctionResult('getPoolDataProvider', res[0].returnData)[0] as string;
        if (res[1]?.success) priceOracle = PROVIDER_IFACE.decodeFunctionResult('getPriceOracle', res[1].returnData)[0] as string;

        if (priceOracle) {
            const [u] = await multicall3(provider, [{
                target: priceOracle, allowFailure: true,
                callData: ORACLE_IFACE.encodeFunctionData('BASE_CURRENCY_UNIT', []),
            }]);
            if (u?.success) {
                baseCurrencyUnit = ORACLE_IFACE.decodeFunctionResult('BASE_CURRENCY_UNIT', u.returnData)[0] as bigint;
            }
        }
    }

    // --- round 3: per-asset configuration, aToken address, price ------------
    // Index maps rather than fixed stride, so a missing data provider or oracle
    // means those calls are simply not made — no placeholder eth_calls.
    const calls3: Multicall3Call[] = [];
    const idxConfig = new Map<number, number>();
    const idxAToken = new Map<number, number>();
    const idxPrice = new Map<number, number>();

    tokens.forEach((t, i) => {
        idxConfig.set(i, calls3.length);
        calls3.push({ target: pool, allowFailure: true, callData: POOL_IFACE.encodeFunctionData('getConfiguration', [t.address]) });
        if (dataProvider) {
            idxAToken.set(i, calls3.length);
            calls3.push({ target: dataProvider, allowFailure: true, callData: DATA_PROVIDER_IFACE.encodeFunctionData('getReserveTokensAddresses', [t.address]) });
        }
        if (priceOracle) {
            idxPrice.set(i, calls3.length);
            calls3.push({ target: priceOracle, allowFailure: true, callData: ORACLE_IFACE.encodeFunctionData('getAssetPrice', [t.address]) });
        }
    });
    const res3 = await multicall3(provider, calls3);

    const decodeAt = <T>(
        results: typeof res3, idx: number | undefined,
        fn: (data: string) => T,
    ): T | null => {
        if (idx == null) return null;
        const r = results[idx];
        if (!r?.success || r.returnData === '0x') return null;
        try { return fn(r.returnData); } catch { return null; }
    };

    type Partial0 = {
        config: bigint | null; aToken: string | null; priceBase: bigint | null; error?: string;
    };
    const partials: Partial0[] = tokens.map((_, i) => {
        const config = decodeAt(res3, idxConfig.get(i),
            d => POOL_IFACE.decodeFunctionResult('getConfiguration', d)[0] as bigint);
        const aToken = decodeAt(res3, idxAToken.get(i),
            d => DATA_PROVIDER_IFACE.decodeFunctionResult('getReserveTokensAddresses', d)[0] as string);
        const priceBase = decodeAt(res3, idxPrice.get(i),
            d => ORACLE_IFACE.decodeFunctionResult('getAssetPrice', d)[0] as bigint);
        return {
            config, aToken, priceBase,
            error: config == null
                ? 'getConfiguration returned nothing — asset is probably not an Aave reserve on this chain'
                : undefined,
        };
    });

    // --- round 4: aToken totalSupply + underlying balance of aToken ---------
    const liqIndex = new Map<number, number>();  // token index -> call index
    const calls4: Multicall3Call[] = [];
    partials.forEach((p, i) => {
        if (!p.aToken) return;
        liqIndex.set(i, calls4.length);
        calls4.push({ target: p.aToken, allowFailure: true, callData: ERC20_IFACE.encodeFunctionData('totalSupply', []) });
        calls4.push({ target: tokens[i].address, allowFailure: true, callData: ERC20_IFACE.encodeFunctionData('balanceOf', [p.aToken]) });
    });
    const res4 = calls4.length ? await multicall3(provider, calls4) : [];

    // --- assemble -----------------------------------------------------------
    const reserves: AaveReserveState[] = tokens.map((t, i) => {
        const p = partials[i];
        const cfgBits = p.config;

        const active = cfgBits == null ? null : bit(cfgBits, BIT_ACTIVE);
        const frozen = cfgBits == null ? null : bit(cfgBits, BIT_FROZEN);
        const paused = cfgBits == null ? null : bit(cfgBits, BIT_PAUSED);
        const borrowingEnabled = cfgBits == null ? null : bit(cfgBits, BIT_BORROWING);
        const flashLoanEnabled = cfgBits == null ? null : bit(cfgBits, BIT_FLASHLOAN);
        const decimals = cfgBits == null ? null : Number((cfgBits >> BIT_DECIMALS) & 0xffn);

        const blockedBy: string[] = [];
        if (cfgBits == null) blockedBy.push('unreadable');
        else {
            if (paused) blockedBy.push('paused');
            if (!active) blockedBy.push('inactive');
            if (!flashLoanEnabled) blockedBy.push('flashloan-disabled');
        }

        let aTokenTotalSupply: bigint | null = null;
        let availableLiquidity: bigint | null = null;
        const ci = liqIndex.get(i);
        if (ci != null) {
            try {
                const ts = res4[ci];
                if (ts?.success && ts.returnData !== '0x') {
                    aTokenTotalSupply = ERC20_IFACE.decodeFunctionResult('totalSupply', ts.returnData)[0] as bigint;
                }
            } catch { /* leave null */ }
            try {
                const bal = res4[ci + 1];
                if (bal?.success && bal.returnData !== '0x') {
                    availableLiquidity = ERC20_IFACE.decodeFunctionResult('balanceOf', bal.returnData)[0] as bigint;
                }
            } catch { /* leave null */ }
        }

        let maxFlashLoan: bigint | null = null;
        if (aTokenTotalSupply != null && availableLiquidity != null) {
            maxFlashLoan = aTokenTotalSupply < availableLiquidity ? aTokenTotalSupply : availableLiquidity;
        } else {
            maxFlashLoan = aTokenTotalSupply ?? availableLiquidity;
        }

        // Value it with the Aave oracle rather than an external price feed: it's
        // on-chain, free, needs no API key or rate limit, is read atomically in
        // the same batch, and is the price Aave itself uses.
        let maxFlashLoanUsd: number | null = null;
        const dec = decimals ?? t.decimals;
        if (maxFlashLoan != null && p.priceBase != null && baseCurrencyUnit && baseCurrencyUnit > 0n) {
            maxFlashLoanUsd = (Number(maxFlashLoan) / 10 ** dec) * (Number(p.priceBase) / Number(baseCurrencyUnit));
        }

        return {
            symbol: t.symbol,
            address: t.address.toLowerCase(),
            decimals,
            configuredDecimals: t.decimals,
            decimalsMismatch: decimals != null && decimals !== t.decimals,
            active, frozen, paused, borrowingEnabled, flashLoanEnabled,
            flashLoanable: blockedBy.length === 0,
            blockedBy,
            aToken: p.aToken ? p.aToken.toLowerCase() : null,
            aTokenTotalSupply, availableLiquidity, maxFlashLoan,
            priceBase: p.priceBase, maxFlashLoanUsd,
            error: p.error,
        };
    });

    const borrowableByDepth = reserves
        .filter(r => r.flashLoanable)
        .sort((a, b) => {
            // Prefer USD depth. Reserves with no price fall back to raw units,
            // which only orders them against each other, and after anything
            // priced — an unpriced reserve is not a confident root choice.
            const av = a.maxFlashLoanUsd, bv = b.maxFlashLoanUsd;
            if (av != null && bv != null) return bv - av;
            if (av != null) return -1;
            if (bv != null) return 1;
            const ar = a.maxFlashLoan ?? 0n, br = b.maxFlashLoan ?? 0n;
            return ar === br ? 0 : (br > ar ? 1 : -1);
        });

    return {
        blockNumber,
        pool,
        dataProvider: dataProvider ? dataProvider.toLowerCase() : null,
        priceOracle: priceOracle ? priceOracle.toLowerCase() : null,
        baseCurrencyUnit,
        reserves,
        borrowableByDepth,
        blocked: reserves.filter(r => !r.flashLoanable),
    };
}

/**
 * Largest flash loan that can actually succeed for `asset`, from a snapshot.
 * Returns 0n when the asset is not borrowable, so callers can treat "blocked"
 * and "no liquidity" the same way: there is no size that works.
 *
 * Intended as a SECOND ceiling alongside the DEX-reserve clamp in
 * orchestrator/build-hops.ts (MAX_INPUT_FRACTION_BPS). Those bound different
 * failures: the DEX clamp stops a pair's uint112 reserves overflowing, this one
 * stops the flash loan reverting before any swap runs. Take the min of both.
 */
export function maxFlashLoanFor(snapshot: AaveReserveSnapshot, asset: string): bigint {
    const r = snapshot.reserves.find(x => x.address === asset.toLowerCase());
    if (!r || !r.flashLoanable) return 0n;
    return r.maxFlashLoan ?? 0n;
}
