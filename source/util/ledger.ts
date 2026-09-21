// -----------------------------------------------------------------------------
// Trade ledger: cross-chain record of CONFIRMED successful transactions.
//
// Deliberately a separate DB from the per-chain scan/reserves/triangles
// caches (db/<chain>.sqlite) — a trading history ledger spans every chain
// the bot runs on, unlike those per-chain caches. Standard location is
// db/ledger.sqlite, resolved via config.ts's ledgerPath().
//
// Only ever written for transactions that actually confirmed on-chain with
// status=1 — see orchestrator/loop.ts, which waits for the receipt before
// calling recordTrade(). A broadcast that reverted on-chain is NOT a trade
// and does not get a row here.
// -----------------------------------------------------------------------------

import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';

const SCHEMA = `
    CREATE TABLE IF NOT EXISTS trades (
        id              INTEGER PRIMARY KEY,
        timestamp       INTEGER NOT NULL,   -- unix seconds, when the tx confirmed
        chain           TEXT NOT NULL,      -- chain label, e.g. 'polygon'
        type            TEXT NOT NULL,      -- 'arbitrage' | 'liquidation' | ...
        txHash          TEXT NOT NULL UNIQUE,
        blockNumber     INTEGER,
        rootToken       TEXT NOT NULL,      -- address
        rootTokenSymbol TEXT,
        profitWei       TEXT NOT NULL,      -- raw amount, stored as string (BigInt-safe, arbitrary precision)
        profitDecimals  INTEGER NOT NULL,
        profitUsd       REAL,               -- null if USD price lookup failed/unavailable at record time
        gasCostWei      TEXT,               -- raw amount, stored as string
        createdAt       INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_trades_chain     ON trades(chain);
    CREATE INDEX IF NOT EXISTS idx_trades_type      ON trades(type);
    CREATE INDEX IF NOT EXISTS idx_trades_timestamp ON trades(timestamp);
`;

export type TradeType = 'arbitrage' | 'liquidation' | 'other';

export type TradeEntry = {
    timestamp: number;
    chain: string;
    type: TradeType;
    txHash: string;
    blockNumber?: number;
    rootToken: string;
    rootTokenSymbol?: string;
    profitWei: bigint;
    profitDecimals: number;
    /** Null if a USD price couldn't be obtained at record time — see usd-price.ts. */
    profitUsd: number | null;
    gasCostWei?: bigint;
};

export type TradeRow = {
    id: number;
    timestamp: number;
    chain: string;
    type: string;
    txHash: string;
    blockNumber: number | null;
    rootToken: string;
    rootTokenSymbol: string | null;
    profitWei: string;
    profitDecimals: number;
    profitUsd: number | null;
    gasCostWei: string | null;
    createdAt: number;
};

export class TradeLedger {
    readonly db: DB;

    /**
     * Pass config.ts's ledgerPath() for the standard location — an absolute
     * path resolved from the project root, consistent with dbPath()'s
     * per-chain DBs. A relative path here resolves against whatever the
     * process's cwd happens to be, which is fragile outside `yarn <script>`.
     */
    constructor(filePath: string) {
        this.db = new Database(filePath);
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('synchronous = NORMAL');
        this.db.exec(SCHEMA);
    }

    close(): void {
        this.db.close();
    }

    /**
     * Record a confirmed trade. Idempotent on txHash (INSERT OR IGNORE) — a
     * retried record call for the same tx is a safe no-op, not a duplicate row.
     */
    recordTrade(entry: TradeEntry): void {
        const now = Math.floor(Date.now() / 1000);
        this.db.prepare(`
            INSERT OR IGNORE INTO trades (
                timestamp, chain, type, txHash, blockNumber,
                rootToken, rootTokenSymbol, profitWei, profitDecimals, profitUsd,
                gasCostWei, createdAt
            ) VALUES (
                @timestamp, @chain, @type, @txHash, @blockNumber,
                @rootToken, @rootTokenSymbol, @profitWei, @profitDecimals, @profitUsd,
                @gasCostWei, @createdAt
            )
        `).run({
            timestamp: entry.timestamp,
            chain: entry.chain.toLowerCase(),
            type: entry.type,
            txHash: entry.txHash.toLowerCase(),
            blockNumber: entry.blockNumber ?? null,
            rootToken: entry.rootToken.toLowerCase(),
            rootTokenSymbol: entry.rootTokenSymbol ?? null,
            profitWei: entry.profitWei.toString(),
            profitDecimals: entry.profitDecimals,
            profitUsd: entry.profitUsd,
            gasCostWei: entry.gasCostWei != null ? entry.gasCostWei.toString() : null,
            createdAt: now,
        });
    }

    getTrades(filters: { chain?: string; type?: string; sinceTimestamp?: number; limit?: number } = {}): TradeRow[] {
        const wheres: string[] = [];
        const params: Array<string | number> = [];
        if (filters.chain) { wheres.push('chain = ?'); params.push(filters.chain.toLowerCase()); }
        if (filters.type)  { wheres.push('type = ?');  params.push(filters.type); }
        if (filters.sinceTimestamp != null) { wheres.push('timestamp >= ?'); params.push(filters.sinceTimestamp); }
        const where = wheres.length ? 'WHERE ' + wheres.join(' AND ') : '';
        const limit = filters.limit ?? 100;
        return this.db.prepare(`SELECT * FROM trades ${where} ORDER BY timestamp DESC LIMIT ?`)
            .all(...params, limit) as TradeRow[];
    }

    /** Sum of profitUsd across matching rows. Rows with a null profitUsd contribute 0 (not counted as unknown). */
    totalProfitUsd(filters: { chain?: string; type?: string } = {}): number {
        const wheres: string[] = [];
        const params: Array<string> = [];
        if (filters.chain) { wheres.push('chain = ?'); params.push(filters.chain.toLowerCase()); }
        if (filters.type)  { wheres.push('type = ?');  params.push(filters.type); }
        const where = wheres.length ? 'WHERE ' + wheres.join(' AND ') : '';
        const row = this.db.prepare(`SELECT COALESCE(SUM(profitUsd), 0) as total FROM trades ${where}`)
            .get(...params) as { total: number };
        return row.total;
    }
}
