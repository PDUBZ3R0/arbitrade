// Scan progress is only valid for the creation event it was scanned for.
//
// Sonic, 2026-10-13: SwapX Algebra and Atlantis (Sonic's main Algebra DEXes)
// sat at 0 pools with scan progress at the head — they had been scanned
// before being configured as Algebra, and every later scan "resumed" past
// their whole history. resumeFor() decides where a factory's scan restarts:
//   1. no progress                                   → from the deploy block
//   2. progress recorded for this topic              → resume
//   3. progress recorded for ANOTHER topic           → from the deploy block, with a note
//   4. legacy row (no topic), CL factory, 0 pools    → rescan when HyperSync is
//      available; otherwise resume and say how to force it (--rescan)
//   5. legacy row, factory has pools                 → resume (trusted)
//   6. an old DB without scan_progress.topic is migrated in place
//
//   node --experimental-strip-types test/test-scan-resume.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { ArbitradeDB } from '../source/util/db.ts';
import { resumeFor } from '../source/scanner/pairs.ts';
import { TOPIC_BY_LAYOUT } from '../source/util/pool-events.ts';

let fails = 0;
const ok = (c, l, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${l} ${extra}`); if (!c) fails++; };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-resume-'));
const A = (n) => '0x' + String(n).repeat(40).slice(0, 40);
const ALG = TOPIC_BY_LAYOUT.algebra, V3 = TOPIC_BY_LAYOUT.v3;
const algebra = { address: A(1), name: 'SwapX Algebra', group: 'algebra' };
const v2 = { address: A(2), name: 'SomeV2', group: 'v2' };

try {
    console.log('6. migration: an old scan_progress without the topic column');
    const file = path.join(dir, 'old.sqlite');
    { const raw = new Database(file); raw.exec('CREATE TABLE scan_progress (factory TEXT PRIMARY KEY, lastBlock INTEGER NOT NULL, updatedAt INTEGER NOT NULL)');
      raw.prepare('INSERT INTO scan_progress VALUES (?,?,?)').run(A(1), 80_000_000, 1); raw.prepare('INSERT INTO scan_progress VALUES (?,?,?)').run(A(2), 80_000_000, 1); raw.close(); }
    const db = new ArbitradeDB(file);
    ok(db.getScanProgressRow(A(1))?.topic === null && db.getScanProgress(A(1)) === 80_000_000, 'old rows kept, topic null');

    console.log('\n4/5. legacy rows');
    let r = resumeFor(db, algebra, ALG, true);
    ok(r.resume === null && /no pools.*rescanning/.test(r.note), 'Algebra factory, 0 pools, HyperSync → rescan', r.note);
    r = resumeFor(db, algebra, ALG, false);
    ok(r.resume === 80_000_000 && /--rescan/.test(r.note), 'same without HyperSync → resume, says how to force it', r.note);
    ok(resumeFor(db, v2, TOPIC_BY_LAYOUT.v2, true).resume === 80_000_000, 'a V2 factory with 0 pairs is not second-guessed');
    db.insertPairs([{ address: A(9), factory: A(1), token0: A(3), token1: A(4), blockNumber: 1, kind: 'v3', clVariant: 'algebra-integral' }]);
    ok(resumeFor(db, algebra, ALG, true).resume === 80_000_000, 'legacy row whose factory has pools → resume');

    console.log('\n2/3. recorded topics');
    db.setScanProgress(A(1), 80_000_100, V3);   // scanned as a v3 factory
    r = resumeFor(db, algebra, ALG, true);
    ok(r.resume === null && /creation event changed/.test(r.note), 'progress for another event → rescan', r.note);
    db.setScanProgress(A(1), 80_000_200, ALG);
    ok(resumeFor(db, algebra, ALG, false).resume === 80_000_200, 'progress for this event → resume');
    db.setScanProgress(A(1), 80_000_300);       // topic omitted: kept
    ok(db.getScanProgressRow(A(1)).topic === ALG.toLowerCase() && db.getScanProgress(A(1)) === 80_000_300, 'a progress write without a topic keeps the recorded one');

    console.log('\n1. no progress / reset');
    db.resetScanProgress(A(1));
    ok(resumeFor(db, algebra, ALG, true).resume === null && db.getScanProgress(A(1)) === null, 'reset → from the deploy block');
    db.close();
} finally {
    fs.rmSync(dir, { recursive: true, force: true });
}

console.log(fails === 0 ? '\nALL SCAN-RESUME CHECKS PASS' : `\n${fails} FAILED`);
process.exit(fails ? 1 : 0);
