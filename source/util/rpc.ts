// -----------------------------------------------------------------------------
// RPC provider factory: websocket first, HTTP as the safety net.
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

import { JsonRpcProvider, WebSocketProvider, Network, keccak256 } from 'ethers';
import type { JsonRpcPayload, JsonRpcResult, JsonRpcError } from 'ethers';

export type RpcEndpoints = { host: string; ws?: string; id?: number };

export type ProviderOptions = {
    /** Force HTTP even when a websocket is configured. */
    http?: boolean;
    /** Per-request socket timeout before falling back to HTTP. Default 20s. */
    timeoutMs?: number;
};

/** The provider every CLI and loop should use for chain.host / chain.ws. */
export function makeProvider(chain: RpcEndpoints, opts: ProviderOptions = {}): JsonRpcProvider {
    if (!chain.ws || opts.http || process.env.ARB_NO_WS === '1') return new JsonRpcProvider(chain.host);
    return new WsFirstProvider(chain.host, chain.ws, chain.id, opts.timeoutMs);
}

type Result = JsonRpcResult | JsonRpcError;

const TRANSPORT_FAIL = Symbol('transport');
const ALREADY_KNOWN = /already known|known transaction|already imported|nonce too low|replacement transaction underpriced/i;

export class WsFirstProvider extends JsonRpcProvider {
    readonly wsUrl: string;
    private ws: WebSocketProvider | null = null;
    private connecting: Promise<WebSocketProvider | null> | null = null;
    private retryAt = 0;
    private backoffMs = 1000;
    private inflight = 0;
    private readonly timeoutMs: number;
    private readonly netw?: Network;
    private closed = false;
    /** Counters, for logs and tests. */
    readonly stats = { ws: 0, http: 0, fallbacks: 0, reconnects: 0 };

    constructor(httpUrl: string, wsUrl: string, chainId?: number, timeoutMs = 20_000) {
        const net = chainId ? Network.from(chainId) : undefined;
        // Sockets cannot carry JSON-RPC batches, so batching is off for the
        // whole provider (each request is its own message either way).
        super(httpUrl, net, { batchMaxCount: 1, ...(net ? { staticNetwork: net } : {}) });
        this.wsUrl = wsUrl;
        this.timeoutMs = timeoutMs;
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
                const onDown = () => {
                    failConnect(new Error('websocket closed'));
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
                this.ws = ws;
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
        try {
            const res = await withTimeout((ws as any)._send(p) as Promise<Result[]>, this.timeoutMs);
            this.stats.ws++;
            return res[0];
        } catch {
            if (this.ws === ws) this.markDown();
            return TRANSPORT_FAIL;
        } finally {
            this.hold(-1);
        }
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
        if (this.ws) { try { this.ws.destroy(); } catch { /* ignore */ } this.ws = null; }
        super.destroy();
    }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    let t: ReturnType<typeof setTimeout>;
    return Promise.race([
        p.finally(() => clearTimeout(t)),
        new Promise<T>((_, rej) => { t = setTimeout(() => rej(new Error(`rpc timeout ${ms}ms`)), ms); t.unref?.(); }),
    ]);
}

/**
 * One provider per endpoint pair for the whole process, for helpers that are
 * called once per candidate (verifyFactory, verifyV3Factory, proxy detection)
 * and never destroy what they create. Without this each call would open its
 * own socket. Callers must NOT destroy() the shared instance.
 */
const shared = new Map<string, JsonRpcProvider>();
export function sharedProvider(chain: RpcEndpoints): JsonRpcProvider {
    const key = `${chain.host}|${process.env.ARB_NO_WS === '1' ? '' : chain.ws ?? ''}`;
    let p = shared.get(key);
    if (!p) { p = makeProvider(chain); shared.set(key, p); }
    return p;
}
