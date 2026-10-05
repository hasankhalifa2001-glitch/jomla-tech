/* eslint-disable @typescript-eslint/no-explicit-any */
import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "fs";
import path from "path";
import { checkProductPublishable } from "@/lib/inventory/publishing-gate";
import {
  getOfflineDb,
  resetOfflineDbForTests,
  createCachedProductRecord,
} from "@/lib/offline";
import {
  calculateCartTotals,
  cartNeedsExchangeRate,
  resolveUnitPriceSYP,
  type CartLineItem,
} from "@/lib/offline/pos-service";

// ---------------------------------------------------------------------------
// Mock setup for API routes
// ---------------------------------------------------------------------------
const h = vi.hoisted(() => {
  const tenantFindUnique = vi.fn();
  const db: any = { tenant: { findUnique: tenantFindUnique } };
  db.$transaction = vi.fn(async (cb: (tx: any) => Promise<any>) => cb(db));

  return {
    db,
    tenantFindUnique,
    requireBaseUnit: vi.fn(),
    resetProductUnits: vi.fn(),
    updateNonBaseUnitConversionFactor: vi.fn(),
    gw: {
      findProductWithUnits: vi.fn(),
      findProductById: vi.fn(),
      updateProduct: vi.fn(),
      updateProductUnit: vi.fn(),
      setProductActive: vi.fn(),
      createAdditionalUnit: vi.fn(),
      createUnitBarcode: vi.fn(),
      resolveSharedCatalogForBarcode: vi.fn(),
      countProductBatches: vi.fn(),
      findProductUnitByBarcodeExcludingProduct: vi.fn(),
    },
    session: {
      user: {
        id: "user-test",
        role: "ADMIN",
        tenantId: "tenant-v46",
        subscriptionStatus: "ACTIVE",
      },
    } as any,
  };
});

vi.mock("@/lib/db", () => ({
  prisma: { tenant: { findUnique: h.tenantFindUnique } },
  getTenantDb: vi.fn(() => h.db),
}));
vi.mock("@/lib/db/tenant-scope", () => ({ getTenantDb: vi.fn(() => h.db) }));
vi.mock("@/auth", () => ({ auth: vi.fn(async () => h.session) }));
vi.mock("@/lib/data/products", () => h.gw);
vi.mock("@/lib/inventory/base-unit", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  requireBaseUnit: h.requireBaseUnit,
  resetProductUnits: h.resetProductUnits,
  updateNonBaseUnitConversionFactor: h.updateNonBaseUnitConversionFactor,
}));

import { PATCH as togglePublic } from "@/app/api/inventory/products/[id]/toggle-public/route";
import { PATCH as patchProduct } from "@/app/api/inventory/products/[id]/route";
import { POST as createProduct } from "@/app/api/inventory/products/route";

const ctx = (id = "prod-1") => ({ params: Promise.resolve({ id }) });

const jsonReq = (method: string, body?: unknown) =>
  new Request("http://localhost/api", {
    method,
    ...(body
      ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
      : {}),
  });

const baseUnitFixture = (over: any = {}) => ({
  id: "u1",
  unitName: "قطعة",
  conversionFactor: "1",
  isBaseUnit: true,
  isActive: true,
  pricingCurrency: "SYP",
  priceWholesale: "1000",
  barcodes: [],
  ...over,
});

const productFixture = (over: any = {}) => ({
  id: "prod-1",
  name: "منتج تجريبي",
  category: "أغذية",
  isActive: true,
  isPublic: false,
  imageUrl: "https://example.com/item.png",
  units: [baseUnitFixture()],
  ...over,
});

describe("Spec v4.6 — Product-Level Image Architecture & Acceptance Criteria", () => {
  beforeEach(async () => {
    Object.values(h.gw).forEach((f) => f.mockReset());
    h.requireBaseUnit.mockReset();
    h.tenantFindUnique.mockReset();

    h.session.user.role = "ADMIN";
    h.session.user.tenantId = "tenant-v46";
    h.tenantFindUnique.mockResolvedValue({ subscriptionStatus: "ACTIVE" });
    h.requireBaseUnit.mockResolvedValue({ id: "u1" });
    h.gw.countProductBatches.mockResolvedValue(0);

    await resetOfflineDbForTests();
  });

  // -------------------------------------------------------------------------
  // (a) gate: no image -> publish rejected
  // -------------------------------------------------------------------------
  describe("(a) Publishing Gate — No Image Rejection", () => {
    it("checkProductPublishable rejects null or empty product image with Arabic reason", () => {
      const resNull = checkProductPublishable({
        isActive: true,
        imageUrl: null,
        units: [{ isActive: true }],
      });
      expect(resNull.publishable).toBe(false);
      expect(resNull.reason).toBe("لا يمكن نشر المنتج في المتجر إلا بعد إضافة صورة للمنتج.");

      const resEmpty = checkProductPublishable({
        isActive: true,
        imageUrl: "   ",
        units: [{ isActive: true }],
      });
      expect(resEmpty.publishable).toBe(false);
      expect(resEmpty.reason).toBe("لا يمكن نشر المنتج في المتجر إلا بعد إضافة صورة للمنتج.");
    });

    it("checkProductPublishable passes when product has a valid non-empty imageUrl", () => {
      const res = checkProductPublishable({
        isActive: true,
        imageUrl: "https://images.example.com/product.jpg",
        units: [{ isActive: true }],
      });
      expect(res.publishable).toBe(true);
      expect(res.reason).toBeUndefined();
    });

    it("toggle-public rejects publishing a product lacking an image with 400 + Arabic message", async () => {
      h.gw.findProductWithUnits.mockResolvedValue(productFixture({ imageUrl: null, isPublic: false }));
      const res = await togglePublic(jsonReq("PATCH"), ctx());
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe("PUBLISH_GATE_BLOCKED");
      expect(json.message).toContain("لا يمكن نشر المنتج في المتجر إلا بعد إضافة صورة للمنتج");
      expect(h.gw.updateProduct).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // (b) clearing image on a public product rejected, replacing allowed
  // -------------------------------------------------------------------------
  describe("(b) Image Modification on Public Products", () => {
    it("rejects clearing image (null) when product is public with 400 + Arabic message", async () => {
      h.gw.findProductWithUnits.mockResolvedValue(
        productFixture({ isPublic: true, imageUrl: "https://example.com/current.jpg" })
      );
      const res = await patchProduct(
        jsonReq("PATCH", { imageUrl: null }),
        ctx()
      );
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe("PUBLISH_GATE_BLOCKED");
      expect(json.message).toContain("لا يمكن نشر المنتج في المتجر إلا بعد إضافة صورة للمنتج");
      expect(h.gw.updateProduct).not.toHaveBeenCalled();
    });

    it("rejects clearing image (empty or whitespace string) when product is public with 400 + Arabic message", async () => {
      h.gw.findProductWithUnits.mockResolvedValue(
        productFixture({ isPublic: true, imageUrl: "https://example.com/current.jpg" })
      );
      const res = await patchProduct(
        jsonReq("PATCH", { imageUrl: "   " }),
        ctx()
      );
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe("PUBLISH_GATE_BLOCKED");
      expect(json.message).toContain("لا يمكن نشر المنتج في المتجر إلا بعد إضافة صورة للمنتج");
      expect(h.gw.updateProduct).not.toHaveBeenCalled();
    });

    it("allows replacing image on a public product with a new valid URL", async () => {
      h.gw.findProductWithUnits.mockResolvedValue(
        productFixture({ isPublic: true, imageUrl: "https://example.com/old.jpg" })
      );
      const res = await patchProduct(
        jsonReq("PATCH", { imageUrl: "https://example.com/replacement.png" }),
        ctx()
      );
      expect(res.status).toBe(200);
      expect(h.gw.updateProduct).toHaveBeenCalledWith(
        h.db,
        "tenant-v46",
        "prod-1",
        expect.objectContaining({
          imageUrl: "https://example.com/replacement.png",
        })
      );
    });
  });

  // -------------------------------------------------------------------------
  // (c) CASHIER rejected via direct API call
  // -------------------------------------------------------------------------
  describe("(c) CASHIER Role Restriction on Direct API Calls", () => {
    beforeEach(() => {
      h.session.user.role = "CASHIER";
    });

    it("rejects CASHIER on PATCH /api/inventory/products/[id] with 403 FORBIDDEN", async () => {
      const res = await patchProduct(jsonReq("PATCH", { name: "تعديل محظور" }), ctx());
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error).toBe("FORBIDDEN");
      expect(h.gw.updateProduct).not.toHaveBeenCalled();
    });

    it("rejects CASHIER on PATCH /api/inventory/products/[id]/toggle-public with 403 FORBIDDEN", async () => {
      const res = await togglePublic(jsonReq("PATCH"), ctx());
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error).toBe("FORBIDDEN");
      expect(h.gw.updateProduct).not.toHaveBeenCalled();
    });

    it("rejects CASHIER on POST /api/inventory/products with 403 FORBIDDEN", async () => {
      const res = await createProduct(
        jsonReq("POST", {
          name: "منتج جديد",
          units: [
            {
              unitName: "قطعة",
              conversionFactor: "1",
              priceWholesale: "1000",
              pricingCurrency: "SYP",
            },
          ],
        })
      );
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error).toBe("FORBIDDEN");
    });
  });

  // -------------------------------------------------------------------------
  // (d) static source check: no unit.imageUrl / units[].imageUrl anywhere
  // -------------------------------------------------------------------------
  describe("(d) Static Source Code Invariant", () => {
    it("verifies no active code accesses unit.imageUrl, units[].imageUrl, or u.imageUrl across codebase", () => {
      const projectRoot = path.resolve(__dirname, "../../../");
      const targetDirs = ["app", "components", "lib", "prisma"];
      const allowedExtensions = [".ts", ".tsx", ".js", ".jsx"];

      const violations: Array<{ file: string; line: number; match: string }> = [];

      function walkDirectory(dir: string) {
        if (!fs.existsSync(dir)) return;
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            if (entry.name === "node_modules" || entry.name === ".next" || entry.name === ".git") {
              continue;
            }
            walkDirectory(fullPath);
          } else if (entry.isFile()) {
            const ext = path.extname(entry.name);
            if (!allowedExtensions.includes(ext)) continue;
            // Skip test files from this check to avoid self-reference
            if (entry.name.includes(".test.") || entry.name.includes(".spec.")) continue;

            const content = fs.readFileSync(fullPath, "utf8");
            const lines = content.split("\n");

            lines.forEach((line, index) => {
              // Strip single-line comments
              const codeOnly = line.split("//")[0].trim();
              if (!codeOnly) return;

              // Check for unit.imageUrl or units[...].imageUrl or u.imageUrl in code
              const regex = /(?:unit|units\[\w*\]|u)\.imageUrl\b/;
              if (regex.test(codeOnly)) {
                violations.push({
                  file: path.relative(projectRoot, fullPath),
                  line: index + 1,
                  match: line.trim(),
                });
              }
            });
          }
        }
      }

      for (const d of targetDirs) {
        walkDirectory(path.join(projectRoot, d));
      }

      expect(violations).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // (e) Dexie: cached product without imageUrl doesn't break POS
  // -------------------------------------------------------------------------
  describe("(e) Dexie Cache & POS Flow without Product imageUrl", () => {
    it("handles cached product with omitted/undefined imageUrl gracefully throughout POS sale", async () => {
      const db = getOfflineDb();

      // Create product where imageUrl is omitted / undefined
      const productNoImage = createCachedProductRecord({
        tenantId: "tenant-v46",
        id: "prod-no-img",
        name: "منتج بدون صورة",
        units: [
          {
            id: "unit-no-img-1",
            unitName: "علبة",
            conversionFactor: 1,
            priceWholesale: "15000",
            pricingCurrency: "SYP",
            isActive: true,
            barcodes: [{ id: "b1", barcode: "6210009990001", barcodeSource: "GS1" }],
          },
        ],
        batches: [],
      });

      // Verify imageUrl is undefined
      expect(productNoImage.imageUrl).toBeUndefined();

      // Save to Dexie cachedProducts
      await db.cachedProducts.put(productNoImage);

      // Retrieve from Dexie
      const retrieved = await db.cachedProducts.get("prod-no-img");
      expect(retrieved).toBeDefined();
      expect(retrieved?.imageUrl).toBeUndefined();

      // Construct cart line item
      const lineItem: CartLineItem = {
        id: "line-no-img",
        product: retrieved!,
        unitId: "unit-no-img-1",
        unitName: "علبة",
        conversionFactor: "1",
        quantity: 3,
        unitPriceSYP: "15000",
        unitPriceUSD: null,
        pricingCurrency: "SYP",
      };

      // Ensure POS utilities execute with no error
      const needsRate = cartNeedsExchangeRate([lineItem]);
      expect(needsRate).toBe(false);

      const price = resolveUnitPriceSYP(retrieved!.units[0], retrieved!, null);
      expect(price.toString()).toBe("15000.0000");

      const totals = calculateCartTotals([lineItem], null);
      expect(totals.totalSYP).toBe("45000.0000");
      expect(totals.totalUSD).toBeNull();
    });
  });
});
