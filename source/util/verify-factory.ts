// -----------------------------------------------------------------------------
// Factory verifier.
//
// Given an unknown DEX factory address, probe it on-chain to determine:
//   - Does it emit PairCreated events? (V2 compatibility)
//   - Sample recent pair: are reserves readable via token.balanceOf(pair)?
//   - What is the actual swap fee?
//   - Is the pair contract shape V2-standard?
//
// Outputs a summary and a ready-to-paste config snippet.
//
// Usage:
//   yarn verify-factory <chain> <factory-address>
//   e.g. yarn verify-factory sonic 0xEE4bC42157cf65291Ba2FE839AE127e3Cc76f741
// -----------------------------------------------------------------------------

import { ethers, JsonRpcProvider, Contract } from 'ethers';
import { loadChainConfig } from './config.ts';
import { etherscanGetLogs, getContractCreation, rateLimit } from './etherscan.ts';
import { realpathSync } from 'node:fs';

const PAIR_CREATED_TOPIC         = ethers.id('PairCreated(address,address,address,uint256)');
const PAIR_CREATED_SOLIDLY_TOPIC = ethers.id('PairCreated(address,address,bool,address,uint256)');

// Minimal ABIs for probing
const PAIR_ABI = [
    'function token0() view returns (address)',
    'function token1() view returns (address)',
    'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
    'function factory() view returns (address)',
];
const ERC20_ABI = [
    'function balanceOf(address) view returns (uint256)',
    'function decimals() view returns (uint8)',
    'function symbol() view returns (string)',
];

export type VerifyResult = {
    address: string;
    isV2: boolean;
    isYoBatchesCompatible: boolean;
    family: 'v2' | 'v2fee' | 'solidly' | 'unknown';
    fee: number | null;         // e.g. 0.003, 0.002, or null if undetermined
    feeConfidence: 'derived' | 'assumed' | 'unknown';
    deployBlock: number | null;
    samplePair: string | null;
    notes: string[];
    configSnippet: string;
};

// -----------------------------------------------------------------------------

async function fetchSamplePairs(
    provider: JsonRpcProvider,
    factory: string,
    chainId: number,
    deployBlock: number | null,
    explorerApiKey?: string,
): Promise<{ hits: Array<{ pair: string; token0: string; token1: string; blockNumber: number; stable: boolean | null }>; matchedTopic: 'v2' | 'solidly' | null }> {
    const head = await provider.getBlockNumber();

    // Search strategy: try each event topic (V2 first, then Solidly-native)
    // over a set of block windows. First hit wins.
    const windows: Array<{ label: string; from: number; to: number }> = [];
    if (deployBlock !== null) {
        windows.push({
            label: `deploy+100k`,
            from: deployBlock,
            to: Math.min(head, deployBlock + 100_000),
        });
        if (deployBlock + 100_000 < head) {
            windows.push({
                label: 'last 100k',
                from: Math.max(0, head - 100_000),
                to: head,
            });
        }
    } else {
        windows.push({ label: 'last 100k', from: Math.max(0, head - 100_000), to: head });
    }

    const topics: Array<{ hash: string; label: 'v2' | 'solidly' }> = [
        { hash: PAIR_CREATED_TOPIC,         label: 'v2' },
        { hash: PAIR_CREATED_SOLIDLY_TOPIC, label: 'solidly' },
    ];

    for (const topic of topics) {
        for (const win of windows) {
            const rpcResult = await tryRpcLogs(provider, factory, win.from, win.to, topic.hash);
            if (rpcResult.hits.length > 0) {
                return { hits: rpcResult.hits, matchedTopic: topic.label };
            }
            if (rpcResult.rpcUsable && rpcResult.errored === false) continue;
            if (!explorerApiKey) continue;
            const esHits = await tryEtherscanLogs(chainId, factory, win.from, win.to, explorerApiKey, topic.hash);
            if (esHits.length > 0) {
                return { hits: esHits, matchedTopic: topic.label };
            }
        }
    }

    return { hits: [], matchedTopic: null };
}

/**
 * Fetch PairCreated events via RPC over a block range. Handles range-too-large
 * errors by shrinking, and logs-pruned by giving up cleanly.
 * Returns hits + whether the RPC was usable for this range.
 *
 * The `topic` parameter selects between V2-shape and Solidly-native-shape
 * PairCreated events. Data-layout differs — this function parses accordingly.
 */
async function tryRpcLogs(
    provider: JsonRpcProvider,
    factory: string,
    fromBlock: number,
    toBlock: number,
    topic: string = PAIR_CREATED_TOPIC,
): Promise<{ hits: Array<{ pair: string; token0: string; token1: string; blockNumber: number; stable: boolean | null }>; rpcUsable: boolean; errored: boolean }> {
    let chunk = Math.min(5000, toBlock - fromBlock + 1);
    const CHUNK_MIN = 10;
    let cursor = fromBlock;
    const isSolidly = topic === PAIR_CREATED_SOLIDLY_TOPIC;

    while (cursor <= toBlock) {
        const end = Math.min(cursor + chunk - 1, toBlock);
        try {
            const logs = await provider.getLogs({
                address: factory,
                topics: [topic],
                fromBlock: cursor,
                toBlock: end,
            });
            if (logs.length > 0) {
                return {
                    hits: logs.map(log => {
                        let pair: string;
                        let stable: boolean | null = null;
                        if (isSolidly) {
                            stable = BigInt('0x' + log.data.slice(2, 66)) === 1n;
                            pair = '0x' + log.data.slice(66, 130).slice(-40);
                        } else {
                            pair = '0x' + log.data.slice(2, 66).slice(-40);
                        }
                        return {
                            pair,
                            token0:      '0x' + log.topics[1].slice(-40),
                            token1:      '0x' + log.topics[2].slice(-40),
                            blockNumber: log.blockNumber,
                            stable,
                        };
                    }),
                    rpcUsable: true,
                    errored: false,
                };
            }
            cursor = end + 1;
        } catch (err) {
            const raw = err as any;
            const msg = ((raw?.error?.message ?? '') + ' ' + (raw?.message ?? String(err)));
            if (/pruned|history/i.test(msg)) {
                return { hits: [], rpcUsable: false, errored: true };
            }
            if (/range|limit|size|too large|10 block/i.test(msg) && chunk > CHUNK_MIN) {
                chunk = Math.max(CHUNK_MIN, Math.floor(chunk / 2));
                continue;
            }
            return { hits: [], rpcUsable: false, errored: true };
        }
    }
    return { hits: [], rpcUsable: true, errored: false };
}

async function tryEtherscanLogs(
    chainId: number,
    factory: string,
    fromBlock: number,
    toBlock: number,
    apiKey: string,
    topic: string = PAIR_CREATED_TOPIC,
): Promise<Array<{ pair: string; token0: string; token1: string; blockNumber: number; stable: boolean | null }>> {
    const chunkSize = 10_000;
    const isSolidly = topic === PAIR_CREATED_SOLIDLY_TOPIC;
    for (let start = fromBlock; start <= toBlock; start += chunkSize) {
        const end = Math.min(start + chunkSize - 1, toBlock);
        await rateLimit();
        try {
            const logs = await etherscanGetLogs({
                chainId,
                address: factory,
                topic0: topic,
                fromBlock: start,
                toBlock: end,
                apiKey,
            });
            if (logs.length > 0) {
                return logs.map(log => {
                    let pair: string;
                    let stable: boolean | null = null;
                    if (isSolidly) {
                        stable = BigInt('0x' + log.data.slice(2, 66)) === 1n;
                        pair = '0x' + log.data.slice(66, 130).slice(-40);
                    } else {
                        pair = '0x' + log.data.slice(2, 66).slice(-40);
                    }
                    return {
                        pair,
                        token0:      '0x' + log.topics[1].slice(-40),
                        token1:      '0x' + log.topics[2].slice(-40),
                        blockNumber: log.blockNumber,
                        stable,
                    };
                });
            }
        } catch {
            // try next chunk
        }
    }
    return [];
}
/**
 * Given a pair, check whether YoBatches's `token.balanceOf(pair)` strategy
 * yields values close to the pair's own `getReserves()`.
 */
async function checkYoBatchesCompatibility(
    provider: JsonRpcProvider,
    pairAddr: string,
): Promise<{ compatible: boolean; delta0: number; delta1: number; notes: string[] }> {
    const notes: string[] = [];
    const pair = new Contract(pairAddr, PAIR_ABI, provider);

    let token0: string, token1: string, reserves: bigint[];
    try {
        [token0, token1, reserves] = await Promise.all([
            pair.token0(),
            pair.token1(),
            pair.getReserves(),
        ]);
    } catch (err) {
        notes.push(`Pair ${pairAddr} doesn't implement standard V2 interface: ${(err as Error).message}`);
        return { compatible: false, delta0: 1, delta1: 1, notes };
    }

    const r0 = BigInt(reserves[0].toString());
    const r1 = BigInt(reserves[1].toString());

    let b0: bigint, b1: bigint;
    try {
        const t0 = new Contract(token0, ERC20_ABI, provider);
        const t1 = new Contract(token1, ERC20_ABI, provider);
        [b0, b1] = await Promise.all([t0.balanceOf(pairAddr), t1.balanceOf(pairAddr)]);
    } catch (err) {
        notes.push(`Failed to read token balances: ${(err as Error).message}`);
        return { compatible: false, delta0: 1, delta1: 1, notes };
    }

    // Relative difference; 0 means perfect match, 1 means "wildly off"
    const rel = (a: bigint, b: bigint): number => {
        const denom = a > b ? a : b;
        if (denom === 0n) return 0;
        const diff = a > b ? a - b : b - a;
        return Number(diff * 1_000_000n / denom) / 1_000_000;
    };
    const delta0 = rel(r0, b0);
    const delta1 = rel(r1, b1);

    // Within 0.5% is fine (fee-on-transfer tokens, dust donations)
    const compatible = delta0 < 0.005 && delta1 < 0.005;
    if (!compatible) {
        notes.push(
            `getReserves()/balanceOf() mismatch on ${pairAddr}: ` +
            `token0 delta=${(delta0 * 100).toFixed(2)}%, token1 delta=${(delta1 * 100).toFixed(2)}%. ` +
            `Tokens likely held in a vault, not in the pair contract.`
        );
    }
    return { compatible, delta0, delta1, notes };
}

// Selectors for Solidly-family indicators (verified via ethers.id())
const SEL_pairFee     = '0x841fa66b';  // pairFee(address)
const SEL_stable      = '0x22be3de1';  // stable()
const SEL_metadata    = '0x392f37e9';  // metadata()

/**
 * Probe whether a factory is Solidly-family (Shadow, Aerodrome, Velodrome, etc).
 *
 * Signals:
 *   - Factory exposes pairFee(address pair) → per-pair fee lookup
 *   - Sample pair exposes stable() → bool for stable-vs-volatile
 *   - Sample pair exposes metadata() → returns tuple with stable flag
 *
 * Returns confidence based on how many signals fire; multiple = near-certain.
 */
async function detectSolidlyFamily(
    provider: JsonRpcProvider,
    factoryAddr: string,
    samplePair: string,
): Promise<{ isSolidly: boolean; signals: string[] }> {
    const signals: string[] = [];

    // Probe factory.pairFee(pair) — pass the sample pair as its uint256 arg
    try {
        const encodedArg = samplePair.toLowerCase().replace('0x', '').padStart(64, '0');
        const result = await provider.call({
            to: factoryAddr,
            data: SEL_pairFee + encodedArg,
        });
        if (result && result !== '0x') {
            signals.push('factory.pairFee(pair) exists — per-pair fees');
        }
    } catch { /* function doesn't exist */ }

    // Probe pair.stable()
    try {
        const result = await provider.call({ to: samplePair, data: SEL_stable });
        if (result && result !== '0x') {
            const val = BigInt(result);
            signals.push(`pair.stable() = ${val === 1n ? 'true (stable pool)' : 'false (volatile pool)'}`);
        }
    } catch { /* function doesn't exist */ }

    // Probe pair.metadata()
    try {
        const result = await provider.call({ to: samplePair, data: SEL_metadata });
        if (result && result !== '0x' && result.length > 66) {
            signals.push('pair.metadata() exists — Solidly-style pair interface');
        }
    } catch { /* function doesn't exist */ }

    return { isSolidly: signals.length > 0, signals };
}

/**
 * Try to derive the swap fee by comparing an on-chain quote against our
 * formula's prediction. For a V2 fork with fee F, the formula
 *   out = in * (1-F) * r_out / (r_in + in * (1-F))
 * should match the actual result within rounding. We try a few common fees
 * (0.003, 0.002, 0.0025, 0.001) and pick the closest.
 */
async function deriveFee(
    provider: JsonRpcProvider,
    pairAddr: string,
): Promise<{ fee: number; confidence: 'derived' | 'assumed'; notes: string[] }> {
    const notes: string[] = [];
    // Most V2 forks encode the fee constant into the pair's swap() function
    // rather than exposing it publicly. Without deploying a helper contract
    // that calls swap() and reads the resulting reserves, we can't derive it
    // precisely on-chain. So we assume the V2 default (0.003) and let the
    // user override in config if they know it differs.
    //
    // Common overrides worth knowing:
    //   - SpookySwap:  0.002 (998/1000)
    //   - Trader Joe:  0.003
    //   - PancakeSwap: 0.0025 (9975/10000)
    //   - ApeSwap:     0.002 (998/1000)
    //
    // Future improvement: deploy a "FeeProber" helper contract that does the
    // swap and reads the delta, so we can derive fee exactly.
    notes.push(
        `Fee not derivable from on-chain state alone. Defaulting to 0.003 (V2 standard). ` +
        `Verify manually by checking the pair contract's swap() source — look for ` +
        `\`amountIn.mul(N)\` where fee = (1000-N)/1000. Common values: 997=0.3%, 998=0.2%, 9975=0.25%.`
    );
    return { fee: 0.003, confidence: 'assumed', notes };
}

// -----------------------------------------------------------------------------

export async function verifyFactory(
    chainName: string,
    address: string,
    explorerApiKey?: string,
): Promise<VerifyResult> {
    const cfg = loadChainConfig(chainName);
    const provider = new JsonRpcProvider(cfg.chain.host);

    const notes: string[] = [];
    const result: VerifyResult = {
        address,
        isV2: false,
        isYoBatchesCompatible: false,
        family: 'unknown',
        fee: null,
        feeConfidence: 'unknown',
        deployBlock: null,
        samplePair: null,
        notes,
        configSnippet: '',
    };

    // Step 1: does the address exist?
    const code = await provider.getCode(address);
    if (code === '0x' || code === '') {
        notes.push(`No code at ${address} on ${chainName}. Wrong address or wrong chain?`);
        return result;
    }
    notes.push(`✓ Contract exists at ${address}`);

    // Step 2: get deploy block via explorer (if key available)
    if (explorerApiKey) {
        try {
            const creation = await getContractCreation(cfg.chain.id, address, explorerApiKey);
            if (creation) {
                result.deployBlock = creation.blockNumber;
                notes.push(`✓ Deployed at block ${creation.blockNumber} by ${creation.creator}`);
            }
        } catch (err) {
            notes.push(`Could not fetch deploy block: ${(err as Error).message}`);
        }
    }

    // Step 3: sample PairCreated events, anchored at deploy block if known.
    // We try both V2-shape and Solidly-shape topics; the winning topic tells us
    // the event-family signature this factory uses.
    notes.push(`  Searching for PairCreated events${result.deployBlock ? ` starting from deploy block ${result.deployBlock}` : ''}...`);
    const { hits: pairs, matchedTopic } = await fetchSamplePairs(
        provider,
        address,
        cfg.chain.id,
        result.deployBlock,
        explorerApiKey,
    );
    if (pairs.length === 0) {
        notes.push(
            `✗ No PairCreated events found (tried both V2 and Solidly signatures). ` +
            `Factory likely uses a different event shape (V3 PoolCreated, Algebra Pool, ` +
            `Balancer vault, custom, etc.) — not compatible with our scanner.`
        );
        return result;
    }
    result.isV2 = true;
    result.samplePair = pairs[0].pair;
    notes.push(`✓ Emits PairCreated events (${matchedTopic} signature, found ${pairs.length}). Sample pair: ${pairs[0].pair} (block ${pairs[0].blockNumber})`);
    if (matchedTopic === 'solidly') {
        const stableCount = pairs.filter(p => p.stable === true).length;
        const volatileCount = pairs.filter(p => p.stable === false).length;
        notes.push(`  Sample composition: ${volatileCount} volatile, ${stableCount} stable`);
    }

    // Step 4: check YoBatches compatibility with the sample pair
    const compat = await checkYoBatchesCompatibility(provider, pairs[0].pair);
    result.isYoBatchesCompatible = compat.compatible;
    notes.push(...compat.notes);
    if (compat.compatible) {
        notes.push(`✓ getReserves() ≈ balanceOf() — YoBatches strategy works here`);
    }

    // Step 5: group determination.
    //   matchedTopic === 'solidly'  → definitely solidly group
    //   matchedTopic === 'v2' + Solidly signals present → v2fee (Shadow-style; hasStableFlag)
    //   matchedTopic === 'v2' + no Solidly signals → pure V2 (or v2fee w/o stable — user's call)
    const detect = await detectSolidlyFamily(provider, address, pairs[0].pair);
    if (matchedTopic === 'solidly') {
        result.family = 'solidly';
        notes.push(`⚑ Solidly group detected (native PairCreated event with stable bool):`);
        for (const s of detect.signals) notes.push(`    - ${s}`);
        notes.push(
            `  → Fee is per-pair (typically via factory.getRealFee(pair)); pools are stable OR volatile. ` +
            `Add under factories["solidly"]. Only volatile pools (stable=false) use ` +
            `x*y=k math; stable pools use a different curve (skip downstream).`
        );
    } else if (detect.isSolidly) {
        result.family = 'v2fee';
        notes.push(`⚑ V2-event factory with Solidly-family features (Shadow-style):`);
        for (const s of detect.signals) notes.push(`    - ${s}`);
        notes.push(
            `  → Fee is per-pair (typically factory.pairFee(pair)) and pools have stable/volatile ` +
            `types (populated at reserve fetch time via pair.stable()). ` +
            `Add under factories["v2fee"] with hasStableFlag: true.`
        );
    } else {
        result.family = 'v2';
        notes.push(`✓ Pure V2 family (no Solidly indicators found)`);
        notes.push(
            `  Note: if this factory actually has per-pair fees (e.g. DXSwap/Swapr), ` +
            `it belongs under v2fee with feeTarget/feeFunction overrides. ` +
            `Verify by checking whether the pair contract has a swapFee() view or similar.`
        );
    }

    // Step 6: derive fee (only meaningful for pure V2 — v2fee/solidly are per-pair)
    if (result.family === 'v2') {
        const feeCheck = await deriveFee(provider, pairs[0].pair);
        result.fee = feeCheck.fee;
        result.feeConfidence = feeCheck.confidence;
        notes.push(...feeCheck.notes);
    } else {
        result.fee = null;
        result.feeConfidence = 'unknown';
        notes.push(
            `Fee determination: skipped (v2fee/solidly fees are per-pair; populated ` +
            `at reserve fetch time)`
        );
    }

    // Generate config snippet — group and shape depend on family
    if (result.isV2 && result.isYoBatchesCompatible) {
        const deployLine = result.deployBlock
            ? `\n          deployBlock: ${result.deployBlock},`
            : '';

        if (result.family === 'solidly') {
            result.configSnippet =
                `    // Add under factories["solidly"]:\n` +
                `        "NAME_ME": {\n` +
                `          address: "${address}",${deployLine}\n` +
                `          // stable/volatile flag extracted from event at scan time\n` +
                `          // fee is per-pair — populated at reserve fetch time via factory.getRealFee(pair)\n` +
                `          // If this fork uses different feeFunction/feeDivisor/feeTarget, override here.\n` +
                `        }`;
        } else if (result.family === 'v2fee') {
            result.configSnippet =
                `    // Add under factories["v2fee"], NOT ["v2"]:\n` +
                `        "NAME_ME": {\n` +
                `          address: "${address}",${deployLine}\n` +
                `          hasStableFlag: true,  // Shadow-style — pair.stable() exists\n` +
                `          // fee is per-pair — populated at reserve fetch time via factory.pairFee(pair)\n` +
                `          // If feeFunction/feeDivisor/feeTarget differ from Shadow's convention, override here.\n` +
                `        }`;
        } else {
            // Pure V2: include fee with clear labeling if it's just assumed
            const feeComment = result.feeConfidence === 'derived'
                ? ''
                : '  // ← UNVERIFIED, check pair swap() source (see report notes)';
            const feeLine = `\n          fee: ${result.fee}${feeComment}`;
            result.configSnippet =
                `    // Add under factories["v2"]:\n` +
                `        "NAME_ME": {\n` +
                `          address: "${address}",${deployLine}${feeLine}\n` +
                `        }`;
        }
    }

    return result;
}

// -----------------------------------------------------------------------------
// CLI

function isMain(): boolean {
    try {
        return realpathSync(process.argv[1]) === import.meta.url.replace(/^file:\/\//, '');
    } catch {
        return false;
    }
}

if (isMain()) {
    const [chainArg, addressArg] = process.argv.slice(2);
    if (!chainArg || !addressArg) {
        console.error('Usage: yarn verify-factory <chain> <address>');
        console.error('Example: yarn verify-factory sonic 0xEE4bC42157cf65291Ba2FE839AE127e3Cc76f741');
        process.exit(1);
    }

    const result = await verifyFactory(chainArg, addressArg, process.env.ETHERSCAN_API_KEY);

    console.log('\n' + '═'.repeat(70));
    console.log(`Factory verification report — ${addressArg}`);
    console.log('═'.repeat(70));
    for (const note of result.notes) console.log(`  ${note}`);

    console.log('\n' + '─'.repeat(70));
    console.log('Summary:');
    console.log(`  V2 compatible:              ${result.isV2 ? 'YES' : 'NO'}`);
    console.log(`  YoBatches compatible:       ${result.isYoBatchesCompatible ? 'YES' : 'NO'}`);
    console.log(`  Family:                     ${result.family}`);
    console.log(`  Fee:                        ${result.fee ?? 'per-pair (Solidly)'} (${result.feeConfidence})`);
    console.log(`  Deploy block:               ${result.deployBlock ?? 'unknown'}`);

    if (result.configSnippet) {
        console.log('\n' + '─'.repeat(70));
        console.log('Suggested config addition:\n');
        console.log(result.configSnippet);
    } else {
        console.log('\n[!] Not adding config snippet — factory not confirmed compatible.');
    }
    console.log('');
}
