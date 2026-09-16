/**
 * lib/data/products.ts
 *
 * THE ONLY FILE (besides lib/inventory/base-unit.ts and
 * lib/inventory/units.ts, each scoped to their own single sensitive
 * field) PERMITTED TO CALL `tx.product.*` / `tx.productUnit.*` DIRECTLY.
 *
 * Every other route/service (POS, inventory screen, sync engine, B2B
 * approval, CSV import, seed script) imports from HERE instead of
 * touching the Prisma model directly. Enforced by a dedicated ESLint
 * rule (eslint-rules/no-direct-model-access.js) blocking any
 * `.product` / `.productUnit` member access outside this allowlist — CI
 * fails the build on violation, same mechanism as the project's existing
 * `$queryRaw` and nested-write rules.
 *
 * WHY THIS EXISTS: `Product.baseUnitId` and `ProductUnit.conversionFactor`
 * are immutable-after-creation guarantees the schema itself cannot
 * enforce (see UNIT-ARCHITECTURE.md). An ESLint rule matching only
 * `.baseUnitId` / `.conversionFactor` MemberExpression access would miss
 * the exact same fields written via Prisma's object-literal `select`/
 * `data` syntax (`{ baseUnitId: true }`, `data: { baseUnitId: x }`) —
 * those are AST `Property` nodes, not `MemberExpression` nodes, so a
 * naive rule silently lets them through untouched. Restricting access at
 * the MODEL level instead (rather than chasing individual field names
 * through every possible syntax shape) closes that gap structurally:
 * nobody outside this file (and base-unit.ts/units.ts for their one
 * field each) can construct a `select`/`data` object for `product` /
 * `productUnit` at all, so there is no surface left for the field-name
 * loophole to hide in.
 *
 * The `Safe*` types below are a SECOND, independent layer on top of the
 * model-level restriction — a compile-time guarantee, not just a lint
 * warning — so that even a future refactor of this file itself can't
 * accidentally let `baseUnitId` / `conversionFactor` leak into a generic
 * "update anything" helper exported from here.
 */

import Decimal from "decimal.js";
import type { Prisma, Product, ProductUnit } from "@prisma/client";
import { commitBaseUnitLink } from "@/lib/inventory/base-unit";
import { assertIsValidBaseUnitFactor } from "@/lib/inventory/units";

// ----------------------------------------------------------------------------
// Safe types — excess-property checking on object literals typed as these
// catches misuse at COMPILE TIME (e.g. calling updateProduct(tx, id,
// { baseUnitId: 'x' }) below is a TS error), independent of and in
// addition to whatever the ESLint rule catches.
// ----------------------------------------------------------------------------
export type SafeProductCreate = Omit<Prisma.ProductCreateInput, "baseUnit" | "units">;
export type SafeProductUpdate = Omit<Prisma.ProductUpdateInput, "baseUnitId" | "baseUnit">;
export type SafeProductUnitCreate = Omit<Prisma.ProductUnitCreateInput, "product" | "isBaseUnitOf">;
export type SafeProductUnitUpdate = Omit<Prisma.ProductUnitUpdateInput, "conversionFactor" | "isBaseUnitOf">;

// ----------------------------------------------------------------------------
// Plain reads. None of these query shapes filter/select on baseUnitId or
// conversionFactor by name, so they carry no risk of the loophole this
// file exists to close — the restriction that matters is on WRITES and on
// any query that specifically targets those field names, not on the mere
// presence of the field in a full-row read result.
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
 * Creates an additional packaging unit (NOT the base unit) on an
 * already-existing product — e.g. adding "طرد" to a product whose base
 * unit is "قطعة". conversionFactor is required and explicit here because
 * this is a genuinely new unit, not an edit to an existing one — creating
 * a value is allowed; editing it afterward is not (see
 * SafeProductUnitUpdate above, which excludes the field entirely).
 *
 * Deliberately rejects conversionFactor === 1: a factor of exactly 1 is
 * reserved for a product's base unit, created only via
 * createProductWithBaseUnit() below. This is a guard against the easy
 * mistake of accidentally creating a second "base-looking" unit through
 * the wrong code path.
 *
 * @throws {Error} if conversionFactor is exactly 1.
 */
export function createAdditionalUnit(
    tx: Prisma.TransactionClient,
    data: Prisma.ProductUnitCreateInput
): Promise<ProductUnit> {
    if (new Decimal(data.conversionFactor as Decimal.Value).equals(1)) {
        throw new Error(
            "createAdditionalUnit: conversionFactor of exactly 1 is reserved " +
            "for a product's base unit — use createProductWithBaseUnit() if " +
            "this is genuinely the product's first/base unit."
        );
    }
    return tx.productUnit.create({ data });
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
    firstUnitData: Omit<SafeProductUnitCreate, "conversionFactor">
): Promise<{ product: Product; baseUnit: ProductUnit }> {
    const product = await tx.product.create({
        data: {
            ...productData,
            tenant: { connect: { id: tenantId } },
        } as Prisma.ProductCreateInput,
    });

    // Defensive, not load-bearing: the literal "1" below is the only value
    // ever passed here, so this can never actually throw — it exists so a
    // future edit that accidentally parameterizes conversionFactor fails
    // loud immediately rather than silently creating a wrong base unit.
    assertIsValidBaseUnitFactor("1");

    const baseUnit = await tx.productUnit.create({
        data: {
            ...firstUnitData,
            conversionFactor: "1",
            tenant: { connect: { id: tenantId } },
            product: { connect: { id: product.id } },
        } as Prisma.ProductUnitCreateInput,
    });

    await commitBaseUnitLink(tx, product.id, baseUnit.id);

    return { product, baseUnit };
}