// What the Sonic hot loop got wrong, each against a real chain (anvil):
//
//   1. Solidly-family pairs emit Sync(uint256,uint256), not Sync(uint112,uint112).
//      The watcher must deliver both — over a websocket subscription AND over
//      ranged getLogs — or every Shadow/Equalizer/Velodrome pair stays frozen at
//      its `yarn reserves` snapshot.
//   2. A block's pushed logs reach the consumer as ONE batch, latest per pair,
//      so the hot loop prices the block's final state rather than attempting
//      on its first Sync and cooling down through the rest.
//   3. The hot loop heals and forgets:
//        - after a decayed edge or an InsufficientRepay revert it re-reads the
//          cycle's pairs and corrects the index;
//        - a triangle that keeps reverting is muted instead of re-attempted
//          every block;
//        - the cooldown starts on a broadcast, not on every dry-run simulation.
//
//   anvil --silent &   node test/compile.mjs   node --experimental-strip-types test/test-sync-topics.mjs

import { JsonRpcProvider, Wallet, ContractFactory, id, AbiCoder } from 'ethers';
import { readFileSync } from 'fs';
import { watchSync, SYNC_TOPIC, SOLIDLY_SYNC_TOPIC } from '../source/orchestrator/sync-watcher.ts';
import { createHotLoop } from '../source/orchestrator/hot-loop.ts';

const art = JSON.parse(readFileSync(new URL('./artifacts.json', import.meta.url), 'utf8'));
const RPC_URL = 'http://127.0.0.1:8545', WS_URL = 'ws://127.0.0.1:8545';
const provider = new JsonRpcProvider(RPC_URL, undefined, { cacheTimeout: -1, staticNetwork: true });
const w = new Wallet('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', provider);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let fails = 0;
const ok = (c, l, extra = '') => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${l} ${extra}`); if (!c) fails++; };
const coder = AbiCoder.defaultAbiCoder();

const deploy = async (n, ...a) => {
    const c = await new ContractFactory(art[n].abi, art[n].bytecode, w).deploy(...a);
    await c.waitForDeployment(); return c;
};

// A "Solidly pair": any call emits Sync(uint256,uint256) with the calldata as
// its data. Runtime: calldatacopy(0,0,cds); log1(0, cds, topic); stop.
async function deploySolidlyEmitter() {
    const runtime = '0x' +
        '36' + '6000' + '6000' + '37' +              // CALLDATASIZE 0 0 CALLDATACOPY
        '7f' + SOLIDLY_SYNC_TOPIC.slice(2) +          // PUSH32 topic
        '36' + '6000' + 'a1' + '00';                  // CALLDATASIZE 0 LOG1 STOP
    const len = (runtime.length - 2) / 2;
    const init = '0x60' + len.toString(16).padStart(2, '0') + '600c60003960' + len.toString(16).padStart(2, '0') + '6000f3' + runtime.slice(2);
    const rc = await (await w.sendTransaction({ data: init })).wait();
    return rc.contractAddress.toLowerCase();
}
const emitSolidly = async (addr, r0, r1, nonce) =>
    w.sendTransaction({ to: addr, data: coder.encode(['uint256', 'uint256'], [r0, r1]), ...(nonce !== undefined ? { nonce } : {}) });

console.log('1. both Sync events are watched');
ok(SOLIDLY_SYNC_TOPIC === id('Sync(uint256,uint256)'), 'SOLIDLY_SYNC_TOPIC = keccak("Sync(uint256,uint256)")');
ok(SYNC_TOPIC === id('Sync(uint112,uint112)'), 'SYNC_TOPIC unchanged');

const SP = await deploySolidlyEmitter();
// uint256 reserves above uint112's ceiling — Solidly declares them uint256.
const BIG = (1n << 120n) + 12345n;
for (const [mode, ws] of [['subscribe', WS_URL], ['topic', undefined]]) {
    const got = [];
    const watcher = await watchSync(RPC_URL, ws, {
        isInteresting: (p) => p === SP,
        onBatch: (u) => { got.push(...u); },
        onError: () => {},
        pollMs: 100,
    });
    await (await emitSolidly(SP, 1000n, BIG)).wait();
    for (let i = 0; i < 40 && got.length === 0; i++) await sleep(100);
    const last = got.at(-1);
    ok(watcher.transport() === mode && last && last.reserve0 === 1000 && last.reserve1 === Number(BIG),
       `${mode}: Solidly Sync(uint256,uint256) delivered and decoded`, last ? `${last.reserve0}/${last.reserve1.toExponential(3)}` : 'nothing');
    await watcher.stop();
}

console.log('\n2. one block\'s pushed logs arrive as one batch');
{
    const tA = await deploy('MockToken', 'A', 0), tB = await deploy('MockToken', 'B', 0);
    const [A, B] = [await tA.getAddress(), await tB.getAddress()];
    const v2 = await deploy('MockPair', A, B, 30);
    const V2 = (await v2.getAddress()).toLowerCase();
    await (await tA.mint(V2, 10n ** 21n)).wait();
    await (await tB.mint(V2, 10n ** 21n)).wait();

    const batches = [];
    const watcher = await watchSync(RPC_URL, WS_URL, {
        isInteresting: (p) => p === V2 || p === SP,
        onBatch: (u, to) => { batches.push({ u: u.map(x => ({ ...x })), to }); },
        onError: () => {},
    });
    await sleep(300);
    await provider.send('evm_setAutomine', [false]);
    let nonce = await provider.getTransactionCount(w.address, 'pending');
    // In ONE block: V2 pair syncs twice (with a balance change between), the
    // Solidly pair syncs twice.
    await (await v2.sync({ nonce: nonce++ }));
    await (await tA.mint(V2, 5n * 10n ** 20n, { nonce: nonce++ }));
    await (await v2.sync({ nonce: nonce++ }));
    await emitSolidly(SP, 1n, 2n, nonce++);
    await emitSolidly(SP, 777n, 888n, nonce++);
    await provider.send('evm_mine', []);
    await provider.send('evm_setAutomine', [true]);
    for (let i = 0; i < 40 && batches.length === 0; i++) await sleep(50);
    await sleep(200);
    const b = batches[0];
    const v2u = b?.u.find(x => x.pair === V2), spu = b?.u.find(x => x.pair === SP);
    ok(batches.length === 1 && b.u.length === 2, 'one batch carrying both pairs', `${batches.length} batch(es), sizes ${batches.map(x => x.u.length)}`);
    ok(v2u && v2u.reserve0 + v2u.reserve1 === 2.5e21, 'V2 pair: the block\'s LAST Sync wins', v2u ? `${v2u.reserve0}+${v2u.reserve1}` : '');
    ok(spu && spu.reserve0 === 777 && spu.reserve1 === 888, 'Solidly pair: the block\'s LAST Sync wins');
    const st = watcher.stats();
    ok(st.logsPushed >= 4 && st.batches === 1, 'stats: 4 logs pushed, 1 batch', JSON.stringify(st));
    await watcher.stop();
}

console.log('\n3. hot loop: resync, mute, cooldown');
{
    // Minimal index: one pair, one triangle that always scores as a candidate.
    const P = '0x00000000000000000000000000000000000000aa';
    const ix = {
        pairIdx: new Map([[P, 0]]), res0: new Float64Array([100]), res1: new Float64Array([100]),
        applySync(p, r0, r1) { const i = this.pairIdx.get(p); if (i === undefined) return -1; this.res0[i] = r0; this.res1[i] = r1; return i; },
        affectedTriangles: () => [0],
        isV3Pool: () => false,
        scoreMany: () => [{ triangleId: 7, rootToken: '0xroot', netProfit: 1, hopCount: 2,
                            hops: [{ pair: P, factory: '0xf', tokenIn: '0xroot', tokenOut: '0xb', fee: 0.003 }] }],
    };
    let t = 1_000_000;
    const logs = [];
    let mode = 'decay';
    let attempts = 0;
    const hot = createHotLoop({
        index: ix, db: null, thresholds: () => ({}), pricing: () => ({ '0xroot': { priceInNumeraire: 1 } }),
        decimalsByToken: new Map(), candidatesPerBlock: 3, cooldownMs: 2000,
        now: () => t, log: (s) => logs.push(s), report: () => {},
        refresh: async (pairs) => pairs.map(p => ({ pair: p, reserve0: 55, reserve1: 66 })),
        muteAfterFailures: 3, muteMs: 60_000,
        attempt: async (c) => {
            attempts++;
            if (mode === 'decay') return { candidate: c, built: null, simulated: false, broadcast: false, confirmed: false };
            return { candidate: c, built: {}, simulated: false, broadcast: false, confirmed: false,
                     simulationError: 'execution reverted (unknown custom error) (data="0x305792c3...")' };
        },
    });
    const sync = (n) => hot.onBatch([{ pair: P, reserve0: 100 + n, reserve1: 100, blockNumber: n, logIndex: 0 }], n);

    await sync(1);
    ok(ix.res0[0] === 55 && ix.res1[0] === 66, 'decayed edge -> pair re-read and index corrected', `${ix.res0[0]}/${ix.res1[0]}`);
    ok(logs.some(l => /resynced 1 pair\(s\) after a decayed edge: 1 were stale/.test(l)), 'and it says so');

    // Dry-run attempts never broadcast, so the very next block is NOT on cooldown.
    t += 10;
    const before = attempts;
    await sync(2);
    ok(attempts === before + 1 && !logs.some(l => /cooldown/.test(l)), 'no cooldown after a non-broadcast attempt');

    mode = 'revert';
    for (let n = 3; n <= 5; n++) { t += 10; await sync(n); }
    ok(logs.some(l => /muting #7 for 1m after 3 failed simulations/.test(l)), 'muted after 3 reverting simulations');
    const atMute = attempts;
    t += 10; await sync(6);
    ok(attempts === atMute && hot.stats().skippedMuted === 1, 'muted triangle is not attempted', `attempts ${atMute}->${attempts}`);
    t += 61_000; await sync(7);
    ok(attempts === atMute + 1, 'mute expires', `attempts ${attempts}`);
    ok(hot.stats().pairsResynced >= 4, 'InsufficientRepay reverts resync too', `${hot.stats().pairsResynced} resynced`);
}

console.log('\n4. hot loop: gas refusals');
{
    // Two cycles sharing pool P: a dust one (#1, refused for gas) ranked first,
    // and a bigger one (#2) behind it. Both direction 'forward'.
    const P = '0x00000000000000000000000000000000000000bb', Q = '0x00000000000000000000000000000000000000cc';
    let dust = 50, big = 500;
    const hop = (pair) => ({ pair, factory: '0xf', tokenIn: '0xroot', tokenOut: '0xb', fee: 0.003 });
    const ix = {
        pairIdx: new Map([[P, 0]]), res0: new Float64Array([1]), res1: new Float64Array([1]),
        applySync(p) { return this.pairIdx.get(p) ?? -1; },
        affectedTriangles: () => [0], isV3Pool: () => false,
        scoreMany: () => [
            { triangleId: 1, direction: 'forward', rootToken: '0xroot', netProfit: dust, hopCount: 2, hops: [hop(P), hop(Q)] },
            { triangleId: 2, direction: 'forward', rootToken: '0xroot', netProfit: big, hopCount: 2, hops: [hop(P), hop(Q)] },
        ],
    };
    let t = 5_000_000;
    const tried = [];
    const hot = createHotLoop({
        index: ix, db: null, thresholds: () => ({}), pricing: () => ({}),
        decimalsByToken: new Map(), candidatesPerBlock: 5, cooldownMs: 0,
        now: () => t, log: () => {}, report: () => {}, gasMemoryMs: 60_000,
        attempt: async (c) => {
            tried.push(c.triangleId);
            // Gas floor 100 raw units: #1 below it, #2 above (and then the edge decays).
            if (c.netProfit < 100) return { candidate: c, built: {}, simulated: false, broadcast: false, confirmed: false, belowGasFloor: true, gasFloorWei: 100n };
            return { candidate: c, built: null, simulated: false, broadcast: false, confirmed: false };
        },
    });
    const block = (n) => hot.onBatch([{ pair: P, reserve0: 1, reserve1: 1, blockNumber: n, logIndex: 0 }], n);

    // pricing() is empty, so both rank equally and keep their order: #1 first.
    await block(1);
    ok(tried.join() === '1,2', 'a gas refusal does not block the next cycle through the same pool', `tried ${tried.join()}`);
    tried.length = 0; t += 10;
    await block(2);
    ok(!tried.includes(1) && hot.stats().skippedBelowGas === 1, 'the refused cycle is not re-estimated while still below its floor', `tried ${tried.join() || 'none'}`);
    tried.length = 0; t += 10; dust = 150;
    await block(3);
    ok(tried.includes(1), 'once the index scores it above the remembered floor, it is tried again');
    tried.length = 0; t += 10; dust = 50;
    await block(4);
    ok(!tried.includes(1), 'back below the floor: skipped again (the floor is kept)', `tried ${tried.join() || 'none'}`);
    tried.length = 0; t += 61_000;
    await block(6);
    ok(tried.includes(1), 'the memory expires (gas price may have moved)');
}

console.log(fails === 0 ? '\nALL SYNC-TOPIC CHECKS PASS' : `\n${fails} FAILED`);
provider.destroy();
process.exit(fails ? 1 : 0);
