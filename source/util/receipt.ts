import type { Provider, TransactionReceipt } from 'ethers';

/**
 * The receipt of `hash` (status 0 included — this never throws on a revert),
 * or null if it has not mined within `timeoutMs`. A failed read is retried, not
 * thrown.
 *
 * Not ethers' tx.wait() / waitForTransaction(): both poll from block listeners
 * and async Promise executors, where a failed receipt read escapes as an
 * unhandled rejection and kills the process. Sonic VPS, 2026-11-02: a rate-
 * limited endpoint answered "Request timeout on the free plan" to a backrun's
 * receipt read and the hot loop crashed after 58 min — and the restart reset
 * the backrun loss cap.
 */
export async function waitReceipt(provider: Provider, hash: string, timeoutMs: number, pollMs = 500): Promise<TransactionReceipt | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        try {
            const r = await provider.getTransactionReceipt(hash);
            if (r) return r;
        } catch { /* a bad endpoint or a rate limit: try again next poll */ }
        if (Date.now() + pollMs > deadline) return null;
        await new Promise(res => setTimeout(res, pollMs));
    }
}
