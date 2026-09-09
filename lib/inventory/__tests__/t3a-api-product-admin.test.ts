/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockTenant,
  mockProduct,
  mockProductUnit,
  mockProductCatalogEntry,
  mockRawPrisma,
  mockSessionState,
} = vi.hoisted(() => {
  const mockTenant = {
    findUnique: vi.fn(),
  };
  const mockProduct = {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
    create: vi.fn(),
  };
  const mockProductUnit = {
    findFirst: vi.fn(),
    update: vi.fn(),
    create: vi.fn(),
  };
  const mockProductCatalogEntry = {
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  };
  const mockProductCatalogEntryReport = {
    findUnique: vi.fn(),
    create: vi.fn(),
  };
  const mockRawPrisma: any = {
    tenant: mockTenant,
    product: mockProduct,
    productUnit: mockProductUnit,
    productCatalogEntry: mockProductCatalogEntry,
    productCatalogEntryReport: mockProductCatalogEntryReport,
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
    mockProductCatalogEntry,
    mockProductCatalogEntryReport,
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

import { PATCH as togglePublicHandler } from "@/app/api/inventory/products/[id]/toggle-public/route";
import { PATCH as toggleActiveHandler } from "@/app/api/inventory/products/[id]/toggle-active/route";
import { PATCH as toggleUnitActiveHandler } from "@/app/api/inventory/products/[id]/units/[unitId]/toggle-active/route";
import {
  PATCH as patchProductHandler,
  DELETE as deleteProductHandler,
} from "@/app/api/inventory/products/[id]/route";
import { GET as catalogLookupHandler } from "@/app/api/catalog/lookup/route";
import { POST as catalogReportHandler } from "@/app/api/catalog/report/route";

describe("T3a API Endpoints — Product & Unit Administration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTenant.findUnique.mockResolvedValue({
      subscriptionStatus: "ACTIVE",
    });
  });

  describe("PATCH /api/inventory/products/[id]/toggle-public", () => {
    it("returns 400 with PRODUCT_INACTIVE when product is inactive", async () => {
      mockProduct.findFirst.mockResolvedValueOnce({
        id: "p1",
        name: "زيت",
        isActive: false,
        isPublic: false,
        units: [
          {
            id: "u1",
            isActive: true,
            priceRetail: 1000,
            imageUrl: "https://example.com/img.jpg",
          },
        ],
      });

      const req = new Request("http://localhost/api/inventory/products/p1/toggle-public", {
        method: "PATCH",
      });
      const res = await togglePublicHandler(req, { params: Promise.resolve({ id: "p1" }) });
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe("PRODUCT_INACTIVE");
    });

    it("returns 400 with PUBLISH_GATE_BLOCKED when active unit has no price or image", async () => {
      mockProduct.findFirst.mockResolvedValueOnce({
        id: "p1",
        name: "زيت",
        isActive: true,
        isPublic: false,
        units: [
          {
            id: "u1",
            isActive: true,
            priceRetail: null,
            imageUrl: null,
          },
        ],
      });

      const req = new Request("http://localhost/api/inventory/products/p1/toggle-public", {
        method: "PATCH",
      });
      const res = await togglePublicHandler(req, { params: Promise.resolve({ id: "p1" }) });
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe("PUBLISH_GATE_BLOCKED");
    });

    it("toggles isPublic to true when publishing gate is satisfied", async () => {
      mockProduct.findFirst.mockResolvedValueOnce({
        id: "p1",
        name: "زيت",
        isActive: true,
        isPublic: false,
        units: [
          {
            id: "u1",
            isActive: true,
            priceRetail: 1200,
            imageUrl: "https://example.com/item.jpg",
          },
        ],
      });
      mockProduct.update.mockResolvedValueOnce({
        id: "p1",
        isPublic: true,
      });

      const req = new Request("http://localhost/api/inventory/products/p1/toggle-public", {
        method: "PATCH",
      });
      const res = await togglePublicHandler(req, { params: Promise.resolve({ id: "p1" }) });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.isPublic).toBe(true);
    });
  });

  describe("PATCH /api/inventory/products/[id]/units/[unitId]/toggle-active", () => {
    // [UPDATED] Deactivating a unit must NEVER touch Product.isPublic —
    // it's a pure visibility toggle on the unit alone (T1/T3a). Previously
    // this test asserted the opposite (auto-unpublish), which was the bug
    // we just removed from the route.
    it("deactivates unit without touching product.isPublic, even if the gate would now fail", async () => {
      mockProduct.findFirst.mockResolvedValueOnce({
        id: "p1",
        isActive: true,
        isPublic: true,
        units: [
          {
            id: "u1",
            isActive: true,
            priceRetail: 1200,
            imageUrl: "https://example.com/item.jpg",
          },
          {
            id: "u2",
            isActive: true,
            priceRetail: null,
            imageUrl: null,
          },
        ],
      });
      mockProductUnit.update.mockResolvedValueOnce({
        id: "u1",
        isActive: false,
      });

      const req = new Request("http://localhost/api/inventory/products/p1/units/u1/toggle-active", {
        method: "PATCH",
      });
      const res = await toggleUnitActiveHandler(req, {
        params: Promise.resolve({ id: "p1", unitId: "u1" }),
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.unit.isActive).toBe(false);
      // isPublic is carried over UNCHANGED — never forced to false as a
      // side effect of a unit going inactive.
      expect(json.productIsPublic).toBe(true);
      // The route must not even attempt to update Product.isPublic here.
      expect(mockProduct.update).not.toHaveBeenCalled();
    });
  });

  describe("PATCH /api/inventory/products/[id]/toggle-active & DELETE", () => {
    // [UPDATED] Deactivating a product must NEVER auto-reset isPublic.
    // Previously this test asserted the opposite, encoding the bug we
    // just removed.
    it("deactivating product leaves isPublic untouched", async () => {
      mockProduct.findFirst.mockResolvedValueOnce({
        id: "p1",
        isActive: true,
        isPublic: true,
      });
      mockProduct.update.mockResolvedValueOnce({
        id: "p1",
        isActive: false,
        isPublic: true,
      });

      const req = new Request("http://localhost/api/inventory/products/p1/toggle-active", {
        method: "PATCH",
      });
      const res = await toggleActiveHandler(req, { params: Promise.resolve({ id: "p1" }) });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.isActive).toBe(false);
      expect(json.isPublic).toBe(true);
      // The update call itself must only ever touch isActive here.
      expect(mockProduct.update).toHaveBeenCalledWith({
        where: { id: "p1" },
        data: { isActive: false },
      });
    });

    // [UPDATED] DELETE (soft-deactivate) must also leave isPublic
    // untouched — same "pure visibility toggle" rule applies here too.
    it("DELETE soft-deactivates product without touching isPublic", async () => {
      mockProduct.findFirst.mockResolvedValueOnce({
        id: "p1",
        isActive: true,
        isPublic: true,
      });
      mockProduct.update.mockResolvedValueOnce({
        id: "p1",
        isActive: false,
        isPublic: true,
      });

      const req = new Request("http://localhost/api/inventory/products/p1", {
        method: "DELETE",
      });
      const res = await deleteProductHandler(req, { params: Promise.resolve({ id: "p1" }) });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(mockProduct.update).toHaveBeenCalledWith({
        where: { id: "p1" },
        data: { isActive: false },
      });
    });
  });

  describe("PATCH /api/inventory/products/[id] & DELETE — Role-Based Access Control (RBAC)", () => {
    it("rejects CASHIER role on PATCH with 403 FORBIDDEN", async () => {
      mockSessionState.session.user.role = "CASHIER";

      const req = new Request("http://localhost/api/inventory/products/p1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "اسم جديد" }),
      });

      const res = await patchProductHandler(req, { params: Promise.resolve({ id: "p1" }) });
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error).toBe("FORBIDDEN");

      mockSessionState.session.user.role = "ADMIN";
    });

    it("rejects CASHIER role on DELETE with 403 FORBIDDEN", async () => {
      mockSessionState.session.user.role = "CASHIER";

      const req = new Request("http://localhost/api/inventory/products/p1", {
        method: "DELETE",
      });

      const res = await deleteProductHandler(req, { params: Promise.resolve({ id: "p1" }) });
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error).toBe("FORBIDDEN");

      mockSessionState.session.user.role = "ADMIN";
    });
  });

  describe("PATCH /api/inventory/products/[id] — Name, Category & Preservation", () => {
    it("updates name and category without touching units or publishing state", async () => {
      mockProduct.findFirst.mockResolvedValueOnce({
        id: "p1",
        name: "زيت قديم",
        category: "تموين",
        isActive: true,
        isPublic: true,
        units: [
          {
            id: "u1",
            unitName: "قطعة",
            conversionFactor: 1,
            priceWholesale: 500,
            priceRetail: 600,
            isActive: true,
            imageUrl: "https://example.com/item.jpg",
          },
        ],
      });

      mockProduct.update.mockResolvedValueOnce({
        id: "p1",
        name: "زيت جديد",
        category: "زيوت",
        isActive: true,
        isPublic: true,
      });

      const req = new Request("http://localhost/api/inventory/products/p1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "زيت جديد", category: "زيوت" }),
      });

      const res = await patchProductHandler(req, { params: Promise.resolve({ id: "p1" }) });
      expect(res.status).toBe(200);

      expect(mockProduct.update).toHaveBeenCalledWith({
        where: { id: "p1" },
        data: {
          name: "زيت جديد",
          category: "زيوت",
          isActive: true,
          isPublic: true,
        },
      });
      expect(mockProductUnit.update).not.toHaveBeenCalled();
      expect(mockProductUnit.create).not.toHaveBeenCalled();
    });
  });

  describe("PATCH /api/inventory/products/[id] — BarcodeSource Validation Gate", () => {
    it("rejects a unit with non-empty barcode when barcodeSource is missing or null", async () => {
      mockProduct.findFirst.mockResolvedValueOnce({
        id: "p1",
        name: "شاي",
        isActive: true,
        isPublic: false,
        units: [],
      });

      const req = new Request("http://localhost/api/inventory/products/p1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          units: [
            {
              unitName: "علبة",
              conversionFactor: 1,
              priceWholesale: 100,
              barcode: "6291041500214",
              barcodeSource: null,
            },
          ],
        }),
      });

      const res = await patchProductHandler(req, { params: Promise.resolve({ id: "p1" }) });
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe("VALIDATION_ERROR");
    });

    it("accepts a unit with barcode when barcodeSource is explicitly GS1 or INTERNAL", async () => {
      mockProduct.findFirst.mockResolvedValueOnce({
        id: "p1",
        name: "شاي",
        isActive: true,
        isPublic: false,
        units: [],
      });
      mockProduct.update.mockResolvedValueOnce({
        id: "p1",
        name: "شاي",
        isActive: true,
        isPublic: false,
      });
      mockProductUnit.create.mockResolvedValueOnce({
        id: "u1",
        unitName: "علبة",
        conversionFactor: 1,
        barcode: "6291041500214",
        barcodeSource: "INTERNAL",
      });

      const req = new Request("http://localhost/api/inventory/products/p1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          units: [
            {
              unitName: "علبة",
              conversionFactor: 1,
              priceWholesale: 100,
              barcode: "6291041500214",
              barcodeSource: "INTERNAL",
            },
          ],
        }),
      });

      const res = await patchProductHandler(req, { params: Promise.resolve({ id: "p1" }) });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
    });
  });
});