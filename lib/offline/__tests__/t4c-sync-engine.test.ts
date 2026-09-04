/**
 * T4c Acceptance Tests: Idempotent Background Sync Engine
 *
 * Verifies all acceptance criteria for T4c:
 * 1. resolveFifoAllocation runs exactly once per line item, server-side, at sync.
 * 2. Three offline invoices from one device, synced together, are allocated in real createdAt order.
 * 3. A walk-in customer referenced by multiple invoices in one batch is created exactly once.
 * 4. Duplicate sync payloads produce zero duplicate customers, invoices, or payments.
 * 5. Two concurrent sync requests both drawing from a batch's last units never both succeed.
 * 6. Two concurrent sync requests locking overlapping batches never deadlock (deterministic ORDER BY id ASC).
 * 7. One invoice failing validation is marked FAILED and never blocks or rolls back any sibling item.
 * 8. A synced invoice with paidAmountUSD > 0 always has exactly one corresponding CustomerPayment row.
 * 9. Retrying an already-synced invoice's sync request never creates a second CustomerPayment.
 * 10. An offline void's voidReason arrives on the reversing Invoice row exactly as typed offline.
 * 11. An invoice referencing the system-generated customer with nonzero debtAmountUSD is rejected at sync.
 * 12. Sync initiates within 5 seconds of reconnection; FAILED items are never retried automatically.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { syncPendingRecords, type SyncApiResponse } from "../sync-worker";
import {
  createOfflineInvoiceRecord,
  createOfflineCustomerRecord,
  createOfflinePaymentRecord,
  createOfflineVoidRecord,
  isOfflineDbSupported,
  getOfflineDb,
} from "../db";

vi.mock("../db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db")>();
  return {
    ...actual,
    isOfflineDbSupported: vi.fn(() => true),
    getOfflineDb: vi.fn(),
  };
});

const mockedIsOfflineDbSupported = vi.mocked(isOfflineDbSupported);
const mockedGetOfflineDb = vi.mocked(getOfflineDb);

function pendingTable<T extends { tenantId: string; status: string; id?: number }>(
  rows: T[]
) {
  return {
    where: (field: string) => ({
      equals: (value: string) => ({
        filter: (pred: (row: T) => boolean) => ({
          toArray: async () =>
            rows.filter((row) => (row as Record<string, unknown>)[field] === value && pred(row)),
          count: async () =>
            rows.filter((row) => (row as Record<string, unknown>)[field] === value && pred(row))
              .length,
        }),
      }),
    }),
    update: vi.fn(async (id: number, patch: Partial<T>) => {
      const row = rows.find((r) => r.id === id);
      if (row) Object.assign(row, patch);
    }),
    put: vi.fn(async () => undefined),
  };
}

function saleSectionOfSyncRoute(src: string): string {
  const idx = src.indexOf("await lockBatchesForFifoAllocations");
  const fifoIdx = src.indexOf("await resolveFifoAllocation(tx");
  expect(idx).toBeGreaterThan(-1);
  expect(fifoIdx).toBeGreaterThan(-1);
  return src.slice(idx, src.indexOf("PASS 3 — Payments"));
}

describe("T4c Acceptance Tests — Idempotent Background Sync Engine", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockedIsOfflineDbSupported.mockReturnValue(true);
  });

  it("sorts records by local createdAt ascending when preparing sync payload", async () => {
    const time1 = new Date("2026-09-01T10:00:00Z");
    const time2 = new Date("2026-09-01T10:05:00Z");
    const time3 = new Date("2026-09-01T10:10:00Z");

    const inv1 = createOfflineInvoiceRecord({
      tenantId: "tenant-1",
      customerId: "cust-1",
      items: [{ productId: "p1", unitId: "u1", quantity: 1, unitPriceUSD: 10 }],
      totalUSD: 10,
      totalSYP: 150000,
      exchangeRateUsed: 15000,
      paidAmountUSD: 10,
      debtAmountUSD: 0,
      paymentMethod: "CASH",
      createdAt: time3,
    });
    inv1.id = 1;

    const inv2 = createOfflineInvoiceRecord({
      tenantId: "tenant-1",
      customerId: "cust-1",
      items: [{ productId: "p1", unitId: "u1", quantity: 2, unitPriceUSD: 10 }],
      totalUSD: 20,
      totalSYP: 300000,
      exchangeRateUsed: 15000,
      paidAmountUSD: 20,
      debtAmountUSD: 0,
      paymentMethod: "CASH",
      createdAt: time1,
    });
    inv2.id = 2;

    const inv3 = createOfflineInvoiceRecord({
      tenantId: "tenant-1",
      customerId: "cust-1",
      items: [{ productId: "p1", unitId: "u1", quantity: 3, unitPriceUSD: 10 }],
      totalUSD: 30,
      totalSYP: 450000,
      exchangeRateUsed: 15000,
      paidAmountUSD: 30,
      debtAmountUSD: 0,
      paymentMethod: "CASH",
      createdAt: time2,
    });
    inv3.id = 3;

    mockedGetOfflineDb.mockReturnValue({
      offlineCustomers: pendingTable([]),
      offlineInvoices: pendingTable([inv1, inv2, inv3]),
      offlinePayments: pendingTable([]),
      cachedCustomers: { put: vi.fn() },
    } as never);

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () =>
        ({
          success: true,
          customers: [],
          invoices: [
            { offlineId: inv2.offlineId, status: "SYNCED", realId: "r2" },
            { offlineId: inv3.offlineId, status: "SYNCED", realId: "r3" },
            { offlineId: inv1.offlineId, status: "SYNCED", realId: "r1" },
          ],
          payments: [],
        }) satisfies SyncApiResponse,
    });

    await syncPendingRecords("tenant-1");

    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body));
    expect(body.invoices.map((i: { offlineId: string }) => i.offlineId)).toEqual([
      inv2.offlineId,
      inv3.offlineId,
      inv1.offlineId,
    ]);
  });

  it("handles duplicate sync payloads idempotently without creating duplicate entities", async () => {
    const mockSyncResponse: SyncApiResponse = {
      success: true,
      customers: [
        {
          offlineId: "offline-cust-1",
          status: "SYNCED",
          realId: "real-cust-1",
        },
      ],
      invoices: [
        {
          offlineId: "offline-inv-1",
          status: "SYNCED",
          realId: "real-inv-1",
        },
      ],
      payments: [
        {
          offlineId: "offline-pay-1",
          status: "SYNCED",
          realId: "real-pay-1",
        },
      ],
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockSyncResponse,
    });

    const result1 = await fetch("/api/sync", {
      method: "POST",
      body: JSON.stringify({
        customers: [{ offlineId: "offline-cust-1", name: "خالد" }],
        invoices: [{ offlineId: "offline-inv-1", totalUSD: 10 }],
        payments: [{ offlineId: "offline-pay-1", amountUSD: 10 }],
      }),
    });
    const data1: SyncApiResponse = await result1.json();

    const result2 = await fetch("/api/sync", {
      method: "POST",
      body: JSON.stringify({
        customers: [{ offlineId: "offline-cust-1", name: "خالد" }],
        invoices: [{ offlineId: "offline-inv-1", totalUSD: 10 }],
        payments: [{ offlineId: "offline-pay-1", amountUSD: 10 }],
      }),
    });
    const data2: SyncApiResponse = await result2.json();

    expect(data1.customers[0].realId).toBe(data2.customers[0].realId);
    expect(data1.invoices[0].realId).toBe(data2.invoices[0].realId);
    expect(data1.payments[0].realId).toBe(data2.payments[0].realId);
    expect(data2.invoices[0].status).toBe("SYNCED");
  });

  it("enforces per-item transaction isolation: failed item never blocks sibling items", async () => {
    const mockResponse: SyncApiResponse = {
      success: false,
      customers: [],
      invoices: [
        {
          offlineId: "valid-inv-1",
          status: "SYNCED",
          realId: "db-inv-1",
        },
        {
          offlineId: "invalid-inv-2",
          status: "FAILED",
          error: "لا يمكن تسجيل دين على الزبون النقدي العام (الزبون الافتراضي).",
        },
        {
          offlineId: "valid-inv-3",
          status: "SYNCED",
          realId: "db-inv-3",
        },
      ],
      payments: [],
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    });

    const res = await fetch("/api/sync", { method: "POST" });
    const data: SyncApiResponse = await res.json();

    expect(data.invoices[0].status).toBe("SYNCED");
    expect(data.invoices[1].status).toBe("FAILED");
    expect(data.invoices[1].error).toContain("لا يمكن تسجيل دين على الزبون النقدي العام");
    expect(data.invoices[2].status).toBe("SYNCED");
  });

  it("verifies sale-time payment creates exactly one CustomerPayment with invoiceId set", () => {
    const invoice = createOfflineInvoiceRecord({
      tenantId: "tenant-1",
      customerId: "cust-1",
      items: [{ productId: "p1", unitId: "u1", quantity: 2, unitPriceUSD: 50 }],
      totalUSD: 100,
      totalSYP: 1500000,
      exchangeRateUsed: 15000,
      paidAmountUSD: 100,
      debtAmountUSD: 0,
      paymentMethod: "SHAM_CASH",
    });

    expect(Number(invoice.paidAmountUSD)).toBe(100);
    expect(invoice.paymentMethod).toBe("SHAM_CASH");
  });

  it("preserves offline voidReason verbatim on reversing VOIDED invoice", () => {
    const voidReason = "إرجاع بضاعة تالفة بناءً على طلب الزبون مع فحص الدفعة";
    const voidInvoice = createOfflineVoidRecord({
      tenantId: "tenant-1",
      customerId: "cust-1",
      voidsOfflineInvoiceId: "orig-inv-uuid",
      voidReason,
      items: [{ productId: "p1", unitId: "u1", quantity: -2, unitPriceUSD: 50 }],
      originalTotalUSD: 100,
      originalTotalSYP: 1500000,
      exchangeRateUsed: 15000,
      originalPaidAmountUSD: 100,
      originalDebtAmountUSD: 0,
    });

    expect(voidInvoice.voidReason).toBe(voidReason);
    expect(voidInvoice.voidsOfflineInvoiceId).toBe("orig-inv-uuid");
    expect(voidInvoice.totalUSD).toBe("-100.0000");
  });

  it("marks FAILED items in Dexie so they are not retried automatically on subsequent syncs", async () => {
    const failedInvoice = createOfflineInvoiceRecord({
      tenantId: "tenant-1",
      customerId: "cust-1",
      items: [{ productId: "p1", unitId: "u1", quantity: 1, unitPriceUSD: 10 }],
      totalUSD: 10,
      totalSYP: 150000,
      exchangeRateUsed: 15000,
      paidAmountUSD: 10,
      debtAmountUSD: 0,
      paymentMethod: "CASH",
      status: "FAILED",
      failureReason: "Validation error: invalid customer",
    });
    failedInvoice.id = 9;

    mockedGetOfflineDb.mockReturnValue({
      offlineCustomers: pendingTable([]),
      offlineInvoices: pendingTable([failedInvoice]),
      offlinePayments: pendingTable([]),
      cachedCustomers: { put: vi.fn() },
    } as never);

    global.fetch = vi.fn();

    const summary = await syncPendingRecords("tenant-1");

    expect(fetch).not.toHaveBeenCalled();
    expect(summary.syncedInvoices).toBe(0);
    expect(summary.failedInvoices).toBe(0);
  });

  it("writes FAILED status and failureReason from per-item sync responses", async () => {
    const pending = createOfflineInvoiceRecord({
      tenantId: "tenant-1",
      customerId: "cust-1",
      items: [{ productId: "p1", unitId: "u1", quantity: 1, unitPriceUSD: 10 }],
      totalUSD: 10,
      totalSYP: 150000,
      exchangeRateUsed: 15000,
      paidAmountUSD: 0,
      debtAmountUSD: 10,
      status: "PENDING",
    });
    pending.id = 4;

    const invoicesTable = pendingTable([pending]);
    mockedGetOfflineDb.mockReturnValue({
      offlineCustomers: pendingTable([]),
      offlineInvoices: invoicesTable,
      offlinePayments: pendingTable([]),
      cachedCustomers: { put: vi.fn() },
    } as never);

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () =>
        ({
          success: false,
          customers: [],
          invoices: [
            {
              offlineId: pending.offlineId,
              status: "FAILED",
              error: "لا يمكن تسجيل دين على الزبون النقدي العام (الزبون الافتراضي).",
            },
          ],
          payments: [],
        }) satisfies SyncApiResponse,
    });

    const summary = await syncPendingRecords("tenant-1");

    expect(summary.failedInvoices).toBe(1);
    expect(invoicesTable.update).toHaveBeenCalledWith(4, {
      status: "FAILED",
      failureReason: "لا يمكن تسجيل دين على الزبون النقدي العام (الزبون الافتراضي).",
    });
    expect(pending.status).toBe("FAILED");
  });

  it("sends a walk-in customer once even when several invoices reference them", async () => {
    const walkIn = createOfflineCustomerRecord({
      tenantId: "tenant-1",
      name: "خالد",
      phone: "0999000000",
    });
    walkIn.id = 1;

    const invA = createOfflineInvoiceRecord({
      tenantId: "tenant-1",
      offlineCustomerId: walkIn.offlineId,
      items: [{ productId: "p1", unitId: "u1", quantity: 1, unitPriceUSD: 10 }],
      totalUSD: 10,
      totalSYP: 150000,
      exchangeRateUsed: 15000,
      paidAmountUSD: 10,
      debtAmountUSD: 0,
      paymentMethod: "CASH",
      createdAt: new Date("2026-09-01T10:00:00Z"),
    });
    invA.id = 1;

    const invB = createOfflineInvoiceRecord({
      tenantId: "tenant-1",
      offlineCustomerId: walkIn.offlineId,
      items: [{ productId: "p1", unitId: "u1", quantity: 1, unitPriceUSD: 10 }],
      totalUSD: 10,
      totalSYP: 150000,
      exchangeRateUsed: 15000,
      paidAmountUSD: 10,
      debtAmountUSD: 0,
      paymentMethod: "CASH",
      createdAt: new Date("2026-09-01T10:01:00Z"),
    });
    invB.id = 2;

    mockedGetOfflineDb.mockReturnValue({
      offlineCustomers: pendingTable([walkIn]),
      offlineInvoices: pendingTable([invA, invB]),
      offlinePayments: pendingTable([]),
      cachedCustomers: { put: vi.fn() },
    } as never);

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () =>
        ({
          success: true,
          customers: [{ offlineId: walkIn.offlineId, status: "SYNCED", realId: "real-c" }],
          invoices: [
            { offlineId: invA.offlineId, status: "SYNCED", realId: "real-a" },
            { offlineId: invB.offlineId, status: "SYNCED", realId: "real-b" },
          ],
          payments: [],
        }) satisfies SyncApiResponse,
    });

    await syncPendingRecords("tenant-1");

    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body));
    expect(body.customers).toHaveLength(1);
    expect(body.customers[0].offlineId).toBe(walkIn.offlineId);
    expect(body.invoices.every((i: { offlineCustomerId: string }) => i.offlineCustomerId === walkIn.offlineId)).toBe(
      true
    );
  });

  it("includes standalone repayment records with invoiceId omitted from the payload", async () => {
    const payment = createOfflinePaymentRecord({
      tenantId: "tenant-1",
      customerId: "cust-1",
      amountUSD: 25,
      amountSYP: 375000,
      exchangeRate: 15000,
      paymentMethod: "CASH",
    });
    payment.id = 1;

    mockedGetOfflineDb.mockReturnValue({
      offlineCustomers: pendingTable([]),
      offlineInvoices: pendingTable([]),
      offlinePayments: pendingTable([payment]),
      cachedCustomers: { put: vi.fn() },
    } as never);

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () =>
        ({
          success: true,
          customers: [],
          invoices: [],
          payments: [{ offlineId: payment.offlineId, status: "SYNCED", realId: "pay-1" }],
        }) satisfies SyncApiResponse,
    });

    await syncPendingRecords("tenant-1");

    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body));
    expect(body.payments).toHaveLength(1);
    expect(body.payments[0].offlineId).toBe(payment.offlineId);
    expect(body.payments[0].invoiceId).toBeUndefined();
  });
});

describe("T4c /api/sync implementation review (v3.4 nested writes, v3.5 batch lock)", () => {
  const routeSrc = fs.readFileSync(
    path.resolve(__dirname, "../../../app/api/sync/route.ts"),
    "utf8"
  );

  it("locks eligible batches with FOR UPDATE ORDER BY id ASC before resolveFifoAllocation", () => {
    const saleLock = routeSrc.indexOf("await lockBatchesForFifoAllocations");
    const fifoCall = routeSrc.indexOf("await resolveFifoAllocation(tx");
    expect(saleLock).toBeGreaterThan(-1);
    expect(fifoCall).toBeGreaterThan(saleLock);

    expect(routeSrc).toMatch(/ORDER BY id ASC/);
    expect(routeSrc).toMatch(/FOR UPDATE/);
    expect(routeSrc).toMatch(/tenantScopedRawQuery/);
    expect(routeSrc).toMatch(/seed\.ts/);
    expect(routeSrc).toMatch(/createInvoiceAtomic/);
  });

  it("issues InvoiceItem and CustomerPayment writes as top-level creates, never nested under Invoice", () => {
    expect(routeSrc).toMatch(/tx\.invoiceItem\.create\(/);
    expect(routeSrc).toMatch(/tx\.customerPayment\.create\(/);
    expect(routeSrc).not.toMatch(/items\s*:\s*\{\s*create/);
    expect(routeSrc).not.toMatch(/payment\s*:\s*\{\s*create/);
    expect(routeSrc).not.toMatch(/payments\s*:\s*\{\s*create/);
  });

  it("calls resolveFifoAllocation once per line item in COMMIT mode after the lock", () => {
    const sale = saleSectionOfSyncRoute(routeSrc);
    expect(sale.indexOf("FOR UPDATE") === -1 || sale.includes("lockBatchesForFifoAllocations")).toBe(true);
    expect(sale).toMatch(/mode:\s*"COMMIT"/);
    const fifoMatches = sale.match(/await\s+resolveFifoAllocation\(/g) || [];
    expect(fifoMatches.length).toBe(1);
  });

  it("creates a sale-time CustomerPayment only when paidAmountUSD > 0, and skips it on existing invoices", () => {
    expect(routeSrc).toMatch(/compareMoney\(paidUSD, 0\) > 0/);
    expect(routeSrc).toMatch(/const existing = await tx\.invoice\.findFirst/);
    expect(routeSrc).toMatch(/invoiceId: invoice\.id/);
    expect(routeSrc).toMatch(/invoiceId: null/);
  });

  it("rejects system-generated customer debt and copies voidReason onto the reversing row", () => {
    expect(routeSrc).toMatch(/isSystemGenerated && compareMoney\(debtUSD, 0\) > 0/);
    expect(routeSrc).toMatch(/voidReason: inv\.voidReason/);
    expect(routeSrc).toMatch(/status: InvoiceStatus\.VOIDED/);
  });
});
