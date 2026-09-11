/**
 * Multi-Unit Conversion Engine (T3a §1)
 *
 * Implements packaging unit conversions (base, secondary, tertiary units)
 * with conversion factors, cost calculations, and inventory deduction math.
 *
 * All monetary and quantity math goes through decimal.js — never native JS
 * numbers — per T1's mandate: "decimal.js — mandatory for every monetary
 * calculation that happens client-side before a value reaches the Prisma
 * Decimal boundary." Quantity outputs also route through decimal.js since
 * they feed ProductBatch.quantity, a Decimal(18,4) column — precision must
 * be exact from the source, never float-then-converted.
 *
 * PERMANENT SPEC ENFORCEMENT NOTE (T3a §5 / schema.prisma BarcodeSource):
 * No function anywhere in this module or the entire codebase may infer
 * or guess `barcodeSource` ("GS1" vs "INTERNAL") from digit length, checksum,
 * or known GS1 prefix patterns. The barcodeSource decision is ALWAYS human
 * and must be confirmed explicitly by the merchant via the mandatory
 * BarcodeSourceModal. Any attempt to automate or infer barcodeSource is
 * strictly forbidden by the Master Technical Specification.
 *
 * VALIDATION SCOPE NOTE (confirmed business rules — do not weaken without
 * explicit confirmation, mirroring the caution this same note used to urge
 * in the opposite direction):
 * validatePackagingUnits enforces exactly these packaging-unit rules:
 *   1. At least one unit must be provided.
 *   2. unitName is required (non-empty) — matches the non-nullable schema field.
 *   3. conversionFactor must be a positive number. Fractional factors are
 *      explicitly ALLOWED and intentional — a wholesaler may legitimately
 *      sell a quarter- or half-carton at a prorated wholesale price, so
 *      conversionFactor is NEVER restricted to integers.
 *   4. Exactly ONE unit per product must have conversionFactor === 1 — the
 *      designated "base" unit. This is required, not optional: every
 *      conversion function in this module (convertUnitQuantity,
 *      convertUnitCost, calculateBatchDeductions) computes through a common
 *      base reference, and with zero or multiple base units that reference
 *      point becomes ambiguous or undefined.
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

function toPositiveDecimal(value: DecimalValue, label: string): DecimalInstance {
  const d = new Decimal(value);
  if (d.lte(0)) {
    throw new Error(`${label} يجب أن يكون رقماً موجباً أكبر من الصفر.`);
  }
  return d;
}

/**
 * Converts a quantity from one packaging unit to another using their conversion factors.
 * All conversion factors are defined relative to a base reference (whichever unit's
 * conversionFactor is smallest / treated as 1 in the merchant's own configuration).
 *
 * Example:
 * 1 Carton = 12 Pieces (carton factor = 12, piece factor = 1)
 * convertUnitQuantity(2, 12, 1) -> 24 (2 cartons = 24 pieces)
 * convertUnitQuantity(24, 1, 12) -> 2 (24 pieces = 2 cartons)
 */
export function convertUnitQuantity(
  quantity: DecimalValue,
  fromConversionFactor: DecimalValue,
  toConversionFactor: DecimalValue
): DecimalInstance {
  const from = toPositiveDecimal(fromConversionFactor, "معامل التحويل المصدر");
  const to = toPositiveDecimal(toConversionFactor, "معامل التحويل الهدف");
  const qty = new Decimal(quantity);

  if (qty.isZero()) return new Decimal(0);

  // Convert to the common base quantity first, then to the target unit.
  const qtyInBase = qty.times(from);
  return qtyInBase.dividedBy(to);
}

/**
 * Converts cost or price from one unit to another.
 * If 1 Piece costs $1, 1 Carton (factor 12) equivalent base cost is $12.
 *
 * convertUnitCost(12, 12, 1) -> 1 ($12 per carton = $1 per piece)
 * convertUnitCost(1, 1, 12) -> 12 ($1 per piece = $12 per carton)
 */
export function convertUnitCost(
  cost: DecimalValue,
  fromConversionFactor: DecimalValue,
  toConversionFactor: DecimalValue
): DecimalInstance {
  const from = toPositiveDecimal(fromConversionFactor, "معامل التحويل المصدر");
  const to = toPositiveDecimal(toConversionFactor, "معامل التحويل الهدف");
  const c = new Decimal(cost);

  if (c.isZero()) return new Decimal(0);

  const costPerBase = c.dividedBy(from);
  return costPerBase.times(to);
}

/**
 * Calculates how many units must be deducted from a batch unit when
 * a sale occurs in a requested packaging unit.
 *
 * Example:
 * Requested: 3 Packs (factor 6) = 18 base items.
 * Batch is tracked in Pieces (factor 1):
 * deduction = 18 pieces.
 * Batch is tracked in Boxes (factor 24):
 * deduction = 18 / 24 = 0.75 boxes.
 */
export function calculateBatchDeductions(
  requestedQty: DecimalValue,
  requestedConversionFactor: DecimalValue,
  batchConversionFactor: DecimalValue
): {
  allocatedInRequestedUnit: DecimalInstance;
  deductedInBatchUnit: DecimalInstance;
  quantityInBaseUnit: DecimalInstance;
} {
  const qty = toPositiveDecimal(requestedQty, "الكمية المطلوبة");
  const reqFactor = toPositiveDecimal(requestedConversionFactor, "معامل تحويل الوحدة المطلوبة");
  const batchFactor = toPositiveDecimal(batchConversionFactor, "معامل تحويل وحدة الدفعة");

  const quantityInBaseUnit = qty.times(reqFactor);
  const deductedInBatchUnit = quantityInBaseUnit.dividedBy(batchFactor);

  return {
    allocatedInRequestedUnit: qty,
    deductedInBatchUnit,
    quantityInBaseUnit,
  };
}

/**
 * Validates packaging unit rules for a product. See the VALIDATION SCOPE
 * NOTE at the top of this file for the full, confirmed rule set and the
 * reasoning behind each rule.
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