/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";

const {
  mockTenant,
  mockProductBatch,
  mockInvoiceItem,
  mockStockAdjustment,
  mockBatchDeletionLog,
  mockRawPrisma,
  mockSessionState,
} = vi.hoisted(() => {
  const mockTenant = {
    findUnique: vi.fn(),
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
  const mockStockAdjustment = {
    count: vi.fn(),
    create: vi.fn(),
    findMany: vi.fn(),
  };
  const mockBatchDeletionLog = {
    create: vi.fn(),
    findMany: vi.fn(),
  };

  const mockRawPrisma: any = {
    tenant: mockTenant,
    productBatch: mockProductBatch,
    invoiceItem: mockInvoiceItem,
    stockAdjustment: mockStockAdjustment,
    batchDeletionLog: mockBatchDeletionLog,
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
    mockProductBatch,
    mockInvoiceItem,
    mockStockAdjustment,
    mockBatchDeletionLog,
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

      expect(mockProductBatch.update).toHaveBeenCalledWith({
        where: { id: "batch-1", tenantId: "tenant-al-baraka" },
        data: {
          quantity: {
            increment: "5",
          },
        },
        include: { unit: true },
      });

      expect(mockStockAdjustment.create).toHaveBeenCalledTimes(1);
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
    it("hard-deletes batch with zero sales and zero adjustments, writing a snapshot to BatchDeletionLog", async () => {
      mockProductBatch.findFirst.mockResolvedValueOnce({
        id: "batch-err",
        tenantId: "tenant-al-baraka",
        productId: "prod-1",
        unitId: "unit-1",
        batchNumber: "TYPO-999",
        quantity: new Prisma.Decimal("10.0000"),
      });

      mockInvoiceItem.count.mockResolvedValueOnce(0);
      mockStockAdjustment.count.mockResolvedValueOnce(0);
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
          deletedByUserId: "admin-user-id",
          reason: "تم إدخال الدفعة بالخطأ وبشكل مكرر",
        },
      });

      expect(mockProductBatch.delete).toHaveBeenCalledWith({
        where: { id: "batch-err", tenantId: "tenant-al-baraka" },
      });
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

    it("blocks deletion if batch has StockAdjustment history but zero InvoiceItem references", async () => {
      mockProductBatch.findFirst.mockResolvedValueOnce({
        id: "batch-adj-only",
        tenantId: "tenant-al-baraka",
        productId: "prod-1",
        unitId: "unit-1",
        batchNumber: "B-ADJ",
        quantity: new Prisma.Decimal("7.0000"),
      });

      mockInvoiceItem.count.mockResolvedValueOnce(0);
      mockStockAdjustment.count.mockResolvedValueOnce(1);

      const req = new Request("http://localhost/api/inventory/batches/batch-adj-only", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reason: "محاولة حذف دفعة خضعت لتسوية سابقة",
        }),
      });

      const res = await deleteBatchHandler(req, {
        params: Promise.resolve({ id: "batch-adj-only" }),
      });
      expect(res.status).toBe(400);

      const json = await res.json();
      expect(json.error).toBe("CANNOT_DELETE_RECONCILED_BATCH");
      expect(mockProductBatch.delete).not.toHaveBeenCalled();
      expect(mockBatchDeletionLog.create).not.toHaveBeenCalled();
    });

    it("catches Prisma P2003 foreign-key violation cleanly without leaking internal error", async () => {
      mockProductBatch.findFirst.mockResolvedValueOnce({
        id: "batch-fk",
        tenantId: "tenant-al-baraka",
        productId: "prod-1",
        unitId: "unit-1",
        batchNumber: "B-FK",
        quantity: new Prisma.Decimal("5.0000"),
      });

      mockInvoiceItem.count.mockResolvedValueOnce(0);
      mockStockAdjustment.count.mockResolvedValueOnce(0);
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
    it("updates batchNumber and expiryDate for ADMIN", async () => {
      mockProductBatch.findFirst.mockResolvedValueOnce({
        id: "batch-1",
        tenantId: "tenant-al-baraka",
      });

      mockProductBatch.update.mockResolvedValueOnce({
        id: "batch-1",
        tenantId: "tenant-al-baraka",
        batchNumber: "BATCH-CORRECTED-2026",
        expiryDate: new Date("2026-12-31"),
        quantity: new Prisma.Decimal("15.0000"),
        unit: { unitName: "قطعة" },
      });

      const req = new Request("http://localhost/api/inventory/batches/batch-1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          batchNumber: "BATCH-CORRECTED-2026",
          expiryDate: "2026-12-31",
        }),
      });

      const res = await patchBatchHandler(req, { params: Promise.resolve({ id: "batch-1" }) });
      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.batch.batchNumber).toBe("BATCH-CORRECTED-2026");
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
        id: "batch-1",
        tenantId: "tenant-al-baraka",
        productId: "prod-1",
        unitId: "unit-1",
        batchNumber: "B100",
        quantity: new Prisma.Decimal("12.0000"),
        expiryDate: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000),
        createdAt: new Date(),
        unit: { unitName: "كرتونة" },
        product: { id: "prod-1", name: "أرز بسمتي", category: "مواد غذائية" },
        adjustments: [
          {
            id: "adj-1",
            quantityDelta: new Prisma.Decimal("2.0000"),
            reason: "تسوية عجز",
            createdAt: new Date(),
            adjustedByUser: { id: "u1", name: "سامر", email: "samer@baraka.sy" },
          },
        ],
        _count: {
          invoiceItems: 0,
          adjustments: 1,
        },
      });

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
      expect(json.batch._count.adjustments).toBe(1);
    });
  });
});