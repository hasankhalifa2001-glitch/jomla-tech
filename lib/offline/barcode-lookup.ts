// lib/offline/barcode-lookup.ts
//
// [NEW — T4b camera + hardware scanner integration]
// Offline-first barcode -> cart-line resolution, shared by BOTH scan
// surfaces added to the POS screen:
//   1. The camera scanner (BarcodeScannerModal, mode="continuous")
//   2. The hardware keyboard-wedge scanner (ProductCatalog's search-input
//      Enter handler, via PosLayout's onBarcodeEnter prop)
//
// [CORRECTED, final] Verified against the real lib/offline/db.ts,
// pos-service.ts, and index.ts barrel:
//   - CachedProductUnit is declared and exported from ./db — imported
//     from there directly, not from ./pos-service (which only imports it
//     for internal use and never re-exports it under its own name).
//   - PosProductItem and getOfflineProducts() are both declared and
//     exported from ./pos-service.
//   - Both are re-exported through lib/offline/index.ts's
//     `export * from "./db"` / `export * from "./pos-service"`, so
//     everywhere else in the app that already does
//     `import { type CachedProductUnit, type PosProductItem, getOfflineProducts } from "@/lib/offline"`
//     resolves to exactly these same declarations — this file's return
//     shape is identical to what the rest of the POS screen already
//     works with, not a parallel/incompatible shape.
//
// Deliberately calls getOfflineProducts() rather than reading raw
// CachedProduct rows off db.cachedProducts directly — getOfflineProducts()
// is the SAME function that already populates the POS screen's visible
// catalog, so reusing it guarantees:
//   1. The returned `product` is a genuine PosProductItem (has
//      totalCachedStock etc.), not a raw CachedProduct missing fields
//      handleAddToCart and other POS code expect.
//   2. Any product-level exclusion getOfflineProducts() already applies
//      is automatically honored here too (no second, separately
//      maintained inclusion rule to keep in sync with the catalog's own).
//   3. No duplicated base-unit/multi-batch/pending-offline-sale stock
//      math — getOfflineProducts() is the single place that logic lives.
//
// [v4.5 — MULTI-BARCODE] Resolution is now TWO steps, in this order:
//   1. ONE indexed point lookup on the flat `cachedProductBarcodes` table,
//      keyed [tenantId+barcode]. Dexie can only index TOP-LEVEL properties,
//      so a scan can never be answered efficiently by walking the nested
//      units[].barcodes arrays — which is exactly why that flat table exists.
//      It also makes a unit's SECOND, THIRD, ... barcode resolve exactly like
//      its first: the index holds one row per barcode.
//   2. The product/unit that row points at is fetched through
//      getOfflineProducts(), for every reason listed above.
// A hit whose product or unit is no longer in the catalog (e.g. the index is
// one refresh behind) resolves to `not_found`, never to a half-built result.
//
// Deliberately still calls getOfflineProducts(tenantId, "") — an empty search
// query — to force it to return the FULL local catalog rather than whatever
// text filter happens to currently be typed into the POS search box. This is
// precisely the fix for the "stale filtered list" bug: a hardware scanner's
// Enter can arrive before PosLayout's own debounced search effect has resolved
// against the box's current text, so matching against a partially-filtered
// `products` state (as the original ProductCatalog implementation did) could
// miss a real, in-stock item.

import { getOfflineDb } from "./db";
import { getOfflineProducts, type PosProductItem } from "./pos-service";
import type { CachedProductUnit } from "./db";

export type BarcodeLookupResult =
    | { status: "found"; product: PosProductItem; unit: CachedProductUnit }
    | { status: "unit_inactive"; product: PosProductItem; unit: CachedProductUnit }
    | { status: "not_found" };

/**
 * Resolves a scanned/typed barcode to the unit it belongs to, entirely from
 * the local cache. Works for ANY of a unit's barcodes.
 *
 * `cachedProductBarcodes` is unique on [tenantId+barcode], so at most one
 * row can ever match — the tenant scope is part of the key, not a filter
 * applied afterwards.
 */
export async function findProductUnitByBarcode(
    tenantId: string | undefined,
    barcode: string
): Promise<BarcodeLookupResult> {
    const trimmed = barcode.trim();
    if (!tenantId || !trimmed) return { status: "not_found" };

    // Step 1: one indexed point lookup — NOT a scan of nested arrays.
    const hit = await getOfflineDb().cachedProductBarcodes.get([tenantId, trimmed]);
    if (!hit) return { status: "not_found" };

    // Step 2: resolve the product/unit through the same reader the POS grid
    // uses, so stock math and catalog-level exclusions stay consistent.
    const products = await getOfflineProducts(tenantId, "");
    const product = products.find((p) => p.id === hit.productId);
    if (!product) return { status: "not_found" };

    const unit = product.units?.find((u) => u.id === hit.unitId);
    if (!unit) return { status: "not_found" };

    if (unit.isActive === false) {
        return { status: "unit_inactive", product, unit };
    }
    return { status: "found", product, unit };
}
