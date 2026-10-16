/**
 * lib/data/__tests__/t5c-orders-approval.real.test.ts
 *
 * T5c — REAL-DATABASE concurrency tests: a GATED PLACEHOLDER (one trivial
 * assertion). The cases below are the PLAN, not implemented tests.
 *
 * This file is gated on TEST_DATABASE_URL and SKIPPED when absent:
 *   describe.skipIf(!process.env.TEST_DATABASE_URL)(...)
 * It NEVER reads DATABASE_URL. TEST_DATABASE_URL must point to a DISPOSABLE
 * test branch only (never production, never the dev database). Do NOT run it
 * without explicit owner approval, and never against a database that holds
 * real merchant data.
 *
 * What the mock suite cannot prove (stated honestly): real FOR UPDATE row-lock
 * serialization, real database atomicity under true concurrency, the native
 * INSERT ... ON CONFLICT upsert compiling to ON CONFLICT, and the 20-second
 * transaction timeout under real latency.
 *
 * Planned real-DB cases (each approval is one $transaction):
 *  1. Two simultaneous approvals of one PENDING_REVIEW order -> exactly one
 *     Invoice + one deduction per line; the loser gets ALREADY_REVIEWED (or the
 *     idempotent success when its request is identical) with zero extra effects.
 *  2. Approval racing reject (both directions) -> exactly one wins; the loser
 *     gets ALREADY_REVIEWED.
 *  3. Two concurrent first-approvals for the same retailer phone from two
 *     wholesalers -> one VerifiedRetailer row with verificationCount 2 and no
 *     aborted transaction (native-upsert proof).
 *  4. Oversell race on one batch -> no batch ever ends negative; the loser gets
 *     INSUFFICIENT_STOCK with per-line details.
 *  5. Approval racing a POS sync on the same batches -> no deadlock, no
 *     negative quantity produced by the approval.
 *  6. A 50-line order with FIFO splits against the real 20s timeout.
 */
import { describe, it, expect } from "vitest";

const hasTestDb = Boolean(process.env.TEST_DATABASE_URL);

describe.skipIf(!hasTestDb)("T5c approval — real-database concurrency (gated PLACEHOLDER)", () => {
    it("placeholder: requires TEST_DATABASE_URL (disposable branch only)", () => {
        expect(process.env.TEST_DATABASE_URL).toBeTruthy();
    });
});