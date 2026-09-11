/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockTenant, mockRawPrisma, mockSessionState } =
  vi.hoisted(() => {
    const mockTenant = {
      findUnique: vi.fn(),
      update: vi.fn(),
    };
    const mockProduct = {
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    };
    const mockProductUnit = {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
    };
    const mockProductBatch = {
      create: vi.fn(),
    };
    const mockUser = {
      findUnique: vi.fn(async () => ({ isActive: true })),
    };
    const mockRawPrisma: any = {
      tenant: mockTenant,
      user: mockUser,
      product: mockProduct,
      productUnit: mockProductUnit,
      productBatch: mockProductBatch,
    };
    mockRawPrisma.$transaction = vi.fn(async (cb: (tx: any) => Promise<any>) => cb(mockRawPrisma));

    const mockSessionState = {
      session: {
        user: {
          id: "user-admin",
          role: "ADMIN",
          tenantId: "tenant-1",
          subscriptionStatus: "ACTIVE",
        },
      } as any,
    };

    return {
      mockTenant,
      mockProduct,
      mockProductUnit,
      mockProductBatch,
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
  tenantScopedRawQuery: vi.fn(async () => []),
}));

// Partially mock csv-parser: keep every real export (including STRICT_DATE_REGEX
// and any future export added by T3d) via importOriginal, and only override the
// two functions this test suite actually needs to stub out. This avoids the
// suite breaking every time csv-parser.ts gains a new export that some route
// file imports directly, since a full vi.mock({...}) replacement silently
// leaves such new exports undefined.
vi.mock("@/lib/inventory/csv-parser", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/inventory/csv-parser")>();
  return {
    ...actual,
    commitCsvImport: vi.fn(async () => ({
      createdProductsCount: 1,
      updatedPricesCount: 0,
      failedNewProducts: [],
      skippedPriceUpdates: 0,
      failedPriceUpdates: [],
    })),
    validateAndPreviewCsv: vi.fn(async () => ({
      validNewProducts: [],
      validPriceUpdates: [],
      errors: [],
    })),
  };
});

vi.mock("@/auth", () => ({
  auth: vi.fn(async () => mockSessionState.session),
}));

import { POST as createProductHandler } from "@/app/api/inventory/products/route";
import { PATCH as togglePublicHandler } from "@/app/api/inventory/products/[id]/toggle-public/route";
import { POST as createBatchHandler } from "@/app/api/inventory/batches/route";
import { POST as commitImportHandler } from "@/app/api/inventory/import/commit/route";
import { POST as previewImportHandler } from "@/app/api/inventory/import/preview/route";
import { POST as exchangeRateHandler } from "@/app/api/tenant/exchange-rate/route";
import { POST as repaymentHandler } from "@/app/api/ledger/repayments/route";
import { POST as voidHandler } from "@/app/api/ledger/voids/route";
import { POST as mergeHandler } from "@/app/api/ledger/merge/route";
import { GET as failedSyncHandler } from "@/app/api/ledger/failed-sync/route";
import { PATCH as orderStatusHandler } from "@/app/api/orders/[id]/status/route";
import { GET as ordersHandler } from "@/app/api/orders/route";

describe("T2b API Mutation Security Boundary & Role Enforcement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionState.session = {
      user: {
        id: "user-admin",
        role: "ADMIN",
        tenantId: "tenant-1",
        subscriptionStatus: "ACTIVE",
      },
    };
    mockTenant.findUnique.mockResolvedValue({
      id: "tenant-1",
      subscriptionStatus: "ACTIVE",
      dailyExchangeRate: "16000",
    });
  });

  describe("1. Subscription Lockout on Mutating API Endpoints (EXPIRED/PENDING)", () => {
    it("rejects POST /api/inventory/products when tenant subscription is PENDING in DB", async () => {
      mockTenant.findUnique.mockResolvedValueOnce({ subscriptionStatus: "PENDING" });
      const req = new Request("http://localhost/api/inventory/products", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Test",
          units: [{ unitName: "قطعة", conversionFactor: 1, priceWholesale: 50 }],
        }),
      });
      const res = await createProductHandler(req);
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error).toBe("SUBSCRIPTION_LOCKED");
    });

    it("rejects POST /api/tenant/exchange-rate when tenant subscription is EXPIRED in DB", async () => {
      mockTenant.findUnique.mockResolvedValueOnce({ subscriptionStatus: "EXPIRED" });
      const req = new Request("http://localhost/api/tenant/exchange-rate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rate: 16500 }),
      });
      const res = await exchangeRateHandler(req);
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error).toBe("SUBSCRIPTION_LOCKED");
    });

    it("allows approval mid-session: previously blocked mutation immediately succeeds after DB update", async () => {
      mockTenant.findUnique.mockResolvedValueOnce({ subscriptionStatus: "PENDING" });
      const req1 = new Request("http://localhost/api/tenant/exchange-rate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rate: 16500 }),
      });
      const res1 = await exchangeRateHandler(req1);
      expect(res1.status).toBe(403);

      // Super-Admin approves in DB
      mockTenant.findUnique.mockResolvedValueOnce({ subscriptionStatus: "ACTIVE" });
      mockTenant.update.mockResolvedValueOnce({ id: "tenant-1", dailyExchangeRate: 16500 });

      const req2 = new Request("http://localhost/api/tenant/exchange-rate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rate: 16500 }),
      });
      const res2 = await exchangeRateHandler(req2);
      expect(res2.status).toBe(200);
      const json2 = await res2.json();
      expect(json2.success).toBe(true);
    });
  });

  describe("2. Server-Side CASHIER Role Enforcement", () => {
    beforeEach(() => {
      mockSessionState.session = {
        user: {
          id: "user-cashier",
          role: "CASHIER",
          tenantId: "tenant-1",
          subscriptionStatus: "ACTIVE",
        },
      };
    });

    it("rejects CASHIER from creating product, batch, toggling public, or CSV import", async () => {
      const pRes = await createProductHandler(
        new Request("http://localhost/api/inventory/products", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "P", units: [] }),
        })
      );
      expect(pRes.status).toBe(403);
      expect((await pRes.json()).error).toBe("FORBIDDEN");

      const bRes = await createBatchHandler(
        new Request("http://localhost/api/inventory/batches", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        })
      );
      expect(bRes.status).toBe(403);
      expect((await bRes.json()).error).toBe("FORBIDDEN");

      const tRes = await togglePublicHandler(
        new Request("http://localhost/api/inventory/products/1/toggle-public", { method: "PATCH" }),
        { params: Promise.resolve({ id: "1" }) }
      );
      expect(tRes.status).toBe(403);
      expect((await tRes.json()).error).toBe("FORBIDDEN");

      const cRes = await commitImportHandler(
        new Request("http://localhost/api/inventory/import/commit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ newProducts: [], priceUpdates: [] }),
        })
      );
      expect(cRes.status).toBe(403);
      expect((await cRes.json()).error).toBe("FORBIDDEN");

      const prevRes = await previewImportHandler(
        new Request("http://localhost/api/inventory/import/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ csvString: "sample" }),
        })
      );
      expect(prevRes.status).toBe(403);
      expect((await prevRes.json()).error).toBe("FORBIDDEN");
    });

    it("rejects CASHIER from ledger repayments, voids, merge, and failed sync", async () => {
      const repRes = await repaymentHandler(new Request("http://localhost/api/ledger/repayments", { method: "POST" }));
      expect(repRes.status).toBe(403);
      expect((await repRes.json()).error).toBe("FORBIDDEN");

      const voidRes = await voidHandler(new Request("http://localhost/api/ledger/voids", { method: "POST" }));
      expect(voidRes.status).toBe(403);
      expect((await voidRes.json()).error).toBe("FORBIDDEN");

      const mergeRes = await mergeHandler(new Request("http://localhost/api/ledger/merge", { method: "POST" }));
      expect(mergeRes.status).toBe(403);
      expect((await mergeRes.json()).error).toBe("FORBIDDEN");

      const syncFailRes = await failedSyncHandler();
      expect(syncFailRes.status).toBe(403);
      expect((await syncFailRes.json()).error).toBe("FORBIDDEN");
    });

    it("rejects CASHIER from approving/rejecting orders, but permits reading orders queue", async () => {
      const orderPatchRes = await orderStatusHandler(
        new Request("http://localhost/api/orders/o-1/status", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "APPROVED" }),
        }),
        { params: Promise.resolve({ id: "o-1" }) }
      );
      expect(orderPatchRes.status).toBe(403);
      expect((await orderPatchRes.json()).error).toBe("FORBIDDEN");

      const ordersGetRes = await ordersHandler();
      expect(ordersGetRes.status).toBe(200);
      const json = await ordersGetRes.json();
      expect(json.success).toBe(true);
      expect(Array.isArray(json.orders)).toBe(true);
    });
  });
});