// -----------------------------------------------------------------------------
// Which Ignition futures are stuck "pending"?   (used by scripts/deploy.sh)
//
//   node scripts/ignition-stuck.mjs ignition/deployments/chain-<id>/journal.jsonl [skipFutureId]
//
// Prints one future id per line: futures whose last transaction Ignition sent
// (or prepared) was never confirmed in its journal, and that never completed.
//
// Why it matters: Ignition validates every new nonce against the HIGHEST
// nonce of any still-pending future in the deployment — not just the module
// being deployed. One deploy that Ignition reported as "dropped" but that
// landed (adopted by deploy-check, so the config is right) stays pending in
// the journal forever, and from then on EVERY deploy on that chain fails:
//
//   HHE10411: The next nonce for 0x… should be 6, but the node reports 7.
//
// (HyperEVM, 2026-10-12: LiquidationExecutor sent at nonce 5, landed, adopted;
// Ignition kept expecting 6 while the chain moved on.)
//
// deploy.sh only gets here after deploy-check has confirmed the deployer has
// nothing in flight (status 5 stops it), so a pending entry is a dead record —
// the transaction either landed (and the check adopts what it created) or was
// dropped. Wiping the record loses nothing.
// -----------------------------------------------------------------------------

import fs from 'node:fs';

const [file, skip] = process.argv.slice(2);
if (!file) { console.error('usage: ignition-stuck.mjs <journal.jsonl> [skipFutureId]'); process.exit(2); }
if (!fs.existsSync(file)) process.exit(0);

/** futureId → { sent: boolean, done: boolean } for its current (post-wipe) execution. */
const state = new Map();
for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    const id = r.futureId;
    if (!id) continue;
    switch (r.type) {
        case 'WIPE_APPLY': state.delete(id); break;
        case 'DEPLOYMENT_EXECUTION_STATE_INITIALIZE': state.set(id, { sent: false, done: false }); break;
        case 'TRANSACTION_PREPARE_SEND':
        case 'TRANSACTION_SEND': { const s = state.get(id); if (s) s.sent = true; break; }
        case 'TRANSACTION_CONFIRM': { const s = state.get(id); if (s) s.sent = false; break; }
        case 'DEPLOYMENT_EXECUTION_STATE_COMPLETE': { const s = state.get(id); if (s) s.done = true; break; }
    }
}
for (const [id, s] of state) if (s.sent && !s.done && id !== skip) console.log(id);
