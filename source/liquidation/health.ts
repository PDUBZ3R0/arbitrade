// -----------------------------------------------------------------------------
// Health-factor monitor: decides WHICH accounts to re-read each block, reads
// them, and reports tier transitions.
//
// TIERS (HF as Aave reports it, WAD)
//
//   liquidatable   HF < 1.0                 re-read every tick
//   near           HF < nearHF   (1.05)     re-read every tick
//   watch          HF < watchHF  (1.25)     re-read every `watchEvery` ticks
//   far            HF >= watchHF            re-read on triggers only
//   idle           no debt                  re-read only on its own Pool event
//
// TRIGGERS (what makes an account re-read outside its cadence)
//
//   own event      any Pool event naming the account (supply, borrow, repay,
//                  withdraw, collateral toggle, eMode, liquidation)
//   price move     the Aave oracle price of a reserve the account borrows or
//                  uses as collateral changed since the last tick. Exposure
//                  comes from the account's live UserConfiguration bitmap.
//                  Accounts above `priceRecheckMaxHF` (2.0) skip small moves —
//                  they need a ~50% move to become liquidatable — unless the
//                  asset has moved more than `bigMoveFrac` (10%) since the
//                  last full sweep, which re-reads every exposed account.
//   rolling sweep  every account with debt, once per `sweepMs` (10 min),
//                  spread across ticks: each tick reads the next slice, sized
//                  by the time since the last tick, so the whole set is covered
//                  per period without ever stalling the loop. (The first,
//                  startup sweep is a single full pass.) Catches what events
//                  and prices cannot: interest accrual, aToken transfers out of
//                  a borrower (no Pool event), and eMode or liquidation-
//                  threshold changes by governance.
//
// DUST is decided by what a liquidation could PAY, not by debt size. A
// liquidator repays debt and receives collateral worth (repaid x bonus), so
// the most any liquidation of an account can earn is
//
//     seizable = min(collateral, debt x bonus)        (close factor taken as 100%)
//     maxProfit = seizable x (bonus - 1) / bonus      (before gas / swap / flash fee)
//
// with `bonus` the highest liquidation bonus among the account's collateral
// assets. This is an UPPER bound, so it never hides a real opportunity. It
// also catches what a debt floor misses: bad debt — $500 owed against $2 of
// collateral — pays at most cents however large the debt. Accounts under
// `minProfitUsd` get NO per-tick tier reads and NO price-triggered reads, only
// their own events and the rolling sweep. On Optimism's first run 6,481 of the
// 6,569 accounts under HF 1.05 were crumbs, and reading them every block made
// each tick take ~12s against 2s blocks.
//
// Prices are read through the venue's own oracle(s) — the exact numbers its
// liquidation check uses (Aave: ONE getAssetsPrices call; Morpho: each market's
// oracle; Comet: its price feeds) — so a price trigger works for every source
// type (Chainlink, exchange-rate adapters, fixed prices) without subscribing
// to feed events.
//
// VENUES. The monitor is protocol-agnostic: it talks to a Venue (venue.ts).
// Passing an AaveMarket (the original signature) wraps it in an AaveVenue.
//
// Every read in a tick is pinned to the same block, so prices and health
// factors describe one consistent state.
// -----------------------------------------------------------------------------

import type { JsonRpcProvider } from 'ethers';
import { AaveVenue, type AaveMarket } from './aave-v3.ts';
import type { Venue, VenueAccount } from './venue.ts';
import type { LiqDB, Tier } from './watchlist-db.ts';

type AccountData = VenueAccount;

export const WAD = 10n ** 18n;
export const MAX_UINT = (1n << 256n) - 1n;
/** Aave v3.3 LiquidationLogic.CLOSE_FACTOR_HF_THRESHOLD: below it a liquidator may repay 100%. */
export const CLOSE_FACTOR_HF = 95n * 10n ** 16n;

/** 1.05 -> 1.05e18, exact to 6 decimal places. */
export const wad = (x: number): bigint => BigInt(Math.round(x * 1e6)) * 10n ** 12n;

export type HealthOptions = {
    nearHF?: number;            // default 1.05
    watchHF?: number;           // default 1.25
    priceRecheckMaxHF?: number; // default 2.0
    bigMoveFrac?: number;       // default 0.10
    watchEvery?: number;        // ticks, default 10
    sweepMs?: number;           // default 600_000
    batchSize?: number;         // accounts per eth_call, default 100
    concurrency?: number;       // eth_calls in flight, default 4
    minProfitUsd?: number;      // dust floor: max liquidation profit, default 0 (off)
};

export type AccountState = {
    user: string;
    hf: bigint | null;
    collateralBase: bigint | null;
    debtBase: bigint | null;
    config: bigint;
    /** eMode category, 0 = none. */
    eMode: number;
    tier: Tier | null;
    checkedBlock: number | null;
};

export type Transition = { user: string; from: Tier | null; to: Tier; account: AccountData };

export type TickReport = {
    block: number;
    read: number;               // accounts re-read
    calls: number;              // account eth_calls (plus 1 for prices)
    failed: number;
    movedAssets: string[];
    sweep: boolean;
    reasons: Record<'event' | 'tier' | 'price' | 'bigMove' | 'sweep', number>;
    /** This tick finished a rolling-sweep cycle (every account with debt read since the last one). */
    sweepCompleted: boolean;
    transitions: Transition[];
};

export class HealthMonitor {
    readonly accounts = new Map<string, AccountState>();
    private lastPrices: Map<string, bigint> | null = null;
    private sweepBasePrices: Map<string, bigint> | null = null;
    private lastTickAt = 0;
    private inited = false;
    private sweepQueue: string[] = [];
    private sweepCursor = 0;
    private ticks = 0;
    /** maxProfit below this (base units) is dust: see header. */
    readonly dustBase: bigint;
    readonly nearHF: bigint;
    readonly watchHF: bigint;
    readonly priceRecheckMaxHF: bigint;
    private readonly opts: Required<HealthOptions>;
    // Plain fields, not constructor parameter properties: --experimental-strip-types
    // rejects parameter properties (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX).
    private readonly provider: JsonRpcProvider;
    readonly venue: Venue;
    private readonly db: LiqDB;
    private readonly now: () => number;
    /** Progress / diagnostics sink. Silent by default; the CLI sets console.log. */
    log: (s: string) => void = () => {};

    constructor(
        provider: JsonRpcProvider,
        venue: Venue | AaveMarket,
        db: LiqDB,
        opts: HealthOptions = {},
        /** Injectable clock, for tests. */
        now: () => number = Date.now,
    ) {
        this.provider = provider;
        this.venue = 'reserves' in venue ? new AaveVenue(provider, venue) : venue;
        this.db = db;
        this.now = now;
        this.opts = {
            nearHF: 1.05, watchHF: 1.25, priceRecheckMaxHF: 2.0, bigMoveFrac: 0.10,
            watchEvery: 10, sweepMs: 600_000, batchSize: 100, concurrency: 4, minProfitUsd: 0,
            ...Object.fromEntries(Object.entries(opts).filter(([, v]) => v != null)),
        } as Required<HealthOptions>;
        this.nearHF = wad(this.opts.nearHF);
        this.watchHF = wad(this.opts.watchHF);
        this.priceRecheckMaxHF = wad(this.opts.priceRecheckMaxHF);
        this.dustBase = BigInt(Math.round(this.opts.minProfitUsd * 1e6)) * this.venue.baseUnit / 1_000_000n;
        this.load();
    }

    /** (Re)load every tracked account from the DB — call after a backfill adds accounts. */
    load(): void {
        for (const r of this.db.accounts()) {
            const prev = this.accounts.get(r.user);
            if (prev) continue;
            this.accounts.set(r.user, {
                user: r.user, hf: r.hf, collateralBase: r.collateralBase, debtBase: r.debtBase,
                config: r.config ?? 0n, eMode: r.eMode ?? 0, tier: r.tier, checkedBlock: r.checkedBlock,
            });
        }
    }

    /** The Aave market, when this monitor watches Aave (back-compat for callers that read it). */
    get market(): AaveMarket { return (this.venue as AaveVenue).market; }

    tierOf(a: Pick<AccountData, 'hf' | 'debtBase'>): Tier {
        if (a.debtBase === 0n || a.hf === MAX_UINT) return 'idle';
        if (a.hf < WAD) return 'liquidatable';
        if (a.hf < this.nearHF) return 'near';
        if (a.hf < this.watchHF) return 'watch';
        return 'far';
    }

    /**
     * Re-read `users`, persist, and return tier changes. `pin` reads at
     * `block` (ticks: prices and HFs from one state); unpinned reads at latest
     * (the startup sweep, which can outlast a fast chain's state window).
     */
    async refresh(users: Iterable<string>, block: number, pin = true): Promise<{ transitions: Transition[]; read: number; calls: number; failed: number }> {
        const list = [...new Set(users)];
        if (list.length === 0) return { transitions: [], read: 0, calls: 0, failed: 0 };
        const { accounts, failed, calls, batchSize, errors } = await this.venue.readAccounts(list, {
            batchSize: this.opts.batchSize, concurrency: this.opts.concurrency, blockTag: pin ? block : undefined, log: this.log,
        });
        // Keep the size the endpoint accepted, so later ticks don't rediscover the cap.
        this.opts.batchSize = batchSize;
        for (const e of errors) this.log(`  [!] account read failed: ${e}`);
        const transitions: Transition[] = [];
        const rows = [];
        for (const a of accounts) {
            const tier = this.tierOf(a);
            const prev = this.accounts.get(a.user);
            if (prev?.tier !== tier) transitions.push({ user: a.user, from: prev?.tier ?? null, to: tier, account: a });
            this.accounts.set(a.user, {
                user: a.user, hf: a.hf, collateralBase: a.collateralBase, debtBase: a.debtBase,
                config: a.config, eMode: a.eMode, tier, checkedBlock: block,
            });
            rows.push({ user: a.user, hf: a.hf, collateralBase: a.collateralBase, debtBase: a.debtBase, config: a.config, eMode: a.eMode, tier });
        }
        this.db.saveHealth(rows, block);
        return { transitions, read: accounts.length, calls, failed };
    }

    /** Estimated most that ONE liquidation call on `a` could pay (base units); the venue decides how. */
    maxProfitBase(a: Pick<AccountState, 'debtBase' | 'collateralBase' | 'config' | 'eMode' | 'hf'> & { user?: string }): bigint | null {
        return this.venue.maxProfitBase(a);
    }

    /** Known to be unable to pay `minProfitUsd`. Never-read accounts are not dust. */
    isDust(a: AccountState): boolean {
        if (this.dustBase === 0n) return false;
        const p = this.maxProfitBase(a);
        return p != null && p < this.dustBase;
    }

    /** Accounts the sweep covers: everything not known to be idle. */
    private sweepable(): string[] {
        return [...this.accounts.values()].filter(a => a.tier !== 'idle').map(a => a.user);
    }

    /**
     * One full pass over every account with debt (or never read). Idle
     * accounts are skipped: they can only gain debt through a Borrow, which
     * marks them dirty. Used at startup; afterwards tick() sweeps incrementally.
     */
    async sweep(block: number, dirty: Iterable<string> = []): Promise<TickReport> {
        this.load();
        if (!this.inited) { await this.venue.init(); this.inited = true; }
        const set = new Set(this.sweepable());
        const swept = set.size;
        for (const u of dirty) set.add(u);   // event-touched idle accounts are not in the sweep set
        // Unpinned: on 0.25s blocks a 70s sweep outlives the RPC's state window.
        const r = await this.refresh(set, block, false);
        // Prices AFTER the accounts: venues that discover markets while reading
        // accounts (Morpho) only then know which prices exist. Read first, the
        // reference would be empty and the first tick would re-read everyone.
        const prices = await this.venue.readPrices();
        this.lastPrices = prices;
        this.sweepBasePrices = new Map(prices);
        this.lastTickAt = this.now();
        this.sweepQueue = this.sweepable();
        this.sweepCursor = 0;
        return {
            block, read: r.read, calls: r.calls + 1, failed: r.failed, movedAssets: [], sweep: true,
            reasons: { event: set.size - swept, tier: 0, price: 0, bigMove: 0, sweep: swept },
            sweepCompleted: true, transitions: r.transitions,
        };
    }

    /**
     * One block's work. `dirty` = accounts named by Pool events since the last
     * tick (LiqDB.applyEvents' return). The first tick is a full sweep.
     */
    async tick(block: number, dirty: Iterable<string> = []): Promise<TickReport> {
        this.ticks++;
        if (!this.lastPrices) return this.sweep(block, dirty);
        this.load();   // accounts a backfill/tail inserted since the last tick

        let prices: Map<string, bigint>;
        try { prices = await this.venue.readPrices(block); }
        catch {
            // The pinned read failed: the block is pruned, or (Optimism, intermittently)
            // the backend that took the call has not seen it yet and answers with an
            // empty revert. One price read is cheap: retry at latest rather than lose
            // the tick. A failure there is real and propagates.
            prices = await this.venue.readPrices();
        }
        const moved: string[] = [];
        let movedMask = 0n, bigMask = 0n;
        for (const [key, p] of prices) {
            const last = this.lastPrices.get(key), base = this.sweepBasePrices?.get(key);
            const mask = this.venue.priceMask(key);
            if (last !== p) { moved.push(key); movedMask |= mask; }
            if (base != null && base > 0n) {
                // |p/base - 1| > bigMoveFrac, in integers: |p - base| * 1e6 > base * frac * 1e6
                const diff = p > base ? p - base : base - p;
                if (diff * 1_000_000n > base * BigInt(Math.round(this.opts.bigMoveFrac * 1e6))) {
                    bigMask |= mask;
                    // Every exposed account is re-read below at price p, so p is
                    // the new reference. Without this, one 10% move would re-read
                    // every exposed account on every tick until the next sweep.
                    this.sweepBasePrices!.set(key, p);
                }
            } else if (base == null && this.sweepBasePrices) {
                this.sweepBasePrices.set(key, p);   // a key first seen after the sweep (new market)
            }
        }
        this.lastPrices = prices;

        const reasons = { event: 0, tier: 0, price: 0, bigMove: 0, sweep: 0 };
        const set = new Set<string>();
        const add = (u: string, why: keyof typeof reasons) => { if (!set.has(u)) { set.add(u); reasons[why]++; } };

        for (const u of dirty) add(u, 'event');
        const watchDue = this.ticks % this.opts.watchEvery === 0;
        for (const a of this.accounts.values()) {
            if (this.isDust(a)) continue;   // own events + rolling sweep only, see header
            if (a.tier === 'liquidatable' || a.tier === 'near') { add(a.user, 'tier'); continue; }
            if (a.tier === 'watch' && watchDue) { add(a.user, 'tier'); continue; }
            if (a.tier === 'idle' || a.config === 0n) continue;
            if (bigMask && (a.config & bigMask)) { add(a.user, 'bigMove'); continue; }
            if (movedMask && (a.config & movedMask) && (a.hf == null || a.hf < this.priceRecheckMaxHF)) add(a.user, 'price');
        }

        // Rolling sweep: the slice of the queue this tick owes, proportional to
        // the time since the last tick, so the queue drains once per sweepMs
        // whatever the block time or tick latency.
        const now = this.now();
        const elapsed = Math.min(this.opts.sweepMs, Math.max(0, now - this.lastTickAt));
        this.lastTickAt = now;
        let sweepCompleted = false;
        let budget = Math.ceil(this.sweepQueue.length * elapsed / this.opts.sweepMs);
        while (budget > 0) {
            if (this.sweepCursor >= this.sweepQueue.length) break;
            const u = this.sweepQueue[this.sweepCursor++];
            if (this.accounts.get(u)?.tier !== 'idle') add(u, 'sweep');
            budget--;
        }
        if (this.sweepQueue.length && this.sweepCursor >= this.sweepQueue.length) {
            // Cycle done: every account with debt was read since the last wrap, so
            // current prices become the reference for big-move detection.
            sweepCompleted = true;
            this.sweepBasePrices = new Map(prices);
            this.sweepQueue = this.sweepable();
            this.sweepCursor = 0;
        }

        const r = await this.refresh(set, block);
        return {
            block, read: r.read, calls: r.calls + 1, failed: r.failed, movedAssets: moved, sweep: false,
            reasons, sweepCompleted, transitions: r.transitions,
        };
    }

    /** Accounts per eth_call currently in use (shrinks if the RPC rejects bigger batches). */
    get batchSize(): number { return this.opts.batchSize; }

    /** Accounts in `tier`, lowest HF first. */
    inTier(...tiers: Tier[]): AccountState[] {
        return [...this.accounts.values()]
            .filter(a => a.tier != null && tiers.includes(a.tier))
            .sort((a, b) => (a.hf! < b.hf! ? -1 : a.hf! > b.hf! ? 1 : 0));
    }
}
