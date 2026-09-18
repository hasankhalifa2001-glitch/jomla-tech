/**
 * lib/inventory/base-unit.ts
 *
 * THE ONLY FILE IN THE ENTIRE CODEBASE PERMITTED TO READ *OR WRITE*
 * `Product.baseUnitId` / `Product.baseUnit` DIRECTLY OFF A PRISMA MODEL,
 * AND ONE OF THE TWO FILES (the other being lib/data/products.ts itself)
 * PERMITTED TO CALL `tx.product.*` / `tx.productUnit.*` DIRECTLY — see
 * lib/data/products.ts's header for the model-level rationale, and
 * eslint.config.mjs's per-file override block for this file.
 *
 * This file never names `.conversionFactor` as a literal object key or
 * MemberExpression property either — see lib/inventory/units.ts's header
 * for why that field name is now fully centralized there instead of just
 * having its arithmetic uses blocked. Wherever this file needs to WRITE
 * a conversionFactor value, it spreads units.ts's
 * buildConversionFactorField() — it never reads or re-validates the
 * field's value itself; "1" is trusted structurally from the single
 * creation path (see createProductWithBaseUnit()/resetProductUnits()).
 *
 * ============================================================================
 * [NEW — toSafeProductWithUnits()] lib/data/products.ts needs to hand
 * routes a Product+units payload that (a) never carries the raw
 * `baseUnitId` FK, and (b) tells the caller which unit is the base unit
 * without it having to compare against that FK itself. The first attempt
 * at this wrote the stripping/annotating logic (a plain
 * `const { baseUnitId, units, ...rest } = product` destructure) directly
 * inside lib/data/products.ts — which is exactly the `.baseUnitId`
 * destructuring access this file's own ESLint ban exists to catch, and
 * products.ts's per-file override deliberately does NOT lift that ban
 * (it only touches baseUnitId indirectly, via commitBaseUnitLink()). The
 * linter correctly flagged it as a real violation.
 *
 * Fixed by moving the whole operation HERE instead:
 * `toSafeProductWithUnits()` takes whatever raw fetched product+units
 * shape lib/data/products.ts already has (via Prisma's `include: { units:
 * true }`) and returns the same shape with `baseUnitId` removed and
 * `units` replaced by DisplayUnitWithBaseFlag[] — so products.ts calls
 * this function and never has to name `.baseUnitId` in its own source at
 * all, the same posture it already has toward `.conversionFactor` via
 * units.ts's buildConversionFactorField()/isReservedBaseUnitFactor().
 * ============================================================================
 *
 * [FIX — real bug closed] `resetProductUnits()` previously called
 * `tx.productUnit.deleteMany(...)` to wipe a zero-batch product's units
 * before creating a fresh base unit. This was WRONG: `ProductUnit` is
 * never a hard-delete candidate anywhere else in this system (T1's
 * Tenant Lifecycle & Deletion Policy establishes this explicitly, for
 * exactly this Cascade/Restrict collision reason), and
 * `B2BOrderRequestItem.unit` is `onDelete: Restrict` — a relation that
 * does not distinguish PENDING_REVIEW from APPROVED/REJECTED order
 * status. ANY B2BOrderRequestItem row ever created against one of this
 * product's units — regardless of how long ago its order was approved or
 * rejected — would make `deleteMany` fail with a raw Prisma FK-violation
 * error (P2003), not the clean `PendingB2BReferenceError` this file
 * previously implied was the only failure mode.
 *
 * FIX: `resetProductUnits()` now SOFT-deletes — `isActive: false` on
 * every existing unit — exactly like every other unit-retirement path in
 * this codebase (T3a's ProductUnit.isActive flag). No row is ever
 * removed, so the Restrict FK never enters into it at all, for orders in
 * ANY status. `assertNoPendingB2BReferences()` is kept as a narrower,
 * business-level guard (see its own updated doc below) rather than the
 * load-bearing FK-safety check it was mistakenly relied on for before.
 * ============================================================================
 *
 * [FIX 2 — tenant isolation on updateNonBaseUnitConversionFactor's write]
 * The final `tx.productUnit.update()` in that function is scoped by both
 * `{ id: params.unitId, tenantId: params.tenantId }` — the same "belt and
 * suspenders" posture every write in lib/data/products.ts now also takes
 * (its own writes additionally scope by tenantId in the update's own
 * `where`, not just via the earlier ownership check), rather than leaning
 * solely on the earlier ownership check plus the Client Extension.
 *
 * [FIX 3 — TxOrClient exported] Previously module-private. Read-only and
 * single-field-write helpers in lib/data/products.ts
 * (listProductsWithInventoryDetails, findProductWithUnits, updateProduct,
 * updateProductUnit, setProductActive, etc.) are frequently called with
 * the plain tenant-scoped client returned by getTenantDb() directly — NOT
 * wrapped in db.$transaction(...) — since a single read or a single
 * top-level write needs no transaction (e.g. a GET handler, or the
 * DELETE handler's setProductActive(db, tenantId, id, false) call).
 * Those functions were typed to accept only `Prisma.TransactionClient`,
 * which does not structurally match the Client Extension type
 * getTenantDb() returns (different internal generic branding) — this
 * produced a real TypeScript compile error at every such call site:
 * "Argument of type 'DynamicClientExtensionThis<...>' is not assignable
 * to parameter of type 'TransactionClient'."
 *
 * Exporting this union type lets products.ts widen exactly those
 * functions' `tx` parameter to accept either shape — the same pattern
 * requireBaseUnit()/requireBaseUnits() below already used successfully.
 *
 * IMPORTANT — NOT every function should be widened this way. Any
 * function that performs MULTIPLE related writes requiring atomicity
 * (createProductWithBaseUnit in products.ts; resetProductUnits and
 * updateNonBaseUnitConversionFactor here in this file — anything that
 * calls commitBaseUnitLink() or otherwise depends on genuinely running
 * inside one real $transaction) must stay pinned to
 * `Prisma.TransactionClient` deliberately, so a caller is compile-time
 * forced to invoke it via db.$transaction(async (tx) => ...). Widening
 * those would silently remove the atomicity guarantee T1's Unit
 * Conversion Architecture depends on. See products.ts's header for which
 * of its functions were and weren't widened, and why.
 */

import type { Product, ProductUnit } from "@prisma/client";
import type { TxOrClient, TenantTransactionClient } from "@/lib/db/tenant-scope";
// [FIX] TxOrClient/TenantTransactionClient كانت معرّفة هون محلياً
// (Prisma.TransactionClient | PrismaClient | ReturnType<typeof getTenantDb>)
// — دايماً كان تعريف خاطئ لأنه ما بيغطي نوع الـ tx داخل transaction على
// extended client. صار الاستيراد من المصدر الصحيح.
export type { TxOrClient, TenantTransactionClient };

import {
    buildConversionFactorField,
    BASE_UNIT_CONVERSION_FACTOR,
    isReservedBaseUnitFactor,
    toDisplayUnits,
    type DisplayUnit,
} from "@/lib/inventory/units";

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
 * Thrown by resetProductUnits() when the product has at least one
 * still-pending (PENDING_REVIEW) B2BOrderRequestItem referencing one of
 * its units.
 *
 * [FIX — rationale corrected] This is now a BUSINESS-level guard, not an
 * FK-safety one: since resetProductUnits() no longer deletes any row
 * (see the file-header FIX note above), nothing here prevents a
 * database-level error. The reason to still block the reset is UX/data
 * coherence — a retailer's order is awaiting an admin's approve/reject
 * decision against a specific set of units; silently deactivating those
 * units out from under a pending decision would leave the approving
 * admin looking at stale unit info. APPROVED/REJECTED orders are exempt:
 * their items are either already immortalized on a real Invoice (via
 * separate InvoiceItem rows) or carry no ongoing significance.
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
 * [FIX 3 — exported] See the file-header FIX 3 note for the full
 * rationale. Used by lib/data/products.ts to widen its read-only and
 * single-field-write helpers so they can be called with either a real
 * `Prisma.TransactionClient` (inside a db.$transaction(...) block) or
 * the plain tenant-scoped client returned by getTenantDb() (for a
 * standalone read or single top-level write that needs no transaction).
 *
 * Functions requiring multi-write atomicity (createProductWithBaseUnit,
 * resetProductUnits, updateNonBaseUnitConversionFactor) deliberately do
 * NOT use this type — they stay pinned to `Prisma.TransactionClient`.
 */
// export type TxOrClient = TenantTransactionClient | TenantDb | ReturnType<typeof getTenantDb>;

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

/**
 * [NEW] A DisplayUnit annotated with whether it's the product's base
 * unit. Defined HERE (not in units.ts, and not in products.ts) because
 * computing it requires comparing a unit's id against
 * `Product.baseUnitId` — this is the one file allowed to do that
 * comparison. lib/data/products.ts imports and re-exports this type for
 * caller convenience; it never constructs a value of this type itself.
 */
export interface DisplayUnitWithBaseFlag extends DisplayUnit {
    isBaseUnit: boolean;
}

/**
 * [NEW] The sanctioned bridge for lib/data/products.ts: takes a raw
 * fetched Product-plus-units result (from `tx.product.findUnique({
 * include: { units: true } })` or `.findMany(...)` with the same shape)
 * and returns the same object with `baseUnitId` stripped and `units`
 * replaced by DisplayUnitWithBaseFlag[] (each unit's `isBaseUnit`
 * precomputed).
 *
 * This is generic over `T` so it works whether the caller's fetched
 * object carries extra fields beyond the base Product scalars (e.g.
 * `batches` on lib/data/products.ts's inventory-listing query) — those
 * extra fields simply pass through untouched in `rest`.
 *
 * lib/data/products.ts calls this instead of ever destructuring
 * `.baseUnitId` itself — see this file's header note on why that
 * destructuring must not happen anywhere outside this file, even for the
 * good purpose of stripping the field back out before it's returned.
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
 * Once any batch exists, every conversionFactor on the product (base or
 * otherwise) is permanently locked.
 *
 * Deliberately still pinned to `Prisma.TransactionClient` — always
 * called from within resetProductUnits() / updateNonBaseUnitConversionFactor(),
 * both of which must themselves run inside a real $transaction. See the
 * file-header FIX 3 note.
 *
 * @throws {Error} if the product already has at least one ProductBatch.
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
        throw new Error(
            `Product ${productId} already has ${batchCount} batch(es) — no ` +
            `unit's conversionFactor (base or otherwise) can be changed once ` +
            `any ProductBatch exists (see T1's Unit Conversion Architecture, ` +
            `Immutability rule).`
        );
    }
}

/**
 * Asserts a product has no still-pending B2BOrderRequestItem rows
 * referencing any of its current units. See PendingB2BReferenceError's
 * doc above for the corrected (business-level, not FK-safety) rationale
 * for why this check still exists even though resetProductUnits() no
 * longer deletes anything.
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
 * "brand-new product" path. Called exclusively from lib/data/products.ts's
 * createProductWithBaseUnit() and from resetProductUnits() below, as the
 * final top-level call inside their respective $transactions.
 *
 * Verifies baseUnitId actually belongs to productId before writing the
 * FK — Product.baseUnitId is a bare `@unique` FK to ProductUnit.id, not a
 * composite (productId, unitId) constraint, so nothing at the schema
 * level otherwise stops a caller from cross-wiring products. Both of
 * this function's current callers always pass a unit they just created
 * on the exact same productId, so this can never actually throw today —
 * it exists so a future caller (or a copy-paste mistake) fails loud
 * immediately instead of silently corrupting the product's
 * unit-conversion integrity.
 *
 * Deliberately still pinned to `Prisma.TransactionClient` — see the
 * file-header FIX 3 note: this is a link-write that must always happen
 * inside the same $transaction as the ProductUnit.create() it follows.
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
        throw new Error(
            `commitBaseUnitLink: baseUnitId ${baseUnitId} belongs to a ` +
            `different product (${unit.productId}) than ${productId}.`
        );
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
 * [FIX] No longer wipes anything. Every existing ProductUnit for the
 * product is SOFT-deleted (`isActive: false`) — the same retirement
 * mechanism T3a already uses for an ordinary unit deactivation — never a
 * hard `deleteMany`. See the file-header FIX note for why the previous
 * hard-delete version was a real bug (a Restrict FK violation waiting to
 * happen for any product with ANY historical B2B order, not just a
 * pending one).
 *
 * Deliberately still pinned to `Prisma.TransactionClient` (not widened
 * to TxOrClient) — this function performs multiple related writes
 * (deactivate units, create new base unit, commitBaseUnitLink, write
 * BaseUnitChangeLog) that must all commit atomically. See the
 * file-header FIX 3 note.
 *
 * ADMIN-only at the route level (T2b's Role Capability Matrix) — this
 * function itself enforces two preconditions before writing anything:
 *   1. Zero ProductBatch rows (assertBaseUnitMutable).
 *   2. Zero PENDING_REVIEW B2BOrderRequestItem rows referencing any
 *      current unit (assertNoPendingB2BReferences) — a business-level
 *      guard now, not an FK-safety one; see that function's doc.
 *
 * Writes, in one $transaction (per T1's nested-write rule):
 *   1. Deactivates every existing ProductUnit for this product
 *      (isActive: false) — a plain field update, not a delete.
 *   2. Creates the new base ProductUnit (conversionFactor forced to "1"
 *      via units.ts's buildConversionFactorField() — this file never
 *      writes that field name itself).
 *   3. Links it via commitBaseUnitLink().
 *   4. Writes one BaseUnitChangeLog row — never a silent reset.
 *
 * Callers whose product may currently be published (isPublic: true) MUST
 * separately force isPublic to false in the SAME transaction — a freshly
 * created base unit has no priceRetail/imageUrl, so the product would
 * otherwise be left publicly listed while failing T3a's own publishing
 * gate. This function has no opinion on publishing state — that stays a
 * caller responsibility (see app/api/products/[id]/route.ts's PATCH
 * handler).
 *
 * @throws {Error} via assertBaseUnitMutable if the product already has
 *   at least one ProductBatch.
 * @throws {PendingB2BReferenceError} via assertNoPendingB2BReferences if
 *   any PENDING_REVIEW B2B order still references a current unit.
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

    // [FIX 9] Soft-delete AND clear `barcode` (setting it to null) on
    // every deactivated unit. `ProductUnit` carries `@@unique([tenantId,
    // barcode])` — a DB-level constraint that does NOT distinguish
    // active from inactive rows. Leaving the old barcode value in place
    // on a deactivated row would make it permanently unavailable to any
    // future unit on this product (including a corrected base unit that
    // legitimately reuses the same physical barcode), failing with a
    // raw P2002 the caller has no clean way to explain to the merchant.
    // barcodeSource is cleared alongside it for consistency — a barcode
    // reattached later goes through T3a's confirmation modal fresh, per
    // that flow's existing rule for any changed barcode.
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
 * every unit — this function is the single, explicitly-guarded exception
 * for the zero-batch case, reusing assertBaseUnitMutable's precondition.
 *
 * Does NOT need assertNoPendingB2BReferences: this function never
 * deletes or deactivates the unit — a pending B2BOrderRequestItem
 * referencing it is unaffected by a plain field edit.
 *
 * Refuses to touch the product's CURRENT base unit — that unit's factor
 * must stay exactly 1 for as long as it IS the base unit; changing which
 * unit is the base goes through resetProductUnits() instead. This
 * function identifies the base unit purely by id (requireBaseUnit()) and
 * never re-reads its conversionFactor to double-check — that field is
 * structurally guaranteed to be "1" from the moment it was created (see
 * lib/data/products.ts's createProductWithBaseUnit() and this file's own
 * resetProductUnits(), the only two places that ever set it), and this
 * file does not name `.conversionFactor` anywhere in its own source, by
 * design — see the file header.
 *
 * No BaseUnitChangeLog entry — this never changes Product.baseUnitId.
 *
 * Deliberately still pinned to `Prisma.TransactionClient` — the read
 * (assertBaseUnitMutable's re-check) and the write must commit
 * atomically against the same transaction the caller opened. See the
 * file-header FIX 3 note.
 *
 * The final write below is scoped by BOTH `id` and `tenantId` — see the
 * file-header FIX 2 note.
 *
 * @throws {Error} via assertBaseUnitMutable if the product already has
 *   at least one ProductBatch.
 * @throws {Error} if unitId does not belong to productId, is the
 *   product's current base unit, or the new factor equals 1.
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
        throw new Error(
            `updateNonBaseUnitConversionFactor: unit ${params.unitId} belongs ` +
            `to a different product (${unit.productId}) than ${params.productId}.`
        );
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