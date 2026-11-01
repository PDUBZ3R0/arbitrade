// readChunked: a refused batch call must cost a retry or a split, never the
// whole chunk.
//
// Polygon, 2026-10-30: the startup refresh's 400-pair reads had no retry; nine
// were refused ("missing revert data") and 3,600 pairs kept 16-day-old
// reserves — 93,505 phantom "already profitable" cycles at the startup sweep.
//
//   node --experimental-strip-types test/test-chunked-read.mjs   (no anvil)

import { readChunked, isTransientRpcError } from '../source/util/chunked-read.ts';

let fails = 0;
const ok = (c, l, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${l} ${extra}`); if (!c) fails++; };
const items = Array.from({ length: 1000 }, (_, i) => i);
const noSleep = { sleep: async () => {} };
const refused = () => new Error('missing revert data (action="call", data=null)');

// 1. Refused twice, then served: every item read, no split.
{
    let calls = 0, refusals = 0;
    const r = await readChunked(items, 400, async (c) => {
        calls++;
        if (c[0] === 400 && refusals < 2) { refusals++; throw refused(); }
        return c.map(x => x * 2);
    }, noSleep);
    ok(r.rows.length === 1000 && r.failed.length === 0 && r.rows.every(({ item, row }) => row === item * 2),
       'a chunk refused twice is retried and read in full', JSON.stringify({ rows: r.rows.length, failed: r.failed.length }));
    ok(calls === 5, 'three chunks + two retries, no split', `calls=${calls}`);
}

// 2. A node that refuses anything over 50 items: split until it serves.
{
    const r = await readChunked(items, 400, async (c) => { if (c.length > 50) throw refused(); return c; }, noSleep);
    ok(r.rows.length === 1000 && r.failed.length === 0, 'a chunk refused at every retry is split until the node serves it');
}

// 3. One item that always reverts (a real error): isolated, the other 399 read.
{
    let calls = 0;
    const r = await readChunked(items, 400, async (c) => {
        calls++;
        if (c.includes(123)) throw new Error('execution reverted');
        return c;
    }, noSleep);
    ok(r.rows.length === 999 && r.failed.length === 1 && r.failed[0].item === 123 && /reverted/.test(r.failed[0].error),
       'one bad item is isolated, not 400 lost with it', JSON.stringify({ rows: r.rows.length, failed: r.failed }));
    // log2(400) ~ 9 levels, two calls each, no retries for a non-transient error.
    ok(calls < 30, 'a real error is split, not retried', `calls=${calls}`);
}

// 4. A reader returning the wrong row count is an error, not a silent misalignment.
{
    const r = await readChunked([1, 2, 3, 4], 4, async (c) => (c.length > 1 ? c.slice(1) : c), noSleep);
    ok(r.rows.length === 4 && r.rows.every(({ item, row }) => item === row), 'a short result is split until rows line up with items');
}

// 5. Backoff is the configured one, in order.
{
    const waits = [];
    let n = 0;
    await readChunked([1], 1, async (c) => { if (n++ < 2) throw refused(); return c; }, { retryDelaysMs: [10, 20], sleep: async (ms) => { waits.push(ms); } });
    ok(waits.join(',') === '10,20', 'retries wait the configured backoff', waits.join(','));
}

ok(isTransientRpcError(refused()) && !isTransientRpcError(new Error('execution reverted: K')), 'isTransientRpcError: refusal yes, revert no');

console.log(fails ? `\n${fails} FAILED` : '\nALL CHUNKED-READ CHECKS PASS');
process.exit(fails ? 1 : 0);
