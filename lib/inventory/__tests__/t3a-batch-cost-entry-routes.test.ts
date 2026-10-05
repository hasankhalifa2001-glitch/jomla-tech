/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";
import Decimal from "decimal.js";

/**
 * [Batch cost entry — ROUTE level] T3a / T4g / Section 11.
 *
 * The companion file t3a-batch-cost-from-total.test.ts covers the DERIVATION
 * (lib/inventory/batch-creation.ts's createBatchRow) directly and explicitly
 * defers "CASHIER -> 403, full batchNumber -> 400, client-sent
 * costPricePerBaseUnit -> 400, receipt atomicity" to a route test file. This
 * is that file. It pins:
 *
 *   1. Every INTERACTIVE creation route rejects a client-supplied
 *      costPricePerBaseUnit (and the other server-derived fields) outright.
 *   2. The multi-product receipt route wraps EVERY row in ONE $transaction,
 *      so a forced failure partway through leaves ZERO partial batches.
 *   3. The PATCH correction path accepts a per-base-unit cost DIRECTLY
 *      (8dp), demands a reason, and writes the batch + its CostPriceChangeLog
 *      row in ONE transaction, with old/new as decimal STRINGS.
 *   4. The worked example: 5 طرد (factor 6) for 10,000 -> per-base
 *      333.33333333, and selling all 30 base units freezes
 *      InvoiceItem.costAmountSYP at exactly 10000.0000.
 *   5. A CASHIER's batch-detail payload carries NO cost figure at all.
 */

const { mockDb, mockState, mockSessionState } = vi.hoisted(() => {
  const mockState = {
    written: [] as any[],
    createCalls: 0,
    failOnCall: 0,
    txnCount: 0,
  };

  const mockDb: any = {
    tenant: { findUnique: vi.fn() },
    product: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn(), create: vi.fn() },
    productUnit: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), findMany: vi.fn(), create: vi.fn() },
    productUnitBarcode: { create: vi.fn(), findMany: vi.fn() },
    productCatalogEntry: { findUnique: vi.fn(), create: vi.fn() },
    productCatalogEntryBarcode: { findUnique: vi.fn() },
    productBatch: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
    },
    costPriceChangeLog: { create: vi.fn(), count: vi.fn(), findMany: vi.fn() },
    stockAdjustment: { create: vi.fn(), findMany: vi.fn(), count: vi.fn() },
    batchDeletionLog: { create: vi.fn() },
    invoiceItem: { count: vi.fn() },
  };

  // A REAL rollback: on a throw, the simulated writes are undone — this is
  // what lets the receipt test assert "zero partial batches" rather than just
  // "the handler returned 500".
  mockDb.$transaction = vi.fn(async (cb: (tx: any) => Promise<any>) => {
    mockState.txnCount += 1;
    const snapshot = [...mockState.written];
    try {
      return await cb(mockDb);
    } catch (error) {
      mockState.written.length = 0;
      mockState.written.push(...snapshot);
      throw error;
    }
  });

  const mockSessionState = {
    session: {
      user: {
        id: "admin-user-id",
        role: "ADMIN",
        tenantId: "tenant-al-baraka",
        subscriptionStatus: "ACTIVE",
      },
    } as any,
  };

  return { mockDb, mockState, mockSessionState };
});

vi.mock("@/lib/db", () => ({
  prisma: mockDb,
  getTenantDb: vi.fn(() => mockDb),
}));

vi.mock("@/lib/db/tenant-scope", () => ({
  getTenantDb: vi.fn(() => mockDb),
}));

vi.mock("@/auth", () => ({
  auth: vi.fn(async () => mockSessionState.session),
}));

// Fresh subscription status is not what this file is testing.
vi.mock("@/lib/auth/tenant", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { ...actual, assertTenantWritable: vi.fn(async () => undefined) };
});

// The product gateway is not under test here; return a stable display row.
vi.mock("@/lib/data/products", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    findProductById: vi.fn(async () => ({ id: "prod-1", name: "منتج تجريبي" })),
  };
});

// createBatchRow is exercised exhaustively in t3a-batch-cost-from-total.test.ts.
// Here it is stubbed so the ROUTE's own transaction/atomicity behaviour is what
// gets asserted — and so a failure can be forced at an exact row.
vi.mock("@/lib/inventory/batch-creation", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    createBatchRow: vi.fn(async (_tx: any, input: any) => {
      mockState.createCalls += 1;
      if (mockState.failOnCall && mockState.createCalls === mockState.failOnCall) {
        throw new Error("forced failure partway through the receipt");
      }
      const row = {
        batchId: `batch-${mockState.createCalls}`,
        batchNumber: input.batchNumber,
        resolvedBaseUnitId: "unit-piece",
        resolvedBaseUnitName: "قطعة",
        baseQuantity: "36.0000",
        costPricePerBaseUnit: "1500.00000000",
        enteredUnitName: "طرد",
      };
      mockState.written.push(row);
      return row;
    }),
  };
});

import { POST as createBatchHandler } from "@/app/api/inventory/batches/route";
import { POST as createReceiptHandler } from "@/app/api/inventory/batches/receipt/route";
import { POST as createProductHandler } from "@/app/api/inventory/products/route";
import {
  GET as getBatchHandler,
  PATCH as patchBatchHandler,
} from "@/app/api/inventory/batches/[id]/route";
import { costFromTotal } from "@/lib/inventory/units";
import { multiplyMoney } from "@/lib/utils/money";

function jsonRequest(url: string, method: string, body: unknown): Request {
  return new Request(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockState.written.length = 0;
  mockState.createCalls = 0;
  mockState.failOnCall = 0;
  mockState.txnCount = 0;
  mockSessionState.session = {
    user: {
      id: "admin-user-id",
      role: "ADMIN",
      tenantId: "tenant-al-baraka",
      subscriptionStatus: "ACTIVE",
    },
  };
});

// ---------------------------------------------------------------------------
describe("1. Interactive creation routes reject a client-supplied cost figure", () => {
  it.each(["costPricePerBaseUnit", "conversionFactor", "baseQuantity", "perBaseUnit"])(
    "POST /api/inventory/batches rejects a forged `%s` with 400",
    async (field) => {
      const res = await createBatchHandler(
        jsonRequest("http://localhost/api/inventory/batches", "POST", {
          productId: "prod-1",
          unitId: "unit-carton",
          batchNumberSuffix: "INV1",
          quantity: "6",
          totalCost: "54000",
          [field]: "999",
        })
      );

      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("CLIENT_COMPUTED_FIELD_NOT_ALLOWED");
    }
  );

  it.each(["costPricePerBaseUnit", "conversionFactor", "baseQuantity", "perBaseUnit"])(
    "POST /api/inventory/products rejects a forged initialBatch `%s` with 400",
    async (field) => {
      const res = await createProductHandler(
        jsonRequest("http://localhost/api/inventory/products", "POST", {
          name: "منتج",
          units: [
            { unitName: "قطعة", conversionFactor: "1", priceWholesale: "1000", pricingCurrency: "SYP" },
          ],
          initialBatch: {
            unitIndex: 0,
            batchNumberSuffix: "INV1",
            quantity: "6",
            totalCost: "54000",
            [field]: "999",
          },
        })
      );

      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("CLIENT_COMPUTED_FIELD_NOT_ALLOWED");
    }
  );

  it("POST /api/inventory/batches/receipt rejects a forged field on ANY line item", async () => {
    const res = await createReceiptHandler(
      jsonRequest("http://localhost/api/inventory/batches/receipt", "POST", {
        batchNumberSuffix: "INV1",
        items: [
          { productId: "p1", unitId: "u1", quantity: "6", totalCost: "54000" },
          { productId: "p2", unitId: "u2", quantity: "6", totalCost: "54000", costPricePerBaseUnit: "999" },
        ],
      })
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("CLIENT_COMPUTED_FIELD_NOT_ALLOWED");
    expect(mockState.written).toHaveLength(0);
  });
});


// ---------------------------------------------------------------------------
describe("2. Multi-product receipt atomicity", () => {
  const twoItemBody = {
    batchNumberSuffix: "INV1",
    items: [
      { productId: "p1", unitId: "u1", quantity: "6", totalCost: "54000" },
      { productId: "p2", unitId: "u2", quantity: "6", totalCost: "54000" },
    ],
  };

  it("creates every row inside ONE transaction on success", async () => {
    const res = await createReceiptHandler(
      jsonRequest("http://localhost/api/inventory/batches/receipt", "POST", twoItemBody)
    );

    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.createdCount).toBe(2);
    expect(payload.batches).toHaveLength(2);
    expect(mockState.txnCount).toBe(1);
    expect(mockState.written).toHaveLength(2);
  });

  it("rolls back ALL rows on a forced failure partway through — zero partial batches", async () => {
    mockState.failOnCall = 2; // the first row succeeds, the second throws

    const res = await createReceiptHandler(
      jsonRequest("http://localhost/api/inventory/batches/receipt", "POST", twoItemBody)
    );

    expect(res.status).toBe(500);
    // The first row was written inside the transaction and then undone —
    // nothing survives, so no partial receipt is ever persisted.
    expect(mockState.written).toHaveLength(0);
    expect(mockState.txnCount).toBe(1);
  });
});


// ---------------------------------------------------------------------------
describe("3. PATCH cost correction — direct 8dp value, reason required, logged", () => {
  const batchRow = () => ({
    id: "batch-1",
    tenantId: "tenant-al-baraka",
    productId: "prod-1",
    unitId: "unit-piece",
    batchNumber: "2026-09-28-INV4471",
    quantity: new Prisma.Decimal("30.0000"),
    costPricePerBaseUnit: new Prisma.Decimal("333.33333333"),
    expiryDate: null,
    createdAt: new Date("2026-09-28T00:00:00Z"),
  });

  it("rejects a 9-decimal cost (the column is Decimal(18,8)) before loading the batch", async () => {
    const res = await patchBatchHandler(
      jsonRequest("http://localhost/api/inventory/batches/batch-1", "PATCH", {
        costPricePerBaseUnit: "1.000000001",
        costPriceChangeReason: "تصحيح",
      }),
      { params: Promise.resolve({ id: "batch-1" }) }
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("VALIDATION_ERROR");
    expect(mockDb.productBatch.findFirst).not.toHaveBeenCalled();
  });

  it("requires a reason whenever a cost is supplied, BEFORE the batch is loaded", async () => {
    const res = await patchBatchHandler(
      jsonRequest("http://localhost/api/inventory/batches/batch-1", "PATCH", {
        costPricePerBaseUnit: "400.00000000",
      }),
      { params: Promise.resolve({ id: "batch-1" }) }
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("COST_PRICE_CHANGE_REASON_REQUIRED");
    expect(mockDb.productBatch.findFirst).not.toHaveBeenCalled();
    expect(mockDb.costPriceChangeLog.create).not.toHaveBeenCalled();
  });

  it("writes the batch and its CostPriceChangeLog row in ONE transaction, old/new as strings", async () => {
    mockDb.productBatch.findFirst.mockResolvedValueOnce(batchRow());
    mockDb.costPriceChangeLog.create.mockResolvedValueOnce({ id: "log-1" });
    mockDb.productBatch.update.mockResolvedValueOnce({
      ...batchRow(),
      costPricePerBaseUnit: new Prisma.Decimal("400.00000000"),
    });

    const res = await patchBatchHandler(
      jsonRequest("http://localhost/api/inventory/batches/batch-1", "PATCH", {
        costPricePerBaseUnit: "400.00000000",
        costPriceChangeReason: "خطأ في إدخال سعر الشراء",
      }),
      { params: Promise.resolve({ id: "batch-1" }) }
    );

    expect(res.status).toBe(200);
    const payload = await res.json();
    // Response carries a decimal STRING, never Number() — Prisma.Decimal's own
    // .toString() (trailing zeros dropped), exactly as the batches[] list in
    // products/route.ts serializes it.
    expect(payload.batch.costPricePerBaseUnit).toBe("400");
    expect(typeof payload.batch.costPricePerBaseUnit).toBe("string");

    expect(mockState.txnCount).toBe(1);
    expect(mockDb.costPriceChangeLog.create).toHaveBeenCalledTimes(1);
    const logArg = mockDb.costPriceChangeLog.create.mock.calls[0][0];
    expect(logArg.data.oldCostPrice).toBe("333.33333333");
    expect(logArg.data.newCostPrice).toBe("400.00000000");
    expect(logArg.data.batchId).toBe("batch-1");
    expect(logArg.data.changedByUserId).toBe("admin-user-id");
    expect(logArg.data.reason).toBe("خطأ في إدخال سعر الشراء");

    expect(mockDb.productBatch.update).toHaveBeenCalledTimes(1);
    expect(mockDb.productBatch.update.mock.calls[0][0].data.costPricePerBaseUnit).toBe("400.00000000");
  });

  it("writes NO audit row when the supplied cost equals the stored one", async () => {
    mockDb.productBatch.findFirst.mockResolvedValueOnce(batchRow());
    mockDb.productBatch.update.mockResolvedValueOnce(batchRow());

    const res = await patchBatchHandler(
      jsonRequest("http://localhost/api/inventory/batches/batch-1", "PATCH", {
        costPricePerBaseUnit: "333.33333333",
        costPriceChangeReason: "لا تغيير فعلي",
      }),
      { params: Promise.resolve({ id: "batch-1" }) }
    );

    expect(res.status).toBe(200);
    expect(mockDb.costPriceChangeLog.create).not.toHaveBeenCalled();
    expect(mockDb.productBatch.update.mock.calls[0][0].data.costPricePerBaseUnit).toBeUndefined();
  });
});


// ---------------------------------------------------------------------------
describe("4. Worked example — 5 طرد (factor 6) for 10,000", () => {
  it("derives 333.33333333 per base unit, and selling all 30 freezes 10000.0000", () => {
    const result = costFromTotal("10000", "5", 6);

    expect(result.baseQuantity).toBe("30.0000");
    expect(result.perBaseUnit).toBe("333.33333333");

    // The frozen InvoiceItem.costAmountSYP is allocatedQty x costPricePerBaseUnit,
    // exactly as app/api/sync/route.ts and the order-approval route compute it.
    const costAmountSYP = multiplyMoney(result.baseQuantity, result.perBaseUnit);
    expect(costAmountSYP).toBe("10000.0000");
  });
});

// ---------------------------------------------------------------------------
describe("5. CASHIER never receives a cost figure from the batch-detail endpoint", () => {
  const detailBatch = () => ({
    id: "batch-1",
    tenantId: "tenant-al-baraka",
    productId: "prod-1",
    unitId: "unit-piece",
    batchNumber: "2026-09-28-INV4471",
    quantity: new Prisma.Decimal("30.0000"),
    costPricePerBaseUnit: new Prisma.Decimal("333.33333333"),
    expiryDate: null,
    createdAt: new Date("2026-09-28T00:00:00Z"),
    unit: { id: "unit-piece", unitName: "قطعة", isActive: true },
    _count: { invoiceItems: 0 },
  });

  it("omits the key entirely for a CASHIER", async () => {
    mockSessionState.session.user.role = "CASHIER";
    mockDb.productBatch.findFirst.mockResolvedValueOnce(detailBatch());
    mockDb.stockAdjustment.findMany.mockResolvedValueOnce([]);

    const res = await getBatchHandler(
      new Request("http://localhost/api/inventory/batches/batch-1"),
      { params: Promise.resolve({ id: "batch-1" }) }
    );

    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.batch).not.toHaveProperty("costPricePerBaseUnit");
  });

  it("includes it as a decimal string for an ADMIN", async () => {
    mockDb.productBatch.findFirst.mockResolvedValueOnce(detailBatch());
    mockDb.stockAdjustment.findMany.mockResolvedValueOnce([]);

    const res = await getBatchHandler(
      new Request("http://localhost/api/inventory/batches/batch-1"),
      { params: Promise.resolve({ id: "batch-1" }) }
    );

    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.batch.costPricePerBaseUnit).toBe("333.33333333");
    expect(new Decimal(payload.batch.costPricePerBaseUnit).toFixed(8)).toBe("333.33333333");
  });
});
