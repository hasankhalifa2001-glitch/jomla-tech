/**
 * lib/data/store-reorder.ts
 *
 * The index behind "أعد طلبي الأخير". The retailer's last order lives only in
 * their browser, so to drop lines that are no longer orderable WITHOUT a network
 * request (spec §6.7), the home page ships a compact index of every currently
 * listable product/unit pair: key -> { names, wholesale price, currency }.
 *
 * Cached per tenant under the catalog tag, behind the tenant gate like every
 * other read. No stock, no cost, no barcode, no internal id beyond the pair.
 *
 * SIZE GUARD: the index is sent in the page HTML, so above
 * STORE_REORDER_INDEX_MAX_PRODUCTS listable products the feature is switched off
 * (an empty index hides the card). Owner-tunable; see the T5a report.
 */

import { unstable_cache } from "next/cache";
import { getTenantDb } from "@/lib/db/tenant-scope";
import { loadStorefrontCatalog, storeCatalogTag } from "@/lib/data/store";
import { listStorefrontUnitsForProducts } from "@/lib/data/products";
import { STORE_CATALOG_CACHE_SECONDS } from "@/lib/config/storefront";
import { serializeMoney } from "@/lib/utils/money";
import { lineKey } from "@/components/store/keys";
import type { CartLineBase } from "@/components/store/types";

export const STORE_REORDER_INDEX_MAX_PRODUCTS = 400;

export function getStorefrontReorderIndex(
    tenantId: string
): Promise<Record<string, CartLineBase>> {
    return unstable_cache(
        async () => {
            const list = await loadStorefrontCatalog(tenantId);
            if (list.length === 0 || list.length > STORE_REORDER_INDEX_MAX_PRODUCTS) return {};

            const db = getTenantDb(tenantId);
            const unitsByProduct = await listStorefrontUnitsForProducts(
                db,
                tenantId,
                list.map((p) => p.id)
            );

            const index: Record<string, CartLineBase> = {};
            for (const product of list) {
                for (const unit of unitsByProduct.get(product.id) ?? []) {
                    index[lineKey(product.id, unit.id)] = {
                        productId: product.id,
                        unitId: unit.id,
                        productName: product.name,
                        unitName: unit.unitName,
                        price: serializeMoney(unit.priceWholesale),
                        currency: unit.pricingCurrency,
                    };
                }
            }
            return index;
        },
        ["storefront-reorder-index", tenantId],
        { tags: [storeCatalogTag(tenantId)], revalidate: STORE_CATALOG_CACHE_SECONDS }
    )();
}