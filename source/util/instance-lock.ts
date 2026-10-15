// -----------------------------------------------------------------------------
// One process per lock file — `yarn arbitrage <chain>` runs once per chain.
//
// Polygon, 2026-10-14: a second `yarn arbitrage polygon --live` was started while the
// first was still running. Both appended to the same hot.log, both signed from
// the same wallet (racing each other's nonces and each other's trades), both
// held a 170 MB index, and the CPU contention left the new one's Sync cursor
// 300–380 blocks (10+ minutes) behind the head — every candidate it found was
// priced from reserves that had long since moved.
//
// The lock is a file holding the owner's pid, created with O_EXCL. A file whose
// pid is no longer running is stale (crash, kill -9) and is taken over.
// -----------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';

export type LockResult =
    | { ok: true; release: () => void; tookOverStale: number | null }
    | { ok: false; pid: number; since: Date | null };

function alive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return true; }
    catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }   // exists, not ours to signal
}

export function acquireLock(file: string): LockResult {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let tookOverStale: number | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const fd = fs.openSync(file, 'wx');
            fs.writeSync(fd, String(process.pid));
            fs.closeSync(fd);
            const release = () => {
                try { if (fs.readFileSync(file, 'utf8').trim() === String(process.pid)) fs.unlinkSync(file); }
                catch { /* already gone */ }
            };
            return { ok: true, release, tookOverStale };
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
            let pid = NaN, since: Date | null = null;
            try { pid = Number(fs.readFileSync(file, 'utf8').trim()); since = fs.statSync(file).mtime; } catch { /* raced with a release */ }
            if (pid === process.pid) return { ok: true, release: () => { try { fs.unlinkSync(file); } catch {} }, tookOverStale };
            if (alive(pid)) return { ok: false, pid, since };
            tookOverStale = Number.isFinite(pid) ? pid : null;
            try { fs.unlinkSync(file); } catch { /* someone else took it over first; retry decides */ }
        }
    }
    const pid = Number(fs.readFileSync(file, 'utf8').trim());
    return { ok: false, pid, since: null };
}
