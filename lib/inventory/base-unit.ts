/**
 * lib/inventory/base-unit.ts
 *
 * THE ONLY FILE IN THE ENTIRE CODEBASE PERMITTED TO READ *OR WRITE*
 * `Product.baseUnitId` / `Product.baseUnit` DIRECTLY OFF A PRISMA MODEL.
 *
 * Every other call site — POS checkout, the sync engine (T4c), B2B order
 * approval (T5), CSV import (T3d), stock reconciliation (T3c), the seed
 * script, and the product-administration routes (T3a) — MUST go through
 * the functions below (via lib/data/products.ts for the writes, or
 * directly for the reads). Direct access to `.baseUnitId` / `.baseUnit`
 * anywhere else is blocked structurally: `lib/data/products.ts` is the
 * only other file allowed to import `tx.product` / `tx.productUnit` at
 * all (see eslint-rules/no-direct-model-access.js — same enforcement
 * mechanism as the project's existing `$queryRaw` and nested-write
 * rules; CI fails the build on violation), and its own `Safe*` update
 * types (Omit<..., "baseUnitId" | "baseUnit">) make it a *compile-time*
 * error for that file to leak the field into any generic write helper it
 * exports. This file is the single place where the raw field is ever
 * named in a `select`/`data`/`include` object anywhere in the codebase.
 *
 * WHY THIS FILE EXISTS (see UNIT-ARCHITECTURE.md / MASTER-SPEC v4.0):
 * `Product.baseUnitId` is `String? @unique` at the schema level because
 * Prisma has no way to express "non-null after row creation." That is a
 * TYPE-LEVEL HONESTY about what the database can enforce, not a license
 * for application code to treat the field as usually-present and skip the
 * check. In practice, baseUnitId becomes non-null the instant a Product's
 * creation transaction commits (Product.create + base ProductUnit.create +
 * commitBaseUnitLink(), all inside one $transaction — see
 * createProductWithBaseUnit() in lib/data/products.ts) and never changes
 * after that, except through the explicitly-logged correctBaseUnit() path
 * below for a zero-batch product. A null baseUnitId observed anywhere
 * outside the create-transaction window is a genuine data-integrity bug,
 * not a normal case — so this module fails LOUD (throws) rather than
 * silently returning undefined, defaulting to some arbitrary unit, or
 * letting a caller's TypeScript `!` assertion paper over the gap.
 *
 * ============================================================================
 * [FIX — TypeScript build error] `requireBaseUnit()` / `requireBaseUnits()` /
 * `assertBaseUnitMutable()` are called from both real transaction contexts
 * (`tx: Prisma.TransactionClient`, e.g. inside T4c's sync commit or T5's
 * B2B approval) AND from `previewFifoAllocation`'s plain, unlocked read
 * path, which uses `getTenantDb(tenantId)` (lib/db/tenant-scope.ts) — a
 * Prisma Client Extension (`client.$extends(...)`) rather than a raw
 * `PrismaClient`. That extended client's TypeScript type is
 * `DynamicClientExtensionThis<...>`, which is NOT structurally assignable
 * to `PrismaClient` (it's missing internal members like `$on` that a bare
 * `PrismaClient` type declares) — even though it exposes the exact same
 * model delegates (`.product.findUniqueOrThrow(...)`, etc.) at runtime.
 * The previous `TxOrClient = Prisma.TransactionClient | PrismaClient`
 * union didn't account for this third shape, so passing `getTenantDb()`'s
 * result here failed to compile (TS2345 / "Property '$on' is missing").
 *
 * FIX: widened the union to also include `ReturnType<typeof getTenantDb>`
 * (imported type-only, so there is no runtime coupling or import-cycle
 * risk — lib/db/tenant-scope.ts does not import from this file). No
 * runtime behavior changes; this is a type-only fix.
 *
 * `commitBaseUnitLink()` and `correctBaseUnit()` below are DELIBERATELY
 * NOT typed against `TxOrClient` — both are write paths that only ever
 * make sense inside a real, mutable transaction (product creation, or an
 * explicit admin correction), never against `getTenantDb()`'s read-only
 * preview client. They take `Prisma.TransactionClient` directly, which
 * also means a caller on the preview/read path gets a compile error if it
 * ever mistakenly tries to call either — the same "wrong shape doesn't
 * compile" guarantee T3b's commitFifoAllocation already relies on.
 * ============================================================================
 */

import type { Prisma, PrismaClient, ProductUnit } from "@prisma/client";
import type { getTenantDb } from "@/lib/db/tenant-scope";
import { assertIsValidBaseUnitFactor } from "@/lib/inventory/units";

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

// [FIX] widened to also accept getTenantDb()'s extended-client shape —
// see the file-header FIX note above. Read-only functions accept this
// wider union; write functions (commitBaseUnitLink, correctBaseUnit)
// deliberately do not — see the note above.
type TxOrClient = Prisma.TransactionClient | PrismaClient | ReturnType<typeof getTenantDb>;

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
 * IMPORTANT: this function returns the BASE unit itself (whose
 * conversionFactor is always 1). It is NEVER a source of the conversion
 * factor for a unit that was actually sold/ordered (e.g. an InvoiceItem
 * or B2BOrderRequestItem's unit, which may be a "pack" or "carton"). That
 * factor must always be fetched separately, directly off the sold/ordered
 * unit's own row — see units.ts's file header and T4c/T5 in MASTER-SPEC
 * v4.0 (corrected) for the write paths this distinction protects.
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
            `correction, it must go through correctBaseUnit() below on a ` +
            `zero-batch product, never a silent field edit.`
        );
    }
}

/**
 * The ONLY sanctioned write of Product.baseUnitId anywhere in the
 * codebase, for the ordinary "brand-new product" path. Called exclusively
 * from lib/data/products.ts's createProductWithBaseUnit(), as the third
 * of three top-level calls inside one $transaction (Product.create →
 * base ProductUnit.create → commitBaseUnitLink) — per T1's nested-write
 * rule, this function issues its own top-level `product.update` call and
 * must never be wrapped inside a nested write of either prior step.
 *
 * Deliberately takes a plain `Prisma.TransactionClient` (not the wider
 * TxOrClient union) — this is a write path and only ever makes sense
 * inside a real transaction, never against a read-only preview client.
 */
export function commitBaseUnitLink(
    tx: Prisma.TransactionClient,
    productId: string,
    baseUnitId: string
): Promise<{ id: string; baseUnitId: string | null }> {
    return tx.product.update({
        where: { id: productId },
        data: { baseUnitId },
        select: { id: true, baseUnitId: true },
    });
}

/**
 * The rare, explicitly-logged correction of a product's base unit — the
 * ONLY other path (besides createProductWithBaseUnit's initial link)
 * ever allowed to change Product.baseUnitId, and only for a product with
 * zero ProductBatch rows (see assertBaseUnitMutable above). Writes
 * exactly one BaseUnitChangeLog row in the same transaction as the field
 * update — never a silent field edit, per T1's Unit Conversion
 * Architecture, Immutability rule.
 *
 * ADMIN-only at the route level (see T2b's Role Capability Matrix) — this
 * function itself does not check role, only the batch-count precondition.
 *
 * @throws {Error} via assertBaseUnitMutable if the product already has
 *   at least one ProductBatch.
 * @throws {MissingBaseUnitError} via requireBaseUnit if the product's
 *   *current* base unit cannot be resolved (should be structurally
 *   impossible — surfaced rather than silently skipped).
 */
export async function correctBaseUnit(
    tx: Prisma.TransactionClient,
    params: {
        tenantId: string;
        productId: string;
        newBaseUnitId: string;
        changedByUserId: string;
        reason: string;
    }
): Promise<void> {
    await assertBaseUnitMutable(tx, params.tenantId, params.productId);

    const currentBaseUnit = await requireBaseUnit(tx, params.tenantId, params.productId);

    const newUnit = await tx.productUnit.findUniqueOrThrow({
        where: { id: params.newBaseUnitId, tenantId: params.tenantId },
    });

    // The newly-designated base unit must itself carry conversionFactor
    // 1 — same rule as the original base unit at product creation. If it
    // doesn't yet (e.g. it was created as an ordinary non-base unit
    // before this correction), that is a separate data-entry problem this
    // function does not silently paper over.
    assertIsValidBaseUnitFactor(newUnit.conversionFactor);

    // Two top-level calls, same $transaction — per T1's nested-write rule.
    await tx.product.update({
        where: { id: params.productId },
        data: { baseUnitId: params.newBaseUnitId },
    });

    await tx.baseUnitChangeLog.create({
        data: {
            tenantId: params.tenantId,
            productId: params.productId,
            oldBaseUnitId: currentBaseUnit.id,
            newBaseUnitId: params.newBaseUnitId,
            changedByUserId: params.changedByUserId,
            reason: params.reason,
        },
    });
}