// -----------------------------------------------------------------------------
// Is the contract on-chain the contract in contracts/?  (used by scripts/deploy.sh)
//
//   node --experimental-strip-types scripts/deploy-check.ts <chain> <Contract> <field> <future>
//     e.g.  hyperliquid FlashArbExecutor executor FlashArbModule#FlashArbExecutor
//
// Compares the runtime code at the address the bot USES — chain.<field> in
// conf/<chain>.json5 — with build/artifacts (run `hardhat compile` first).
// Ignition's own record (deployed_addresses.json) is checked too, so a deploy
// that landed but never reached the config is recognised rather than repeated.
//
// What is ignored, because it legitimately differs from the artifact:
//   - immutables (FlashArbExecutor's owner and aavePool, …): the artifact's
//     immutableReferences say exactly where they sit; both sides are zeroed there
//   - the CBOR metadata tail: it hashes the source text, so a comment-only edit
//     changes it without changing a single instruction
// Constructor arguments therefore do not count as "different" — a changed
// aavePool parameter needs --force.
//
// Exit status (deploy.sh branches on it):
//   0  current      the configured (or Ignition's) address holds this code
//   3  missing      nothing configured, or no code at the address
//   4  outdated     code is there and differs
//   5  pending      the deployer has an unconfirmed transaction — wait; a
//                   deploy now could duplicate one still in flight
//   1  error        could not tell (RPC failure, no artifact) — never deploy blind
// One line on stdout: "<status> <address|-> <reason>".
// -----------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Wallet, getAddress } from 'ethers';
import 'dotenv/config';
import { loadChainConfig } from '../source/util/config.ts';
import { RetryingJsonRpcProvider } from '../source/util/rpc.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [chainArg, contract, field, future] = process.argv.slice(2);
const out = (code: number, status: string, addr: string | null, reason: string): never => {
    console.log(`${status} ${addr ?? '-'} ${reason}`);
    process.exit(code);
};
if (!chainArg || !contract || !field || !future) {
    console.error('usage: deploy-check.ts <chain> <Contract> <field> <future>');
    process.exit(2);
}

/** Runtime code with immutables zeroed and the metadata tail removed. */
export function normalizeRuntime(hex: string, immutables: Record<string, Array<{ start: number; length: number }>>): string {
    let b = Buffer.from(hex.replace(/^0x/, ''), 'hex');
    b = Buffer.from(b);   // own copy
    for (const refs of Object.values(immutables ?? {})) {
        for (const { start, length } of refs) if (start + length <= b.length) b.fill(0, start, start + length);
    }
    // Solidity appends CBOR metadata and then its length as a 2-byte big-endian.
    if (b.length >= 2) {
        const n = b.readUInt16BE(b.length - 2);
        if (n + 2 <= b.length && b[b.length - 2 - n] >= 0xa0 && b[b.length - 2 - n] <= 0xbf) b = b.subarray(0, b.length - 2 - n);
    }
    return b.toString('hex');
}

const cfg = loadChainConfig(chainArg);
const artifactPath = path.join(ROOT, 'build/artifacts/contracts', `${contract}.sol`, `${contract}.json`);
if (!fs.existsSync(artifactPath)) out(1, 'error', null, `no artifact at ${path.relative(ROOT, artifactPath)} — run hardhat compile first`);
const art = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
const want = normalizeRuntime(art.deployedBytecode, art.immutableReferences ?? {});

const configured = (cfg.chain as any)[field] as string | undefined;
let ignitionAddr: string | undefined;
try {
    const p = path.join(ROOT, 'ignition/deployments', `chain-${cfg.chain.id}`, 'deployed_addresses.json');
    ignitionAddr = JSON.parse(fs.readFileSync(p, 'utf8'))[future];
} catch { /* nothing deployed through Ignition here yet */ }

// The chain id is known, so pin it: no network auto-detection, whose retry
// chatter on a dead RPC would bury the one line deploy.sh prints.
const provider = new RetryingJsonRpcProvider(cfg.chain.host, Number(cfg.chain.id), { staticNetwork: true });
const codeAt = async (a: string): Promise<string> => {
    for (let i = 0; ; i++) {
        try { return await provider.getCode(a); }
        catch (e) { if (i >= 3) throw e; await new Promise(r => setTimeout(r, 1000 * 2 ** i)); }
    }
};

try {
    // A transaction still in flight from the deployer: whatever the code says
    // now may be about to change (tonight's "dropped" deploy had landed).
    if (process.env.PRIVATE_KEY) {
        const me = new Wallet(process.env.PRIVATE_KEY).address;
        const [latest, pending] = await Promise.all([
            provider.getTransactionCount(me, 'latest'), provider.getTransactionCount(me, 'pending'),
        ]);
        if (pending > latest) out(5, 'pending', null, `deployer ${me} has ${pending - latest} unconfirmed transaction(s) (nonce ${latest}..${pending - 1}) — wait for it to land, then re-run`);
    }

    const candidates = [...new Set([configured, ignitionAddr].filter((a): a is string => !!a && /^0x[0-9a-fA-F]{40}$/.test(a)).map(a => getAddress(a)))];
    if (candidates.length === 0) out(3, 'missing', null, `chain.${field} is not set and Ignition has no ${future} for chain-${cfg.chain.id}`);

    let sawCode: string | null = null;
    for (const a of candidates) {
        const code = await codeAt(a);
        if (code === '0x') continue;
        if (normalizeRuntime(code, art.immutableReferences ?? {}) === want) {
            const where = a === (configured && getAddress(configured)) ? `chain.${field}` : `Ignition's record (chain.${field} is ${configured ?? 'unset'} — run yarn contract-update ${cfg.chain.label})`;
            out(0, 'current', a, `${contract} at ${where} matches contracts/${contract}.sol`);
        }
        sawCode ??= a;
    }
    if (sawCode) out(4, 'outdated', sawCode, `code at ${sawCode} differs from contracts/${contract}.sol`);
    out(3, 'missing', candidates[0], `no code at ${candidates.join(' / ')}`);
} catch (e) {
    out(1, 'error', null, `could not read the chain: ${(e as Error).message?.slice(0, 160)}`);
}
