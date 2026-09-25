/**
 * lib/receipts/local-receipt-source.ts
 *
 * T4f — assembles a ReceiptSource for a DEVICE-LOCAL invoice (Rule 1's
 * "thermal printing reads from whichever local representation is
 * authoritative") with no network call of any kind.
 *
 * The one thing an offlineInvoices row does not carry is names: db.ts's
 * OfflineInvoiceItem stores only productId/unitId, because a sale is written
 * from the cart and the catalog is expected to stay cached. So this module
 * resolves display names from `cachedProducts` — the local catalog cache
 * T4a/T4b already maintain — and nothing else.
 *
 * [WHY cachedProducts IS READ DIRECTLY HERE, NOT getOfflineProducts()]
 * lib/offline/pos-service.ts's getOfflineProducts() is the POS *search/
 * browse* reader: it decorates every product with a freshly computed
 * totalCachedStock (subtracting pending offline sales) and filters by a query
 * string. Printing a receipt needs neither, and paying for that per-item
 * stock math on every print would be pure waste — so this does the narrow,
 * explicit lookup it actually needs (product id → name, unit id → unit name)
 * and says so. It is a read-only read of a cache table; no write path exists
 * here.
 */

import {
  getOfflineDb,
  isOfflineDbSupported,
  type OfflineInvoice,
  type OfflineInvoiceItem,
} from "@/lib/offline/db";
import {
  EMPTY_LOCAL_ITEM_NAMES,
  type LocalReceiptItemNames,
  type LocalReceiptSource,
} from "./receipt-model";

export async function resolveLocalReceiptItemNames(
  tenantId: string | undefined,
  items: OfflineInvoiceItem[]
): Promise<LocalReceiptItemNames> {
  if (!tenantId || !isOfflineDbSupported() || items.length === 0) {
    return EMPTY_LOCAL_ITEM_NAMES;
  }

  const neededProductIds = new Set(items.map((item) => item.productId));
  const neededUnitIds = new Set(items.map((item) => item.unitId));

  const products = await getOfflineDb()
    .cachedProducts.where("tenantId")
    .equals(tenantId)
    .toArray();

  const productNames: Record<string, string> = {};
  const unitNames: Record<string, string> = {};

  for (const product of products) {
    if (neededProductIds.has(product.id)) {
      productNames[product.id] = product.name;
    }
    for (const unit of product.units ?? []) {
      if (neededUnitIds.has(unit.id)) {
        unitNames[unit.id] = unit.unitName;
      }
    }
  }

  return { productNames, unitNames };
}

/**
 * The local-source builder every print path uses.
 *
 * `knownItemNames` is the post-checkout fast path: components/pos/pos-layout.tsx
 * still holds the cart's CartLineItem[] (which carries `product.name` and
 * `unitName`), so a receipt printed straight after a sale touches Dexie not at
 * all. Anywhere else, names are resolved from the local catalog.
 */
export async function buildLocalReceiptSource(params: {
  tenantId?: string;
  invoice: OfflineInvoice;
  customerName: string;
  knownItemNames?: LocalReceiptItemNames;
}): Promise<LocalReceiptSource> {
  const itemNames =
    params.knownItemNames ??
    (await resolveLocalReceiptItemNames(params.tenantId, params.invoice.items));

  return {
    source: "local",
    invoice: params.invoice,
    customerName: params.customerName,
    itemNames,
  };
}

/**
 * Builds a LocalReceiptItemNames map from already-fanned-out line identifiers.
 *
 * [WHY THIS TAKES FLAT IDS AND NOT A CartLineItem] `lib/**` is inside
 * eslint.config.mjs's BACKEND_ONLY_FILES scope, where PRODUCT_MODEL_RULES bans
 * any `.product` member access — a rule that exists to stop a Prisma relation
 * from being read outside the sanctioned data-access gateways, and which is
 * (correctly) blind to the difference between "a Prisma relation" and "a
 * frontend DTO that happens to have a `product` field". Reading
 * `line.product.id` here tripped it.
 *
 * The adaptation therefore belongs at the CALL SITE, in components/** — which
 * is deliberately outside that scope precisely because it only ever handles
 * pre-shaped DTOs (see eslint.config.mjs's module header). Callers map their
 * own cart lines into these four flat fields, which also keeps this module
 * free of any dependency on the POS cart's shape.
 */
export function itemNamesFromCartLines(
  lines: ReadonlyArray<{
    productId: string;
    productName: string;
    unitId: string;
    unitName: string;
  }>
): LocalReceiptItemNames {
  const productNames: Record<string, string> = {};
  const unitNames: Record<string, string> = {};

  for (const line of lines) {
    productNames[line.productId] = line.productName;
    unitNames[line.unitId] = line.unitName;
  }

  return { productNames, unitNames };
}
