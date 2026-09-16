/**
 * lib/inventory/packaging-unit-validation.ts
 * (renamed from the original "Multi-Unit Conversion Engine" — see
 * CORRECTION NOTE below for why)
 *
 * Validates packaging-unit rules for a product at creation/edit time
 * (T3a §0 / §1). This file does NOT perform any base-unit conversion
 * arithmetic — that is the exclusive job of lib/inventory/units.ts
 * (toBaseUnit / fromBaseUnit / breakdownForDisplay), per T1's Unit
 * Conversion Architecture (MASTER-SPEC v4.0). See the CORRECTION NOTE
 * below for what was removed from this file and why.
 *
 * ============================================================================
 * CORRECTION NOTE (v4.0 alignment fix):
 * The original version of this file additionally exported
 * `convertUnitQuantity(qty, fromFactor, toFactor)`,
 * `convertUnitCost(cost, fromFactor, toFactor)`, and
 * `calculateBatchDeductions(requestedQty, requestedFactor, batchFactor)` —
 * generic "convert between any two arbitrary packaging units" functions.
 * `calculateBatchDeductions` in particular assumed a ProductBatch could be
 * tracked in a non-base unit (its own docstring example: "Batch is tracked
 * in Boxes (factor 24): deduction = 18 / 24 = 0.75 boxes").
 *
 * That is exactly the pre-v4.0 design MASTER-SPEC v4.0 explicitly replaced
 * (Rejected Approach #10): ProductBatch.quantity is now ALWAYS expressed
 * in the product's single designated base unit — never "boxes," never
 * whatever unit happened to be on screen. Keeping those three functions
 * around risked two concrete failures:
 *   1. A write path (POS/T4c, B2B approval/T5, reconciliation/T3c) could
 *      call calculateBatchDeductions instead of toBaseUnit() and silently
 *      compute a deduction against a non-base "batch unit" that, per the
 *      current schema, no longer exists — reintroducing the accumulated
 *      rounding-error bug ("21.9984 قطعة" instead of "24 قطعة") v4.0 was
 *      built specifically to eliminate.
 *   2. Performing conversionFactor arithmetic outside lib/inventory/
 *      units.ts violates the project's dedicated ESLint rule (identical
 *      mechanism to the $queryRaw / nested-write rules) that blocks any
 *      multiply/divide by a conversionFactor-like value outside that one
 *      sanctioned file.
 *
 * All three functions have been removed from this file. Only
 * `validatePackagingUnits` (creation/edit-time validation, not a
 * conversion) remains. Any code that needs an actual base-unit
 * conversion must import toBaseUnit()/fromBaseUnit()/breakdownForDisplay()
 * from lib/inventory/units.ts instead.
 * ============================================================================
 *
 * VALIDATION SCOPE NOTE (confirmed business rules — do not weaken without
 * explicit confirmation):
 * validatePackagingUnits enforces exactly these packaging-unit rules:
 *   1. At least one unit must be provided.
 *   2. unitName is required (non-empty) — matches the non-nullable schema field.
 *   3. conversionFactor must be a positive number. Fractional factors are
 *      explicitly ALLOWED and intentional — a wholesaler may legitimately
 *      sell a quarter- or half-carton at a prorated wholesale price, so
 *      conversionFactor is NEVER restricted to integers.
 *   4. Exactly ONE unit per product must have conversionFactor === 1 — the
 *      base unit. Under T3a §0 (v4.0), this is not a free choice among
 *      several editable units: the FIRST unit entered at product creation
 *      automatically becomes the base unit, and the UI locks its
 *      conversionFactor to 1 without even exposing an editable field for
 *      it. This validation function is therefore a defensive safety net
 *      (e.g. catching a bug in a batch-edit or CSV-import path that
 *      shouldn't be able to produce zero or multiple factor-1 units in
 *      the first place) rather than the primary mechanism that "chooses"
 *      the base unit.
 *   5. No two units on the same product may share the same
 *      conversionFactor — a duplicate factor creates ambiguity in FIFO
 *      allocation display and POS/storefront unit pickers (which unit is
 *      "the" 12-factor unit?), so it is forbidden outright.
 * Do not add further constraints beyond these five (integer-only factors
 * being one that was previously and deliberately rejected) without
 * explicit confirmation, and do not remove rules 4/5 without it either —
 * both directions of drift have happened before on this module.
 *
 * [FIX — TypeScript build error] `Decimal.Value` (the namespace-merged
 * type decimal.js's own .d.ts declares alongside the `Decimal` class) does
 * not resolve under this project's TypeScript/module configuration
 * (Next.js 16 + Turbopack, "moduleResolution": "bundler") — the default
 * import `import Decimal from "decimal.js"` only carries the VALUE binding
 * here, not the merged namespace/type, so every use of `Decimal.Value` or
 * even the bare `Decimal` class name AS A TYPE failed to compile
 * (`TS2749`/`TS2833`). `Decimal` still works perfectly fine as a VALUE
 * (constructing instances via `new Decimal(...)` is unaffected) — only
 * its use as a standalone type name is broken in this config. Fixed by
 * defining two local type aliases derived from `typeof Decimal` — which
 * TypeScript can always compute from a value regardless of whether that
 * value's own type name resolves — instead of depending on decimal.js's
 * own namespace declaration:
 *   - `DecimalInstance` replaces every bare `Decimal` used as a type.
 *   - `DecimalValue` replaces every `Decimal.Value` used as a type.
 * No runtime behavior changes; this is a type-only fix.
 */

import Decimal from "decimal.js";

type DecimalInstance = InstanceType<typeof Decimal>;
type DecimalValue = number | string | DecimalInstance;

export interface PackagingUnit {
  id?: string;
  unitName: string;
  conversionFactor: DecimalValue; // number | string | Decimal — always normalized internally
  priceWholesale?: DecimalValue;
  priceRetail?: DecimalValue | null;
  isActive?: boolean;
}

/**
 * Validates packaging unit rules for a product. See the VALIDATION SCOPE
 * NOTE at the top of this file for the full, confirmed rule set and the
 * reasoning behind each rule. This function performs no base-unit
 * conversion arithmetic itself — see lib/inventory/units.ts for that.
 */
export function validatePackagingUnits(units: PackagingUnit[]): {
  valid: boolean;
  error?: string;
} {
  if (!units || units.length === 0) {
    return { valid: false, error: "يجب تحديد وحدة قياس واحدة على الأقل." };
  }

  const factorsSeen = new Map<string, string>(); // normalized factor key -> unitName that used it
  let baseUnitCount = 0;

  for (const u of units) {
    if (!u.unitName || !u.unitName.trim()) {
      return { valid: false, error: "اسم الوحدة مطلوب لجميع الوحدات." };
    }

    let factor: DecimalInstance;
    try {
      factor = new Decimal(u.conversionFactor);
    } catch {
      return {
        valid: false,
        error: `معامل التحويل للوحدة "${u.unitName}" غير صالح.`,
      };
    }

    if (factor.lte(0)) {
      return {
        valid: false,
        error: `معامل التحويل للوحدة "${u.unitName}" يجب أن يكون رقماً موجباً أكبر من الصفر.`,
      };
    }

    if (factor.equals(1)) {
      baseUnitCount += 1;
    }

    // Normalize the factor to a canonical decimal string so that
    // mathematically-equal values written differently (e.g. "12" vs
    // "12.0" vs "12.00") are correctly detected as duplicates.
    const factorKey = factor.toFixed();
    const existingUnitName = factorsSeen.get(factorKey);
    if (existingUnitName) {
      return {
        valid: false,
        error: `معامل التحويل مكرر: الوحدتان "${existingUnitName}" و"${u.unitName}" لهما نفس معامل التحويل (${factor.toString()}).`,
      };
    }
    factorsSeen.set(factorKey, u.unitName);
  }

  if (baseUnitCount === 0) {
    return {
      valid: false,
      error: "يجب تحديد وحدة أساسية واحدة بمعامل تحويل يساوي 1 (مثلاً: قطعة).",
    };
  }

  if (baseUnitCount > 1) {
    return {
      valid: false,
      error: "لا يمكن تحديد أكثر من وحدة أساسية واحدة بمعامل تحويل يساوي 1.",
    };
  }

  return { valid: true };
}