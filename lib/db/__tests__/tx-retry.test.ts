/**
 * lib/db/__tests__/tx-retry.test.ts
 *
 * T5c Phase 3 — shared transient-transaction classifier + retry runner.
 *
 * REAL: lib/db/tx-retry.ts. MOCKED: nothing (pure predicates + a counter
 * closure for the runner). Never touches a database.
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

describe("tx-retry — classification matches T4c sync", () => {
    it("retries P2034/P1001/P1002/P1008/P1017", () => {
        for (const code of ["P2034", "P1001", "P1002", "P1008", "P1017"]) {
            expect(isRetryableTxError(known(code)), code).toBe(true);
        }
    });
    it("retries P2028 (transaction timeout, capped at 2)", () => {
        expect(isRetryableTxError(known("P2028"))).toBe(true);
        expect(isTransactionTimeoutError(known("P2028"))).toBe(true);
        expect(isTransactionTimeoutError(known("P2034"))).toBe(false);
        expect(TX_TIMEOUT_MAX_ATTEMPTS).toBe(2);
        expect(TX_MAX_ATTEMPTS).toBe(3);
    });
    it("P2010 retries ONLY on SQLSTATE 40001/40P01 in meta.code", () => {
        expect(isRetryableTxError(known("P2010", { code: "40001" }))).toBe(true);
        expect(isRetryableTxError(known("P2010", { code: "40P01" }))).toBe(true);
        expect(isRetryableTxError(known("P2010", { code: "23505" }))).toBe(false);
        expect(isRetryableTxError(known("P2010"))).toBe(false);
    });
    it("a validation message containing 140001.0000 is NOT retryable (v4.9 FIX 8)", () => {
        expect(isRetryableTxError(new Error("total (140001.0000) mismatch"))).toBe(false);
        expect(isRetryableTxError(new Error("amount 40001 invalid"))).toBe(false);
    });
    it("retries PrismaClientInitializationError + unambiguous phrases", () => {
        expect(isRetryableTxError(new Prisma.PrismaClientInitializationError("down", "test"))).toBe(true);
        expect(isRetryableTxError(new Error("deadlock detected"))).toBe(true);
        expect(isRetryableTxError(new Error("could not serialize access"))).toBe(true);
        expect(isRetryableTxError(new Error("Server has closed the connection"))).toBe(true);
    });
    it("non-transient codes are not retryable", () => {
        expect(isRetryableTxError(known("P2002"))).toBe(false);
        expect(isRetryableTxError(known("P2025"))).toBe(false);
        expect(isRetryableTxError(new Error("plain boom"))).toBe(false);
    });
});

describe("tx-retry — runner retries transient, never domain", () => {
    it("retries a transient failure then succeeds", async () => {
        let calls = 0;
        const out = await withTxRetries(async () => {
            calls++;
            if (calls === 1) throw known("P2034");
            return "ok";
        });
        expect(out).toBe("ok");
        expect(calls).toBe(2);
    });
    it("P2028 throws after 2 attempts (not 3)", async () => {
        let calls = 0;
        await expect(
            withTxRetries(
                async () => {
                    calls++;
                    throw known("P2028");
                },
                { maxAttempts: 5 }
            )
        ).rejects.toMatchObject({ code: "P2028" });
        expect(calls).toBe(2);
    });
    it("every Approval* + ZodError + MoneyError is never retried", async () => {
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
            const isFatal = (e: unknown) => e === fatal;
            await expect(
                withTxRetries(
                    async () => {
                        calls++;
                        throw fatal;
                    },
                    { isFatal }
                )
            ).rejects.toBe(fatal);
            expect(calls).toBe(1);
        }
    });
    it("a non-fatal unknown error still throws without retry", async () => {
        const fn = vi.fn(async () => {
            throw new Error("plain boom");
        });
        await expect(withTxRetries(fn)).rejects.toThrow("plain boom");
        expect(fn).toHaveBeenCalledTimes(1);
    });
});

const noSleep = async () => { };

it("pauses between attempts, but not after the final failure or for fatal errors", async () => {
    const sleeps: number[] = [];
    const sleep = async (ms: number) => { sleeps.push(ms); };
    let calls = 0;
    await expect(
        withTxRetries(async () => { calls++; throw known("P2034"); }, { sleep })
    ).rejects.toMatchObject({ code: "P2034" });
    expect(calls).toBe(3);
    expect(sleeps).toHaveLength(2);                    // between attempts only
    expect(sleeps.every((ms) => ms >= 100 && ms < 300)).toBe(true);

    sleeps.length = 0;
    const fatal = new Error("domain");
    await expect(
        withTxRetries(async () => { throw fatal; }, { sleep, isFatal: (e) => e === fatal })
    ).rejects.toBe(fatal);
    expect(sleeps).toHaveLength(0);                    // fatal: no pause, no retry
});

it("maxAttempts <= 0 still runs once instead of throwing undefined", async () => {
    let calls = 0;
    await expect(
        withTxRetries(async () => { calls++; throw known("P2034"); }, { maxAttempts: 0, sleep: noSleep })
    ).rejects.toMatchObject({ code: "P2034" });
    expect(calls).toBe(1);
});

it("P2024 is retryable by code", () => {
    expect(isRetryableTxError(known("P2024"))).toBe(true);
});