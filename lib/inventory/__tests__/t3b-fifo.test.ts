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
import { getTenantDb } from "@/lib/db/tenant-scope";
import { requireBaseUnit, MissingBaseUnitError } from "@/lib/inventory/base-unit";
import fs from "node:fs";
import path from "node:path";

/**
 * [REWRITE — full alignment with the current, v4.0-corrected fifo.ts]
 *
 * The previous version of this test file targeted a PRE-v4.0-correction
 * shape of fifo.ts that no longer exists:
 *   - It mocked `tx.productUnit.findFirst()` / `getTenantDb().productUnit.findFirst()`
 *     directly, as if fifo.ts resolved the requested unit itself. The
 *     current fifo.ts NEVER touches ProductUnit at all — it resolves the
 *     product's base unit exclusively via lib/inventory/base-unit.ts's
 *     requireBaseUnit(), which this file must therefore mock instead.
 *   - It exercised a "convert requested carton units into batch piece
 *     units" scenario via `conversionFactor` on mocked units. Per T3b's
 *     CORRECTION NOTE and its own Acceptance Criteria ("fifo.ts itself
 *     contains no reference to conversionFactor in any form"), this
 *     conversion no longer happens inside fifo.ts at all — the caller
 *     (T4b/T4c/T5) must convert requestedQty into the base unit via
 *     toBaseUnit() BEFORE calling either function here. That whole test
 *     scenario is invalid under the current design and is replaced below
 *     with a test of assertUnitIsBaseUnit()'s mismatch guard instead.
 *   - It asserted numeric (not decimal-string) output fields
 *     (allocatedQty: 10, totalAllocatedQty: 3, etc.) and a
 *     "وحدة القياس المطلوبة غير موجودة لهذا المنتج." error message that no
 *     longer exists anywhere in fifo.ts. Every quantity-shaped output is
 *     now a decimal-serialized STRING (`.toFixed(4)`), and an
 *     unresolvable/mismatched unit now surfaces as either
 *     MissingBaseUnitError (propagated from requireBaseUnit) or the
 *     literal "Unit mismatch: ..." Error thrown by assertUnitIsBaseUnit().
 *   - It typed commitFifoAllocation's first parameter as
 *     `Prisma.TransactionClient` exactly. The corrected fifo.ts widens
 *     this to `TxOrClient` (lib/db/tenant-scope.ts) so it can be invoked
 *     with either a real transaction client or the plain tenant-scoped
 *     client — see tenant-scope.ts's header for why the two are not
 *     structurally identical in this codebase. The strict
 *     parameter-equality type test is removed in favor of a runtime
 *     assignability check (a plain mock object satisfying the minimal
 *     shape fifo.ts actually calls), which is what real callers
 *     (app/api/sync/route.ts, T5's B2B approval) rely on in practice.
 *
 * Mock target for previewFifoAllocation: getTenantDb (lib/db/tenant-scope)
 * → its returned client's `.productBatch.findMany()`, PLUS
 * lib/inventory/base-unit.ts's requireBaseUnit() (mocked at the module
 * level, since fifo.ts imports and calls it directly — it is NOT
 * re-derived from a raw Prisma call inside fifo.ts itself).
 *
 * Mock target for commitFifoAllocation: a plain `tx`-shaped object with
 * `.productBatch.findMany()`, passed directly as the first argument
 * (never through getTenantDb) — plus the same requireBaseUnit() mock.
 */

const mockTenantDb = {
  productBatch: {
    findMany: vi.fn(),
  },
};

vi.mock("@/lib/db/tenant-scope", () => ({
  getTenantDb: vi.fn(),
}));

vi.mock("@/lib/inventory/base-unit", () => ({
  requireBaseUnit: vi.fn(),
  MissingBaseUnitError: class MissingBaseUnitError extends Error {
    constructor(productId: string) {
      super(`Product ${productId} has no baseUnitId.`);
      this.name = "MissingBaseUnitError";
    }
  },
}));

describe("T3b — Shared FIFO Resolver (lib/inventory/fifo.ts)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getTenantDb).mockReturnValue(mockTenantDb as any);
  });

  describe("1. Compile-Time & Runtime Signature Enforcement", () => {
    it("enforces previewFifoAllocation takes only PreviewFifoParams (no tx parameter)", () => {
      expectTypeOf(previewFifoAllocation).parameters.toEqualTypeOf<[PreviewFifoParams]>();
      expectTypeOf(previewFifoAllocation).returns.toEqualTypeOf<Promise<AllocationPlan>>();
    });

    it("commitFifoAllocation's first parameter is a required tx client — omitting it is a compile error", () => {
      // @ts-expect-error — tx is required; calling with only params must not compile.
      commitFifoAllocation({
        tenantId: "tenant-1",
        productId: "prod-1",
        unitId: "unit-1",
        requestedQty: "5",
      });
    });

    it("commitFifoAllocation accepts a plain tx-shaped object exposing only productBatch.findMany (TxOrClient, not strictly Prisma.TransactionClient)", async () => {
      const mockTx = {
        productBatch: { findMany: vi.fn().mockResolvedValue([]) },
      };
      vi.mocked(requireBaseUnit).mockResolvedValue({ id: "unit-1", unitName: "قطعة" } as any);

      // Runtime assignability: this must not throw a type-shape error at
      // the call site. The real proof this signature is TxOrClient (not
      // the raw, unextended Prisma.TransactionClient exactly) is that
      // app/api/sync/route.ts calls this with a raw client and
      // app/api/inventory/products/[id]/route.ts calls it with an
      // extended one — both compile against the real fifo.ts.
      const plan = await commitFifoAllocation(mockTx as any, {
        tenantId: "tenant-1",
        productId: "prod-1",
        unitId: "unit-1",
        requestedQty: "5",
      });
      expect(plan.allocations).toEqual([]);
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

    // [T3b Acceptance Criteria] "fifo.ts itself contains no reference to
    // conversionFactor in any form — verified by static analysis of every
    // call site in the file." This is the single most important
    // structural guarantee this revision of fifo.ts makes — see the
    // CORRECTION NOTE at the top of fifo.ts for why the previous version
    // violated it.
    it("contains no reference to conversionFactor anywhere in the file", () => {
      expect(fifoSource).not.toMatch(/conversionFactor/);
    });

    it("previewFifoAllocation never imports the raw unscoped prisma client, and does use getTenantDb", () => {
      const importsSection = fifoSource.slice(0, fifoSource.indexOf("export async function previewFifoAllocation"));
      expect(importsSection).not.toMatch(/import\s*{\s*prisma\s*}\s*from\s*["']@\/lib\/db["']/);
      expect(fifoSource).toMatch(/import\s*{\s*getTenantDb\s*}\s*from\s*["']@\/lib\/db\/tenant-scope["']/);
    });

    it("commitFifoAllocation contains no internal call to $queryRaw or tenantScopedRawQuery", () => {
      const commitStart = fifoSource.indexOf("export async function commitFifoAllocation");
      const commitBody = fifoSource.slice(commitStart);
      expect(commitBody).not.toMatch(/\$queryRaw/);
      expect(commitBody).not.toMatch(/tenantScopedRawQuery/);
      expect(commitBody).not.toMatch(/FOR UPDATE/);
    });

    it("previewFifoAllocation contains no database write operations or transactions", () => {
      // Slice ends at the next JSDoc block ("/**") after
      // previewFifoAllocation begins, so a neighboring function's
      // docstring (which may mention $transaction/create in prose) is
      // never accidentally included in the slice being checked.
      const previewStart = fifoSource.indexOf("export async function previewFifoAllocation");
      const nextDocBlockStart = fifoSource.indexOf("/**", previewStart + 1);
      const previewBody = fifoSource.slice(previewStart, nextDocBlockStart === -1 ? undefined : nextDocBlockStart);

      expect(previewBody).not.toMatch(/\$transaction/);
      expect(previewBody).not.toMatch(/\.(create|update|delete|upsert|createMany|updateMany|deleteMany)\(/);
    });
  });

  describe("3. FIFO Ordering Logic (expiryDate ASC NULLS LAST, id ASC tie-break)", () => {
    const mockBaseUnit = { id: "unit-piece", unitName: "قطعة" };

    it("sorts batches by earliest expiry date first, null expiry dates last, and id ASC tie-break", async () => {
      const mockBatches = [
        { id: "batch-D-null-exp-2", batchNumber: "BN-D", quantity: "10", expiryDate: null },
        { id: "batch-B-exp-oct", batchNumber: "BN-B", quantity: "10", expiryDate: new Date("2026-10-01T00:00:00Z") },
        { id: "batch-A-exp-sep", batchNumber: "BN-A", quantity: "10", expiryDate: new Date("2026-09-01T00:00:00Z") },
        { id: "batch-C-null-exp-1", batchNumber: "BN-C", quantity: "10", expiryDate: null },
      ];

      vi.mocked(requireBaseUnit).mockResolvedValue(mockBaseUnit as any);
      mockTenantDb.productBatch.findMany.mockResolvedValue(mockBatches as any);

      const plan = await previewFifoAllocation({
        tenantId: "tenant-1",
        productId: "prod-1",
        unitId: "unit-piece",
        requestedQty: "35",
      });

      expect(plan.isSufficient).toBe(true);
      expect(plan.allocations).toHaveLength(4);
      expect(plan.allocations[0].batchId).toBe("batch-A-exp-sep");
      expect(plan.allocations[0].allocatedQty).toBe("10.0000");
      expect(plan.allocations[1].batchId).toBe("batch-B-exp-oct");
      expect(plan.allocations[1].allocatedQty).toBe("10.0000");
      expect(plan.allocations[2].batchId).toBe("batch-C-null-exp-1");
      expect(plan.allocations[2].allocatedQty).toBe("10.0000");
      expect(plan.allocations[3].batchId).toBe("batch-D-null-exp-2");
      expect(plan.allocations[3].allocatedQty).toBe("5.0000");
    });

    it("breaks ties with id ASC (raw code-point order) when expiry dates are identical", async () => {
      const mockBatches = [
        { id: "batch-z-2", batchNumber: "BN-2", quantity: "10", expiryDate: new Date("2026-12-01T00:00:00Z") },
        { id: "batch-a-1", batchNumber: "BN-1", quantity: "10", expiryDate: new Date("2026-12-01T00:00:00Z") },
      ];

      vi.mocked(requireBaseUnit).mockResolvedValue(mockBaseUnit as any);
      mockTenantDb.productBatch.findMany.mockResolvedValue(mockBatches as any);

      const plan = await previewFifoAllocation({
        tenantId: "tenant-1",
        productId: "prod-1",
        unitId: "unit-piece",
        requestedQty: "15",
      });

      expect(plan.allocations[0].batchId).toBe("batch-a-1");
      expect(plan.allocations[0].allocatedQty).toBe("10.0000");
      expect(plan.allocations[1].batchId).toBe("batch-z-2");
      expect(plan.allocations[1].allocatedQty).toBe("5.0000");
    });
  });

  describe("4. Unit-Mismatch Guard (assertUnitIsBaseUnit)", () => {
    // [REPLACES the old "Multi-Unit Conversions" section] fifo.ts no
    // longer converts between units at all — it only ever operates on
    // ProductBatch.quantity, which is always base-unit by construction.
    // The one unit-related check left inside this file is a GUARD: the
    // caller must have already resolved and converted against the real
    // base unit before calling in; a mismatch is a caller/integration
    // bug and must fail loud, never silently "helped" by a conversion
    // fifo.ts has no business performing.
    it("throws a clear 'Unit mismatch' error when the supplied unitId is not the product's actual base unit", async () => {
      vi.mocked(requireBaseUnit).mockResolvedValue({ id: "unit-piece", unitName: "قطعة" } as any);
      mockTenantDb.productBatch.findMany.mockResolvedValue([]);

      await expect(
        previewFifoAllocation({
          tenantId: "tenant-1",
          productId: "prod-1",
          unitId: "unit-carton", // NOT the base unit
          requestedQty: "3",
        })
      ).rejects.toThrow(/Unit mismatch/);
    });

    it("succeeds when the supplied unitId matches the resolved base unit exactly", async () => {
      vi.mocked(requireBaseUnit).mockResolvedValue({ id: "unit-piece", unitName: "قطعة" } as any);
      mockTenantDb.productBatch.findMany.mockResolvedValue([
        { id: "batch-1", batchNumber: "BN-01", quantity: "18", expiryDate: new Date("2026-05-01") },
      ]);

      const plan = await previewFifoAllocation({
        tenantId: "tenant-1",
        productId: "prod-1",
        unitId: "unit-piece",
        requestedQty: "18",
      });

      expect(plan.isSufficient).toBe(true);
      expect(plan.requestedUnitId).toBe("unit-piece");
      expect(plan.requestedUnitName).toBe("قطعة");
    });
  });

  describe("5. Shortfall / Insufficient Stock Handling", () => {
    const mockBaseUnit = { id: "unit-piece", unitName: "قطعة" };

    it("reports isSufficient: false and calculates remainingQty (as a decimal string) when stock is insufficient", async () => {
      vi.mocked(requireBaseUnit).mockResolvedValue(mockBaseUnit as any);
      mockTenantDb.productBatch.findMany.mockResolvedValue([
        { id: "batch-1", batchNumber: "BN-01", quantity: "7", expiryDate: new Date("2026-05-01") },
      ]);

      const plan = await previewFifoAllocation({
        tenantId: "tenant-1",
        productId: "prod-1",
        unitId: "unit-piece",
        requestedQty: "10",
      });

      expect(plan.isSufficient).toBe(false);
      expect(plan.totalAllocatedQty).toBe("7.0000");
      expect(plan.remainingQty).toBe("3.0000");
      expect(plan.allocations).toHaveLength(1);
      expect(plan.allocations[0].allocatedQty).toBe("7.0000");
    });

    it("handles zero available batches gracefully", async () => {
      vi.mocked(requireBaseUnit).mockResolvedValue(mockBaseUnit as any);
      mockTenantDb.productBatch.findMany.mockResolvedValue([]);

      const plan = await previewFifoAllocation({
        tenantId: "tenant-1",
        productId: "prod-1",
        unitId: "unit-piece",
        requestedQty: "5",
      });

      expect(plan.isSufficient).toBe(false);
      expect(plan.totalAllocatedQty).toBe("0.0000");
      expect(plan.remainingQty).toBe("5.0000");
      expect(plan.allocations).toEqual([]);
    });

    it("ignores batches with zero or negative quantity at the query level (never allocates from them)", async () => {
      vi.mocked(requireBaseUnit).mockResolvedValue(mockBaseUnit as any);
      // The real query filters `quantity: { gt: 0 }` server-side; this
      // test only confirms the query shape requests that filter — see
      // section 7 below for the exact where-clause assertion.
      mockTenantDb.productBatch.findMany.mockResolvedValue([
        { id: "batch-1", batchNumber: "BN-01", quantity: "5", expiryDate: null },
      ]);

      const plan = await previewFifoAllocation({
        tenantId: "tenant-1",
        productId: "prod-1",
        unitId: "unit-piece",
        requestedQty: "5",
      });

      expect(mockTenantDb.productBatch.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ quantity: { gt: 0 } }),
        })
      );
      expect(plan.isSufficient).toBe(true);
    });
  });

  describe("6. Validation & Tenant Isolation Guardrails", () => {
    it("rejects non-positive requestedQty with the exact Arabic error fifo.ts throws", async () => {
      await expect(
        previewFifoAllocation({
          tenantId: "tenant-1",
          productId: "prod-1",
          unitId: "unit-1",
          requestedQty: "0",
        })
      ).rejects.toThrow("الكمية المطلوبة يجب أن تكون أكبر من الصفر.");

      await expect(
        previewFifoAllocation({
          tenantId: "tenant-1",
          productId: "prod-1",
          unitId: "unit-1",
          requestedQty: "-5",
        })
      ).rejects.toThrow("الكمية المطلوبة يجب أن تكون أكبر من الصفر.");
    });

    it("rejects missing or blank tenantId before ever calling requireBaseUnit", async () => {
      await expect(
        previewFifoAllocation({
          tenantId: "   ",
          productId: "prod-1",
          unitId: "unit-1",
          requestedQty: "1",
        })
      ).rejects.toThrow("Tenant isolation error");

      expect(requireBaseUnit).not.toHaveBeenCalled();
    });

    it("commitFifoAllocation rejects missing tenantId with its own (commit-specific) message", async () => {
      const mockTx = { productBatch: { findMany: vi.fn() } };

      await expect(
        commitFifoAllocation(mockTx as any, {
          tenantId: "",
          productId: "prod-1",
          unitId: "unit-1",
          requestedQty: "1",
        })
      ).rejects.toThrow("Tenant isolation error: tenantId is required to commit a FIFO allocation.");
    });

    it("propagates MissingBaseUnitError unchanged when the product has no resolvable base unit", async () => {
      vi.mocked(requireBaseUnit).mockRejectedValue(new MissingBaseUnitError("prod-1"));

      await expect(
        previewFifoAllocation({
          tenantId: "tenant-1",
          productId: "prod-1",
          unitId: "unit-1",
          requestedQty: "1",
        })
      ).rejects.toBeInstanceOf(MissingBaseUnitError);
    });
  });

  describe("7. commitFifoAllocation — reads directly via the provided tx, no lock of its own", () => {
    it("resolves the base unit via requireBaseUnit(tx, ...) and reads candidate batches directly through tx", async () => {
      const mockBaseUnit = { id: "unit-1", unitName: "قطعة" };
      const mockBatch = { id: "batch-1", batchNumber: "BN-01", quantity: "10", expiryDate: new Date("2026-05-01") };

      vi.mocked(requireBaseUnit).mockResolvedValue(mockBaseUnit as any);

      // commitFifoAllocation takes `tx` directly as its first argument —
      // it never goes through getTenantDb() at all, so this mock is
      // independent of the getTenantDb mock configured in beforeEach.
      const mockTx = {
        productBatch: {
          findMany: vi.fn().mockResolvedValue([mockBatch]),
        },
      };

      const plan = await commitFifoAllocation(mockTx as any, {
        tenantId: "tenant-1",
        productId: "prod-1",
        unitId: "unit-1",
        requestedQty: "5",
      });

      expect(requireBaseUnit).toHaveBeenCalledWith(mockTx, "tenant-1", "prod-1");

      expect(mockTx.productBatch.findMany).toHaveBeenCalledWith({
        where: {
          tenantId: "tenant-1",
          productId: "prod-1",
          quantity: { gt: 0 },
        },
        select: {
          id: true,
          batchNumber: true,
          quantity: true,
          expiryDate: true,
        },
      });

      expect(plan.isSufficient).toBe(true);
      expect(plan.totalAllocatedQty).toBe("5.0000");
      expect(plan.allocations[0].batchId).toBe("batch-1");
      expect(plan.allocations[0].allocatedQty).toBe("5.0000");
      expect(plan.allocations[0].deductQtyInBatchUnit).toBe("5.0000");
      expect(plan.allocations[0].batchUnitId).toBe("unit-1");
      expect(plan.allocations[0].batchUnitName).toBe("قطعة");
    });

    it("throws Unit mismatch and never reads batches when the caller supplies a non-base unitId", async () => {
      const mockBaseUnit = { id: "unit-real-base", unitName: "قطعة" };
      vi.mocked(requireBaseUnit).mockResolvedValue(mockBaseUnit as any);

      const mockTx = { productBatch: { findMany: vi.fn() } };

      await expect(
        commitFifoAllocation(mockTx as any, {
          tenantId: "tenant-1",
          productId: "prod-1",
          unitId: "unit-wrong",
          requestedQty: "5",
        })
      ).rejects.toThrow(/Unit mismatch/);

      expect(mockTx.productBatch.findMany).not.toHaveBeenCalled();
    });
  });
});