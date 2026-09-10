/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { expectTypeOf } from "vitest";
import {
  previewFifoAllocation,
  commitFifoAllocation,
  type AllocationPlan,
  type PreviewFifoParams,
  type CommitFifoParams,
} from "../fifo";
import { Prisma } from "@prisma/client";
import { getTenantDb } from "@/lib/db/tenant-scope";
import fs from "node:fs";
import path from "node:path";

// [FIX] previewFifoAllocation (lib/inventory/fifo.ts) was corrected to use
// getTenantDb(tenantId) instead of the raw `prisma` client imported from
// "@/lib/db" — see fifo.ts's own [FIX] comment on previewFifoAllocation for
// the full reasoning (T1's tenant-isolation architecture). This test file
// previously mocked "@/lib/db"'s `prisma` export, which is NOT the module
// previewFifoAllocation actually calls anymore — those mocks were silently
// never hit by the real code path, meaning these tests would either fail
// against real (unmocked) database calls or were validating a stale
// implementation. The mock target is now `getTenantDb` from
// "@/lib/db/tenant-scope", returning a fake tenant-scoped client whose
// shape mirrors the real one for the two models previewFifoAllocation
// touches (productUnit, productBatch).
const mockTenantDb = {
  productUnit: {
    findFirst: vi.fn(),
  },
  productBatch: {
    findMany: vi.fn(),
  },
};

vi.mock("@/lib/db/tenant-scope", () => ({
  getTenantDb: vi.fn(),
}));

describe("T3b — Shared FIFO Resolver (lib/inventory/fifo.ts)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getTenantDb).mockReturnValue(mockTenantDb as any);
  });

  describe("1. Compile-Time & Type Signatures Enforcement", () => {
    it("enforces previewFifoAllocation takes only PreviewFifoParams (no tx parameter)", () => {
      expectTypeOf(previewFifoAllocation).parameters.toEqualTypeOf<[PreviewFifoParams]>();
      expectTypeOf(previewFifoAllocation).returns.toEqualTypeOf<Promise<AllocationPlan>>();
    });

    it("enforces commitFifoAllocation strictly requires Prisma.TransactionClient as parameter 0", () => {
      expectTypeOf(commitFifoAllocation).parameters.toEqualTypeOf<
        [Prisma.TransactionClient, CommitFifoParams]
      >();
      expectTypeOf(commitFifoAllocation).returns.toEqualTypeOf<Promise<AllocationPlan>>();
    });
  });

  describe("2. Structural Source Code Guarantees", () => {
    const fifoSource = fs.readFileSync(
      path.resolve(process.cwd(), "lib/inventory/fifo.ts"),
      "utf-8"
    );

    it("does not export resolveFifoAllocation (single-function design rejected)", () => {
      expect(fifoSource).not.toMatch(/export\s+(async\s+)?function\s+resolveFifoAllocation/);
    });

    // [FIX] Was checking that commitFifoAllocation never imports the raw
    // `prisma` client — irrelevant now that previewFifoAllocation is the
    // one using a client at all outside `tx`. Kept the original intent
    // (previewFifoAllocation must never touch the raw, unscoped `prisma`
    // export — it must go through getTenantDb instead) but pointed at the
    // right function and the right claim.
    it("previewFifoAllocation never imports the raw unscoped prisma client", () => {
      const importsSection = fifoSource.slice(0, fifoSource.indexOf("export async function previewFifoAllocation"));
      expect(importsSection).not.toMatch(/import\s*{\s*prisma\s*}\s*from\s*["']@\/lib\/db["']/);
      expect(fifoSource).toMatch(/import\s*{\s*getTenantDb\s*}\s*from\s*["']@\/lib\/db\/tenant-scope["']/);
    });

    it("commitFifoAllocation contains no internal call to $queryRaw or tenantScopedRawQuery", () => {
      const commitBody = fifoSource.slice(fifoSource.indexOf("export async function commitFifoAllocation"));
      expect(commitBody).not.toMatch(/\$queryRaw/);
      expect(commitBody).not.toMatch(/tenantScopedRawQuery/);
      expect(commitBody).not.toMatch(/FOR UPDATE/);
    });

    it("previewFifoAllocation contains no database write operations or transactions", () => {
      // [FIX] The slice previously ended at the literal string
      // "export async function commitFifoAllocation" — but commitFifoAllocation's
      // own JSDoc comment (which mentions "prisma.$transaction(async (tx) =>
      // ...)" in prose, describing HOW commitFifoAllocation is used
      // elsewhere) sits ABOVE that literal, so it was included inside
      // `previewBody` and made this test fail on a false positive: the
      // match was inside a comment, not inside previewFifoAllocation's
      // actual code. The slice now ends at the start of that next JSDoc
      // block (the first "/**" after previewFifoAllocation begins), so only
      // previewFifoAllocation's own code and its own leading comment are
      // included — never a neighboring function's docstring.
      const previewStart = fifoSource.indexOf("export async function previewFifoAllocation");
      const nextDocBlockStart = fifoSource.indexOf("/**", previewStart + 1);
      const previewBody = fifoSource.slice(previewStart, nextDocBlockStart);

      expect(previewBody).not.toMatch(/\$transaction/);
      expect(previewBody).not.toMatch(/\.(create|update|delete|upsert|createMany|updateMany|deleteMany)\(/);
    });
  });

  describe("3. FIFO Ordering Logic (expiryDate ASC NULLS LAST, id ASC tie-break)", () => {
    it("sorts batches by earliest expiry date first, null expiry dates last, and id ASC tie-break", async () => {
      const mockUnit = {
        id: "unit-piece",
        unitName: "قطعة",
        conversionFactor: 1,
      };

      const mockBatches = [
        {
          id: "batch-D-null-exp-2",
          batchNumber: "BN-D",
          quantity: 10,
          expiryDate: null,
          createdAt: new Date("2026-01-01"),
          unitId: "unit-piece",
          unit: mockUnit,
        },
        {
          id: "batch-B-exp-oct",
          batchNumber: "BN-B",
          quantity: 10,
          expiryDate: new Date("2026-10-01T00:00:00Z"),
          createdAt: new Date("2026-01-01"),
          unitId: "unit-piece",
          unit: mockUnit,
        },
        {
          id: "batch-A-exp-sep",
          batchNumber: "BN-A",
          quantity: 10,
          expiryDate: new Date("2026-09-01T00:00:00Z"),
          createdAt: new Date("2026-01-01"),
          unitId: "unit-piece",
          unit: mockUnit,
        },
        {
          id: "batch-C-null-exp-1",
          batchNumber: "BN-C",
          quantity: 10,
          expiryDate: null,
          createdAt: new Date("2026-01-01"),
          unitId: "unit-piece",
          unit: mockUnit,
        },
      ];

      mockTenantDb.productUnit.findFirst.mockResolvedValue(mockUnit as any);
      mockTenantDb.productBatch.findMany.mockResolvedValue(mockBatches as any);

      const plan = await previewFifoAllocation({
        tenantId: "tenant-1",
        productId: "prod-1",
        unitId: "unit-piece",
        requestedQty: 35,
      });

      expect(plan.isSufficient).toBe(true);
      expect(plan.allocations).toHaveLength(4);
      expect(plan.allocations[0].batchId).toBe("batch-A-exp-sep");
      expect(plan.allocations[0].allocatedQty).toBe(10);
      expect(plan.allocations[1].batchId).toBe("batch-B-exp-oct");
      expect(plan.allocations[1].allocatedQty).toBe(10);
      expect(plan.allocations[2].batchId).toBe("batch-C-null-exp-1");
      expect(plan.allocations[2].allocatedQty).toBe(10);
      expect(plan.allocations[3].batchId).toBe("batch-D-null-exp-2");
      expect(plan.allocations[3].allocatedQty).toBe(5);
    });

    it("breaks ties with id ASC when expiry dates are identical", async () => {
      const mockUnit = {
        id: "unit-piece",
        unitName: "قطعة",
        conversionFactor: 1,
      };

      const mockBatches = [
        {
          id: "batch-z-2",
          batchNumber: "BN-2",
          quantity: 10,
          expiryDate: new Date("2026-12-01T00:00:00Z"),
          createdAt: new Date("2026-01-01"),
          unitId: "unit-piece",
          unit: mockUnit,
        },
        {
          id: "batch-a-1",
          batchNumber: "BN-1",
          quantity: 10,
          expiryDate: new Date("2026-12-01T00:00:00Z"),
          createdAt: new Date("2026-01-01"),
          unitId: "unit-piece",
          unit: mockUnit,
        },
      ];

      mockTenantDb.productUnit.findFirst.mockResolvedValue(mockUnit as any);
      mockTenantDb.productBatch.findMany.mockResolvedValue(mockBatches as any);

      const plan = await previewFifoAllocation({
        tenantId: "tenant-1",
        productId: "prod-1",
        unitId: "unit-piece",
        requestedQty: 15,
      });

      expect(plan.allocations[0].batchId).toBe("batch-a-1");
      expect(plan.allocations[0].allocatedQty).toBe(10);
      expect(plan.allocations[1].batchId).toBe("batch-z-2");
      expect(plan.allocations[1].allocatedQty).toBe(5);
    });
  });

  describe("4. Multi-Unit Conversions & Batch Deductions Math", () => {
    it("converts requested carton packaging units into batch piece units correctly", async () => {
      const cartonUnit = {
        id: "unit-carton",
        unitName: "كرتونة",
        conversionFactor: 12,
      };

      const pieceUnit = {
        id: "unit-piece",
        unitName: "قطعة",
        conversionFactor: 1,
      };

      const mockBatches = [
        {
          id: "batch-1",
          batchNumber: "BN-01",
          quantity: 18,
          expiryDate: new Date("2026-05-01"),
          createdAt: new Date("2026-01-01"),
          unitId: "unit-piece",
          unit: pieceUnit,
        },
        {
          id: "batch-2",
          batchNumber: "BN-02",
          quantity: 30,
          expiryDate: new Date("2026-06-01"),
          createdAt: new Date("2026-01-01"),
          unitId: "unit-piece",
          unit: pieceUnit,
        },
      ];

      mockTenantDb.productUnit.findFirst.mockResolvedValue(cartonUnit as any);
      mockTenantDb.productBatch.findMany.mockResolvedValue(mockBatches as any);

      const plan = await previewFifoAllocation({
        tenantId: "tenant-1",
        productId: "prod-rice",
        unitId: "unit-carton",
        requestedQty: 3,
      });

      expect(plan.isSufficient).toBe(true);
      expect(plan.totalAllocatedQty).toBe(3);
      expect(plan.remainingQty).toBe(0);
      expect(plan.allocations).toHaveLength(2);

      expect(plan.allocations[0].batchId).toBe("batch-1");
      expect(plan.allocations[0].allocatedQty).toBe(1.5);
      expect(plan.allocations[0].deductQtyInBatchUnit).toBe(18);
      expect(plan.allocations[0].batchUnitId).toBe("unit-piece");

      expect(plan.allocations[1].batchId).toBe("batch-2");
      expect(plan.allocations[1].allocatedQty).toBe(1.5);
      expect(plan.allocations[1].deductQtyInBatchUnit).toBe(18);
      expect(plan.allocations[1].batchUnitId).toBe("unit-piece");
    });
  });

  describe("5. Shortfall / Insufficient Stock Handling", () => {
    it("reports isSufficient: false and calculates remainingQty when stock is insufficient", async () => {
      const mockUnit = {
        id: "unit-piece",
        unitName: "قطعة",
        conversionFactor: 1,
      };

      const mockBatches = [
        {
          id: "batch-1",
          batchNumber: "BN-01",
          quantity: 7,
          expiryDate: new Date("2026-05-01"),
          createdAt: new Date("2026-01-01"),
          unitId: "unit-piece",
          unit: mockUnit,
        },
      ];

      mockTenantDb.productUnit.findFirst.mockResolvedValue(mockUnit as any);
      mockTenantDb.productBatch.findMany.mockResolvedValue(mockBatches as any);

      const plan = await previewFifoAllocation({
        tenantId: "tenant-1",
        productId: "prod-1",
        unitId: "unit-piece",
        requestedQty: 10,
      });

      expect(plan.isSufficient).toBe(false);
      expect(plan.totalAllocatedQty).toBe(7);
      expect(plan.remainingQty).toBe(3);
      expect(plan.allocations).toHaveLength(1);
      expect(plan.allocations[0].allocatedQty).toBe(7);
    });

    it("handles zero available batches gracefully", async () => {
      const mockUnit = {
        id: "unit-piece",
        unitName: "قطعة",
        conversionFactor: 1,
      };

      mockTenantDb.productUnit.findFirst.mockResolvedValue(mockUnit as any);
      mockTenantDb.productBatch.findMany.mockResolvedValue([]);

      const plan = await previewFifoAllocation({
        tenantId: "tenant-1",
        productId: "prod-1",
        unitId: "unit-piece",
        requestedQty: 5,
      });

      expect(plan.isSufficient).toBe(false);
      expect(plan.totalAllocatedQty).toBe(0);
      expect(plan.remainingQty).toBe(5);
      expect(plan.allocations).toEqual([]);
    });
  });

  describe("6. Validation & Tenant Isolation Guardrails", () => {
    it("rejects non-positive requestedQty with clear Arabic error", async () => {
      await expect(
        previewFifoAllocation({
          tenantId: "tenant-1",
          productId: "prod-1",
          unitId: "unit-1",
          requestedQty: 0,
        })
      ).rejects.toThrow("الكمية المطلوبة يجب أن تكون أكبر من الصفر.");

      await expect(
        previewFifoAllocation({
          tenantId: "tenant-1",
          productId: "prod-1",
          unitId: "unit-1",
          requestedQty: -5,
        })
      ).rejects.toThrow("الكمية المطلوبة يجب أن تكون أكبر من الصفر.");
    });

    it("rejects missing or empty tenantId", async () => {
      await expect(
        previewFifoAllocation({
          tenantId: "   ",
          productId: "prod-1",
          unitId: "unit-1",
          requestedQty: 1,
        })
      ).rejects.toThrow("Tenant isolation error");
    });

    it("rejects non-existent product packaging unit", async () => {
      mockTenantDb.productUnit.findFirst.mockResolvedValue(null);

      await expect(
        previewFifoAllocation({
          tenantId: "tenant-1",
          productId: "prod-1",
          unitId: "non-existent-unit",
          requestedQty: 1,
        })
      ).rejects.toThrow("وحدة القياس المطلوبة غير موجودة لهذا المنتج.");
    });
  });

  describe("7. commitFifoAllocation Transactional Execution", () => {
    it("reads candidate batches directly via provided tx client", async () => {
      const mockUnit = {
        id: "unit-1",
        unitName: "قطعة",
        conversionFactor: 1,
      };

      const mockBatch = {
        id: "batch-1",
        batchNumber: "BN-01",
        quantity: 10,
        expiryDate: new Date("2026-05-01"),
        createdAt: new Date("2026-01-01"),
        unitId: "unit-1",
        unit: mockUnit,
      };

      // commitFifoAllocation takes `tx` directly as its first argument — it
      // never goes through getTenantDb() at all, so this mock is
      // independent of the getTenantDb mock set up in beforeEach above.
      const mockTx = {
        productUnit: {
          findFirst: vi.fn().mockResolvedValue(mockUnit),
        },
        productBatch: {
          findMany: vi.fn().mockResolvedValue([mockBatch]),
        },
      } as unknown as Prisma.TransactionClient;

      const plan = await commitFifoAllocation(mockTx, {
        tenantId: "tenant-1",
        productId: "prod-1",
        unitId: "unit-1",
        requestedQty: 5,
      });

      expect(mockTx.productUnit.findFirst).toHaveBeenCalledWith({
        where: {
          id: "unit-1",
          productId: "prod-1",
          tenantId: "tenant-1",
        },
        select: {
          id: true,
          unitName: true,
          conversionFactor: true,
        },
      });

      expect(mockTx.productBatch.findMany).toHaveBeenCalledWith({
        where: {
          tenantId: "tenant-1",
          productId: "prod-1",
          quantity: { gt: 0 },
        },
        include: {
          unit: true,
        },
      });

      expect(plan.isSufficient).toBe(true);
      expect(plan.totalAllocatedQty).toBe(5);
      expect(plan.allocations[0].batchId).toBe("batch-1");
    });
  });
});