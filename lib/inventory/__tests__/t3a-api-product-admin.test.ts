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
  const mockRawPrisma: any = {
    tenant: mockTenant,
    product: mockProduct,
    productUnit: mockProductUnit,
    productCatalogEntry: mockProductCatalogEntry,
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
import { DELETE as deleteProductHandler } from "@/app/api/inventory/products/[id]/route";

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
    it("deactivates unit and auto-unpublishes product if gate no longer satisfied", async () => {
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
      mockProduct.update.mockResolvedValueOnce({
        id: "p1",
        isPublic: false,
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
      expect(json.productIsPublic).toBe(false);
    });
  });

  describe("PATCH /api/inventory/products/[id]/toggle-active & DELETE", () => {
    it("deactivating product automatically resets isPublic to false", async () => {
      mockProduct.findFirst.mockResolvedValueOnce({
        id: "p1",
        isActive: true,
        isPublic: true,
      });
      mockProduct.update.mockResolvedValueOnce({
        id: "p1",
        isActive: false,
        isPublic: false,
      });

      const req = new Request("http://localhost/api/inventory/products/p1/toggle-active", {
        method: "PATCH",
      });
      const res = await toggleActiveHandler(req, { params: Promise.resolve({ id: "p1" }) });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.isActive).toBe(false);
      expect(json.isPublic).toBe(false);
    });

    it("DELETE soft-deactivates product and unpublishes from storefront", async () => {
      mockProduct.findFirst.mockResolvedValueOnce({
        id: "p1",
        isActive: true,
        isPublic: true,
      });
      mockProduct.update.mockResolvedValueOnce({
        id: "p1",
        isActive: false,
        isPublic: false,
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
        data: {
          isActive: false,
          isPublic: false,
        },
      });
    });

});
