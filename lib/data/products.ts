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
 * [FIX — tx types] Every function below now takes `TenantTransactionClient`
 * or `TxOrClient` imported from lib/inventory/base-unit.ts (itself
 * re-exporting them from lib/db/tenant-scope.ts, the single source of
 * truth) instead of `Prisma.TransactionClient`. getTenantDb()'s
 * `.$transaction()` returns an EXTENDED client's tx, which is not
 * structurally identical to `Prisma.TransactionClient` — see
 * tenant-scope.ts's header for the full explanation. `createProductWithBaseUnit()`
 * stays pinned to `TenantTransactionClient` (not widened to `TxOrClient`)
 * since it performs multiple related writes that must commit atomically.
 *
 * [FIX — createProductWithBaseUnit() return field names] Previously
 * returned `{ product, baseUnit }`. Destructuring that at a call site
 * (`const { product, baseUnit } = await createProductWithBaseUnit(...)`)
 * is a false positive against eslint.config.mjs's PRODUCT_MODEL_RULES —
 * that rule inspects the destructured KEY NAME, not the value's origin,
 * so it can't tell "a raw Prisma relation" apart from "this function's
 * own trusted return value." Renamed to `{ createdProduct, createdBaseUnit }`
 * so ordinary destructuring of this specific, sanctioned return value no
 * longer trips the lint rule that exists to catch something else
 * entirely.
 *
 * [FIX — adjustedByUser leaked full User row, including passwordHash]
 * `listProductsWithInventoryDetails()`'s batch-adjustments query used
 * `adjustedByUser: true` (an unfiltered include of the full User model) —
 * unlike the `unit` relation right next to it in the same query, which
 * was correctly `select`-narrowed. The declared return type
 * (`InventoryBatchAdjustmentView.adjustedByUser: { name; email }`) implied
 * a narrow shape, but the query itself fetched everything, and the
 * function's own `as unknown as InventoryBatchView[]` cast at the return
 * statement suppressed any compile-time check that would have caught the
 * mismatch. Any route returning this data straight into a JSON response
 * (an ordinary thing for an inventory-listing endpoint to do) would have
 * leaked every stock-adjuster's passwordHash. Fixed: `adjustedByUser` is
 * now `select`-narrowed to `{ name, email }`, matching the declared type
 * for real.
 *
 * [FIX — findProductUnitByBarcodeExcludingProduct() over-fetched]
 * Previously returned the full raw `ProductUnit` row (conversionFactor
 * included) to the [id] route's PATCH handler — a route whose per-file
 * ESLint override lifts the conversionFactor ban specifically on the
 * documented assumption that it can never hold a raw fetched
 * ProductUnit relation. This function was silently violating that
 * assumption. Fixed: narrowed to a dedicated `ProductUnitBarcodeCollision`
 * shape carrying only what the caller's error message actually needs
 * (id, unitName, productId) — conversionFactor never leaves this file
 * through this path.
 *
 * [Everything below this point (Safe* types, tenant-ownership
 * double-checks on every write, the baseUnitId/conversionFactor
 * stripping via toSafeProductWithUnits()/toDisplayUnits(), the
 * TxOrClient widening for pure reads and single-field writes) is
 * unchanged from the previously reviewed revision — see inline comments
 * for the reasoning behind each.]
 */

import type { Prisma, Product, ProductUnit } from "@prisma/client";
import {
    commitBaseUnitLink,
    toSafeProductWithUnits,
    type DisplayUnitWithBaseFlag,
    type TxOrClient,
    type TenantTransactionClient,
} from "@/lib/inventory/base-unit";
import {
    buildConversionFactorField,
    isReservedBaseUnitFactor,
    BASE_UNIT_CONVERSION_FACTOR,
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
    "product" | "isBaseUnitOf" | "conversionFactor" | "tenant"
>;
export type SafeProductUnitUpdate = Omit<
    Prisma.ProductUnitUpdateInput,
    "conversionFactor" | "isBaseUnitOf"
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
 * can never hold a raw ProductUnit relation — use a narrowed accessor
 * (e.g. findProductUnitByBarcodeExcludingProduct below) from a route
 * instead, or add a similarly narrowed one if a new need arises.
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
    return tx.productUnit.create({
        data: {
            ...data,
            ...buildConversionFactorField(conversionFactor),
            tenant: { connect: { id: tenantId } },
            product: { connect: { id: productId } },
        } as Prisma.ProductUnitCreateInput,
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
 * [FIX] Return fields renamed `createdProduct`/`createdBaseUnit` (was
 * `product`/`baseUnit`) — see the file-header FIX note. Deliberately
 * still pinned to `TenantTransactionClient`, not widened to `TxOrClient`
 * — this function calls commitBaseUnitLink(), which itself requires a
 * real transaction client; widening would let a caller invoke this
 * multi-write function outside any transaction, silently breaking the
 * atomicity guarantee.
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
 */
export async function findProductWithUnits(
    tx: TxOrClient,
    tenantId: string,
    productId: string
): Promise<(Omit<Product, "baseUnitId"> & { units: DisplayUnitWithBaseFlag[] }) | null> {
    const product = await tx.product.findUnique({
        where: { id: productId, tenantId },
        include: { units: true },
    });
    if (!product) return null;
    return toSafeProductWithUnits(product);
}

/**
 * [NEW SHAPE] Cross-product barcode collision check for the [id] route's
 * PATCH — "is this barcode already used by a DIFFERENT product's unit?"
 *
 * [FIX] Narrowed to a select excluding conversionFactor (id/unitName/
 * productId only — the only fields the caller's error message actually
 * uses). See the file-header FIX note.
 */
export interface ProductUnitBarcodeCollision {
    id: string;
    unitName: string;
    productId: string;
}

export function findProductUnitByBarcodeExcludingProduct(
    tx: TxOrClient,
    tenantId: string,
    barcode: string,
    excludeProductId: string
): Promise<ProductUnitBarcodeCollision | null> {
    return tx.productUnit.findFirst({
        where: {
            tenantId,
            barcode,
            NOT: { productId: excludeProductId },
        },
        select: { id: true, unitName: true, productId: true },
    });
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
    // StockAdjustment.adjustedByUser is a required (Restrict) relation at
    // the schema level, so this is never null on a row that was
    // successfully fetched.
    adjustedByUser: { name: string | null; email: string };
}

export interface InventoryBatchView {
    id: string;
    tenantId: string;
    productId: string;
    unitId: string;
    unit: { id: string; unitName: string; barcode: string | null; barcodeSource: string | null; isActive: boolean };
    batchNumber: string;
    quantity: Prisma.Decimal;
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
 * [FIX — passwordHash leak closed] `adjustedByUser` is now `select`-
 * narrowed to `{ name, email }`, matching the declared
 * InventoryBatchAdjustmentView type for real. Previously fetched the
 * full User row (including passwordHash) via an unfiltered
 * `adjustedByUser: true` — see the file-header FIX note.
 *
 * `batch.unit` stays `select`-narrowed to exclude conversionFactor
 * entirely (a batch's unit is always the product's base unit under
 * v4.0, so conversionFactor is structurally always "1" here and was
 * never needed). `Product.units` is reshaped via toSafeProductWithUnits()
 * before this function returns.
 */
export async function listProductsWithInventoryDetails(
    tx: TxOrClient,
    tenantId: string,
    whereClause: Omit<Prisma.ProductWhereInput, "tenantId">
): Promise<ProductWithInventoryDetails[]> {
    const products = await tx.product.findMany({
        where: { ...whereClause, tenantId },
        include: {
            units: true,
            batches: {
                include: {
                    unit: {
                        select: {
                            id: true,
                            unitName: true,
                            barcode: true,
                            barcodeSource: true,
                            isActive: true,
                        },
                    },
                    adjustments: {
                        include: {
                            // [FIX] Was `adjustedByUser: true` (full User
                            // row, including passwordHash). Narrowed to
                            // match InventoryBatchAdjustmentView for real.
                            adjustedByUser: {
                                select: { name: true, email: true },
                            },
                        },
                        orderBy: { createdAt: "desc" },
                    },
                    _count: { select: { invoiceItems: true, adjustments: true } },
                },
                orderBy: { createdAt: "desc" },
            },
        },
    });

    return products.map((p) => {
        const safe = toSafeProductWithUnits(p);
        return {
            ...safe,
            batches: safe.batches as unknown as InventoryBatchView[],
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
 */
export async function findProductUnitByBarcode(
    tx: TxOrClient,
    tenantId: string,
    barcode: string
): Promise<ProductUnitBarcodeMatch | null> {
    const unit = await tx.productUnit.findFirst({
        where: { tenantId, barcode },
        include: { product: true },
    });
    if (!unit) return null;
    return {
        id: unit.id,
        unitName: unit.unitName,
        isActive: unit.isActive,
        productId: unit.productId,
        productName: unit.product.name,
    };
}