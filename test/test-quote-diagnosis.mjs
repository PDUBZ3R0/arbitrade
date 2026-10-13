// "Did it come back short because the pool moved, or because our math is
// wrong?" — CandidateExecutor.diagnoseRepay.
//
// An InsufficientRepay from estimateGas / the simulation is re-run pinned to
// built.blockTag, the block every read behind the prediction came from:
//   1. clean there                        → "stale" (the path moved after it)
//   2. InsufficientRepay there too        → "QUOTE MISMATCH", with predicted
//      vs executor output in ppm, appended to log/<chain>/quote-mismatch.jsonl
//   3. a different revert there           → reported as such
//   4. an all-V2 path (no pinned block)   → says it cannot tell
//   5. not an InsufficientRepay at all    → no suffix
// Pure: the contract call is a stub that records the blockTag it was given.
//
//   node --experimental-strip-types test/test-quote-diagnosis.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { id, AbiCoder } from 'ethers';
import { CandidateExecutor } from '../source/orchestrator/attempt.ts';

let fails = 0;
const ok = (c, l, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${l} ${extra}`); if (!c) fails++; };

const sel = id('InsufficientRepay(uint256,uint256)').slice(0, 10);
const repay = (bal, req) => sel + AbiCoder.defaultAbiCoder().encode(['uint256', 'uint256'], [bal, req]).slice(2);
const revertWith = (data) => Object.assign(new Error('execution reverted (unknown custom error)'), { data });

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'quote-diag-'));
const cwd = process.cwd();
process.chdir(scratch);
try {
    const ex = Object.create(CandidateExecutor.prototype);
    ex.cfg = { chain: { label: 'katana' } };
    ex.opts = { ownerAddress: '0x000000000000000000000000000000000000dEaD' };
    const candidate = {
        triangleId: 42, rootToken: '0xroot',
        hops: [
            { pair: '0xv3pool', factory: '0xfac3', kind: 'v3', fee: 500, tokenIn: '0xroot', tokenOut: '0xusdc' },
            { pair: '0xv2pair', factory: '0xfac2', fee: 0.003, tokenIn: '0xusdc', tokenOut: '0xroot' },
        ],
    };
    const built = { blockTag: 1234, expectedAmountOut: 1_000_000n, rootAmountIn: 990_000n,
        hops: [{ kind: 1, feePpm: 500 }, { kind: 0, feePpm: 3000 }] };
    const stub = (behaviour) => {
        const seen = [];
        return { seen, call: { fn: { staticCall: async (...a) => { seen.push(a.at(-1)?.blockTag); return behaviour(); } }, args: (m) => [m] } };
    };
    const first = revertWith(repay(995_000n, 1_000_100n));

    console.log('1. clean at the read block → stale');
    {
        const s = stub(() => undefined);
        const r = await ex.diagnoseRepay(first, s.call, built, 10n, candidate);
        ok(/stale: clean at block 1234/.test(r), 'verdict', r);
        ok(s.seen[0] === 1234, 're-run pinned to built.blockTag', `(${s.seen[0]})`);
    }

    console.log('\n2. still short at the read block → QUOTE MISMATCH, logged');
    {
        const s = stub(() => { throw revertWith(repay(996_000n, 1_000_010n)); });
        const r = await ex.diagnoseRepay(first, s.call, built, 10n, candidate);
        ok(/QUOTE MISMATCH at block 1234: predicted 1000000, executor got 996000 \(4000 ppm short\)/.test(r), 'verdict with ppm', r);
        const f = path.join('log', 'katana', 'quote-mismatch.jsonl');
        const rec = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8').trim().split('\n').at(-1)) : null;
        ok(rec && rec.block === 1234 && rec.shortPpm === 4000 && rec.triangleId === 42, 'jsonl record', JSON.stringify(rec)?.slice(0, 90));
        ok(rec && rec.hops.length === 2 && rec.hops[0].kind === 'v3' && rec.hops[0].pair === '0xv3pool' && rec.hops[1].feePpm === 3000, 'record carries the path (kinds, pools, fees)');
    }

    console.log('\n3. a different revert at the read block');
    {
        const s = stub(() => { throw revertWith('0x08c379a0deadbeef'); });
        const r = await ex.diagnoseRepay(first, s.call, built, 10n, candidate);
        ok(/reverts differently: 0x08c379a0/.test(r), 'reported', r);
    }

    console.log('\n4. all-V2 path: no pinned block');
    {
        const s = stub(() => undefined);
        const r = await ex.diagnoseRepay(first, s.call, { ...built, blockTag: undefined }, 10n, candidate);
        ok(/cannot tell stale from mismatch/.test(r) && s.seen.length === 0, 'says so, makes no call', r);
    }

    console.log('\n5. not an InsufficientRepay');
    {
        const s = stub(() => undefined);
        const r = await ex.diagnoseRepay(revertWith('0x08c379a0'), s.call, built, 10n, candidate);
        ok(r === '' && s.seen.length === 0, 'no suffix, no call');
        const r2 = await ex.diagnoseRepay(new Error('timeout'), s.call, built, 10n, candidate);
        ok(r2 === '', 'no revert data → no suffix');
    }
} finally {
    process.chdir(cwd);
    fs.rmSync(scratch, { recursive: true, force: true });
}

console.log(fails === 0 ? '\nALL QUOTE-DIAGNOSIS CHECKS PASS' : `\n${fails} FAILED`);
process.exit(fails ? 1 : 0);
