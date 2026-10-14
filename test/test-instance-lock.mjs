// One `yarn hot <chain>` at a time (source/util/instance-lock.ts).
//
// Polygon, 2026-10-14: a second hot loop was started on the same chain and
// wallet while the first still ran — both wrote one hot.log, raced each
// other's nonces, and the newer one sat 300+ blocks behind the head.
//
//   1. first acquire succeeds and writes our pid
//   2. a second process is refused, and told the holder's pid
//   3. release removes the file; the second process now gets it
//   4. a lock left by a dead pid (crash, kill -9) is taken over, and says so
//   5. release never deletes a lock someone else holds
//
//   node --experimental-strip-types test/test-instance-lock.mjs

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireLock } from '../source/util/instance-lock.ts';

let fails = 0;
const ok = (c, l, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${l} ${extra}`); if (!c) fails++; };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-'));
const file = path.join(dir, 'log', 'polygon', 'hot.lock');
const mod = fileURLToPath(new URL('../source/util/instance-lock.ts', import.meta.url));
const other = () => {
    const r = spawnSync('node', ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e',
        `import { acquireLock } from ${JSON.stringify(mod)}; const r = acquireLock(${JSON.stringify(file)}); console.log(JSON.stringify({ ok: r.ok, pid: r.pid ?? null, stale: r.tookOverStale ?? null })); if (r.ok) r.release();`],
        { encoding: 'utf8' });
    return JSON.parse(r.stdout.trim() || '{}');
};

try {
    console.log('1. first acquire');
    const a = acquireLock(file);
    ok(a.ok && fs.readFileSync(file, 'utf8') === String(process.pid), 'ok, file holds our pid');

    console.log('\n2. a second process');
    const b = other();
    ok(b.ok === false && b.pid === process.pid, 'refused, names the holder', JSON.stringify(b));

    console.log('\n3. release');
    a.release();
    ok(!fs.existsSync(file), 'file removed');
    ok(other().ok === true, 'the other process now gets it');

    console.log('\n4. stale lock (dead pid)');
    const dead = spawnSync('node', ['-e', 'console.log(process.pid)'], { encoding: 'utf8' }).stdout.trim();
    fs.writeFileSync(file, dead);
    const c = acquireLock(file);
    ok(c.ok && c.tookOverStale === Number(dead) && fs.readFileSync(file, 'utf8') === String(process.pid), 'taken over, and reported', `stale pid ${c.tookOverStale}`);

    console.log('\n5. release only removes our own lock');
    fs.writeFileSync(file, '1');   // pid 1 is always alive: someone else's
    c.release();
    ok(fs.existsSync(file) && fs.readFileSync(file, 'utf8') === '1', 'left alone');
    ok(acquireLock(file).ok === false, 'and it still blocks us');
} finally {
    fs.rmSync(dir, { recursive: true, force: true });
}

console.log(fails === 0 ? '\nALL INSTANCE-LOCK CHECKS PASS' : `\n${fails} FAILED`);
process.exit(fails ? 1 : 0);
