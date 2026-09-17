/**
 * lib/data/products.ts
 *
 * THE ONLY FILE (besides lib/inventory/base-unit.ts and
 * lib/inventory/units.ts, each scoped to their own single sensitive
 * field) PERMITTED TO CALL `tx.product.*` / `tx.productUnit.*` DIRECTLY.
 *
 * Every other route/service (POS, inventory screen, sync engine, B2B
 * approval, CSV import, seed script) imports from HERE instead of
 * touching the Prisma model directly. Enforced by a dedicated
 * `no-restricted-syntax` rule in eslint.config.mjs
 * (`MemberExpression[property.name=/^(product|productUnit)$/]` and its
 * computed/destructuring siblings) blocking any `.product` /
 * `.productUnit` member access outside this allowlist.
 *
 * WHY THIS EXISTS: `Product.baseUnitId` is a schema-level guarantee the
 * application must still enforce by convention (see
 * lib/inventory/base-unit.ts). Restricting access at the MODEL level
 * (rather than only at the field-name level) closes the loophole where a
 * naive rule targeting only `.baseUnitId` would miss the exact same
 * field written via Prisma's object-literal `select`/`data` syntax
 * (`{ baseUnitId: true }`) — those are AST `Property` nodes, not
 * `MemberExpression` nodes.
 *
 * [FIX — this file never names `.conversionFactor` either] The same
 * loophole applies to `ProductUnit.conversionFactor`. Every write of
 * that field below goes through units.ts's buildConversionFactorField()
 * and is spread into the data object rather than written as a literal
 * key; every check of whether a value equals the reserved base-unit
 * factor goes through units.ts's isReservedBaseUnitFactor() on a plain
 * function argument, never by reading `.conversionFactor` off a
 * Prisma-typed object in this file's own source.
 *
 * [NOTE — this file never SHAPES conversionFactor-bearing output either]
 * listActiveUnitsForProduct()/listAllUnitsForProduct() below return raw
 * ProductUnit rows, which structurally still carry a `conversionFactor`
 * column (there's no `select` narrowing it out — narrowing it out would
 * itself require naming the field, the exact thing this file avoids).
 * That's fine for a caller that only reads non-restricted fields
 * (unitName, priceWholesale, barcode...) directly off the result. A
 * caller that needs conversionFactor-bearing output in a specific shape
 * (T4a's offline cache payload, T3c/T3e's breakdownForDisplay() input)
 * must pass these raw rows into lib/inventory/units.ts's
 * toOfflineCacheUnits()/toDisplayUnits() — never reshape them here or in
 * the calling route itself, since either would require naming
 * `conversionFactor` outside units.ts.
 *
 * The `Safe*` types below are a SECOND, independent layer on top of both
 * restrictions above — a compile-time guarantee, not just a lint
 * warning — so that even a future refactor of this file itself can't
 * accidentally let `baseUnitId` / `conversionFactor` leak into a generic
 * "update anything" helper exported from here.
 */

import type { Prisma, Product, ProductUnit } from "@prisma/client";
import { commitBaseUnitLink } from "@/lib/inventory/base-unit";
import {
    buildConversionFactorField,
    isReservedBaseUnitFactor,
    BASE_UNIT_CONVERSION_FACTOR,
} from "@/lib/inventory/units";

// ----------------------------------------------------------------------------
// Safe types — excess-property checking on object literals typed as these
// catches misuse at COMPILE TIME (e.g. calling updateProduct(tx, id,
// { baseUnitId: 'x' }) below is a TS error), independent of and in
// addition to whatever the ESLint rule catches. Both sensitive fields are
// excluded from every input type this file exports, not just the ones
// that "obviously" needed it.
// ----------------------------------------------------------------------------
export type SafeProductCreate = Omit<Prisma.ProductCreateInput, "baseUnit" | "units">;
export type SafeProductUpdate = Omit<Prisma.ProductUpdateInput, "baseUnitId" | "baseUnit">;
export type SafeProductUnitCreate = Omit<
    Prisma.ProductUnitCreateInput,
    "product" | "isBaseUnitOf" | "conversionFactor"
>;
export type SafeProductUnitUpdate = Omit<
    Prisma.ProductUnitUpdateInput,
    "conversionFactor" | "isBaseUnitOf"
>;

// ----------------------------------------------------------------------------
// Plain reads. None of these query shapes filter/select on baseUnitId or
// conversionFactor by name, so they carry no risk of the loophole this
// file exists to close — the restriction that matters is on WRITES and on
// any query that specifically targets those field names, not on the mere
// presence of the field in a full-row read result. See the file header
// note above for what a CALLER of these must do if it needs
// conversionFactor-bearing output in a specific shape.
// ----------------------------------------------------------------------------
export function findProductById(
    tx: Prisma.TransactionClient,
    tenantId: string,
    productId: string
): Promise<Product | null> {
    return tx.product.findUnique({ where: { id: productId, tenantId } });
}

export function listActiveProducts(
    tx: Prisma.TransactionClient,
    tenantId: string
): Promise<Product[]> {
    return tx.product.findMany({ where: { tenantId, isActive: true } });
}

export function findProductUnitById(
    tx: Prisma.TransactionClient,
    tenantId: string,
    unitId: string
): Promise<ProductUnit | null> {
    return tx.productUnit.findUnique({ where: { id: unitId, tenantId } });
}

export function listActiveUnitsForProduct(
    tx: Prisma.TransactionClient,
    tenantId: string,
    productId: string
): Promise<ProductUnit[]> {
    return tx.productUnit.findMany({
        where: { tenantId, productId, isActive: true },
    });
}

/**
 * [NEW] Every unit for a product, active AND inactive — deliberately
 * unfiltered by isActive. Two real consumers need this, not
 * listActiveUnitsForProduct():
 *   1. T4a's refreshProductCache(): the offline cachedProducts.units[]
 *      shape carries its own `isActive` field per unit (see T1's Local
 *      Offline Database Schema) specifically so a deactivated unit can
 *      still be recognized offline — e.g. T3a's "Stock on a discontinued
 *      unit" (مخزون على وحدة متوقفة) badge needs the unit's own name/id
 *      even after POS/storefront pickers hide it.
 *   2. T3c's inventory screen, for the same "discontinued unit" display
 *      and for breakdownForDisplay() to correctly resolve a batch's
 *      remaining quantity into any unit that legitimately still has a
 *      positive remainder recorded against it, even a retired one.
 * Pass the result into lib/inventory/units.ts's toOfflineCacheUnits() or
 * toDisplayUnits() — never map conversionFactor out of it yourself here
 * or in a calling route.
 */
export function listAllUnitsForProduct(
    tx: Prisma.TransactionClient,
    tenantId: string,
    productId: string
): Promise<ProductUnit[]> {
    return tx.productUnit.findMany({
        where: { tenantId, productId },
    });
}

// ----------------------------------------------------------------------------
// Safe writes — every ordinary field (name, category, isActive, isPublic,
// pricing, barcode, imageUrl...) goes through these. baseUnitId and
// conversionFactor are structurally absent from their input types, so
// passing either is a compile error here, not a runtime check.
// ----------------------------------------------------------------------------
export function updateProduct(
    tx: Prisma.TransactionClient,
    productId: string,
    data: SafeProductUpdate
): Promise<Product> {
    return tx.product.update({ where: { id: productId }, data });
}

export function updateProductUnit(
    tx: Prisma.TransactionClient,
    unitId: string,
    data: SafeProductUnitUpdate
): Promise<ProductUnit> {
    return tx.productUnit.update({ where: { id: unitId }, data });
}

/**
 * Product deactivation/reactivation — the ONLY field this touches is
 * isActive, deliberately separate from updateProduct() so a caller can
 * never accidentally bundle an isActive toggle with an isPublic change in
 * the same call.
 */
export function setProductActive(
    tx: Prisma.TransactionClient,
    productId: string,
    isActive: boolean
): Promise<Product> {
    return tx.product.update({ where: { id: productId }, data: { isActive } });
}

/**
 * Creates an additional packaging unit (NOT the base unit) on an
 * already-existing product — e.g. adding "طرد" to a product whose base
 * unit is "قطعة". `conversionFactor` is a required, explicit, PLAIN
 * argument here — never embedded inside `data` — precisely so this
 * file's own source never contains the literal object key
 * `conversionFactor` (see the file-header FIX note). The value is
 * validated via units.ts's isReservedBaseUnitFactor(), also on the plain
 * argument, then merged into the write via
 * units.ts's buildConversionFactorField().
 *
 * @throws {Error} if conversionFactor equals the reserved base-unit
 *   value (1) — that value is reserved for createProductWithBaseUnit()
 *   below.
 */
export function createAdditionalUnit(
    tx: Prisma.TransactionClient,
    conversionFactor: string,
    data: SafeProductUnitCreate
): Promise<ProductUnit> {
    if (isReservedBaseUnitFactor(conversionFactor)) {
        throw new Error(
            "createAdditionalUnit: conversionFactor of exactly 1 is reserved " +
            "for a product's base unit — use createProductWithBaseUnit() if " +
            "this is genuinely the product's first/base unit."
        );
    }
    return tx.productUnit.create({
        data: { ...data, ...buildConversionFactorField(conversionFactor) } as Prisma.ProductUnitCreateInput,
    });
}

/**
 * Creates a brand-new product together with its first packaging unit,
 * which automatically becomes the product's base unit (conversionFactor
 * forced to "1", non-editable afterward — see T3a's Section 0 in
 * MASTER-SPEC v4.0). Three top-level Prisma calls, per T1's nested-write
 * rule — Product.create → base ProductUnit.create →
 * commitBaseUnitLink() — all issued inside the single `tx` the caller
 * passes in, so a crash between any two leaves no orphaned Product row
 * (the whole transaction rolls back).
 *
 * This is the ONLY sanctioned way to create a new Product in the entire
 * codebase — there is no separate "create bare product, add base unit
 * later" path, since a Product without a resolvable base unit is not a
 * valid state outside this function's own transaction window (see
 * requireBaseUnit()'s MissingBaseUnitError in base-unit.ts).
 */
export async function createProductWithBaseUnit(
    tx: Prisma.TransactionClient,
    tenantId: string,
    productData: SafeProductCreate,
    firstUnitData: SafeProductUnitCreate
): Promise<{ product: Product; baseUnit: ProductUnit }> {
    const product = await tx.product.create({
        data: {
            ...productData,
            tenant: { connect: { id: tenantId } },
        } as Prisma.ProductCreateInput,
    });

    const baseUnit = await tx.productUnit.create({
        data: {
            ...firstUnitData,
            ...buildConversionFactorField(BASE_UNIT_CONVERSION_FACTOR),
            tenant: { connect: { id: tenantId } },
            product: { connect: { id: product.id } },
        } as Prisma.ProductUnitCreateInput,
    });

    await commitBaseUnitLink(tx, tenantId, product.id, baseUnit.id);

    return { product, baseUnit };
}