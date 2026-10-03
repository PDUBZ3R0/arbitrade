// Regenerates test/fixtures/v3-golden.json: random V3 pools and swaps
// executed against the real UniswapV3Pool bytecode (v3-core 1.0.0) on a local
// anvil, each checked field-for-field against calculus-v3.js's v3_swap_exact.
// Exits non-zero on any mismatch.
//
//   npm i -D @uniswap/v3-core@1.0.1 solc@0.8.26     (one-time)
//   node test/v3-golden/gen.mjs                     (anvil on PATH)
//   POOLS=60 SWAPS=40 SEED=999 node test/v3-golden/gen.mjs   (bigger / other seed; WRITE=0 to check only)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { ethers } from 'ethers';
import { createRequire } from 'node:module';
import { v3_swap_exact, getSqrtRatioAtTick, MIN_SQRT_RATIO, MAX_SQRT_RATIO } from '../../source/util/calculus-v3.js';

const here = (p) => new URL(p, import.meta.url);
const require = createRequire(import.meta.url);

// compile the tiny harness (mintable tokens + callback payer) with solc-js
function compileHarness() {
    const solc = require('solc');
    const input = { language: 'Solidity', sources: { 'H.sol': { content: fs.readFileSync(here('./V3Harness.sol'), 'utf8') } },
        settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } };
    const o = JSON.parse(solc.compile(JSON.stringify(input)));
    for (const e of o.errors ?? []) if (e.severity === 'error') throw new Error(e.formattedMessage);
    const c = o.contracts['H.sol'];
    const pick = (n) => ({ abi: c[n].abi, bytecode: '0x' + c[n].evm.bytecode.object });
    return { Tok: pick('Tok'), Harness: pick('Harness') };
}

const POOLS = +process.env.POOLS || 40, SWAPS = +process.env.SWAPS || 40;
const anvil = spawn('anvil', ['--port', '8547', '--disable-code-size-limit', '--gas-limit', '3000000000', '--silent']);
await new Promise(r => setTimeout(r, 1500));
const provider = new ethers.JsonRpcProvider('http://127.0.0.1:8547', undefined, { cacheTimeout: -1 });
const signer = await provider.getSigner(0);
let nonce = await provider.getTransactionCount(await signer.getAddress());
const send = async (p) => { const tx = await p; await tx.wait(); };
const ov = () => ({ nonce: nonce++, gasLimit: 30_000_000n });

const art = n => require(`@uniswap/v3-core/artifacts/contracts/${n}.sol/${n}.json`);
const F = art('UniswapV3Factory'), P = art('UniswapV3Pool');
const out = compileHarness();
const deploy = async (a) => { const c = await new ethers.ContractFactory(a.abi, a.bytecode, signer).deploy(ov()); await c.waitForDeployment(); return c; };

const factory = await deploy(F);
await send(factory.enableFeeAmount(100, 1, ov()));
const harness = await deploy(out.Harness);
const H = await harness.getAddress();

let seed = +process.env.SEED || 12345;
const rnd = () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const logU = (lo, hi) => BigInt(Math.floor(10 ** (lo + rnd() * (hi - lo))).toLocaleString('fullwide', { useGrouping: false }));
const bigRand = (lo, hi) => lo + (BigInt(Math.floor(rnd() * 2 ** 50)) * (hi - lo)) / (1n << 50n);

const TIERS = [[100, 1], [500, 10], [3000, 60], [10000, 200]];
let checks = 0, fails = 0, reverts = 0, crossedTotal = 0, stepsTotal = 0, multiWord = 0;
const golden = [];

for (let p = 0; p < POOLS; p++) {
    const [fee, spacing] = TIERS[p % 4];
    const ta = await deploy(out.Tok), tb = await deploy(out.Tok);
    let [t0, t1] = [await ta.getAddress(), await tb.getAddress()];
    if (BigInt(t0) > BigInt(t1)) [t0, t1] = [t1, t0];
    await send(factory.createPool(t0, t1, fee, ov()));
    const pool = new ethers.Contract(await factory.getPool(t0, t1, fee), P.abi, signer);
    const PA = await pool.getAddress();

    const t = ri(-60000, 60000);
    const sp0 = bigRand(getSqrtRatioAtTick(t), getSqrtRatioAtTick(t + 1));
    await send(pool.initialize(sp0, ov()));

    const nPos = ri(2, 14), span = spacing * ri(20, 900);
    const center = Math.floor(t / spacing) * spacing;
    for (let k = 0; k < nPos; k++) {
        let lo = center - Math.floor(rnd() * span / spacing) * spacing;
        let hi = center + Math.ceil(rnd() * span / spacing + 1) * spacing;
        if (rnd() < 0.3) { // ranges entirely on one side: creates liquidity gaps
            const off = ri(1, 60) * spacing * (rnd() < 0.5 ? -1 : 1);
            lo += off; hi += off;
        }
        if (lo >= hi) hi = lo + spacing;
        await send(harness.mint(PA, lo, hi, logU(9, 23), ov()));
    }

    for (let s = 0; s < SWAPS; s++) {
        const [slot0, liq] = await Promise.all([pool.slot0(), pool.liquidity()]);
        // Rebuild the tick table from chain: TickLens-equivalent via bitmap words.
        const ticks = [];
        const tc = Math.floor(Number(slot0[1]) / spacing);
        const words = []; for (let w = (tc >> 8) - 12; w <= (tc >> 8) + 12; w++) words.push(w);
        const bms = await Promise.all(words.map(w => pool.tickBitmap(w)));
        const idxs = [];
        words.forEach((w, k) => { for (let b = 0; b < 256; b++) if ((bms[k] >> BigInt(b)) & 1n) idxs.push((w * 256 + b) * spacing); });
        const tl = await Promise.all(idxs.map(i => pool.ticks(i)));
        idxs.forEach((index, k) => ticks.push({ index, liquidityNet: tl[k].liquidityNet }));
        const lowW = ((tc >> 8) - 12) * 256 * spacing, highW = (((tc >> 8) + 12) * 256 + 255) * spacing;
        const state = { sqrtPriceX96: slot0[0], tick: Number(slot0[1]), liquidity: liq, fee, tickSpacing: spacing, ticks, windowLow: lowW, windowHigh: highW };

        const zf = rnd() < 0.5;
        const exactIn = rnd() < 0.6;
        const L = liq > 0n ? liq : 10n ** 15n;
        let amt = (L * logU(0, 8)) / 10n ** 6n + 1n;
        if (!exactIn) amt = -amt;
        let lim;
        if (rnd() < 0.3) {
            const d = BigInt(Math.floor(rnd() * 2 ** 30));
            lim = zf ? state.sqrtPriceX96 - (state.sqrtPriceX96 * d) / (1n << 32n) - 1n
                     : state.sqrtPriceX96 + (state.sqrtPriceX96 * d) / (1n << 32n) + 1n;
            if (lim <= MIN_SQRT_RATIO) lim = MIN_SQRT_RATIO + 1n;
            if (lim >= MAX_SQRT_RATIO) lim = MAX_SQRT_RATIO - 1n;
        }
        const limArg = lim ?? (zf ? MIN_SQRT_RATIO + 1n : MAX_SQRT_RATIO - 1n);

        let chain, sim, chainErr, simErr;
        try { chain = await harness.swapReport.staticCall(PA, zf, amt, limArg); } catch (e) { chainErr = e.shortMessage || e.message; }
        try { sim = v3_swap_exact(state, zf, amt, lim); } catch (e) { simErr = e.message; }

        checks++;
        if (chainErr || simErr) {
            reverts++;
            if (!(chainErr && simErr)) { fails++; console.log('REVERT MISMATCH', { chainErr, simErr, fee, zf, amt, lim }); }
            continue;
        }
        if (!sim.complete) { checks--; continue; }
        const same = chain[0] === sim.amount0 && chain[1] === sim.amount1 && chain[2] === sim.sqrtPriceX96
                  && Number(chain[3]) === sim.tick && chain[4] === sim.liquidity;
        crossedTotal += sim.crossed; stepsTotal += sim.steps; if (sim.steps > sim.crossed + 1) multiWord++;
        if (!same) {
            fails++;
            console.log('MISMATCH', { fee, zf, amt, lim, chain: chain.map(String), sim });
        } else if (golden.length < 600 && (sim.crossed > 0 || rnd() < 0.25)) {
            golden.push({ pool: state, zeroForOne: zf, amountSpecified: amt, sqrtPriceLimitX96: lim,
                          expect: { amount0: sim.amount0, amount1: sim.amount1, sqrtPriceX96: sim.sqrtPriceX96, tick: sim.tick, liquidity: sim.liquidity } });
        }
        // Commit some swaps so later checks start from moved states.
        if (rnd() < 0.35) { try { await send(harness.swap(PA, zf, amt, limArg, ov())); } catch { nonce = await provider.getTransactionCount(await signer.getAddress()); } }
    }
    process.stdout.write(`pool ${p + 1}/${POOLS} fee=${fee} checks=${checks} fails=${fails}\r`);
}
console.log(`\nchecks=${checks} fails=${fails} bothReverted=${reverts} ticksCrossed=${crossedTotal} steps=${stepsTotal} swapsWithEmptyWordSteps=${multiWord}`);
if (process.env.WRITE !== '0' && !fails) fs.writeFileSync(here('../fixtures/v3-golden.json'), JSON.stringify(golden, (k, v) => typeof v === 'bigint' ? v.toString() + 'n' : v));
console.log('golden vectors:', golden.length);
anvil.kill();
process.exit(fails ? 1 : 0);
