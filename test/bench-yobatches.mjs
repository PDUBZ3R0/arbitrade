// How much does a YoBatches batch cost, and how big can one get?
//
// The practical ceiling on batch size is the node's eth_call gas cap (commonly
// 50M, sometimes 10M). Bigger batches = fewer round trips, and the Polygon
// reserves run is round-trip bound: 203,832 pairs in 1,102 batches took 407s,
// with 94% of that in three factories whose 20-way concurrency bought only
// 1.8x over serial. So gas per pair is the lever that sets how few round trips
// are possible.
//
// Measured, not estimated. Two things are easy to get wrong by reasoning:
//   * COLD vs WARM account access. The first touch of an address costs 2600,
//     later ones 100. In production almost every token is a distinct cold
//     address; a benchmark that reuses three tokens measures the warm path and
//     flatters itself by ~25x. So every pair here gets two freshly deployed
//     tokens.
//   * Per-pair cost is what matters, not total. Measured at several sizes and
//     fitted, so the fixed overhead is separated from the slope.

import { JsonRpcProvider, Wallet, ContractFactory, Interface } from 'ethers';
import { readFileSync } from 'fs';

const art = JSON.parse(readFileSync(new URL('./artifacts.json', import.meta.url), 'utf8'));
const provider = new JsonRpcProvider('http://127.0.0.1:8545', undefined, { cacheTimeout: -1, staticNetwork: true });
const w = new Wallet('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', provider);

const deploy = async (n, ...a) => {
    const f = new ContractFactory(art[n].abi, art[n].bytecode, w);
    const c = await f.deploy(...a); await c.waitForDeployment(); return c;
};

const MAX_PAIRS = 120;           // 240 distinct tokens
console.log(`Deploying ${MAX_PAIRS * 2} distinct tokens (so every account access is cold)...`);
const tokens = [];
for (let i = 0; i < MAX_PAIRS * 2; i++) {
    const f = new ContractFactory(art.MockToken.abi, art.MockToken.bytecode, w);
    const c = await f.deploy('T' + i, 0);
    tokens.push(await c.getAddress());
    if (i % 60 === 59) process.stdout.write(`  ${i + 1}/${MAX_PAIRS * 2}\r`);
}
console.log(`  ${tokens.length} tokens deployed      `);

// "Pairs" only need to be addresses we ask for a balance of. Use the token
// addresses themselves as pools so they are cold too.
const triples = [];
for (let i = 0; i < MAX_PAIRS; i++) {
    triples.push([tokens[i * 2], tokens[i * 2], tokens[i * 2 + 1]]);
}
// Give them balances so the balanceOf path returns a non-zero word.
for (let i = 0; i < MAX_PAIRS; i++) {
    const t = new ContractFactory(art.MockToken.abi, art.MockToken.bytecode, w).attach(tokens[i * 2 + 1]);
    await (await t.mint(tokens[i * 2], 10n ** 21n)).wait();
}

const v1 = await deploy('YoBatches');
const v2 = await deploy('YoBatches2');
const V1 = await v1.getAddress(), V2 = await v2.getAddress();

const if1 = new Interface(['function getReservesByPairs(address[3][] args) view returns ((address pair, address token0, uint256 reserves0, address token1, uint256 reserves1)[])']);
const if2 = new Interface(['function getReserves(address[3][] args) view returns (uint256[])']);

async function measure(to, iface, fn, n) {
    const data = iface.encodeFunctionData(fn, [triples.slice(0, n)]);
    const gas = await provider.estimateGas({ to, data });
    const raw = await provider.call({ to, data });
    const decoded = iface.decodeFunctionResult(fn, raw)[0];
    return {
        gas: Number(gas),
        reqBytes: (data.length - 2) / 2,
        resBytes: (raw.length - 2) / 2,
        rows: decoded.length,
    };
}

const SIZES = [10, 30, 60, 120];
console.log('\n' + '='.repeat(74));
console.log('pairs |      v1 gas |      v2 gas | v1 res B | v2 res B | saving');
console.log('-'.repeat(74));
const r1 = [], r2 = [];
for (const n of SIZES) {
    const a = await measure(V1, if1, 'getReservesByPairs', n);
    const b = await measure(V2, if2, 'getReserves', n);
    r1.push([n, a.gas]); r2.push([n, b.gas]);
    console.log(
        String(n).padStart(5) + ' | ' + a.gas.toLocaleString().padStart(11) + ' | ' + b.gas.toLocaleString().padStart(11) +
        ' | ' + String(a.resBytes).padStart(8) + ' | ' + String(b.resBytes).padStart(8) +
        ' | ' + (100 - 100 * b.gas / a.gas).toFixed(1) + '%');
}

// Least-squares slope = marginal gas per pair; intercept = fixed overhead.
const fit = (pts) => {
    const n = pts.length;
    const sx = pts.reduce((a, p) => a + p[0], 0), sy = pts.reduce((a, p) => a + p[1], 0);
    const sxy = pts.reduce((a, p) => a + p[0] * p[1], 0), sxx = pts.reduce((a, p) => a + p[0] * p[0], 0);
    const m = (n * sxy - sx * sy) / (n * sxx - sx * sx);
    return { perPair: m, fixed: (sy - m * sx) / n };
};
const f1 = fit(r1), f2 = fit(r2);
console.log('='.repeat(74));
console.log(`v1: ${f1.perPair.toFixed(0)} gas/pair (+${f1.fixed.toFixed(0)} fixed)`);
console.log(`v2: ${f2.perPair.toFixed(0)} gas/pair (+${f2.fixed.toFixed(0)} fixed)   ` +
    `${(100 - 100 * f2.perPair / f1.perPair).toFixed(1)}% cheaper per pair`);

console.log('\nMax pairs per eth_call at common node gas caps:');
console.log('   cap    |      v1 |      v2');
for (const cap of [10e6, 30e6, 50e6, 100e6]) {
    const a = Math.floor((cap - f1.fixed) / f1.perPair);
    const b = Math.floor((cap - f2.fixed) / f2.perPair);
    console.log('  ' + (cap / 1e6 + 'M').padStart(6) + '   | ' + a.toLocaleString().padStart(7) + ' | ' + b.toLocaleString().padStart(7));
}

console.log('\nRound trips for Polygon (203,832 pairs), batch size vs transport cost:');
console.log('  batch |  batches | note');
for (const bs of [200, 500, 1000, 2000, 3000]) {
    const batches = Math.ceil(203832 / bs);
    const g1 = f1.fixed + f1.perPair * bs, g2 = f2.fixed + f2.perPair * bs;
    const fits = (g, cap) => g <= cap ? 'ok' : 'OVER';
    console.log('  ' + String(bs).padStart(5) + ' | ' + String(batches).padStart(8) +
        ` | v1 ${(g1 / 1e6).toFixed(1)}M gas (${fits(g1, 50e6)} @50M), v2 ${(g2 / 1e6).toFixed(1)}M (${fits(g2, 50e6)} @50M)`);
}
console.log(`\n  current: 200/batch = 1,020 batches. Measured run: 1,102 batches / 407s.`);
provider.destroy();
