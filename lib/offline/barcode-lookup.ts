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
// catalog, so reusing it here guarantees:
//   1. The returned `product` is a genuine PosProductItem (has
//      totalCachedStock etc.), not a raw CachedProduct missing fields
//      handleAddToCart and other POS code expect.
//   2. Any product-level exclusion getOfflineProducts() already applies
//      is automatically honored here too (no second, separately
//      maintained inclusion rule to keep in sync with the catalog's own).
//   3. No duplicated base-unit/multi-batch/pending-offline-sale stock
//      math — getOfflineProducts() is the single place that logic lives.

import { getOfflineProducts, type PosProductItem } from "./pos-service";
import type { CachedProductUnit } from "./db";

export type BarcodeLookupResult =
    | { status: "found"; product: PosProductItem; unit: CachedProductUnit }
    | { status: "unit_inactive"; product: PosProductItem; unit: CachedProductUnit }
    | { status: "not_found" };

/**
 * Scans this tenant's locally cached, fully-computed product catalog (via
 * getOfflineProducts — the SAME source of truth the visible POS grid uses)
 * for a unit whose `barcode` matches exactly. Barcode uniqueness is
 * enforced tenant-wide at the schema level (ProductUnit is unique on
 * (tenantId, barcode)), so at most one product/unit pair can ever match.
 *
 * Deliberately calls getOfflineProducts(tenantId, "") — an empty search
 * query — to force it to return the FULL local catalog rather than
 * whatever text filter happens to currently be typed into the POS search
 * box. This is precisely the fix for the "stale filtered list" bug: a
 * hardware scanner's Enter can arrive before PosLayout's own debounced
 * search effect has resolved against the box's current text, so matching
 * against a partially-filtered `products` state (as the original
 * ProductCatalog implementation did) could miss a real, in-stock item.
 *
 * Not indexed at the Dexie level — getOfflineProducts already does an
 * in-memory pass over the tenant's cached catalog either way (including
 * its own pending-offline-sale stock adjustment); this adds one more
 * in-memory `.find()` per product on top of work already being done. Fine
 * at the catalog sizes this app targets; revisit only if ever measured to
 * be a real bottleneck.
 */
export async function findProductUnitByBarcode(
    tenantId: string | undefined,
    barcode: string
): Promise<BarcodeLookupResult> {
    const trimmed = barcode.trim();
    if (!tenantId || !trimmed) return { status: "not_found" };

    const products = await getOfflineProducts(tenantId, "");

    for (const product of products) {
        const unit = product.units?.find((u) => u.barcode && u.barcode === trimmed);
        if (!unit) continue;

        if (unit.isActive === false) {
            return { status: "unit_inactive", product, unit };
        }
        return { status: "found", product, unit };
    }

    return { status: "not_found" };
}