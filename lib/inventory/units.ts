/**
 * lib/inventory/units.ts
 *
 * THE ONLY FILE IN THE ENTIRE CODEBASE PERMITTED TO PERFORM ARITHMETIC ON
 * `ProductUnit.conversionFactor`.
 *
 * No UI component, no API route, no other lib module may compute
 * `quantity * conversionFactor` or `quantity / conversionFactor` directly.
 * Every such computation goes through one of the functions below, all
 * built on decimal.js — never a native JS number. This is what prevents
 * the accumulated-rounding-error bug documented in UNIT-ARCHITECTURE.md
 * (batch quantities like "21.9984 قطعة" instead of "24 قطعة") from ever
 * recurring. Enforced by a dedicated ESLint rule (see eslint-rules/
 * no-direct-conversion-factor-arithmetic.js), same mechanism as the
 * project's existing $queryRaw and nested-write rules — CI fails the
 * build on violation.
 *
 * DIRECTION RULES — do not mix these up:
 *   - toBaseUnit()   → used whenever something DECREMENTS or WRITES a
 *                       ProductBatch.quantity / StockAdjustment.quantityDelta
 *                       figure: a POS sale, a B2B approval, a manual
 *                       reconciliation entered in a non-base unit. The
 *                       result of this function is the ONLY thing ever
 *                       passed as `requestedQty` to
 *                       commitFifoAllocation() (T3b) or written to
 *                       ProductBatch.quantity / StockAdjustment.quantityDelta.
 *   - fromBaseUnit() / breakdownForDisplay() → DISPLAY ONLY. Their output
 *                       is never written back to any table. Used for
 *                       showing a batch's remaining stock in a
 *                       human-friendly unit on the inventory/POS screen.
 */

import Decimal from "decimal.js";

type Numeric = string | number | Decimal;

/**
 * Converts a quantity expressed in a sale/display unit into the
 * equivalent quantity in the product's base unit.
 *
 * Example: selling 3 packs where 1 pack = 24 pieces (the base unit):
 *   toBaseUnit(3, 24) → Decimal("72")
 *
 * This is the ONLY sanctioned direction for anything that decrements
 * ProductBatch.quantity or writes StockAdjustment.quantityDelta. The
 * `soldUnitConversionFactor` argument MUST come from a trusted source —
 * i.e. resolved server-side via a Prisma read (through requireBaseUnit()
 * or a plain ProductUnit lookup scoped by tenantId), never taken as-is
 * from a client request payload. See T4c's and T5's sync/approval notes
 * in MASTER-SPEC v4.0 for why: a client-supplied conversionFactor could
 * be tampered with to under/over-deduct stock.
 */
export function toBaseUnit(
    quantityInSoldUnit: Numeric,
    soldUnitConversionFactor: Numeric
): Decimal {
    return new Decimal(quantityInSoldUnit).times(soldUnitConversionFactor);
}

/**
 * The reverse direction — converts a quantity already in the base unit
 * (as stored in ProductBatch.quantity) into a target display/sale unit.
 *
 * DISPLAY ONLY. The result of this call must never be written back to
 * ProductBatch.quantity, StockAdjustment.quantityDelta, or any other
 * persisted field — it exists purely to render something readable on
 * screen (e.g. converting a raw base-unit figure into "how many packs is
 * this?" for a single-unit display, before breakdownForDisplay() below
 * does the fuller multi-unit breakdown).
 */
export function fromBaseUnit(
    quantityInBaseUnit: Numeric,
    targetUnitConversionFactor: Numeric
): Decimal {
    return new Decimal(quantityInBaseUnit).dividedBy(targetUnitConversionFactor);
}

export interface DisplayUnit {
    id: string;
    unitName: string;
    conversionFactor: Numeric;
}

export interface UnitBreakdownEntry {
    unitId: string;
    unitName: string;
    count: Decimal;
}

/**
 * Breaks a base-unit quantity down into the largest possible units first,
 * then the remainder in progressively smaller units — the human-friendly
 * "2 packs and 24 pieces" style display used on the inventory/POS screens.
 *
 * DETERMINISTIC AND ERROR-FREE BY CONSTRUCTION: every call starts from
 * the original `quantityInBaseUnit` — the actual value stored in
 * ProductBatch.quantity — never from the output of a previous conversion.
 * Each level's remainder is computed as `remaining - count * factor` in
 * Decimal, not via a JS `%` operator, so there is no possibility of
 * accumulated floating-point drift regardless of how many times this
 * function is called or in what order.
 *
 * `units` should include every active ProductUnit for the product,
 * including the base unit itself (conversionFactor = "1") so any leftover
 * remainder below the smallest packaging unit still resolves to a clean
 * base-unit count rather than being silently dropped.
 */
export function breakdownForDisplay(
    quantityInBaseUnit: Numeric,
    units: DisplayUnit[]
): UnitBreakdownEntry[] {
    const sorted = [...units].sort((a, b) =>
        new Decimal(b.conversionFactor).comparedTo(new Decimal(a.conversionFactor))
    );

    let remaining = new Decimal(quantityInBaseUnit);
    const result: UnitBreakdownEntry[] = [];

    for (const unit of sorted) {
        const factor = new Decimal(unit.conversionFactor);
        if (factor.lessThanOrEqualTo(0)) {
            // Defensive: a conversionFactor of 0 or negative is invalid data —
            // skip rather than divide by zero / produce a nonsensical count.
            continue;
        }
        const count = remaining.dividedBy(factor).floor();
        if (count.greaterThan(0)) {
            result.push({ unitId: unit.id, unitName: unit.unitName, count });
            remaining = remaining.minus(count.times(factor));
        }
    }

    return result;
}

/**
 * Convenience guard for the base unit's own row: throws if a
 * conversionFactor other than exactly 1 is ever supplied for what's being
 * treated as a base unit. Call this at the point a base ProductUnit is
 * created (see lib/inventory/product-create.ts) — it exists to catch a
 * programming mistake immediately rather than let a wrong value slip into
 * the database and corrupt every downstream conversion for that product.
 */
export function assertIsValidBaseUnitFactor(conversionFactor: Numeric): void {
    if (!new Decimal(conversionFactor).equals(1)) {
        throw new Error(
            `A product's base unit must have conversionFactor exactly 1 — ` +
            `received ${conversionFactor.toString()}. The base unit is the ` +
            `reference point every other unit's conversionFactor is expressed ` +
            `relative to; it cannot itself be anything other than 1.`
        );
    }
}