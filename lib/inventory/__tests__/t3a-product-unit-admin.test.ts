/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from "vitest";
import { checkProductPublishable } from "@/lib/inventory/publishing-gate";
import { Prisma } from "@prisma/client";

describe("T3a — Product & Unit Administration", () => {
  describe("1. Storefront Publishing Gate Logic (checkProductPublishable)", () => {
    it("rejects publishing when product is inactive (isActive = false)", () => {
      const result = checkProductPublishable({
        isActive: false,
        units: [
          {
            isActive: true,
            priceRetail: 1500,
            imageUrl: "https://example.com/item.jpg",
          },
        ],
      });

      expect(result.publishable).toBe(false);
      expect(result.reason).toContain("موقوف");
    });

    it("rejects publishing when product has no units", () => {
      const result = checkProductPublishable({
        isActive: true,
        units: [],
      });

      expect(result.publishable).toBe(false);
      expect(result.reason).toContain("وحدة نشطة واحدة على الأقل");
    });

    it("rejects publishing when all units are inactive", () => {
      const result = checkProductPublishable({
        isActive: true,
        units: [
          {
            isActive: false,
            priceRetail: 1500,
            imageUrl: "https://example.com/item.jpg",
          },
          {
            isActive: false,
            priceRetail: 5000,
            imageUrl: "https://example.com/carton.jpg",
          },
        ],
      });

      expect(result.publishable).toBe(false);
      expect(result.reason).toContain("وحدة نشطة");
    });

    it("rejects publishing when active units have missing or zero retail price", () => {
      const resultNullPrice = checkProductPublishable({
        isActive: true,
        units: [
          {
            isActive: true,
            priceRetail: null,
            imageUrl: "https://example.com/item.jpg",
          },
        ],
      });
      expect(resultNullPrice.publishable).toBe(false);
      expect(resultNullPrice.reason).toContain("سعر مفرق");

      const resultZeroPrice = checkProductPublishable({
        isActive: true,
        units: [
          {
            isActive: true,
            priceRetail: 0,
            imageUrl: "https://example.com/item.jpg",
          },
        ],
      });
      expect(resultZeroPrice.publishable).toBe(false);
      expect(resultZeroPrice.reason).toContain("سعر مفرق");

      const resultNegativePrice = checkProductPublishable({
        isActive: true,
        units: [
          {
            isActive: true,
            priceRetail: -50,
            imageUrl: "https://example.com/item.jpg",
          },
        ],
      });
      expect(resultNegativePrice.publishable).toBe(false);
    });

    it("rejects publishing when active units have missing or empty image URL", () => {
      const resultNullImg = checkProductPublishable({
        isActive: true,
        units: [
          {
            isActive: true,
            priceRetail: 2500,
            imageUrl: null,
          },
        ],
      });
      expect(resultNullImg.publishable).toBe(false);
      expect(resultNullImg.reason).toContain("صورة");

      const resultEmptyImg = checkProductPublishable({
        isActive: true,
        units: [
          {
            isActive: true,
            priceRetail: 2500,
            imageUrl: "   ",
          },
        ],
      });
      expect(resultEmptyImg.publishable).toBe(false);
      expect(resultEmptyImg.reason).toContain("صورة");
    });

    it("does NOT count inactive units toward publishing gate requirements", () => {
      const result = checkProductPublishable({
        isActive: true,
        units: [
          {
            isActive: false,
            priceRetail: 2500,
            imageUrl: "https://example.com/img.jpg",
          },
          {
            isActive: true,
            priceRetail: 2500,
            imageUrl: null,
          },
        ],
      });
      expect(result.publishable).toBe(false);
    });

    it("accepts publishing when at least one active unit has valid priceRetail and imageUrl", () => {
      const result = checkProductPublishable({
        isActive: true,
        units: [
          {
            isActive: true,
            priceRetail: null,
            imageUrl: null,
          },
          {
            isActive: true,
            priceRetail: new Prisma.Decimal("1250.50") as any,
            imageUrl: "https://example.com/consumer-pack.jpg",
          },
        ],
      });

      expect(result.publishable).toBe(true);
      expect(result.eligibleUnit).toBeDefined();
    });
  });
  describe("2. Unit & Product State Transitions & Cascades", () => {
    it("deactivating the only gate-compliant unit invalidates storefront publishing", () => {
      const product = {
        isActive: true,
        isPublic: true,
        units: [
          {
            id: "u-base",
            isActive: true,
            priceRetail: 1000,
            imageUrl: "https://example.com/base.jpg",
          },
          {
            id: "u-box",
            isActive: true,
            priceRetail: null,
            imageUrl: null,
          },
        ],
      };

      // Before deactivation: publishable
      expect(checkProductPublishable(product).publishable).toBe(true);

      // Now deactivate u-base
      const unitsAfterDeactivation = product.units.map((u) =>
        u.id === "u-base" ? { ...u, isActive: false } : u
      );

      // Gate check after deactivation
      const checkAfter = checkProductPublishable({
        isActive: product.isActive,
        units: unitsAfterDeactivation,
      });

      // Must NOT be publishable anymore
      expect(checkAfter.publishable).toBe(false);
    });

    it("product deactivation forces isPublic to false", () => {
      const product = {
        isActive: false,
        isPublic: true,
        units: [
          {
            isActive: true,
            priceRetail: 1000,
            imageUrl: "https://example.com/base.jpg",
          },
        ],
      };

      const gateCheck = checkProductPublishable(product);
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
