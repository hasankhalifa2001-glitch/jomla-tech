/* eslint-disable no-restricted-syntax */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// The routes read/write products ONLY through lib/data/products.ts (gateway),
// and check subscription via lib/auth/tenant.ts -> getTenantDb(...).tenant.
// So we mock the gateway itself, and give the fake db a `tenant` model.
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
        id: "user-admin",
        role: "ADMIN",
        tenantId: "tenant-1",
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
import { PATCH as toggleActive } from "@/app/api/inventory/products/[id]/toggle-active/route";
import { PATCH as toggleUnitActive } from "@/app/api/inventory/products/[id]/units/[unitId]/toggle-active/route";
import {
  PATCH as patchProduct,
  DELETE as deleteProduct,
} from "@/app/api/inventory/products/[id]/route";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const ctx = (id = "p1") => ({ params: Promise.resolve({ id }) });

const req = (method: string, body?: unknown) =>
  new Request("http://localhost/x", {
    method,
    ...(body
      ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
      : {}),
  });

// Shape returned by findProductWithUnits (DisplayUnitWithBaseFlag)
const baseUnit = (over: any = {}) => ({
  id: "u1",
  unitName: "قطعة",
  conversionFactor: "1",
  isBaseUnit: true,
  isActive: true,
  pricingCurrency: "SYP",
  priceWholesale: "500",
  barcodes: [],
  ...over,
});

const product = (over: any = {}) => ({
  id: "p1",
  name: "زيت",
  category: "تموين",
  isActive: true,
  isPublic: false,
  // [v4.6] The ONE product image (moved here from ProductUnit). Having it on
  // the product by default keeps the "gate passes" fixtures meaningful; tests
  // that need the gate to fail override it with null.
  imageUrl: "https://example.com/item.jpg",
  units: [baseUnit()],
  ...over,
});

const unitPatch = (over: any = {}) => ({
  id: "u1",
  unitName: "قطعة",
  conversionFactor: "1",
  priceWholesale: "500",
  ...over,
});

// The last argument passed to updateProductUnit for a given unit id.
const unitUpdateArgs = (unitId: string) =>
  h.gw.updateProductUnit.mock.calls.find((c: any[]) => c[2] === unitId)?.[3];

describe("T3a API — Product & Unit Administration", () => {
  beforeEach(() => {
    // mockReset (not clearAllMocks): also drops leftover implementations so
    // one test's mockResolvedValue can never leak into the next.
    Object.values(h.gw).forEach((f) => f.mockReset());
    h.requireBaseUnit.mockReset();
    h.resetProductUnits.mockReset();
    h.updateNonBaseUnitConversionFactor.mockReset();
    h.tenantFindUnique.mockReset();

    h.session.user.role = "ADMIN";
    h.tenantFindUnique.mockResolvedValue({ subscriptionStatus: "ACTIVE" });
    h.requireBaseUnit.mockResolvedValue({ id: "u1" });
    h.gw.countProductBatches.mockResolvedValue(0);
  });

  // -------------------------------------------------------------------------
  describe("PATCH toggle-public", () => {
    it("400 PRODUCT_INACTIVE when the product is inactive", async () => {
      h.gw.findProductWithUnits.mockResolvedValue(product({ isActive: false }));
      const res = await togglePublic(req("PATCH"), ctx());
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("PRODUCT_INACTIVE");
      expect(h.gw.updateProduct).not.toHaveBeenCalled();
    });

    it("400 PUBLISH_GATE_BLOCKED when the PRODUCT has no image", async () => {
      h.gw.findProductWithUnits.mockResolvedValue(product({ imageUrl: null }));
      const res = await togglePublic(req("PATCH"), ctx());
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("PUBLISH_GATE_BLOCKED");
      expect(h.gw.updateProduct).not.toHaveBeenCalled();
    });

    it("publishes when the gate passes, scoped by tenant", async () => {
      h.gw.findProductWithUnits.mockResolvedValue(product());
      h.gw.updateProduct.mockResolvedValue({ id: "p1", isPublic: true });
      const res = await togglePublic(req("PATCH"), ctx());
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.isPublic).toBe(true);
      expect(h.gw.updateProduct).toHaveBeenCalledWith(h.db, "tenant-1", "p1", {
        isPublic: true,
      });
    });

    it("404 for a product that is not in this tenant", async () => {
      h.gw.findProductWithUnits.mockResolvedValue(null);
      const res = await togglePublic(req("PATCH"), ctx());
      expect(res.status).toBe(404);
      expect(h.gw.updateProduct).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  describe("PATCH unit toggle-active", () => {
    it("deactivates the unit and never touches Product.isPublic", async () => {
      h.gw.findProductWithUnits.mockResolvedValue(
        product({
          isPublic: true,
          units: [
            baseUnit(),
            baseUnit({ id: "u2", isBaseUnit: false, conversionFactor: "24" }),
          ],
        })
      );
      h.gw.updateProductUnit.mockResolvedValue({ id: "u2", isActive: false });

      const res = await toggleUnitActive(req("PATCH"), {
        params: Promise.resolve({ id: "p1", unitId: "u2" }),
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.unit.isActive).toBe(false);
      expect(json.productIsPublic).toBe(true);
      expect(h.gw.updateProductUnit).toHaveBeenCalledWith(h.db, "tenant-1", "u2", {
        isActive: false,
      });
      expect(h.gw.updateProduct).not.toHaveBeenCalled();
    });

    it("404 when the unit belongs to another product", async () => {
      h.gw.findProductWithUnits.mockResolvedValue(product());
      const res = await toggleUnitActive(req("PATCH"), {
        params: Promise.resolve({ id: "p1", unitId: "foreign" }),
      });
      expect(res.status).toBe(404);
      expect(h.gw.updateProductUnit).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  describe("PATCH toggle-active & DELETE", () => {
    it("toggle-active goes through setProductActive only", async () => {
      h.gw.findProductById.mockResolvedValue({ id: "p1", isActive: true, isPublic: true });
      h.gw.setProductActive.mockResolvedValue({ id: "p1", isActive: false, isPublic: true });

      const res = await toggleActive(req("PATCH"), ctx());
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.isActive).toBe(false);
      expect(json.isPublic).toBe(true);
      expect(h.gw.setProductActive).toHaveBeenCalledWith(h.db, "tenant-1", "p1", false);
      expect(h.gw.updateProduct).not.toHaveBeenCalled();
    });

    it("DELETE soft-deactivates only", async () => {
      h.gw.findProductWithUnits.mockResolvedValue(product({ isPublic: true }));
      h.gw.setProductActive.mockResolvedValue({});

      const res = await deleteProduct(req("DELETE"), ctx());
      expect(res.status).toBe(200);
      expect((await res.json()).success).toBe(true);
      expect(h.gw.setProductActive).toHaveBeenCalledWith(h.db, "tenant-1", "p1", false);
      expect(h.gw.updateProduct).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  describe("RBAC + subscription lock", () => {
    it.each([
      ["PATCH product", () => patchProduct(req("PATCH", { name: "x" }), ctx())],
      ["DELETE product", () => deleteProduct(req("DELETE"), ctx())],
      ["toggle-public", () => togglePublic(req("PATCH"), ctx())],
      ["toggle-active", () => toggleActive(req("PATCH"), ctx())],
    ])("CASHIER gets 403 on %s with zero gateway calls", async (_name, call) => {
      h.session.user.role = "CASHIER";
      const res = await call();
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe("FORBIDDEN");
      expect(Object.values(h.gw).some((f) => f.mock.calls.length > 0)).toBe(false);
    });

    it("PENDING tenant gets 403 before any product read", async () => {
      h.tenantFindUnique.mockResolvedValue({ subscriptionStatus: "PENDING" });
      const res = await deleteProduct(req("DELETE"), ctx());
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe("SUBSCRIPTION_LOCKED");
      expect(h.gw.findProductWithUnits).not.toHaveBeenCalled();
    });

    it("EXPIRED tenant gets 403 on PATCH product", async () => {
      h.tenantFindUnique.mockResolvedValue({ subscriptionStatus: "EXPIRED" });
      const res = await patchProduct(req("PATCH", { name: "x" }), ctx());
      expect(res.status).toBe(403);
      expect(h.gw.updateProduct).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  describe("PATCH product — name, category & preservation", () => {
    it("updates name/category, sends NO stale isActive/isPublic, touches no units", async () => {
      h.gw.findProductWithUnits.mockResolvedValue(product({ isPublic: true }));

      const res = await patchProduct(
        req("PATCH", { name: "زيت جديد", category: "زيوت" }),
        ctx()
      );
      expect(res.status).toBe(200);

      expect(h.gw.updateProduct).toHaveBeenCalledTimes(1);
      const args = h.gw.updateProduct.mock.calls[0][3];
      expect(args.name).toBe("زيت جديد");
      expect(args.category).toBe("زيوت");
      // Fields the client didn't send must stay undefined ("don't touch"),
      // so a concurrent toggle can't be overwritten with a stale read.
      expect(args.isActive).toBeUndefined();
      expect(args.isPublic).toBeUndefined();

      expect(h.gw.createAdditionalUnit).not.toHaveBeenCalled();
      expect(h.gw.updateProductUnit).not.toHaveBeenCalled();
      expect(h.gw.createUnitBarcode).not.toHaveBeenCalled();
    });

    it("forwards isPublic only when the client sent it", async () => {
      h.gw.findProductWithUnits.mockResolvedValue(product());
      const res = await patchProduct(req("PATCH", { isPublic: true }), ctx());
      expect(res.status).toBe(200);
      const args = h.gw.updateProduct.mock.calls[0][3];
      expect(args.isPublic).toBe(true);
      expect(args.isActive).toBeUndefined();
    });

    it("404 when the product is outside the tenant", async () => {
      h.gw.findProductWithUnits.mockResolvedValue(null);
      const res = await patchProduct(req("PATCH", { name: "x" }), ctx());
      expect(res.status).toBe(404);
      expect(h.gw.updateProduct).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  describe("PATCH product — existing unit edits are persisted", () => {
    it("saves name/price of an existing unit via updateProductUnit", async () => {
      h.gw.findProductWithUnits.mockResolvedValue(product());
      const res = await patchProduct(
        req("PATCH", { units: [unitPatch({ unitName: "حبة", priceWholesale: "700" })] }),
        ctx()
      );
      expect(res.status).toBe(200);
      expect(h.gw.updateProductUnit).toHaveBeenCalledTimes(1);
      expect(h.gw.updateProductUnit).toHaveBeenCalledWith(
        h.db,
        "tenant-1",
        "u1",
        expect.objectContaining({ unitName: "حبة", priceWholesale: "700" })
      );
    });

    it("omitted isActive/pricingCurrency are left unchanged (no silent defaults)", async () => {
      h.gw.findProductWithUnits.mockResolvedValue(
        product({
          units: [
            baseUnit(),
            baseUnit({
              id: "u2",
              unitName: "طرد",
              isBaseUnit: false,
              conversionFactor: "24",
              isActive: false,
              pricingCurrency: "USD",
            }),
          ],
        })
      );

      const res = await patchProduct(
        req("PATCH", {
          units: [
            unitPatch(),
            { id: "u2", unitName: "طرد", conversionFactor: "24", priceWholesale: "9000" },
          ],
        }),
        ctx()
      );
      expect(res.status).toBe(200);

      const u2 = unitUpdateArgs("u2");
      expect(u2.priceWholesale).toBe("9000");
      // Must NOT re-activate the deactivated unit or flip USD -> SYP.
      expect(u2.isActive).toBeUndefined();
      expect(u2.pricingCurrency).toBeUndefined();
    });

    it("publish gate validates the PRODUCT image actually being saved", async () => {
      h.gw.findProductWithUnits.mockResolvedValue(product({ imageUrl: null }));
      const res = await patchProduct(
        req("PATCH", {
          isPublic: true,
          imageUrl: "https://x.test/y.jpg",
          units: [unitPatch()],
        }),
        ctx()
      );
      expect(res.status).toBe(200);
      const args = h.gw.updateProduct.mock.calls[0][3];
      expect(args.isPublic).toBe(true);
      expect(args.imageUrl).toBe("https://x.test/y.jpg");
      // The image is a PRODUCT field now: a per-unit write must never carry it.
      expect(unitUpdateArgs("u1")).toEqual(
        expect.objectContaining({ priceWholesale: "500" })
      );
      expect(unitUpdateArgs("u1").imageUrl).toBeUndefined();
    });

    it("rejects clearing image (null) on a public product with 400 + Arabic message", async () => {
      h.gw.findProductWithUnits.mockResolvedValue(
        product({ isPublic: true, imageUrl: "https://example.com/current.jpg" })
      );
      const res = await patchProduct(
        req("PATCH", { imageUrl: null }),
        ctx()
      );
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe("PUBLISH_GATE_BLOCKED");
      expect(json.message).toContain("لا يمكن نشر المنتج في المتجر إلا بعد إضافة صورة للمنتج");
      expect(h.gw.updateProduct).not.toHaveBeenCalled();
    });

    it("rejects clearing image (empty string) on a public product with 400 + Arabic message", async () => {
      h.gw.findProductWithUnits.mockResolvedValue(
        product({ isPublic: true, imageUrl: "https://example.com/current.jpg" })
      );
      const res = await patchProduct(
        req("PATCH", { imageUrl: "   " }),
        ctx()
      );
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe("PUBLISH_GATE_BLOCKED");
      expect(json.message).toContain("لا يمكن نشر المنتج في المتجر إلا بعد إضافة صورة للمنتج");
      expect(h.gw.updateProduct).not.toHaveBeenCalled();
    });

    it("allows replacing image on a public product", async () => {
      h.gw.findProductWithUnits.mockResolvedValue(
        product({ isPublic: true, imageUrl: "https://example.com/old.jpg" })
      );
      const res = await patchProduct(
        req("PATCH", { imageUrl: "https://example.com/new.jpg" }),
        ctx()
      );
      expect(res.status).toBe(200);
      const args = h.gw.updateProduct.mock.calls[0][3];
      expect(args.imageUrl).toBe("https://example.com/new.jpg");
    });

    it("new additional unit gets the real defaults (SYP, active)", async () => {
      h.gw.findProductWithUnits.mockResolvedValue(product());
      h.gw.createAdditionalUnit.mockResolvedValue({ id: "u9" });
      const res = await patchProduct(
        req("PATCH", {
          units: [
            unitPatch(),
            { unitName: "طرد", conversionFactor: "24", priceWholesale: "9000" },
          ],
        }),
        ctx()
      );
      expect(res.status).toBe(200);
      expect(h.gw.createAdditionalUnit).toHaveBeenCalledWith(
        h.db,
        "tenant-1",
        "p1",
        "24",
        expect.objectContaining({ pricingCurrency: "SYP", isActive: true })
      );
    });

    it("factor change on a non-base unit goes through the guarded helper", async () => {
      h.gw.findProductWithUnits.mockResolvedValue(
        product({
          units: [
            baseUnit(),
            baseUnit({ id: "u2", unitName: "طرد", isBaseUnit: false, conversionFactor: "24" }),
          ],
        })
      );
      const res = await patchProduct(
        req("PATCH", {
          units: [
            unitPatch(),
            { id: "u2", unitName: "طرد", conversionFactor: "30", priceWholesale: "9000" },
          ],
        }),
        ctx()
      );
      expect(res.status).toBe(200);
      expect(h.updateNonBaseUnitConversionFactor).toHaveBeenCalledWith(h.db, {
        tenantId: "tenant-1",
        productId: "p1",
        unitId: "u2",
        newConversionFactor: "30",
      });
    });

    it("400 CONVERSION_FACTOR_LOCKED when the product already has batches", async () => {
      h.gw.countProductBatches.mockResolvedValue(2);
      h.gw.findProductWithUnits.mockResolvedValue(
        product({
          units: [
            baseUnit(),
            baseUnit({ id: "u2", unitName: "طرد", isBaseUnit: false, conversionFactor: "24" }),
          ],
        })
      );
      const res = await patchProduct(
        req("PATCH", {
          units: [
            unitPatch(),
            { id: "u2", unitName: "طرد", conversionFactor: "30", priceWholesale: "9000" },
          ],
        }),
        ctx()
      );
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("CONVERSION_FACTOR_LOCKED");
      expect(h.updateNonBaseUnitConversionFactor).not.toHaveBeenCalled();
    });

    it("a unit id from another product is rejected before any unit write (currently surfaces as 500)", async () => {
      h.gw.findProductWithUnits.mockResolvedValue(product());
      const res = await patchProduct(
        req("PATCH", { units: [unitPatch(), unitPatch({ id: "foreign", unitName: "x", conversionFactor: "5" })] }),
        ctx()
      );
      // UnitNotBelongingToProductError is thrown inside the transaction and
      // is not mapped to a friendly code -> generic 500, but never a write.
      expect(res.status).toBe(500);
      expect(h.gw.updateProductUnit).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  describe("PATCH product — after a base-unit reset", () => {
    it("a leftover DEACTIVATED factor-1 unit no longer breaks validation", async () => {
      // resetProductUnits() soft-deletes the old base (isActive:false,
      // factor 1) and creates a new one — both rows come back from the read.
      h.gw.findProductWithUnits.mockResolvedValue(
        product({
          units: [
            baseUnit({ id: "u0", isBaseUnit: false, isActive: false, unitName: "قديمة" }),
            baseUnit({ id: "u1", unitName: "جديدة" }),
          ],
        })
      );
      const res = await patchProduct(
        req("PATCH", { units: [unitPatch({ unitName: "جديدة", priceWholesale: "700" })] }),
        ctx()
      );
      expect(res.status).toBe(200);
      expect(h.resetProductUnits).not.toHaveBeenCalled();
      expect(unitUpdateArgs("u1")).toEqual(expect.objectContaining({ priceWholesale: "700" }));
      // The dead row is not touched.
      expect(unitUpdateArgs("u0")).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  describe("PATCH product — base-unit change (reset flow)", () => {
    // Existing base u1 becomes a 12-pack; a brand-new factor-1 unit is the
    // new base -> wantsBaseUnitChange.
    const resetPayload = (extra: any = {}) => ({
      units: [
        unitPatch({ conversionFactor: "12" }),
        {
          unitName: "علبة",
          conversionFactor: "1",
          priceWholesale: "100",
          barcodes: [{ barcode: "555", barcodeSource: "INTERNAL" }],
        },
      ],
      ...extra,
    });

    it("400 BASE_UNIT_CHANGE_REASON_REQUIRED without a reason", async () => {
      h.gw.findProductWithUnits.mockResolvedValue(product());
      const res = await patchProduct(req("PATCH", resetPayload()), ctx());
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("BASE_UNIT_CHANGE_REASON_REQUIRED");
      expect(h.resetProductUnits).not.toHaveBeenCalled();
    });

    it("400 BASE_UNIT_LOCKED when batches already exist", async () => {
      h.gw.countProductBatches.mockResolvedValue(3);
      h.gw.findProductWithUnits.mockResolvedValue(product());
      const res = await patchProduct(
        req("PATCH", resetPayload({ baseUnitChangeReason: "خطأ إدخال" })),
        ctx()
      );
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("BASE_UNIT_LOCKED");
      expect(h.resetProductUnits).not.toHaveBeenCalled();
    });

    it("resets, attaches barcodes to the NEW unit, and does NOT force the product private", async () => {
      h.gw.findProductWithUnits.mockResolvedValue(product({ isPublic: true }));
      h.resetProductUnits.mockResolvedValue({ id: "u-new" });

      const res = await patchProduct(
        req("PATCH", resetPayload({ baseUnitChangeReason: "خطأ إدخال" })),
        ctx()
      );
      expect(res.status).toBe(200);

      expect(h.resetProductUnits).toHaveBeenCalledTimes(1);
      const resetArgs = h.resetProductUnits.mock.calls[0][1];
      expect(resetArgs.newBaseUnit.unitName).toBe("علبة");
      expect(resetArgs.newBaseUnit.pricingCurrency).toBe("SYP"); // explicit default
      expect(resetArgs.reason).toBe("خطأ إدخال");

      expect(h.gw.createUnitBarcode).toHaveBeenCalledWith(h.db, "tenant-1", "u-new", {
        barcode: "555",
        barcodeSource: "INTERNAL",
      });
      // [v4.6] The image belongs to the product, so a base-unit reset can no
      // longer invalidate publishing. isPublic is left untouched (undefined),
      // NOT forced to false -- the gate was re-run against the post-reset
      // state instead, and this request was rejected if it would not qualify.
      expect(h.gw.updateProduct.mock.calls[0][3].isPublic).toBeUndefined();

      // Sibling-unit edits in the same payload are not applied, and the
      // response says so.
      expect(h.gw.updateProductUnit).not.toHaveBeenCalled();
      expect((await res.json()).message).toContain("لم يتم تطبيق");
    });
  });

  // -------------------------------------------------------------------------
  // -------------------------------------------------------------------------
  describe("PATCH product -- product-level image (v4.6)", () => {
    it("400 PUBLISH_GATE_BLOCKED when the product has no image at all", async () => {
      h.gw.findProductWithUnits.mockResolvedValue(product({ imageUrl: null }));
      const res = await patchProduct(req("PATCH", { isPublic: true }), ctx());
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("PUBLISH_GATE_BLOCKED");
      expect(h.gw.updateProduct).not.toHaveBeenCalled();
    });

    it("400 PUBLISH_GATE_BLOCKED when every unit is inactive", async () => {
      h.gw.findProductWithUnits.mockResolvedValue(
        product({ units: [baseUnit({ isActive: false })] })
      );
      const res = await patchProduct(req("PATCH", { isPublic: true }), ctx());
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("PUBLISH_GATE_BLOCKED");
      expect(h.gw.updateProduct).not.toHaveBeenCalled();
    });

    it("400 PUBLISH_GATE_BLOCKED when the image is cleared on a PUBLIC product", async () => {
      h.gw.findProductWithUnits.mockResolvedValue(product({ isPublic: true }));
      const res = await patchProduct(req("PATCH", { imageUrl: null }), ctx());
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("PUBLISH_GATE_BLOCKED");
      // Nothing may be written when the request would break the gate.
      expect(h.gw.updateProduct).not.toHaveBeenCalled();
    });

    it("400 PUBLISH_GATE_BLOCKED when the image is blank on a PUBLIC product", async () => {
      h.gw.findProductWithUnits.mockResolvedValue(product({ isPublic: true }));
      const res = await patchProduct(req("PATCH", { imageUrl: "   " }), ctx());
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("PUBLISH_GATE_BLOCKED");
      expect(h.gw.updateProduct).not.toHaveBeenCalled();
    });

    it("clearing the image on a PRIVATE product is allowed (the image is optional)", async () => {
      h.gw.findProductWithUnits.mockResolvedValue(product({ isPublic: false }));
      const res = await patchProduct(req("PATCH", { imageUrl: null }), ctx());
      expect(res.status).toBe(200);
      expect(h.gw.updateProduct.mock.calls[0][3].imageUrl).toBeNull();
    });

    it("an omitted image leaves the stored one untouched", async () => {
      h.gw.findProductWithUnits.mockResolvedValue(product());
      const res = await patchProduct(req("PATCH", { name: "x" }), ctx());
      expect(res.status).toBe(200);
      expect(h.gw.updateProduct.mock.calls[0][3].imageUrl).toBeUndefined();
    });

    it("a submitted image is trimmed before it is saved", async () => {
      h.gw.findProductWithUnits.mockResolvedValue(product());
      const res = await patchProduct(
        req("PATCH", { imageUrl: "  https://x.test/y.jpg  " }),
        ctx()
      );
      expect(res.status).toBe(200);
      expect(h.gw.updateProduct.mock.calls[0][3].imageUrl).toBe("https://x.test/y.jpg");
    });
  });

  describe("PATCH product — barcodeSource validation gate", () => {
    it("400 when a legacy barcode arrives with barcodeSource null", async () => {
      h.gw.findProductWithUnits.mockResolvedValue(product());
      const res = await patchProduct(
        req("PATCH", {
          units: [unitPatch({ barcode: "6291041500214", barcodeSource: null })],
        }),
        ctx()
      );
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("VALIDATION_ERROR");
      expect(h.gw.createUnitBarcode).not.toHaveBeenCalled();
    });

    it("400 when a barcodes[] element has no source", async () => {
      h.gw.findProductWithUnits.mockResolvedValue(product());
      const res = await patchProduct(
        req("PATCH", {
          units: [unitPatch({ barcodes: [{ barcode: "6291041500214" }] })],
        }),
        ctx()
      );
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("VALIDATION_ERROR");
      expect(h.gw.createUnitBarcode).not.toHaveBeenCalled();
    });

    it("writes each new barcode via createUnitBarcode (INTERNAL: no shared catalog)", async () => {
      h.gw.findProductWithUnits.mockResolvedValue(product());
      h.gw.findProductUnitByBarcodeExcludingProduct.mockResolvedValue(null);

      const res = await patchProduct(
        req("PATCH", {
          units: [
            unitPatch({
              barcodes: [{ barcode: "6291041500214", barcodeSource: "INTERNAL" }],
            }),
          ],
        }),
        ctx()
      );
      expect(res.status).toBe(200);
      expect(h.gw.createUnitBarcode).toHaveBeenCalledWith(h.db, "tenant-1", "u1", {
        barcode: "6291041500214",
        barcodeSource: "INTERNAL",
      });
      expect(h.gw.resolveSharedCatalogForBarcode).not.toHaveBeenCalled();
    });

    it("GS1 barcodes also go through the shared-catalog resolver", async () => {
      h.gw.findProductWithUnits.mockResolvedValue(product());
      h.gw.findProductUnitByBarcodeExcludingProduct.mockResolvedValue(null);
      h.gw.resolveSharedCatalogForBarcode.mockResolvedValue("entry-1");

      const res = await patchProduct(
        req("PATCH", {
          units: [
            unitPatch({
              barcodes: [{ barcode: "6291041500214", barcodeSource: "GS1" }],
            }),
          ],
        }),
        ctx()
      );
      expect(res.status).toBe(200);
      expect(h.gw.createUnitBarcode).toHaveBeenCalledTimes(1);
      expect(h.gw.resolveSharedCatalogForBarcode).toHaveBeenCalledTimes(1);
    });

    it("skips barcodes already stored on the unit (idempotent re-save)", async () => {
      h.gw.findProductWithUnits.mockResolvedValue(
        product({
          units: [
            baseUnit({ barcodes: [{ id: "b1", barcode: "111", barcodeSource: "INTERNAL" }] }),
          ],
        })
      );
      h.gw.findProductUnitByBarcodeExcludingProduct.mockResolvedValue(null);

      const res = await patchProduct(
        req("PATCH", {
          units: [unitPatch({ barcodes: [{ barcode: "111", barcodeSource: "INTERNAL" }] })],
        }),
        ctx()
      );
      expect(res.status).toBe(200);
      expect(h.gw.createUnitBarcode).not.toHaveBeenCalled();
    });

    it("400 DUPLICATE_BARCODE when another product already uses the barcode", async () => {
      h.gw.findProductWithUnits.mockResolvedValue(product());
      h.gw.findProductUnitByBarcodeExcludingProduct.mockResolvedValue({
        id: "ux",
        unitName: "x",
        productId: "p2",
      });

      const res = await patchProduct(
        req("PATCH", {
          units: [unitPatch({ barcodes: [{ barcode: "999", barcodeSource: "INTERNAL" }] })],
        }),
        ctx()
      );
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("DUPLICATE_BARCODE");
      expect(h.gw.createUnitBarcode).not.toHaveBeenCalled();
    });

    it("400 DUPLICATE_BARCODE when the same barcode repeats inside one request", async () => {
      h.gw.findProductWithUnits.mockResolvedValue(product());
      h.gw.findProductUnitByBarcodeExcludingProduct.mockResolvedValue(null);

      const res = await patchProduct(
        req("PATCH", {
          units: [
            unitPatch({
              barcodes: [
                { barcode: "777", barcodeSource: "INTERNAL" },
                { barcode: "777", barcodeSource: "INTERNAL" },
              ],
            }),
          ],
        }),
        ctx()
      );
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("DUPLICATE_BARCODE");
    });

    it("PATCH response carries the deprecated barcode/barcodeSource shim like GET", async () => {
      h.gw.findProductWithUnits.mockResolvedValue(
        product({
          units: [
            baseUnit({ barcodes: [{ id: "b1", barcode: "111", barcodeSource: "GS1" }] }),
          ],
        })
      );
      const res = await patchProduct(req("PATCH", { name: "x" }), ctx());
      const json = await res.json();
      expect(json.product.units[0].barcode).toBe("111");
      expect(json.product.units[0].barcodeSource).toBe("GS1");
    });
  });
});