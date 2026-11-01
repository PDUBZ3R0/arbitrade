// -----------------------------------------------------------------------------
// Chunked batch reads that survive a public RPC refusing some of the calls.
//
// Polygon, 2026-10-30: the hot loop's startup refresh read 17,000 pairs in
// 400-pair calls with no retry. The rated pool refused nine of them
// ("missing revert data" — the node gave up, nothing reverted), and the
// refresh logged "3600 pair(s) unreadable (left as-is)" and went on. Those
// pairs kept DB reserves 16 days old until they next traded; the startup
// sweep then reported 93,505 and 116,088 "already profitable" cycles, the
// hot loop confirmed 0 of 130 attempts, and the pending probe's backruns
// decayed on exact reserves 69 times in 99. The same 17,022 pairs read
// cleanly on a second try minutes later.
//
// So: retry a refused call with backoff, then split a chunk that still fails
// (a smaller call often gets through, and a genuinely bad item is isolated
// instead of taking 399 good ones down with it). Only single items that never
// read come back as `failed`.
// -----------------------------------------------------------------------------

/** A node that refused the call (rate limit, null-data CALL_EXCEPTION, timeout) — not a real revert. Worth a retry. */
export const isTransientRpcError = (e: unknown): boolean =>
    /missing revert data|could not coalesce|CALL_EXCEPTION|SERVER_ERROR|TIMEOUT|timeout|rate limit|too many request|ECONNRESET|ETIMEDOUT|socket hang up|-3200[0-9]|\b429\b|\b503\b/i
        .test((e as Error)?.message ?? String(e));

export async function readChunked<T, R>(
    items: T[],
    chunkSize: number,
    /** Reads one chunk; must return one result per item, in order. */
    read: (chunk: T[]) => Promise<R[]>,
    opts: {
        /** Backoff before each retry of a transient failure; its length is the retry count. Default 250, 750ms. */
        retryDelaysMs?: number[];
        isTransient?: (e: unknown) => boolean;
        sleep?: (ms: number) => Promise<void>;
    } = {},
): Promise<{ rows: Array<{ item: T; row: R }>; failed: Array<{ item: T; error: string }> }> {
    const delays = opts.retryDelaysMs ?? [250, 750];
    const transient = opts.isTransient ?? isTransientRpcError;
    const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
    const rows: Array<{ item: T; row: R }> = [];
    const failed: Array<{ item: T; error: string }> = [];

    const attempt = async (chunk: T[]): Promise<void> => {
        let lastErr: unknown;
        for (let i = 0; i <= delays.length; i++) {
            if (i > 0) await sleep(delays[i - 1]);
            try {
                const got = await read(chunk);
                if (got.length !== chunk.length) throw new Error(`read returned ${got.length} rows for ${chunk.length} items`);
                chunk.forEach((item, k) => rows.push({ item, row: got[k] }));
                return;
            } catch (e) {
                lastErr = e;
                // A real error won't fix itself on a retry; splitting may isolate it.
                if (!transient(e)) break;
            }
        }
        if (chunk.length === 1) {
            failed.push({ item: chunk[0], error: ((lastErr as Error)?.message ?? String(lastErr)).slice(0, 200) });
            return;
        }
        const h = Math.ceil(chunk.length / 2);
        await attempt(chunk.slice(0, h));
        await attempt(chunk.slice(h));
    };

    for (let i = 0; i < items.length; i += chunkSize) await attempt(items.slice(i, i + chunkSize));
    return { rows, failed };
}
