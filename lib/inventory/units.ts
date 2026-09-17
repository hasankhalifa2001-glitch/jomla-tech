/**
 * lib/inventory/units.ts
 *
 * THE ONLY FILE IN THE ENTIRE CODEBASE PERMITTED TO NAME
 * `ProductUnit.conversionFactor` — as a `select`/`data`/`include` object
 * key, as a `MemberExpression` property, as a destructured binding, or in
 * any arithmetic expression built from it.
 *
 * [FIX — supersedes the "arithmetic-only" restriction] Earlier revisions
 * of this architecture only blocked MULTIPLYING/DIVIDING by
 * `.conversionFactor` outside this file, on the theory that a bare read
 * (e.g. T4c/T5 fetching the sold unit's factor before calling
 * toBaseUnit()) was harmless and had to be allowed elsewhere. Two real
 * gaps followed from that:
 *   1. The relation name leading to the field varies by model —
 *      `InvoiceItem.unit`, `ProductBatch.unit`, `B2BOrderRequestItem.unit`
 *      — never `.productUnit`. A rule written to catch `.product`/
 *      `.productUnit` access (lib/data/products.ts's model-level guard)
 *      never even sees `item.unit.conversionFactor`; it's a different
 *      top-level model (InvoiceItem) with an unrelated relation name.
 *      Chasing every possible relation name by regex is a losing game —
 *      any future model that relates to ProductUnit under yet another
 *      field name reopens the same hole.
 *   2. Even where the arithmetic-only rule DID apply, it only matched a
 *      raw `*`/`/` operator — not decimal.js method calls
 *      (`qty.times(unit.conversionFactor)`), which is the ONLY sanctioned
 *      way to do this arithmetic in this codebase (see toBaseUnit() —
 *      native JS `*`/`/` on money/quantity figures is banned project-
 *      wide). The rule that existed could never fire on the exact
 *      pattern the rest of this architecture requires everyone to use.
 *
 * FIX: stop trying to block specific *usages* of conversionFactor
 * (arithmetic, specific relation paths) and instead block the field NAME
 * itself, full stop, anywhere it appears syntactically outside this file
 * — the same treatment lib/inventory/base-unit.ts already gives
 * `baseUnitId`. This is relation-name-agnostic, and it makes the
 * arithmetic concern moot: nothing outside this file can ever hold a
 * reference to the value in the first place, so there is nothing left to
 * multiply, divide, or call `.times()` on.
 *
 * [FIX #2 — the reads-vs-writes gap this closes] Banning the field name
 * everywhere else means NO OTHER FILE — including lib/data/products.ts,
 * which legitimately fetches full ProductUnit rows for ordinary reads —
 * can shape that data into anything a caller needs that involves
 * conversionFactor: T4a's cachedProducts.units[] payload, and T3c/T3e's
 * DisplayUnit[] input to breakdownForDisplay(). Both conversions are
 * therefore centralized HERE (toOfflineCacheUnits(), toDisplayUnits()
 * below), taking the raw ProductUnit[] rows products.ts already knows how
 * to fetch and reshaping them — the only file allowed to do that reshaping
 * is this one, since only this file may write the literal key
 * `conversionFactor` into the output object.
 *
 * Every caller elsewhere in the codebase (T4b's POS, T4c's sync engine,
 * T5's B2B approval, T3c's reconciliation) that needs a specific unit's
 * conversionFactor now calls getUnitConversionFactor() below — never a
 * direct Prisma `select`/`include` naming the field, never a property
 * read off an already-fetched relation. Enforced by a dedicated
 * `no-restricted-syntax` block in eslint.config.mjs — CI fails the build
 * on violation, same mechanism as the project's existing `$queryRaw` and
 * nested-write rules.
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
 *                       `conversionFactor`. Callers pass the raw
 *                       Prisma rows in; they get back plain objects with
 *                       conversionFactor pre-serialized to a string.
 *
 * [FIX — TypeScript build error, unchanged from prior revision] `Decimal`
 * used as a standalone TYPE name does not resolve under this project's
 * TypeScript/module configuration (Next.js 16 + Turbopack,
 * "moduleResolution": "bundler"). `Decimal` still works fine as a VALUE.
 * Fix: a local `DecimalInstance` type alias derived from `typeof Decimal`.
 * No runtime behavior changes; this is a type-only fix.
 */

import Decimal from "decimal.js";
import type { Prisma, ProductUnit } from "@prisma/client";

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
 * This is the ONLY sanctioned direction for anything that decrements
 * ProductBatch.quantity or writes StockAdjustment.quantityDelta. The
 * `soldUnitConversionFactor` argument MUST come from getUnitConversionFactor()
 * below — resolved server-side, tenant-scoped — never taken as-is from a
 * client request payload. See T4c's and T5's sync/approval notes in
 * MASTER-SPEC v4.0 (corrected) for why: a client-supplied conversionFactor
 * could be tampered with to under/over-deduct stock.
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
    conversionFactor: Numeric;
}

export interface UnitBreakdownEntry {
    unitId: string;
    unitName: string;
    count: DecimalInstance;
}

/**
 * Breaks a base-unit quantity down into the largest possible units first,
 * then the remainder in progressively smaller units — the human-friendly
 * "2 packs and 24 pieces" style display used on the inventory/POS screens.
 *
 * DETERMINISTIC AND ERROR-FREE BY CONSTRUCTION: every call starts from
 * the original `quantityInBaseUnit`, never from the output of a previous
 * conversion. Each level's remainder is computed in Decimal, not via a
 * JS `%` operator.
 *
 * `units` should include every active ProductUnit for the product,
 * including the base unit itself (conversionFactor = "1"). Build this
 * array via toDisplayUnits() below, from rows fetched through
 * lib/data/products.ts — never by mapping a raw Prisma relation object
 * yourself outside this file.
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
 * [FIX] The ONLY sanctioned way, anywhere in the codebase, to read a
 * specific ProductUnit's conversionFactor out of the database. Always
 * tenant-scoped. Callers pass the result straight into toBaseUnit()/
 * fromBaseUnit() — never store, log, or return it as-is in an API
 * response, and never accept a client-supplied value as a substitute for
 * calling this.
 *
 * This is what T4c's sync engine and T5's B2B approval call to fetch the
 * SOLD/ORDERED unit's own factor (via that unit's unitId on
 * InvoiceItem/B2BOrderRequestItem) — never requireBaseUnit()
 * (lib/inventory/base-unit.ts), which resolves an unrelated base-unit row
 * whose factor is always exactly 1 and would apply no conversion at all.
 *
 * @throws if no ProductUnit with this id exists for this tenant.
 */
export async function getUnitConversionFactor(
    tx: Prisma.TransactionClient,
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
 * [NEW — closes the products.ts ↔ breakdownForDisplay integration gap]
 * Reshapes already-fetched ProductUnit rows (e.g. from
 * lib/data/products.ts's listAllUnitsForProduct()/listActiveUnitsForProduct())
 * into the DisplayUnit[] shape breakdownForDisplay() consumes.
 *
 * This is the ONLY sanctioned way to bridge a plain products.ts read into
 * breakdownForDisplay() — a caller must never write
 * `units.map(u => ({ ...u, conversionFactor: u.conversionFactor }))`
 * itself, since that would name the banned field outside this file.
 */
export function toDisplayUnits(units: ProductUnit[]): DisplayUnit[] {
    return units.map((u) => ({
        id: u.id,
        unitName: u.unitName,
        conversionFactor: u.conversionFactor.toString(),
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
 * [NEW — closes the products.ts ↔ T4a offline-cache integration gap]
 * Reshapes already-fetched ProductUnit rows into T1's exact
 * `cachedProducts.units[]` Dexie shape (see MASTER-SPEC T1, Local Offline
 * Database Schema), with every Decimal field pre-serialized to a string
 * — Dexie must never store a native JS number or a raw Decimal instance
 * for a monetary/quantity field.
 *
 * Callers (T4a's refreshProductCache()) fetch the rows via
 * lib/data/products.ts's listAllUnitsForProduct() — deliberately ALL
 * units, not just active ones, since T3a's "Stock on a discontinued
 * unit" badge needs to keep showing a deactivated unit's own name/id
 * even after it's hidden from POS/storefront pickers — and pass them
 * straight into this function. No other file may build this payload
 * itself, since doing so would require naming `conversionFactor`
 * directly.
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
 * treated as a base unit. Call this at the point a base ProductUnit is
 * created (see lib/data/products.ts's createProductWithBaseUnit()) or
 * re-designated (see lib/inventory/base-unit.ts's resetProductUnits()).
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
 * factor (1)? Used by lib/data/products.ts's createAdditionalUnit() to
 * reject an attempt to create a second "factor-1" unit on a product
 * through the wrong code path — without that file ever needing to
 * name/read `.conversionFactor` off a Prisma object itself (it operates
 * on a plain function argument instead).
 */
export function isReservedBaseUnitFactor(value: Numeric): boolean {
    return new Decimal(value).equals(1);
}

/**
 * Builds the `{ conversionFactor: ... }` fragment of a Prisma `data`
 * object from a plain value, entirely inside this file. See
 * lib/data/products.ts's header for why callers must SPREAD this
 * fragment rather than ever writing the literal key `conversionFactor`
 * in their own source.
 */
export function buildConversionFactorField(
    conversionFactor: Numeric
): { conversionFactor: string } {
    return { conversionFactor: new Decimal(conversionFactor).toString() };
}