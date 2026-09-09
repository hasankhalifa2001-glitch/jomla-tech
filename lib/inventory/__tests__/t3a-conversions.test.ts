import { describe, it, expect } from "vitest";
import {
  convertUnitQuantity,
  convertUnitCost,
  calculateBatchDeductions,
  validatePackagingUnits,
} from "../conversions";

describe("T3a Packaging Unit Conversion Engine", () => {
  describe("convertUnitQuantity", () => {
    it("converts cartons to pieces correctly (factor 12 -> 1)", () => {
      // 2 cartons of 12 = 24 pieces
      expect(convertUnitQuantity(2, 12, 1)).toBe(24);
    });

    it("converts pieces to cartons correctly (factor 1 -> 12)", () => {
      // 24 pieces = 2 cartons
      expect(convertUnitQuantity(24, 1, 12)).toBe(2);
    });

    it("converts between non-base units correctly (factor 24 box -> factor 6 pack)", () => {
      // 1 box of 24 pieces = 4 packs of 6 pieces
      expect(convertUnitQuantity(1, 24, 6)).toBe(4);
    });

    it("handles zero quantity gracefully", () => {
      expect(convertUnitQuantity(0, 12, 1)).toBe(0);
    });

    it("throws error for non-positive conversion factors", () => {
      expect(() => convertUnitQuantity(10, 0, 1)).toThrow();
      expect(() => convertUnitQuantity(10, 1, -5)).toThrow();
    });
  });

  describe("convertUnitCost", () => {
    it("calculates cost per piece given cost per carton", () => {
      // 1 carton (12 pcs) costs $120 -> 1 piece costs $10
      expect(convertUnitCost(120, 12, 1)).toBe(10);
    });

    it("calculates cost per box given cost per piece", () => {
      // 1 piece costs $5 -> 1 box (24 pcs) costs $120
      expect(convertUnitCost(5, 1, 24)).toBe(120);
    });

    it("calculates cost between packaging units", () => {
      // 1 pack (6 pcs) costs $30 -> 1 box (24 pcs) costs $120
      expect(convertUnitCost(30, 6, 24)).toBe(120);
    });

    it("throws error for invalid conversion factor", () => {
      expect(() => convertUnitCost(50, -1, 10)).toThrow();
    });
  });

  describe("calculateBatchDeductions", () => {
    it("calculates deductions when batch unit matches requested unit", () => {
      const res = calculateBatchDeductions(5, 1, 1);
      expect(res.allocatedInRequestedUnit).toBe(5);
      expect(res.deductedInBatchUnit).toBe(5);
      expect(res.quantityInBaseUnit).toBe(5);
    });

    it("calculates deductions when requested unit is larger than batch unit", () => {
      // Selling 2 cartons (factor 12) from batch stocked in pieces (factor 1)
      const res = calculateBatchDeductions(2, 12, 1);
      expect(res.allocatedInRequestedUnit).toBe(2);
      expect(res.deductedInBatchUnit).toBe(24);
      expect(res.quantityInBaseUnit).toBe(24);
    });

    it("calculates deductions when requested unit is smaller than batch unit", () => {
      // Selling 12 pieces (factor 1) from batch stocked in cartons (factor 12)
      const res = calculateBatchDeductions(12, 1, 12);
      expect(res.allocatedInRequestedUnit).toBe(12);
      expect(res.deductedInBatchUnit).toBe(1);
      expect(res.quantityInBaseUnit).toBe(12);
    });

    it("rejects zero or negative quantities", () => {
      expect(() => calculateBatchDeductions(0, 1, 1)).toThrow();
      expect(() => calculateBatchDeductions(-3, 1, 1)).toThrow();
    });
  });

  describe("validatePackagingUnits", () => {
    it("validates valid base + secondary + tertiary packaging setup", () => {
      const units = [
        { unitName: "قطعة", conversionFactor: 1 },
        { unitName: "طرد (6 قطع)", conversionFactor: 6 },
        { unitName: "صندوق (24 قطعة)", conversionFactor: 24 },
      ];
      const result = validatePackagingUnits(units);
      expect(result.valid).toBe(true);
      expect(result.baseUnit?.unitName).toBe("قطعة");
    });

    it("fails if no base unit (factor 1) exists", () => {
      const units = [
        { unitName: "طرد", conversionFactor: 6 },
        { unitName: "كرتونة", conversionFactor: 12 },
      ];
      const result = validatePackagingUnits(units);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("يجب تحديد وحدة أساسية واحدة فقط");
    });

    it("fails if multiple base units exist", () => {
      const units = [
        { unitName: "قطعة 1", conversionFactor: 1 },
        { unitName: "قطعة 2", conversionFactor: 1 },
      ];
      const result = validatePackagingUnits(units);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("يجب تحديد وحدة أساسية واحدة فقط");
    });

    it("fails on duplicate conversion factor", () => {
      const units = [
        { unitName: "قطعة", conversionFactor: 1 },
        { unitName: "طرد أ", conversionFactor: 6 },
        { unitName: "طرد ب", conversionFactor: 6 },
      ];
      const result = validatePackagingUnits(units);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("مكرر أكثر من مرة");
    });

    it("fails on duplicate unit name", () => {
      const units = [
        { unitName: "قطعة", conversionFactor: 1 },
        { unitName: "قطعة", conversionFactor: 10 },
      ];
      const result = validatePackagingUnits(units);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("مكرر");
    });

    it("fails on empty unit name", () => {
      const units = [
        { unitName: "", conversionFactor: 1 },
      ];
      const result = validatePackagingUnits(units);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("اسم الوحدة مطلوب");
    });
  });
});
