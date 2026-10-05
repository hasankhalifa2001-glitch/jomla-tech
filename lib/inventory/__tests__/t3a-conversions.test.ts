import { describe, it, expect } from "vitest";
import Decimal from "decimal.js";
import {
  toBaseUnit,
  fromBaseUnit,
  validatePackagingUnits,
  isReservedBaseUnitFactor,
  assertIsValidBaseUnitFactor,
  costFromTotal,
  costBreakdownForDisplay,
  InvalidCostInputError,
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

    // NOTE ON IMPLEMENTATION BEHAVIOR: units.ts counts base units *inside*
    // the same loop that detects duplicate conversionFactors, and the
    // base-unit check now runs FIRST — so two units that both declare
    // conversionFactor === 1 are reported with the specific "أكثر من وحدة
    // أساسية واحدة" message rather than the generic duplicate-factor one.
    // (The reverse ordering made that specific message unreachable dead
    // code; units.ts's own header documents the change, and this assertion
    // was left behind by it. The generic duplicate-factor check in the next
    // test still covers every OTHER repeated factor.)
    it("reports the specific 'more than one base unit' message when two units both declare conversionFactor 1", () => {
      const units = [
        { unitName: "قطعة 1", conversionFactor: 1 },
        { unitName: "قطعة 2", conversionFactor: 1 },
      ];
      const result = validatePackagingUnits(units);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("لا يمكن تحديد أكثر من وحدة أساسية واحدة بمعامل تحويل يساوي 1");
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

// ============================================================================
// [Batch cost entry] T3a/T4g — "the merchant enters the TOTAL paid for the
// received quantity, the system derives the cost per BASE unit".
//
// costFromTotal() is the ONE derivation the server actually stores from
// (lib/inventory/batch-creation.ts's createBatchRow() calls it), and
// costBreakdownForDisplay() is what both batch forms render live off the same
// function — so these cases pin both what gets written and what the merchant
// is promised on screen.
// ============================================================================

describe("costFromTotal — Total paid -> cost per base unit", () => {
  it("derives the worked example the screens use: 6 طرد (factor 6) for 54,000 SYP", () => {
    const result = costFromTotal("54000", "6", 6);
    // 6 طرد x factor 6 = 36 قطعة, and 54,000 / 36 = 1,500 per قطعة.
    expect(result.baseQuantity).toBe("36.0000");
    expect(result.perBaseUnit).toBe("1500.00000000");
    // The two stored values reconcile back to exactly what was paid.
    expect(new Decimal(result.perBaseUnit).times(result.baseQuantity).toString()).toBe("54000");
  });

  it("emits the base quantity at the column's own scale 4 and the cost at scale 8", () => {
    const result = costFromTotal("54000", "6", 6);
    expect(result.baseQuantity.split(".")[1]).toHaveLength(4);
    expect(result.perBaseUnit.split(".")[1]).toHaveLength(8);
  });

  it("degenerates to a plain division when the purchase unit IS the base unit (factor 1)", () => {
    const result = costFromTotal("4500", "3", 1);
    expect(result.baseQuantity).toBe("3.0000");
    expect(result.perBaseUnit).toBe("1500.00000000");
  });

  it("divides by the quantity AFTER converting it with the purchase unit's own factor", () => {
    // 2 كرتونة x factor 12 = 24 pieces, 24,000 / 24 = 1,000 per piece.
    const result = costFromTotal("24000", "2", 12);
    expect(result.baseQuantity).toBe("24.0000");
    expect(result.perBaseUnit).toBe("1000.00000000");
  });

  it("does NOT round a non-terminating per-base price to 4 dp — the reason the column is Decimal(18,8)", () => {
    const result = costFromTotal("100", "3", 1);
    expect(result.perBaseUnit).toBe("33.33333333");
    // At 4 dp the stored value would be 33.3333, and 33.3333 x 3 = 99.9999,
    // i.e. the batch's cost basis would no longer reconcile with the 100 paid.
    expect(new Decimal(result.perBaseUnit).times(result.baseQuantity).toDecimalPlaces(4).toString()).toBe("100");
  });

  it("accepts decimal-string inputs without native-float drift", () => {
    const result = costFromTotal("3.3", "2.5", "1");
    expect(result.baseQuantity).toBe("2.5000");
    expect(result.perBaseUnit).toBe("1.32000000");
  });

  it("rejects a zero or negative total", () => {
    expect(() => costFromTotal("0", "6", 6)).toThrow(InvalidCostInputError);
    expect(() => costFromTotal("-54000", "6", 6)).toThrow(InvalidCostInputError);
  });

  it("rejects a zero or negative quantity", () => {
    expect(() => costFromTotal("54000", "0", 6)).toThrow(InvalidCostInputError);
    expect(() => costFromTotal("54000", "-6", 6)).toThrow(InvalidCostInputError);
  });

  it("rejects a non-positive conversion factor", () => {
    expect(() => costFromTotal("54000", "6", 0)).toThrow(InvalidCostInputError);
    expect(() => costFromTotal("54000", "6", -6)).toThrow(InvalidCostInputError);
  });

  it("rejects empty or malformed numeric input", () => {
    expect(() => costFromTotal("", "6", 6)).toThrow(InvalidCostInputError);
    expect(() => costFromTotal("54000", "", 6)).toThrow(InvalidCostInputError);
    expect(() => costFromTotal("abc", "6", 6)).toThrow(InvalidCostInputError);
  });

  it("rejects a derived cost that would overflow Decimal(18,8)", () => {
    // 99,999,999,999,999 over a single base unit exceeds the column's 10
    // integer digits — better a clear Arabic error at entry time than a
    // silent Postgres overflow at write time.
    expect(() => costFromTotal("99999999999999", "1", 1)).toThrow(InvalidCostInputError);
  });
});

describe("costBreakdownForDisplay — the live lines in both batch forms", () => {
  it("renders the brief's three figures for 6 طرد @ 54,000", () => {
    const breakdown = costBreakdownForDisplay("54000", "6", 6);
    expect(breakdown).not.toBeNull();
    expect(breakdown!.quantityInBaseUnits).toBe("36");
    expect(breakdown!.pricePerPurchaseUnit).toBe("9000.00"); // 54,000 / 6 طرد
    expect(breakdown!.pricePerBaseUnit).toBe("1500.00"); // 54,000 / 36 قطعة
  });

  it("returns one and the same figure for both price lines when the unit IS the base unit", () => {
    // This equality is exactly why the UI hides the redundant
    // per-purchase-unit line in that case, rather than repeating it.
    const breakdown = costBreakdownForDisplay("4500", "3", 1);
    expect(breakdown!.quantityInBaseUnits).toBe("3");
    expect(breakdown!.pricePerPurchaseUnit).toBe("1500.00");
    expect(breakdown!.pricePerBaseUnit).toBe("1500.00");
  });

  it("rounds both displayed prices to 2 dp, ROUND_HALF_UP", () => {
    const breakdown = costBreakdownForDisplay("100", "3", 1);
    expect(breakdown!.pricePerPurchaseUnit).toBe("33.33");
    expect(breakdown!.pricePerBaseUnit).toBe("33.33");
  });

  it("returns null — so the form renders nothing rather than a misleading 0.00 — for any not-yet-derivable pair", () => {
    // Empty (still being typed), zero (not yet a real quantity) and malformed
    // input all land here; the live block is simply absent in those states.
    expect(costBreakdownForDisplay("", "6", 6)).toBeNull();
    expect(costBreakdownForDisplay("54000", "", 6)).toBeNull();
    expect(costBreakdownForDisplay("0", "6", 6)).toBeNull();
    expect(costBreakdownForDisplay("54000", "0", 6)).toBeNull();
    expect(costBreakdownForDisplay("54000", "6", 0)).toBeNull();
    expect(costBreakdownForDisplay("abc", "6", 6)).toBeNull();
  });
});