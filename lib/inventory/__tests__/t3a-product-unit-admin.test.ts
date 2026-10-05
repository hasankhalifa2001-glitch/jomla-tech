import { describe, it, expect } from "vitest";
import { checkProductPublishable } from "@/lib/inventory/publishing-gate";

describe("T3a — Product & Unit Administration", () => {
  describe("1. Storefront Publishing Gate Logic (checkProductPublishable)", () => {
    it("rejects publishing when product is inactive (isActive = false)", () => {
      const result = checkProductPublishable({
        isActive: false,
        imageUrl: "https://example.com/item.jpg",
        units: [{ isActive: true }],
      });

      expect(result.publishable).toBe(false);
      expect(result.reason).toContain("موقوف");
    });

    it("rejects publishing when the product has no active unit", () => {
      const noUnitsAtAll = checkProductPublishable({
        isActive: true,
        imageUrl: "https://example.com/item.jpg",
        units: [],
      });
      expect(noUnitsAtAll.publishable).toBe(false);
      expect(noUnitsAtAll.reason).toContain("وحدة قياس نشطة واحدة على الأقل");

      const everyUnitInactive = checkProductPublishable({
        isActive: true,
        imageUrl: "https://example.com/item.jpg",
        units: [{ isActive: false }, { isActive: false }],
      });
      expect(everyUnitInactive.publishable).toBe(false);
      expect(everyUnitInactive.reason).toContain("وحدة قياس نشطة");
    });

    it("rejects publishing when the PRODUCT image is missing or blank", () => {
      const missingImage = checkProductPublishable({
        isActive: true,
        imageUrl: null,
        units: [{ isActive: true }],
      });
      expect(missingImage.publishable).toBe(false);
      expect(missingImage.reason).toContain("صورة");

      const blankImage = checkProductPublishable({
        isActive: true,
        imageUrl: "   ",
        units: [{ isActive: true }],
      });
      expect(blankImage.publishable).toBe(false);
      expect(blankImage.reason).toContain("صورة");

      const omittedImage = checkProductPublishable({
        isActive: true,
        units: [{ isActive: true }],
      });
      expect(omittedImage.publishable).toBe(false);
      expect(omittedImage.reason).toContain("صورة");
    });

    it("does NOT let an individual unit's own state satisfy the product image", () => {
      // The image is a PRODUCT field: no per-unit image exists anymore, and a
      // unit carrying its own value must not make a photo-less product
      // publishable.
      const result = checkProductPublishable({
        isActive: true,
        imageUrl: null,
        units: [{ isActive: true }, { isActive: true }],
      });
      expect(result.publishable).toBe(false);
    });

    it("reports the missing image INSTEAD of the missing unit only when the unit rule passes", () => {
      // Two distinct messages: an inactive unit is never masked by a good image,
      // and a missing image is never masked by a healthy unit.
      const noActiveUnit = checkProductPublishable({
        isActive: true,
        imageUrl: "https://example.com/item.jpg",
        units: [{ isActive: false }],
      });
      expect(noActiveUnit.reason).toContain("وحدة قياس نشطة");
      expect(noActiveUnit.reason).not.toContain("صورة");

      const noImage = checkProductPublishable({
        isActive: true,
        imageUrl: null,
        units: [{ isActive: true }],
      });
      expect(noImage.reason).toContain("صورة");
      expect(noImage.reason).not.toContain("وحدة قياس نشطة");
    });

    it("accepts publishing when the product is active, has an image and an active unit", () => {
      const result = checkProductPublishable({
        isActive: true,
        imageUrl: "https://example.com/product.jpg",
        units: [{ isActive: false }, { isActive: true }],
      });

      expect(result.publishable).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it("never returns a per-unit 'eligibleUnit' any more", () => {
      const result = checkProductPublishable({
        isActive: true,
        imageUrl: "https://example.com/product.jpg",
        units: [{ isActive: true }],
      });
      expect(result).not.toHaveProperty("eligibleUnit");
    });
  });
  describe("2. Unit & Product State Transitions & Cascades", () => {
    it("deactivating the last active unit invalidates storefront publishing", () => {
      const product = {
        isActive: true,
        imageUrl: "https://example.com/base.jpg",
        units: [
          { id: "u-base", isActive: true },
          { id: "u-box", isActive: true },
        ],
      };

      // Before deactivation: publishable
      expect(checkProductPublishable(product).publishable).toBe(true);

      // Deactivating ONE of two active units keeps it publishable — the image
      // now lives on the product, so losing a unit no longer costs the photo.
      const afterOneDeactivation = product.units.map((u) =>
        u.id === "u-base" ? { ...u, isActive: false } : u
      );
      expect(
        checkProductPublishable({ ...product, units: afterOneDeactivation }).publishable
      ).toBe(true);

      // Deactivating the LAST active unit does close the gate.
      const afterAllDeactivation = afterOneDeactivation.map((u) => ({
        ...u,
        isActive: false,
      }));
      expect(
        checkProductPublishable({ ...product, units: afterAllDeactivation }).publishable
      ).toBe(false);
    });

    it("clearing the product image closes the storefront gate", () => {
      const product = {
        isActive: true,
        imageUrl: "https://example.com/base.jpg",
        units: [{ id: "u-base", isActive: true }],
      };
      expect(checkProductPublishable(product).publishable).toBe(true);

      const cleared = checkProductPublishable({ ...product, imageUrl: "" });
      expect(cleared.publishable).toBe(false);
      expect(cleared.reason).toContain("صورة");
    });

    it("product deactivation closes the gate even with an image and an active unit", () => {
      const gateCheck = checkProductPublishable({
        isActive: false,
        imageUrl: "https://example.com/base.jpg",
        units: [{ isActive: true }],
      });
      expect(gateCheck.publishable).toBe(false);
    });
  });
  describe("3. POS Unit Filtering Contracts", () => {
    it("filters out inactive units from cart unit-switching options", () => {
      const product = {
        id: "p1",
        name: "زيت زيتون 1 لتر",
        isActive: true,
        units: [
          { id: "u1", unitName: "قنينة", conversionFactor: 1, isActive: true },
          { id: "u2", unitName: "طرد (12 قنينة)", conversionFactor: 12, isActive: false },
          { id: "u3", unitName: "كرتونة (24 قنينة)", conversionFactor: 24, isActive: true },
        ],
      };

      const availableUnits = product.units.filter((u) => u.isActive !== false);
      expect(availableUnits).toHaveLength(2);
      expect(availableUnits.map((u) => u.id)).toEqual(["u1", "u3"]);
    });

    it("scanned barcode only matches active units", () => {
      const units = [
        { id: "u-legacy", barcode: "6210001234567", isActive: false },
        { id: "u-new", barcode: "6210001234568", isActive: true },
      ];

      const scanBarcode = (barcode: string) =>
        units.find((u) => u.barcode === barcode && u.isActive !== false);

      expect(scanBarcode("6210001234567")).toBeUndefined();
      expect(scanBarcode("6210001234568")?.id).toBe("u-new");
    });
  });
  describe("4. BarcodeSource Invariants (GS1 vs INTERNAL)", () => {
    it("differentiates GS1 and INTERNAL barcodes for shared catalog promotion", () => {
      const gs1Unit = {
        barcode: "6210001234567",
        barcodeSource: "GS1" as const,
      };
      const internalUnit = {
        barcode: "INT-998877",
        barcodeSource: "INTERNAL" as const,
      };

      const isEligibleForSharedCatalog = (source?: string | null) => source === "GS1";

      expect(isEligibleForSharedCatalog(gs1Unit.barcodeSource)).toBe(true);
      expect(isEligibleForSharedCatalog(internalUnit.barcodeSource)).toBe(false);
      expect(isEligibleForSharedCatalog(null)).toBe(false);
    });
  });

});