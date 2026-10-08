// tailRpc error classification: an outright-refused filter (Sonic blocks
// Euler's 174-address getLogs with -32602 "Request blocked") must THROW so the
// caller can skip the venue, and a persistently-"transient" error must give up
// after MAX_TRANSIENT_FAILS instead of looping forever and wedging the other
// venues in the sequential tracks loop. A successful chunk resets the counter.
import { tailRpc } from '../source/liquidation/events.ts';

let pass = 0, fail = 0;
const ok = (c, m, x = '') => { if (c) { pass++; console.log(`  ok   ${m} ${x}`); } else { fail++; console.log(`  FAIL ${m} ${x}`); } };

// Minimal LiqDB / EventSource stubs — tailRpc only touches these members.
const mkDb = () => ({ pool: '0xpool', applyEvents: () => [] });
const mkSource = (addrs = ['0xa']) => ({ eventAddresses: addrs, eventTopics: ['0xtopic'], decodeEvent: () => null });
// ethers-shaped error: message + nested error.message, like a wrapped JSON-RPC reject.
const rpcErr = (outer, innerMsg) => Object.assign(new Error(outer), { error: { message: innerMsg } });

// A provider whose getLogs runs a scripted sequence of outcomes. Each entry is
// either an Error to throw or an array of logs to return.
const scripted = (seq) => { let i = 0; return { getLogs: async () => { const s = seq[Math.min(i++, seq.length - 1)]; if (s instanceof Error) throw s; return s; }, _calls: () => i }; };

const NO_SLEEP = { chunkMin: 10, chunkMax: 50_000 };
// speed: monkeypatch global setTimeout so the 5s backoffs are instant.
const realST = globalThis.setTimeout;
globalThis.setTimeout = (fn) => realST(fn, 0);

console.log('1. outright refusal throws immediately (does not retry)');
{
    const prov = scripted([rpcErr('could not coalesce error', 'Request blocked')]);
    let threw = null;
    try { await tailRpc(prov, mkDb(), 100, 200, { ...NO_SLEEP, source: mkSource() }); }
    catch (e) { threw = e; }
    ok(threw != null, 'threw on "Request blocked"');
    ok(threw && /refused/i.test(threw.message), 'message marks it as refused', threw?.message?.slice(0, 70));
    ok(prov._calls() === 1, 'called getLogs exactly once — no retry loop', `calls=${prov._calls()}`);
}

console.log('2. -32602 code in the message is treated as a refusal');
{
    const prov = scripted([rpcErr('server responded', 'error -32602 bad filter')]);
    let threw = null;
    try { await tailRpc(prov, mkDb(), 100, 200, { ...NO_SLEEP, source: mkSource() }); } catch (e) { threw = e; }
    ok(threw != null && prov._calls() === 1, '-32602 throws without retrying', `calls=${prov._calls()}`);
}

console.log('3. a persistently-transient error gives up after the cap (no infinite loop)');
{
    // Always throws a transient-looking error → must terminate, not hang.
    const prov = scripted([rpcErr('network error', 'gateway timeout 504')]);
    let threw = null;
    const done = tailRpc(prov, mkDb(), 100, 200, { ...NO_SLEEP, source: mkSource() })
        .catch(e => { threw = e; });
    // Bounded wait: if the cap works this resolves immediately under the patched timer.
    await Promise.race([done, new Promise((_, rej) => realST(() => rej(new Error('TIMED OUT — tailRpc looped')), 2000))])
        .catch(e => { if (/TIMED OUT/.test(e.message)) { fail++; console.log('  FAIL did not give up — ' + e.message); } });
    ok(threw != null, 'eventually threw instead of looping forever');
    // 1 initial + MAX_TRANSIENT_FAILS(6) retries = 7 attempts, then throw.
    ok(prov._calls() === 7, 'gave up after 6 retries (7 total attempts)', `calls=${prov._calls()}`);
}

console.log('4. a transient blip that then succeeds is NOT fatal, and resets the counter');
{
    const prov = scripted([
        rpcErr('network error', 'ECONNRESET'),   // blip on first chunk
        [],                                        // recovers — chunk 1 done, counter resets
    ]);
    let threw = null, res = null;
    try { res = await tailRpc(prov, mkDb(), 100, 200, { chunk: 5_000, ...NO_SLEEP, source: mkSource() }); }
    catch (e) { threw = e; }
    ok(threw == null, 'recovered without throwing');
    ok(res != null && res.throughBlock === 200, 'completed through the head block', `through=${res?.throughBlock}`);
}

globalThis.setTimeout = realST;
console.log(`\n${fail === 0 ? 'all passed' : fail + ' FAILED'} (${pass} ok)`);
process.exit(fail === 0 ? 0 : 1);
