// A pair the hot loop cannot read must cost one candidate, not the process.
//
// Arbitrum, 2026-10-10..12: the startup sweep hit a "V2 pair" whose
// getReserves() came back as empty data — an address with no code answers an
// eth_call with success and 0x — and decoding it threw out of the loop. The
// container restarted it, it rebuilt its index, swept, and died again: 376
// times in two days, never once reaching the point of watching Syncs.
//
//   1. buildHops on a cycle through a code-less "pair" throws
//      UnreadablePairError naming the pair (not a generic decode error, and
//      not `null`, which the loop would read as a decayed edge and resync).
//   2. The hot loop survives an attempt that throws: it logs it, counts it,
//      moves on to the next candidate, and mutes the triangle after repeats.
//
//   node test/test-unreadable-pair.mjs   (anvil on PATH; own anvil on 8567)

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { ethers } from 'ethers';
import { buildHops, UnreadablePairError } from '../source/orchestrator/build-hops.ts';
import { createHotLoop } from '../source/orchestrator/hot-loop.ts';

let fails = 0;
const ok = (c, l, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${l} ${extra}`); if (!c) fails++; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const art = JSON.parse(readFileSync(new URL('./artifacts.json', import.meta.url), 'utf8'));
const anvil = spawn('anvil', ['--port', '8567', '--silent']);
await sleep(1500);
const provider = new ethers.JsonRpcProvider('http://127.0.0.1:8567', undefined, { staticNetwork: true, cacheTimeout: -1 });
const w = new ethers.Wallet('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', provider);

const A = '0x' + 'a'.repeat(40), B = '0x' + 'b'.repeat(40);
const GHOST = '0x' + '9'.repeat(40);       // no code
const cand = (id, pairs) => ({
    triangleId: id, rootToken: A, hopCount: 2, direction: 'forward', inputAmount: 1e18, grossProfit: 1e16, netProfit: 1e16,
    hops: [{ pair: pairs[0], factory: '0x' + '1'.repeat(40), tokenIn: A, tokenOut: B, fee: 0.003, kind: 'v2' },
           { pair: pairs[1], factory: '0x' + '2'.repeat(40), tokenIn: B, tokenOut: A, fee: 0.003, kind: 'v2' }],
});

try {
    const mc = await new ethers.ContractFactory(art.Multicall3Min.abi, art.Multicall3Min.bytecode, w).deploy();
    await mc.waitForDeployment();
    await provider.send('anvil_setCode', ['0xcA11bde05977b3631167028862bE2a173976CA11', await provider.getCode(await mc.getAddress())]);

    console.log('1. buildHops through a code-less pair');
    let err = null;
    try { await buildHops(provider, '0x' + 'e'.repeat(40), null, cand(1, [GHOST, GHOST]), 0n); } catch (e) { err = e; }
    ok(err instanceof UnreadablePairError, 'throws UnreadablePairError', err ? `(${err.message})` : '(returned instead)');
    ok(err?.pair?.toLowerCase() === GHOST && /no contract code/.test(err?.message ?? ''), 'names the pair and the likely reason');

    console.log('\n2. the hot loop survives an attempt that throws');
    const logs = [];
    const loop = createHotLoop({
        index: {}, db: null, thresholds: () => ({}), pricing: () => ({}), decimalsByToken: new Map(),
        attempt: async (c) => { if (c.triangleId === 1) throw err ?? new Error('boom'); return { simulated: false, built: null, simulationError: 'reverted' }; },
        report: () => {}, candidatesPerBlock: 5, cooldownMs: 0, log: (s) => logs.push(s), muteAfterFailures: 2,
    });
    const P = (n) => '0x' + String(n).repeat(40);
    let threw = null;
    try {
        await loop.sweep([cand(1, [P(3), P(4)]), cand(2, [P(5), P(6)])]);
        await loop.sweep([cand(1, [P(3), P(4)]), cand(2, [P(5), P(6)])]);
        await loop.sweep([cand(1, [P(3), P(4)])]);
    } catch (e) { threw = e; }
    ok(threw === null, 'sweep resolved — the loop is still alive', threw ? `(${threw.message})` : '');
    ok(logs.some(l => /#1 — attempt threw, skipped: pair 0x9{40}/.test(l)), 'logged the throw, naming the pair', logs.find(l => /attempt threw/.test(l))?.slice(0, 90) ?? '');
    ok(loop.stats().attempts === 4, 'the next candidate was still attempted in each sweep', `(attempts ${loop.stats().attempts})`);
    ok(loop.stats().skippedMuted === 1, 'after 2 throws the triangle is muted', `(muted skips ${loop.stats().skippedMuted})`);
} finally {
    anvil.kill();
}
console.log(fails === 0 ? '\nALL UNREADABLE-PAIR CHECKS PASS' : `\n${fails} FAILED`);
process.exit(fails ? 1 : 0);
