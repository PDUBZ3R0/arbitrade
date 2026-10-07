// DexUsd (source/liquidation/dex-usd.ts): USD from the scanner's pool DB, for
// chains with no Aave oracle. No chain needed — a pool DB in the scanner's schema.
//
//   node --experimental-strip-types test/test-dex-usd.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const { DexUsd } = await import('../source/liquidation/dex-usd.ts');
let fails = 0;
const ok = (c, l, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${l} ${extra}`); if (!c) fails++; };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexusd-'));
const file = path.join(dir, 'x.sqlite');
const db = new Database(file);
db.exec(`CREATE TABLE pairs (address TEXT, factory TEXT, token0 TEXT, token1 TEXT, blockNumber INTEGER, fee REAL, stable INTEGER, kind TEXT, tickSpacing INTEGER);
         CREATE TABLE reserves (pair TEXT PRIMARY KEY, reserves0 TEXT, reserves1 TEXT, blockNumber INTEGER, updatedAt INTEGER);
         CREATE TABLE tokens (address TEXT PRIMARY KEY, symbol TEXT, name TEXT, decimals INTEGER, fetchStatus TEXT, fetchedAt INTEGER, discoveredAt INTEGER);`);
const A = (n) => '0x' + n.toString(16).padStart(40, '0');
const [WETH, USDC, FAKE, STOCK, ORPH, THIN] = [1, 2, 3, 4, 5, 6].map(A);
const tok = db.prepare("INSERT INTO tokens VALUES (?,?,?,?, 'ok', 0, 0)");
tok.run(WETH, 'WETH', '', 18); tok.run(USDC, 'USDC', '', 6); tok.run(FAKE, 'USDC', 'scam', 6);
tok.run(STOCK, 'TSLA', '', 18); tok.run(ORPH, 'ORPH', '', 18); tok.run(THIN, 'THIN', '', 18);
let n = 100;
const pair = (a, b, ra, rb, extra = {}) => {
    const p = A(n++);
    const [t0, t1, r0, r1] = a < b ? [a, b, ra, rb] : [b, a, rb, ra];
    db.prepare('INSERT INTO pairs VALUES (?,?,?,?,1,NULL,?,?,NULL)').run(p, A(0xf), t0, t1, extra.stable ?? null, extra.kind ?? 'v2');
    db.prepare('INSERT INTO reserves VALUES (?,?,?,1,1)').run(p, String(r0), String(r1));
};
const e18 = (x) => BigInt(Math.round(x * 1e6)) * 10n ** 12n, e6 = (x) => BigInt(Math.round(x * 1e6));
pair(WETH, USDC, e18(1000), e6(3_000_000));            // real: $3,000
pair(WETH, FAKE, e18(1), e6(1_000_000_000));            // scam: 1 WETH vs a billion fake USDC -> $1B/WETH
pair(WETH, USDC, e18(5), e6(20_000), { stable: 1 });    // stable-curve pool: ignored
pair(STOCK, WETH, e18(100), e18(10));                   // TSLA via WETH: 0.1 WETH = $300
pair(THIN, USDC, e18(1), e6(5_000));                    // $5K stable side: under the floor
db.close();

const d = new DexUsd(file, WETH);
const w = d.priceUsd(WETH);
ok(Math.abs(w - 3000) < 1e-6, 'WETH from the pool holding the most WETH, not the fake-USDC mountain', `$${w}`);
ok(d.priceUsd(USDC) === 1, 'a stablecoin is $1');
const s = d.priceUsd(STOCK);
ok(Math.abs(s - 300) < 1e-6, 'no stable pair: priced through the native token', `$${s}`);
ok(d.priceUsd(ORPH) == null, 'no pool: unknown (null), never $0');
ok(d.priceUsd(THIN) == null, 'stablecoin side under $10K: ignored');
ok(new DexUsd(path.join(dir, 'missing.sqlite'), WETH).available === false, 'no DB: unavailable, not an error');
d.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
