/**
 * lib/inventory/base-unit.ts
 *
 * THE ONLY FILE IN THE ENTIRE CODEBASE PERMITTED TO READ
 * `Product.baseUnitId` / `Product.baseUnit` DIRECTLY OFF A PRISMA RESULT.
 *
 * Every other call site — POS checkout, the sync engine (T4c), B2B order
 * approval (T5), CSV import (T3d), stock reconciliation (T3c), the seed
 * script — MUST obtain a product's base unit through `requireBaseUnit()`
 * below. Direct property access on `.baseUnitId` / `.baseUnit` anywhere
 * else is blocked by a dedicated ESLint rule (see eslint-rules/
 * no-direct-base-unit-access.js), enforced the same way as the project's
 * existing `$queryRaw` and nested-write rules — CI fails the build on
 * violation.
 *
 * WHY THIS FILE EXISTS (see UNIT-ARCHITECTURE.md / MASTER-SPEC v4.0):
 * `Product.baseUnitId` is `String? @unique` at the schema level because
 * Prisma has no way to express "non-null after row creation." That is a
 * TYPE-LEVEL HONESTY about what the database can enforce, not a license
 * for application code to treat the field as usually-present and skip the
 * check. In practice, baseUnitId becomes non-null the instant a Product's
 * creation transaction commits (Product.create + base ProductUnit.create +
 * Product.update({ baseUnitId }), all inside one $transaction — see
 * createProductWithBaseUnit() in lib/inventory/product-create.ts) and
 * never changes after that. A null baseUnitId observed anywhere outside
 * that transaction window is a genuine data-integrity bug, not a normal
 * case — so this module fails LOUD (throws) rather than silently
 * returning undefined, defaulting to some arbitrary unit, or letting a
 * caller's TypeScript `!` assertion paper over the gap.
 */

import type { Prisma, PrismaClient, ProductUnit } from "@prisma/client";

export class MissingBaseUnitError extends Error {
    constructor(productId: string) {
        super(
            `Product ${productId} has no baseUnitId (or its baseUnit relation ` +
            `could not be resolved). This should be structurally impossible ` +
            `outside the create-transaction window — treat this as a data ` +
            `integrity bug (e.g. an incomplete/legacy product row, or a ` +
            `crashed creation transaction that somehow left a partial row), ` +
            `never as a null case to silently route around. Do not catch ` +
            `this error and fall back to a default/first unit — surface it, ` +
            `fix the underlying product row, or block the operation.`
        );
        this.name = "MissingBaseUnitError";
    }
}

type TxOrClient = Prisma.TransactionClient | PrismaClient;

/**
 * Resolves and returns a product's base ProductUnit, guaranteed non-null.
 *
 * This is the ONLY sanctioned way to answer "what is this product's base
 * unit?" anywhere in the codebase. Every write path that needs to know
 * which ProductUnit a ProductBatch.unitId must reference, and every
 * conversion that needs a base-unit conversionFactor reference point,
 * calls this function — never reads `.baseUnitId` off a product object
 * it already has in scope, since that object may be stale or may have
 * been fetched without the `baseUnit` relation included.
 *
 * @throws {MissingBaseUnitError} if the product has no baseUnitId, or the
 *   baseUnitId points at a ProductUnit row that no longer resolves (both
 *   should be structurally impossible — see the file-level doc above).
 */
export async function requireBaseUnit(
    tx: TxOrClient,
    tenantId: string,
    productId: string
): Promise<ProductUnit> {
    const product = await tx.product.findUniqueOrThrow({
        where: { id: productId, tenantId },
        include: { baseUnit: true },
    });

    if (!product.baseUnitId || !product.baseUnit) {
        throw new MissingBaseUnitError(productId);
    }

    return product.baseUnit;
}

/**
 * Batch variant of requireBaseUnit(), for call sites resolving base units
 * for multiple products at once (e.g. a POS checkout with several distinct
 * products in the cart, or a CSV import batch). Still goes through one
 * query per product's underlying guarantee — no shortcut that skips the
 * per-product null check.
 *
 * @throws {MissingBaseUnitError} on the first product found missing a
 *   valid base unit — fails the whole batch loud rather than silently
 *   skipping the offending product.
 */
export async function requireBaseUnits(
    tx: TxOrClient,
    tenantId: string,
    productIds: string[]
): Promise<Map<string, ProductUnit>> {
    const products = await tx.product.findMany({
        where: { id: { in: productIds }, tenantId },
        include: { baseUnit: true },
    });

    const result = new Map<string, ProductUnit>();
    for (const product of products) {
        if (!product.baseUnitId || !product.baseUnit) {
            throw new MissingBaseUnitError(product.id);
        }
        result.set(product.id, product.baseUnit);
    }

    // Defensive: findMany silently omits ids that don't exist at all (e.g.
    // a deleted/mistyped productId) rather than throwing — surface that
    // distinctly from "found but missing a base unit," since it's a
    // different bug class (referential integrity, not unit-conversion
    // integrity).
    const foundIds = new Set(result.keys());
    const missingIds = productIds.filter((id) => !foundIds.has(id));
    if (missingIds.length > 0) {
        throw new Error(
            `requireBaseUnits: the following productIds do not exist for ` +
            `tenant ${tenantId}: ${missingIds.join(", ")}`
        );
    }

    return result;
}

/**
 * Asserts that a product is eligible to have its base unit (or its base
 * unit's conversionFactor) changed — i.e. it has zero ProductBatch rows.
 * Per T1's Unit Conversion Architecture, once any batch exists, the base
 * unit choice and its conversionFactor (always 1) are permanently locked.
 * Call this before allowing any admin-facing "fix the base unit" action;
 * do NOT re-implement this check inline at each call site.
 *
 * @throws {Error} if the product already has at least one ProductBatch.
 */
export async function assertBaseUnitMutable(
    tx: TxOrClient,
    tenantId: string,
    productId: string
): Promise<void> {
    const batchCount = await tx.productBatch.count({
        where: { productId, tenantId },
    });

    if (batchCount > 0) {
        throw new Error(
            `Product ${productId} already has ${batchCount} batch(es) — its ` +
            `base unit and that unit's conversionFactor can never be changed ` +
            `once any ProductBatch exists (see T1's Unit Conversion ` +
            `Architecture, Immutability rule). If this is a genuine data-entry ` +
            `correction, it must go through an explicitly logged admin action, ` +
            `never a silent field edit.`
        );
    }
}