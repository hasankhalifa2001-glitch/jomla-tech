/**
 * Cache Population (Sync-Down)
 *
 * Implements T4a cache-refresh functions:
 * - refreshProductCache(tenantId): pulls products, units, and batches from the server and overwrites Dexie's cachedProducts.
 * - refreshCustomerCache(tenantId): pulls customers and balances from the server and overwrites Dexie's cachedCustomers.
 *
 * [DEVIATION — documented, not accidental] T1's spec text gives both
 * functions the signature `(tenantId): Promise<void>`. This file
 * deliberately returns `Promise<CacheRefreshResult>` instead: being
 * offline is an expected, quiet case ({ ok: false, reason: "offline" }),
 * but a real server error, a malformed response, or a failed Dexie write
 * is NOT the same thing and must not disappear into a bare `void` the
 * same way "offline" does. A caller (e.g. the app-load hook, or a manual
 * refresh button) can branch on `reason` to decide whether to show
 * nothing (offline) or surface a real failure to the user. Every caller
 * of these two functions in this codebase treats the return value as
 * optional to inspect — a caller that ignores it entirely still gets the
 * exact fire-and-forget behavior T1 specifies (no throw, no blocked app
 * load), so this is a strict superset of the literal spec, not a
 * narrower or incompatible one. Flagging here so this doesn't read as an
 * unnoticed drift from the spec text on a later pass.
 */

import {
  getOfflineDb,
  isOfflineDbSupported,
  createCachedProductRecord,
  createCachedCustomerRecord,
  type CachedProduct,
  type CachedProductBarcode,
  type CachedCustomer,
} from "./db";

export type CacheRefreshResult =
  | { ok: true }
  | { ok: false; reason: "no_tenant" | "unsupported" | "offline" | "fetch_failed" | "write_failed" };

interface ServerProductUnit {
  id: string;
  unitName: string;
  /**
   * [FIX] Was previously typed `number`. ProductUnit.conversionFactor is
   * a Decimal(18,4) column server-side (see schema.prisma) — same
   * precision class as priceWholesale right below, and the
   * exact field this whole codebase's Unit Conversion Architecture
   * treats as precision-critical (see lib/inventory/units.ts). The
   * server route (/api/inventory/products) now serializes this via
   * toDisplayUnits(), which always returns a decimal string — never a
   * native number — matching the actual contract this file must declare.
   */
  conversionFactor: string;
  pricingCurrency: "SYP" | "USD";
  priceWholesale: string;
  // [v4.5] REPLACED the old `barcode: string | null` / `barcodeSource` scalar
  // pair. The inventory GET returns the unit's full barcode list — zero, one,
  // or many rows, each with its own source. It ALSO still sends the deprecated
  // per-unit `barcode` scalar for one transition period; deliberately not read
  // here, since `barcodes` is authoritative whenever it is present (the
  // fallback below covers a response from an older server build).
  barcodes?: Array<{
    id: string;
    barcode: string;
    barcodeSource: "GS1" | "INTERNAL" | null;
  }> | null;
  barcode?: string | null;
  barcodeSource?: "GS1" | "INTERNAL" | null;
  isActive?: boolean;
}

interface ServerProductBatch {
  id: string;
  batchNumber: string;
  /**
   * [FIX] Was previously typed `number`. ProductBatch.quantity is a
   * Decimal(18,4) column server-side (see schema.prisma) — a weighed
   * product can carry a fractional remaining quantity, and a Prisma
   * Decimal converted to a native `number` on the server risks precision
   * loss on the exact same class of value this contract already protects
   * for priceWholesale above. The server route must serialize this with
   * .toString(), matching every other monetary/decimal-precision field in
   * this contract.
   */
  quantity: string;
  unitId: string;
  expiryDate: string | null;
}

interface ServerProduct {
  id: string;
  name: string;
  category: string | null;
  // [v4.6] Product-level image — one per product, replaces the old per-unit
  // imageUrl. Optional/null to stay forward-compatible with any older server
  // response that pre-dates this field.
  imageUrl?: string | null;
  isActive?: boolean;
  units: ServerProductUnit[];
  batches: ServerProductBatch[];
}

interface ServerProductsResponse {
  success: boolean;
  products: ServerProduct[];
}

interface ServerCustomer {
  id: string;
  tenantId: string;
  name: string;
  phone: string | null;
  shopName: string | null;
  // Same string-only contract as above — /api/customers already returns
  // these via toFixed(4)/serializeMoney, never a native number.
  cachedBalanceDebtSYP?: string;
  cachedBalanceDebtUSD?: string;
  isSystemGenerated?: boolean;
  /** [ADDED — offline credit-sale gate] See
   * CachedCustomer.hasPriorInvoices's doc comment in db.ts — true when
   * /api/customers found at least one Invoice for this customer. */
  hasPriorInvoices?: boolean;
}

interface ServerCustomersResponse {
  success: boolean;
  customers: ServerCustomer[];
}

function isOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

/**
 * Refreshes local Dexie product cache from the server for the given tenant.
 * Returns { ok: false, reason: "offline" } quietly when offline (expected,
 * not an error) — but a real fetch/response/write failure is reported back
 * via { ok: false, reason: "fetch_failed" | "write_failed" } rather than
 * disappearing into a bare catch. See the file-header DEVIATION note on
 * why this returns a result object rather than the spec's literal
 * `Promise<void>`.
 */
export async function refreshProductCache(tenantId: string): Promise<CacheRefreshResult> {
  if (!tenantId || !tenantId.trim()) return { ok: false, reason: "no_tenant" };
  if (!isOfflineDbSupported()) return { ok: false, reason: "unsupported" };
  if (isOffline()) return { ok: false, reason: "offline" };

  const scopedTenantId = tenantId.trim();

  let mapped: CachedProduct[];
  try {
    const res = await fetch("/api/inventory/products", { cache: "no-store" });
    if (!res.ok) {
      console.error(`refreshProductCache: server responded ${res.status}`);
      return { ok: false, reason: "fetch_failed" };
    }

    const data = (await res.json()) as ServerProductsResponse;
    if (!data.success || !Array.isArray(data.products)) {
      console.error("refreshProductCache: malformed response", data);
      return { ok: false, reason: "fetch_failed" };
    }

    mapped = data.products.map((p) =>
      createCachedProductRecord({
        tenantId: scopedTenantId,
        id: p.id,
        name: p.name,
        category: p.category || undefined,
        // [v4.6] Copy the product-level image. null / undefined both become
        // undefined in the cache (optional field) so offline readers that
        // have not yet refreshed simply get `undefined` and must tolerate it.
        imageUrl: p.imageUrl ?? undefined,
        isActive: p.isActive !== false,
        units: (p.units || []).map((u) => ({
          id: u.id,
          unitName: u.unitName,
          conversionFactor: u.conversionFactor,
          priceWholesale: u.priceWholesale,
          pricingCurrency: u.pricingCurrency,
          // [v4.5] The unit's full barcode list, with the deprecated scalar
          // pair accepted as a fallback so a response from an older server
          // build still caches a usable barcode. Each row keeps its server id.
          barcodes:
            u.barcodes && u.barcodes.length > 0
              ? u.barcodes.map((b) => ({
                id: b.id,
                barcode: b.barcode,
                barcodeSource: b.barcodeSource ?? undefined,
              }))
              : u.barcode
                ? [
                  {
                    // No server row id for a legacy scalar response — a stable
                    // local id keeps React keys working; the next refresh
                    // against a v4.5 server replaces it with the real id.
                    id: `legacy-${u.id}-${u.barcode}`,
                    barcode: u.barcode,
                    barcodeSource: u.barcodeSource ?? undefined,
                  },
                ]
                : [],
          isActive: u.isActive !== false,
        })),
        batches: (p.batches || []).map((b) => ({
          id: b.id,
          unitId: b.unitId,
          batchNumber: b.batchNumber,
          quantity: b.quantity,
          expiryDate: b.expiryDate ?? undefined,
        })),
      })
    );
  } catch (error) {
    // A real failure — network error mid-fetch, invalid JSON, or a bad
    // record rejected by createCachedProductRecord's own validation.
    // Distinct from "offline" (checked before we ever got here) and must
    // be surfaced, not swallowed.
    console.error("refreshProductCache: fetch/parse failed:", error);
    return { ok: false, reason: "fetch_failed" };
  }

  try {
    const db = getOfflineDb();

    // [v4.5] The FLAT barcode index is derived from exactly the records being
    // cached, inside the SAME transaction as cachedProducts — so the two can
    // never disagree, and a failed write rolls both back together. POS barcode
    // scans read THIS table, never the nested units[].barcodes arrays.
    const barcodeRows: CachedProductBarcode[] = [];
    for (const product of mapped) {
      for (const unit of product.units) {
        for (const b of unit.barcodes ?? []) {
          if (!b?.barcode) continue;
          barcodeRows.push({
            tenantId: scopedTenantId,
            barcode: b.barcode,
            productId: product.id,
            unitId: unit.id,
          });
        }
      }
    }

    await db.transaction("rw", db.cachedProducts, db.cachedProductBarcodes, async () => {
      await db.cachedProducts.where("tenantId").equals(scopedTenantId).delete();
      await db.cachedProductBarcodes.where("tenantId").equals(scopedTenantId).delete();
      if (mapped.length > 0) {
        await db.cachedProducts.bulkPut(mapped);
      }
      if (barcodeRows.length > 0) {
        await db.cachedProductBarcodes.bulkPut(barcodeRows);
      }
    });
    return { ok: true };
  } catch (error) {
    console.error("refreshProductCache: Dexie write failed:", error);
    return { ok: false, reason: "write_failed" };
  }
}

/**
 * Refreshes local Dexie customer cache from the server for the given tenant.
 * Same offline-vs-real-failure distinction as refreshProductCache above.
 */
export async function refreshCustomerCache(tenantId: string): Promise<CacheRefreshResult> {
  if (!tenantId || !tenantId.trim()) return { ok: false, reason: "no_tenant" };
  if (!isOfflineDbSupported()) return { ok: false, reason: "unsupported" };
  if (isOffline()) return { ok: false, reason: "offline" };

  const scopedTenantId = tenantId.trim();

  let mapped: CachedCustomer[];
  try {
    const res = await fetch("/api/customers", { cache: "no-store" });
    if (!res.ok) {
      console.error(`refreshCustomerCache: server responded ${res.status}`);
      return { ok: false, reason: "fetch_failed" };
    }

    const data = (await res.json()) as ServerCustomersResponse;
    if (!data.success || !Array.isArray(data.customers)) {
      console.error("refreshCustomerCache: malformed response", data);
      return { ok: false, reason: "fetch_failed" };
    }

    mapped = data.customers.map((c) =>
      createCachedCustomerRecord({
        tenantId: scopedTenantId,
        id: c.id,
        name: c.name,
        phone: c.phone || undefined,
        shopName: c.shopName || undefined,
        cachedBalanceDebtSYP: c.cachedBalanceDebtSYP ?? "0.0000",
        cachedBalanceDebtUSD: c.cachedBalanceDebtUSD,
        isSystemGenerated: c.isSystemGenerated ?? false,
        hasPriorInvoices: c.hasPriorInvoices === true,
      })
    );
  } catch (error) {
    console.error("refreshCustomerCache: fetch/parse failed:", error);
    return { ok: false, reason: "fetch_failed" };
  }

  try {
    const db = getOfflineDb();
    await db.transaction("rw", db.cachedCustomers, async () => {
      await db.cachedCustomers.where("tenantId").equals(scopedTenantId).delete();
      if (mapped.length > 0) {
        await db.cachedCustomers.bulkPut(mapped);
      }
    });
    return { ok: true };
  } catch (error) {
    console.error("refreshCustomerCache: Dexie write failed:", error);
    return { ok: false, reason: "write_failed" };
  }
}