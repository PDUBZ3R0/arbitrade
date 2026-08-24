// -----------------------------------------------------------------------------
// SQLite database layer.
//
// Schema:
//
//   factories  — one row per known DEX factory, per chain
//     (we also store name/type/fee here for reference; source of truth is config)
//
//   pairs      — one row per V2 pair, discovered via PairCreated events
//     UNIQUE(factory, address) prevents duplicate inserts on rescan
//     Indexed by token0, token1, and (token0, token1) for triangle enumeration
//
//   reserves   — rolling snapshot of pair reserves (one row per pair, upserted)
//     reserves0/1 stored as TEXT because uint112 can exceed JS Number precision
//     when tokens have 18 decimals and pool holds > ~9M tokens
//
//   scan_progress — last block scanned per factory, so we can resume
//
// -----------------------------------------------------------------------------

import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';

const SCHEMA = `
    CREATE TABLE IF NOT EXISTS factories (
        address     TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        type        TEXT NOT NULL DEFAULT 'v2',
        fee         REAL NOT NULL DEFAULT 0.003,
        deployBlock INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pairs (
        address     TEXT NOT NULL,
        factory     TEXT NOT NULL,
        token0      TEXT NOT NULL,
        token1      TEXT NOT NULL,
        blockNumber INTEGER NOT NULL,
        -- Nullable per-pair overrides for Solidly-family factories where
        -- fee varies per pair (looked up via factory.pairFee(pair)) and
        -- pairs have distinct stable vs volatile curves.
        -- NULL = use factory-level defaults; only V2/V3 assumptions apply.
        fee         REAL,
        stable      INTEGER,  -- 0/1, NULL for pure V2 (no stable/volatile distinction)
        PRIMARY KEY (factory, address)
    );

    -- Indexes for triangle enumeration: "give me pairs containing token X"
    CREATE INDEX IF NOT EXISTS idx_pairs_token0 ON pairs(token0);
    CREATE INDEX IF NOT EXISTS idx_pairs_token1 ON pairs(token1);
    CREATE INDEX IF NOT EXISTS idx_pairs_tokens ON pairs(token0, token1);
    CREATE INDEX IF NOT EXISTS idx_pairs_factory ON pairs(factory);

    CREATE TABLE IF NOT EXISTS reserves (
        pair        TEXT PRIMARY KEY,
        reserves0   TEXT NOT NULL,
        reserves1   TEXT NOT NULL,
        blockNumber INTEGER NOT NULL,
        updatedAt   INTEGER NOT NULL   -- unix timestamp
    );

    CREATE INDEX IF NOT EXISTS idx_reserves_block ON reserves(blockNumber);

    CREATE TABLE IF NOT EXISTS scan_progress (
        factory      TEXT PRIMARY KEY,
        lastBlock    INTEGER NOT NULL,
        updatedAt    INTEGER NOT NULL
    );
`;

/**
 * Schema migration: for existing databases that don't have the fee/stable
 * columns on pairs, add them. ALTER TABLE ADD COLUMN is idempotent-safe if
 * we check first.
 */
function migratePairsColumns(db: import('better-sqlite3').Database): void {
    const cols = db.prepare("PRAGMA table_info(pairs)").all() as Array<{ name: string }>;
    const names = new Set(cols.map(c => c.name));
    if (!names.has('fee')) {
        db.exec('ALTER TABLE pairs ADD COLUMN fee REAL');
    }
    if (!names.has('stable')) {
        db.exec('ALTER TABLE pairs ADD COLUMN stable INTEGER');
    }
}

// -----------------------------------------------------------------------------

export type PairRow = {
    address: string;
    factory: string;
    token0: string;
    token1: string;
    blockNumber: number;
    // Solidly-family only; NULL for pure V2 pairs.
    fee?: number | null;
    stable?: boolean | null;
};

export type ReserveRow = {
    pair: string;
    reserves0: string;   // decimal string, parse to BigInt
    reserves1: string;
    blockNumber: number;
    updatedAt: number;
};

// -----------------------------------------------------------------------------

export class ArbitradeDB {
    readonly db: DB;

    constructor(filePath: string) {
        this.db = new Database(filePath);
        this.db.pragma('journal_mode = WAL');   // better concurrency
        this.db.pragma('synchronous = NORMAL'); // ~2x write speedup, still safe
        this.db.exec(SCHEMA);
        migratePairsColumns(this.db);
    }

    close() {
        this.db.close();
    }

    // ------------------------------------------- factories

    upsertFactory(f: { address: string; name: string; type: string; fee: number; deployBlock: number }) {
        this.db.prepare(`
            INSERT INTO factories (address, name, type, fee, deployBlock)
            VALUES (@address, @name, @type, @fee, @deployBlock)
            ON CONFLICT(address) DO UPDATE SET
                name        = excluded.name,
                type        = excluded.type,
                fee         = excluded.fee,
                deployBlock = excluded.deployBlock
        `).run({
            address: f.address.toLowerCase(),
            name: f.name,
            type: f.type,
            fee: f.fee,
            deployBlock: f.deployBlock,
        });
    }

    /** Fetch the cached deploy block for a factory, or null if unknown. */
    getFactoryDeployBlock(address: string): number | null {
        const row = this.db.prepare('SELECT deployBlock FROM factories WHERE address = ?')
            .get(address.toLowerCase()) as { deployBlock: number } | undefined;
        // Zero means "not yet discovered" — same as absent
        if (!row || !row.deployBlock) return null;
        return row.deployBlock;
    }

    // ------------------------------------------- pairs

    /**
     * Insert a batch of pairs in one transaction. Returns count inserted
     * (duplicates via UNIQUE(factory, address) are silently ignored).
     */
    insertPairs(rows: PairRow[]): number {
        const stmt = this.db.prepare(`
            INSERT OR IGNORE INTO pairs (address, factory, token0, token1, blockNumber, fee, stable)
            VALUES (@address, @factory, @token0, @token1, @blockNumber, @fee, @stable)
        `);
        const tx = this.db.transaction((rs: PairRow[]) => {
            let n = 0;
            for (const r of rs) {
                const res = stmt.run({
                    address: r.address.toLowerCase(),
                    factory: r.factory.toLowerCase(),
                    token0: r.token0.toLowerCase(),
                    token1: r.token1.toLowerCase(),
                    blockNumber: r.blockNumber,
                    fee: r.fee ?? null,
                    stable: r.stable == null ? null : (r.stable ? 1 : 0),
                });
                if (res.changes > 0) n++;
            }
            return n;
        });
        return tx(rows);
    }

    countPairs(factory?: string): number {
        if (factory) {
            const row = this.db.prepare('SELECT COUNT(*) AS n FROM pairs WHERE factory = ?')
                .get(factory.toLowerCase()) as { n: number };
            return row.n;
        }
        const row = this.db.prepare('SELECT COUNT(*) AS n FROM pairs').get() as { n: number };
        return row.n;
    }

    // ------------------------------------------- scan progress

    getScanProgress(factory: string): number | null {
        const row = this.db.prepare('SELECT lastBlock FROM scan_progress WHERE factory = ?')
            .get(factory.toLowerCase()) as { lastBlock: number } | undefined;
        return row?.lastBlock ?? null;
    }

    setScanProgress(factory: string, block: number) {
        this.db.prepare(`
            INSERT INTO scan_progress (factory, lastBlock, updatedAt)
            VALUES (?, ?, ?)
            ON CONFLICT(factory) DO UPDATE SET
                lastBlock = excluded.lastBlock,
                updatedAt = excluded.updatedAt
        `).run(factory.toLowerCase(), block, Math.floor(Date.now() / 1000));
    }

    // ------------------------------------------- reserves

    /**
     * Get pairs that need a reserves refresh. Optionally filter by:
     *   - factory: only pairs from this factory
     *   - maxAgeSeconds: skip pairs whose reserves were updated more recently
     *
     * Returns an array in the shape the fetcher wants (with the pair's factory
     * so the caller can group by group/family).
     */
    getPairsForReservesFetch(opts: {
        factory?: string;
        maxAgeSeconds?: number;
    } = {}): Array<{ pair: string; factory: string; token0: string; token1: string }> {
        const wheres: string[] = [];
        const params: any[] = [];
        if (opts.factory) {
            wheres.push('p.factory = ?');
            params.push(opts.factory.toLowerCase());
        }
        if (opts.maxAgeSeconds !== undefined) {
            const cutoff = Math.floor(Date.now() / 1000) - opts.maxAgeSeconds;
            // "r.updatedAt is null" means we've never fetched reserves for this pair yet
            wheres.push('(r.updatedAt IS NULL OR r.updatedAt < ?)');
            params.push(cutoff);
        }
        const where = wheres.length ? 'WHERE ' + wheres.join(' AND ') : '';
        return this.db.prepare(`
            SELECT p.address AS pair, p.factory, p.token0, p.token1
            FROM pairs p
            LEFT JOIN reserves r ON r.pair = p.address
            ${where}
            ORDER BY p.factory, p.address
        `).all(...params) as any;
    }

    /**
     * Upsert reserves for a batch of pairs. Zero-reserve pairs should be
     * filtered out by the caller (we don't waste space on dead pools).
     */
    upsertReserves(rows: Array<{
        pair: string;
        reserves0: bigint;
        reserves1: bigint;
        blockNumber: number;
    }>): number {
        const now = Math.floor(Date.now() / 1000);
        const stmt = this.db.prepare(`
            INSERT INTO reserves (pair, reserves0, reserves1, blockNumber, updatedAt)
            VALUES (@pair, @reserves0, @reserves1, @blockNumber, @updatedAt)
            ON CONFLICT(pair) DO UPDATE SET
                reserves0   = excluded.reserves0,
                reserves1   = excluded.reserves1,
                blockNumber = excluded.blockNumber,
                updatedAt   = excluded.updatedAt
        `);
        const tx = this.db.transaction((rs: typeof rows) => {
            let n = 0;
            for (const r of rs) {
                const res = stmt.run({
                    pair:      r.pair.toLowerCase(),
                    reserves0: r.reserves0.toString(),   // TEXT column, decimal string
                    reserves1: r.reserves1.toString(),
                    blockNumber: r.blockNumber,
                    updatedAt: now,
                });
                if (res.changes > 0) n++;
            }
            return n;
        });
        return tx(rows);
    }

    countReserves(): number {
        const row = this.db.prepare('SELECT COUNT(*) AS n FROM reserves').get() as { n: number };
        return row.n;
    }

    // ------------------------------------------- pair metadata (fee/stable for solidly-family)

    /**
     * Get pairs from a specific factory that lack fee/stable metadata.
     * If `forceRefresh` is true, returns ALL pairs regardless of whether
     * metadata is already populated (for the periodic refresh command).
     */
    getPairsForMetadataFetch(factory: string, forceRefresh: boolean): Array<{ pair: string; stable: number | null }> {
        const where = forceRefresh
            ? 'factory = ?'
            : 'factory = ? AND fee IS NULL';
        return this.db.prepare(`
            SELECT address AS pair, stable
            FROM pairs
            WHERE ${where}
            ORDER BY address
        `).all(factory.toLowerCase()) as any;
    }

    /** Update fee (and stable, if provided) for a single pair. */
    updatePairMetadata(rows: Array<{ pair: string; fee: number; stable?: boolean | null }>): number {
        const stmt = this.db.prepare(`
            UPDATE pairs
            SET fee = @fee,
                stable = COALESCE(@stable, stable)
            WHERE address = @pair
        `);
        const tx = this.db.transaction((rs: typeof rows) => {
            let n = 0;
            for (const r of rs) {
                const res = stmt.run({
                    pair:   r.pair.toLowerCase(),
                    fee:    r.fee,
                    stable: r.stable == null ? null : (r.stable ? 1 : 0),
                });
                if (res.changes > 0) n++;
            }
            return n;
        });
        return tx(rows);
    }
}
