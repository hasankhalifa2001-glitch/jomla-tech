/**
 * lib/db/__tests__/tx-retry.test.ts
 *
 * T5c — shared transient-transaction classifier + retry runner.
 *
 * REAL: lib/db/tx-retry.ts. MOCKED: nothing (pure predicates + counter
 * closures; an instant `sleep` is injected so no test waits). Never touches a
 * database.
 */
import { describe, it, expect, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import {
    TX_MAX_ATTEMPTS,
    TX_TIMEOUT_MAX_ATTEMPTS,
    isRetryableTxError,
    isTransactionTimeoutError,
    withTxRetries,
} from "@/lib/db/tx-retry";
import { MoneyError } from "@/lib/utils/money";
import {
    ApprovalDomainError,
    ApprovalAlreadyReviewedError,
    ApprovalInsufficientStockError,
    ApprovalInvalidCustomerError,
    ApprovalInvalidPaymentError,
    ApprovalOrderNotFoundError,
    ApprovalProductInactiveError,
    ApprovalRateRequiredError,
    ApprovalValidationError,
} from "@/lib/data/orders-approval";

function known(code: string, meta?: Record<string, unknown>): Prisma.PrismaClientKnownRequestError {
    return new Prisma.PrismaClientKnownRequestError("tx", { code, clientVersion: "test", meta });
}

const noSleep = async () => { };
/** The same predicate the approve route uses. */
const isFatal = (e: unknown) => e instanceof ApprovalDomainError || e instanceof z.ZodError || e instanceof MoneyError;

describe("tx-retry — classification matches T4c sync", () => {
    it("retries P2034 / P2024 / P1001 / P1002 / P1008 / P1017 by code", () => {
        for (const code of ["P2034", "P2024", "P1001", "P1002", "P1008", "P1017"]) {
            expect(isRetryableTxError(known(code)), code).toBe(true);
        }
    });

    it("retries P2028 (interactive transaction timeout); only P2028 is a timeout error", () => {
        expect(isRetryableTxError(known("P2028"))).toBe(true);
        expect(isTransactionTimeoutError(known("P2028"))).toBe(true);
        expect(isTransactionTimeoutError(known("P2034"))).toBe(false);
        expect(isTransactionTimeoutError(new Error("P2028"))).toBe(false);
        expect(TX_TIMEOUT_MAX_ATTEMPTS).toBe(2);
        expect(TX_MAX_ATTEMPTS).toBe(3);
    });

    it("P2010 retries ONLY on SQLSTATE 40001/40P01 in meta.code", () => {
        expect(isRetryableTxError(known("P2010", { code: "40001" }))).toBe(true);
        expect(isRetryableTxError(known("P2010", { code: "40P01" }))).toBe(true);
        expect(isRetryableTxError(known("P2010", { code: "23505" }))).toBe(false);
        expect(isRetryableTxError(known("P2010"))).toBe(false);
    });

    it("a validation message containing 140001.0000 is NOT retryable", () => {
        expect(isRetryableTxError(new Error("total (140001.0000) mismatch"))).toBe(false);
        expect(isRetryableTxError(new Error("amount 40001 invalid"))).toBe(false);
    });

    it("retries PrismaClientInitializationError and the unambiguous phrases", () => {
        expect(isRetryableTxError(new Prisma.PrismaClientInitializationError("down", "test"))).toBe(true);
        for (const m of [
            "deadlock detected",
            "could not serialize access",
            "Server has closed the connection",
            "connection terminated unexpectedly",
            "Can't reach database server",
            "Timed out fetching a new connection from the pool",
        ]) {
            expect(isRetryableTxError(new Error(m)), m).toBe(true);
        }
    });

    it("non-transient errors are not retryable", () => {
        expect(isRetryableTxError(known("P2002"))).toBe(false);
        expect(isRetryableTxError(known("P2025"))).toBe(false);
        expect(isRetryableTxError(new Error("plain boom"))).toBe(false);
    });
});

describe("tx-retry — runner", () => {
    it("retries a transient failure then succeeds", async () => {
        let calls = 0;
        const out = await withTxRetries(
            async () => {
                calls++;
                if (calls === 1) throw known("P2034");
                return "ok";
            },
            { sleep: noSleep }
        );
        expect(out).toBe("ok");
        expect(calls).toBe(2);
    });

    it("pauses between attempts only (jittered 100-300ms), never after the final failure or for fatal errors", async () => {
        const sleeps: number[] = [];
        const sleep = async (ms: number) => {
            sleeps.push(ms);
        };
        let calls = 0;
        await expect(
            withTxRetries(
                async () => {
                    calls++;
                    throw known("P2034");
                },
                { sleep }
            )
        ).rejects.toMatchObject({ code: "P2034" });
        expect(calls).toBe(3);
        expect(sleeps).toHaveLength(2);
        expect(sleeps.every((ms) => ms >= 100 && ms < 300)).toBe(true);

        sleeps.length = 0;
        const fatal = new ApprovalAlreadyReviewedError();
        await expect(
            withTxRetries(
                async () => {
                    throw fatal;
                },
                { sleep, isFatal }
            )
        ).rejects.toBe(fatal);
        expect(sleeps).toHaveLength(0);
    });

    it("P2028 is tolerated at most TWICE in total (the second one is rethrown)", async () => {
        let calls = 0;
        await expect(
            withTxRetries(
                async () => {
                    calls++;
                    throw known("P2028");
                },
                { maxAttempts: 5, sleep: noSleep }
            )
        ).rejects.toMatchObject({ code: "P2028" });
        expect(calls).toBe(2);
    });

    it("a P2034 followed by a P2028 still gets another attempt (only P2028 failures count against the P2028 cap)", async () => {
        const errors = [known("P2034"), known("P2028")];
        let calls = 0;
        const out = await withTxRetries(
            async () => {
                calls++;
                const e = errors.shift();
                if (e) throw e;
                return "ok";
            },
            { sleep: noSleep }
        );
        expect(out).toBe("ok");
        expect(calls).toBe(3);
    });

    it("P2028 then P2034 then P2028 stops at the second P2028 (third attempt)", async () => {
        const errors = [known("P2028"), known("P2034"), known("P2028")];
        let calls = 0;
        await expect(
            withTxRetries(
                async () => {
                    calls++;
                    throw errors.shift();
                },
                { sleep: noSleep }
            )
        ).rejects.toMatchObject({ code: "P2028" });
        expect(calls).toBe(3);
    });

    it("every Approval* error (via the base class), ZodError and MoneyError is never retried", async () => {
        const fatals: unknown[] = [
            new ApprovalOrderNotFoundError(),
            new ApprovalAlreadyReviewedError(),
            new ApprovalInsufficientStockError([]),
            new ApprovalProductInactiveError("i", "p"),
            new ApprovalRateRequiredError(),
            new ApprovalInvalidCustomerError(),
            new ApprovalInvalidPaymentError(),
            new ApprovalValidationError(),
            new z.ZodError([]),
            new MoneyError("bad"),
        ];
        for (const fatal of fatals) {
            let calls = 0;
            await expect(
                withTxRetries(
                    async () => {
                        calls++;
                        throw fatal;
                    },
                    { isFatal, sleep: noSleep }
                )
            ).rejects.toBe(fatal);
            expect(calls).toBe(1);
        }
    });

    it("a non-fatal unknown error still throws without retry", async () => {
        const fn = vi.fn(async () => {
            throw new Error("plain boom");
        });
        await expect(withTxRetries(fn, { sleep: noSleep })).rejects.toThrow("plain boom");
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it("maxAttempts <= 0 still runs once instead of throwing undefined", async () => {
        let calls = 0;
        await expect(
            withTxRetries(
                async () => {
                    calls++;
                    throw known("P2034");
                },
                { maxAttempts: 0, sleep: noSleep }
            )
        ).rejects.toMatchObject({ code: "P2034" });
        expect(calls).toBe(1);
    });
});