// -----------------------------------------------------------------------------
// Concentrated-liquidity factory verifier.
//
// The V3 counterpart to verify-factory.ts. Given a factory address, decide by
// MEASUREMENT — not by its name — whether its pools are something this bot can
// price and trade:
//
//   1. Which creation event does it emit? (pool-events.ts: V3, V3-by-spacing,
//      Algebra). That picks the scanner's topic for it: `poolEvent`.
//   2. Do sample pools answer slot0(), liquidity(), fee() and tickSpacing()
//      with values in range? That is what calculus-v3.js and
//      YoBatches2.getV3State read.
//   3. Is ticks()'s layout the one the reader assumes? For an initialized
//      tick, word 0 must be liquidityGross > 0 and word 1 liquidityNet with
//      |liquidityNet| <= liquidityGross. A fork that reorders the struct fails
//      this and is rejected rather than mispriced.
//   4. Which swap callback does the pool call? Found by looking for the
//      callback's 4-byte selector (PUSH4) in the pool's runtime bytecode, or
//      the implementation's when the pool is an EIP-1167 clone. The executor
//      must implement exactly that callback, so it goes into config.
//   5. If YoBatches2 is deployed (chain.contract), does getV3State agree with
//      the direct reads? That proves the whole reserves path end to end.
//
// Algebra factories are recognised and reported, but marked unusable: their
// state lives in globalState()/tickTable() with dynamic fees, which nothing
// downstream models yet.
//
// Usage (also reached through `yarn verify <chain> <addr>` when the factory
// emits no PairCreated):
//   node --experimental-strip-types source/util/verify-v3-factory.ts <chain> <address>
// -----------------------------------------------------------------------------

import { ethers, JsonRpcProvider } from 'ethers';
import { realpathSync } from 'node:fs';
import { loadChainConfig } from './config.ts';
import { getContractCreation } from './etherscan.ts';
import { TOPIC_BY_LAYOUT, parseCreationLog, type EventLayout, type ParsedCreation } from './pool-events.ts';

/** Swap callbacks we know how to recognise. The executor implements by name. */
export const KNOWN_CALLBACKS = [
    'uniswapV3SwapCallback',
    'pancakeV3SwapCallback',
    'algebraSwapCallback',
    'ramsesV2SwapCallback',
    'solidlyV3SwapCallback',
] as const;
export type CallbackName = typeof KNOWN_CALLBACKS[number];
const CALLBACK_SELECTORS: Array<{ name: CallbackName; selector: string }> = KNOWN_CALLBACKS.map(name => ({
    name,
    selector: ethers.id(`${name}(int256,int256,bytes)`).slice(2, 10),
}));

const CL_LAYOUTS: EventLayout[] = ['v3', 'v3ts', 'algebra'];

export type V3VerifyResult = {
    address: string;
    /** true when every check passed and the factory can go under factories["v3"]. */
    usable: boolean;
    family: 'v3' | 'algebra' | 'unknown';
    /** Creation event layout seen; v3 -> poolEvent "uniswap", v3ts -> "tickspacing". */
    layout: EventLayout | null;
    poolEvent: 'uniswap' | 'tickspacing' | null;
    callback: CallbackName | null;
    deployBlock: number | null;
    samplePool: string | null;
    /** Fees (pips) and tick spacings seen across the sampled pools. */
    feesSeen: number[];
    spacingsSeen: number[];
    lensChecked: boolean;
    notes: string[];
    configSnippet: string;
};

// ---- raw, tolerant eth_call helpers ----------------------------------------

async function callWords(provider: JsonRpcProvider, to: string, sig: string, args: string = ''): Promise<bigint[] | null> {
    try {
        const data = ethers.id(sig).slice(0, 10) + args;
        const raw = await provider.call({ to, data });
        if (!raw || raw === '0x' || raw.length < 66) return null;
        const out: bigint[] = [];
        for (let i = 2; i + 64 <= raw.length; i += 64) out.push(BigInt('0x' + raw.slice(i, i + 64)));
        return out;
    } catch {
        return null;
    }
}
const enc = (v: bigint | number) => BigInt.asUintN(256, BigInt(v)).toString(16).padStart(64, '0');
const asInt = (w: bigint, bits: number) => Number(BigInt.asIntN(bits, w));

/** Runtime code, following an EIP-1167 minimal proxy to its implementation. */
async function runtimeCode(provider: JsonRpcProvider, addr: string): Promise<{ code: string; via?: string }> {
    const code = (await provider.getCode(addr)).toLowerCase();
    const m = code.match(/^0x363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3$/);
    if (m) {
        const impl = '0x' + m[1];
        return { code: (await provider.getCode(impl)).toLowerCase(), via: impl };
    }
    return { code };
}

/**
 * Callbacks whose selector appears as a PUSH4 operand. Walks opcodes rather
 * than substring-matching, so a selector that merely occurs inside PUSH32
 * data or the metadata blob does not count.
 */
export function findCallbackSelectors(codeHex: string): CallbackName[] {
    const code = codeHex.startsWith('0x') ? codeHex.slice(2) : codeHex;
    const want = new Map(CALLBACK_SELECTORS.map(c => [c.selector, c.name]));
    const found = new Set<CallbackName>();
    for (let i = 0; i < code.length; ) {
        const op = parseInt(code.slice(i, i + 2), 16);
        if (op === 0x63) {
            const hit = want.get(code.slice(i + 2, i + 10));
            if (hit) found.add(hit);
        }
        // PUSH1..PUSH32 carry immediate bytes; skip them
        i += 2 + (op >= 0x60 && op <= 0x7f ? (op - 0x5f) * 2 : 0);
    }
    return [...found];
}

// ---- sampling pools ---------------------------------------------------------

async function samplePools(
    provider: JsonRpcProvider,
    factory: string,
    deployBlock: number | null,
    hypersyncUrl?: string,
    envioToken?: string,
): Promise<{ layout: EventLayout | null; hits: Array<ParsedCreation & { blockNumber: number }> }> {
    const head = await provider.getBlockNumber();

    if (hypersyncUrl && envioToken) {
        const { samplePairsFromFactoryHyperSync } = await import('./hypersync.ts');
        for (const layout of CL_LAYOUTS) {
            try {
                const hits = await samplePairsFromFactoryHyperSync(
                    hypersyncUrl, envioToken, factory, deployBlock ?? 0, head, TOPIC_BY_LAYOUT[layout], layout);
                if (hits.length > 0) {
                    return { layout, hits: hits.map(h => ({ feePips: null, tickSpacing: null, ...h })) };
                }
            } catch (err) {
                console.log(`  [!] HyperSync sample query failed (${(err as Error).message.slice(0, 80)}), falling back to RPC`);
                break;
            }
        }
    }

    // RPC: newest window first (live pools are the useful sample), then the
    // window after deployment. One getLogs per window with all three topics
    // OR-ed, shrinking on range errors.
    const windows: Array<[number, number]> = [[Math.max(0, head - 100_000), head]];
    if (deployBlock !== null && deployBlock + 100_000 < head - 100_000) {
        windows.push([deployBlock, deployBlock + 100_000]);
    }
    const topicSet = CL_LAYOUTS.map(l => TOPIC_BY_LAYOUT[l]);
    for (const [from, to] of windows) {
        let chunk = Math.min(10_000, to - from + 1);
        // walk backwards from the head so the first hit is a recent pool
        for (let end = to; end >= from; ) {
            const start = Math.max(from, end - chunk + 1);
            try {
                const logs = await provider.getLogs({ address: factory, topics: [topicSet], fromBlock: start, toBlock: end });
                if (logs.length > 0) {
                    const layout = CL_LAYOUTS.find(l => TOPIC_BY_LAYOUT[l] === logs[0].topics[0])!;
                    const hits = logs
                        .filter(l => l.topics[0] === TOPIC_BY_LAYOUT[layout])
                        .map(l => {
                            const p = parseCreationLog([...l.topics], l.data, layout);
                            return p ? { ...p, blockNumber: l.blockNumber } : null;
                        })
                        .filter((x): x is ParsedCreation & { blockNumber: number } => x !== null)
                        .reverse();
                    if (hits.length) return { layout, hits };
                }
                end = start - 1;
            } catch (err) {
                const msg = String((err as any)?.error?.message ?? (err as Error).message);
                if (/range|limit|size|too large|10 block/i.test(msg) && chunk > 10) { chunk = Math.max(10, chunk >> 1); continue; }
                break;
            }
        }
    }
    return { layout: null, hits: [] };
}

// ---- verification -------------------------------------------------------------

/** Lets tests (and callers that already hold these) skip loading conf/<chain>.json5. */
export type V3VerifyContext = {
    provider?: JsonRpcProvider;
    chain?: { id: number; host?: string; hypersyncUrl?: string; contract?: string };
};

export async function verifyV3Factory(
    chainName: string,
    address: string,
    explorerApiKey?: string,
    ctx: V3VerifyContext = {},
): Promise<V3VerifyResult> {
    const cfg = ctx.chain ? { chain: ctx.chain } : loadChainConfig(chainName);
    const provider = ctx.provider ?? new JsonRpcProvider(cfg.chain.host);
    const notes: string[] = [];
    const r: V3VerifyResult = {
        address: address.toLowerCase(), usable: false, family: 'unknown', layout: null, poolEvent: null,
        callback: null, deployBlock: null, samplePool: null, feesSeen: [], spacingsSeen: [],
        lensChecked: false, notes, configSnippet: '',
    };

    if ((await provider.getCode(address)) === '0x') {
        notes.push(`✗ No code at ${address} on ${chainName}.`);
        return r;
    }
    notes.push(`✓ Contract exists at ${address}`);

    if (explorerApiKey) {
        try {
            const c = await getContractCreation(cfg.chain.id, address, explorerApiKey);
            if (c) { r.deployBlock = c.blockNumber; notes.push(`✓ Deployed at block ${c.blockNumber}`); }
        } catch (err) {
            notes.push(`  Could not fetch deploy block: ${(err as Error).message.slice(0, 100)}`);
        }
    }

    // 1. creation event
    const { layout, hits } = await samplePools(provider, address, r.deployBlock, cfg.chain.hypersyncUrl, process.env.ENVIO_API_TOKEN);
    if (!layout || hits.length === 0) {
        notes.push('✗ No PoolCreated / Pool events found from this address (searched the last 100k blocks' +
            (r.deployBlock !== null ? ' and the 100k after deployment' : '') + ').');
        return r;
    }
    r.layout = layout;
    r.family = layout === 'algebra' ? 'algebra' : 'v3';
    r.poolEvent = layout === 'v3' ? 'uniswap' : layout === 'v3ts' ? 'tickspacing' : null;
    notes.push(`✓ Emits ${layout === 'v3' ? 'PoolCreated (fee-keyed, Uniswap V3 shape)' :
        layout === 'v3ts' ? 'PoolCreated (tick-spacing-keyed)' : 'Pool (Algebra shape)'}; ${hits.length} sampled`);

    if (r.family === 'algebra') {
        notes.push('✗ Algebra pools (globalState/tickTable, dynamic fee) are not modelled yet — not usable.');
        return r;
    }

    // 2-3. pool state, on up to 5 sampled pools
    let goodPools = 0, tickLayoutChecked = false;
    for (const h of hits.slice(0, 5)) {
        const pool = h.pair;
        const slot0 = await callWords(provider, pool, 'slot0()');
        const liq = await callWords(provider, pool, 'liquidity()');
        const fee = await callWords(provider, pool, 'fee()');
        const ts = await callWords(provider, pool, 'tickSpacing()');
        const t0 = await callWords(provider, pool, 'token0()');
        if (!slot0 || slot0.length < 2 || !liq || !fee || !ts || !t0) {
            notes.push(`  [!] ${pool}: missing ${[!slot0 && 'slot0', !liq && 'liquidity', !fee && 'fee', !ts && 'tickSpacing', !t0 && 'token0'].filter(Boolean).join(', ')}`);
            continue;
        }
        const sqrtP = slot0[0], tick = asInt(slot0[1], 24), spacing = asInt(ts[0], 24), feePips = Number(fee[0]);
        const MIN_SQRT = 4295128739n, MAX_SQRT = 1461446703485210103287273052203988822378723970342n;
        const tokenMatches = ('0x' + t0[0].toString(16).padStart(40, '0')) === h.token0;
        const sane = sqrtP >= MIN_SQRT && sqrtP < MAX_SQRT && spacing > 0 && spacing <= 16384
                  && feePips < 1_000_000 && liq[0] < (1n << 128n) && tokenMatches;
        if (!sane) {
            notes.push(`  [!] ${pool}: values out of range (sqrtP=${sqrtP}, spacing=${spacing}, fee=${feePips}, token0 match=${tokenMatches})`);
            continue;
        }
        if (h.feePips !== null && h.feePips !== feePips) notes.push(`  [!] ${pool}: event fee ${h.feePips} but pool.fee() = ${feePips} — using the pool's`);
        if (h.tickSpacing !== null && h.tickSpacing !== spacing) notes.push(`  [!] ${pool}: event spacing ${h.tickSpacing} but pool.tickSpacing() = ${spacing}`);
        goodPools++;
        if (!r.feesSeen.includes(feePips)) r.feesSeen.push(feePips);
        if (!r.spacingsSeen.includes(spacing)) r.spacingsSeen.push(spacing);
        r.samplePool ??= pool;

        // ticks() layout, on the first initialized tick near the current price
        if (!tickLayoutChecked) {
            const compressed = Math.floor(tick / spacing);
            for (const w of [compressed >> 8, (compressed >> 8) - 1, (compressed >> 8) + 1]) {
                const bm = await callWords(provider, pool, 'tickBitmap(int16)', enc(w));
                if (!bm || bm[0] === 0n) continue;
                let b = 0; while (((bm[0] >> BigInt(b)) & 1n) === 0n) b++;
                const t = (w * 256 + b) * spacing;
                const info = await callWords(provider, pool, 'ticks(int24)', enc(t));
                if (!info || info.length < 2) break;
                const gross = info[0], net = BigInt.asIntN(128, info[1]);
                const ok = gross > 0n && (net < 0n ? -net : net) <= gross;
                notes.push(ok
                    ? `✓ ticks() layout: tick ${t} has liquidityGross ${gross}, liquidityNet ${net}`
                    : `✗ ticks() layout mismatch at tick ${t}: word0=${gross}, word1=${net}`);
                tickLayoutChecked = true;
                if (!ok) return r;
                break;
            }
        }
    }
    if (goodPools === 0) {
        notes.push('✗ No sampled pool answered slot0/liquidity/fee/tickSpacing sanely.');
        return r;
    }
    notes.push(`✓ ${goodPools} pool(s) answer slot0/liquidity/fee/tickSpacing; fees ${r.feesSeen.join(', ')} pips, spacings ${r.spacingsSeen.join(', ')}`);
    if (!tickLayoutChecked) notes.push('  [!] No initialized tick near the sampled prices — ticks() layout not checked.');

    // 4. callback
    const { code, via } = await runtimeCode(provider, r.samplePool!);
    const cbs = findCallbackSelectors(code);
    if (via) notes.push(`  Pool is an EIP-1167 clone of ${via}; inspected the implementation`);
    if (cbs.length === 1) {
        r.callback = cbs[0];
        notes.push(`✓ Swap callback: ${cbs[0]} (selector found in pool bytecode)`);
    } else if (cbs.length === 0) {
        notes.push(`✗ No known swap-callback selector in the pool bytecode (${KNOWN_CALLBACKS.join(', ')}). ` +
            `The executor cannot pay this pool until its callback is identified.`);
        return r;
    } else {
        notes.push(`✗ Several callback selectors present (${cbs.join(', ')}) — ambiguous, check the source.`);
        return r;
    }

    // 5. YoBatches2 end-to-end, when deployed
    if (cfg.chain.contract) {
        try {
            const { getV3States } = await import('./yobatches.ts');
            const b = await getV3States(provider, cfg.chain.contract, [r.samplePool!], 1);
            const p = b.pools[0];
            const s0 = await callWords(provider, r.samplePool!, 'slot0()');
            if (p && s0 && p.sqrtPriceX96 === s0[0]) {
                r.lensChecked = true;
                notes.push(`✓ YoBatches2.getV3State reads this pool (${p.ticks.length} ticks in ±1 word)`);
            } else {
                notes.push(`✗ YoBatches2.getV3State did not return this pool's state — is chain.contract a YoBatches2?`);
                return r;
            }
        } catch (err) {
            notes.push(`  [!] getV3State check failed: ${(err as Error).message.slice(0, 100)} — redeploy YoBatches2 and re-run`);
        }
    } else {
        notes.push('  [!] chain.contract unset — YoBatches2 path not checked.');
    }

    r.usable = true;
    const deployLine = r.deployBlock ? `\n          deployBlock: ${r.deployBlock},` : '';
    r.configSnippet =
        `    // Add under factories["v3"]:\n` +
        `        "NAME_ME": {\n` +
        `          // measured: fees ${r.feesSeen.join('/')} pips, spacings ${r.spacingsSeen.join('/')}\n` +
        `          address: "${r.address}",${deployLine}\n` +
        `          poolEvent: "${r.poolEvent}",\n` +
        `          callback: "${r.callback}"\n` +
        `        }`;
    return r;
}

// ---- CLI ---------------------------------------------------------------------

export function printV3Report(r: V3VerifyResult): void {
    console.log('\n' + '═'.repeat(70));
    console.log(`Concentrated-liquidity factory report — ${r.address}`);
    console.log('═'.repeat(70));
    for (const n of r.notes) console.log(`  ${n}`);
    console.log('\n' + '─'.repeat(70));
    console.log(`  Usable:        ${r.usable ? 'YES' : 'NO'}`);
    console.log(`  Family:        ${r.family}`);
    console.log(`  Pool event:    ${r.poolEvent ?? r.layout ?? 'none'}`);
    console.log(`  Callback:      ${r.callback ?? 'unknown'}`);
    console.log(`  Deploy block:  ${r.deployBlock ?? 'unknown'}`);
    if (r.configSnippet) {
        console.log('\nSuggested config addition:\n');
        console.log(r.configSnippet);
    }
    console.log('');
}

function isMain(): boolean {
    try { return realpathSync(process.argv[1]) === import.meta.url.replace(/^file:\/\//, ''); } catch { return false; }
}

if (isMain()) {
    const [chainArg, addressArg] = process.argv.slice(2);
    if (!chainArg || !addressArg) {
        console.error('Usage: node --experimental-strip-types source/util/verify-v3-factory.ts <chain> <address>');
        process.exit(1);
    }
    printV3Report(await verifyV3Factory(chainArg, addressArg, process.env.ETHERSCAN_API_KEY));
}
