// An Algebra V1 pool's next-swap fee, read from its volatility oracle as the pool
// (util/algebra-fee.ts), which build-hops prices at when it is the higher one.
//
// Polygon, 2026-11-01: QuickSwap V3 pool 0x1a8a985d stored fee 2780 and charged
// ~10,800 on the next swap; path #2844927 came up 0.77% short three times.
//
//   1. operator answers → its fee (and only when asked "from" the pool)
//   2. operator's getFee fails (Algebra 1.9 getFees, a bad read) → null
//   3. no dataStorageOperator (Integral, a Uniswap pool) → null, and cached
//
//   node --experimental-strip-types test/test-algebra-next-fee.mjs   (anvil on PATH; own anvil on 8575)

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { ethers } from 'ethers';
import { algebraV1NextFee, resetAlgebraOperatorCache } from '../source/util/algebra-fee.ts';

const require = createRequire(import.meta.url);
const here = (p) => new URL(p, import.meta.url);
let fails = 0;
const ok = (c, l, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${l} ${extra}`); if (!c) fails++; };

const solc = require('solc');
const out = JSON.parse(solc.compile(JSON.stringify({
    language: 'Solidity',
    sources: { 'Mocks.sol': { content: fs.readFileSync(here('./Mocks.sol'), 'utf8') } },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'shanghai', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
})));
for (const e of out.errors ?? []) if (e.severity === 'error') { console.error(e.formattedMessage); process.exit(1); }
const art = {};
for (const [, cs] of Object.entries(out.contracts)) for (const [n, c] of Object.entries(cs)) art[n] = { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object };

const PORT = 8575;
const anvil = spawn('anvil', ['--port', String(PORT), '--silent']);
await new Promise(r => setTimeout(r, 1500));
const provider = new ethers.JsonRpcProvider(`http://127.0.0.1:${PORT}`, undefined, { cacheTimeout: -1, staticNetwork: true });
const signer = await provider.getSigner(0);
let nonce = await provider.getTransactionCount(await signer.getAddress());
const ov = () => ({ nonce: nonce++, gasLimit: 10_000_000n });
const deploy = async (a, ...args) => { const c = await new ethers.ContractFactory(a.abi, a.bytecode, signer).deploy(...args, ov()); await c.waitForDeployment(); return c; };
const send = async (p) => (await p).wait();
const state = { tick: -203463, liquidity: 1047233498110296n };
const now = Math.floor(Date.now() / 1000);

try {
    const pool = await deploy(art.MockAlgebraV1Pool, 2780);
    const P = await pool.getAddress();
    const op = await deploy(art.MockAlgebraOperator, P, 10823);
    const O = await op.getAddress();
    await send(pool.setOperator(O, ov()));

    console.log('1. the oracle answers its pool');
    ok(await algebraV1NextFee(provider, P, state, now) === 10823, 'next-swap fee 10823 (stored 2780)');
    let refused = false;
    try { await provider.call({ to: O, data: op.interface.encodeFunctionData('getFee', [now, state.tick, 341, state.liquidity]) }); } catch { refused = true; }
    ok(refused, 'the same call not "from" the pool is refused — why the helper sets from');

    console.log('\n2. the oracle cannot answer');
    await send(op.set(10823, true, ov()));
    ok(await algebraV1NextFee(provider, P, state, now) === null, 'getFee reverts → null (stored fee stands)');

    console.log('\n3. not an Algebra V1 pool');
    resetAlgebraOperatorCache();
    const other = await deploy(art.MockToken, 'NOT-A-POOL', 0);
    ok(await algebraV1NextFee(provider, await other.getAddress(), state, now) === null, 'no dataStorageOperator() → null');
    ok(await algebraV1NextFee(provider, '0x00000000000000000000000000000000000000aa', state, now) === null, 'no code → null');
} catch (e) {
    console.error(e); fails++;
} finally {
    anvil.kill();
}
console.log(fails ? `\n${fails} FAILED` : '\nALL ALGEBRA-NEXT-FEE CHECKS PASS');
process.exit(fails ? 1 : 0);
