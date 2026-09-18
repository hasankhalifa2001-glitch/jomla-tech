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
 * [FIX 2 — tenant isolation on writes] Every READ below already scopes
 * its `where` by `tenantId`, matching T1's tenant-isolation architecture
 * (the Prisma Client Extension is Phase 1's primary guard, but every
 * query in this codebase is also written defensively as if the
 * extension were absent — the same double-layered posture T1's
 * tenantScopedRawQuery() takes for raw queries). Every WRITE helper below
 * (updateProduct / updateProductUnit / setProductActive /
 * createAdditionalUnit) verifies the target row actually belongs to the
 * calling tenant BEFORE writing, via assertProductBelongsToTenant() /
 * assertProductUnitBelongsToTenant() — AND the actual `update()`/
 * `create()` call itself is also scoped by `tenantId` directly in its
 * own `where`, not just guarded by the earlier check. Two independent
 * layers, not one: a check-then-write pattern alone still has a (tiny,
 * but real) window between the check and the write, and scoping the
 * write's own `where` closes that window structurally rather than by
 * timing. This mirrors the same posture
 * `updateNonBaseUnitConversionFactor()` in lib/inventory/base-unit.ts
 * already applies to its own writes.
 *
 * [FIX 2b — createAdditionalUnit() previously had NO tenant check at
 * all] Unlike every other write helper in this file,
 * createAdditionalUnit() connected `productId` into a new ProductUnit
 * row without ever confirming that product belongs to `tenantId` first.
 * A caller passing a productId belonging to a different tenant (bad
 * input, a compromised route, or a future caller that forgets to
 * re-derive productId from a tenant-scoped read first) would silently
 * create a ProductUnit row whose own `tenantId` field is correct but
 * whose `productId` points at another tenant's Product — a real
 * cross-tenant data-contamination path. Fixed: this function now calls
 * assertProductBelongsToTenant() up front, identically to
 * createProductWithBaseUnit()'s implicit guarantee (it always creates
 * its OWN product in the same call, so there was never a cross-tenant
 * risk there).
 *
 * [FIX 3 — conversionFactor leak via listProductsWithInventoryDetails]
 * The inventory-listing query previously included `unit: true` (a full,
 * unnarrowed ProductUnit row) inside each batch, and returned raw
 * `Product.units` arrays straight from Prisma — both routes around this
 * file's own conversionFactor restriction, since it's a bare relation
 * name (`unit`/`units`), not `.product`/`.productUnit`, so the model-level
 * ESLint rule never saw it, and the calling route files
 * (app/api/products/route.ts, app/api/products/[id]/route.ts) have the
 * conversionFactor ban deliberately LIFTED on the assumption that they
 * can never hold a raw fetched relation containing that field — an
 * assumption this function was quietly violating. Fixed: `batch.unit` is
 * now `select`-narrowed to exclude conversionFactor, and `Product.units`
 * is reshaped via lib/inventory/units.ts's toDisplayUnits() before
 * leaving this file, so the literal field name — and any raw Prisma
 * relation carrying it — never crosses this file's boundary. Callers
 * that need more display fields than DisplayUnit currently carries
 * (priceWholesale, pricingCurrency, etc.) should extend toDisplayUnits()
 * / toOfflineCacheUnits() in units.ts rather than reading the raw row
 * here or in the route.
 *
 * [FIX 4 — raw baseUnitId no longer leaves this file] `findProductWithUnits()`
 * and `listProductsWithInventoryDetails()` previously typed their return
 * value as `Omit<Product, never> & {...}` — `Omit<T, never>` omits
 * nothing, so the raw `Product.baseUnitId` scalar FK was still present on
 * every object this file handed back to a route, even though the
 * ESLint model-level ban stops those route files from ever NAMING
 * `.baseUnitId` in their own source. That's a real gap: a route that
 * does `return NextResponse.json(product)` (spreading the whole object
 * into an HTTP response) would leak the raw baseUnitId value to the
 * client regardless of what the route's own source code names — the
 * lint rule guards against a route READING the field, not against this
 * file continuing to CARRY it downstream.
 *
 * [FIX 4b — the stripping/annotating itself must NOT happen in this
 * file] The first pass at this fix wrote `const { baseUnitId, units,
 * ...rest } = product` directly in THIS file — which is exactly the
 * `.baseUnitId` destructuring access `BASE_UNIT_ID_RULES` bans, and this
 * file's own per-file ESLint override deliberately does NOT lift that
 * ban (see the header note above: "baseUnitId/isBaseUnitOf also stays
 * fully banned — this file only ever touches it indirectly, via
 * base-unit.ts's commitBaseUnitLink()"). The linter correctly caught
 * this as a real violation, not a false positive: this file has no
 * standing exemption to read that field itself, even for the good
 * purpose of stripping it back out. Fixed properly: the
 * destructure-and-annotate logic now lives entirely in
 * lib/inventory/base-unit.ts's `toSafeProductWithUnits()` — the
 * sanctioned file for touching `baseUnitId` — which takes a raw fetched
 * product+units result and hands back a value that already has
 * `baseUnitId` stripped and each unit annotated with `isBaseUnit`. This
 * file (products.ts) never names `.baseUnitId` anywhere in its own
 * source; it only calls the helper and gets safe data back, exactly the
 * same posture it already has toward `.conversionFactor` via
 * units.ts's `buildConversionFactorField()`/`isReservedBaseUnitFactor()`.
 *
 * [FIX 5 — tx parameter widened to TxOrClient for read-only and
 * single-field-write helpers] Every function below previously typed its
 * `tx` parameter strictly as `Prisma.TransactionClient`. In practice,
 * many callers invoke these functions with the plain tenant-scoped
 * client returned by `getTenantDb()` directly — NOT wrapped in
 * `db.$transaction(...)` — because a standalone read (e.g. a GET
 * handler's product listing) or a single top-level write with no
 * sibling writes to stay atomic with (e.g. the DELETE handler's
 * `setProductActive(db, tenantId, id, false)`) needs no transaction at
 * all. `getTenantDb()`'s return type (a Prisma Client Extension type)
 * does not structurally satisfy `Prisma.TransactionClient` (different
 * internal generic branding), so every such call site failed to
 * compile: "Argument of type 'DynamicClientExtensionThis<...>' is not
 * assignable to parameter of type 'TransactionClient'."
 *
 * Fixed by widening the affected functions' `tx` parameter to
 * `TxOrClient` (exported from lib/inventory/base-unit.ts, where
 * requireBaseUnit()/requireBaseUnits() already used this exact pattern
 * successfully) — a union covering `Prisma.TransactionClient`,
 * `PrismaClient`, and `getTenantDb()`'s return type. `TxOrClient`
 * includes `Prisma.TransactionClient`, so every existing call site that
 * DOES pass a real transaction client (e.g. everything inside this
 * file's own `db.$transaction(async (tx) => {...})` blocks in the
 * routes) keeps working unchanged.
 *
 * `createProductWithBaseUnit()` is the ONE exception below — it is left
 * pinned to `Prisma.TransactionClient` deliberately. It performs three
 * related top-level writes (Product.create → ProductUnit.create →
 * commitBaseUnitLink()) that must commit atomically, and
 * commitBaseUnitLink() (lib/inventory/base-unit.ts) itself requires a
 * real `Prisma.TransactionClient` — widening this function's parameter
 * would silently remove the compile-time guarantee that it can only ever
 * be invoked via `db.$transaction(async (tx) => ...)`, exactly the
 * failure mode T1's nested-write/atomicity rules exist to prevent. See
 * lib/inventory/base-unit.ts's file-header FIX 3 note for the same
 * reasoning applied to resetProductUnits()/updateNonBaseUnitConversionFactor().
 *
 * [NOTE — this file never SHAPES conversionFactor-bearing output itself]
 * Any conversionFactor-bearing payload this file returns is always built
 * by calling into lib/inventory/units.ts's toDisplayUnits()/
 * toOfflineCacheUnits() — never assembled by hand here, since doing so
 * would require naming the field directly in this file's own source.
 *
 * The `Safe*` types below are a SECOND, independent layer on top of both
 * restrictions above — a compile-time guarantee, not just a lint
 * warning — so that even a future refactor of this file itself can't
 * accidentally let `baseUnitId` / `conversionFactor` leak into a generic
 * "update anything" helper exported from here.
 */

import type { Prisma, Product, ProductUnit } from "@prisma/client";
import {
    commitBaseUnitLink,
    toSafeProductWithUnits,
    type DisplayUnitWithBaseFlag,
    type TxOrClient,
    type TenantTransactionClient, // [FIX] مضافة
} from "@/lib/inventory/base-unit";
import {
    buildConversionFactorField,
    isReservedBaseUnitFactor,
    BASE_UNIT_CONVERSION_FACTOR,
} from "@/lib/inventory/units";

// Re-exported so existing imports of `DisplayUnitWithBaseFlag` from this
// file keep working — the type itself is now DEFINED in
// lib/inventory/base-unit.ts (the sanctioned file for baseUnitId), since
// computing `isBaseUnit` requires comparing against that field, which
// this file is (correctly) forbidden from ever naming itself. See the
// FIX 4b note below.
export type { DisplayUnitWithBaseFlag };

// ----------------------------------------------------------------------------
// Safe types — excess-property checking on object literals typed as these
// catches misuse at COMPILE TIME (e.g. calling updateProduct(tx, tenantId,
// id, { baseUnitId: 'x' }) below is a TS error), independent of and in
// addition to whatever the ESLint rule catches. Both sensitive fields are
// excluded from every input type this file exports, not just the ones
// that "obviously" needed it.
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
// Plain reads. None of these query shapes filter/select on baseUnitId or
// conversionFactor by name, so they carry no risk of the loophole this
// file exists to close — the restriction that matters is on WRITES and on
// any query that specifically targets those field names, not on the mere
// presence of the field in a full-row read result. See the file header
// note above for what a CALLER of these must do if it needs
// conversionFactor-bearing output in a specific shape.
//
// [FIX 5] `tx` widened to TxOrClient — these are pure reads, always safe
// to call with either a real transaction client or the plain tenant-
// scoped client directly.
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
    tx: TxOrClient,
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
//
// [FIX 2] Every write below verifies row ownership before writing (via
// assertProductBelongsToTenant / assertProductUnitBelongsToTenant), AND
// the write's own `where` is additionally scoped by `tenantId` directly
// — not relying on the pre-check alone, and not relying solely on the
// Client Extension to have scoped it upstream. This is the same
// double-layered posture T1 already takes for raw queries via
// tenantScopedRawQuery(), and the same posture
// updateNonBaseUnitConversionFactor() in lib/inventory/base-unit.ts
// already applies to its own write.
//
// [FIX 5] `tx` widened to TxOrClient for updateProduct/updateProductUnit/
// setProductActive/createAdditionalUnit — each performs exactly one
// top-level Prisma write with no sibling write it must stay atomic with
// at this layer (any atomicity these need with OTHER models' writes —
// e.g. the PATCH route's resetProductUnits() call — is the caller's
// responsibility, achieved by opening its own db.$transaction(...) and
// passing that `tx` in). createProductWithBaseUnit() is the deliberate
// exception — see the file-header FIX 5 note.
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
    // [FIX 2] `where` scoped by tenantId too, not just `id` — closes the
    // window between the check above and this write.
    return tx.product.update({ where: { id: productId, tenantId }, data });
}

export async function updateProductUnit(
    tx: TxOrClient,
    tenantId: string,
    unitId: string,
    data: SafeProductUnitUpdate
): Promise<ProductUnit> {
    await assertProductUnitBelongsToTenant(tx, tenantId, unitId);
    // [FIX 2] `where` scoped by tenantId too, not just `id`.
    return tx.productUnit.update({ where: { id: unitId, tenantId }, data });
}

/**
 * Product deactivation/reactivation — the ONLY field this touches is
 * isActive, deliberately separate from updateProduct() so a caller can
 * never accidentally bundle an isActive toggle with an isPublic change in
 * the same call.
 */
export async function setProductActive(
    tx: TxOrClient,
    tenantId: string,
    productId: string,
    isActive: boolean
): Promise<Product> {
    await assertProductBelongsToTenant(tx, tenantId, productId);
    // [FIX 2] `where` scoped by tenantId too, not just `id`.
    return tx.product.update({ where: { id: productId, tenantId }, data: { isActive } });
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
 * [FIX 2b] Now verifies productId belongs to tenantId BEFORE creating
 * the unit — previously the only write helper in this file with no
 * tenant-ownership check at all, meaning a productId belonging to a
 * different tenant would silently succeed in creating a ProductUnit row
 * cross-linked to it. See the file-header FIX 2b note.
 *
 * @throws {Error} if productId does not belong to tenantId.
 * @throws {Error} if conversionFactor equals the reserved base-unit
 *   value (1) — that value is reserved for createProductWithBaseUnit()
 *   below.
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
 * requireBaseUnit()'s MissingBaseUnitError in base-unit.ts). No
 * tenant-ownership pre-check is needed here (unlike createAdditionalUnit)
 * since this function always creates its OWN product in the same call —
 * there is no pre-existing productId to cross-wire against.
 *
 * [FIX 5] Deliberately still pinned to `Prisma.TransactionClient`, NOT
 * widened to TxOrClient — see the file-header FIX 5 note. This function
 * calls commitBaseUnitLink() (lib/inventory/base-unit.ts), which itself
 * requires a real `Prisma.TransactionClient`; widening this parameter
 * would let a caller invoke this multi-write function with a plain
 * client outside any transaction, silently breaking the atomicity
 * guarantee (a crash between the Product.create and the ProductUnit.create
 * would then leave an orphaned Product row). Every caller must open its
 * own `db.$transaction(async (tx) => ...)` and pass that `tx` in.
 */
export async function createProductWithBaseUnit(
    tx: TenantTransactionClient, // [FIX] كان Prisma.TransactionClient
    tenantId: string,
    productData: SafeProductCreate,
    firstUnitData: SafeProductUnitCreate
): Promise<{ createdProduct: Product; createdBaseUnit: ProductUnit }> {
    // [FIX] أسماء الحقول تغيّرت من product/baseUnit إلى createdProduct/
    // createdBaseUnit — عشان أي destructuring لنتيجة هالدالة بملف route ما
    // يوقع بـ false-positive على قاعدة PRODUCT_MODEL_RULES (يلي بتفحص
    // اسم المفتاح حرفياً، مش مصدر القيمة).
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
// [NEW] Missing reads referenced by app/api/products/route.ts and
// app/api/products/[id]/route.ts after their v4.0 rewrite — added here.
// None of these name `conversionFactor` as a literal key (no `orderBy` by
// it either — CONVERSION_FACTOR_RULES stays fully active in this file),
// and none leak a `.product` relation to a caller outside this file.
//
// [FIX 5] `tx` widened to TxOrClient throughout this section too — every
// one of these is a pure read.
// ----------------------------------------------------------------------------

/**
 * A single product plus all its units (active and inactive) — used by
 * the [id] route's GET (to build the isBaseUnit-annotated response) and
 * PATCH (as both the pre-update snapshot and, inside the transaction,
 * the post-update read returned to the client).
 *
 * [FIX 3] `units` is reshaped via toDisplayUnits() before returning, so
 * the raw ProductUnit rows (which carry a real conversionFactor column)
 * never leave this file.
 *
 * [FIX 4] The returned Product no longer carries the raw `baseUnitId`
 * scalar at all (`Omit<Product, "baseUnitId">`, not the previous
 * `Omit<Product, never>`, which omitted nothing) — a route that spreads
 * this object straight into a JSON response can no longer leak that FK
 * regardless of what the route's own source code names. Each unit now
 * carries a precomputed `isBaseUnit` boolean instead (see
 * DisplayUnitWithBaseFlag above) — the route renders a "base unit" badge
 * off that flag, never off conversionFactor === "1" or the raw FK.
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
    // [FIX 4b] Never destructure `.baseUnitId` in this file — hand the raw
    // fetched result straight to base-unit.ts's sanctioned helper instead.
    return toSafeProductWithUnits(product);
}


export interface ProductUnitBarcodeCollision {
    id: string;
    unitName: string;
    productId: string;
}

/**
 * Cross-product barcode collision check for the [id] route's PATCH —
 * "is this barcode already used by a DIFFERENT product's unit?"
 *
 * [FIX 8] Narrowed to a select excluding conversionFactor — this
 * function is callable from app/api/inventory/products/[id]/route.ts,
 * whose per-file ESLint override lifts the conversionFactor ban on the
 * stated assumption that no raw fetched ProductUnit relation ever
 * reaches it. Previously this returned the full ProductUnit row
 * (conversionFactor included), which silently broke that assumption.
 */
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

/**
 * [FIX 6 — real bug: `adjustments: unknown[]` broke every consumer]
 * `listProductsWithInventoryDetails()`'s query fetches each batch's
 * adjustments via `adjustments: { include: { adjustedByUser: true },
 * orderBy: { createdAt: "desc" } }` — i.e. full StockAdjustment rows,
 * each carrying its full `adjustedByUser` User relation. The previous
 * `adjustments: unknown[]` on InventoryBatchView below didn't reflect
 * that shape at all, so any caller (e.g. the GET route's
 * `batch.adjustments.map((adj) => ({ id: adj.id, quantityDelta:
 * adj.quantityDelta.toString(), ..., adjustedByUserName:
 * adj.adjustedByUser?.name || adj.adjustedByUser?.email || "مستخدم" }))`)
 * hit "'adj' is of type 'unknown'" on every property access — `unknown`
 * has no accessible members without a type guard/assertion first. Fixed
 * by giving `adjustments` its real element type below, matching exactly
 * the fields the query actually includes and callers actually read.
 */
export interface InventoryBatchAdjustmentView {
    id: string;
    quantityDelta: Prisma.Decimal;
    reason: string;
    createdAt: Date;
    // StockAdjustment.adjustedByUser is a required (Restrict) relation at
    // the schema level, so this is never null on a row that was
    // successfully fetched — kept non-optional to match that guarantee.
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
 * adjustment history, and invoiceItems/adjustments counts) — the shape
 * app/api/products/route.ts's GET processes into the inventory-table
 * response.
 *
 * [FIX 3] Two changes closing the conversionFactor leak this function
 * previously had:
 *   1. `batch.unit` is now `select`-narrowed to exclude
 *      conversionFactor entirely (id/unitName/barcode/barcodeSource/
 *      isActive only) — a batch's unit is always the product's base
 *      unit under v4.0 (conversionFactor is structurally always "1"),
 *      so the inventory table never needed the raw number here; if a
 *      future screen genuinely does, fetch it via
 *      lib/inventory/units.ts's getUnitConversionFactor() explicitly,
 *      never by widening this select.
 *   2. `Product.units` is reshaped via toDisplayUnits() before this
 *      function returns, so the top-level `units: true` include no
 *      longer hands the route a raw ProductUnit[] either.
 *
 * [FIX 4] `baseUnitId` is stripped from every returned product
 * (`ProductWithInventoryDetails` now extends `Omit<Product,
 * "baseUnitId">`, not `Omit<Product, never>`), and each unit carries a
 * precomputed `isBaseUnit` flag instead — same reasoning as
 * findProductWithUnits() above.
 *
 * [FIX 5] `tx` widened to TxOrClient — this is the function whose call
 * site (`listProductsWithInventoryDetails(db, tenantId, whereClause)` in
 * the GET handler, called directly on the plain tenant-scoped client,
 * with no surrounding transaction) originally surfaced this whole class
 * of type error.
 *
 * Ordered by batch createdAt (never by conversionFactor — that field
 * name stays banned in this file; sort by it only happens inside
 * lib/inventory/units.ts, if ever needed).
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
                            // [FIX 7] كان `adjustedByUser: true` — صف User كامل
                            // بما فيه passwordHash. مضيّق الآن بنفس نمط `unit`
                            // أعلاه، ليطابق فعلياً النوع المُعلن
                            // InventoryBatchAdjustmentView.adjustedByUser.
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
 * row with a nested `.product` relation — see this file's header note on
 * why a caller must never receive that key directly.
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