// -----------------------------------------------------------------------------
// Liquidation watchlist storage: db/<chain>-liq.sqlite.
//
// A separate file from db/<chain>.sqlite on purpose. The arb DB is rewritten
// wholesale by reserves/triangles runs and is 8GB on Polygon; the watchlist is
// small, written every block by `yarn liq-watch --follow`, and should not
// contend with (or be stuck behind) a triangles rebuild. Both are regenerable
// caches — deleting this file costs one backfill.
//
// Keyed by pool, so two lending markets on one chain (Aave plus a fork such as
// HyperLend, or two Aave instances) share the file without colliding.
//
// Big numbers (HF, base values, the config bitmap) are stored as TEXT — they
// are uint256 and SQLite integers are 64-bit.
// -----------------------------------------------------------------------------

import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import { dbPath } from '../util/config.ts';

export type Tier = 'liquidatable' | 'near' | 'watch' | 'far' | 'idle';

export type AccountRow = {
    user: string;
    firstBlock: number;
    lastEventBlock: number;
    checkedBlock: number | null;
    hf: bigint | null;
    collateralBase: bigint | null;
    debtBase: bigint | null;
    config: bigint | null;
    eMode: number;
    tier: Tier | null;
};

const SCHEMA = `
    CREATE TABLE IF NOT EXISTS liq_markets (
        pool        TEXT PRIMARY KEY,
        lastBlock   INTEGER NOT NULL      -- events applied through this block, inclusive
    );
    CREATE TABLE IF NOT EXISTS liq_accounts (
        pool            TEXT NOT NULL,
        user            TEXT NOT NULL,
        firstBlock      INTEGER NOT NULL,  -- first Borrow seen
        lastEventBlock  INTEGER NOT NULL,  -- last Pool event touching this account
        checkedBlock    INTEGER,           -- block of the last health read, null = never read
        hf              TEXT,              -- WAD, decimal string
        collateralBase  TEXT,
        debtBase        TEXT,
        config          TEXT,              -- UserConfigurationMap.data, hex
        tier            TEXT,
        PRIMARY KEY (pool, user)
    );
    CREATE INDEX IF NOT EXISTS idx_liq_accounts_tier ON liq_accounts(pool, tier);
`;

/** db/<chain>-liq.sqlite, next to the chain's arb DB. ARB_LIQ_DB overrides (tests). */
export function liqDbPath(chainArg: string): string {
    if (process.env.ARB_LIQ_DB) return process.env.ARB_LIQ_DB;
    return dbPath(chainArg).replace(/\.sqlite$/, '-liq.sqlite');
}

const big = (s: string | null): bigint | null => (s == null ? null : BigInt(s));

export class LiqDB {
    readonly db: DB;
    readonly pool: string;

    constructor(filePath: string, pool: string) {
        this.db = new Database(filePath);
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('synchronous = NORMAL');
        this.db.exec(SCHEMA);
        // Added after the first release; existing DBs get the column here.
        const cols = (this.db.prepare('PRAGMA table_info(liq_accounts)').all() as Array<{ name: string }>).map(c => c.name);
        if (!cols.includes('emode')) this.db.exec('ALTER TABLE liq_accounts ADD COLUMN emode INTEGER NOT NULL DEFAULT 0');
        this.pool = pool.toLowerCase();
    }

    close(): void { this.db.close(); }

    /** Last block whose events are applied, or null if never scanned. */
    lastBlock(): number | null {
        const r = this.db.prepare('SELECT lastBlock FROM liq_markets WHERE pool = ?').get(this.pool) as { lastBlock: number } | undefined;
        return r ? r.lastBlock : null;
    }

    /**
     * Apply one batch of decoded events and advance progress, atomically — a
     * crash can never record progress past events that were not stored.
     *
     * Borrow inserts the account (or bumps lastEventBlock). Every other event
     * only bumps lastEventBlock on an account we already track: a Supply from
     * someone with no debt cannot be liquidated, and if they borrow later the
     * Borrow event adds them.
     *
     * Returns the tracked accounts touched by this batch (for re-checking).
     */
    applyEvents(events: Array<{ account: string; isBorrow: boolean; blockNumber: number }>, throughBlock: number): Set<string> {
        const touched = new Set<string>();
        const insert = this.db.prepare(`
            INSERT INTO liq_accounts (pool, user, firstBlock, lastEventBlock) VALUES (?, ?, ?, ?)
            ON CONFLICT(pool, user) DO UPDATE SET lastEventBlock = MAX(lastEventBlock, excluded.lastEventBlock)`);
        const bump = this.db.prepare(`
            UPDATE liq_accounts SET lastEventBlock = MAX(lastEventBlock, ?) WHERE pool = ? AND user = ?`);
        const progress = this.db.prepare(`
            INSERT INTO liq_markets (pool, lastBlock) VALUES (?, ?)
            ON CONFLICT(pool) DO UPDATE SET lastBlock = MAX(lastBlock, excluded.lastBlock)`);
        this.db.transaction(() => {
            for (const e of events) {
                if (e.isBorrow) {
                    insert.run(this.pool, e.account, e.blockNumber, e.blockNumber);
                    touched.add(e.account);
                } else if (bump.run(e.blockNumber, this.pool, e.account).changes > 0) {
                    touched.add(e.account);
                }
            }
            progress.run(this.pool, throughBlock);
        })();
        return touched;
    }

    accounts(): AccountRow[] {
        const rows = this.db.prepare(`
            SELECT user, firstBlock, lastEventBlock, checkedBlock, hf, collateralBase, debtBase, config, emode, tier
            FROM liq_accounts WHERE pool = ?`).all(this.pool) as any[];
        return rows.map(r => ({
            user: r.user, firstBlock: r.firstBlock, lastEventBlock: r.lastEventBlock, checkedBlock: r.checkedBlock,
            hf: big(r.hf), collateralBase: big(r.collateralBase), debtBase: big(r.debtBase),
            config: big(r.config), eMode: r.emode ?? 0, tier: r.tier,
        }));
    }

    count(): number {
        return (this.db.prepare('SELECT COUNT(*) n FROM liq_accounts WHERE pool = ?').get(this.pool) as { n: number }).n;
    }

    saveHealth(rows: Array<{ user: string; hf: bigint; collateralBase: bigint | null; debtBase: bigint | null; config: bigint; eMode?: number; tier: Tier }>, block: number): void {
        const upd = this.db.prepare(`
            UPDATE liq_accounts SET checkedBlock = ?, hf = ?, collateralBase = ?, debtBase = ?, config = ?, emode = ?, tier = ?
            WHERE pool = ? AND user = ?`);
        this.db.transaction(() => {
            for (const r of rows) {
                // null = the venue could not price it in USD (never stored as 0: that would read as dust).
                upd.run(block, r.hf.toString(), r.collateralBase?.toString() ?? null, r.debtBase?.toString() ?? null,
                    '0x' + r.config.toString(16), r.eMode ?? 0, r.tier, this.pool, r.user);
            }
        })();
    }
}
