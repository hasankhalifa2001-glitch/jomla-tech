// lib/offline/barcode-lookup.ts
//
// [NEW — T4b camera + hardware scanner integration]
// [CORRECTED] The first draft of this file imported a non-existent named
// export `db` from "./db" (the actual module only exports `getOfflineDb()`
// and the `OfflineDatabase` class) and read raw `CachedProduct` rows
// straight off the `cachedProducts` Dexie table. `CachedProduct` (db.ts) is
// NOT the same shape as `PosProductItem` (pos-service.ts) — PosProductItem
// is a derived shape computed BY getOfflineProducts(), adding fields like
// `totalCachedStock` (multi-batch, base-unit stock breakdown) that do not
// exist on the raw cached row at all. Returning a raw CachedProduct where a
// PosProductItem is expected (handleAddToCart's signature) would either
// fail to compile or silently hand downstream code an object missing
// fields it relies on.
//
// Fixed by reusing getOfflineProducts() itself — the exact same function
// that already populates the POS screen's visible catalog — instead of
// re-implementing raw Dexie access here. This guarantees:
//   1. The returned `product` is a genuine, fully-computed PosProductItem,
//      identical in shape to every other product object already flowing
//      through the POS screen (cart, catalog cards, etc).
//   2. Any product-level exclusion getOfflineProducts() already applies
//      (e.g. a deactivated Product being absent from the POS catalog
//      entirely, per T3a) is automatically honored here too — there is no
//      second, separately-maintained inclusion/exclusion rule to keep in
//      sync with the catalog's own.
//   3. No duplicated base-unit/multi-batch stock math — getOfflineProducts
//      is the single place that logic lives.

import { getOfflineProducts, type PosProductItem, type CachedProductUnit } from "./pos-service";

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
 * Not indexed at the Dexie level — getOfflineProducts does an in-memory
 * pass over the tenant's cached catalog either way, and this adds one more
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