// `yarn db-clean <chain> --empty` / `--prune-conf`: blacklist configured factories that were
// scanned for nothing — and ONLY those. Zero pairs is also what a factory
// looks like when it was never scanned, scanned for the wrong creation event
// (Sonic's SwapX/Atlantis, 2026-10-13) or scanned part-way.
//
//   A  v2, has pairs                                   → kept
//   B  v2, 0 pairs, scanned to the head for its event  → blacklisted
//   C  v2, 0 pairs, never scanned                      → left alone
//   D  v3, 0 pairs, legacy progress (no topic)         → left alone, says --rescan
//   E  algebra, 0 pairs, progress for the v3 event     → left alone (wrong event)
//   F  v2, 0 pairs, scanned but 5M blocks behind       → left alone (incomplete)
//   plus an orphan pair from a factory no longer configured (old behaviour).
//
// Dry run changes nothing; --yes blacklists B (reason recorded), forgets it in
// the DB, deletes the orphan, and leaves the rest. Runs the real CLI in a
// scratch copy of the project, so conf/ is never touched.
//
//   node --experimental-strip-types test/test-db-clean-empty.mjs

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSON5 from 'json5';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fails = 0;
const ok = (c, l, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${l} ${extra}`); if (!c) fails++; };
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'db-clean-empty-'));
const A = (c) => '0x' + c.repeat(40);

try {
    fs.cpSync(path.join(ROOT_DIR, 'source'), path.join(scratch, 'source'), { recursive: true });
    fs.mkdirSync(path.join(scratch, 'conf')); fs.mkdirSync(path.join(scratch, 'db'));
    fs.copyFileSync(path.join(ROOT_DIR, 'conf/@chains.json5'), path.join(scratch, 'conf/@chains.json5'));
    fs.copyFileSync(path.join(ROOT_DIR, 'package.json'), path.join(scratch, 'package.json'));
    fs.symlinkSync(path.join(ROOT_DIR, 'node_modules'), path.join(scratch, 'node_modules'));
    fs.writeFileSync(path.join(scratch, 'conf/katana.json5'), `{
  chain: { host: 'http://127.0.0.1:1', token: '${A('9')}' },
  factories: {
    v2: { list: { A: { address: '${A('a')}', fee: 0.003 },
                  // B was added by hand, long ago
                  B: { address: '${A('b')}', fee: 0.003 },
                  C: { address: '${A('c')}', fee: 0.003 }, F: { address: '${A('f')}', fee: 0.003 } } },
    v3: { list: { D: { address: '${A('d')}', poolEvent: 'uniswap', callback: 'uniswapV3SwapCallback' } } },
    algebra: { list: { E: { address: '${A('e')}' } } },
  },
}\n`);

    const { ArbitradeDB } = await import(path.join(scratch, 'source/util/db.ts'));
    const { TOPIC_BY_LAYOUT } = await import(path.join(scratch, 'source/util/pool-events.ts'));
    const dbFile = path.join(scratch, 'db/katana.sqlite');
    let db = new ArbitradeDB(dbFile);
    const raw = db.db;
    for (const [c, type] of [['a', 'v2'], ['b', 'v2'], ['c', 'v2'], ['d', 'v3'], ['e', 'algebra'], ['f', 'v2'], ['7', 'v2']]) {
        raw.prepare('INSERT INTO factories (address,name,type,fee,deployBlock) VALUES (?,?,?,?,?)').run(A(c), c.toUpperCase(), type, 0.003, 1);
    }
    db.insertPairs([
        { address: A('1'), factory: A('a'), token0: A('2'), token1: A('3'), blockNumber: 5 },
        { address: A('4'), factory: A('7'), token0: A('2'), token1: A('3'), blockNumber: 5 },   // orphan: factory 7 not configured
    ]);
    const HEAD = 10_000_000;
    db.setScanProgress(A('a'), HEAD, TOPIC_BY_LAYOUT.v2);
    db.setScanProgress(A('b'), HEAD - 50, TOPIC_BY_LAYOUT.v2);
    db.setScanProgress(A('d'), HEAD);                          // legacy: no topic
    db.setScanProgress(A('e'), HEAD, TOPIC_BY_LAYOUT.v3);      // scanned for the wrong event
    db.setScanProgress(A('f'), HEAD - 5_000_000, TOPIC_BY_LAYOUT.v2);
    db.close();

    const run = (...a) => {
        const r = spawnSync('node', ['--experimental-strip-types', '--no-warnings', 'source/db-clean.ts', 'katana', ...a], { cwd: scratch, encoding: 'utf8' });
        return (r.stdout ?? '') + (r.stderr ?? '');
    };
    const blFile = path.join(scratch, 'conf/katana-blacklist.json5');

    console.log('1. dry run');
    const dry = run('--empty');
    ok(/1 configured factory has no pairs/.test(dry) && dry.includes(A('b')), 'B is the only one proposed', dry.match(/configured factor.*/)?.[0]);
    ok(/never scanned/.test(dry) && /--rescan 0xd{40}/.test(dry) && /different creation event/.test(dry) && /scan incomplete/.test(dry),
        'C, D, E, F each left alone with its reason');
    ok(/orphan pair/.test(dry) && /DRY RUN/.test(dry), 'orphans still reported; says it is a dry run');
    ok(!fs.existsSync(blFile), 'nothing blacklisted');

    console.log('\n2. --yes');
    const out = run('--empty', '--yes');
    const bl = fs.existsSync(blFile) ? JSON5.parse(fs.readFileSync(blFile, 'utf8')) : { factories: [] };
    ok(bl.factories.length === 1 && bl.factories[0].address === A('b') && /no pairs after a scan to block/.test(bl.factories[0].reason), 'B blacklisted, with the reason', JSON.stringify(bl.factories[0] ?? {}).slice(0, 140));
    db = new ArbitradeDB(dbFile);
    ok(db.getScanProgressRow(A('b')) === null && !db.db.prepare('SELECT 1 FROM factories WHERE address = ?').get(A('b')), 'B forgotten in the DB (factories row, scan progress)');
    ok(db.getScanProgressRow(A('d')) && db.getScanProgressRow(A('e')) && db.getScanProgressRow(A('f')), 'D, E, F untouched');
    ok(db.countPairs(A('7')) === 0 && db.countPairs(A('a')) === 1, 'orphan deleted, A kept');
    db.close();
    ok(/Blacklisted 1 factory/.test(out), 'reports it', out.match(/Blacklisted.*/)?.[0]);

    console.log('\n3. again: B is now excluded by the blacklist, nothing new');
    const again = run('--empty', '--yes');
    ok(/No scanned-and-empty factories/.test(again) && !again.includes(A('b')), 'idempotent: B no longer in the config (blacklisted), nothing new', again.match(/Current config has.*|No scanned.*/g)?.join(' | '));

    console.log('\n4. --prune-conf: blacklisted entries out of the conf');
    const confFile = path.join(scratch, 'conf/katana.json5');
    const before = fs.readFileSync(confFile, 'utf8');
    const dryP = run('--prune-conf');
    ok(/1 blacklisted factory is still in conf\/katana.json5/.test(dryP) && dryP.includes('factories.v2.B') && /DRY RUN/.test(dryP), 'dry run lists B', dryP.match(/blacklisted factor.*/)?.[0]);
    ok(fs.readFileSync(confFile, 'utf8') === before, 'dry run leaves the conf byte-identical');
    const yesP = run('--prune-conf', '--yes');
    const after = fs.readFileSync(confFile, 'utf8');
    const parsed = JSON5.parse(after);
    ok(!('B' in parsed.factories.v2.list) && ['A', 'C', 'F'].every(k => k in parsed.factories.v2.list) && 'D' in parsed.factories.v3.list && 'E' in parsed.factories.algebra.list,
        'B removed; every other factory kept', Object.keys(parsed.factories.v2.list).join(','));
    ok(/\/\/ removed B \(0xb{40}\) — blacklisted \d{4}-\d\d-\d\d: B \(v2\): no pairs/.test(after), 'a note marks the removal, with the blacklist reason', after.match(/\/\/ removed.*/)?.[0]?.slice(0, 90));
    ok(after.includes('// B was added by hand, long ago'), 'existing comments kept');
    ok(/Removed 1 from conf/.test(yesP), 'reports it');
    ok(JSON5.parse(fs.readFileSync(blFile, 'utf8')).factories.length === 1, 'blacklist entry stays (so find-factories --add will not re-add it)');
    const again2 = run('--prune-conf', '--yes');
    ok(/No blacklisted factories left/.test(again2) && fs.readFileSync(confFile, 'utf8') === after, 'second run is a no-op');
} finally {
    fs.rmSync(scratch, { recursive: true, force: true });
}

console.log(fails === 0 ? '\nALL DB-CLEAN --empty CHECKS PASS' : `\n${fails} FAILED`);
process.exit(fails ? 1 : 0);
