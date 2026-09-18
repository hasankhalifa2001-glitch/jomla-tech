/**
 * lib/inventory/units.ts
 *
 * THE ONLY FILE IN THE ENTIRE CODEBASE PERMITTED TO NAME
 * `ProductUnit.conversionFactor` — as a `select`/`data`/`include` object
 * key, as a `MemberExpression` property, as a destructured binding, or in
 * any arithmetic expression built from it.
 *
 * [FIX — tx type] `getUnitConversionFactor()` below now takes
 * `TenantTransactionClient` (imported from lib/db/tenant-scope.ts) instead
 * of `Prisma.TransactionClient` — the two are NOT structurally identical
 * for this codebase, since every $transaction() call here goes through
 * getTenantDb()'s extended client. See tenant-scope.ts's own header note
 * for the full explanation.
 *
 * [FIX — toDisplayUnits() field consistency] Previously serialized
 * `conversionFactor` to a string but left `priceWholesale`/`priceRetail`
 * as raw Prisma.Decimal instances — inconsistent, even though it worked
 * by accident (Decimal has a `.toJSON()` Prisma relies on for
 * NextResponse.json() serialization). All three are now consistently
 * strings, matching T1's "decimal.js-serialized string, never a native
 * number" rule and matching conversionFactor's own treatment.
 *
 * DIRECTION RULES — do not mix these up:
 *   - toBaseUnit()   → used whenever something DECREMENTS or WRITES a
 *                       ProductBatch.quantity / StockAdjustment.quantityDelta
 *                       figure. The result is the ONLY thing ever passed
 *                       as `requestedQty` to commitFifoAllocation() (T3b)
 *                       or written to ProductBatch.quantity /
 *                       StockAdjustment.quantityDelta.
 *   - fromBaseUnit() / breakdownForDisplay() → DISPLAY ONLY. Their output
 *                       is never written back to any table.
 *   - getUnitConversionFactor() → the ONLY sanctioned way, anywhere in
 *                       the codebase, to obtain ONE specific ProductUnit's
 *                       conversionFactor from the database, for use in
 *                       toBaseUnit()/fromBaseUnit(). Never store, log, or
 *                       forward it to a client payload.
 *   - toDisplayUnits() / toOfflineCacheUnits() → the ONLY sanctioned way
 *                       to turn a batch of already-fetched ProductUnit
 *                       rows (from lib/data/products.ts's plain reads)
 *                       into a shape a caller outside this file can
 *                       actually use without itself naming
 *                       `conversionFactor`.
 *   - validatePackagingUnits() → creation/edit-time RULE CHECK only
 *                       (T3a §0/§1) — one base unit, positive factors, no
 *                       duplicates. Performs no conversion arithmetic and
 *                       writes nothing.
 *
 * [TypeScript build note, unchanged] `Decimal` used as a standalone TYPE
 * name does not resolve under this project's module configuration
 * ("moduleResolution": "bundler"). `Decimal` still works fine as a VALUE.
 * Fix: a local `DecimalInstance` type alias derived from `typeof Decimal`.
 */

import Decimal from "decimal.js";
import type { ProductUnit } from "@prisma/client";
import type { TenantTransactionClient } from "@/lib/db/tenant-scope";

type DecimalInstance = InstanceType<typeof Decimal>;
type Numeric = string | number | DecimalInstance;

/** The one and only valid conversionFactor value for any base unit. */
export const BASE_UNIT_CONVERSION_FACTOR = "1";

/**
 * Converts a quantity expressed in a sale/display unit into the
 * equivalent quantity in the product's base unit.
 *
 * Example: selling 3 packs where 1 pack = 24 pieces (the base unit):
 *   toBaseUnit(3, 24) → Decimal("72")
 *
 * The `soldUnitConversionFactor` argument MUST come from
 * getUnitConversionFactor() below — resolved server-side, tenant-scoped —
 * never taken as-is from a client request payload for a path that
 * re-validates a previously-submitted quantity (T4c's sync, T5's B2B
 * approval). A same-request submission (e.g. product creation's own
 * initial batch) may trust its own payload, since nothing else could have
 * tampered with it between submission and this call.
 */
export function toBaseUnit(
    quantityInSoldUnit: Numeric,
    soldUnitConversionFactor: Numeric
): DecimalInstance {
    return new Decimal(quantityInSoldUnit).times(soldUnitConversionFactor);
}

/**
 * The reverse direction — converts a quantity already in the base unit
 * (as stored in ProductBatch.quantity) into a target display/sale unit.
 *
 * DISPLAY ONLY. The result of this call must never be written back to
 * ProductBatch.quantity, StockAdjustment.quantityDelta, or any other
 * persisted field.
 */
export function fromBaseUnit(
    quantityInBaseUnit: Numeric,
    targetUnitConversionFactor: Numeric
): DecimalInstance {
    return new Decimal(quantityInBaseUnit).dividedBy(targetUnitConversionFactor);
}

export interface DisplayUnit {
    id: string;
    unitName: string;
    conversionFactor: string;
    isActive: boolean;
    pricingCurrency: "SYP" | "USD";
    priceWholesale: string;
    priceRetail: string | null;
    barcode: string | null;
    barcodeSource: "GS1" | "INTERNAL" | null;
    imageUrl: string | null;
}

export interface UnitBreakdownEntry {
    unitId: string;
    unitName: string;
    count: DecimalInstance;
}

/**
 * Breaks a base-unit quantity down into the largest possible units first,
 * then the remainder in progressively smaller units.
 *
 * DETERMINISTIC AND ERROR-FREE BY CONSTRUCTION: every call starts from
 * the original `quantityInBaseUnit`, never from the output of a previous
 * conversion. Each level's remainder is computed in Decimal, not via a
 * JS `%` operator.
 *
 * `units` should include every active ProductUnit for the product,
 * including the base unit itself (conversionFactor = "1"). Build this
 * array via toDisplayUnits() below, from rows fetched through
 * lib/data/products.ts.
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
 * The ONLY sanctioned way, anywhere in the codebase, to read a specific
 * ProductUnit's conversionFactor out of the database. Always tenant-scoped.
 *
 * [FIX] tx typed as TenantTransactionClient — see file header.
 *
 * @throws if no ProductUnit with this id exists for this tenant.
 */
export async function getUnitConversionFactor(
    tx: TenantTransactionClient,
    tenantId: string,
    unitId: string
): Promise<DecimalInstance> {
    const unit = await tx.productUnit.findUniqueOrThrow({
        where: { id: unitId, tenantId },
        select: { conversionFactor: true },
    });
    return new Decimal(unit.conversionFactor);
}

/**
 * Reshapes already-fetched ProductUnit rows into the DisplayUnit[] shape
 * breakdownForDisplay() and every route consume.
 *
 * [FIX] priceWholesale/priceRetail now consistently serialized to string
 * as well, matching conversionFactor's own treatment — previously only
 * conversionFactor was serialized, which worked by accident (Decimal's
 * .toJSON()) but was internally inconsistent.
 */
export function toDisplayUnits(units: ProductUnit[]): DisplayUnit[] {
    return units.map((u) => ({
        id: u.id,
        unitName: u.unitName,
        conversionFactor: u.conversionFactor.toString(),
        isActive: u.isActive,
        pricingCurrency: u.pricingCurrency,
        priceWholesale: u.priceWholesale.toString(),
        priceRetail: u.priceRetail !== null ? u.priceRetail.toString() : null,
        barcode: u.barcode,
        barcodeSource: u.barcodeSource,
        imageUrl: u.imageUrl,
    }));
}

export interface OfflineCacheUnit {
    id: string;
    unitName: string;
    conversionFactor: string;
    priceWholesale: string;
    priceRetail: string | null;
    pricingCurrency: "SYP" | "USD";
    barcode: string | null;
    barcodeSource: "GS1" | "INTERNAL" | null;
    isActive: boolean;
}

/**
 * Reshapes already-fetched ProductUnit rows into T1's exact
 * `cachedProducts.units[]` Dexie shape, with every Decimal field
 * pre-serialized to a string.
 *
 * Callers (T4a's refreshProductCache()) fetch ALL units (active and
 * inactive) via lib/data/products.ts's listAllUnitsForProduct() —
 * deliberately not just active ones, since T3a's "Stock on a discontinued
 * unit" badge needs a deactivated unit's own name/id even after it's
 * hidden from POS/storefront pickers.
 */
export function toOfflineCacheUnits(units: ProductUnit[]): OfflineCacheUnit[] {
    return units.map((u) => ({
        id: u.id,
        unitName: u.unitName,
        conversionFactor: u.conversionFactor.toString(),
        priceWholesale: u.priceWholesale.toString(),
        priceRetail: u.priceRetail ? u.priceRetail.toString() : null,
        pricingCurrency: u.pricingCurrency,
        barcode: u.barcode,
        barcodeSource: u.barcodeSource,
        isActive: u.isActive,
    }));
}

/**
 * Convenience guard for the base unit's own row: throws if a
 * conversionFactor other than exactly 1 is ever supplied for what's being
 * treated as a base unit.
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

/**
 * Pure value check, no DB access: is this value the reserved base-unit
 * factor (1)?
 */
export function isReservedBaseUnitFactor(value: Numeric): boolean {
    return new Decimal(value).equals(1);
}

/**
 * Builds the `{ conversionFactor: ... }` fragment of a Prisma `data`
 * object from a plain value, entirely inside this file. Callers must
 * SPREAD this fragment rather than ever writing the literal key
 * `conversionFactor` in their own source.
 */
export function buildConversionFactorField(
    conversionFactor: Numeric
): { conversionFactor: string } {
    return { conversionFactor: new Decimal(conversionFactor).toString() };
}

// ============================================================================
// Creation/edit-time packaging-unit RULE VALIDATION (T3a §0/§1). Not a
// conversion function — performs no arithmetic beyond comparison, writes
// nothing, and operates on plain caller-supplied objects (a form payload
// shape), never a fetched Prisma relation. Lives here purely because it
// must read `.conversionFactor` off each candidate unit to validate it.
// ============================================================================

/**
 * VALIDATION SCOPE NOTE (confirmed business rules — do not weaken without
 * explicit confirmation):
 *   1. At least one unit must be provided.
 *   2. unitName is required (non-empty).
 *   3. conversionFactor must be a positive number. Fractional factors are
 *      explicitly ALLOWED — never restricted to integers.
 *   4. Exactly ONE unit per product must have conversionFactor === 1 —
 *      the base unit.
 *   5. No two units on the same product may share the same
 *      conversionFactor.
 */
export interface PackagingUnit {
    id?: string;
    unitName: string;
    conversionFactor: Numeric;
    priceWholesale?: Numeric;
    priceRetail?: Numeric | null;
    isActive?: boolean;
}

export function validatePackagingUnits(units: PackagingUnit[]): {
    valid: boolean;
    error?: string;
} {
    if (!units || units.length === 0) {
        return { valid: false, error: "يجب تحديد وحدة قياس واحدة على الأقل." };
    }

    const factorsSeen = new Map<string, string>();
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
            if (baseUnitCount > 1) {
                return {
                    valid: false,
                    error: "لا يمكن تحديد أكثر من وحدة أساسية واحدة بمعامل تحويل يساوي 1.",
                };
            }
        }

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