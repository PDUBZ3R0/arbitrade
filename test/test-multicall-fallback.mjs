// multicall3() on a chain without Multicall3 (Hydration has none): the same
// calls give the same results through aggregate3 and through the per-call
// fallback, and allowFailure: false still fails the batch. Starts its own anvil.
//
//   node test/compile.mjs   (once)
//   node --experimental-strip-types test/test-multicall-fallback.mjs

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { ethers } from 'ethers';
import { multicall3, MULTICALL3_ADDRESS } from '../source/util/multicall.ts';

const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (cond, what, got) => {
    if (cond) { pass++; console.log(`  ok   ${what}`); }
    else { fail++; console.log(`  FAIL ${what}${got !== undefined ? `  got ${JSON.stringify(got)}` : ''}`); }
};

const art = JSON.parse(fs.readFileSync(new URL('./artifacts.json', import.meta.url), 'utf8'));
const PORT = 8566, RPC = `http://127.0.0.1:${PORT}`;
const anvil = spawn('anvil', ['--port', String(PORT), '--silent']);
await sleep(1500);
const fresh = () => new ethers.JsonRpcProvider(RPC, undefined, { staticNetwork: true, cacheTimeout: -1 });

try {
    const p0 = fresh();
    const w = new ethers.Wallet('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', p0);
    const f = new ethers.ContractFactory(art.Multicall3Min.abi, art.Multicall3Min.bytecode, w);
    const mc = await f.deploy(); await mc.waitForDeployment();
    const target = await mc.getAddress();   // any contract: getBlockNumber() answers, a bogus selector reverts
    const iface = new ethers.Interface(['function getBlockNumber() view returns (uint256)']);
    const calls = [
        { target, allowFailure: true, callData: iface.encodeFunctionData('getBlockNumber', []) },
        { target, allowFailure: true, callData: '0xdeadbeef' },
        { target: '0x00000000000000000000000000000000000c0de0', allowFailure: true, callData: '0x' },   // no code: succeeds empty
    ];
    const block = await p0.getBlockNumber();

    console.log('\nno Multicall3 at the canonical address');
    await p0.send('anvil_setCode', [MULTICALL3_ADDRESS, '0x']);
    const pa = fresh();
    const each = await multicall3(pa, calls, block);
    ok(each.length === 3, 'one result per call');
    ok(each[0].success && BigInt(each[0].returnData) === BigInt(block), 'a call that answers comes back with its data, at the block asked for', each[0]);
    ok(!each[1].success, 'a reverting call is a failure, not a throw', each[1]);
    ok(each[2].success && each[2].returnData === '0x', 'a call to an address without code succeeds empty, as in aggregate3', each[2]);
    let threw = false;
    try { await multicall3(pa, [{ ...calls[1], allowFailure: false }]); } catch { threw = true; }
    ok(threw, 'allowFailure: false and a revert fails the whole batch');

    console.log('\nMulticall3 at the canonical address');
    await p0.send('anvil_setCode', [MULTICALL3_ADDRESS, await p0.getCode(target)]);
    const pb = fresh();   // the code lookup is cached per provider
    const agg = await multicall3(pb, calls, block);
    ok(agg.map(r => r.success).join() === each.map(r => r.success).join(), 'same success flags through aggregate3', agg);
    ok(agg[0].returnData === each[0].returnData, 'same return data through aggregate3');
    for (const p of [p0, pa, pb]) p.destroy();
} finally {
    anvil.kill();
}

console.log(`\n${fail ? `${fail} FAILED, ` : ''}${pass} ok`);
if (fail) process.exit(1);
console.log('all passed');
