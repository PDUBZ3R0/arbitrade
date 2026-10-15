// -----------------------------------------------------------------------------
// RPC provider factory.
//
// REAL CHAINS: a pool of rated public RPCs (vetted-provider's VettedProvider).
// makeProvider(cfg.chain) routes every request to a public endpoint rated for
// that job (getLogs range, revert data, gas cap, history, head freshness), with
// your own endpoints used only when no public one can do it:
//
//   ratings     conf/provider/<chainId>.json  (vetrpc vet <chainId>). Without a
//               file the pool uses chainlist's unrated list and learns as it goes.
//   private     <LABEL>_RPC / <LABEL>_WS from .env, when set
//   sends       chain.sequencer (conf, or <LABEL>_SEQUENCER): transactions go
//               ONLY there; without one, to the private endpoint; without
//               either, to the best-rated public trader endpoint
//
// The conf files' host / ws entries are not used for real chains any more.
//
// LOCAL / TEST endpoints — a chain object without a label, an RPC on 127.0.0.1
// or localhost (anvil), or ARB_NO_POOL=1 — keep the single-endpoint providers
// below: websocket first, HTTP as the safety net.
//
// --- the single-endpoint providers --------------------------------------------
//
// Every place that used to do `new JsonRpcProvider(cfg.chain.host)` calls
// makeProvider(cfg.chain) instead. When the chain has a websocket endpoint
// (`ws` / `wss` in @chains.json5 or the chain conf, or <LABEL>_WS in .env)
// requests go over one persistent socket — no per-request HTTP/TLS setup,
// which is what matters for the hot path's estimateGas -> staticCall ->
// sendTransaction sequence. Without one, it is a plain JsonRpcProvider,
// exactly as before. HyperSync is untouched: it has its own client.
//
// WHY A SUBCLASS OF JsonRpcProvider, NOT ethers' WebSocketProvider
//
// A bare WebSocketProvider has three properties that are fine for a demo and
// wrong for a bot that runs for days:
//
//   1. It does not reconnect. A dropped socket leaves requests hanging until
//      something times them out — and nothing does by default.
//   2. It holds the Node event loop open, so every short CLI (scan, reserves,
//      verify…) would hang at exit unless each one remembered to destroy it.
//   3. Its type is not JsonRpcProvider, which ~30 function signatures here
//      expect.
//
// WsFirstProvider IS a JsonRpcProvider for the HTTP host and overrides only
// _send: each request tries the socket first, with a timeout; a transport
// failure (timeout, closed socket, connect failure) marks the socket down,
// reconnects it in the background with backoff, and serves that request over
// HTTP. A JSON-RPC *error* answered over the socket (a revert, a range limit)
// is a real answer and is returned as-is — it is not retried over HTTP, so the
// caller sees one consistent provider's behaviour.
//
// eth_sendRawTransaction is the one write. If the socket times out after the
// node may already have it, resending over HTTP can come back "already known";
// that is success, and the tx hash (keccak of the raw tx) is returned, so a
// broadcast is never reported as failed when it went through.
//
// The socket is ref'd only while requests are in flight, so it never keeps a
// finished CLI alive.
//
// Set ARB_NO_WS=1 to force plain HTTP everywhere (debugging, or a provider
// whose websocket misbehaves).
// -----------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonRpcProvider, WebSocketProvider, Network, keccak256 } from 'ethers';
import type { JsonRpcPayload, JsonRpcResult, JsonRpcError } from 'ethers';
import { VettedProvider } from 'vetted-provider';

export type RpcEndpoints = { host: string; ws?: string; id?: number; label?: string; sequencer?: string };

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LOCAL_RE = /^(?:https?|wss?):\/\/(?:127\.|localhost\b|\[::1\]|0\.0\.0\.0)/i;

/** <LABEL>_RPC / <LABEL>_WS from .env — the private endpoints. */
export function privateEndpoints(label: string): { rpc?: string; ws?: string } {
    const k = label.toUpperCase().replace(/-/g, '_');
    return { rpc: process.env[`${k}_RPC`] || undefined, ws: process.env[`${k}_WS`] || undefined };
}

/** Where a chain's RPC ratings live. */
export const ratingsFile = (chainId: number | string) => path.join(PROJECT_ROOT, 'conf', 'provider', `${chainId}.json`);

/**
 * The widest eth_getLogs block range any rated endpoint passing `scanner`
 * accepts — a chunk ceiling for log replays that go through the pool. Null
 * without ratings (or off the pool), so callers keep their own tuning.
 */
export function poolLogRange(chain: RpcEndpoints): number | null {
    if (!usesPool(chain)) return null;
    try {
        const res = JSON.parse(fs.readFileSync(ratingsFile(chain.id!), 'utf8')) as { endpoints?: Array<{ ratings?: { scanner?: { pass?: boolean } }; logs?: { maxRange?: number | null } }> };
        const ranges = (res.endpoints ?? []).filter(e => e.ratings?.scanner?.pass).map(e => e.logs?.maxRange ?? 0).filter(n => n > 0);
        return ranges.length ? Math.max(...ranges) : null;
    } catch { return null; }
}

/** True when makeProvider(chain) gives the rated public pool rather than one endpoint. */
export function usesPool(chain: RpcEndpoints): boolean {
    return !!chain.label && !!chain.id && process.env.ARB_NO_POOL !== '1' && !LOCAL_RE.test(chain.host ?? '');
}

export type ProviderOptions = {
    /** Force HTTP even when a websocket is configured. */
    http?: boolean;
    /**
     * How long the SOCKET may stay silent — no reply, no pong — while a
     * request is waiting, before it is declared dead and the request retried
     * over HTTP. Default 20s. A slow request on a live socket is not a dead
     * socket: see WsFirstProvider.
     */
    timeoutMs?: number;
    /** Hard cap for any single request on the socket. Default 10 minutes. */
    maxRequestMs?: number;
};

/**
 * A rate-limit reply: a JSON-RPC error or HTTP failure whose MESSAGE says so.
 * Not code -32005 alone — Infura-style nodes use -32005 for "query returned
 * more than 10000 results", which scan must see promptly to shrink its range.
 */
const RATE_LIMIT = /rate.?limit|too many requests|\b429\b|request limit|exceeded.*(?:rate|requests per)|capacity exceeded/i;
export function isRateLimited(e: unknown): boolean {
    const any = e as any;
    const msg = [any?.message, any?.shortMessage, any?.error?.message, any?.info?.error?.message,
                 any?.info?.responseStatus, JSON.stringify(any?.value ?? '')].filter(Boolean).join(' ');
    return RATE_LIMIT.test(msg) || any?.status === 429 || any?.info?.responseStatus?.startsWith?.('429');
}

/**
 * JsonRpcProvider that waits out rate limits instead of failing the caller.
 *
 * Public endpoints (rpc.hyperliquid.xyz, publicnode, …) answer bursts with
 * `{"code":-32005,"message":"rate limited"}`. Inside a batch that error comes
 * back with `id: null`, ethers cannot match it to a request, and the caller
 * gets "missing response for request" — which is how one refused eth_getCode
 * killed `yarn reserves hyperliquid` before it read a single pair. Retrying
 * the whole payload is safe: a rate-limited request was never executed, and
 * that includes eth_sendRawTransaction. Anything else is returned untouched.
 */
export class RetryingJsonRpcProvider extends JsonRpcProvider {
    /** Rate-limit waits so far — for logs and tests. */
    rateLimitRetries = 0;
    private static readonly MAX_ATTEMPTS = 7;   // ~0.5+1+2+4+8+8 s ≈ 24 s of waiting at most
    async _send(payload: JsonRpcPayload | JsonRpcPayload[]): Promise<JsonRpcResult[]> {
        for (let attempt = 1; ; attempt++) {
            let res: Result[] | undefined;
            let err: unknown;
            try { res = (await super._send(payload)) as Result[]; } catch (e) { err = e; }
            const limited = err !== undefined
                ? isRateLimited(err)
                : res!.some(r => 'error' in r && isRateLimited({ message: (r as JsonRpcError).error?.message }));
            if (!limited || attempt >= RetryingJsonRpcProvider.MAX_ATTEMPTS) {
                if (err !== undefined) throw err;
                return res as JsonRpcResult[];
            }
            this.rateLimitRetries++;
            const wait = Math.min(8000, 500 * 2 ** (attempt - 1)) * (0.75 + Math.random() * 0.5);
            await new Promise(r => setTimeout(r, wait));
        }
    }
}

/** The provider every CLI and loop should use: the rated pool for a real chain (see the header). */
export function makeProvider(chain: RpcEndpoints, opts: ProviderOptions = {}): JsonRpcProvider {
    const noWs = !!opts.http || process.env.ARB_NO_WS === '1';
    if (usesPool(chain)) {
        const own = privateEndpoints(chain.label!);
        const ratings = ratingsFile(chain.id!);
        if (!fs.existsSync(ratings) && !warnedUnrated.has(chain.id!)) {
            warnedUnrated.add(chain.id!);
            console.warn(`[rpc] no ratings at ${path.relative(process.cwd(), ratings)} — using chainlist's unrated endpoints (rate them: vetrpc vet ${chain.id})`);
        }
        return new VettedProvider(Number(chain.id), {
            privateRpc: own.rpc ?? null,
            privateWs: noWs ? null : own.ws ?? null,
            sendRpc: chain.sequencer || undefined,
            ratings,
            useWs: !noWs,
            // Subscriptions (the hot loop's feed) go to your own websocket first
            // when you have one; public subscribers are the fallback.
            subscriptions: noWs ? 'poll' : 'push',
            subscribePrivate: !!own.ws && !noWs,
            // Some reads are heavy (getV3State over 100 pools); a timeout is a
            // transport failure that sends the request elsewhere, so be patient.
            timeoutMs: opts.maxRequestMs ?? 60_000,
        });
    }
    if (!chain.host) {
        const k = (chain.label ?? 'CHAIN').toUpperCase().replace(/-/g, '_');
        throw new Error(`no RPC for ${chain.label ?? `chain ${chain.id}`}: off the rated pool (ARB_NO_POOL=1, or no label/id) it needs ${k}_RPC in .env or chain.host in conf`);
    }
    if (!chain.ws || noWs) return new RetryingJsonRpcProvider(chain.host);
    return new WsFirstProvider(chain.host, chain.ws, chain.id, opts.timeoutMs, opts.maxRequestMs);
}

type Result = JsonRpcResult | JsonRpcError;

const TRANSPORT_FAIL = Symbol('transport');
const ALREADY_KNOWN = /already known|known transaction|already imported|nonce too low|replacement transaction underpriced/i;

export class WsFirstProvider extends RetryingJsonRpcProvider {
    readonly wsUrl: string;
    private ws: WebSocketProvider | null = null;
    private connecting: Promise<WebSocketProvider | null> | null = null;
    private retryAt = 0;
    private backoffMs = 1000;
    private inflight = 0;
    private readonly timeoutMs: number;
    private readonly netw?: Network;
    private closed = false;
    /** Rejects every request in flight on the current socket when it drops. */
    private failInflight: ((e: Error) => void) | null = null;
    private downSignal: Promise<never> | null = null;
    /** One rejecter per request in flight on the socket; markDown fails them all. */
    private readonly waiters = new Set<(e: Error) => void>();
    /** Last time the current socket delivered anything (a reply or a pong). */
    private lastRxAt = 0;
    private pingTimer: ReturnType<typeof setInterval> | null = null;
    private readonly maxRequestMs: number;
    /** Counters, for logs and tests. */
    readonly stats = { ws: 0, http: 0, fallbacks: 0, reconnects: 0 };
    /** permessage-deflate negotiated on the current socket (null until connected). */
    compressed: boolean | null = null;

    constructor(httpUrl: string, wsUrl: string, chainId?: number, timeoutMs = 20_000, maxRequestMs = 600_000) {
        const net = chainId ? Network.from(chainId) : undefined;
        // Sockets cannot carry JSON-RPC batches, so batching is off for the
        // whole provider (each request is its own message either way).
        super(httpUrl, net, { batchMaxCount: 1, ...(net ? { staticNetwork: net } : {}) });
        this.wsUrl = wsUrl;
        this.timeoutMs = timeoutMs;
        this.maxRequestMs = maxRequestMs;
        this.netw = net;
    }

    /** True while the socket is connected and serving requests. */
    get usingWebsocket(): boolean { return this.ws !== null; }

    private socketOf(ws: WebSocketProvider | null): any {
        return (ws as any)?.websocket?._socket;   // the `ws` package's net.Socket
    }
    private hold(delta: number): void {
        this.inflight += delta;
        const s = this.socketOf(this.ws);
        if (!s) return;
        if (this.inflight > 0) s.ref?.(); else s.unref?.();
    }

    private markDown(): void {
        const ws = this.ws;
        this.ws = null;
        if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
        this.failInflight?.(new Error('websocket down'));
        this.failInflight = null;
        for (const fail of this.waiters) fail(new Error('websocket down'));
        this.waiters.clear();
        if (ws) { try { ws.destroy(); } catch { /* already gone */ } }
        this.retryAt = Date.now() + this.backoffMs;
        this.backoffMs = Math.min(this.backoffMs * 2, 60_000);
    }

    private async socket(): Promise<WebSocketProvider | null> {
        if (this.closed) return null;
        if (this.ws) return this.ws;
        if (Date.now() < this.retryAt) return null;
        this.connecting ??= (async () => {
            let ws: WebSocketProvider | null = null;
            try {
                ws = new WebSocketProvider(this.wsUrl, this.netw, this.netw ? { staticNetwork: this.netw } : undefined);
                const raw: any = (ws as any).websocket;
                // A refused/failed connect must fail fast, not after the timeout.
                let failConnect!: (e: Error) => void;
                const connectFailed = new Promise<never>((_, rej) => { failConnect = rej; });
                connectFailed.catch(() => { /* handled by the race below */ });
                // ethers never settles requests that were in flight when the
                // socket closes; they would hang until the timeout. Fail them
                // at once instead, so they retry over HTTP immediately.
                let failInflight!: (e: Error) => void;
                const down = new Promise<never>((_, rej) => { failInflight = rej; });
                down.catch(() => { /* raced per request */ });
                const onDown = () => {
                    failConnect(new Error('websocket closed'));
                    failInflight(new Error('websocket closed'));
                    if (this.ws === ws) this.markDown();
                };
                if (raw?.on) { raw.on('close', onDown); raw.on('error', onDown); }
                else if (raw?.addEventListener) { raw.addEventListener('close', onDown); raw.addEventListener('error', onDown); }
                // ethers' _start() resolves before the socket is OPEN when the
                // network is static (no eth_chainId round trip to wait on), and
                // every send in that window fails "WebSocket is not open". So
                // wait for the open event ourselves, then start.
                const opened = new Promise<void>(res => {
                    if (raw?.readyState === 1) return res();
                    if (raw?.once) raw.once('open', () => res());
                    else raw?.addEventListener?.('open', () => res(), { once: true });
                });
                await withTimeout(Promise.race([opened, connectFailed]), Math.min(this.timeoutMs, 10_000));
                await withTimeout(Promise.race([(ws as any)._start(), connectFailed]), Math.min(this.timeoutMs, 10_000));
                this.socketOf(ws)?.unref?.();
                // Liveness: any frame from the server counts, and a ping
                // every quarter-timeout keeps a socket that is busy on one
                // long request provably alive (the server pongs between
                // frames even while it computes).
                this.lastRxAt = Date.now();
                const touch = () => { this.lastRxAt = Date.now(); };
                raw?.on?.('message', touch);
                raw?.on?.('pong', touch);
                this.compressed = /permessage-deflate/.test(String(raw?.extensions ?? ''));
                if (this.pingTimer) clearInterval(this.pingTimer);
                this.pingTimer = setInterval(() => {
                    if (this.inflight > 0 && raw?.readyState === 1) { try { raw.ping?.(); } catch { /* closing */ } }
                }, Math.max(250, Math.floor(this.timeoutMs / 4)));
                this.pingTimer.unref?.();
                this.ws = ws;
                this.downSignal = down;
                this.failInflight = failInflight;
                this.backoffMs = 1000;
                this.stats.reconnects++;
                return ws;
            } catch {
                if (ws) { try { ws.destroy(); } catch { /* ignore */ } }
                this.retryAt = Date.now() + this.backoffMs;
                this.backoffMs = Math.min(this.backoffMs * 2, 60_000);
                return null;
            } finally {
                this.connecting = null;
            }
        })();
        return this.connecting;
    }

    private async viaSocket(p: JsonRpcPayload): Promise<Result | typeof TRANSPORT_FAIL> {
        const ws = await this.socket();
        if (!ws) return TRANSPORT_FAIL;
        this.hold(+1);
        // Each request gets its own "socket down" rejecter, cleared when it
        // settles. Racing every request against ONE per-socket promise attached
        // a handler to it per request — each holding that request's whole
        // response — freed only when the socket dropped: a socket that stayed up
        // for 15 h grew the heap to 4 GB (Robinhood liq-watch, 2026-10-14).
        let failNow!: (e: Error) => void;
        const down = new Promise<never>((_, reject) => { failNow = reject; });
        down.catch(() => {});
        this.waiters.add(failNow);
        try {
            // NOT a plain per-request timeout. A heavy eth_call (getV3State
            // on 100 pools) can take longer than 20s on a perfectly healthy
            // socket; timing it out tore the socket down, failed every other
            // request in flight on it, and re-ran all of them over HTTP —
            // observed as "fallbacks 69" and a reserves run at 0.02 batch/s,
            // each batch executed twice. The socket is dead only if it has
            // gone SILENT (no replies, no pongs) for timeoutMs.
            const live = this.liveness(Date.now());
            try {
                const res = await Promise.race([(ws as any)._send(p) as Promise<Result[]>, down, live.promise]);
                this.stats.ws++;
                return res[0];
            } finally {
                live.cancel();
                this.waiters.delete(failNow);
            }
        } catch {
            if (this.ws === ws) this.markDown();
            return TRANSPORT_FAIL;
        } finally {
            this.hold(-1);
        }
    }

    /**
     * Rejects once the socket has been silent for timeoutMs, or the request
     * has run for maxRequestMs. The interval is ref'd on purpose — it is what
     * keeps Node alive while a request waits (see withTimeout) — so callers
     * must cancel() it when the request settles.
     */
    private liveness(start: number): { promise: Promise<never>; cancel: () => void } {
        let t: ReturnType<typeof setInterval> | null = null;
        const promise = new Promise<never>((_, rej) => {
            t = setInterval(() => {
                const now = Date.now();
                if (now - Math.max(start, this.lastRxAt) > this.timeoutMs) rej(new Error(`websocket silent ${this.timeoutMs}ms`));
                else if (now - start > this.maxRequestMs) rej(new Error(`request exceeded ${this.maxRequestMs}ms`));
            }, Math.max(50, Math.min(1000, Math.floor(this.timeoutMs / 4))));
        });
        promise.catch(() => { /* raced */ });
        return { promise, cancel: () => { if (t) clearInterval(t); t = null; } };
    }

    private async viaHttp(p: JsonRpcPayload): Promise<Result> {
        this.stats.http++;
        const res = await super._send(p);
        return res[0];
    }

    // ethers types the base as JsonRpcResult[], but its HTTP _send returns
    // error objects in the same array; the cast keeps the override honest.
    async _send(payload: JsonRpcPayload | JsonRpcPayload[]): Promise<JsonRpcResult[]> {
        const list = Array.isArray(payload) ? payload : [payload];
        const out: Result[] = [];
        for (const p of list) {
            const r = await this.viaSocket(p);
            if (r !== TRANSPORT_FAIL) { out.push(r); continue; }
            if (this.ws === null && this.stats.ws + this.stats.http > 0) this.stats.fallbacks++;
            const h = await this.viaHttp(p);
            // A raw tx the socket may already have delivered: "already known"
            // over HTTP means it is in the mempool — report it as sent.
            if (p.method === 'eth_sendRawTransaction' && 'error' in h && ALREADY_KNOWN.test(String(h.error?.message ?? ''))) {
                out.push({ id: p.id, result: keccak256((p.params as any[])[0]) } as JsonRpcResult);
                continue;
            }
            out.push(h);
        }
        return out as JsonRpcResult[];
    }

    destroy(): void {
        this.closed = true;
        if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
        if (this.ws) { try { this.ws.destroy(); } catch { /* ignore */ } this.ws = null; }
        super.destroy();
    }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    let t: ReturnType<typeof setTimeout>;
    return Promise.race([
        p.finally(() => clearTimeout(t)),
        // Deliberately NOT unref'd: while a request is pending this timer is
        // what keeps Node alive if the socket underneath has been torn down.
        // An unref'd timer let `yarn reserves` exit mid-run ("unsettled
        // top-level await") when a socket dropped with requests in flight.
        // It is cleared as soon as the request settles, so a finished CLI
        // still exits at once.
        new Promise<T>((_, rej) => { t = setTimeout(() => rej(new Error(`rpc timeout ${ms}ms`)), ms); }),
    ]);
}

/**
 * One provider per endpoint pair for the whole process, for helpers that are
 * called once per candidate (verifyFactory, verifyV3Factory, proxy detection)
 * and never destroy what they create. Without this each call would open its
 * own socket. Callers must NOT destroy() the shared instance.
 */
const shared = new Map<string, JsonRpcProvider>();
const warnedUnrated = new Set<number | string>();
export function sharedProvider(chain: RpcEndpoints): JsonRpcProvider {
    const key = usesPool(chain) ? `pool|${chain.id}` : `${chain.host}|${process.env.ARB_NO_WS === '1' ? '' : chain.ws ?? ''}`;
    let p = shared.get(key);
    if (!p) { p = makeProvider(chain); shared.set(key, p); }
    return p;
}

/**
 * An RPC URL safe to print: API keys in the query (key, token, authorization,
 * apikey, secret…), long key-like path segments (/v2/<key>, /<token>) and
 * user:pass are masked. Logs leave the machine (S3, CloudWatch), so every URL a
 * log line prints goes through this.
 */
export function redactUrl(u: string | undefined | null): string {
    if (!u) return String(u);
    try {
        const x = new URL(u);
        if (x.username || x.password) { x.username = '***'; x.password = ''; }
        for (const k of [...x.searchParams.keys()]) {
            if (/key|token|auth|secret|pass|sig/i.test(k)) x.searchParams.set(k, '***');
        }
        x.pathname = x.pathname.split('/').map(seg => seg.length >= 20 && /^[A-Za-z0-9_-]+$/.test(seg) ? '***' : seg).join('/');
        return x.toString().replace(/%2A/g, '*');
    } catch {
        return u.replace(/[A-Za-z0-9_-]{20,}/g, '***');
    }
}
