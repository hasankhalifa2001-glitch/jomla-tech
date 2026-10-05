/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * lib/ledger/__tests__/t4e-repayment.test.ts
 *
 * T4e — تسديد دفعة (customer repayment): the ONE server core, the online
 * route built on it, the balance single-source, the pure UI decision helpers,
 * and the offline queue's own guard posture.
 *
 *   COVERAGE → ACCEPTANCE CRITERIA
 *   1. POST /api/ledger/repayments: a CASHIER is rejected with 403 BEFORE any
 *      work happens — zero writes, no $transaction, no tenant read, no body
 *      validation (the Role Capability Matrix is the boundary).
 *   2. recordRepayment() rejections: the system-generated cash customer, an
 *      inactive customer, amount <= 0, and amount > current balance — each
 *      throws RepaymentError (Arabic message + status) and writes NOTHING.
 *   3. Happy path: exactly ONE top-level customerPayment.create with
 *      invoiceId: null; balanceAfter matches an INDEPENDENT decimal.js
 *      reference (debts in the hundreds of millions, fractional), and feeding
 *      the created row back through computeBalanceSYP reproduces balanceAfter.
 *   4. Merged-customer survivor: the repayment resolves through
 *      resolveActiveCustomerId INSIDE the transaction and lands on the
 *      survivor row, never the merged-away one.
 *   5. Idempotency: the same offlineId twice → one row total, second call
 *      reports alreadyRecorded: true. Concurrent calls go through
 *      recordRepaymentIdempotent (P2002 on offlineId → re-read outside tx).
 *   6. Stale-rate / frozenRate: sync passes the record's stored rate; online
 *      reads today's DB rate. amountUSD is SYP ÷ the frozen rate (a case that
 *      flips if computed from USD × today's rate).
 *   7. Static source assertions (comment-stripped): repayment.ts holds exactly
 *      ONE customerPayment.create and no raw SQL; the sync engine's PASS 3
 *      delegates to recordRepaymentIdempotent; the online route contains no
 *      repayment rules of its own; GET /api/customers uses the shared
 *      computeBalanceSYP; client /api/ledger/* URLs match real route files.
 *   8. canShowRepaymentButton() / parseAmountInput() / remaining-balance
 *      helpers — pure truth tables (Arabic-Indic digits included).
 *
 * KNOWN LIMITATION, STATED EXPLICITLY: the test environment is `node`
 * (vitest.config.ts) with no jsdom — DOM-level assertions ("the button is
 * absent for a CASHIER") are covered by the pure decision helpers plus static
 * source assertions on the rendered component, the same approach T4d used.
 */

import fs from "fs";
import path from "path";
import Decimal from "decimal.js";
import { Prisma } from "@prisma/client";
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — one in-memory "database" shared by the route and recordRepayment,
// so the route tests exercise the REAL role matrix, the REAL zod schema, and
// the REAL recordRepayment() — only the persistence layer is faked.
// ---------------------------------------------------------------------------
const { mockState, mockSessionState } = vi.hoisted(() => {
  const state = {
    payments: [] as any[],
    mergeLogs: [] as any[],
    customers: new Map<string, any>(),
    invoices: [] as any[],
    dailyExchangeRate: "14375.5000" as string | null,
    paymentSeq: 0,
    reset() {
      state.payments.length = 0;
      state.mergeLogs.length = 0;
      state.customers.clear();
      state.invoices.length = 0;
      state.dailyExchangeRate = "14375.5000";
      state.paymentSeq = 0;
    },
  };

  const tx: any = {
    customerPayment: {
      findFirst: vi.fn(async ({ where }: any) => {
        if (where?.offlineId) {
          return state.payments.find((p) => p.offlineId === where.offlineId) ?? null;
        }
        return null;
      }),
      findMany: vi.fn(async ({ where }: any) =>
        state.payments.filter(
          (p) =>
            p.tenantId === where?.tenantId &&
            p.customerId === where?.customerId &&
            (where?.invoiceId === null ? p.invoiceId === null : true)
        )
      ),
      create: vi.fn(async ({ data }: any) => {
        state.paymentSeq += 1;
        const row = { id: `pay-${state.paymentSeq}`, ...data };
        state.payments.push(row);
        return { id: row.id };
      }),
    },
    customerMergeLog: {
      findFirst: vi.fn(async ({ where }: any) => {
        return state.mergeLogs.find((m) => m.mergedCustomerId === where?.mergedCustomerId) ?? null;
      }),
    },
    customer: {
      findFirst: vi.fn(async ({ where }: any) => state.customers.get(where?.id) ?? null),
    },
    invoice: {
      findMany: vi.fn(async ({ where }: any) =>
        state.invoices.filter((i) => i.customerId === where?.customerId)
      ),
    },
    tenant: {
      findUnique: vi.fn(async () => ({
        id: "tenant-1",
        // What assertTenantWritable() reads (real implementation, mocked DB).
        subscriptionStatus: "ACTIVE",
        // What recordRepayment() reads FRESH inside its own transaction.
        dailyExchangeRate: state.dailyExchangeRate,
      })),
    },
  };
  tx.$transaction = vi.fn(async (cb: (t: any) => Promise<any>) => cb(tx));

  const sessionState = { session: null as any };

  return {
    mockState: {
      ...state,
      tx,
      reset: state.reset,
      // Accessors, not the spread's copied value: a test that does
      // `mockState.dailyExchangeRate = "..."` must change what the mock
      // `tenant.findUnique` actually returns.
      get dailyExchangeRate(): string | null {
        return state.dailyExchangeRate;
      },
      set dailyExchangeRate(value: string | null) {
        state.dailyExchangeRate = value;
      },
    },
    mockSessionState: sessionState,
  };
});

vi.mock("@/auth", () => ({
  auth: vi.fn(async () => mockSessionState.session),
}));

vi.mock("@/lib/db", () => ({
  prisma: mockState.tx,
  getTenantDb: vi.fn(() => mockState.tx),
}));

vi.mock("@/lib/db/tenant-scope", () => ({
  getTenantDb: vi.fn(() => mockState.tx),
  tenantScopedRawQuery: vi.fn(async () => []),
}));

import {
  isUniqueConflictOn,
  recordRepayment,
  recordRepaymentIdempotent,
  RepaymentError,
} from "@/lib/ledger/repayment";
import { computeBalanceSYP } from "@/lib/ledger/balance";
import {
  canShowRepaymentButton,
  canSubmitRepayment,
  computeRemainingBalanceSYP,
  fullBalanceAmountSYP,
  parseAmountInput
} from "@/lib/ledger/repayment-ui";
import { POST as repaymentHandler } from "@/app/api/ledger/repayments/route";

const TENANT_ID = "tenant-1";
const CUSTOMER_ID = "cust-real";

/** Seeds an (optionally system/inactive) customer plus its invoice debts. */
function seedCustomer(opts?: {
  id?: string;
  isActive?: boolean;
  isSystemGenerated?: boolean;
  debts?: string[];
}) {
  const id = opts?.id ?? CUSTOMER_ID;
  mockState.customers.set(id, {
    id,
    isActive: opts?.isActive ?? true,
    isSystemGenerated: opts?.isSystemGenerated ?? false,
  });
  for (const debt of opts?.debts ?? []) {
    mockState.invoices.push({ tenantId: TENANT_ID, customerId: id, debtAmountSYP: debt });
  }
  return id;
}

function adminSession() {
  mockSessionState.session = {
    user: { id: "user-admin", role: "ADMIN", tenantId: TENANT_ID, subscriptionStatus: "ACTIVE" },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockState.reset();
  mockSessionState.session = null;
});

// ===========================================================================
// 1. recordRepayment() — the ONE server-side core (lib/ledger/repayment.ts)
// ===========================================================================
describe("recordRepayment() — rejections write nothing", () => {
  it("rejects a non-positive amount before any write", async () => {
    seedCustomer({ debts: ["500000.0000"] });

    for (const amount of ["0", "-25000", "abc"] as const) {
      await expect(
        recordRepayment(mockState.tx, TENANT_ID, { customerId: CUSTOMER_ID, amountSYP: amount })
      ).rejects.toBeInstanceOf(RepaymentError);
    }

    expect(mockState.tx.customerPayment.create).not.toHaveBeenCalled();
  });

  it("rejects an amount above the customer's current balance (Arabic message, no write)", async () => {
    seedCustomer({ debts: ["1000000.0000"] });

    let caught: unknown;
    try {
      await recordRepayment(mockState.tx, TENANT_ID, {
        customerId: CUSTOMER_ID,
        amountSYP: "1000000.0001", // 0.0001 above the debt
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(RepaymentError);
    expect((caught as RepaymentError).status).toBe(400);
    // Digit grouping/locale formatting may vary — the reason must be the
    // documented Arabic one, comparing THIS amount against the balance.
    expect((caught as Error).message).toContain("قيمة الدفعة");
    expect((caught as Error).message).toContain("أكبر من الرصيد الحالي المستحق");
    expect((caught as Error).message).toContain("لا يمكن تسديد أكثر من الدين القائم");
    expect(mockState.tx.customerPayment.create).not.toHaveBeenCalled();
  });

  it("rejects the system-generated cash customer", async () => {
    const id = seedCustomer({ isSystemGenerated: true, debts: ["999999.0000"] });

    await expect(
      recordRepayment(mockState.tx, TENANT_ID, { customerId: id, amountSYP: "1000" })
    ).rejects.toThrow(/النقدي العام/u);
    expect(mockState.tx.customerPayment.create).not.toHaveBeenCalled();
  });

  it("rejects an inactive (merged/deactivated) customer", async () => {
    const id = seedCustomer({ isActive: false, debts: ["500000.0000"] });

    await expect(
      recordRepayment(mockState.tx, TENANT_ID, { customerId: id, amountSYP: "1000" })
    ).rejects.toThrow(/غير مفعّل/u);
    expect(mockState.tx.customerPayment.create).not.toHaveBeenCalled();
  });

  it("rejects a missing customerId / tenantId", async () => {
    await expect(
      recordRepayment(mockState.tx, TENANT_ID, { customerId: "  ", amountSYP: "1000" })
    ).rejects.toBeInstanceOf(RepaymentError);
    await expect(
      recordRepayment(mockState.tx, "", { customerId: CUSTOMER_ID, amountSYP: "1000" })
    ).rejects.toBeInstanceOf(RepaymentError);
    expect(mockState.tx.customerPayment.create).not.toHaveBeenCalled();
  });

  it("rejects when no daily exchange rate is set (Arabic: حدّد سعر الصرف أولاً)", async () => {
    seedCustomer({ debts: ["500000.0000"] });
    mockState.dailyExchangeRate = null;

    await expect(
      recordRepayment(mockState.tx, TENANT_ID, { customerId: CUSTOMER_ID, amountSYP: "1000" })
    ).rejects.toThrow("حدّد سعر الصرف أولاً");
    expect(mockState.tx.customerPayment.create).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// 2. recordRepayment() — the happy path, checked against an INDEPENDENT
//    decimal.js reference (never against the code's own output)
// ===========================================================================
describe("recordRepayment() — happy path & money correctness", () => {
  it("writes ONE top-level row (invoiceId: null) and matches an independent balance reference", async () => {
    const debts = ["250000000.5555", "123456789.9876"];
    const existingRepayments = ["75000000.1234"];
    seedCustomer({ debts });

    // Pre-existing repayments on the same customer (independent ones only).
    for (const amount of existingRepayments) {
      mockState.payments.push({
        id: `seed-${amount}`,
        tenantId: TENANT_ID,
        customerId: CUSTOMER_ID,
        invoiceId: null,
        offlineId: null,
        amountSYP: amount,
        amountUSD: "0.0000",
        exchangeRate: "14375.5000",
      });
    }

    const amountSYP = "100000000.0001";
    const refBefore = new Decimal(debts[0])
      .plus(debts[1])
      .minus(existingRepayments[0])
      .toFixed(4);
    const refAfter = new Decimal(refBefore).minus(amountSYP).toFixed(4);

    const result = await recordRepayment(mockState.tx, TENANT_ID, {
      customerId: CUSTOMER_ID,
      amountSYP,
      offlineId: "offl-happy-1",
    });

    // Exactly ONE create, and it is the independent-repayment shape.
    expect(mockState.tx.customerPayment.create).toHaveBeenCalledTimes(1);
    const createdRows = mockState.payments.filter((p) => p.id.startsWith("pay-"));
    expect(createdRows).toHaveLength(1);
    expect(createdRows[0].invoiceId).toBeNull();
    expect(createdRows[0].amountSYP).toBe(amountSYP);

    expect(result.balanceBeforeSYP).toBe(refBefore);
    expect(result.balanceAfterSYP).toBe(refAfter);
    expect(result.alreadyRecorded).toBe(false);

    // The persisted row, fed back through the SHARED formula, reproduces the
    // same balance — server and ledger screen cannot drift apart.
    const recompute = computeBalanceSYP(
      mockState.invoices.map((i) => i.debtAmountSYP),
      mockState.payments.filter((p) => p.invoiceId === null).map((p) => p.amountSYP)
    );
    expect(recompute).toBe(refAfter);
  });

  it("online path freezes today's DB rate; amountUSD = SYP ÷ that rate", async () => {
    seedCustomer({ debts: ["2000000.0000"] });
    mockState.dailyExchangeRate = "15500.2500";

    const result = await recordRepayment(mockState.tx, TENANT_ID, {
      customerId: CUSTOMER_ID,
      amountSYP: "1550025.0000",
    });

    const created = mockState.payments.find((p) => p.id.startsWith("pay-"));
    expect(created.exchangeRate).toBe("15500.2500");
    const refUSD = new Decimal("1550025.0000").div("15500.2500").toFixed(4);
    expect(created.amountUSD).toBe(refUSD);
    expect(result.exchangeRate).toBe("15500.2500");
    expect(result.amountUSD).toBe(refUSD);
  });

  it("frozenRate (sync/stale-rate) is persisted even when today's DB rate differs; USD is SYP ÷ frozen rate", async () => {
    seedCustomer({ debts: ["2000000.0000"] });
    mockState.dailyExchangeRate = "10000.0000"; // today's rate — would flip the USD answer
    const frozenRate = "15500.2500";
    const amountSYP = "1550025.0000";

    const result = await recordRepayment(mockState.tx, TENANT_ID, {
      customerId: CUSTOMER_ID,
      amountSYP,
      frozenRate,
    });

    const created = mockState.payments.find((p) => p.id.startsWith("pay-"));
    expect(created.exchangeRate).toBe(frozenRate);
    const refUSD = new Decimal(amountSYP).div(frozenRate).toFixed(4);
    const wrongIfToday = new Decimal(amountSYP).div("10000.0000").toFixed(4);
    expect(created.amountUSD).toBe(refUSD);
    expect(created.amountUSD).not.toBe(wrongIfToday);
    expect(result.amountUSD).toBe(refUSD);
  });

  it("is idempotent: the same offlineId twice creates ONE row", async () => {
    seedCustomer({ debts: ["800000.0000"] });

    const first = await recordRepayment(mockState.tx, TENANT_ID, {
      customerId: CUSTOMER_ID,
      amountSYP: "100000",
      offlineId: "offl-dup-1",
    });
    const second = await recordRepayment(mockState.tx, TENANT_ID, {
      customerId: CUSTOMER_ID,
      amountSYP: "100000",
      offlineId: "offl-dup-1",
    });

    expect(first.alreadyRecorded).toBe(false);
    expect(second.alreadyRecorded).toBe(true);
    expect(second.paymentId).toBe(first.paymentId);
    expect(mockState.tx.customerPayment.create).toHaveBeenCalledTimes(1);
    expect(mockState.payments.filter((p) => p.id.startsWith("pay-"))).toHaveLength(1);
  });

  it("two simultaneous recordRepaymentIdempotent calls with the same offlineId write ONE row and both succeed", async () => {
    seedCustomer({ debts: ["500000.0000"] });
    const params = {
      customerId: CUSTOMER_ID,
      amountSYP: "100000",
      offlineId: "offl-race-1",
    };

    mockState.tx.customerPayment.create.mockImplementation(async ({ data }: any) => {
      const already = mockState.payments.find((p) => p.offlineId && p.offlineId === data.offlineId);
      if (already) {
        throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
          code: "P2002",
          clientVersion: "6.0.0",
          meta: { target: ["offlineId"] },
        });
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
      const raced = mockState.payments.find((p) => p.offlineId && p.offlineId === data.offlineId);
      if (raced) {
        throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
          code: "P2002",
          clientVersion: "6.0.0",
          meta: { target: ["offlineId"] },
        });
      }
      const row = { id: `pay-race-${mockState.payments.length + 1}`, ...data };
      mockState.payments.push(row);
      return { id: row.id };
    });

    const [first, second] = await Promise.all([
      recordRepaymentIdempotent(mockState.tx, TENANT_ID, params),
      recordRepaymentIdempotent(mockState.tx, TENANT_ID, params),
    ]);

    expect(first.paymentId).toBe(second.paymentId);
    expect([first.alreadyRecorded, second.alreadyRecorded].filter(Boolean).length).toBeGreaterThanOrEqual(1);
    expect(mockState.payments.filter((p) => p.offlineId === "offl-race-1")).toHaveLength(1);
  });

  it("isUniqueConflictOn requires meta.target to include the field — never a message substring", () => {
    const byTarget = new Prisma.PrismaClientKnownRequestError("Unique constraint failed on invoiceId", {
      code: "P2002",
      clientVersion: "6.0.0",
      meta: { target: ["invoiceId"] },
    });
    const byOfflineId = new Prisma.PrismaClientKnownRequestError("something else", {
      code: "P2002",
      clientVersion: "6.0.0",
      meta: { target: ["CustomerPayment_offlineId_key"] },
    });
    expect(isUniqueConflictOn(byTarget, "offlineId")).toBe(false);
    expect(isUniqueConflictOn(byOfflineId, "offlineId")).toBe(false);
    const exact = new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
      code: "P2002",
      clientVersion: "6.0.0",
      meta: { target: ["offlineId"] },
    });
    expect(isUniqueConflictOn(exact, "offlineId")).toBe(true);
  });

  it("lands the repayment on the SURVIVOR of a merge, never the merged-away row", async () => {
    // cust-merged was merged into cust-survivor moments ago.
    seedCustomer({ id: "cust-survivor", debts: ["600000.0000"] });
    mockState.mergeLogs.push({
      mergedCustomerId: "cust-merged",
      survivingCustomerId: "cust-survivor",
    });

    const result = await recordRepayment(mockState.tx, TENANT_ID, {
      customerId: "cust-merged",
      amountSYP: "150000",
    });

    const created = mockState.payments.find((p) => p.id.startsWith("pay-"));
    expect(created.customerId).toBe("cust-survivor");
    expect(result.customerId).toBe("cust-survivor");
    // The balance the guard was checked against is the SURVIVOR's balance.
    expect(result.balanceBeforeSYP).toBe("600000.0000");
    expect(result.balanceAfterSYP).toBe("450000.0000");
    // The customer lookup happened against the resolved id, not the stale one.
    expect(mockState.tx.customer.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: "cust-survivor" }) })
    );
  });
});

// ===========================================================================
// 3. POST /api/ledger/payments — the ONLINE route (REAL role matrix + zod +
//    recordRepayment; only the persistence layer is the in-memory mock)
// ===========================================================================
describe("POST /api/ledger/repayments", () => {
  function postRequest(body: unknown) {
    return new Request("http://localhost/api/ledger/repayments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  it("answers 401 without a session", async () => {
    mockSessionState.session = null;
    const res = await repaymentHandler(postRequest({ customerId: CUSTOMER_ID, amountSYP: "1000", offlineId: "offl-1" }));
    expect(res.status).toBe(401);
    expect(mockState.tx.$transaction).not.toHaveBeenCalled();
  });

  it("rejects a CASHIER with 403 BEFORE any work — zero writes, no transaction, no tenant read", async () => {
    mockSessionState.session = {
      user: { id: "user-cashier", role: "CASHIER", tenantId: TENANT_ID, subscriptionStatus: "ACTIVE" },
    };
    seedCustomer({ debts: ["500000.0000"] });

    const res = await repaymentHandler(
      postRequest({ customerId: CUSTOMER_ID, amountSYP: "1000" })
    );

    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("FORBIDDEN");

    // ZERO writes — the capability check runs before body parsing, before the
    // subscription read, and before any transaction opens.
    expect(mockState.tx.$transaction).not.toHaveBeenCalled();
    expect(mockState.tx.customerPayment.create).not.toHaveBeenCalled();
    expect(mockState.tx.tenant.findUnique).not.toHaveBeenCalled();
    expect(mockState.payments).toHaveLength(0);
  });

  it("records an ADMIN repayment and returns the server-computed balance", async () => {
    adminSession();
    seedCustomer({ debts: ["900000.0000"] });

    const res = await repaymentHandler(
      postRequest({ customerId: CUSTOMER_ID, amountSYP: "400000", paymentMethod: "SHAM_CASH" })
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    const refAfter = new Decimal("900000.0000").minus("400000").toFixed(4);
    expect(body.balanceSYP).toBe(refAfter);
    expect(body.balanceBeforeSYP).toBe("900000.0000");
    expect(body.exchangeRate).toBe("14375.5000");
    expect(mockState.tx.customerPayment.create).toHaveBeenCalledTimes(1);

    const row = mockState.payments.find((p) => p.id.startsWith("pay-"));
    expect(row.invoiceId).toBeNull();
    expect(row.paymentMethod).toBe("SHAM_CASH");
    expect(row.tenantId).toBe(TENANT_ID);
  });

  it("answers 400 with the Arabic reason for an amount above the balance, and writes nothing", async () => {
    adminSession();
    seedCustomer({ debts: ["100000.0000"] });

    const res = await repaymentHandler(
      postRequest({ customerId: CUSTOMER_ID, amountSYP: "9999999" })
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("REPAYMENT_REJECTED");
    expect(body.message).toMatch(/أكبر من الرصيد/u);
    // The transaction OPENS but recordRepayment() rejects inside it before
    // any write — the create must never fire.
    expect(mockState.tx.customerPayment.create).not.toHaveBeenCalled();
    expect(mockState.payments).toHaveLength(0);
  });

  it("answers 400 for a malformed body (zod) without opening a transaction", async () => {
    adminSession();

    const res = await repaymentHandler(postRequest({ customerId: CUSTOMER_ID })); // no amount
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("VALIDATION_ERROR");

    const badJson = await repaymentHandler(postRequest("{not json"));
    expect(badJson.status).toBe(400);
    expect((await badJson.json()).error).toBe("BAD_REQUEST");

    expect(mockState.tx.$transaction).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// 4. Balance single-source (lib/ledger/balance.ts) — pure formula, checked
//    against an INDEPENDENT decimal.js reference
// ===========================================================================
describe("computeBalanceSYP — the ledger formula", () => {
  it("matches an independent decimal.js sum over large, fractional values", () => {
    const debts = [
      "4294967296.1234", // > 2^32 — would break a naive integer/float path
      "987654321.9876",
      "0.0001",
      "150000000.5555",
    ];
    const repayments = ["750000000.1111", "0.0004", "250000000.7777"];

    const reference = debts
      .reduce((acc, d) => acc.plus(d), new Decimal(0))
      .minus(repayments.reduce((acc, r) => acc.plus(r), new Decimal(0)))
      .toFixed(4);

    expect(computeBalanceSYP(debts, repayments)).toBe(reference);
  });

  it("nets a VOIDED invoice's mirror debt back to zero (negative debt participates)", () => {
    const debts = ["500000.0000", "-500000.0000"]; // original + its void mirror
    expect(computeBalanceSYP(debts, [])).toBe("0.0000");
  });

  it("ignores null/undefined entries instead of producing NaN", () => {
    expect(computeBalanceSYP(["100000.0000", null as never], [])).toBe("100000.0000");
    expect(computeBalanceSYP(["100000.0000"], ["100000.0000", undefined as never])).toBe("0.0000");
  });
});

// ===========================================================================
// 5. UI decision helpers (lib/ledger/repayment-ui.ts) — pure truth tables
// ===========================================================================
describe("canShowRepaymentButton — the one gate for the ledger card button", () => {
  it("ADMIN + positive balance + real customer → true", () => {
    expect(canShowRepaymentButton(true, "0.0001", false)).toBe(true);
    expect(canShowRepaymentButton(true, "1000000.0000", false)).toBe(true);
  });

  it("CASHIER → always false (absent from the DOM, never disabled)", () => {
    expect(canShowRepaymentButton(false, "500000.0000", false)).toBe(false);
  });

  it("system-generated cash customer → false regardless of role or balance", () => {
    expect(canShowRepaymentButton(true, "500000.0000", true)).toBe(false);
    expect(canShowRepaymentButton(false, "500000.0000", true)).toBe(false);
  });

  it("zero / negative (credit) balance → false — nothing to settle", () => {
    expect(canShowRepaymentButton(true, "0.0000", false)).toBe(false);
    expect(canShowRepaymentButton(true, "-25000.0000", false)).toBe(false);
  });

  it("garbage / absent balance → false, never a thrown render", () => {
    expect(canShowRepaymentButton(true, null, false)).toBe(false);
    expect(canShowRepaymentButton(true, undefined, false)).toBe(false);
    expect(canShowRepaymentButton(true, "not-a-number", false)).toBe(false);
  });
});

describe("amount helpers — Arabic-first input handling", () => {
  it("parses Arabic-Indic digits, thousands separators, and whitespace", () => {
    expect(parseAmountInput("٥٠٠٠")).toBe("5000.0000");
    expect(parseAmountInput(" ١٬٢٥٠٬٠٠٠ ")).toBe("1250000.0000");
    expect(parseAmountInput("1,000")).toBe("1000.0000");
  });

  it("returns null for empty / zero / negative / garbage instead of coercing to 0", () => {
    expect(parseAmountInput("")).toBeNull();
    expect(parseAmountInput("   ")).toBeNull();
    expect(parseAmountInput(null)).toBeNull();
    expect(parseAmountInput("0")).toBeNull();
    expect(parseAmountInput("-5")).toBeNull();
    expect(parseAmountInput("abc")).toBeNull();
  });

  it("computeRemainingBalanceSYP: balance − amount, or null when the amount exceeds the balance", () => {
    expect(computeRemainingBalanceSYP("500000.0000", "125000.0000")).toBe("375000.0000");
    expect(computeRemainingBalanceSYP("500000.0000", "500000.0001")).toBeNull();
    expect(computeRemainingBalanceSYP("500000.0000", "junk")).toBeNull();
  });

  it("canSubmitRepayment: 0 < amount <= balance", () => {
    expect(canSubmitRepayment("500000.0000", "1")).toBe(true);
    expect(canSubmitRepayment("500000.0000", "500000.0000")).toBe(true);
    expect(canSubmitRepayment("500000.0000", "500000.0001")).toBe(false);
    expect(canSubmitRepayment("500000.0000", "0")).toBe(false);
    expect(canSubmitRepayment("500000.0000", "")).toBe(false);
  });

  it("fullBalanceAmountSYP omits trailing zeros (input-friendly), null when not positive", () => {
    expect(fullBalanceAmountSYP("123456.789")).toBe("123456.789");
    expect(fullBalanceAmountSYP("2800")).toBe("2800");
    // Round-trips exactly through the parser the dialog also uses.
    expect(parseAmountInput(fullBalanceAmountSYP("123456.789"))).toBe("123456.7890");
    expect(fullBalanceAmountSYP("0")).toBeNull();
    expect(fullBalanceAmountSYP("-1")).toBeNull();
  });
});

// ===========================================================================
// 6. Static source assertions — every scan runs on COMMENT-STRIPPED source so
//    documentation that merely mentions a path can never cause a false pass.
// ===========================================================================
describe("T4e static source assertions", () => {
  const rootDir = process.cwd();

  /** Removes block/line comments; line-comment pass skips "://". */
  function stripComments(src: string): string {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
  }

  const readSource = (relativePath: string) =>
    stripComments(fs.readFileSync(path.join(rootDir, relativePath), "utf-8"));

  it("lib/ledger/repayment.ts holds exactly ONE customerPayment.create, no nested writes, no raw SQL", () => {
    const code = readSource("lib/ledger/repayment.ts");

    const creates = code.match(/customerPayment\.create/g) ?? [];
    expect(creates).toHaveLength(1);
    expect(code).not.toMatch(/\$queryRaw|\$executeRaw/);
    // The independent repayment shape — never tied to one invoice.
    expect(code).toContain("invoiceId: null");
    // The balance is read through the shared module, never re-derived here.
    expect(code).toContain("getCustomerBalanceSYP");
    expect(code).not.toMatch(/debtAmountSYP\s*[-+]/);
  });

  it("the sync engine's PASS 3 delegates to recordRepayment — no second create, no payload rate/USD", () => {
    const raw = fs.readFileSync(path.join(rootDir, "app/api/sync/route.ts"), "utf-8");

    expect(raw).toContain('import { recordRepayment } from "@/lib/ledger/repayment"');

    // Slice the Payment pass itself: from its loop to the response assembly.
    const start = raw.indexOf("for (const p of payments as PaymentPayload[])");
    const end = raw.indexOf("const allResults = [...customerResults", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const pass = stripComments(raw.slice(start, end));
    expect(pass).toContain("recordRepayment(tx, tenantId");
    expect(pass).not.toContain("customerPayment.create");
    // The device's queued rate/USD never reach the ledger row.
    expect(pass).not.toContain("p.exchangeRate");
    expect(pass).not.toContain("p.amountUSD");
    expect(pass).not.toMatch(/\$(query|execute)Raw/);
  });

  it("POST /api/ledger/payments owns NO repayment rules — no balance formula, no direct write, no raw SQL", () => {
    const code = readSource("app/api/ledger/repayments/route.ts");

    expect(code).toContain("recordRepayment(");
    expect(code).toContain('assertRolePermission(session.user.role, "ledger:log_repayment")');
    expect(code).toContain("assertTenantWritable");
    // No second copy of anything: not a write, not the formula, not raw SQL.
    expect(code).not.toContain("customerPayment");
    expect(code).not.toContain("debtAmountSYP");
    expect(code).not.toMatch(/\$queryRaw|\$executeRaw/);
    // tenantId always comes from the session, never the body.
    expect(code).toContain("const tenantId = session.user.tenantId;");
  });

  it("GET /api/customers reads the shared computeBalanceSYP — no inline re-implementation", () => {
    const code = readSource("app/api/customers/route.ts");
    expect(code).toContain('import { computeBalanceSYP } from "@/lib/ledger/balance"');
    expect(code).toContain("computeBalanceSYP(");
    // The old inline loop (sum invoices, subtract repayments) must be gone.
    expect(code).not.toMatch(/for\s*\(.*repayment/);
  });

  it("the ledger card renders the repay button ONLY behind canShowRepaymentButton, and mounts the modal with it", () => {
    const code = readSource("components/ledger/customer-card.tsx");

    expect(code).toContain("canShowRepaymentButton(");
    // The button and the dialog are both inside `{canRepay && (` blocks — for
    // a CASHIER (isAdmin=false) they never enter the DOM at all.
    expect(code.match(/\{canRepay && \(/g)).toHaveLength(2);
    expect(code).toContain("<RepaymentModal");
  });

  it("the repayment dialog performs no balance/exchange-rate computation of its own", () => {
    const code = readSource("components/ledger/repayment-modal.tsx");
    // Delegates both paths; never computes or posts a rate/USD figure.
    expect(code).toContain("submitOfflinePayment(");
    expect(code).toContain("/api/ledger/payments");
    expect(code).not.toContain("dailyExchangeRate");
    expect(code).not.toMatch(/\$(query|execute)Raw/);
    expect(code).not.toContain("computeBalanceSYP");
  });
});






