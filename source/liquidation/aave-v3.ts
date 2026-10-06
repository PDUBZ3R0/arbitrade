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

export type RawLog = { topics: readonly string[]; data: string; blockNumber: number };

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
};

export type AaveMarket = {
    pool: string;        // lowercase
    oracle: string;      // lowercase
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

    const [or] = await multicall3(provider, [
        { target: addressesProvider, allowFailure: true, callData: PROVIDER_IFACE.encodeFunctionData('getPriceOracle', []) },
    ]);
    if (!or?.success || or.returnData === '0x') throw new Error(`getPriceOracle() failed on addresses provider ${addressesProvider}`);
    const oracle = (PROVIDER_IFACE.decodeFunctionResult('getPriceOracle', or.returnData)[0] as string).toLowerCase();

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
        const decimals = de?.success && de.returnData !== '0x'
            ? Number(ERC20_IFACE.decodeFunctionResult('decimals', de.returnData)[0]) : 18;
        reserves.push({ asset, id, symbol: sy?.success ? decodeSymbol(sy.returnData) : '?', decimals, bonusBps });
    });

    return {
        pool: pool.toLowerCase(), oracle, baseUnit, reserves,
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
 * getUserAccountData + getUserConfiguration for `users`, `batchSize` accounts
 * per eth_call, `concurrency` calls in flight. Every account in one batch is
 * read at the same block; pass `blockTag` to pin all batches to one block so
 * a tick's prices and health factors agree.
 *
 * Accounts whose calls fail are omitted from the result (and counted), never
 * returned with made-up zeros — a zero HF would look liquidatable.
 *
 * WHEN A WHOLE BATCH FAILS. getUserAccountData loops every reserve and asks
 * the oracle for each price, so it is expensive (~100k+ gas on a 14-reserve
 * market) and public endpoints cap eth_call gas well below what 100 of them
 * need. Running out of gas inside aggregate3 reverts with NO data ("missing
 * revert data"), which is what the first Optimism run hit. So a failed batch
 * is split in half and retried, down to single accounts, and the batch size
 * that worked is carried forward (`batchSize` in the result) so the next
 * batches — and, via HealthMonitor, the next ticks — start at the size the
 * endpoint accepts instead of rediscovering it. Rate limits and timeouts are
 * retried at the same size first; they say nothing about the batch.
 *
 * STATE ERRORS ARE NOT SIZE ERRORS. "historical state … is not available" /
 * "Unknown state. First available state is …" / "missing trie node" mean the
 * node no longer (or does not yet) hold state for the pinned `blockTag`. On
 * Arbitrum's public RPC — 4 blocks/s, a few seconds of state kept — a sweep
 * pinned to a block from before a 13s subgraph seed hit exactly this, and
 * bisection shrank the batch to 1 account per call for nothing. Such an error
 * drops the pin: the batch, and every later one in this call, is read at
 * `latest` (`unpinned` in the result). Each batch is still one atomic read.
 */
const TRANSIENT_RE = /(rate limit|too many requests|429|timeout|timed out|ETIMEDOUT|ECONNRESET|EAI_AGAIN|502|503|504|gateway)/i;
export const STATE_RE = /(historical state|state .{0,80}not available|unknown state|first available state|missing trie node|header not found|unknown block|block not found|pruned)/i;

export async function readAccounts(
    provider: JsonRpcProvider,
    pool: string,
    users: string[],
    opts: { batchSize?: number; concurrency?: number; blockTag?: number; log?: (s: string) => void } = {},
): Promise<{ accounts: AccountData[]; failed: number; calls: number; batchSize: number; errors: string[]; unpinned: boolean }> {
    let size = Math.max(1, opts.batchSize ?? 100);
    let blockTag: number | undefined = opts.blockTag;
    let unpinned = false;
    const concurrency = opts.concurrency ?? 4;
    const log = opts.log ?? (() => {});
    const accounts: AccountData[] = [];
    const errors: string[] = [];
    let failed = 0, calls = 0, cursor = 0, ok = 0;

    const decode = (batch: string[], res: Awaited<ReturnType<typeof multicall3>>) => {
        batch.forEach((user, i) => {
            const a = res[3 * i], c = res[3 * i + 1], m = res[3 * i + 2];
            if (!a?.success || a.returnData === '0x' || !c?.success || c.returnData === '0x') { failed++; return; }
            try {
                const d = POOL_IFACE.decodeFunctionResult('getUserAccountData', a.returnData);
                accounts.push({
                    user: user.toLowerCase(),
                    collateralBase: d[0] as bigint,
                    debtBase: d[1] as bigint,
                    liqThresholdBps: Number(d[3]),
                    hf: d[5] as bigint,
                    config: POOL_IFACE.decodeFunctionResult('getUserConfiguration', c.returnData)[0] as bigint,
                    // getUserEMode failing (a fork without eMode) is not an account failure.
                    eMode: m?.success && m.returnData !== '0x' ? Number(POOL_IFACE.decodeFunctionResult('getUserEMode', m.returnData)[0]) : 0,
                });
            } catch { failed++; }
        });
    };

    const read = async (batch: string[]): Promise<void> => {
        const callList: Multicall3Call[] = [];
        for (const u of batch) {
            callList.push({ target: pool, allowFailure: true, callData: POOL_IFACE.encodeFunctionData('getUserAccountData', [u]) });
            callList.push({ target: pool, allowFailure: true, callData: POOL_IFACE.encodeFunctionData('getUserConfiguration', [u]) });
            callList.push({ target: pool, allowFailure: true, callData: POOL_IFACE.encodeFunctionData('getUserEMode', [u]) });
        }
        let lastMsg = '';
        for (let attempt = 0; attempt < 4; attempt++) {
            try {
                calls++;
                decode(batch, await multicall3(provider, callList, blockTag));
                ok++;
                return;
            } catch (err) {
                const e = err as any;
                lastMsg = `${e?.shortMessage ?? e?.message ?? String(err)} ${e?.info?.error?.message ?? e?.error?.message ?? ''}`.trim();
                if (STATE_RE.test(lastMsg)) {
                    if (blockTag == null) break;   // already unpinned: a real failure
                    if (!unpinned) log(`  [i] node has no state for block ${blockTag} (${lastMsg.slice(0, 60)}); reading at latest`);
                    blockTag = undefined; unpinned = true;
                    continue;
                }
                if (!TRANSIENT_RE.test(lastMsg)) break;
                await new Promise(r => setTimeout(r, 1000 * 2 ** attempt));
            }
        }
        if (batch.length === 1) {
            // Single accounts failing before ANY call has worked means the
            // endpoint is broken, not the batch: stop instead of issuing one
            // doomed call per account across the whole watchlist.
            if (ok === 0 && failed >= 3) throw new Error(`account reads failing on every call: ${lastMsg.slice(0, 200)}`);
            failed++;
            if (errors.length < 5) errors.push(`${batch[0]}: ${lastMsg.slice(0, 120)}`);
            return;
        }
        // A state error at `latest` is not a batch-size problem either.
        if (STATE_RE.test(lastMsg)) {
            failed += batch.length;
            if (errors.length < 5) errors.push(`${batch.length} accounts: ${lastMsg.slice(0, 120)}`);
            return;
        }
        const half = Math.ceil(batch.length / 2);
        if (half < size) {
            size = half;
            log(`  [i] batch of ${batch.length} rejected (${lastMsg.slice(0, 60)}); reading ${size} accounts per call from here`);
        }
        // Re-read in chunks of the CURRENT size, which may shrink further while
        // we go — once 5 is known to work, the rest of this batch should not
        // be retried at 18 and 9 again.
        for (let i = 0; i < batch.length;) {
            const chunk = batch.slice(i, i + Math.min(size, half));
            i += chunk.length;
            await read(chunk);
        }
    };

    const worker = async () => {
        while (cursor < users.length) {
            const batch = users.slice(cursor, cursor + size);
            cursor += batch.length;
            await read(batch);
        }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, Math.ceil(users.length / size)) }, worker));
    return { accounts, failed, calls, batchSize: size, errors, unpinned };
}
