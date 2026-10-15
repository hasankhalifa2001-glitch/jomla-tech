/**
 * lib/db/tx-retry.ts
 *
 * T5c — shared transient-transaction classifier + retry runner.
 *
 * Classification mirrors app/api/sync/route.ts (T4c):
 * Prisma codes P2034/P2024/P1001/P1002/P1008/P1017; P2010 only when meta.code
 * is the SQLSTATE 40001/40P01 (never bare numbers inside message text —
 * validation messages embed amounts like "(140001.0000)"); initialization
 * errors; and an unambiguous message-phrase fallback. P2028 (interactive
 * transaction timeout) is additionally retryable, but at most
 * TX_TIMEOUT_MAX_ATTEMPTS P2028 failures in total are tolerated.
 *
 * Domain errors are NEVER retried: pass isFatal() and they rethrow at once.
 *
 * app/api/sync/route.ts is deliberately NOT refactored here (follow-up).
 */
import { Prisma } from "@prisma/client";

/** Total attempts for ordinary retryable failures (mirrors T4c's MAX_TX_ATTEMPTS). */
export const TX_MAX_ATTEMPTS = 3;
/** Maximum number of P2028 (interactive-transaction timeout) failures tolerated. */
export const TX_TIMEOUT_MAX_ATTEMPTS = 2;

/**
 * Same classification as T4c's isRetryableTxError(), plus P2028.
 * True only for transient infrastructure failures — never a domain error.
 */
export function isRetryableTxError(err: unknown): boolean {
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
        // P2034 write conflict / deadlock; P2024 pool timeout; P1001 unreachable;
        // P1002 timeout; P1008 operation timeout; P1017 server closed connection.
        if (["P2034", "P2024", "P1001", "P1002", "P1008", "P1017"].includes(err.code)) {
            return true;
        }
        // P2028: interactive-transaction timeout (capped separately in withTxRetries).
        if (err.code === "P2028") {
            return true;
        }
        // P2010: a RAW query failed; the Postgres SQLSTATE is in meta.code.
        // ONLY the structured field is read — never a bare-number match.
        if (err.code === "P2010") {
            const sqlState = (err.meta as { code?: unknown } | undefined)?.code;
            if (sqlState === "40001" || sqlState === "40P01") {
                return true;
            }
        }
    }
    // The client failed to establish a connection at all — transient.
    if (err instanceof Prisma.PrismaClientInitializationError) {
        return true;
    }
    const message = err instanceof Error ? err.message : String(err);
    // Unambiguous phrases only — NO bare numeric tokens.
    return /deadlock detected|could not serialize|P2024|server has closed the connection|connection terminated|connection reset|econnreset|etimedout|timed out fetching a new connection|can't reach database server/i.test(
        message
    );
}

/** True only for P2028 (interactive-transaction timeout). */
export function isTransactionTimeoutError(err: unknown): boolean {
    return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2028";
}

export interface TxRetryOptions {
    maxAttempts?: number;
    /** Max number of P2028 failures tolerated across all attempts. */
    timeoutMaxAttempts?: number;
    /** Domain errors (Approval*, ZodError, MoneyError) — never retried. */
    isFatal?: (err: unknown) => boolean;
    /** Injectable delay (tests pass an instant one). Default: jittered 100-300ms. */
    sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function withTxRetries<T>(run: () => Promise<T>, opts?: TxRetryOptions): Promise<T> {
    const maxAttempts = Math.max(1, opts?.maxAttempts ?? TX_MAX_ATTEMPTS);
    const timeoutMax = Math.max(1, opts?.timeoutMaxAttempts ?? TX_TIMEOUT_MAX_ATTEMPTS);
    const sleep = opts?.sleep ?? defaultSleep;
    let timeoutFailures = 0;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await run();
        } catch (err) {
            lastError = err;
            if (opts?.isFatal?.(err)) throw err;
            if (!isRetryableTxError(err)) throw err;
            // Only P2028 occurrences count against the P2028 cap (a P2034
            // followed by a P2028 still gets another attempt).
            if (isTransactionTimeoutError(err)) {
                timeoutFailures += 1;
                if (timeoutFailures >= timeoutMax) throw err;
            }
            if (attempt >= maxAttempts) throw err;
            // Short jittered pause: avoids re-colliding with the same
            // conflicting transaction / a still-reconnecting database.
            await sleep(100 + Math.floor(Math.random() * 200));
        }
    }
    throw lastError;
}