import { describe, it, expect } from "vitest";
import Decimal from "decimal.js";
import {
  toBaseUnit,
  fromBaseUnit,
  validatePackagingUnits,
  isReservedBaseUnitFactor,
  assertIsValidBaseUnitFactor,
} from "../units";

// [FIX — full rewrite] The previous version of this file tested
// convertUnitQuantity/convertUnitCost/calculateBatchDeductions from the
// now-deleted lib/inventory/packaging-unit-validation.ts — functions that
// assumed a ProductBatch could be tracked in ANY packaging unit and
// therefore needed a generic "convert between any two units" primitive.
// That is exactly the pre-v4.0 design MASTER-SPEC v4.0 replaced (T1's
// Rejected Approach #10): under v4.0, ProductBatch.unitId is ALWAYS the
// product's base unit, so there is no longer a generic
// unit-A-to-unit-B conversion anywhere in the codebase — only ONE
// sanctioned direction each way:
//   - toBaseUnit(quantityInSoldUnit, soldUnitConversionFactor) — sale/
//     order/adjustment quantity -> base unit, the only thing ever passed
//     to commitFifoAllocation() or written to ProductBatch.quantity /
//     StockAdjustment.quantityDelta.
//   - fromBaseUnit(quantityInBaseUnit, targetUnitConversionFactor) —
//     DISPLAY ONLY, the reverse direction (e.g. breakdownForDisplay()'s
//     "2 packs and 24 pieces" style output).
// Both live in lib/inventory/units.ts now (this file's actual subject),
// which also absorbed validatePackagingUnits() from the deleted
// packaging-unit-validation.ts (see units.ts's own header, FIX #3).
//
// convertUnitCost() and calculateBatchDeductions() have no v4.0
// equivalent at all — a batch's unit is always the base unit by
// construction, so "cost per unit conversion" and "how much gets
// deducted from the batch's own unit vs. the requested unit" are no
// longer separate questions; toBaseUnit()'s single output IS the batch
// deduction. Their test cases are not ported forward for that reason —
// there is nothing left in the current codebase for them to test.
type DecimalInstance = InstanceType<typeof Decimal>;

const num = (d: DecimalInstance) => d.toNumber();

describe("T1/T3a/T3b Unit Conversion Engine (v4.0)", () => {
  describe("toBaseUnit", () => {
    it("converts a sale/order quantity in a non-base unit into the base unit (factor 12)", () => {
      // 2 cartons (factor 12) = 24 base units (pieces)
      expect(num(toBaseUnit(2, 12))).toBe(24);
    });

    it("returns the same quantity when the sold unit IS the base unit (factor 1)", () => {
      expect(num(toBaseUnit(5, 1))).toBe(5);
    });

    it("handles a fractional conversion factor (e.g. selling half a carton)", () => {
      // 1 half-carton (factor 0.5, relative to a single piece) = 0.5 base units
      expect(num(toBaseUnit(1, 0.5))).toBe(0.5);
    });

    it("handles zero quantity gracefully", () => {
      expect(num(toBaseUnit(0, 12))).toBe(0);
    });

    it("supports decimal-string inputs without precision loss", () => {
      // A quantity/factor pair that would lose precision under native
      // JS float math is preserved exactly via decimal.js.
      expect(toBaseUnit("2.5", "3.3").toString()).toBe("8.25");
    });
  });

  describe("fromBaseUnit", () => {
    it("converts a base-unit quantity into a display unit (factor 12)", () => {
      // 24 base units (pieces) = 2 cartons of 12
      expect(num(fromBaseUnit(24, 12))).toBe(2);
    });

    it("returns the same quantity when the target unit IS the base unit (factor 1)", () => {
      expect(num(fromBaseUnit(7, 1))).toBe(7);
    });

    it("is the exact inverse of toBaseUnit for the same factor", () => {
      const factor = 24;
      const original = new Decimal(3);
      const roundTripped = fromBaseUnit(toBaseUnit(original, factor), factor);
      expect(roundTripped.equals(original)).toBe(true);
    });
  });

  describe("isReservedBaseUnitFactor / assertIsValidBaseUnitFactor", () => {
    it("recognizes exactly 1 as the reserved base-unit factor", () => {
      expect(isReservedBaseUnitFactor(1)).toBe(true);
      expect(isReservedBaseUnitFactor("1")).toBe(true);
      expect(isReservedBaseUnitFactor("1.0")).toBe(true);
    });

    it("rejects any factor other than exactly 1", () => {
      expect(isReservedBaseUnitFactor(12)).toBe(false);
      expect(isReservedBaseUnitFactor(0.5)).toBe(false);
    });

    it("assertIsValidBaseUnitFactor does not throw for exactly 1", () => {
      expect(() => assertIsValidBaseUnitFactor(1)).not.toThrow();
    });

    it("assertIsValidBaseUnitFactor throws for anything other than 1", () => {
      expect(() => assertIsValidBaseUnitFactor(12)).toThrow();
      expect(() => assertIsValidBaseUnitFactor(0)).toThrow();
    });
  });

  describe("validatePackagingUnits", () => {
    // NOTE: validatePackagingUnits only returns { valid, error? } — it does
    // NOT return a `baseUnit` field. The confirmed rule set (see the
    // VALIDATION SCOPE NOTE atop units.ts) is exactly five rules; these
    // tests check only those five and do not assert on a `baseUnit`
    // property that doesn't exist in the implementation.

    it("validates valid base + secondary + tertiary packaging setup", () => {
      const units = [
        { unitName: "قطعة", conversionFactor: 1 },
        { unitName: "طرد (6 قطع)", conversionFactor: 6 },
        { unitName: "صندوق (24 قطعة)", conversionFactor: 24 },
      ];
      const result = validatePackagingUnits(units);
      expect(result.valid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it("fails if no base unit (factor 1) exists", () => {
      const units = [
        { unitName: "طرد", conversionFactor: 6 },
        { unitName: "كرتونة", conversionFactor: 12 },
      ];
      const result = validatePackagingUnits(units);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("يجب تحديد وحدة أساسية واحدة بمعامل تحويل يساوي 1");
    });

    // NOTE ON IMPLEMENTATION BEHAVIOR: units.ts checks for a duplicate
    // conversionFactor *inside* the same loop that counts base units, and
    // the duplicate-factor check fires before the post-loop
    // baseUnitCount > 1 check ever runs. Since two units can only both
    // have conversionFactor === 1 by definition sharing the same
    // normalized factorKey ("1"), the duplicate-factor branch always
    // catches this case first — the dedicated "أكثر من وحدة أساسية"
    // message is currently unreachable dead code. This test asserts the
    // actual (reachable) behavior; flagged for a product decision on
    // whether the check order should change to surface a more specific
    // message for this case.
    it("fails if multiple units share conversionFactor 1 (caught by the duplicate-factor check, not a separate 'multiple base units' message)", () => {
      const units = [
        { unitName: "قطعة 1", conversionFactor: 1 },
        { unitName: "قطعة 2", conversionFactor: 1 },
      ];
      const result = validatePackagingUnits(units);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("معامل التحويل مكرر");
    });

    it("fails on duplicate conversion factor", () => {
      const units = [
        { unitName: "قطعة", conversionFactor: 1 },
        { unitName: "طرد أ", conversionFactor: 6 },
        { unitName: "طرد ب", conversionFactor: 6 },
      ];
      const result = validatePackagingUnits(units);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("معامل التحويل مكرر");
    });

    it("treats mathematically-equal factors written differently as duplicates (e.g. 6 vs 6.0)", () => {
      const units = [
        { unitName: "قطعة", conversionFactor: 1 },
        { unitName: "طرد أ", conversionFactor: 6 },
        { unitName: "طرد ب", conversionFactor: "6.0" },
      ];
      const result = validatePackagingUnits(units);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("معامل التحويل مكرر");
    });

    it("fails on empty unit name", () => {
      const units = [{ unitName: "", conversionFactor: 1 }];
      const result = validatePackagingUnits(units);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("اسم الوحدة مطلوب");
    });

    it("fails on empty units array", () => {
      const result = validatePackagingUnits([]);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("يجب تحديد وحدة قياس واحدة على الأقل");
    });

    it("fails on non-positive conversion factor", () => {
      const units = [
        { unitName: "قطعة", conversionFactor: 1 },
        { unitName: "سالبة", conversionFactor: -2 },
      ];
      const result = validatePackagingUnits(units);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("يجب أن يكون رقماً موجباً أكبر من الصفر");
    });

    it("allows a fractional conversion factor (e.g. half-carton)", () => {
      const units = [
        { unitName: "قطعة", conversionFactor: 1 },
        { unitName: "نصف كرتونة", conversionFactor: 0.5 },
      ];
      const result = validatePackagingUnits(units);
      expect(result.valid).toBe(true);
    });
  });
});

// NOT ported from the original test file: "fails on duplicate unit name".
// The confirmed VALIDATION SCOPE NOTE in units.ts lists exactly five
// rules and explicitly warns against adding further constraints "without
// explicit confirmation." Duplicate-unit-name rejection is not one of the
// five, and the current implementation only tracks duplicate conversion
// factors, not duplicate names (two units named "قطعة" with different
// factors currently pass validation). If a duplicate-name rule is actually
// wanted, that needs to be confirmed as a real business decision first —
// then units.ts's five-rule list, its scope note, and this test file
// should all be updated together, not just the test.