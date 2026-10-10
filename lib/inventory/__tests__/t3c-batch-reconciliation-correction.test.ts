/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";

const {
  mockTenant,
  mockProduct,
  mockProductBatch,
  mockInvoiceItem,
  mockStockAdjustment,
  mockBatchDeletionLog,
  mockCostPriceChangeLog,
  mockRawPrisma,
  mockSessionState,
} = vi.hoisted(() => {
  const mockTenant = {
    findUnique: vi.fn(),
  };
  // [v4.3 T1/T3c corrigendum] GET /api/inventory/batches/[id] resolves the
  // product through lib/data/products.ts's findProductById() — the sanctioned
  // gateway, which reads tx.product.findUnique — never through a nested
  // `product` relation on the batch query.
  const mockProduct = {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
  };
  const mockProductBatch = {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
  };
  const mockInvoiceItem = {
    count: vi.fn(),
  };
  // [v4.3 T1/T3c corrigendum] `count` is here on purpose so a test can assert
  // the delete path NEVER counts adjustment rows (that count was the silent
  // second eligibility condition this corrigendum removed), and
  // delete/deleteMany are here so a test can assert a hard-deleted batch's
  // StockAdjustment rows are never touched.
  const mockStockAdjustment = {
    count: vi.fn(),
    create: vi.fn(),
    findMany: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
  };
  const mockBatchDeletionLog = {
    create: vi.fn(),
    findMany: vi.fn(),
  };
  // [v4.3 T1/T3c corrigendum — acceptance criteria #5/#6] CostPriceChangeLog
  // (T4g's audit trail) is the second "snapshot, not live FK" log. Its write
  // endpoint belongs to T4g; what this file verifies is that a batch holding
  // such a row is still hard-deletable, and that the row is neither deleted
  // nor even looked at by the delete path. `create` is wired statefully by the
  // combined-case test to record the row.
  const mockCostPriceChangeLog = {
    create: vi.fn(),
    count: vi.fn(),
    findMany: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
  };

  const mockRawPrisma: any = {
    tenant: mockTenant,
    product: mockProduct,
    productBatch: mockProductBatch,
    invoiceItem: mockInvoiceItem,
    stockAdjustment: mockStockAdjustment,
    batchDeletionLog: mockBatchDeletionLog,
    costPriceChangeLog: mockCostPriceChangeLog,
  };

  mockRawPrisma.$transaction = vi.fn(async (cb: (tx: any) => Promise<any>) => cb(mockRawPrisma));

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

  return {
    mockTenant,
    mockProduct,
    mockProductBatch,
    mockInvoiceItem,
    mockStockAdjustment,
    mockBatchDeletionLog,
    mockCostPriceChangeLog,
    mockRawPrisma,
    mockSessionState,
  };
});

vi.mock("@/lib/db", () => ({
  prisma: mockRawPrisma,
  getTenantDb: vi.fn(() => mockRawPrisma),
}));

vi.mock("@/lib/db/tenant-scope", () => ({
  getTenantDb: vi.fn(() => mockRawPrisma),
}));

vi.mock("@/auth", () => ({
  auth: vi.fn(async () => mockSessionState.session),
}));

import { POST as reconcileHandler } from "@/app/api/inventory/batches/[id]/reconcile/route";
import {
  GET as getBatchHandler,
  PATCH as patchBatchHandler,
  DELETE as deleteBatchHandler,
} from "@/app/api/inventory/batches/[id]/route";

// [FIX] The file as submitted had every describe/it block scattered
// out of order and disconnected from its own body — most seriously, the
// outer `describe("T3c — ...")` wrapping `beforeEach` sat at the very
// bottom of the file with nothing nested inside it, meaning the four
// numbered describe blocks below were siblings at module scope rather
// than children of it, and `beforeEach` never ran before any of their
// tests. Two `it(...)` blocks ("blocks CASHIER from performing stock
// reconciliation" and "blocks CASHIER from deleting a batch") had their
// bodies physically relocated elsewhere in the file, disconnected from
// their own opening `it(...)` line. Restored to one single, correctly
// nested structure below — no test's assertions or mock setup were
// changed, only their placement.
describe("T3c — Batch, Expiration & Negative-Stock Tracker: Reconciliation & Correction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionState.session = {
      user: {
        id: "admin-user-id",
        role: "ADMIN",
        tenantId: "tenant-al-baraka",
        subscriptionStatus: "ACTIVE",
      },
    };
    mockTenant.findUnique.mockResolvedValue({
      subscriptionStatus: "ACTIVE",
    });
  });

  describe("1. Manual Stock Reconciliation (POST /api/inventory/batches/[id]/reconcile)", () => {
    it("creates exactly one StockAdjustment row and atomically increments ProductBatch.quantity inside $transaction", async () => {
      mockProductBatch.findFirst.mockResolvedValueOnce({
        id: "batch-1",
        tenantId: "tenant-al-baraka",
        productId: "prod-1",
        unitId: "unit-1",
        batchNumber: "B100",
        quantity: new Prisma.Decimal("-3.0000"),
        unit: { unitName: "قطعة" },
      });

      mockStockAdjustment.create.mockResolvedValueOnce({
        id: "adj-1",
        tenantId: "tenant-al-baraka",
        batchId: "batch-1",
        adjustedByUserId: "admin-user-id",
        quantityDelta: new Prisma.Decimal("5.0000"),
        reason: "جرد دوري وإضافة النقص",
        createdAt: new Date(),
        adjustedByUser: { id: "admin-user-id", name: "Admin", email: "admin@baraka.sy" },
      });

      mockProductBatch.update.mockResolvedValueOnce({
        id: "batch-1",
        tenantId: "tenant-al-baraka",
        productId: "prod-1",
        unitId: "unit-1",
        batchNumber: "B100",
        quantity: new Prisma.Decimal("2.0000"),
        unit: { unitName: "قطعة" },
      });

      const req = new Request("http://localhost/api/inventory/batches/batch-1/reconcile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          quantityDelta: "5",
          reason: "جرد دوري وإضافة النقص",
        }),
      });

      const res = await reconcileHandler(req, { params: Promise.resolve({ id: "batch-1" }) });
      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.batch.quantity).toBe(2);
      expect(json.adjustment.quantityDelta).toBe(5);
      expect(json.adjustment.reason).toBe("جرد دوري وإضافة النقص");

      // [FIX] The stale `include: { unit: true }` expectation is gone: this
      // route deliberately never includes the unit relation on the update
      // (carrying a raw ProductUnit row — conversionFactor included — into the
      // response was the leak that include used to feed).
      expect(mockProductBatch.update).toHaveBeenCalledWith({
        where: { id: "batch-1", tenantId: "tenant-al-baraka" },
        data: {
          quantity: {
            increment: "5",
          },
        },
      });

      // [v4.3 T1/T3c corrigendum — acceptance criterion #2] The adjustment row
      // itself carries a snapshot of productId/unitId/batchNumber matching the
      // batch's values at that instant. There is no live relation to read them
      // back through anymore, so this snapshot is the only thing keeping the
      // row meaningful once the batch is hard-deleted.
      expect(mockStockAdjustment.create).toHaveBeenCalledTimes(1);
      expect(mockStockAdjustment.create).toHaveBeenCalledWith({
        data: {
          tenantId: "tenant-al-baraka",
          batchId: "batch-1",
          productId: "prod-1",
          unitId: "unit-1",
          batchNumber: "B100",
          adjustedByUserId: "admin-user-id",
          quantityDelta: "5",
          reason: "جرد دوري وإضافة النقص",
        },
        include: {
          adjustedByUser: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
        },
      });
    });

    it("rejects reconciliation with zero delta or empty reason", async () => {
      const reqZeroDelta = new Request("http://localhost/api/inventory/batches/batch-1/reconcile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          quantityDelta: "0",
          reason: "لا تغيير",
        }),
      });

      const resZero = await reconcileHandler(reqZeroDelta, {
        params: Promise.resolve({ id: "batch-1" }),
      });
      expect(resZero.status).toBe(400);

      const reqShortReason = new Request("http://localhost/api/inventory/batches/batch-1/reconcile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          quantityDelta: "3",
          reason: "  ",
        }),
      });

      const resReason = await reconcileHandler(reqShortReason, {
        params: Promise.resolve({ id: "batch-1" }),
      });
      expect(resReason.status).toBe(400);
    });

    it("blocks CASHIER from performing stock reconciliation", async () => {
      mockSessionState.session.user.role = "CASHIER";

      const req = new Request("http://localhost/api/inventory/batches/batch-1/reconcile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          quantityDelta: "5",
          reason: "محاولة كاشير",
        }),
      });

      const res = await reconcileHandler(req, { params: Promise.resolve({ id: "batch-1" }) });
      expect(res.status).toBe(403);
      expect(mockProductBatch.update).not.toHaveBeenCalled();
    });
  });

  describe("2. Mistaken Batch Hard Deletion (DELETE /api/inventory/batches/[id])", () => {
    // [v4.3 T1/T3c corrigendum] Zero InvoiceItem references is now the ONE and
    // ONLY hard-delete eligibility condition. Every fixture below carries a
    // costPricePerBaseUnit (required by the v4.4 schema and snapshotted into
    // BatchDeletionLog.costPriceAtDeletion), and the tests differ only in which
    // *historical* audit rows exist for the batch being deleted.
    const batchFixture = (overrides: Record<string, unknown> = {}) => ({
      id: "batch-1",
      tenantId: "tenant-al-baraka",
      productId: "prod-1",
      unitId: "unit-1",
      batchNumber: "B100",
      // [v4.7] Distinct, non-default values so a route that forgets to
      // snapshot (or snapshots the LIVE quantity instead of the original)
      // cannot pass by accident: initial 100 / total 500,000 versus a live
      // quantity of 40 here (tests override the live quantity as needed).
      receiptId: "receipt-1",
      initialQuantity: new Prisma.Decimal("100.0000"),
      totalCostSYP: new Prisma.Decimal("500000.0000"),
      quantity: new Prisma.Decimal("40.0000"),
      costPricePerBaseUnit: new Prisma.Decimal("5000.0000"),
      ...overrides,
    });

    // [v4.7] Asserts the three receipt snapshot fields on the row written to
    // BatchDeletionLog. Compared via toString() so a MISSING field fails
    // loudly (undefined !== "100") instead of being ignored the way
    // toHaveBeenCalledWith ignores undefined properties.
    const expectDeletionSnapshot = (
      data: any,
      exp: { receiptId: string; initial: string; total: string; live: string }
    ) => {
      expect(data.receiptId).toBe(exp.receiptId);
      expect(new Prisma.Decimal(data.initialQuantityAtDeletion).toString()).toBe(
        new Prisma.Decimal(exp.initial).toString()
      );
      expect(new Prisma.Decimal(data.totalCostAtDeletion).toString()).toBe(
        new Prisma.Decimal(exp.total).toString()
      );
      expect(new Prisma.Decimal(data.quantityAtDeletion).toString()).toBe(
        new Prisma.Decimal(exp.live).toString()
      );
    };

    const attemptHardDelete = (id: string, reason: string) =>
      deleteBatchHandler(
        new Request(`http://localhost/api/inventory/batches/${id}`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason }),
        }),
        { params: Promise.resolve({ id }) }
      );

    it("hard-deletes a batch with zero sales, writing a snapshot to BatchDeletionLog", async () => {
      mockProductBatch.findFirst.mockResolvedValueOnce(
        batchFixture({
          id: "batch-err",
          batchNumber: "TYPO-999",
          quantity: new Prisma.Decimal("10.0000"),
        })
      );

      mockInvoiceItem.count.mockResolvedValueOnce(0);
      mockBatchDeletionLog.create.mockResolvedValueOnce({ id: "log-1" });
      mockProductBatch.delete.mockResolvedValueOnce({ id: "batch-err" });

      const req = new Request("http://localhost/api/inventory/batches/batch-err", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reason: "تم إدخال الدفعة بالخطأ وبشكل مكرر",
        }),
      });

      const res = await deleteBatchHandler(req, { params: Promise.resolve({ id: "batch-err" }) });
      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json.success).toBe(true);

      expect(mockBatchDeletionLog.create).toHaveBeenCalledWith({
        data: {
          tenantId: "tenant-al-baraka",
          batchId: "batch-err",
          productId: "prod-1",
          unitId: "unit-1",
          batchNumber: "TYPO-999",
          quantityAtDeletion: new Prisma.Decimal("10.0000"),
          costPriceAtDeletion: new Prisma.Decimal("5000.0000"),
          // [v4.7] receipt snapshot — original values, not the live quantity.
          receiptId: "receipt-1",
          initialQuantityAtDeletion: new Prisma.Decimal("100.0000"),
          totalCostAtDeletion: new Prisma.Decimal("500000.0000"),
          deletedByUserId: "admin-user-id",
          reason: "تم إدخال الدفعة بالخطأ وبشكل مكرر",
        },
      });

      expect(mockProductBatch.delete).toHaveBeenCalledWith({
        where: { id: "batch-err", tenantId: "tenant-al-baraka" },
      });
    });

    // [v4.7] The log must record what the batch was RECEIVED as (100 units for
    // 500,000), not what is left on the shelf (40) — that is the whole point
    // of the write-once initialQuantity / totalCostSYP fields.
    it("[v4.7] snapshots the ORIGINAL receipt quantity/total, not the live remaining quantity", async () => {
      mockProductBatch.findFirst.mockResolvedValueOnce(
        batchFixture({ id: "batch-snap", batchNumber: "B-SNAP" }) // live 40, initial 100
      );
      mockInvoiceItem.count.mockResolvedValueOnce(0);
      mockBatchDeletionLog.create.mockResolvedValueOnce({ id: "log-snap" });
      mockProductBatch.delete.mockResolvedValueOnce({ id: "batch-snap" });

      const res = await attemptHardDelete("batch-snap", "سبب الحذف للاختبار");
      expect(res.status).toBe(200);

      const data = mockBatchDeletionLog.create.mock.calls[0][0].data;
      expectDeletionSnapshot(data, {
        receiptId: "receipt-1",
        initial: "100",
        total: "500000",
        live: "40",
      });
      expect(new Prisma.Decimal(data.initialQuantityAtDeletion).eq(data.quantityAtDeletion)).toBe(
        false
      );
    });

    it("[v4.7] takes the snapshot from THE batch being deleted (different batches, different receipts)", async () => {
      const cases = [
        { id: "batch-x1", receiptId: "receipt-X", initial: "12.5000", total: "62500.0000", live: "3.0000" },
        { id: "batch-y1", receiptId: "receipt-Y", initial: "9000.0000", total: "1234.5000", live: "9000.0000" },
      ];

      for (const c of cases) {
        mockProductBatch.findFirst.mockResolvedValueOnce(
          batchFixture({
            id: c.id,
            receiptId: c.receiptId,
            initialQuantity: new Prisma.Decimal(c.initial),
            totalCostSYP: new Prisma.Decimal(c.total),
            quantity: new Prisma.Decimal(c.live),
          })
        );
        mockInvoiceItem.count.mockResolvedValueOnce(0);
        mockBatchDeletionLog.create.mockResolvedValueOnce({ id: `log-${c.id}` });
        mockProductBatch.delete.mockResolvedValueOnce({ id: c.id });

        const res = await attemptHardDelete(c.id, "سبب الحذف للاختبار");
        expect(res.status).toBe(200);
      }

      expect(mockBatchDeletionLog.create).toHaveBeenCalledTimes(2);
      cases.forEach((c, i) => {
        expectDeletionSnapshot(mockBatchDeletionLog.create.mock.calls[i][0].data, {
          receiptId: c.receiptId,
          initial: c.initial,
          total: c.total,
          live: c.live,
        });
      });
    });

    it("[v4.7] writes the log row BEFORE deleting the batch, inside a single transaction", async () => {
      mockProductBatch.findFirst.mockResolvedValueOnce(
        batchFixture({ id: "batch-order", batchNumber: "B-ORDER" })
      );
      mockInvoiceItem.count.mockResolvedValueOnce(0);
      mockBatchDeletionLog.create.mockResolvedValueOnce({ id: "log-order" });
      mockProductBatch.delete.mockResolvedValueOnce({ id: "batch-order" });

      const res = await attemptHardDelete("batch-order", "سبب الحذف للاختبار");
      expect(res.status).toBe(200);

      expect(mockRawPrisma.$transaction).toHaveBeenCalledTimes(1);
      const logOrder = mockBatchDeletionLog.create.mock.invocationCallOrder[0];
      const deleteOrder = mockProductBatch.delete.mock.invocationCallOrder[0];
      expect(logOrder).toBeLessThan(deleteOrder);
    });

    it("[v4.7] ignores receipt/snapshot values forged in the DELETE body", async () => {
      mockProductBatch.findFirst.mockResolvedValueOnce(
        batchFixture({ id: "batch-forge", batchNumber: "B-FORGE" })
      );
      mockInvoiceItem.count.mockResolvedValueOnce(0);
      mockBatchDeletionLog.create.mockResolvedValueOnce({ id: "log-forge" });
      mockProductBatch.delete.mockResolvedValueOnce({ id: "batch-forge" });

      const res = await deleteBatchHandler(
        new Request("http://localhost/api/inventory/batches/batch-forge", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            reason: "سبب الحذف للاختبار",
            receiptId: "forged-receipt",
            initialQuantityAtDeletion: "999999",
            totalCostAtDeletion: "1",
          }),
        }),
        { params: Promise.resolve({ id: "batch-forge" }) }
      );

      // Either outcome is safe: rejecting the unknown keys (4xx, nothing
      // written) or ignoring them (200, values taken from the DB row).
      if (res.status === 200) {
        expectDeletionSnapshot(mockBatchDeletionLog.create.mock.calls[0][0].data, {
          receiptId: "receipt-1",
          initial: "100",
          total: "500000",
          live: "40",
        });
      } else {
        expect(res.status).toBe(400);
        expect(mockBatchDeletionLog.create).not.toHaveBeenCalled();
        expect(mockProductBatch.delete).not.toHaveBeenCalled();
      }
    });

    it("blocks deletion if batch has InvoiceItem references (sales history exists)", async () => {
      mockProductBatch.findFirst.mockResolvedValueOnce({
        id: "batch-sold",
        tenantId: "tenant-al-baraka",
        productId: "prod-1",
        unitId: "unit-1",
        batchNumber: "B-SOLD",
        quantity: new Prisma.Decimal("5.0000"),
      });

      mockInvoiceItem.count.mockResolvedValueOnce(3);

      const req = new Request("http://localhost/api/inventory/batches/batch-sold", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reason: "محاولة حذف دفعة مباعة",
        }),
      });

      const res = await deleteBatchHandler(req, { params: Promise.resolve({ id: "batch-sold" }) });
      expect(res.status).toBe(400);

      const json = await res.json();
      expect(json.error).toBe("CANNOT_DELETE_BATCH_WITH_SALES");
      expect(mockProductBatch.delete).not.toHaveBeenCalled();
      expect(mockBatchDeletionLog.create).not.toHaveBeenCalled();
    });

    // ========================================================================
    // [v4.3 T1/T3c corrigendum — acceptance criteria #1 and #3]
    //
    // This test REPLACES the old "blocks deletion if batch has StockAdjustment
    // history but zero InvoiceItem references" assertion, which encoded the
    // very bug being fixed: a live `onDelete: Restrict` FK from StockAdjustment
    // to ProductBatch silently added a second, undocumented eligibility
    // condition. T3c states exactly one condition — zero InvoiceItem
    // references — and the API now implements exactly that.
    // ========================================================================
    it("hard-deletes a batch with zero InvoiceItem references but a prior StockAdjustment row", async () => {
      mockProductBatch.findFirst.mockResolvedValueOnce(
        batchFixture({
          id: "batch-adj-only",
          batchNumber: "B-ADJ",
          quantity: new Prisma.Decimal("7.0000"),
        })
      );

      mockInvoiceItem.count.mockResolvedValueOnce(0);
      mockBatchDeletionLog.create.mockResolvedValueOnce({ id: "log-adj" });
      mockProductBatch.delete.mockResolvedValueOnce({ id: "batch-adj-only" });

      const res = await attemptHardDelete("batch-adj-only", "حذف دفعة خضعت لتسوية سابقة");

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);

      // The prior reconciliation is irrelevant to eligibility: the delete path
      // never even counts adjustment rows anymore.
      expect(mockInvoiceItem.count).toHaveBeenCalledWith({
        where: { batchId: "batch-adj-only", tenantId: "tenant-al-baraka" },
      });
      expect(mockStockAdjustment.count).not.toHaveBeenCalled();

      expect(mockBatchDeletionLog.create).toHaveBeenCalledWith({
        data: {
          tenantId: "tenant-al-baraka",
          batchId: "batch-adj-only",
          productId: "prod-1",
          unitId: "unit-1",
          batchNumber: "B-ADJ",
          quantityAtDeletion: new Prisma.Decimal("7.0000"),
          costPriceAtDeletion: new Prisma.Decimal("5000.0000"),
          receiptId: "receipt-1",
          initialQuantityAtDeletion: new Prisma.Decimal("100.0000"),
          totalCostAtDeletion: new Prisma.Decimal("500000.0000"),
          deletedByUserId: "admin-user-id",
          reason: "حذف دفعة خضعت لتسوية سابقة",
        },
      });

      expect(mockProductBatch.delete).toHaveBeenCalledWith({
        where: { id: "batch-adj-only", tenantId: "tenant-al-baraka" },
      });

      // [criterion #3] The historical adjustment row is neither deleted nor
      // blocking — nothing in this handler touches it at all. It survives as a
      // standalone record, queryable by its own (tenantId, batchId) snapshot
      // fields plus productId/unitId/batchNumber.
      expect(mockStockAdjustment.delete).not.toHaveBeenCalled();
      expect(mockStockAdjustment.deleteMany).not.toHaveBeenCalled();
    });

    // [v4.3 T1/T3c corrigendum — acceptance criterion #1, end-to-end] The
    // literal acceptance scenario: create a batch, reconcile it once, then
    // hard-delete it. Both handlers run for real against the same mock, so a
    // regression in either the write path (missing snapshot fields) or the
    // delete path (reinstated adjustment guard) fails this test.
    it("reconcile → hard-delete: a reconciled batch can then be hard-deleted, and its adjustment survives", async () => {
      const batch = batchFixture({
        id: "batch-chain",
        batchNumber: "2026-09-27-CHAIN",
        quantity: new Prisma.Decimal("-3.0000"),
      });

      // Step 1 — reconcile once, writing the StockAdjustment row.
      mockProductBatch.findFirst.mockResolvedValueOnce(batch);
      mockStockAdjustment.create.mockResolvedValueOnce({
        id: "adj-chain",
        tenantId: "tenant-al-baraka",
        batchId: "batch-chain",
        productId: "prod-1",
        unitId: "unit-1",
        batchNumber: "2026-09-27-CHAIN",
        adjustedByUserId: "admin-user-id",
        quantityDelta: new Prisma.Decimal("5.0000"),
        reason: "جرد دوري وإضافة النقص",
        createdAt: new Date(),
        adjustedByUser: { id: "admin-user-id", name: "Admin", email: "admin@baraka.sy" },
      });
      mockProductBatch.update.mockResolvedValueOnce({
        ...batch,
        quantity: new Prisma.Decimal("2.0000"),
      });

      const reconcileRes = await reconcileHandler(
        new Request("http://localhost/api/inventory/batches/batch-chain/reconcile", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ quantityDelta: "5", reason: "جرد دوري وإضافة النقص" }),
        }),
        { params: Promise.resolve({ id: "batch-chain" }) }
      );
      expect(reconcileRes.status).toBe(200);
      expect(mockStockAdjustment.create).toHaveBeenCalledTimes(1);

      // Step 2 — the very same batch now has one StockAdjustment row and still
      // zero InvoiceItem references, so the hard delete must succeed.
      mockProductBatch.findFirst.mockResolvedValueOnce({
        ...batch,
        quantity: new Prisma.Decimal("2.0000"),
      });
      mockInvoiceItem.count.mockResolvedValueOnce(0);
      mockBatchDeletionLog.create.mockResolvedValueOnce({ id: "log-chain" });
      mockProductBatch.delete.mockResolvedValueOnce({ id: "batch-chain" });

      const deleteRes = await attemptHardDelete("batch-chain", "الدفعة مسجلة بالخطأ");
      expect(deleteRes.status).toBe(200);
      expect((await deleteRes.json()).success).toBe(true);

      expect(mockBatchDeletionLog.create).toHaveBeenCalledTimes(1);
      expect(mockProductBatch.delete).toHaveBeenCalledTimes(1);
      expectDeletionSnapshot(mockBatchDeletionLog.create.mock.calls[0][0].data, {
        receiptId: "receipt-1",
        initial: "100",
        total: "500000",
        live: "2",
      });
      // The adjustment written in step 1 is left completely alone.
      expect(mockStockAdjustment.delete).not.toHaveBeenCalled();
      expect(mockStockAdjustment.deleteMany).not.toHaveBeenCalled();
    });

    // ========================================================================
    // [v4.3 T1/T3c corrigendum — acceptance criterion #5] The identical hazard
    // exists one model over: CostPriceChangeLog. Its batchId was designed as a
    // plain snapshot field from the start (BatchDeletionLog's precedent), so no
    // code change is needed here — but the criterion must be proven, not
    // assumed: a batch whose only history is a cost-price correction deletes
    // normally, and that log row neither blocks nor disappears.
    // ========================================================================
    it("hard-deletes a batch whose only history is a prior CostPriceChangeLog row (ADMIN cost correction)", async () => {
      mockProductBatch.findFirst.mockResolvedValueOnce(
        batchFixture({
          id: "batch-cost-only",
          batchNumber: "B-COST",
          quantity: new Prisma.Decimal("4.0000"),
        })
      );

      mockInvoiceItem.count.mockResolvedValueOnce(0);
      mockBatchDeletionLog.create.mockResolvedValueOnce({ id: "log-cost" });
      mockProductBatch.delete.mockResolvedValueOnce({ id: "batch-cost-only" });

      const res = await attemptHardDelete("batch-cost-only", "دفعة مسجلة بالخطأ بعد تصحيح التكلفة");

      expect(res.status).toBe(200);
      expect((await res.json()).success).toBe(true);
      expect(mockBatchDeletionLog.create).toHaveBeenCalledTimes(1);
      expectDeletionSnapshot(mockBatchDeletionLog.create.mock.calls[0][0].data, {
        receiptId: "receipt-1",
        initial: "100",
        total: "500000",
        live: "4",
      });
      expect(mockProductBatch.delete).toHaveBeenCalledWith({
        where: { id: "batch-cost-only", tenantId: "tenant-al-baraka" },
      });

      // The delete path neither deletes the cost-price audit row nor even
      // looks at the model: there is no count guard, no existence check, and
      // no relation left to raise P2003 on.
      expect(mockCostPriceChangeLog.count).not.toHaveBeenCalled();
      expect(mockCostPriceChangeLog.findMany).not.toHaveBeenCalled();
      expect(mockCostPriceChangeLog.delete).not.toHaveBeenCalled();
      expect(mockCostPriceChangeLog.deleteMany).not.toHaveBeenCalled();
    });

    // ========================================================================
    // [v4.3 T1/T3c corrigendum — acceptance criterion #6] The realistic
    // combined case, in BOTH orders: one reconciliation and one ADMIN
    // cost-price correction written against the very same batch. Both audit
    // rows must survive the hard delete, and neither may block it. The
    // cost-price correction itself is T4g's write path (not built yet), so the
    // row is recorded through the same mocked model the delete path sees —
    // statefully, so "the row still exists afterwards" is a real assertion
    // rather than a mock-arity one.
    // ========================================================================
    it("hard-deletes a batch holding BOTH a StockAdjustment and a CostPriceChangeLog row (reconciliation first)", async () => {
      const batch = batchFixture({
        id: "batch-combined-a",
        batchNumber: "2026-09-27-COMBINED-A",
        quantity: new Prisma.Decimal("8.0000"),
      });
      const adjustments: any[] = [];
      const costPriceLogs: any[] = [];

      // 1. Reconcile once — the real handler, with a stateful mock.
      mockStockAdjustment.create.mockImplementationOnce(async ({ data }: any) => {
        const row = {
          id: "adj-combined-a",
          createdAt: new Date(),
          adjustedByUser: { id: "admin-user-id", name: "Admin", email: "admin@baraka.sy" },
          ...data,
        };
        adjustments.push(row);
        return row;
      });
      mockProductBatch.findFirst.mockResolvedValueOnce({
        ...batch,
        quantity: new Prisma.Decimal("-1.0000"),
      });
      mockProductBatch.update.mockResolvedValueOnce({
        ...batch,
        quantity: new Prisma.Decimal("9.0000"),
      });

      const reconcileRes = await reconcileHandler(
        new Request("http://localhost/api/inventory/batches/batch-combined-a/reconcile", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ quantityDelta: "2", reason: "جرد دوري" }),
        }),
        { params: Promise.resolve({ id: "batch-combined-a" }) }
      );
      expect(reconcileRes.status).toBe(200);
      expect(adjustments).toHaveLength(1);

      // 2. Correct the cost price once (T4g write path — simulated).
      mockCostPriceChangeLog.create.mockImplementationOnce(async ({ data }: any) => {
        const row = { id: "cost-combined-a", createdAt: new Date(), ...data };
        costPriceLogs.push(row);
        return row;
      });
      await mockRawPrisma.costPriceChangeLog.create({
        data: {
          tenantId: "tenant-al-baraka",
          batchId: "batch-combined-a",
          oldCostPrice: new Prisma.Decimal("5000.0000"),
          newCostPrice: new Prisma.Decimal("4500.0000"),
          changedByUserId: "admin-user-id",
          reason: "تصحيح سعر التكلفة",
        },
      });
      expect(costPriceLogs).toHaveLength(1);

      // 3. Zero InvoiceItem references — the delete must succeed, with one
      //    BatchDeletionLog row written as usual.
      mockProductBatch.findFirst.mockResolvedValueOnce({
        ...batch,
        quantity: new Prisma.Decimal("9.0000"),
      });
      mockInvoiceItem.count.mockResolvedValueOnce(0);
      mockBatchDeletionLog.create.mockResolvedValueOnce({ id: "log-combined-a" });
      mockProductBatch.delete.mockResolvedValueOnce({ id: "batch-combined-a" });

      const res = await attemptHardDelete(
        "batch-combined-a",
        "دفعة مسجلة بالخطأ رغم التسوية وتصحيح التكلفة"
      );
      expect(res.status).toBe(200);
      expect((await res.json()).success).toBe(true);

      // Both historical rows survive, untouched, still keyed to the deleted
      // batch by their snapshot batchId.
      expect(adjustments).toHaveLength(1);
      expect(costPriceLogs).toHaveLength(1);
      expect(adjustments[0].batchId).toBe("batch-combined-a");
      expect(costPriceLogs[0].batchId).toBe("batch-combined-a");

      expect(mockBatchDeletionLog.create).toHaveBeenCalledTimes(1);
      expectDeletionSnapshot(mockBatchDeletionLog.create.mock.calls[0][0].data, {
        receiptId: "receipt-1",
        initial: "100",
        total: "500000",
        live: "9",
      });
      expect(mockStockAdjustment.delete).not.toHaveBeenCalled();
      expect(mockStockAdjustment.deleteMany).not.toHaveBeenCalled();
      expect(mockCostPriceChangeLog.delete).not.toHaveBeenCalled();
      expect(mockCostPriceChangeLog.deleteMany).not.toHaveBeenCalled();
    });

    it("hard-deletes a batch holding BOTH rows written in the opposite order (cost correction first)", async () => {
      const batch = batchFixture({
        id: "batch-combined-b",
        batchNumber: "2026-09-27-COMBINED-B",
        quantity: new Prisma.Decimal("6.0000"),
      });
      const adjustments: any[] = [];
      const costPriceLogs: any[] = [];

      // 1. Cost-price correction first (T4g write path — simulated).
      mockCostPriceChangeLog.create.mockImplementationOnce(async ({ data }: any) => {
        const row = { id: "cost-combined-b", createdAt: new Date(), ...data };
        costPriceLogs.push(row);
        return row;
      });
      await mockRawPrisma.costPriceChangeLog.create({
        data: {
          tenantId: "tenant-al-baraka",
          batchId: "batch-combined-b",
          oldCostPrice: new Prisma.Decimal("5000.0000"),
          newCostPrice: new Prisma.Decimal("5200.0000"),
          changedByUserId: "admin-user-id",
          reason: "تصحيح سعر التكلفة",
        },
      });

      // 2. Then a reconciliation — the real handler.
      mockStockAdjustment.create.mockImplementationOnce(async ({ data }: any) => {
        const row = {
          id: "adj-combined-b",
          createdAt: new Date(),
          adjustedByUser: { id: "admin-user-id", name: "Admin", email: "admin@baraka.sy" },
          ...data,
        };
        adjustments.push(row);
        return row;
      });
      mockProductBatch.findFirst.mockResolvedValueOnce({
        ...batch,
        quantity: new Prisma.Decimal("1.0000"),
      });
      mockProductBatch.update.mockResolvedValueOnce({
        ...batch,
        quantity: new Prisma.Decimal("3.0000"),
      });

      const reconcileRes = await reconcileHandler(
        new Request("http://localhost/api/inventory/batches/batch-combined-b/reconcile", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ quantityDelta: "2", reason: "تسوية عجز" }),
        }),
        { params: Promise.resolve({ id: "batch-combined-b" }) }
      );
      expect(reconcileRes.status).toBe(200);
      expect(adjustments).toHaveLength(1);
      expect(costPriceLogs).toHaveLength(1);

      // 3. Delete.
      mockProductBatch.findFirst.mockResolvedValueOnce({
        ...batch,
        quantity: new Prisma.Decimal("3.0000"),
      });
      mockInvoiceItem.count.mockResolvedValueOnce(0);
      mockBatchDeletionLog.create.mockResolvedValueOnce({ id: "log-combined-b" });
      mockProductBatch.delete.mockResolvedValueOnce({ id: "batch-combined-b" });

      const res = await attemptHardDelete("batch-combined-b", "الدفعة مسجلة بالخطأ");
      expect(res.status).toBe(200);
      expect((await res.json()).success).toBe(true);

      expect(adjustments).toHaveLength(1);
      expect(costPriceLogs).toHaveLength(1);
      expect(mockBatchDeletionLog.create).toHaveBeenCalledTimes(1);
      expectDeletionSnapshot(mockBatchDeletionLog.create.mock.calls[0][0].data, {
        receiptId: "receipt-1",
        initial: "100",
        total: "500000",
        live: "3",
      });
      expect(mockStockAdjustment.deleteMany).not.toHaveBeenCalled();
      expect(mockCostPriceChangeLog.deleteMany).not.toHaveBeenCalled();
    });

    it("catches Prisma P2003 foreign-key violation cleanly without leaking internal error", async () => {
      mockProductBatch.findFirst.mockResolvedValueOnce(
        batchFixture({
          id: "batch-fk",
          batchNumber: "B-FK",
          quantity: new Prisma.Decimal("5.0000"),
        })
      );

      mockInvoiceItem.count.mockResolvedValueOnce(0);
      mockBatchDeletionLog.create.mockResolvedValueOnce({ id: "log-fk" });

      const p2003Error = new Prisma.PrismaClientKnownRequestError(
        "Foreign key constraint failed on the field",
        {
          code: "P2003",
          clientVersion: "6.0.0",
        }
      );
      mockProductBatch.delete.mockRejectedValueOnce(p2003Error);

      const req = new Request("http://localhost/api/inventory/batches/batch-fk", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reason: "حذف دفعة واجهت تعارض قيود أجنبية",
        }),
      });

      const res = await deleteBatchHandler(req, { params: Promise.resolve({ id: "batch-fk" }) });
      expect(res.status).toBe(400);

      const json = await res.json();
      expect(json.error).toBe("FOREIGN_KEY_VIOLATION");
    });

    it("blocks CASHIER from deleting a batch", async () => {
      mockSessionState.session.user.role = "CASHIER";

      const req = new Request("http://localhost/api/inventory/batches/batch-1", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reason: "محاولة كاشير لحذف دفعة",
        }),
      });

      const res = await deleteBatchHandler(req, { params: Promise.resolve({ id: "batch-1" }) });
      expect(res.status).toBe(403);
      expect(mockProductBatch.delete).not.toHaveBeenCalled();
    });
  });

  describe("3. Direct Non-Quantity Batch Edit (PATCH /api/inventory/batches/[id])", () => {
    it("updates batchNumberSuffix and expiryDate for ADMIN", async () => {
      mockProductBatch.findFirst.mockResolvedValueOnce({
        id: "batch-1",
        tenantId: "tenant-al-baraka",
        batchNumber: "2026-09-27-OLD",
        // [Batch cost entry] ProductBatch.costPricePerBaseUnit is REQUIRED
        // (non-nullable) — the PATCH response now serializes it, so the
        // fixture must carry a real value.
        costPricePerBaseUnit: new Prisma.Decimal("5000.0000"),
      });

      mockProductBatch.update.mockResolvedValueOnce({
        id: "batch-1",
        tenantId: "tenant-al-baraka",
        batchNumber: "2026-09-27-CORRECTED",
        expiryDate: new Date("2026-12-31"),
        quantity: new Prisma.Decimal("15.0000"),
        costPricePerBaseUnit: new Prisma.Decimal("5000.0000"),
        unit: { unitName: "قطعة" },
      });

      const req = new Request("http://localhost/api/inventory/batches/batch-1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          batchNumberSuffix: "CORRECTED",
          expiryDate: "2026-12-31",
        }),
      });

      const res = await patchBatchHandler(req, { params: Promise.resolve({ id: "batch-1" }) });
      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.batch.batchNumber).toBe("2026-09-27-CORRECTED");
    });

    it("explicitly blocks direct edits to quantity (must use reconciliation)", async () => {
      const req = new Request("http://localhost/api/inventory/batches/batch-1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          quantity: "20",
        }),
      });

      const res = await patchBatchHandler(req, { params: Promise.resolve({ id: "batch-1" }) });
      expect(res.status).toBe(400);

      const json = await res.json();
      expect(json.error).toBe("QUANTITY_IMMUTABLE_DIRECT_EDIT");
      expect(mockProductBatch.update).not.toHaveBeenCalled();
    });

    it("blocks CASHIER from updating batch fields", async () => {
      mockSessionState.session.user.role = "CASHIER";

      const req = new Request("http://localhost/api/inventory/batches/batch-1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          batchNumber: "NEW-NUM",
        }),
      });

      const res = await patchBatchHandler(req, { params: Promise.resolve({ id: "batch-1" }) });
      expect(res.status).toBe(403);
      expect(mockProductBatch.update).not.toHaveBeenCalled();
    });
  });

  describe("4. Batch Detail Query (GET /api/inventory/batches/[id])", () => {
    it("returns live batch quantity, expiry badges, and full adjustment history", async () => {
      mockProductBatch.findFirst.mockResolvedValueOnce({
        // [v4.3 T1/T3c corrigendum] No `adjustments` relation and no
        // `_count.adjustments` on the batch query anymore — the history is read
        // separately through StockAdjustment's plain snapshot (tenantId,
        // batchId) pair (mocked below), and the count is derived from its
        // length.
        id: "batch-1",
        tenantId: "tenant-al-baraka",
        productId: "prod-1",
        unitId: "unit-1",
        batchNumber: "B100",
        quantity: new Prisma.Decimal("12.0000"),
        // [Batch cost entry] REQUIRED (non-nullable) — the ADMIN batch-detail
        // payload serializes it via .toString().
        costPricePerBaseUnit: new Prisma.Decimal("1500.00000000"),
        expiryDate: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000),
        createdAt: new Date(),
        unit: { unitName: "كرتونة" },
        _count: { invoiceItems: 0 },
      });

      // findProductById() (lib/data/products.ts) is the sanctioned gateway and
      // reads tx.product.findUnique — it is a REAL module here (not mocked), so
      // the `product` model must exist on the Prisma mock or the route 500s.
      mockProduct.findUnique.mockResolvedValueOnce({
        id: "prod-1",
        name: "أرز بسمتي",
        category: "مواد غذائية",
      });

      // Adjustment history, by snapshot batchId (not a relation).
      mockStockAdjustment.findMany.mockResolvedValueOnce([
        {
          id: "adj-1",
          quantityDelta: new Prisma.Decimal("2.0000"),
          reason: "تسوية عجز",
          createdAt: new Date(),
          adjustedByUser: { id: "u1", name: "سامر", email: "samer@baraka.sy" },
        },
      ]);

      const req = new Request("http://localhost/api/inventory/batches/batch-1");
      const res = await getBatchHandler(req, { params: Promise.resolve({ id: "batch-1" }) });
      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.batch.productName).toBe("أرز بسمتي");
      expect(json.batch.quantity).toBe(12);
      expect(json.batch.expiryStatus).toBe("RED");
      expect(json.batch.adjustments).toHaveLength(1);
      expect(json.batch.adjustments[0].reason).toBe("تسوية عجز");
      expect(json.batch.adjustments[0].adjustedByUserName).toBe("سامر");
      // Response contract preserved: _count.adjustments is the history length.
      expect(json.batch._count.adjustments).toBe(1);
      expect(json.batch._count.invoiceItems).toBe(0);

      // Read through the plain snapshot pair, never a relation.
      expect(mockStockAdjustment.findMany).toHaveBeenCalledWith({
        where: { tenantId: "tenant-al-baraka", batchId: "batch-1" },
        select: {
          id: true,
          quantityDelta: true,
          reason: true,
          createdAt: true,
          adjustedByUser: { select: { id: true, name: true, email: true } },
        },
        orderBy: { createdAt: "desc" },
      });
    });
  });

  // ==========================================================================
  // [v4.3 T1/T3c corrigendum — acceptance criterion #4]
  //
  // Both halves of the fix are proven against the GENERATED PRISMA CLIENT's own
  // metadata (DMMF), not against the .prisma source text: what the application
  // actually gets at runtime is the generated client, so a source file that
  // merely looks right while the client was generated from something else would
  // still be broken. `Prisma.dmmf` IS that compiled datamodel — i.e. exactly
  // "inspecting the generated Prisma client's types".
  // ==========================================================================
  describe("5. Schema shape of the corrigendum (generated Prisma client metadata)", () => {
    type DmmfField = { name: string; kind: string; type: string };
    type DmmfModel = { name: string; fields: DmmfField[] };

    const dmmfModels = (Prisma.dmmf as unknown as { datamodel: { models: DmmfModel[] } })
      .datamodel.models;

    const modelNamed = (name: string) => dmmfModels.find((m) => m.name === name);
    const fieldNamed = (model: DmmfModel | undefined, name: string) =>
      model?.fields.find((f) => f.name === name);

    it("keeps StockAdjustment.batchId a plain scalar snapshot beside productId/unitId/batchNumber", () => {
      const stockAdjustment = modelNamed("StockAdjustment");
      expect(stockAdjustment).toBeDefined();

      for (const field of ["batchId", "productId", "unitId", "batchNumber"]) {
        expect(fieldNamed(stockAdjustment, field)?.kind).toBe("scalar");
      }
    });

    it("has NO relation from StockAdjustment to ProductBatch", () => {
      const stockAdjustment = modelNamed("StockAdjustment")!;
      const objectFields = stockAdjustment.fields.filter((f) => f.kind === "object");

      // The only relation fields left are the tenant scope and the audit user.
      expect(objectFields.map((f) => f.name).sort()).toEqual(["adjustedByUser", "tenant"]);
      expect(objectFields.some((f) => f.type === "ProductBatch")).toBe(false);
    });

    it("has NO `adjustments` back-relation field on ProductBatch", () => {
      const productBatch = modelNamed("ProductBatch")!;
      expect(fieldNamed(productBatch, "adjustments")).toBeUndefined();

      // The relations a batch still has. The snapshot logs (this one
      // included) are deliberately not among them. [v4.7] adds `receipt` —
      // the required goods-receiving header every batch now belongs to.
      expect(
        productBatch.fields
          .filter((f) => f.kind === "object")
          .map((f) => f.name)
          .sort()
      ).toEqual(["invoiceItems", "product", "receipt", "tenant", "unit"]);
    });

    it("keeps CostPriceChangeLog.batchId a plain scalar snapshot too (no ProductBatch relation)", () => {
      const costPriceChangeLog = modelNamed("CostPriceChangeLog");
      expect(costPriceChangeLog).toBeDefined();
      expect(fieldNamed(costPriceChangeLog, "batchId")?.kind).toBe("scalar");
      expect(
        costPriceChangeLog!.fields.some((f) => f.kind === "object" && f.type === "ProductBatch")
      ).toBe(false);
    });

    // [v4.7] The deletion log keeps receipt data as plain scalar snapshots —
    // a live relation to ProductReceipt/ProductBatch would either block the
    // hard delete or cascade the audit row away with it.
    it("[v4.7] keeps BatchDeletionLog's receipt fields plain scalars (no live relations)", () => {
      const log = modelNamed("BatchDeletionLog");
      expect(log).toBeDefined();

      for (const field of ["receiptId", "initialQuantityAtDeletion", "totalCostAtDeletion"]) {
        expect(fieldNamed(log, field)?.kind).toBe("scalar");
      }
      expect(
        log!.fields
          .filter((f) => f.kind === "object")
          .map((f) => f.name)
          .sort()
      ).toEqual(["deletedByUser", "tenant"]);
    });

    it("[v4.7] gives ProductBatch the scalar receiptId / initialQuantity / totalCostSYP fields", () => {
      const productBatch = modelNamed("ProductBatch");
      expect(fieldNamed(productBatch, "receiptId")?.kind).toBe("scalar");
      expect(fieldNamed(productBatch, "initialQuantity")).toMatchObject({
        kind: "scalar",
        type: "Decimal",
      });
      expect(fieldNamed(productBatch, "totalCostSYP")).toMatchObject({
        kind: "scalar",
        type: "Decimal",
      });
    });
  });
});