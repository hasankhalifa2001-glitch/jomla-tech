/**
 * lib/inventory/base-unit.ts
 *
 * THE ONLY FILE IN THE ENTIRE CODEBASE PERMITTED TO READ *OR WRITE*
 * `Product.baseUnitId` / `Product.baseUnit` / `ProductUnit.isBaseUnitOf`
 * DIRECTLY OFF A PRISMA MODEL, AND ONE OF THE TWO FILES (the other being
 * lib/data/products.ts) PERMITTED TO CALL `tx.product.*` / `tx.productUnit.*`
 * DIRECTLY — see lib/data/products.ts's header for the model-level
 * rationale, and eslint.config.mjs's per-file override block for this file.
 *
 * This file never names `.conversionFactor` as a literal object key or
 * MemberExpression property either — see lib/inventory/units.ts's header.
 * Wherever this file needs to WRITE a conversionFactor value, it spreads
 * units.ts's buildConversionFactorField().
 *
 * [FIX — tx type] Every function below now takes `TenantTransactionClient`
 * (imported from lib/db/tenant-scope.ts, the single place that derives it
 * from getTenantDb()'s real $transaction signature) instead of a
 * hand-defined union or the raw `Prisma.TransactionClient`. See
 * tenant-scope.ts's header for why those are NOT structurally identical
 * in this codebase.
 *
 * [FIX — BaseUnitLockedError] `assertBaseUnitMutable()` previously threw a
 * plain `Error` with a specific message, and callers (the PATCH route)
 * detected it via brittle string-matching (`error.message.includes(...)`).
 * A future wording change to that message would have silently broken the
 * route's friendly-error mapping with no compile-time warning. Replaced
 * with a dedicated `BaseUnitLockedError` class, matching the pattern
 * `MissingBaseUnitError`/`PendingB2BReferenceError` already use — callers
 * now do `error instanceof BaseUnitLockedError`, immune to message wording.
 *
 * [FIX — UnitNotBelongingToProductError wired up] This class was
 * previously defined at the bottom of the file but never actually thrown
 * — `commitBaseUnitLink()` and `updateNonBaseUnitConversionFactor()` both
 * still raised a plain `Error` for the exact "this unit belongs to a
 * different product" situation the class exists to describe, leaving
 * callers with the same brittle string-matching problem
 * `BaseUnitLockedError` was introduced to solve elsewhere in this file.
 * Both call sites now throw `UnitNotBelongingToProductError` instead.
 *
 * [FIX — resetProductUnits() clears barcode/barcodeSource on soft-delete]
 * `ProductUnit` carries `@@unique([tenantId, barcode])` — a DB-level
 * constraint that does NOT distinguish active from inactive rows.
 * Previously, deactivating a product's units here left their `barcode`
 * value in place, which would permanently block any FUTURE unit on this
 * product (including a corrected base unit that legitimately reuses the
 * same physical barcode) from ever using that value again — failing with
 * a raw P2002 the caller has no clean way to explain. Fixed: the
 * soft-delete step now also clears `barcode`/`barcodeSource` to null. A
 * barcode reattached later goes through T3a's confirmation modal fresh,
 * consistent with that flow's existing rule for any changed barcode.
 *
 * ============================================================================
 * [Earlier, still-active fix] `resetProductUnits()` previously called
 * `tx.productUnit.deleteMany(...)` to wipe a zero-batch product's units
 * before creating a fresh base unit. WRONG: `ProductUnit` is never a
 * hard-delete candidate anywhere else in this system, and
 * `B2BOrderRequestItem.unit` is `onDelete: Restrict` for orders in ANY
 * status (not just PENDING_REVIEW). `resetProductUnits()` now
 * SOFT-deletes (`isActive: false`) every existing unit instead — no row
 * is ever removed, so the Restrict FK never enters into it, for orders in
 * any status. `assertNoPendingB2BReferences()` remains a narrower,
 * business-level (not FK-safety) guard.
 * ============================================================================
 */

import type { Product, ProductUnit } from "@prisma/client";
import type { TenantTransactionClient, TxOrClient } from "@/lib/db/tenant-scope";
import {
    buildConversionFactorField,
    BASE_UNIT_CONVERSION_FACTOR,
    isReservedBaseUnitFactor,
    toDisplayUnits,
    type DisplayUnit,
} from "@/lib/inventory/units";

export type { TenantTransactionClient, TxOrClient };

export class MissingBaseUnitError extends Error {
    constructor(productId: string) {
        super(
            `Product ${productId} has no baseUnitId (or its baseUnit relation ` +
            `could not be resolved). This should be structurally impossible ` +
            `outside the create-transaction window — treat this as a data ` +
            `integrity bug, never as a null case to silently route around. ` +
            `Do not catch this error and fall back to a default/first unit — ` +
            `surface it, fix the underlying product row, or block the ` +
            `operation.`
        );
        this.name = "MissingBaseUnitError";
    }
}

/**
 * Thrown by assertBaseUnitMutable() when a product already has at least
 * one ProductBatch — dedicated class replacing the previous plain Error,
 * so callers detect this via `instanceof` instead of matching on message
 * text. See the file-header FIX note.
 */
export class BaseUnitLockedError extends Error {
    constructor(productId: string, batchCount: number) {
        super(
            `Product ${productId} already has ${batchCount} batch(es) — no ` +
            `unit's conversionFactor (base or otherwise) can be changed once ` +
            `any ProductBatch exists (see T1's Unit Conversion Architecture, ` +
            `Immutability rule).`
        );
        this.name = "BaseUnitLockedError";
    }
}

/**
 * Thrown by resetProductUnits() when the product has at least one
 * still-pending (PENDING_REVIEW) B2BOrderRequestItem referencing one of
 * its units. A BUSINESS-level guard, not an FK-safety one — since
 * resetProductUnits() no longer deletes any row, nothing here prevents a
 * database-level error. The reason to still block the reset is UX/data
 * coherence — an admin shouldn't have units change out from under a
 * pending retailer decision. APPROVED/REJECTED orders are exempt.
 */
export class PendingB2BReferenceError extends Error {
    constructor(productId: string, pendingOrderCount: number) {
        super(
            `Product ${productId} has ${pendingOrderCount} pending ` +
            `(PENDING_REVIEW) B2BOrderRequestItem row(s) referencing one of ` +
            `its units. A base-unit reset cannot proceed while a retailer ` +
            `order is still awaiting approval against these units — resolve ` +
            `(approve or reject) every pending order for this product first.`
        );
        this.name = "PendingB2BReferenceError";
    }
}

/**
 * [FIX — now actually thrown] Raised whenever a unitId is confirmed to
 * belong to a DIFFERENT product than the one a caller expected —
 * commitBaseUnitLink()'s cross-wiring guard and
 * updateNonBaseUnitConversionFactor()'s ownership check both throw this
 * instead of a plain Error, so a caller can catch it via `instanceof`
 * rather than matching on message text. Previously defined but unused;
 * see the file-header FIX note.
 */
export class UnitNotBelongingToProductError extends Error {
    constructor(unitId: string, productId: string) {
        super(`ProductUnit ${unitId} does not belong to product ${productId}.`);
        this.name = "UnitNotBelongingToProductError";
    }
}

/**
 * Resolves and returns a product's base ProductUnit, guaranteed non-null.
 *
 * IMPORTANT: returns the BASE unit itself (conversionFactor always 1).
 * NEVER a source of the conversion factor for a sold/ordered unit — that
 * factor always comes from lib/inventory/units.ts's
 * getUnitConversionFactor(), called with the sold/ordered unit's own id.
 *
 * @throws {MissingBaseUnitError}
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
 * Batch variant of requireBaseUnit() for multiple products at once.
 *
 * @throws {MissingBaseUnitError} on the first product missing a valid
 *   base unit.
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

/** A DisplayUnit annotated with whether it's the product's base unit. */
export interface DisplayUnitWithBaseFlag extends DisplayUnit {
    isBaseUnit: boolean;
}

/**
 * The sanctioned bridge for lib/data/products.ts: takes a raw fetched
 * Product-plus-units result and returns the same object with
 * `baseUnitId` stripped and `units` replaced by
 * DisplayUnitWithBaseFlag[] (each unit's `isBaseUnit` precomputed).
 */
export function toSafeProductWithUnits<
    T extends { baseUnitId: string | null; units: ProductUnit[] }
>(product: T): Omit<T, "baseUnitId" | "units"> & { units: DisplayUnitWithBaseFlag[] } {
    const { baseUnitId, units, ...rest } = product;
    const annotatedUnits: DisplayUnitWithBaseFlag[] = toDisplayUnits(units).map((u) => ({
        ...u,
        isBaseUnit: u.id === baseUnitId,
    }));
    return { ...rest, units: annotatedUnits } as Omit<T, "baseUnitId" | "units"> & {
        units: DisplayUnitWithBaseFlag[];
    };
}

/**
 * Asserts a product is eligible to have its base unit, or any of its
 * units' conversionFactor, changed — i.e. it has zero ProductBatch rows.
 *
 * Deliberately pinned to `TenantTransactionClient` — always called from
 * within resetProductUnits() / updateNonBaseUnitConversionFactor(), both
 * of which must themselves run inside a real transaction.
 *
 * @throws {BaseUnitLockedError} if the product already has at least one
 *   ProductBatch.
 */
export async function assertBaseUnitMutable(
    tx: TenantTransactionClient,
    tenantId: string,
    productId: string
): Promise<void> {
    const batchCount = await tx.productBatch.count({
        where: { productId, tenantId },
    });

    if (batchCount > 0) {
        throw new BaseUnitLockedError(productId, batchCount);
    }
}

/**
 * Asserts a product has no still-pending B2BOrderRequestItem rows
 * referencing any of its current units.
 *
 * @throws {PendingB2BReferenceError} if any PENDING_REVIEW
 *   B2BOrderRequestItem references a unit belonging to this product.
 */
export async function assertNoPendingB2BReferences(
    tx: TenantTransactionClient,
    tenantId: string,
    productId: string
): Promise<void> {
    const pendingCount = await tx.b2BOrderRequestItem.count({
        where: {
            tenantId,
            productId,
            orderRequest: { status: "PENDING_REVIEW" },
        },
    });

    if (pendingCount > 0) {
        throw new PendingB2BReferenceError(productId, pendingCount);
    }
}

/**
 * The ONLY sanctioned write of Product.baseUnitId for the ordinary
 * "brand-new product" path. Called exclusively from
 * lib/data/products.ts's createProductWithBaseUnit() and from
 * resetProductUnits() below, as the final top-level call inside their
 * respective transactions.
 *
 * Verifies baseUnitId actually belongs to productId before writing the
 * FK — nothing at the schema level otherwise stops a caller from
 * cross-wiring products.
 *
 * @throws {UnitNotBelongingToProductError} if baseUnitId belongs to a
 *   different product than productId.
 */
export async function commitBaseUnitLink(
    tx: TenantTransactionClient,
    tenantId: string,
    productId: string,
    baseUnitId: string
): Promise<{ id: string; baseUnitId: string | null }> {
    const unit = await tx.productUnit.findUniqueOrThrow({
        where: { id: baseUnitId, tenantId },
        select: { productId: true },
    });
    if (unit.productId !== productId) {
        throw new UnitNotBelongingToProductError(baseUnitId, productId);
    }

    return tx.product.update({
        where: { id: productId, tenantId },
        data: { baseUnitId },
        select: { id: true, baseUnitId: true },
    });
}

/**
 * Replaces a product's designated base unit with a fresh one, for the
 * rare correction case: a zero-batch product whose base unit was chosen
 * wrong at creation.
 *
 * ADMIN-only at the route level (T2b's Role Capability Matrix) — this
 * function itself enforces two preconditions before writing anything:
 *   1. Zero ProductBatch rows (assertBaseUnitMutable).
 *   2. Zero PENDING_REVIEW B2BOrderRequestItem rows referencing any
 *      current unit (assertNoPendingB2BReferences).
 *
 * Writes, in one transaction (per T1's nested-write rule):
 *   1. Deactivates every existing ProductUnit for this product
 *      (isActive: false), also clearing barcode/barcodeSource — see the
 *      file-header FIX note on why the barcode clear is required.
 *   2. Creates the new base ProductUnit (conversionFactor forced to "1").
 *   3. Links it via commitBaseUnitLink().
 *   4. Writes one BaseUnitChangeLog row — never a silent reset.
 *
 * Callers whose product may currently be published (isPublic: true) MUST
 * separately force isPublic to false in the SAME transaction — this
 * function has no opinion on publishing state.
 *
 * This function never accepts a barcode/barcodeSource for the new base
 * unit — a barcode is only ever attached afterward, through the
 * dedicated per-unit edit flow that triggers T3a's confirmation modal,
 * never bundled into a base-unit reset.
 *
 * @throws {BaseUnitLockedError} via assertBaseUnitMutable if the product
 *   already has at least one ProductBatch.
 * @throws {PendingB2BReferenceError} via assertNoPendingB2BReferences.
 * @throws {MissingBaseUnitError} via requireBaseUnit if the product's
 *   *current* base unit cannot be resolved (structurally unexpected).
 */
export async function resetProductUnits(
    tx: TenantTransactionClient,
    params: {
        tenantId: string;
        productId: string;
        newBaseUnit: {
            unitName: string;
            pricingCurrency: "SYP" | "USD";
            priceWholesale: string;
            priceRetail?: string | null;
            imageUrl?: string | null;
        };
        changedByUserId: string;
        reason: string;
    }
): Promise<ProductUnit> {
    await assertBaseUnitMutable(tx, params.tenantId, params.productId);
    await assertNoPendingB2BReferences(tx, params.tenantId, params.productId);

    const oldBaseUnit = await requireBaseUnit(tx, params.tenantId, params.productId);

    // [FIX] Soft-delete AND clear barcode/barcodeSource — see the
    // file-header FIX note. `@@unique([tenantId, barcode])` does not
    // distinguish active from inactive rows, so leaving the old value in
    // place would permanently block any future unit on this product from
    // reusing it.
    await tx.productUnit.updateMany({
        where: { productId: params.productId, tenantId: params.tenantId },
        data: { isActive: false, barcode: null, barcodeSource: null },
    });

    const newBaseUnit = await tx.productUnit.create({
        data: {
            tenantId: params.tenantId,
            productId: params.productId,
            unitName: params.newBaseUnit.unitName,
            ...buildConversionFactorField(BASE_UNIT_CONVERSION_FACTOR),
            pricingCurrency: params.newBaseUnit.pricingCurrency,
            priceWholesale: params.newBaseUnit.priceWholesale,
            priceRetail: params.newBaseUnit.priceRetail ?? null,
            imageUrl: params.newBaseUnit.imageUrl ?? null,
            isActive: true,
        },
    });

    await commitBaseUnitLink(tx, params.tenantId, params.productId, newBaseUnit.id);

    await tx.baseUnitChangeLog.create({
        data: {
            tenantId: params.tenantId,
            productId: params.productId,
            oldBaseUnitId: oldBaseUnit.id,
            newBaseUnitId: newBaseUnit.id,
            changedByUserId: params.changedByUserId,
            reason: params.reason,
        },
    });

    return newBaseUnit;
}

/**
 * Corrects a data-entry mistake on a NON-base unit's conversionFactor —
 * for a product with zero ProductBatch rows only. Deliberately separate
 * from lib/data/products.ts's updateProductUnit(), whose
 * SafeProductUnitUpdate type permanently excludes conversionFactor for
 * every unit.
 *
 * Does NOT need assertNoPendingB2BReferences: this function never
 * deletes or deactivates the unit.
 *
 * Refuses to touch the product's CURRENT base unit — that unit's factor
 * must stay exactly 1 for as long as it IS the base unit; changing which
 * unit is the base goes through resetProductUnits() instead.
 *
 * No BaseUnitChangeLog entry — this never changes Product.baseUnitId.
 *
 * The final write is scoped by BOTH `id` and `tenantId`.
 *
 * @throws {BaseUnitLockedError} via assertBaseUnitMutable if the product
 *   already has at least one ProductBatch.
 * @throws {Error} if unitId is the product's current base unit, or the
 *   new factor equals 1.
 * @throws {UnitNotBelongingToProductError} if unitId belongs to a
 *   different product.
 */
export async function updateNonBaseUnitConversionFactor(
    tx: TenantTransactionClient,
    params: {
        tenantId: string;
        productId: string;
        unitId: string;
        newConversionFactor: string;
    }
): Promise<ProductUnit> {
    await assertBaseUnitMutable(tx, params.tenantId, params.productId);

    const baseUnit = await requireBaseUnit(tx, params.tenantId, params.productId);

    if (params.unitId === baseUnit.id) {
        throw new Error(
            `updateNonBaseUnitConversionFactor: unit ${params.unitId} is this ` +
            `product's current base unit — its factor must stay 1. Use ` +
            `resetProductUnits() to change which unit is the base unit.`
        );
    }

    const unit = await tx.productUnit.findUniqueOrThrow({
        where: { id: params.unitId, tenantId: params.tenantId },
    });
    if (unit.productId !== params.productId) {
        throw new UnitNotBelongingToProductError(params.unitId, params.productId);
    }

    if (isReservedBaseUnitFactor(params.newConversionFactor)) {
        throw new Error(
            `updateNonBaseUnitConversionFactor: a conversionFactor of exactly ` +
            `1 is reserved for the base unit — this would create a duplicate ` +
            `factor-1 unit. Use resetProductUnits() if this unit should ` +
            `actually become the base unit.`
        );
    }

    return tx.productUnit.update({
        where: { id: params.unitId, tenantId: params.tenantId },
        data: buildConversionFactorField(params.newConversionFactor),
    });
}