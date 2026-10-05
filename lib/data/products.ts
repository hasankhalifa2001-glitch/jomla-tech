/**
 * lib/data/products.ts
 *
 * THE ONLY FILE (besides lib/inventory/base-unit.ts and
 * lib/inventory/units.ts, each scoped to their own single sensitive
 * field) PERMITTED TO CALL `tx.product.*` / `tx.productUnit.*` DIRECTLY.
 *
 * Every other route/service imports from HERE instead of touching the
 * Prisma model directly. Enforced by a dedicated `no-restricted-syntax`
 * rule in eslint.config.mjs.
 *
 * [v4.5] This file is ALSO now the sole sanctioned caller of
 * `tx.productUnitBarcode.*` — the same ESLint rule that restricts
 * `tx.product.*`/`tx.productUnit.*` to this file is extended to cover
 * `tx.productUnitBarcode.*` too. ProductUnit.barcode/barcodeSource no
 * longer exist as scalar fields; every barcode read/write goes through
 * the ProductUnitBarcode model instead (zero, one, or many rows per
 * unit — see schema.prisma's [v4.5] note). Every function below that
 * used to read/write those scalars directly is updated accordingly.
 *
 * [FIX — tx types] Every function below now takes `TenantTransactionClient`
 * or `TxOrClient` imported from lib/inventory/base-unit.ts (itself
 * re-exporting them from lib/db/tenant-scope.ts, the single source of
 * truth) instead of `Prisma.TransactionClient`. `createProductWithBaseUnit()`
 * stays pinned to `TenantTransactionClient` since it performs multiple
 * related writes that must commit atomically.
 *
 * [FIX — createProductWithBaseUnit() return field names] Renamed to
 * `{ createdProduct, createdBaseUnit }` (was `{ product, baseUnit }`) so
 * ordinary destructuring of this sanctioned return value no longer trips
 * eslint.config.mjs's PRODUCT_MODEL_RULES ObjectPattern selector, which
 * matches on the destructured KEY NAME alone.
 *
 * [FIX — adjustedByUser leaked full User row, including passwordHash]
 * listProductsWithInventoryDetails()'s batch-adjustments query now
 * `select`-narrows adjustedByUser to { name, email } — previously an
 * unfiltered `adjustedByUser: true` fetched (and could leak) every
 * stock-adjuster's passwordHash.
 *
 * [FIX — findProductUnitByBarcodeExcludingProduct() over-fetched]
 * Narrowed to a dedicated ProductUnitBarcodeCollision shape (id,
 * unitName, productId only) — previously returned the full raw
 * ProductUnit row (conversionFactor included) to a route whose ESLint
 * override assumes it can never hold that field.
 *
 * [v4.5] Both barcode-lookup functions are additionally rewritten to
 * query `tx.productUnitBarcode` (joined to its parent unit/product)
 * instead of `tx.productUnit` directly, since the barcode columns moved
 * off that model entirely.
 *
 * [FIX — createAdditionalUnit() now writes tenantId explicitly] See the
 * inline comment at that function below: this function's `tx` parameter
 * is the wide `TxOrClient`, which includes the RAW, unextended
 * `Prisma.TransactionClient` (per tenant-scope.ts's own TxOrClient
 * union). A `create` operation has no `where` to scope against — the
 * ONLY way tenantId ends up on the row is either the Client Extension's
 * auto-injection (which requires a real getTenantDb()-derived client) or
 * writing it explicitly. Previously this function relied solely on
 * auto-injection while accepting a client type that doesn't guarantee
 * that injection happens — a real gap, inconsistent with this file's own
 * belt-and-suspenders posture on every UPDATE below (each of which scopes
 * tenantId via its own `where`, not the extension alone). Fixed by
 * writing `tenantId` explicitly in the `data` object, closing the gap
 * regardless of which client shape is actually passed in.
 */

import type { Prisma, Product, ProductUnit, ProductUnitBarcode } from "@prisma/client";
import {
    commitBaseUnitLink,
    toSafeProductWithUnits,
    type DisplayUnitWithBaseFlag,
    type TxOrClient,
    type TenantTransactionClient,
} from "@/lib/inventory/base-unit";
import {
    buildConversionFactorField,
    getUnitConversionFactor,
    isReservedBaseUnitFactor,
    BASE_UNIT_CONVERSION_FACTOR,
    type DisplayUnit,
    toDisplayUnits,
} from "@/lib/inventory/units";

export type { DisplayUnitWithBaseFlag };

// ----------------------------------------------------------------------------
// Safe types — excess-property checking on object literals typed as these
// catches misuse at COMPILE TIME, independent of and in addition to
// whatever the ESLint rule catches.
// ----------------------------------------------------------------------------
export type SafeProductCreate = Omit<Prisma.ProductCreateInput, "baseUnit" | "units" | "tenant">;
export type SafeProductUpdate = Omit<Prisma.ProductUpdateInput, "baseUnitId" | "baseUnit">;
export type SafeProductUnitCreate = Omit<
    Prisma.ProductUnitCreateInput,
    "product" | "isBaseUnitOf" | "conversionFactor" | "tenant" | "barcodes"
>;
export type SafeProductUnitUpdate = Omit<
    Prisma.ProductUnitUpdateInput,
    "conversionFactor" | "isBaseUnitOf" | "barcodes"
>;

// [v4.5] Safe type for writing a single ProductUnitBarcode row —
// `unit`/`tenant` relations excluded (this file writes `unitId`/`tenantId`
// as plain scalars instead, matching createAdditionalUnit()'s existing
// belt-and-suspenders posture below).
export type SafeProductUnitBarcodeCreate = Omit<
    Prisma.ProductUnitBarcodeCreateInput,
    "unit" | "tenant"
>;

// ----------------------------------------------------------------------------
// Plain reads. `tx` widened to TxOrClient — pure reads, always safe with
// either a real transaction client or the plain tenant-scoped client.
// ----------------------------------------------------------------------------
export function findProductById(
    tx: TxOrClient,
    tenantId: string,
    productId: string
): Promise<Product | null> {
    return tx.product.findUnique({ where: { id: productId, tenantId } });
}

export function listActiveProducts(
    tx: TxOrClient,
    tenantId: string
): Promise<Product[]> {
    return tx.product.findMany({ where: { tenantId, isActive: true } });
}

/**
 * Returns a full raw ProductUnit row (conversionFactor included). Safe
 * to call from lib/inventory/base-unit.ts and other internal, sanctioned
 * callers that are themselves exempt from the conversionFactor ban.
 * Do NOT call this from a route file whose ESLint override assumes it
 * can never hold a raw ProductUnit relation.
 *
 * [v4.5] NOTE — this does NOT eagerly include `barcodes`. A caller that
 * needs a unit's barcode list must call listBarcodesForUnit() below
 * separately, or use findProductWithUnits()/toSafeProductWithUnits()'s
 * already-reshaped output, which does include them.
 */
export function findProductUnitById(
    tx: TxOrClient,
    tenantId: string,
    unitId: string
): Promise<ProductUnit | null> {
    return tx.productUnit.findUnique({ where: { id: unitId, tenantId } });
}

export function listActiveUnitsForProduct(
    tx: TxOrClient,
    tenantId: string,
    productId: string
): Promise<ProductUnit[]> {
    return tx.productUnit.findMany({
        where: { tenantId, productId, isActive: true },
    });
}

/**
 * Every unit for a product, active AND inactive — used by T4a's
 * refreshProductCache() and T3c's "Stock on a discontinued unit" display.
 * Pass the result into lib/inventory/units.ts's toOfflineCacheUnits() or
 * toDisplayUnits() — never map conversionFactor out of it yourself.
 */
export function listAllUnitsForProduct(
    tx: TxOrClient,
    tenantId: string,
    productId: string
): Promise<ProductUnit[]> {
    return tx.productUnit.findMany({
        where: { tenantId, productId },
    });
}

// ----------------------------------------------------------------------------
// [v4.5] ProductUnitBarcode reads/writes — the sanctioned gateway for the
// model that replaced ProductUnit.barcode/barcodeSource. Every barcode
// scalar operation in the codebase goes through these functions; nothing
// outside this file (and the ESLint-exempted internals it re-exports
// from) calls tx.productUnitBarcode.* directly.
// ----------------------------------------------------------------------------

export interface BarcodeView {
    id: string;
    barcode: string;
    barcodeSource: string | null;
    createdAt: Date;
}

/**
 * Every barcode row attached to one unit, oldest first (creation order),
 * for display on the product-edit screen.
 */
export function listBarcodesForUnit(
    tx: TxOrClient,
    tenantId: string,
    unitId: string
): Promise<BarcodeView[]> {
    return tx.productUnitBarcode.findMany({
        where: { tenantId, unitId },
        select: { id: true, barcode: true, barcodeSource: true, createdAt: true },
        orderBy: { createdAt: "asc" },
    });
}

/**
 * Creates a single ProductUnitBarcode row. `tenantId`/`unitId` are
 * written as explicit plain scalars (same belt-and-suspenders reasoning
 * as createAdditionalUnit() below) rather than relying solely on the
 * Client Extension's auto-injection, since `tx` here is the wide
 * `TxOrClient`.
 *
 * Does NOT check for cross-tenant barcode collisions itself — the
 * caller (the products route) is responsible for running that check via
 * findProductUnitByBarcode()/findProductUnitByBarcodeExcludingProduct()
 * BEFORE calling this, so a clean, specific error message can be
 * returned instead of a raw P2002. The DB-level `@@unique([tenantId,
 * barcode])` constraint remains the final backstop for a genuine race.
 */
export async function createUnitBarcode(
    tx: TxOrClient,
    tenantId: string,
    unitId: string,
    data: SafeProductUnitBarcodeCreate
): Promise<ProductUnitBarcode> {
    await assertProductUnitBelongsToTenant(tx, tenantId, unitId);
    return tx.productUnitBarcode.create({
        data: {
            ...data,
            tenantId,
            unitId,
        } as Prisma.ProductUnitBarcodeUncheckedCreateInput,
    });
}

/**
 * Hard-deletes a single barcode row belonging to `unitId`. ADMIN-only at the
 * route layer (see T2b's Role Capability Matrix) — this function itself only
 * enforces tenant ownership, not role.
 *
 * Safe to hard-delete (unlike Product/ProductUnit's soft-delete-only
 * policy): InvoiceItem/B2BOrderRequestItem key off unitId, never off a
 * barcode row, so removing one can never orphan a financial record — see
 * schema.prisma's [v4.5] note.
 *
 * [v4.5] Takes `unitId` as well as `barcodeId` on purpose: tenant ownership
 * alone would let a caller delete a barcode belonging to ANY of the tenant's
 * units (including a different product's), simply by knowing/guessing a row
 * id. The route is
 * `app/api/inventory/products/[id]/units/[unitId]/barcodes/[barcodeId]`,
 * so the unit the caller believes they are editing is verified here, not
 * merely assumed.
 */
export async function deleteUnitBarcode(
    tx: TxOrClient,
    tenantId: string,
    unitId: string,
    barcodeId: string
): Promise<void> {
    const row = await tx.productUnitBarcode.findUniqueOrThrow({
        where: { id: barcodeId },
        select: { tenantId: true, unitId: true },
    });
    if (row.tenantId !== tenantId) {
        throw new Error(
            `ProductUnitBarcode ${barcodeId} does not belong to tenant ${tenantId}.`
        );
    }
    if (row.unitId !== unitId) {
        throw new Error(
            `ProductUnitBarcode ${barcodeId} belongs to unit ${row.unitId}, not ${unitId}.`
        );
    }
    await tx.productUnitBarcode.delete({ where: { id: barcodeId, tenantId } });
}

// ----------------------------------------------------------------------------
// [v4.5] Shared-catalog gateways — ProductCatalogEntry / ProductCatalogEntryBarcode.
//
// The old design keyed the shared catalog on a single unique barcode, so a
// product entered with N barcodes produced N near-duplicate catalog rows. The
// new design keeps ONE ProductCatalogEntry per real product and links every
// known barcode to it through ProductCatalogEntryBarcode (platform-wide
// unique), which is why matching any of a product's barcodes resolves to the
// same suggested name/category/photo.
//
// These live here, not in the routes, because ProductCatalogEntryBarcode is
// confined to this file (see eslint.config.mjs's
// PRODUCT_CATALOG_ENTRY_BARCODE_MODEL_RULES) — the inventory routes call the
// functions below.
// ----------------------------------------------------------------------------

/**
 * "Is this barcode already known to the platform?" — one indexed hit on
 * ProductCatalogEntryBarcode.barcode. Returns the OWNING entry's id, or null.
 */
export function findCatalogEntryIdByBarcode(
    tx: TxOrClient,
    barcode: string
): Promise<string | null> {
    return tx.productCatalogEntryBarcode
        .findUnique({ where: { barcode }, select: { catalogEntryId: true } })
        .then((row) => row?.catalogEntryId ?? null);
}

/**
 * Creates a brand-new shared-catalog entry AND its first barcode row, as two
 * top-level calls inside the caller's transaction (T1's nested-write rule —
 * never `barcodes: { create: ... }`). Returns the new entry's id.
 *
 * On a genuine concurrent race the SECOND insert raises P2002, which is
 * deliberately NOT swallowed here: PostgreSQL aborts the whole transaction on
 * a failed statement, so a local try/catch could not meaningfully continue —
 * the caller's outer P2002 handler turns it into a clean, truthful error, and
 * the transaction rollback means no orphaned entry row is left behind.
 */
export async function createCatalogEntryWithFirstBarcode(
    tx: TxOrClient,
    params: {
        barcode: string;
        name: string;
        category: string | null;
        imageUrl: string | null;
        addedByTenantId: string;
    }
): Promise<string> {
    const entry = await tx.productCatalogEntry.create({
        data: {
            name: params.name,
            category: params.category,
            imageUrl: params.imageUrl,
            addedByTenantId: params.addedByTenantId,
        },
        select: { id: true },
    });

    await tx.productCatalogEntryBarcode.create({
        data: { catalogEntryId: entry.id, barcode: params.barcode },
    });

    return entry.id;
}

/**
 * Links ONE additional barcode to an entry that is already known to exist
 * (either already in the platform's catalog, or created earlier in the SAME
 * request by createCatalogEntryWithFirstBarcode()).
 */
export async function linkBarcodeToCatalogEntry(
    tx: TxOrClient,
    catalogEntryId: string,
    barcode: string
): Promise<void> {
    await tx.productCatalogEntryBarcode.create({
        data: { catalogEntryId, barcode },
    });
}

/**
 * Resolves ONE barcode to its shared-catalog entry, creating the entry when
 * this is genuinely the first time the platform has seen the barcode.
 *
 * `preferEntryId` is the request-scoped continuity rule (T3a §6, v4.5): the
 * entry id this SAME request already resolved for another barcode of the same
 * product. It is used ONLY for a barcode the platform has never seen —
 *   * barcode #1 already known      -> resolves to ITS OWN existing entry
 *   * barcode #3 new, #1 resolved   -> LINKS to #1's entry (never a third entry)
 *   * barcode #1 new                -> creates the one entry every later new
 *                                      barcode of this request links to
 * A barcode that is already known is never re-pointed at a different entry,
 * and no duplicate ProductCatalogEntry is ever created for a known barcode.
 *
 * The caller threads continuity itself:
 *   let entryId: string | null = null;
 *   for (const b of gs1Barcodes) {
 *     entryId = await resolveSharedCatalogForBarcode(tx, { ...b, preferEntryId: entryId });
 *   }
 */
export async function resolveSharedCatalogForBarcode(
    tx: TxOrClient,
    params: {
        barcode: string;
        name: string;
        category: string | null;
        imageUrl: string | null;
        addedByTenantId: string;
        preferEntryId: string | null;
    }
): Promise<string> {
    const existingEntryId = await findCatalogEntryIdByBarcode(tx, params.barcode);
    if (existingEntryId) return existingEntryId;

    if (params.preferEntryId) {
        await linkBarcodeToCatalogEntry(tx, params.preferEntryId, params.barcode);
        return params.preferEntryId;
    }

    return createCatalogEntryWithFirstBarcode(tx, {
        barcode: params.barcode,
        name: params.name,
        category: params.category,
        imageUrl: params.imageUrl,
        addedByTenantId: params.addedByTenantId,
    });
}

// ----------------------------------------------------------------------------
// Safe writes — every write below verifies row ownership before writing,
// AND the write's own `where` is additionally scoped by `tenantId`
// directly (belt-and-suspenders, not relying on the pre-check alone or
// on the Client Extension having scoped it upstream).
// ----------------------------------------------------------------------------

async function assertProductBelongsToTenant(
    tx: TxOrClient,
    tenantId: string,
    productId: string
): Promise<void> {
    const row = await tx.product.findUniqueOrThrow({
        where: { id: productId },
        select: { tenantId: true },
    });
    if (row.tenantId !== tenantId) {
        throw new Error(
            `Product ${productId} does not belong to tenant ${tenantId}.`
        );
    }
}

async function assertProductUnitBelongsToTenant(
    tx: TxOrClient,
    tenantId: string,
    unitId: string
): Promise<void> {
    const row = await tx.productUnit.findUniqueOrThrow({
        where: { id: unitId },
        select: { tenantId: true },
    });
    if (row.tenantId !== tenantId) {
        throw new Error(
            `ProductUnit ${unitId} does not belong to tenant ${tenantId}.`
        );
    }
}

export async function updateProduct(
    tx: TxOrClient,
    tenantId: string,
    productId: string,
    data: SafeProductUpdate
): Promise<Product> {
    await assertProductBelongsToTenant(tx, tenantId, productId);
    return tx.product.update({ where: { id: productId, tenantId }, data });
}

export async function updateProductUnit(
    tx: TxOrClient,
    tenantId: string,
    unitId: string,
    data: SafeProductUnitUpdate
): Promise<ProductUnit> {
    await assertProductUnitBelongsToTenant(tx, tenantId, unitId);
    return tx.productUnit.update({ where: { id: unitId, tenantId }, data });
}

/**
 * Product deactivation/reactivation — the ONLY field this touches is
 * isActive, deliberately separate from updateProduct().
 */
export async function setProductActive(
    tx: TxOrClient,
    tenantId: string,
    productId: string,
    isActive: boolean
): Promise<Product> {
    await assertProductBelongsToTenant(tx, tenantId, productId);
    return tx.product.update({ where: { id: productId, tenantId }, data: { isActive } });
}

/**
 * Creates an additional packaging unit (NOT the base unit) on an
 * already-existing product. `conversionFactor` is a required, explicit,
 * PLAIN argument here — never embedded inside `data` — so this file's
 * own source never contains the literal object key `conversionFactor`.
 *
 * [v4.5] `data` no longer accepts `barcode`/`barcodeSource` — those
 * scalars don't exist on ProductUnit anymore (SafeProductUnitCreate
 * excludes `barcodes` too, at the type level). Attach barcodes for the
 * newly created unit via one or more separate createUnitBarcode() calls,
 * each its own top-level call inside the same $transaction, per T1's
 * nested-write ban.
 *
 * @throws {Error} if productId does not belong to tenantId.
 * @throws {Error} if conversionFactor equals the reserved base-unit
 *   value (1).
 */
export async function createAdditionalUnit(
    tx: TxOrClient,
    tenantId: string,
    productId: string,
    conversionFactor: string,
    data: SafeProductUnitCreate
): Promise<ProductUnit> {
    await assertProductBelongsToTenant(tx, tenantId, productId);

    if (isReservedBaseUnitFactor(conversionFactor)) {
        throw new Error(
            "createAdditionalUnit: conversionFactor of exactly 1 is reserved " +
            "for a product's base unit — use createProductWithBaseUnit() if " +
            "this is genuinely the product's first/base unit."
        );
    }

    // [FIX — belt-and-suspenders, matching this file's own posture on
    // every UPDATE above] Unlike an update (which scopes tenantId via its
    // own `where`), a create has no existing row to scope against — the
    // ONLY way tenantId ends up correct here is either the Client
    // Extension's auto-injection (which requires a real
    // getTenantDb()-derived client) or writing it explicitly. Since this
    // function's `tx` parameter is the wide `TxOrClient` — which includes
    // the RAW, unextended `Prisma.TransactionClient` per tenant-scope.ts's
    // own union — relying on auto-injection alone would silently produce
    // a tenantId-less row if ever called with that raw variant. Writing
    // it explicitly closes that gap regardless of which client shape is
    // passed, exactly the same defensive stance
    // updateProduct()/updateProductUnit()/setProductActive() already take.
    return tx.productUnit.create({
        data: {
            ...data,
            ...buildConversionFactorField(conversionFactor),
            tenantId: tenantId,
            productId: productId,
        } as Prisma.ProductUnitUncheckedCreateInput,
    });
}

/**
 * Creates a brand-new product together with its first packaging unit,
 * which automatically becomes the product's base unit (conversionFactor
 * forced to "1", non-editable afterward). Three top-level Prisma calls
 * (Product.create → base ProductUnit.create → commitBaseUnitLink()),
 * all issued inside the single `tx` the caller passes in, so a crash
 * between any two leaves no orphaned Product row.
 *
 * This is the ONLY sanctioned way to create a new Product in the entire
 * codebase.
 *
 * [v4.5] `firstUnitData` (SafeProductUnitCreate) no longer accepts
 * `barcode`/`barcodeSource` — attach the base unit's barcode(s), if any,
 * via separate createUnitBarcode() calls in the SAME `tx` after this
 * function returns, using `createdBaseUnit.id`.
 *
 * Deliberately pinned to `TenantTransactionClient`, not widened to
 * `TxOrClient` — this function calls commitBaseUnitLink(), which itself
 * requires a real transaction client; widening would let a caller invoke
 * this multi-write function outside any transaction, silently breaking
 * the atomicity guarantee. Because `tx` is guaranteed to be a real
 * getTenantDb()-derived transaction client here (never the raw,
 * unextended Prisma.TransactionClient — see tenant-scope.ts's own
 * TenantTransactionClient definition), relying on the Client Extension's
 * auto-injection of `tenantId` on the two `create` calls below is safe —
 * unlike createAdditionalUnit() above, which had to write it explicitly
 * because ITS `tx` type permits the raw client variant.
 */
export async function createProductWithBaseUnit(
    tx: TenantTransactionClient,
    tenantId: string,
    productData: SafeProductCreate,
    firstUnitData: SafeProductUnitCreate
): Promise<{ createdProduct: Product; createdBaseUnit: ProductUnit }> {
    const product = await tx.product.create({
        data: {
            ...productData,
        } as Prisma.ProductUncheckedCreateInput,
    });

    const baseUnit = await tx.productUnit.create({
        data: {
            ...firstUnitData,
            ...buildConversionFactorField(BASE_UNIT_CONVERSION_FACTOR),
            productId: product.id,
        } as Prisma.ProductUnitUncheckedCreateInput,
    });

    await commitBaseUnitLink(tx, tenantId, product.id, baseUnit.id);

    return { createdProduct: product, createdBaseUnit: baseUnit };
}

// ----------------------------------------------------------------------------
// Reads used by the products routes.
// ----------------------------------------------------------------------------

/**
 * A single product plus all its units (active and inactive).
 *
 * `units` is reshaped via toSafeProductWithUnits() (which itself calls
 * toDisplayUnits()) before returning, so raw ProductUnit rows never leave
 * this file, and the returned Product no longer carries the raw
 * `baseUnitId` scalar at all.
 *
 * [v4.5] The `include` now also fetches each unit's `barcodes`, so
 * toSafeProductWithUnits()/toDisplayUnits() can carry the full
 * barcode list through to DisplayUnitWithBaseFlag — see units.ts for
 * that reshape.
 */
export async function findProductWithUnits(
    tx: TxOrClient,
    tenantId: string,
    productId: string
): Promise<(Omit<Product, "baseUnitId"> & { units: DisplayUnitWithBaseFlag[] }) | null> {
    const product = await tx.product.findUnique({
        where: { id: productId, tenantId },
        include: {
            units: {
                include: {
                    barcodes: {
                        select: { id: true, barcode: true, barcodeSource: true, createdAt: true },
                        orderBy: { createdAt: "asc" },
                    },
                },
            },
        },
    });
    if (!product) return null;
    return toSafeProductWithUnits(product);
}

/**
 * Cross-product barcode collision check for the [id] route's PATCH —
 * "is this barcode already used by a DIFFERENT product's unit?"
 *
 * [v4.5] Rewritten to query `productUnitBarcode` (the barcode now lives
 * there, not on ProductUnit) joined to its parent unit/product. Return
 * shape (id/unitName/productId) is UNCHANGED — `id` here is the
 * colliding UNIT's id (not the barcode row's id), matching every
 * existing caller's expectation that this identifies a unit, not a
 * barcode row.
 */
export interface ProductUnitBarcodeCollision {
    id: string;
    unitName: string;
    productId: string;
}

export async function findProductUnitByBarcodeExcludingProduct(
    tx: TxOrClient,
    tenantId: string,
    barcode: string,
    excludeProductId: string
): Promise<ProductUnitBarcodeCollision | null> {
    const row = await tx.productUnitBarcode.findFirst({
        where: {
            tenantId,
            barcode,
            unit: { productId: { not: excludeProductId } },
        },
        select: {
            unit: { select: { id: true, unitName: true, productId: true } },
        },
    });
    if (!row) return null;
    return {
        id: row.unit.id,
        unitName: row.unit.unitName,
        productId: row.unit.productId,
    };
}

/**
 * Count of ProductBatch rows for a product — the early, informational
 * (non-authoritative) check the [id] route's PATCH runs before deciding
 * whether a base-unit change / conversionFactor edit is even worth
 * attempting. The authoritative re-check still happens inside the
 * transaction via base-unit.ts's assertBaseUnitMutable().
 */
export function countProductBatches(
    tx: TxOrClient,
    tenantId: string,
    productId: string
): Promise<number> {
    return tx.productBatch.count({
        where: { tenantId, productId },
    });
}

export interface InventoryBatchAdjustmentView {
    id: string;
    quantityDelta: Prisma.Decimal;
    reason: string;
    createdAt: Date;
    adjustedByUser: { name: string | null; email: string };
}

export interface InventoryBatchView {
    id: string;
    tenantId: string;
    productId: string;
    unitId: string;
    // [v4.5] `barcode`/`barcodeSource` scalars replaced by `barcodes`, the
    // full list attached to this batch's unit — a unit may now carry
    // zero, one, or many.
    unit: { id: string; unitName: string; barcodes: BarcodeView[]; isActive: boolean };
    batchNumber: string;
    quantity: Prisma.Decimal;
    costPricePerBaseUnit: Prisma.Decimal;
    expiryDate: Date | null;
    createdAt: Date;
    adjustments: InventoryBatchAdjustmentView[];
    _count: { invoiceItems: number; adjustments: number };
}

export interface ProductWithInventoryDetails extends Omit<Product, "baseUnitId"> {
    units: DisplayUnitWithBaseFlag[];
    batches: InventoryBatchView[];
}

/**
 * Full inventory-screen listing: every product matching whereClause,
 * with its units and batches (each batch carrying its unit, its
 * adjustment history, and invoiceItems/adjustments counts).
 *
 * [v4.3 T1/T3c corrigendum] `adjustments` is no longer a ProductBatch
 * relation field — StockAdjustment.batchId is a plain, indexed snapshot
 * field (see schema.prisma). Its removal also removed the nested include
 * that used to fetch this history and the `_count.adjustments` that came
 * with it. Both are reconstructed below with ONE extra batched snapshot
 * lookup keyed by `where: { tenantId, batchId: { in: [...] } }`, so this
 * function's return shape — and every consumer of it — is unchanged.
 *
 * `adjustedByUser` is `select`-narrowed to `{ name, email }` — see the
 * file-header FIX note (previously leaked passwordHash via an unfiltered
 * `adjustedByUser: true`). `batch.unit` stays `select`-narrowed to
 * exclude conversionFactor entirely.
 *
 * [v4.5] `batch.unit`'s select now fetches `barcodes` (a nested select,
 * not a scalar) instead of the old `barcode`/`barcodeSource` scalar
 * pair. `Product.units` is reshaped via toSafeProductWithUnits() before
 * this function returns, which itself now carries each unit's full
 * barcode list.
 */
export async function listProductsWithInventoryDetails(
    tx: TxOrClient,
    tenantId: string,
    whereClause: Omit<Prisma.ProductWhereInput, "tenantId">
): Promise<ProductWithInventoryDetails[]> {
    const products = await tx.product.findMany({
        where: { ...whereClause, tenantId },
        include: {
            units: {
                include: {
                    barcodes: {
                        select: { id: true, barcode: true, barcodeSource: true, createdAt: true },
                        orderBy: { createdAt: "asc" },
                    },
                },
            },
            batches: {
                include: {
                    unit: {
                        select: {
                            id: true,
                            unitName: true,
                            isActive: true,
                            // [v4.5] nested select replacing the old scalar
                            // barcode/barcodeSource pair.
                            barcodes: {
                                select: { id: true, barcode: true, barcodeSource: true, createdAt: true },
                                orderBy: { createdAt: "asc" },
                            },
                        },
                    },
                    // [v4.3 T1/T3c corrigendum] The `adjustments` include that
                    // used to sit here is gone — no such relation exists on
                    // ProductBatch anymore. This history is fetched by the
                    // batched snapshot lookup below instead. The remaining
                    // `_count` is narrowed to the one relation ProductBatch
                    // still has.
                    _count: { select: { invoiceItems: true } },
                },
                orderBy: { createdAt: "desc" },
            },
        },
    });

    // [v4.3 T1/T3c corrigendum] ONE batched snapshot lookup replaces the
    // per-batch `adjustments` relation include that no longer exists — never
    // one query per batch. Rows are grouped by their plain `batchId` snapshot
    // field, so a batch that has since been hard-deleted contributes nothing
    // here (it is not in `batchIds`), while a batch that is still listed keeps
    // its full adjustment log, exactly as before.
    const batchIds = products.flatMap((p) => p.batches.map((b) => b.id));

    const adjustmentRows = batchIds.length
        ? await tx.stockAdjustment.findMany({
            where: { tenantId, batchId: { in: batchIds } },
            select: {
                id: true,
                batchId: true,
                quantityDelta: true,
                reason: true,
                createdAt: true,
                adjustedByUser: { select: { name: true, email: true } },
            },
            orderBy: { createdAt: "desc" },
        })
        : [];

    const adjustmentsByBatchId = new Map<string, InventoryBatchAdjustmentView[]>();
    for (const adj of adjustmentRows) {
        const view: InventoryBatchAdjustmentView = {
            id: adj.id,
            quantityDelta: adj.quantityDelta,
            reason: adj.reason,
            createdAt: adj.createdAt,
            adjustedByUser: adj.adjustedByUser,
        };
        const existing = adjustmentsByBatchId.get(adj.batchId);
        if (existing) existing.push(view);
        else adjustmentsByBatchId.set(adj.batchId, [view]);
    }

    return products.map((p) => {
        const safe = toSafeProductWithUnits(p);
        return {
            ...safe,
            batches: safe.batches.map((batch) => {
                const adjustments = adjustmentsByBatchId.get(batch.id) ?? [];
                return {
                    ...batch,
                    adjustments,
                    _count: {
                        invoiceItems: batch._count?.invoiceItems ?? 0,
                        // Same value the removed relation-count produced:
                        // exactly the rows now fetched by snapshot batchId.
                        adjustments: adjustments.length,
                    },
                } as unknown as InventoryBatchView;
            }),
        };
    });
}

export interface ProductUnitBarcodeMatch {
    id: string;
    unitName: string;
    isActive: boolean;
    productId: string;
    productName: string;
}

/**
 * Tenant-wide barcode lookup (any product) — used by products/route.ts's
 * POST to reject a barcode already in use anywhere for this tenant.
 * Flattened to a plain productName field rather than returning the raw
 * row with a nested `.product` relation.
 *
 * [v4.5] Rewritten to query `productUnitBarcode` first, then walk to its
 * unit and product — the barcode column no longer lives on ProductUnit
 * itself. Return shape is UNCHANGED, so every existing caller (e.g. the
 * products route's duplicate-barcode check) keeps working with no
 * further edits.
 */
export async function findProductUnitByBarcode(
    tx: TxOrClient,
    tenantId: string,
    barcode: string
): Promise<ProductUnitBarcodeMatch | null> {
    const row = await tx.productUnitBarcode.findFirst({
        where: { tenantId, barcode },
        select: {
            unit: {
                select: {
                    id: true,
                    unitName: true,
                    isActive: true,
                    productId: true,
                    product: { select: { name: true } },
                },
            },
        },
    });
    if (!row) return null;
    return {
        id: row.unit.id,
        unitName: row.unit.unitName,
        isActive: row.unit.isActive,
        productId: row.unit.productId,
        productName: row.unit.product.name,
    };
}

export interface ProductNameCategoryUnits {
    id: string;
    name: string;
    category: string | null;
    units: DisplayUnit[];
}

/**
 * [CSV import] Every product for a tenant with its units reshaped via
 * toDisplayUnits() — used by validateAndPreviewCsv() to seed the
 * packaging-consistency check without ever naming conversionFactor
 * itself in csv-parser.ts.
 *
 * [v4.5] `include` now also fetches each unit's `barcodes` so
 * toDisplayUnits() can carry the full list through — see units.ts.
 * NOTE: the CSV file-shape question for multi-barcode rows (T3d) is
 * still an OPEN DECISION per the T3a-addendum spec doc — this function
 * only ensures the data is available to whatever CSV logic is decided;
 * it does not itself decide how a CSV row maps to one-or-many barcodes.
 */
export async function listAllProductsWithUnitsForPackagingCheck(
    tx: TxOrClient,
    tenantId: string
): Promise<ProductNameCategoryUnits[]> {
    const products = await tx.product.findMany({
        where: { tenantId },
        include: {
            units: {
                include: {
                    barcodes: {
                        select: { id: true, barcode: true, barcodeSource: true, createdAt: true },
                        orderBy: { createdAt: "asc" },
                    },
                },
            },
        },
    });
    return products.map((p) => ({
        id: p.id,
        name: p.name,
        category: p.category,
        units: toDisplayUnits(p.units),
    }));
}

export interface UnitWithProductName extends DisplayUnit {
    productId: string;
    productName: string;
    isActive: boolean;
}

/**
 * [CSV import] Every ProductUnit for a tenant with its parent product's
 * name — used by validateAndPreviewCsv() to build the barcode lookup map
 * without a raw `.product` relation leaving this file.
 *
 * [v4.5] `include` now also fetches each unit's `barcodes` — same reason
 * as listAllProductsWithUnitsForPackagingCheck() above.
 */
export async function listAllUnitsForTenantWithProductName(
    tx: TxOrClient,
    tenantId: string
): Promise<UnitWithProductName[]> {
    const units = await tx.productUnit.findMany({
        where: { tenantId },
        include: {
            product: { select: { name: true } },
            barcodes: {
                select: { id: true, barcode: true, barcodeSource: true, createdAt: true },
                orderBy: { createdAt: "asc" },
            },
        },
    });
    return units.map((u) => ({
        ...toDisplayUnits([u])[0],
        productId: u.productId,
        productName: u.product.name,
        isActive: u.isActive,
    }));
}

/**
 * [CSV import] Case-insensitive (name, category) product match, with all
 * its units — used by commitCsvImport() to decide whether a "new
 * product" CSV row is genuinely new or should attach an additional
 * packaging unit to an already-existing product.
 *
 * [v4.5] `include` now also fetches each unit's `barcodes` — same reason
 * as findProductWithUnits() above.
 */
export async function findProductByNameCategory(
    tx: TxOrClient,
    tenantId: string,
    name: string,
    category: string | null
): Promise<(Omit<Product, "baseUnitId"> & { units: DisplayUnitWithBaseFlag[] }) | null> {
    const product = await tx.product.findFirst({
        where: {
            tenantId,
            name: { equals: name, mode: "insensitive" },
            category: category ? { equals: category, mode: "insensitive" } : null,
        },
        include: {
            units: {
                include: {
                    barcodes: {
                        select: { id: true, barcode: true, barcodeSource: true, createdAt: true },
                        orderBy: { createdAt: "asc" },
                    },
                },
            },
        },
    });
    if (!product) return null;
    return toSafeProductWithUnits(product);
}
// ----------------------------------------------------------------------------
// [T4h] DASHBOARD SUPPORT GATEWAYS
//
// Three deliberately NARROW read helpers for lib/data/analytics.ts (invoked
// per /dashboard load through app/api/analytics/route.ts), added here because
// this file is the ONLY place allowed to name the product / productUnit /
// productBatch models or to reach a `.conversionFactor` at all (see
// eslint.config.mjs's BACKEND_ONLY_FILES block and this file's own header).
//
// WHY NOT REUSE listProductsWithInventoryDetails():
// that function fetches EVERY product with EVERY unit AND EVERY batch (plus
// their barcode lists and adjustment histories) — correct for the inventory
// screen, far too heavy to run on every /dashboard load. These three helpers
// read exactly what the analytics screen needs and nothing else.
// ----------------------------------------------------------------------------

/**
 * Fail-loud tenant guard. Belt-and-suspenders: every `where` below ALSO
 * carries `tenantId` explicitly (and the getTenantDb() extension would inject
 * it a third time), but a missing tenant id must never silently widen one of
 * these reads to the whole table if this gateway is ever called through a raw
 * client.
 */
function requireTenantId(tenantId: string, caller: string): void {
    if (typeof tenantId !== "string" || tenantId.trim() === "") {
        throw new Error(`lib/data/products.ts: ${caller}() requires a tenantId.`);
    }
}

/**
 * Fail-loud guard over a caller-supplied id list: no blank entries. An EMPTY
 * list is legal — an empty dashboard window has no products / no units — and
 * the helpers below return an empty map for it instead of querying with an
 * empty `in: []`.
 */
function requireIdList(ids: readonly string[], caller: string): void {
    for (const id of ids) {
        if (typeof id !== "string" || id.trim() === "") {
            throw new Error(`lib/data/products.ts: ${caller}() received a blank id.`);
        }
    }
}

/**
 * Resolves a set of SOLD unit ids (an InvoiceItem's `unitId`) to that unit's
 * conversion factor, in ONE batch of reads.
 *
 * - The factor is read ONLY through units.ts's getUnitConversionFactor() — the
 *   one sanctioned reader — never by naming `conversionFactor` in a select
 *   here (banned in this file too; see CONVERSION_FACTOR_RULES).
 * - The BASE-UNIT NAME deliberately does NOT travel with the factor: the
 *   analytics layer resolves the (at most 15) surfaced products' base-unit
 *   names itself via base-unit.ts's fail-loud requireBaseUnits(), degrading a
 *   missing label to an empty unit name instead of failing the dashboard.
 *
 * A unit id that does not exist for this tenant simply has no map entry; the
 * caller decides what that means (T4h treats it as a data-integrity bug and
 * throws rather than ranking a wrong number).
 */
export async function listUnitConversionFactors(
    tx: TxOrClient,
    tenantId: string,
    unitIds: readonly string[]
): Promise<Map<string, string>> {
    requireTenantId(tenantId, "listUnitConversionFactors");
    requireIdList(unitIds, "listUnitConversionFactors");

    const unique = [...new Set(unitIds)];
    const result = new Map<string, string>();
    if (unique.length === 0) return result;

    const unitRows = await tx.productUnit.findMany({
        where: { tenantId, id: { in: unique } },
        select: { id: true },
    });

    for (const row of unitRows) {
        const factor = await getUnitConversionFactor(tx, tenantId, row.id);
        result.set(row.id, factor.toString());
    }

    return result;
}

/** One stock-risk batch row, flattened for the dashboard alerts. */
export interface AlertBatchRow {
    id: string;
    batchNumber: string;
    quantity: string;
    expiryDate: Date | null;
    productId: string;
    productName: string;
    unitName: string;
}

/**
 * The ONLY batches worth alerting on: negative-stock batches, and real stock
 * (`quantity > 0`) expiring BEFORE `expiringBefore`. Filtered IN THE DATABASE
 * (a single indexed read), not by fetching a tenant's whole batch table and
 * discarding most of it in application code.
 *
 * Product names are fetched separately by id — this file may not name
 * `product` as an `include`/`select`/`where` KEY (PRODUCT_MODEL_RULES bans
 * `include: { product: ... }` outside this file, and cleanup-by-inlining it
 * here would defeat the point of the ban), so a second tiny keyed read stands
 * in for the join (listProductNamesByIds below).
 *
 * The rows come back FLAT and UNCLASSIFIED: splitting them into
 * "needs reconciliation" vs "expiring soon", the calendar-day math and the
 * list caps all belong to lib/data/analytics.ts's buildAlerts(), which owns
 * the dashboard's alert semantics.
 */
export async function listBatchAlertRows(
    tx: TxOrClient,
    tenantId: string,
    options: { expiringBefore: Date }
): Promise<AlertBatchRow[]> {
    requireTenantId(tenantId, "listBatchAlertRows");

    const rows = await tx.productBatch.findMany({
        where: {
            tenantId,
            OR: [
                { quantity: { lt: 0 } },
                { quantity: { gt: 0 }, expiryDate: { not: null, lt: options.expiringBefore } },
            ],
        },
        select: {
            id: true,
            batchNumber: true,
            quantity: true,
            expiryDate: true,
            productId: true,
            unit: { select: { unitName: true } },
        },
        orderBy: { expiryDate: "asc" },
    });

    const productIds = [...new Set(rows.map((row) => row.productId))];
    const nameById =
        productIds.length > 0
            ? await listProductNamesByIds(tx, tenantId, productIds)
            : new Map<string, string>();

    return rows.map((row) => ({
        id: row.id,
        batchNumber: row.batchNumber,
        quantity: row.quantity.toString(),
        expiryDate: row.expiryDate,
        productId: row.productId,
        productName: nameById.get(row.productId) ?? "منتج غير متوفر",
        unitName: row.unit.unitName,
    }));
}

// [T4h] THE narrowest of the dashboard's three reads from this gateway: just
// id → display name for the products the analytics window actually touched.
// The Top-5 lists are built from InvoiceItem rows, so a product soft-deleted
// after it was sold has no catalog row to name it; this lookup substitutes a
// placeholder for exactly those, and is the ONLY thing the analytics data layer
// needs from the catalog — listProductsWithInventoryDetails() would be the
// wrong call here for the reason listBatchAlertRows() gives (same heavy-read
// rationale as the gateway section above).
export async function listProductNamesByIds(
    tx: TxOrClient,
    tenantId: string,
    productIds: readonly string[]
): Promise<Map<string, string>> {
    requireTenantId(tenantId, "listProductNamesByIds");
    requireIdList(productIds, "listProductNamesByIds");

    const names = new Map<string, string>();
    if (productIds.length === 0) return names;

    const rows = await tx.product.findMany({
        where: { tenantId, id: { in: [...productIds] } },
        select: { id: true, name: true },
    });

    for (const row of rows) names.set(row.id, row.name);
    return names;
}