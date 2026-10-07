// -----------------------------------------------------------------------------
// A liquidation VENUE: one lending protocol deployment the watcher can track
// and the executor can liquidate on.
//
//   aave-v3       one Pool; account = borrower address
//   morpho-blue   the Morpho singleton; account = `${borrower}:${marketId}`
//   compound-v3   every Comet on the chain; account = `${borrower}:${comet}`
//
// HealthMonitor, the event feed and liq-watch only ever talk to this
// interface, so the tiering, triggers, rolling sweep, dust floor and backoff
// are shared code, not three copies.
//
// Every venue reports accounts in the same shape (VenueAccount):
//
//   hf              WAD; < 1e18 = liquidatable; MAX_UINT = no debt
//   collateralBase  USD value (venue.baseUnit), or null when the venue cannot
//   debtBase        price the asset in USD — never 0 as a stand-in, because a
//                   0 would make the account look idle or like dust
//   config          exposure bitmask: bit i set = this account's health moves
//                   with price key i (see priceKeys). A price change re-reads
//                   exactly the accounts whose mask intersects it.
//   eMode           venue-specific small integer (Aave eMode category), else 0
// -----------------------------------------------------------------------------

export type VenueKind = 'aave-v3' | 'morpho-blue' | 'compound-v3' | 'compound-v2' | 'euler-v2';

export type VenueAccount = {
    user: string;
    collateralBase: bigint | null;
    debtBase: bigint | null;
    /** Weighted liquidation threshold, bps (informational; 0 when not meaningful). */
    liqThresholdBps: number;
    hf: bigint;
    config: bigint;
    eMode: number;
};

export type ReadResult = {
    accounts: VenueAccount[];
    failed: number;
    calls: number;
    /** Accounts per eth_call that the endpoint accepted (carried into later reads). */
    batchSize: number;
    errors: string[];
    unpinned: boolean;
};

export type ReadOptions = { batchSize?: number; concurrency?: number; blockTag?: number; log?: (s: string) => void };

/** Raw log in the shape both transports (eth_getLogs, HyperSync) normalise to. */
export type RawLog = { address?: string; topics: readonly string[]; data: string; blockNumber: number };

export type VenueEvent = {
    /** Account key in this venue's format. */
    account: string;
    /** Only borrow-type events ADD an account to the watchlist. */
    isBorrow: boolean;
    blockNumber: number;
};

export interface Venue {
    readonly kind: VenueKind;
    /** Short human label for logs ("Aave V3", "Morpho Blue", "Compound III"). */
    readonly label: string;
    /** DB key (LiqDB.pool) — lowercase, unique per venue on a chain. */
    readonly key: string;
    /** Unit of collateralBase / debtBase / maxProfitBase (1e8 = USD with 8 decimals). */
    readonly baseUnit: bigint;

    // --- discovery ---
    /** Contracts whose logs feed the watchlist. */
    readonly eventAddresses: string[];
    /** topic0s to subscribe to. */
    readonly eventTopics: string[];
    /** Account touched by a log, or null when it is not one of eventTopics. */
    decodeEvent(log: RawLog): VenueEvent | null;
    /** First block worth scanning when seeding from events (deploy block), if known. */
    readonly deployBlock?: number;

    // --- health ---
    /** Called once before the first read (load markets, reserves, …). */
    init(): Promise<void>;
    readPrices(blockTag?: number): Promise<Map<string, bigint>>;
    /** Exposure bit for each price key returned by readPrices. */
    priceMask(key: string): bigint;
    readAccounts(accounts: string[], opts?: ReadOptions): Promise<ReadResult>;
    /** Upper-ish estimate of what ONE liquidation call could pay (baseUnit), null if unknown. */
    maxProfitBase(a: Pick<VenueAccount, 'debtBase' | 'collateralBase' | 'config' | 'eMode'> & { hf: bigint | null; user?: string }): bigint | null;
    /** "collateral → debt" description for reports. */
    describe(a: Pick<VenueAccount, 'config' | 'user'>): string;
}

/** `${user}:${market}` <-> parts, for venues whose account is a (borrower, market) pair. */
export const accountKey = (user: string, market: string): string => `${user.toLowerCase()}:${market.toLowerCase()}`;
export const splitAccount = (key: string): { user: string; market: string } => {
    const i = key.indexOf(':');
    return i < 0 ? { user: key, market: '' } : { user: key.slice(0, i), market: key.slice(i + 1) };
};

/** Topic word -> lowercase address. */
export const topicAddr = (t: string | undefined): string | null =>
    t && t.length === 66 ? ('0x' + t.slice(26)).toLowerCase() : null;
