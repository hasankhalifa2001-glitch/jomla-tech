/* eslint-disable no-restricted-syntax */
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
    // [v4.0 alignment] The real call chain is:
    //   route  -> findProductById()          -> product.findUnique
    //          -> findProductUnitById()      -> productUnit.findUnique
    //          -> requireBaseUnit()          -> product.findUniqueOrThrow
    //          -> getUnitConversionFactor()  -> productUnit.findUniqueOrThrow
    //   fifo   -> requireBaseUnit()          -> product.findUniqueOrThrow
    //          -> productBatch.findMany
    // The old mock only had product.findFirst / productUnit.findFirst, which
    // nothing calls any more.
    const mockProduct = {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    };
    const mockProductUnit = {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
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

const TENANT = "tenant-1";

/**
 * Extracts the full body of a named exported function from a TypeScript source
 * string using brace-matching. Throws loudly (never silently mis-slices) if the
 * signature or braces cannot be located.
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

// ----------------------------------------------------------------------------
// Fixtures. Quantities are decimal STRINGS (ProductBatch.quantity is a Decimal
// column and every batch quantity is in the product's BASE unit, v4.0).
// ----------------------------------------------------------------------------
interface SeedBatch {
  id: string;
  batchNumber: string;
  quantity: string;
  expiryDate: Date | null;
  costPricePerBaseUnit: string;
}

const batch = (
  id: string,
  batchNumber: string,
  quantity: string,
  expiryDate: Date | null,
  costPricePerBaseUnit = "1000.00000000"
): SeedBatch => ({ id, batchNumber, quantity, expiryDate, costPricePerBaseUnit });

interface SeedOptions {
  productId?: string;
  baseUnitId?: string;
  baseUnitName?: string;
  /** The unit the caller sells/previews in. Defaults to the base unit itself. */
  soldUnitId?: string;
  /** How many BASE units equal ONE sold unit. "1" when sold unit === base unit. */
  soldUnitFactor?: string;
  batches?: SeedBatch[];
}

/**
 * Seeds every Prisma call the route + fifo.ts make, so each test only states
 * what differs. Re-seeding fully on every call matters: vi.clearAllMocks()
 * clears call history but NOT implementations, so stale values from a previous
 * test would otherwise leak through.
 */
function seed(opts: SeedOptions = {}) {
  const productId = opts.productId ?? "prod-1";
  const baseUnitId = opts.baseUnitId ?? "unit-base";
  const baseUnitName = opts.baseUnitName ?? "قطعة";
  const soldUnitId = opts.soldUnitId ?? baseUnitId;
  const soldUnitFactor = opts.soldUnitFactor ?? "1";

  mockTenantDb.product.findUnique.mockResolvedValue({ id: productId, tenantId: TENANT });
  mockTenantDb.productUnit.findUnique.mockResolvedValue({
    id: soldUnitId,
    productId,
    tenantId: TENANT,
  });
  mockTenantDb.product.findUniqueOrThrow.mockResolvedValue({
    id: productId,
    tenantId: TENANT,
    baseUnitId,
    baseUnit: { id: baseUnitId, unitName: baseUnitName, conversionFactor: "1" },
  });
  mockTenantDb.productUnit.findUniqueOrThrow.mockResolvedValue({
    conversionFactor: soldUnitFactor,
  });
  mockTenantDb.productBatch.findMany.mockResolvedValue(opts.batches ?? []);

  return { productId, baseUnitId, soldUnitId };
}

function previewRequest(body: Record<string, unknown>) {
  return new Request("http://localhost/api/inventory/fifo-preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("T3e — Inventory Preview (Read-Only FIFO Allocation)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionState.session = {
      user: {
        id: "user-1",
        role: "ADMIN",
        tenantId: TENANT,
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

      const previewBody = extractFunctionBody(
        fifoSource,
        "export async function previewFifoAllocation"
      );

      expect(previewBody).not.toMatch(/\$transaction/);
      expect(previewBody).not.toMatch(/commitFifoAllocation/);
      expect(previewBody).not.toMatch(/\.(create|update|delete|upsert|createMany|updateMany|deleteMany)\(/);
    });

    it("[v4.0] statically verifies fifo.ts never references conversionFactor (T3b acceptance criterion)", () => {
      const fifoSource = fs.readFileSync(
        path.resolve(process.cwd(), "lib/inventory/fifo.ts"),
        "utf-8"
      );
      expect(fifoSource).not.toMatch(/conversionFactor/);
    });
  });

  describe("2. No-Lock & No-Transaction Execution Invariants", () => {
    it("never opens a database transaction ($transaction) or issues a raw/locking query through the route", async () => {
      seed({
        batches: [batch("batch-1", "B001", "10.0000", new Date("2026-12-31"))],
      });

      const res = await previewHandler(previewRequest({ productId: "prod-1", unitId: "unit-base", requestedQty: "5" }));
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);

      expect(mockRawPrisma.$transaction).not.toHaveBeenCalled();
      expect(mockRawPrisma.$queryRaw).not.toHaveBeenCalled();
      expect(mockTenantScopedRawQuery).not.toHaveBeenCalled();
    });

    it("never executes row-level locking queries when previewFifoAllocation is called directly", async () => {
      const { baseUnitId } = seed({
        batches: [batch("batch-1", "B001", "10.0000", new Date("2026-12-31"))],
      });

      await previewFifoAllocation({
        tenantId: TENANT,
        productId: "prod-1",
        unitId: baseUnitId,
        requestedQty: "5",
      });

      expect(mockTenantScopedRawQuery).not.toHaveBeenCalled();
      expect(mockRawPrisma.$queryRaw).not.toHaveBeenCalled();
      expect(mockRawPrisma.$transaction).not.toHaveBeenCalled();
    });

    it("scopes the batch query explicitly by tenantId and only loads batches with stock", async () => {
      const { baseUnitId } = seed({ batches: [] });

      await previewFifoAllocation({
        tenantId: TENANT,
        productId: "prod-1",
        unitId: baseUnitId,
        requestedQty: "1",
      });

      expect(mockTenantDb.productBatch.findMany).toHaveBeenCalledTimes(1);
      const arg = mockTenantDb.productBatch.findMany.mock.calls[0][0];
      expect(arg.where).toMatchObject({ tenantId: TENANT, productId: "prod-1", quantity: { gt: 0 } });
    });
  });

  describe("3. Real Concurrency & Zero Lock Contention", () => {
    it("handles multiple concurrent preview calls with deterministic FIFO order (all quantities in the base unit)", async () => {
      // Every batch quantity is a BASE-unit figure (v4.0). No per-batch unit.
      const { baseUnitId } = seed({
        baseUnitName: "قطعة",
        batches: [
          batch("batch-b", "LOT-2026-06", "24", new Date("2026-06-30")),
          batch("batch-a", "LOT-2026-03", "12", new Date("2026-03-31")),
          batch("batch-c", "LOT-NO-EXP", "60", null),
        ],
      });

      const results = await Promise.all(
        Array.from({ length: 15 }, () =>
          previewFifoAllocation({
            tenantId: TENANT,
            productId: "prod-1",
            unitId: baseUnitId,
            requestedQty: "30",
          })
        )
      );

      expect(results).toHaveLength(15);
      for (const plan of results) {
        expect(plan.isSufficient).toBe(true);
        expect(plan.requestedQty).toBe("30.0000");
        expect(plan.totalAllocatedQty).toBe("30.0000");
        expect(plan.remainingQty).toBe("0.0000");
        expect(plan.allocations).toHaveLength(2);

        // Earliest expiry first (2026-03-31, all 12), then 2026-06-30 (the other 18).
        expect(plan.allocations[0].batchNumber).toBe("LOT-2026-03");
        expect(plan.allocations[0].allocatedQty).toBe("12.0000");
        expect(plan.allocations[1].batchNumber).toBe("LOT-2026-06");
        expect(plan.allocations[1].allocatedQty).toBe("18.0000");
      }

      // No transaction, no lock, for any of the 15 calls.
      expect(mockRawPrisma.$transaction).not.toHaveBeenCalled();
      expect(mockTenantScopedRawQuery).not.toHaveBeenCalled();
    });

    it("places a batch with no expiry date last, and breaks same-expiry ties by id ascending", async () => {
      const { baseUnitId } = seed({
        batches: [
          batch("b-2", "TIE-2", "5", new Date("2026-05-01")),
          batch("b-none", "NO-EXP", "5", null),
          batch("b-1", "TIE-1", "5", new Date("2026-05-01")),
        ],
      });

      const plan = await previewFifoAllocation({
        tenantId: TENANT,
        productId: "prod-1",
        unitId: baseUnitId,
        requestedQty: "15",
      });

      expect(plan.allocations.map((a) => a.batchNumber)).toEqual(["TIE-1", "TIE-2", "NO-EXP"]);
    });

    it("skips batches whose quantity is zero or negative", async () => {
      const { baseUnitId } = seed({
        batches: [
          batch("b-neg", "NEGATIVE", "-5", new Date("2026-01-01")),
          batch("b-zero", "ZERO", "0", new Date("2026-01-02")),
          batch("b-ok", "OK", "8", new Date("2026-01-03")),
        ],
      });

      const plan = await previewFifoAllocation({
        tenantId: TENANT,
        productId: "prod-1",
        unitId: baseUnitId,
        requestedQty: "3",
      });

      expect(plan.allocations).toHaveLength(1);
      expect(plan.allocations[0].batchNumber).toBe("OK");
      expect(plan.allocations[0].allocatedQty).toBe("3.0000");
    });
  });

  describe("4. Shortfall & Insufficient Stock Handling", () => {
    it("returns fullyAllocated: false and exact shortfallQty without throwing when requestedQty exceeds stock", async () => {
      seed({
        productId: "prod-rice",
        baseUnitId: "unit-kg",
        baseUnitName: "كيلو",
        batches: [
          batch("batch-1", "RICE-01", "4", new Date("2026-10-01")),
          batch("batch-2", "RICE-02", "3", new Date("2026-11-01")),
        ],
      });

      const res = await previewHandler(
        previewRequest({ productId: "prod-rice", unitId: "unit-kg", requestedQty: "10" })
      );
      expect(res.status).toBe(200);
      const json = await res.json();

      expect(json.success).toBe(true);
      expect(json.resolution.isSufficient).toBe(false);
      expect(json.resolution.fullyAllocated).toBe(false);
      expect(json.resolution.totalAllocatedQty).toBe("7.0000");
      expect(json.resolution.shortfallQty).toBe("3.0000");
      expect(json.resolution.remainingQty).toBe("3.0000");
      expect(json.resolution.allocations).toHaveLength(2);
    });

    it("handles zero available batches gracefully with full shortfall and empty allocations", async () => {
      seed({ productId: "prod-empty", baseUnitId: "unit-pc", batches: [] });

      const res = await previewHandler(
        previewRequest({ productId: "prod-empty", unitId: "unit-pc", requestedQty: "15" })
      );
      expect(res.status).toBe(200);
      const json = await res.json();

      expect(json.success).toBe(true);
      expect(json.resolution.isSufficient).toBe(false);
      expect(json.resolution.fullyAllocated).toBe(false);
      expect(json.resolution.totalAllocatedQty).toBe("0.0000");
      expect(json.resolution.shortfallQty).toBe("15.0000");
      expect(json.resolution.allocations).toHaveLength(0);
    });

    it("returns fullyAllocated: true and shortfallQty: 0 when requestedQty exactly equals total available stock", async () => {
      seed({
        productId: "prod-flour",
        baseUnitId: "unit-kg",
        baseUnitName: "كيلو",
        batches: [
          batch("batch-1", "FLOUR-01", "4", new Date("2026-08-01")),
          batch("batch-2", "FLOUR-02", "3", new Date("2026-09-01")),
        ],
      });

      const res = await previewHandler(
        previewRequest({ productId: "prod-flour", unitId: "unit-kg", requestedQty: "7" })
      );
      expect(res.status).toBe(200);
      const json = await res.json();

      expect(json.resolution.isSufficient).toBe(true);
      expect(json.resolution.fullyAllocated).toBe(true);
      expect(json.resolution.totalAllocatedQty).toBe("7.0000");
      expect(json.resolution.remainingQty).toBe("0.0000");
      expect(json.resolution.shortfallQty).toBe("0.0000");
      expect(json.resolution.allocations).toHaveLength(2);
      expect(json.resolution.allocations[0].allocatedQty).toBe("4.0000");
      expect(json.resolution.allocations[1].allocatedQty).toBe("3.0000");
    });
  });

  describe("5. Cross-Tenant & Cross-Product Pre-flight Guard", () => {
    it("rejects request with 404 NOT_FOUND when product does not exist for current tenant", async () => {
      seed();
      mockTenantDb.product.findUnique.mockResolvedValue(null);

      const res = await previewHandler(
        previewRequest({ productId: "foreign-prod-id", unitId: "some-unit", requestedQty: "5" })
      );
      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error).toBe("NOT_FOUND");
      expect(json.message).toContain("المنتج المحدد غير موجود");

      expect(mockTenantDb.productBatch.findMany).not.toHaveBeenCalled();
    });

    it("rejects request with 400 VALIDATION_ERROR when the unit does not exist for this tenant", async () => {
      seed();
      mockTenantDb.productUnit.findUnique.mockResolvedValue(null);

      const res = await previewHandler(
        previewRequest({ productId: "prod-1", unitId: "foreign-unit-id", requestedQty: "5" })
      );
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe("VALIDATION_ERROR");
      expect(json.message).toContain("وحدة القياس المحددة غير صالحة");

      expect(mockTenantDb.productBatch.findMany).not.toHaveBeenCalled();
    });

    it("rejects request with 400 VALIDATION_ERROR when the unit belongs to a DIFFERENT product of the same tenant", async () => {
      seed();
      mockTenantDb.productUnit.findUnique.mockResolvedValue({
        id: "unit-other",
        productId: "some-other-product",
        tenantId: TENANT,
      });

      const res = await previewHandler(
        previewRequest({ productId: "prod-1", unitId: "unit-other", requestedQty: "5" })
      );
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe("VALIDATION_ERROR");
      expect(json.message).toContain("وحدة القياس المحددة غير صالحة");

      expect(mockTenantDb.productBatch.findMany).not.toHaveBeenCalled();
    });
  });

  describe("6. Input Validation & Decimal Precision", () => {
    it("rejects a negative requestedQty with the positivity message (not just any 400)", async () => {
      seed();
      const res = await previewHandler(
        previewRequest({ productId: "prod-1", unitId: "unit-base", requestedQty: "-3" })
      );
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe("VALIDATION_ERROR");
      expect(json.message).toContain("أكبر من الصفر");
    });

    it("rejects a zero requestedQty", async () => {
      seed();
      const res = await previewHandler(
        previewRequest({ productId: "prod-1", unitId: "unit-base", requestedQty: "0" })
      );
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("VALIDATION_ERROR");
    });

    it("rejects a malformed requestedQty string", async () => {
      seed();
      const res = await previewHandler(
        previewRequest({ productId: "prod-1", unitId: "unit-base", requestedQty: "abc" })
      );
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe("VALIDATION_ERROR");
      expect(json.message).toContain("صيغة الكمية");
    });

    it("rejects a native JS number for requestedQty — the contract is a decimal STRING", async () => {
      seed();
      const res = await previewHandler(
        previewRequest({ productId: "prod-1", unitId: "unit-base", requestedQty: 5 })
      );
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("VALIDATION_ERROR");
      expect(mockTenantDb.productBatch.findMany).not.toHaveBeenCalled();
    });

    it("rejects missing authentication session with 401 UNAUTHORIZED", async () => {
      mockSessionState.session = null;

      const res = await previewHandler(
        previewRequest({ productId: "prod-1", unitId: "unit-base", requestedQty: "5" })
      );
      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.error).toBe("UNAUTHORIZED");
    });

    it("preserves exact fractional quantities through the sold-unit -> base-unit conversion", async () => {
      // 0.75 boxes x 6 pieces/box = 4.5 pieces, drawn from a batch of 9 pieces.
      seed({
        productId: "prod-decimal",
        baseUnitId: "unit-piece",
        soldUnitId: "unit-box",
        soldUnitFactor: "6",
        batches: [batch("batch-1", "B-DEC-1", "9", new Date("2026-12-31"))],
      });

      const res = await previewHandler(
        previewRequest({ productId: "prod-decimal", unitId: "unit-box", requestedQty: "0.75" })
      );
      expect(res.status).toBe(200);
      const json = await res.json();

      expect(json.resolution.requestedQty).toBe("4.5000");
      expect(json.resolution.totalAllocatedQty).toBe("4.5000");
      expect(json.resolution.isSufficient).toBe(true);
      expect(json.resolution.fullyAllocated).toBe(true);
      expect(json.resolution.allocations[0].allocatedQty).toBe("4.5000");
      expect(json.resolution.allocations[0].deductQtyInBatchUnit).toBe("4.5000");
    });

    it("keeps 4-decimal precision exactly (0.1234 x factor 3 = 0.3702, no float drift)", async () => {
      seed({
        baseUnitId: "unit-piece",
        soldUnitId: "unit-pack",
        soldUnitFactor: "3",
        batches: [batch("batch-1", "B-1", "10", new Date("2026-12-31"))],
      });

      const res = await previewHandler(
        previewRequest({ productId: "prod-1", unitId: "unit-pack", requestedQty: "0.1234" })
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.resolution.requestedQty).toBe("0.3702");
      expect(json.resolution.allocations[0].allocatedQty).toBe("0.3702");
    });
  });

  describe("7. [v4.0] Sold-unit -> base-unit conversion", () => {
    it("converts 3 packs (factor 24) into exactly 72 base units before previewing", async () => {
      // Mirrors T3b's acceptance test: 3 packs x 24 must reach the FIFO core
      // as 72 — not 3, and not 3 x 1 (the base unit's own factor).
      seed({
        baseUnitId: "unit-piece",
        baseUnitName: "قطعة",
        soldUnitId: "unit-pack",
        soldUnitFactor: "24",
        batches: [batch("batch-1", "LOT-1", "100", new Date("2026-12-31"))],
      });

      const res = await previewHandler(
        previewRequest({ productId: "prod-1", unitId: "unit-pack", requestedQty: "3" })
      );
      expect(res.status).toBe(200);
      const json = await res.json();

      expect(json.resolution.requestedQty).toBe("72.0000");
      expect(json.resolution.totalAllocatedQty).toBe("72.0000");
      expect(json.resolution.allocations[0].allocatedQty).toBe("72.0000");
      // The plan is reported against the BASE unit, which is what batches are scoped to.
      expect(json.resolution.requestedUnitId).toBe("unit-piece");
      expect(json.resolution.requestedUnitName).toBe("قطعة");
      expect(json.resolution.allocations[0].batchUnitId).toBe("unit-piece");
    });

    it("reads the sold unit's factor from the database via its own unitId (never from the client payload)", async () => {
      seed({
        baseUnitId: "unit-piece",
        soldUnitId: "unit-pack",
        soldUnitFactor: "24",
        batches: [batch("batch-1", "LOT-1", "100", new Date("2026-12-31"))],
      });

      // A forged factor in the body must be ignored entirely.
      const res = await previewHandler(
        previewRequest({
          productId: "prod-1",
          unitId: "unit-pack",
          requestedQty: "2",
          conversionFactor: "1",
        })
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.resolution.requestedQty).toBe("48.0000");

      const factorLookup = mockTenantDb.productUnit.findUniqueOrThrow.mock.calls[0][0];
      expect(factorLookup.where).toMatchObject({ id: "unit-pack", tenantId: TENANT });
    });

    it("flags a shortfall measured in base units when the converted quantity exceeds stock", async () => {
      seed({
        baseUnitId: "unit-piece",
        soldUnitId: "unit-pack",
        soldUnitFactor: "24",
        batches: [batch("batch-1", "LOT-1", "50", new Date("2026-12-31"))],
      });

      const res = await previewHandler(
        previewRequest({ productId: "prod-1", unitId: "unit-pack", requestedQty: "3" })
      );
      const json = await res.json();
      // 3 x 24 = 72 needed, 50 available -> 22 short, all in base units.
      expect(json.resolution.fullyAllocated).toBe(false);
      expect(json.resolution.totalAllocatedQty).toBe("50.0000");
      expect(json.resolution.shortfallQty).toBe("22.0000");
    });

    it("returns 409 MISSING_BASE_UNIT when the product has no designated base unit", async () => {
      seed();
      mockTenantDb.product.findUniqueOrThrow.mockResolvedValue({
        id: "prod-1",
        tenantId: TENANT,
        baseUnitId: null,
        baseUnit: null,
      });

      const res = await previewHandler(
        previewRequest({ productId: "prod-1", unitId: "unit-base", requestedQty: "5" })
      );
      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.error).toBe("MISSING_BASE_UNIT");
      expect(mockTenantDb.productBatch.findMany).not.toHaveBeenCalled();
    });

    it("previewFifoAllocation itself refuses a non-base unitId (forgotten upstream conversion)", async () => {
      seed({ baseUnitId: "unit-piece" });

      await expect(
        previewFifoAllocation({
          tenantId: TENANT,
          productId: "prod-1",
          unitId: "unit-pack",
          requestedQty: "3",
        })
      ).rejects.toThrow(/Unit mismatch/);
      expect(mockTenantDb.productBatch.findMany).not.toHaveBeenCalled();
    });
  });

  describe("8. Cost snapshot carried on each allocation (T4g)", () => {
    it("serializes costPricePerBaseUnit at 8 decimal places without truncating to 4", async () => {
      const { baseUnitId } = seed({
        batches: [batch("batch-1", "B-1", "30", new Date("2026-12-31"), "333.33333333")],
      });

      const plan = await previewFifoAllocation({
        tenantId: TENANT,
        productId: "prod-1",
        unitId: baseUnitId,
        requestedQty: "10",
      });

      expect(plan.allocations[0].costPricePerBaseUnit).toBe("333.33333333");
    });
  });

  describe("9. Direct-call guards", () => {
    it("rejects a non-positive requestedQty", async () => {
      const { baseUnitId } = seed();
      await expect(
        previewFifoAllocation({ tenantId: TENANT, productId: "prod-1", unitId: baseUnitId, requestedQty: "0" })
      ).rejects.toThrow();
    });

    it("rejects an empty tenantId before touching the database", async () => {
      const { baseUnitId } = seed();
      await expect(
        previewFifoAllocation({ tenantId: "  ", productId: "prod-1", unitId: baseUnitId, requestedQty: "1" })
      ).rejects.toThrow(/tenantId is required/);
      expect(mockTenantDb.productBatch.findMany).not.toHaveBeenCalled();
    });
  });
});