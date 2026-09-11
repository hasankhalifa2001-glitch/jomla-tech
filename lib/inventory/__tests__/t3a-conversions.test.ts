import { describe, it, expect } from "vitest";
import Decimal from "decimal.js";
import {
  convertUnitQuantity,
  convertUnitCost,
  calculateBatchDeductions,
  validatePackagingUnits,
} from "../conversions";

// [FIX — TypeScript build error] Same root cause as documented atop
// conversions.ts: decimal.js's own namespace-merged `Decimal` type does
// not resolve under this project's Next.js 16 + Turbopack
// "moduleResolution": "bundler" config — `import Decimal from "decimal.js"`
// only carries the VALUE binding here, so using the bare `Decimal` class
// name AS A TYPE fails with TS2749. `Decimal` still works fine as a VALUE
// (e.g. inside the imported functions). Fixed by deriving a local
// `DecimalInstance` type alias from `typeof Decimal`, which TypeScript can
// always compute regardless of whether the value's own type name resolves.
type DecimalInstance = InstanceType<typeof Decimal>;

// All conversion functions return Decimal instances, never native numbers
// (per T1's decimal.js mandate) — compare via .toNumber() for readability
// in these tests, or .equals() when checking against another Decimal.
const num = (d: DecimalInstance) => d.toNumber();

describe("T3a Packaging Unit Conversion Engine", () => {
  describe("convertUnitQuantity", () => {
    it("converts cartons to pieces correctly (factor 12 -> 1)", () => {
      // 2 cartons of 12 = 24 pieces
      expect(num(convertUnitQuantity(2, 12, 1))).toBe(24);
    });

    it("converts pieces to cartons correctly (factor 1 -> 12)", () => {
      // 24 pieces = 2 cartons
      expect(num(convertUnitQuantity(24, 1, 12))).toBe(2);
    });

    it("converts between non-base units correctly (factor 24 box -> factor 6 pack)", () => {
      // 1 box of 24 pieces = 4 packs of 6 pieces
      expect(num(convertUnitQuantity(1, 24, 6))).toBe(4);
    });

    it("handles zero quantity gracefully", () => {
      expect(num(convertUnitQuantity(0, 12, 1))).toBe(0);
    });

    it("throws error for non-positive conversion factors", () => {
      expect(() => convertUnitQuantity(10, 0, 1)).toThrow();
      expect(() => convertUnitQuantity(10, 1, -5)).toThrow();
    });
  });

  describe("convertUnitCost", () => {
    it("calculates cost per piece given cost per carton", () => {
      // 1 carton (12 pcs) costs $120 -> 1 piece costs $10
      expect(num(convertUnitCost(120, 12, 1))).toBe(10);
    });

    it("calculates cost per box given cost per piece", () => {
      // 1 piece costs $5 -> 1 box (24 pcs) costs $120
      expect(num(convertUnitCost(5, 1, 24))).toBe(120);
    });

    it("calculates cost between packaging units", () => {
      // 1 pack (6 pcs) costs $30 -> 1 box (24 pcs) costs $120
      expect(num(convertUnitCost(30, 6, 24))).toBe(120);
    });

    it("throws error for invalid conversion factor", () => {
      expect(() => convertUnitCost(50, -1, 10)).toThrow();
    });
  });

  describe("calculateBatchDeductions", () => {
    it("calculates deductions when batch unit matches requested unit", () => {
      const res = calculateBatchDeductions(5, 1, 1);
      expect(num(res.allocatedInRequestedUnit)).toBe(5);
      expect(num(res.deductedInBatchUnit)).toBe(5);
      expect(num(res.quantityInBaseUnit)).toBe(5);
    });

    it("calculates deductions when requested unit is larger than batch unit", () => {
      // Selling 2 cartons (factor 12) from batch stocked in pieces (factor 1)
      const res = calculateBatchDeductions(2, 12, 1);
      expect(num(res.allocatedInRequestedUnit)).toBe(2);
      expect(num(res.deductedInBatchUnit)).toBe(24);
      expect(num(res.quantityInBaseUnit)).toBe(24);
    });

    it("calculates deductions when requested unit is smaller than batch unit", () => {
      // Selling 12 pieces (factor 1) from batch stocked in cartons (factor 12)
      const res = calculateBatchDeductions(12, 1, 12);
      expect(num(res.allocatedInRequestedUnit)).toBe(12);
      expect(num(res.deductedInBatchUnit)).toBe(1);
      expect(num(res.quantityInBaseUnit)).toBe(12);
    });

    it("rejects zero or negative quantities", () => {
      expect(() => calculateBatchDeductions(0, 1, 1)).toThrow();
      expect(() => calculateBatchDeductions(-3, 1, 1)).toThrow();
    });
  });

  describe("validatePackagingUnits", () => {
    // NOTE: validatePackagingUnits only returns { valid, error? } — it does
    // NOT return a `baseUnit` field. The confirmed rule set (see the
    // VALIDATION SCOPE NOTE atop conversions.ts) is exactly five rules;
    // these tests check only those five and do not assert on a `baseUnit`
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

    // NOTE ON IMPLEMENTATION BEHAVIOR: conversions.ts checks for a
    // duplicate conversionFactor *inside* the same loop that counts base
    // units, and the duplicate-factor check fires before the post-loop
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
// The confirmed VALIDATION SCOPE NOTE in conversions.ts lists exactly five
// rules and explicitly warns against adding further constraints "without
// explicit confirmation." Duplicate-unit-name rejection is not one of the
// five, and the current implementation only tracks duplicate conversion
// factors, not duplicate names (two units named "قطعة" with different
// factors currently pass validation). If a duplicate-name rule is actually
// wanted, that needs to be confirmed as a real business decision first —
// then conversions.ts's five-rule list, its scope note, and this test file
// should all be updated together, not just the test.