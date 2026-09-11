/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { expectTypeOf } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  previewFifoAllocation,
  type AllocationPlan,
  type PreviewFifoParams,
} from "../fifo";

const { mockTenantDb, mockRawPrisma, mockSessionState, mockTenantScopedRawQuery } =
  vi.hoisted(() => {
    const mockProduct = {
      findFirst: vi.fn(),
    };
    const mockProductUnit = {
      findFirst: vi.fn(),
    };
    const mockProductBatch = {
      findMany: vi.fn(),
    };
    const mockTenantScopedRawQuery = vi.fn(async () => []);

    const mockTenantDb: any = {
      product: mockProduct,
      productUnit: mockProductUnit,
      productBatch: mockProductBatch,
    };

    const mockRawPrisma: any = {
      product: mockProduct,
      productUnit: mockProductUnit,
      productBatch: mockProductBatch,
      $transaction: vi.fn(async (cb: (tx: any) => Promise<any>) => cb(mockTenantDb)),
      $queryRaw: vi.fn(async () => []),
    };

    const mockSessionState = {
      session: {
        user: {
          id: "user-1",
          role: "ADMIN",
          tenantId: "tenant-1",
        },
      } as any,
    };

    return {
      mockTenantDb,
      mockRawPrisma,
      mockSessionState,
      mockTenantScopedRawQuery,
    };
  });

vi.mock("@/auth", () => ({
  auth: vi.fn(async () => mockSessionState.session),
}));

vi.mock("@/lib/db", () => ({
  prisma: mockRawPrisma,
  getTenantDb: vi.fn(() => mockTenantDb),
}));

vi.mock("@/lib/db/tenant-scope", () => ({
  getTenantDb: vi.fn(() => mockTenantDb),
  tenantScopedRawQuery: mockTenantScopedRawQuery,
}));

import { POST as previewHandler } from "@/app/api/inventory/fifo-preview/route";

/**
 * Extracts the full body of a named exported function from a TypeScript source
 * string using brace-matching, rather than relying on the presence of a
 * trailing "/**" doc-comment block (which is fragile: if no doc comment
 * follows the function, `indexOf("/**", ...)` returns -1 and `slice()` would
 * silently swallow the rest of the file instead of failing loudly).
 */
function extractFunctionBody(source: string, functionSignature: string): string {
  const startIdx = source.indexOf(functionSignature);
  if (startIdx === -1) {
    throw new Error(
      `extractFunctionBody: could not locate signature "${functionSignature}" in source.`
    );
  }

  const firstBraceIdx = source.indexOf("{", startIdx);
  if (firstBraceIdx === -1) {
    throw new Error(
      `extractFunctionBody: could not locate opening brace for "${functionSignature}".`
    );
  }

  let depth = 0;
  let endIdx = -1;
  for (let i = firstBraceIdx; i < source.length; i++) {
    const char = source[i];
    if (char === "{") depth++;
    else if (char === "}") {
      depth--;
      if (depth === 0) {
        endIdx = i;
        break;
      }
    }
  }

  if (endIdx === -1) {
    throw new Error(
      `extractFunctionBody: unbalanced braces while parsing "${functionSignature}" — could not find matching closing brace.`
    );
  }

  return source.slice(firstBraceIdx, endIdx + 1);
}

describe("T3e — Inventory Preview (Read-Only FIFO Allocation)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionState.session = {
      user: {
        id: "user-1",
        role: "ADMIN",
        tenantId: "tenant-1",
      },
    };
  });

  describe("1. Structural & Compile-Time Separation Guarantees", () => {
    it("confirms previewFifoAllocation type signature takes only PreviewFifoParams (no tx parameter)", () => {
      expectTypeOf(previewFifoAllocation).parameters.toEqualTypeOf<[PreviewFifoParams]>();
      expectTypeOf(previewFifoAllocation).returns.toEqualTypeOf<Promise<AllocationPlan>>();
    });

    it("statically verifies that app/api/inventory/fifo-preview/route.ts never imports commitFifoAllocation", () => {
      const routeSource = fs.readFileSync(
        path.resolve(process.cwd(), "app/api/inventory/fifo-preview/route.ts"),
        "utf-8"
      );
      expect(routeSource).not.toMatch(/commitFifoAllocation/);
    });

    it("statically verifies that previewFifoAllocation source code never invokes $transaction or write mutations", () => {
      const fifoSource = fs.readFileSync(
        path.resolve(process.cwd(), "lib/inventory/fifo.ts"),
        "utf-8"
      );

      // Brace-matched extraction — robust regardless of whether a doc comment
      // follows the function. Throws loudly instead of silently mis-slicing
      // if the signature or braces can't be located.
      const previewBody = extractFunctionBody(
        fifoSource,
        "export async function previewFifoAllocation"
      );

      expect(previewBody).not.toMatch(/\$transaction/);
      expect(previewBody).not.toMatch(/commitFifoAllocation/);
      expect(previewBody).not.toMatch(/\.(create|update|delete|upsert|createMany|updateMany|deleteMany)\(/);
    });
  });

  describe("2. No-Lock & No-Transaction Execution Invariants", () => {
    it("never opens a database transaction ($transaction) during FIFO preview", async () => {
      mockTenantDb.product.findFirst.mockResolvedValue({ id: "prod-1" });
      mockTenantDb.productUnit.findFirst.mockResolvedValue({
        id: "unit-1",
        productId: "prod-1",
        unitName: "قطعة",
        conversionFactor: 1,
      });
      mockTenantDb.productBatch.findMany.mockResolvedValue([
        {
          id: "batch-1",
          batchNumber: "B001",
          quantity: 10,
          expiryDate: new Date("2026-12-31"),
          createdAt: new Date("2026-01-01"),
          unitId: "unit-1",
          unit: { unitName: "قطعة", conversionFactor: 1 },
        },
      ]);

      const req = new Request("http://localhost/api/inventory/fifo-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productId: "prod-1",
          unitId: "unit-1",
          requestedQty: 5,
        }),
      });

      const res = await previewHandler(req);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);

      // Verify no transaction was opened
      expect(mockRawPrisma.$transaction).not.toHaveBeenCalled();
    });

    it("never executes row-level locking queries (SELECT ... FOR UPDATE or tenantScopedRawQuery)", async () => {
      mockTenantDb.productUnit.findFirst.mockResolvedValue({
        id: "unit-1",
        productId: "prod-1",
        unitName: "قطعة",
        conversionFactor: 1,
      });
      mockTenantDb.productBatch.findMany.mockResolvedValue([
        {
          id: "batch-1",
          batchNumber: "B001",
          quantity: 10,
          expiryDate: new Date("2026-12-31"),
          createdAt: new Date("2026-01-01"),
          unitId: "unit-1",
          unit: { unitName: "قطعة", conversionFactor: 1 },
        },
      ]);

      await previewFifoAllocation({
        tenantId: "tenant-1",
        productId: "prod-1",
        unitId: "unit-1",
        requestedQty: 5,
      });

      expect(mockTenantScopedRawQuery).not.toHaveBeenCalled();
      expect(mockRawPrisma.$queryRaw).not.toHaveBeenCalled();
    });
  });

  describe("3. Real Concurrency & Zero Lock Contention", () => {
    it("handles multiple concurrent preview calls simultaneously with zero deadlocks and deterministic FIFO order", async () => {
      mockTenantDb.productUnit.findFirst.mockResolvedValue({
        id: "unit-carton",
        productId: "prod-juice",
        unitName: "كرتونة",
        conversionFactor: 12,
      });

      const candidateBatches = [
        {
          id: "batch-b",
          batchNumber: "LOT-2026-06",
          quantity: 2, // 2 cartons = 24 pcs
          expiryDate: new Date("2026-06-30"),
          createdAt: new Date("2026-01-01"),
          unitId: "unit-carton",
          unit: { unitName: "كرتونة", conversionFactor: 12 },
        },
        {
          id: "batch-a",
          batchNumber: "LOT-2026-03",
          quantity: 1, // 1 carton = 12 pcs
          expiryDate: new Date("2026-03-31"),
          createdAt: new Date("2026-01-01"),
          unitId: "unit-carton",
          unit: { unitName: "كرتونة", conversionFactor: 12 },
        },
        {
          id: "batch-c",
          batchNumber: "LOT-NO-EXP",
          quantity: 5, // 5 cartons = 60 pcs
          expiryDate: null,
          createdAt: new Date("2026-01-01"),
          unitId: "unit-carton",
          unit: { unitName: "كرتونة", conversionFactor: 12 },
        },
      ];

      mockTenantDb.productBatch.findMany.mockResolvedValue(candidateBatches);

      // Fire 15 concurrent preview invocations
      const concurrentCalls = Array.from({ length: 15 }, () =>
        previewFifoAllocation({
          tenantId: "tenant-1",
          productId: "prod-juice",
          unitId: "unit-carton",
          requestedQty: 2.5,
        })
      );

      const results = await Promise.all(concurrentCalls);

      expect(results).toHaveLength(15);
      for (const plan of results) {
        expect(plan.isSufficient).toBe(true);
        expect(plan.requestedQty).toBe(2.5);
        expect(plan.totalAllocatedQty).toBe(2.5);
        expect(plan.remainingQty).toBe(0);
        expect(plan.allocations).toHaveLength(2);

        // Strict FIFO ordering: 2026-03-31 (1 carton) first, then 2026-06-30 (1.5 cartons)
        expect(plan.allocations[0].batchNumber).toBe("LOT-2026-03");
        expect(plan.allocations[0].allocatedQty).toBe(1);
        expect(plan.allocations[1].batchNumber).toBe("LOT-2026-06");
        expect(plan.allocations[1].allocatedQty).toBe(1.5);
      }
    });
  });

  describe("4. Shortfall & Insufficient Stock Handling", () => {
    it("returns fullyAllocated: false and exact shortfallQty without throwing when requestedQty exceeds stock", async () => {
      mockTenantDb.product.findFirst.mockResolvedValue({ id: "prod-rice" });
      mockTenantDb.productUnit.findFirst.mockResolvedValue({
        id: "unit-kg",
        productId: "prod-rice",
        unitName: "كيلو",
        conversionFactor: 1,
      });

      // Total available: 7 kg
      mockTenantDb.productBatch.findMany.mockResolvedValue([
        {
          id: "batch-1",
          batchNumber: "RICE-01",
          quantity: 4,
          expiryDate: new Date("2026-10-01"),
          createdAt: new Date("2026-01-01"),
          unitId: "unit-kg",
          unit: { unitName: "كيلو", conversionFactor: 1 },
        },
        {
          id: "batch-2",
          batchNumber: "RICE-02",
          quantity: 3,
          expiryDate: new Date("2026-11-01"),
          createdAt: new Date("2026-01-01"),
          unitId: "unit-kg",
          unit: { unitName: "كيلو", conversionFactor: 1 },
        },
      ]);

      const req = new Request("http://localhost/api/inventory/fifo-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productId: "prod-rice",
          unitId: "unit-kg",
          requestedQty: 10, // Exceeds 7 kg by 3 kg
        }),
      });

      const res = await previewHandler(req);
      expect(res.status).toBe(200);
      const json = await res.json();

      expect(json.success).toBe(true);
      expect(json.resolution.isSufficient).toBe(false);
      expect(json.resolution.fullyAllocated).toBe(false);
      expect(json.resolution.totalAllocatedQty).toBe(7);
      expect(json.resolution.shortfallQty).toBe(3);
      expect(json.resolution.remainingQty).toBe(3);
      expect(json.resolution.allocations).toHaveLength(2);
    });

    it("handles zero available batches gracefully with full shortfall and empty allocations", async () => {
      mockTenantDb.product.findFirst.mockResolvedValue({ id: "prod-empty" });
      mockTenantDb.productUnit.findFirst.mockResolvedValue({
        id: "unit-pc",
        productId: "prod-empty",
        unitName: "قطعة",
        conversionFactor: 1,
      });
      mockTenantDb.productBatch.findMany.mockResolvedValue([]);

      const req = new Request("http://localhost/api/inventory/fifo-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productId: "prod-empty",
          unitId: "unit-pc",
          requestedQty: 15,
        }),
      });

      const res = await previewHandler(req);
      expect(res.status).toBe(200);
      const json = await res.json();

      expect(json.success).toBe(true);
      expect(json.resolution.isSufficient).toBe(false);
      expect(json.resolution.fullyAllocated).toBe(false);
      expect(json.resolution.totalAllocatedQty).toBe(0);
      expect(json.resolution.shortfallQty).toBe(15);
      expect(json.resolution.allocations).toHaveLength(0);
    });

    it("returns fullyAllocated: true and shortfallQty: 0 when requestedQty exactly equals total available stock (exact-match edge case)", async () => {
      mockTenantDb.product.findFirst.mockResolvedValue({ id: "prod-flour" });
      mockTenantDb.productUnit.findFirst.mockResolvedValue({
        id: "unit-kg",
        productId: "prod-flour",
        unitName: "كيلو",
        conversionFactor: 1,
      });

      // Total available across both batches: 4 + 3 = exactly 7 kg
      mockTenantDb.productBatch.findMany.mockResolvedValue([
        {
          id: "batch-1",
          batchNumber: "FLOUR-01",
          quantity: 4,
          expiryDate: new Date("2026-08-01"),
          createdAt: new Date("2026-01-01"),
          unitId: "unit-kg",
          unit: { unitName: "كيلو", conversionFactor: 1 },
        },
        {
          id: "batch-2",
          batchNumber: "FLOUR-02",
          quantity: 3,
          expiryDate: new Date("2026-09-01"),
          createdAt: new Date("2026-01-01"),
          unitId: "unit-kg",
          unit: { unitName: "كيلو", conversionFactor: 1 },
        },
      ]);

      const req = new Request("http://localhost/api/inventory/fifo-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productId: "prod-flour",
          unitId: "unit-kg",
          requestedQty: 7, // Exactly matches total available stock — no surplus, no shortfall
        }),
      });

      const res = await previewHandler(req);
      expect(res.status).toBe(200);
      const json = await res.json();

      expect(json.success).toBe(true);
      expect(json.resolution.isSufficient).toBe(true);
      expect(json.resolution.fullyAllocated).toBe(true);
      expect(json.resolution.totalAllocatedQty).toBe(7);
      expect(json.resolution.remainingQty).toBe(0);
      expect(json.resolution.shortfallQty).toBe(0);
      expect(json.resolution.allocations).toHaveLength(2);
      // Both batches fully drawn down, nothing left unaccounted for
      expect(json.resolution.allocations[0].allocatedQty).toBe(4);
      expect(json.resolution.allocations[1].allocatedQty).toBe(3);
    });
  });

  describe("5. Cross-Tenant & Cross-Product Pre-flight Guard", () => {
    it("rejects request with 404 NOT_FOUND when product does not exist for current tenant", async () => {
      mockTenantDb.product.findFirst.mockResolvedValue(null);

      const req = new Request("http://localhost/api/inventory/fifo-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productId: "foreign-prod-id",
          unitId: "some-unit",
          requestedQty: 5,
        }),
      });

      const res = await previewHandler(req);
      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error).toBe("NOT_FOUND");
      expect(json.message).toContain("المنتج المحدد غير موجود");

      // Assert previewFifoAllocation was not invoked
      expect(mockTenantDb.productBatch.findMany).not.toHaveBeenCalled();
    });

    it("rejects request with 400 VALIDATION_ERROR when unit belongs to a different product or tenant", async () => {
      mockTenantDb.product.findFirst.mockResolvedValue({ id: "prod-1" });
      // Unit not found under prod-1
      mockTenantDb.productUnit.findFirst.mockResolvedValue(null);

      const req = new Request("http://localhost/api/inventory/fifo-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productId: "prod-1",
          unitId: "foreign-unit-id",
          requestedQty: 5,
        }),
      });

      const res = await previewHandler(req);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe("VALIDATION_ERROR");
      expect(json.message).toContain("وحدة القياس المحددة غير صالحة");

      // Assert candidate batches were never loaded
      expect(mockTenantDb.productBatch.findMany).not.toHaveBeenCalled();
    });
  });

  describe("6. Input Validation & Decimal Precision", () => {
    it("rejects non-positive or invalid requestedQty with 400 VALIDATION_ERROR", async () => {
      const req = new Request("http://localhost/api/inventory/fifo-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productId: "prod-1",
          unitId: "unit-1",
          requestedQty: -3,
        }),
      });

      const res = await previewHandler(req);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe("VALIDATION_ERROR");
    });

    it("rejects missing authentication session with 401 UNAUTHORIZED", async () => {
      mockSessionState.session = null;

      const req = new Request("http://localhost/api/inventory/fifo-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productId: "prod-1",
          unitId: "unit-1",
          requestedQty: 5,
        }),
      });

      const res = await previewHandler(req);
      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.error).toBe("UNAUTHORIZED");
    });

    it("preserves exact fractional decimal quantities through calculation", async () => {
      mockTenantDb.product.findFirst.mockResolvedValue({ id: "prod-decimal" });
      mockTenantDb.productUnit.findFirst.mockResolvedValue({
        id: "unit-box",
        productId: "prod-decimal",
        unitName: "صندوق",
        conversionFactor: 6,
      });

      mockTenantDb.productBatch.findMany.mockResolvedValue([
        {
          id: "batch-1",
          batchNumber: "B-DEC-1",
          quantity: 1.5, // 1.5 boxes = 9 pcs
          expiryDate: new Date("2026-12-31"),
          createdAt: new Date("2026-01-01"),
          unitId: "unit-box",
          unit: { unitName: "صندوق", conversionFactor: 6 },
        },
      ]);

      const req = new Request("http://localhost/api/inventory/fifo-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productId: "prod-decimal",
          unitId: "unit-box",
          requestedQty: 0.75,
        }),
      });

      const res = await previewHandler(req);
      expect(res.status).toBe(200);
      const json = await res.json();

      expect(json.success).toBe(true);
      expect(json.resolution.requestedQty).toBe(0.75);
      expect(json.resolution.totalAllocatedQty).toBe(0.75);
      expect(json.resolution.isSufficient).toBe(true);
      expect(json.resolution.fullyAllocated).toBe(true);
      expect(json.resolution.allocations[0].allocatedQty).toBe(0.75);
      expect(json.resolution.allocations[0].deductQtyInBatchUnit).toBe(0.75);
    });
  });
});