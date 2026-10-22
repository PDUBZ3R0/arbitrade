// -----------------------------------------------------------------------------
// Deploy one contract with a plain create transaction — no Ignition.
// (used by scripts/deploy.sh on HyperEVM)
//
//   node --experimental-strip-types scripts/deploy-direct.ts <chain> <Contract>
//     e.g.  hyperliquid LiquidationExecutor
//
// WHY. On HyperEVM a deployment goes to a big block (one a minute). While it
// waits, rpc.hyperliquid.xyz does not report the transaction, so Ignition's
// tracker decides it was dropped (HHE10400) and aborts — every time — while the
// transaction lands seconds later. This script never asks "is my transaction
// still known?". It waits on outcomes only:
//   - a receipt for the hash, or
//   - code appearing at the CREATE address for (deployer, nonce)
// and gives up only if the deployer's nonce moves past ours with no code there
// (our transaction was replaced or reverted) or the timeout passes.
//
// Constructor arguments, mirroring ignition/modules:
//   SniperExecutor                [SNIPER_OWNER] (deploy.sh: env or SniperModule.owner)
//   FlashArbExecutor, TokenProbe  [aavePool] from ignition/parameters/<chain>.json
//                                 (FlashArbModule.aavePool; 0x0…0 where there is no Aave)
//   LiquidationExecutor, YoBatches3  none
//
// HyperEVM block size. Small blocks (every second) cap at 2M gas; anything
// bigger needs the deployer's big-block flag (one block a minute).
//   --estimate   print the deploy's gas estimate (or "unknown") and exit;
//                deploy.sh uses it to toggle big blocks only when needed
//   --small      the deployer is on small blocks: cap gasLimit at SMALL_BLOCK_GAS
//
// Output: progress on stderr; on success ONE line on stdout: "<address> <nonce> <txhash>".
// Exit: 0 deployed, 1 failed/timeout (re-running deploy.sh is safe: deploy-check
// finds a contract that landed late and adopts it).
// -----------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ContractFactory, Wallet, getCreateAddress } from 'ethers';
import 'dotenv/config';
import { loadChainConfig } from '../source/util/config.ts';
import { RetryingJsonRpcProvider } from '../source/util/rpc.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const [chainArg, contract] = argv.filter(a => !a.startsWith('--'));
const ESTIMATE_ONLY = argv.includes('--estimate');
const SMALL = argv.includes('--small');
/** HyperEVM small-block gas limit. */
export const SMALL_BLOCK_GAS = 2_000_000n;
const TIMEOUT_MS = Number(process.env.DEPLOY_TIMEOUT_MS ?? 6 * 60_000);   // a big block is ~60 s; allow several
const POLL_MS = 3_000;
const log = (s: string) => process.stderr.write(s + '\n');
const fail = (s: string): never => { log(`[deploy-direct] ${s}`); process.exit(1); };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

if (!chainArg || !contract) fail('usage: deploy-direct.ts <chain> <Contract>');
if (!process.env.PRIVATE_KEY) fail('PRIVATE_KEY is not set (.env)');

const cfg = loadChainConfig(chainArg);
const artifactPath = path.join(ROOT, 'build/artifacts/contracts', `${contract}.sol`, `${contract}.json`);
if (!fs.existsSync(artifactPath)) fail(`no artifact at ${path.relative(ROOT, artifactPath)} — run hardhat compile first`);
const art = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));

// Constructor arguments — keep in step with ignition/modules/*.ts.
let args: unknown[] = [];
if (contract === 'FlashArbExecutor' || contract === 'TokenProbe') {
    const p = path.join(ROOT, 'ignition/parameters', `${cfg.chain.label}.json`);
    if (!fs.existsSync(p)) fail(`missing ${path.relative(ROOT, p)} — it needs { "FlashArbModule": { "aavePool": "0x…" } } (0x0…0 if none)`);
    const pool = JSON.parse(fs.readFileSync(p, 'utf8'))?.FlashArbModule?.aavePool;
    if (!/^0x[0-9a-fA-F]{40}$/.test(pool ?? '')) fail(`no FlashArbModule.aavePool in ${path.relative(ROOT, p)}`);
    args = [pool];
} else if (contract === 'SniperExecutor') {
    // Its owner is sniper's hot wallet (deploy.sh exports SNIPER_OWNER), never this deployer.
    if (!/^0x[0-9a-fA-F]{40}$/.test(process.env.SNIPER_OWNER ?? '')) fail('SNIPER_OWNER (sniper\'s hot wallet address) is not set');
    args = [process.env.SNIPER_OWNER];
} else if (contract !== 'LiquidationExecutor' && contract !== 'YoBatches3') {
    fail(`don't know the constructor arguments for ${contract} — add it here (mirror its ignition module)`);
}

// batchMaxCount 1: one node, one request at a time, as deploy-check.ts (rpc3.monad.xyz answers
// a batch over 10 with HTTP 413).
const provider = new RetryingJsonRpcProvider(cfg.chain.host, Number(cfg.chain.id), { staticNetwork: true, batchMaxCount: 1 });
const wallet = new Wallet(process.env.PRIVATE_KEY!, provider);
const me = wallet.address;

if (ESTIMATE_ONLY) {
    const factory = new ContractFactory(art.abi, art.bytecode, wallet);
    const req = await factory.getDeployTransaction(...args);
    try { console.log(String(await provider.estimateGas({ ...req, from: me }))); }
    catch (e) { log(`[deploy-direct] estimate failed: ${(e as Error).message?.slice(0, 120)}`); console.log('unknown'); }
    process.exit(0);
}

const latest = await provider.getTransactionCount(me, 'latest');
const pending = await provider.getTransactionCount(me, 'pending');
if (pending > latest) fail(`deployer ${me} has ${pending - latest} unconfirmed transaction(s) — wait for them, then re-run`);
const nonce = latest;
const expected = getCreateAddress({ from: me, nonce });

const factory = new ContractFactory(art.abi, art.bytecode, wallet);
const req = await factory.getDeployTransaction(...args);
const gas = await provider.estimateGas({ ...req, from: me });
let gasLimit = (gas * 12n) / 10n;
if (SMALL) {
    if (gas > SMALL_BLOCK_GAS) fail(`estimate ${gas} exceeds the ${SMALL_BLOCK_GAS} small-block limit — deploy with big blocks on`);
    if (gasLimit > SMALL_BLOCK_GAS) gasLimit = SMALL_BLOCK_GAS;
}
log(`[deploy-direct] ${contract} on ${cfg.chain.label}: nonce ${nonce} → ${expected}, gas ${gas} (limit ${gasLimit})${args.length ? `, args ${JSON.stringify(args)}` : ''}`);

const tx = await wallet.sendTransaction({ ...req, nonce, gasLimit });
log(`[deploy-direct] sent ${tx.hash} — waiting for a receipt or for code at ${expected} (up to ${Math.round(TIMEOUT_MS / 1000)} s)`);

const t0 = Date.now();
let lastNote = 0;
while (Date.now() - t0 < TIMEOUT_MS) {
    await sleep(POLL_MS);
    let receipt = null, code = '0x', now = nonce;
    try {
        [receipt, code, now] = await Promise.all([
            provider.getTransactionReceipt(tx.hash),
            provider.getCode(expected),
            provider.getTransactionCount(me, 'latest'),
        ]);
    } catch (e) {
        log(`[deploy-direct] poll error (retrying): ${(e as Error).message?.slice(0, 120)}`);
        continue;
    }
    if (receipt) {
        if (receipt.status !== 1) fail(`transaction ${tx.hash} reverted in block ${receipt.blockNumber}`);
        const addr = receipt.contractAddress ?? expected;
        log(`[deploy-direct] deployed at ${addr} in block ${receipt.blockNumber} (${Math.round((Date.now() - t0) / 1000)} s)`);
        console.log(`${addr} ${nonce} ${tx.hash}`);
        process.exit(0);
    }
    if (code !== '0x') {
        log(`[deploy-direct] code is at ${expected} (no receipt from this RPC yet — landed regardless)`);
        console.log(`${expected} ${nonce} ${tx.hash}`);
        process.exit(0);
    }
    if (now > nonce) {
        // Nonce consumed, no code: give the RPC one more look before calling it.
        await sleep(POLL_MS);
        if ((await provider.getCode(expected)) !== '0x') { console.log(`${expected} ${nonce} ${tx.hash}`); process.exit(0); }
        fail(`nonce ${nonce} was used but there is no code at ${expected} — the create was replaced or reverted (is hot/liq-watch sending from this key?)`);
    }
    if (Date.now() - lastNote > 20_000) { lastNote = Date.now(); log(`[deploy-direct] waiting… ${Math.round((Date.now() - t0) / 1000)} s`); }
}
fail(`no receipt and no code after ${Math.round(TIMEOUT_MS / 1000)} s. Re-run the same deploy: if it lands later, the check adopts it.`);
