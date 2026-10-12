// Toggle HyperEVM big blocks for the PRIVATE_KEY address.
//
//   node scripts/hyperevm-bigblocks.mjs status       is it on?
//   node scripts/hyperevm-bigblocks.mjs on           route this address's txs to big blocks
//   node scripts/hyperevm-bigblocks.mjs off          back to small blocks
//   add --testnet for Hyperliquid testnet (chain 998)
//
// WHY. HyperEVM builds two kinds of block: small (~2-3M gas, every second) and
// big (30M gas, every minute). Which one a transaction lands in is decided by
// a per-ADDRESS flag on HyperCore, not by the transaction. A deployment above
// the small-block limit — LiquidationExecutor's is — is refused with "exceeds
// block gas limit" until the flag is on.
//
// TURN IT OFF AGAIN. The deployer is also the executors' owner, i.e. the bot's
// key. While the flag is on, EVERY transaction from it waits for a one-minute
// block, which is fatal for liquidations and arbitrage. So:
//
//   node scripts/hyperevm-bigblocks.mjs on
//   yarn deploy-liquidator hyperliquid
//   node scripts/hyperevm-bigblocks.mjs off
//
// PREREQUISITE. The address must already be a HyperCore user — it has to have
// received a Core asset. Cheapest: in app.hyperliquid.xyz, Portfolio, move a
// little HYPE from HyperEVM to Spot, or deposit ≥5 USDC via the bridge. The
// script checks this first and says so, rather than letting the exchange reject
// the action with a terse error.
//
// HOW IT IS SIGNED. evmUserModify is an "L1 action": msgpack(action) ‖ nonce
// (u64 BE) ‖ 0x00 (no vault) is keccak-hashed, and that hash is signed as the
// EIP-712 `Agent { source, connectionId }` in the "Exchange" domain (chainId
// 1337), source "a" on mainnet / "b" on testnet. Same as the official
// hyperliquid-python-sdk's Exchange.use_big_blocks(); the msgpack encoding is
// done by hand below because the action is two short strings and a bool.

import 'dotenv/config';
import { Wallet, keccak256, concat, toBeHex, Signature, getAddress } from 'ethers';
import { pathToFileURL } from 'node:url';

// ---- msgpack, just enough for {type: string, usingBigBlocks: bool} ----------
function packStr(s) {
    const b = new TextEncoder().encode(s);
    if (b.length < 32) return concat([Uint8Array.of(0xa0 | b.length), b]);
    if (b.length < 256) return concat([Uint8Array.of(0xd9, b.length), b]);
    throw new Error('string too long for this encoder');
}
function packValue(v) {
    if (typeof v === 'string') return packStr(v);
    if (typeof v === 'boolean') return Uint8Array.of(v ? 0xc3 : 0xc2);
    throw new Error(`unsupported msgpack value ${typeof v}`);
}
/** Map in insertion order — the order Python's msgpack.packb(dict) uses. */
function packMap(obj) {
    const entries = Object.entries(obj);
    if (entries.length >= 16) throw new Error('map too large for this encoder');
    return concat([Uint8Array.of(0x80 | entries.length), ...entries.flatMap(([k, v]) => [packStr(k), packValue(v)])]);
}

export function actionHash(action, nonce) {
    return keccak256(concat([packMap(action), toBeHex(BigInt(nonce), 8), Uint8Array.of(0x00)]));
}

export async function signL1Action(wallet, action, nonce, isMainnet) {
    const sig = await wallet.signTypedData(
        { name: 'Exchange', version: '1', chainId: 1337, verifyingContract: '0x0000000000000000000000000000000000000000' },
        { Agent: [{ name: 'source', type: 'string' }, { name: 'connectionId', type: 'bytes32' }] },
        { source: isMainnet ? 'a' : 'b', connectionId: actionHash(action, nonce) },
    );
    const s = Signature.from(sig);
    return { r: s.r, s: s.s, v: s.v };
}

// ---- I/O --------------------------------------------------------------------
async function post(url, body) {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = text; }
    if (!res.ok) throw new Error(`${url} → HTTP ${res.status}: ${text.slice(0, 300)}`);
    return json;
}

async function usingBigBlocks(EVM_RPC, address) {
    const r = await post(EVM_RPC, { jsonrpc: '2.0', id: 1, method: 'eth_usingBigBlocks', params: [address] });
    if (r.error) throw new Error(`eth_usingBigBlocks: ${JSON.stringify(r.error)}`);
    return r.result === true;
}

async function coreRole(API, address) {
    const r = await post(`${API}/info`, { type: 'userRole', user: address });
    return r?.role ?? 'unknown';
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---- main -------------------------------------------------------------------
async function main() {
    const args = process.argv.slice(2);
    const cmd = args.find(a => !a.startsWith('--'));
    const testnet = args.includes('--testnet');

    const API = testnet ? 'https://api.hyperliquid-testnet.xyz' : 'https://api.hyperliquid.xyz';
    // Hyperliquid's own EVM RPC: third-party endpoints (dRPC, …) do not implement
    // eth_usingBigBlocks, so the readback must come from here regardless of
    // HYPERLIQUID_RPC.
    const EVM_RPC = testnet ? 'https://rpc.hyperliquid-testnet.xyz/evm' : 'https://rpc.hyperliquid.xyz/evm';

    if (!['on', 'off', 'status'].includes(cmd)) {
        console.error('usage: node scripts/hyperevm-bigblocks.mjs on|off|status [--testnet]');
        process.exit(1);
    }
    if (!process.env.PRIVATE_KEY) {
        console.error('PRIVATE_KEY is not set (.env)');
        process.exit(1);
    }
    const wallet = new Wallet(process.env.PRIVATE_KEY);
    const address = getAddress(wallet.address);

    console.log(`${testnet ? 'testnet' : 'mainnet'}  ${address}`);
    const before = await usingBigBlocks(EVM_RPC, address);
    console.log(`  big blocks: ${before ? 'ON (txs wait for ~1-minute 30M-gas blocks)' : 'off (small 1-second blocks)'}`);
    if (cmd === 'status') process.exit(0);

    const want = cmd === 'on';
    if (before === want) {
        console.log(`  already ${cmd} — nothing to do`);
        process.exit(0);
    }

    const role = await coreRole(API, address);
    if (role === 'missing') {
        console.error(`
      [!] ${address} is not a HyperCore user yet, so HyperCore will refuse the toggle.
          Activate it once by giving it a Core asset, e.g. in https://app.hyperliquid.xyz
          with this wallet: Portfolio → move a little HYPE from HyperEVM to Spot,
          or deposit ≥5 USDC through the bridge. Then rerun.`);
        process.exit(1);
    }
    if (role !== 'user') console.warn(`  [!] HyperCore role is "${role}", not "user" — trying anyway`);

    const action = { type: 'evmUserModify', usingBigBlocks: want };
    const nonce = Date.now();
    const signature = await signL1Action(wallet, action, nonce, !testnet);
    const res = await post(`${API}/exchange`, { action, nonce, signature, vaultAddress: null });
    if (res?.status !== 'ok') {
        console.error(`  exchange refused: ${JSON.stringify(res)}`);
        process.exit(1);
    }
    console.log(`  exchange accepted evmUserModify usingBigBlocks=${want}`);

    // HyperCore applies it on its next block; the EVM side can lag a few seconds.
    for (let i = 0; i < 30; i++) {
        if ((await usingBigBlocks(EVM_RPC, address)) === want) {
            console.log(`  confirmed: big blocks ${want ? 'ON' : 'off'}`);
            if (want) console.log(`  deploy now, then:  node scripts/hyperevm-bigblocks.mjs off${testnet ? ' --testnet' : ''}`);
            process.exit(0);
        }
        await sleep(2000);
    }
    console.error(`  [!] accepted, but eth_usingBigBlocks still reports ${!want} after 60s — check with: node scripts/hyperevm-bigblocks.mjs status`);
    process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
