// waitReceipt (source/util/receipt.ts): a failed receipt read is retried, never
// thrown. Sonic VPS, 2026-11-02: ethers' tx.wait() leaked a rate-limited
// receipt read as an unhandled rejection and the hot loop crashed.
//
//   node --experimental-strip-types test/test-receipt.mjs
import assert from 'node:assert/strict';
import { waitReceipt } from '../source/util/receipt.ts';

let unhandled = 0;
process.on('unhandledRejection', () => { unhandled++; });

// 1. Two failed reads, one not-yet-mined, then the (reverted) receipt.
{
    let calls = 0;
    const provider = {
        async getTransactionReceipt() {
            calls++;
            if (calls <= 2) throw new Error('Request timeout on the free plan, please upgrade to paid plan');
            if (calls === 3) return null;
            return { status: 0, blockNumber: 7 };
        },
    };
    const r = await waitReceipt(provider, '0xabc', 5_000, 10);
    assert.equal(r?.status, 0, 'a status-0 receipt comes back, not a throw');
    assert.equal(calls, 4);
    console.log('  ✓ failed reads are retried; a reverted receipt is returned');
}

// 2. Never mined (and every read failing): null at the deadline.
{
    const provider = { async getTransactionReceipt() { throw new Error('boom'); } };
    const t0 = Date.now();
    const r = await waitReceipt(provider, '0xabc', 120, 20);
    assert.equal(r, null);
    assert.ok(Date.now() - t0 < 1_000, 'bounded by the timeout');
    console.log('  ✓ not mined within the timeout → null');
}

await new Promise(res => setTimeout(res, 50));
assert.equal(unhandled, 0, 'no unhandled rejections');
console.log('test-receipt: all passed');
