/**
 * Product Pull-Sync (Server -> Dexie)
 *
 * Complements lib/offline/sync-worker.ts, which handles the OPPOSITE
 * direction (Dexie -> server, T4c). This file is the missing counterpart:
 * it pulls this tenant's live product catalog from GET /api/products and
 * replaces the tenant's slice of `cachedProducts` in Dexie with it.
 *
 * Deliberately named `product-sync.ts`, not `sync.ts`, to avoid any
 * confusion with `sync-worker.ts` (push direction) sitting in the same
 * folder.
 */

import {
    getOfflineDb,
    isOfflineDbSupported,
    createCachedProductRecord,
    type CachedProduct,
} from "./db";

interface ServerProductUnit {
    id: string;
    unitName: string;
    conversionFactor: number;
    pricingCurrency: "SYP" | "USD";
    priceWholesale: number;
    priceRetail: number | null;
    barcode: string | null;
    barcodeSource: "GS1" | "INTERNAL" | null;
    isActive?: boolean;
}

interface ServerProductBatch {
    id: string;
    batchNumber: string;
    quantity: number;
    unitId: string;
    expiryDate: string | null;
}

interface ServerProduct {
    id: string;
    name: string;
    category: string | null;
    units: ServerProductUnit[];
    batches: ServerProductBatch[];
}

interface ServerProductsResponse {
    success: boolean;
    products: ServerProduct[];
}

export interface ProductSyncResult {
    success: boolean;
    count: number;
    reason?: "OFFLINE" | "NO_TENANT" | "UNSUPPORTED" | "FETCH_FAILED";
}

/**
 * Pulls this tenant's live product catalog (units + batches) from
 * GET /api/products and replaces the tenant's slice of `cachedProducts`
 * in Dexie with it — a full replace (delete-then-bulkPut), not a merge,
 * so a product deactivated/removed server-side also disappears from the
 * offline cache instead of lingering forever.
 *
 * Deliberately silent-fail (returns success:false, never throws) on
 * "offline" or "fetch failed" — this is meant to be called opportunistically
 * (on POS mount, on reconnect) without interrupting a cashier who may be
 * legitimately offline. Callers that need to surface an error to the user
 * (e.g. a manual "sync now" button) should inspect the returned reason.
 */
export async function syncProductsFromServer(tenantId?: string): Promise<ProductSyncResult> {
    if (!tenantId || !tenantId.trim()) {
        return { success: false, count: 0, reason: "NO_TENANT" };
    }
    if (!isOfflineDbSupported()) {
        return { success: false, count: 0, reason: "UNSUPPORTED" };
    }
    if (typeof navigator !== "undefined" && !navigator.onLine) {
        return { success: false, count: 0, reason: "OFFLINE" };
    }

    const scopedTenantId = tenantId.trim();

    let data: ServerProductsResponse;
    try {
        const res = await fetch("/api/inventory/products", { cache: "no-store" });
        if (!res.ok) {
            return { success: false, count: 0, reason: "FETCH_FAILED" };
        }
        data = (await res.json()) as ServerProductsResponse;
    } catch {
        return { success: false, count: 0, reason: "FETCH_FAILED" };
    }

    if (!data.success || !Array.isArray(data.products)) {
        return { success: false, count: 0, reason: "FETCH_FAILED" };
    }

    const mapped: CachedProduct[] = data.products.map((p) =>
        createCachedProductRecord({
            tenantId: scopedTenantId,
            id: p.id,
            name: p.name,
            category: p.category || undefined,
            units: p.units.map((u) => ({
                id: u.id,
                unitName: u.unitName,
                conversionFactor: u.conversionFactor,
                priceWholesale: u.priceWholesale,
                priceRetail: u.priceRetail ?? undefined,
                pricingCurrency: u.pricingCurrency,
                barcode: u.barcode ?? undefined,
                barcodeSource: u.barcodeSource ?? undefined,
                isActive: u.isActive !== false,
            })),
            batches: p.batches.map((b) => ({
                id: b.id,
                unitId: b.unitId,
                batchNumber: b.batchNumber,
                quantity: b.quantity,
                expiryDate: b.expiryDate ?? undefined,
            })),
        })
    );

    const db = getOfflineDb();
    // Full replace, not a merge: a product removed/deactivated server-side
    // must also disappear from the offline cache, not linger forever.
    await db.transaction("rw", db.cachedProducts, async () => {
        await db.cachedProducts.where("tenantId").equals(scopedTenantId).delete();
        await db.cachedProducts.bulkPut(mapped);
    });

    return { success: true, count: mapped.length };
}