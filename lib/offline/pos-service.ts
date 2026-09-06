/**
 * POS Service for Offline Operations (T4b)
 *
 * Interacts directly and exclusively with Dexie IndexedDB tables:
 * - cachedProducts: Product catalog with units and batch quantities
 * - cachedCustomers: Synced existing customer records
 * - offlineCustomers: Locally created walk-in customer records
 * - offlineInvoices: Completed offline sales queue
 * - cachedTenantSettings: Daily exchange rate
 *
 * TENANT SCOPING POLICY:
 * - WRITE paths (submitOfflineSale, createOfflineWalkInCustomer,
 *   seedSampleOfflineData) require a real, non-empty tenantId and throw
 *   otherwise. A write is the only path that can create durable,
 *   tenant-attributable data — falling back to a shared sentinel key here
 *   risks silently filing a real sale, customer, or seeded demo data under
 *   a bucket no legitimate tenant will ever query again.
 * - READ paths (getOfflineProducts, getOfflineCustomers,
 *   getOfflineInvoicesList, findMatchingCustomerByPhone) fall back to a
 *   shared sentinel key via resolveTenantId() when no tenantId is given.
 *   A read can only ever return an empty/default result in that state —
 *   it cannot create or corrupt tenant data — so this is safe for a
 *   pre-login or mid-hydration UI state without forcing every read call
 *   site to guard against a not-yet-available session.
 *
 * [v3.6] CURRENCY RE-ANCHORING — mirrors schema.prisma and db.ts. SYP is
 * now the authoritative currency for cart line items, cart totals, and
 * the sale payload. USD fields are derived/display-only, computed from
 * the SYP figure via the cached exchange rate, and are `null` whenever no
 * exchange rate is cached yet — unlike SYP, USD must never throw just
 * because a rate is missing, since it no longer gates anything.
 */

import {
  getOfflineDb,
  isOfflineDbSupported,
  createOfflineCustomerRecord,
  createOfflineInvoiceRecord,
  createCachedProductRecord,
  createCachedCustomerRecord,
  type PaymentMethod,
  type CachedProduct,
  type CachedCustomer,
  type CachedProductUnit,
  type OfflineInvoice,
} from "./db";
import { setCachedDailyExchangeRate, DEFAULT_TENANT_CACHE_KEY } from "./exchange-rate";
import { generateOfflineId } from "./id";
import {
  compareMoney,
  toDecimal,
  multiplyMoney,
  sumMoney,
  convertCurrency,
  serializeMoney,
  subtractMoney,
  type MoneyInput,
} from "../utils/money";

export interface PosProductItem extends CachedProduct {
  totalCachedStock: number;
}

export interface SelectedCustomer {
  type: "EXISTING" | "WALK_IN" | "SYSTEM";
  id: string;
  name: string;
  phone?: string;
  shopName?: string;
  // [v3.6] AUTHORITATIVE.
  balanceDebtSYP?: number;
  // [v3.6] Derived/informational, when available.
  balanceDebtUSD?: number;
  isSystemGenerated?: boolean;
}

export interface CartLineItem {
  id: string;
  product: CachedProduct;
  unitId: string;
  unitName: string;
  conversionFactor: number;
  quantity: number;
  // [v3.6] AUTHORITATIVE.
  unitPriceSYP: string;
  // [v3.6] Derived/informational — null if no exchange rate was cached
  // when this line was added to the cart.
  unitPriceUSD: string | null;
  priceRetailSYP?: string;
  priceRetailUSD?: string | null;
}

export interface CartTotalsResult {
  // [v3.6] AUTHORITATIVE — always computable, since every line's
  // unitPriceSYP was already resolved (with a rate, if needed) at
  // add-to-cart time.
  totalSYP: string;
  // [v3.6] Derived/informational — null only if the caller passes no
  // exchange rate to this function itself (e.g. rendering the cart
  // before a rate has loaded).
  totalUSD: string | null;
  itemCount: number;
  lineItems: Array<{
    id: string;
    lineTotalSYP: string;
    lineTotalUSD: string | null;
  }>;
}

export interface OfflineSalePayload {
  customer?: SelectedCustomer | null;
  items: CartLineItem[];
  // [v3.6] AUTHORITATIVE fields only. totalUSD/paidAmountUSD/debtAmountUSD
  // are deliberately NOT part of this payload anymore — they're derived
  // downstream by createOfflineInvoiceRecord from these SYP figures plus
  // exchangeRateUsed, removing the possibility of two independently-
  // supplied numbers drifting apart (see the removed cross-check note in
  // submitOfflineSale below).
  totalSYP: MoneyInput;
  exchangeRateUsed: MoneyInput;
  paidAmountSYP: MoneyInput;
  debtAmountSYP: MoneyInput;
  paymentMethod?: PaymentMethod;
}

export interface DuplicatePhoneMatch {
  customer: SelectedCustomer;
  source: "CACHED" | "OFFLINE" | "ONLINE";
}

// ============================================================================
// [FIX] Stock-display helpers.
//
// ProductBatch/CachedProductBatch.quantity is stored in whatever unit that
// specific batch was recorded in (a batch recorded as "5 كرتونة" stores
// quantity: 5, NOT 5 × conversionFactor). Any code that needs a single
// TOTAL figure across batches recorded in different units (e.g. one batch
// in كرتونة, another in قطعة, for the same product) MUST convert each
// batch to the product's base unit (conversionFactor === 1) via its own
// unit's conversionFactor BEFORE summing — never sum raw `quantity`
// values across batches blindly, since that silently treats "5 كرتونة"
// and "5 قطعة" as the same 5.
// ============================================================================

export interface StockBreakdownPart {
  unitName: string;
  count: number;
}

/**
 * Breaks a total, base-unit stock quantity into a human-readable
 * multi-unit breakdown — largest packaging unit first, remainder in
 * smaller units, down to the base (conversionFactor === 1) unit. e.g. for
 * a product with "قطعة" (factor 1) and "كرتونة" (factor 12), a
 * totalBaseQuantity of 65 becomes [{count: 5, unitName: "كرتونة"},
 * {count: 5, unitName: "قطعة"}].
 *
 * Deliberately unit-name-agnostic (works for "شوال"/"طرد"/"باكيت", not
 * just "كرتونة"/"قطعة") since ProductUnit.unitName is merchant-defined
 * free text, not a fixed enum.
 */
export function breakdownStockByUnits(
  totalBaseQuantity: number,
  units: CachedProductUnit[]
): StockBreakdownPart[] {
  if (!totalBaseQuantity || totalBaseQuantity <= 0) return [];

  if (!units || units.length === 0) {
    return [{ unitName: "قطعة", count: totalBaseQuantity }];
  }

  // Sort descending by conversionFactor so we greedily divide from the
  // largest packaging unit down to the smallest.
  const sortedUnits = [...units].sort(
    (a, b) => (Number(b.conversionFactor) || 1) - (Number(a.conversionFactor) || 1)
  );

  let remaining = totalBaseQuantity;
  const parts: StockBreakdownPart[] = [];

  for (const unit of sortedUnits) {
    const factor = Number(unit.conversionFactor) || 1;
    if (factor <= 1) continue; // base unit is handled explicitly below
    const count = Math.floor(remaining / factor);
    if (count > 0) {
      parts.push({ unitName: unit.unitName, count });
      remaining -= count * factor;
    }
  }

  // Whatever's left over is expressed in the base unit — even if that's
  // the whole quantity (product has no packaging unit above factor 1).
  const baseUnit = sortedUnits.find((u) => (Number(u.conversionFactor) || 1) === 1);
  if (remaining > 0 || parts.length === 0) {
    parts.push({
      unitName: baseUnit ? baseUnit.unitName : "قطعة",
      count: remaining,
    });
  }

  return parts;
}

/** Renders a StockBreakdownPart[] as e.g. "5 كرتونة و5 قطعة". */
export function formatStockBreakdown(parts: StockBreakdownPart[]): string {
  if (parts.length === 0) return "0";
  return parts.map((p) => `${p.count} ${p.unitName}`).join(" و");
}

export function isSystemCashCustomer(customer?: SelectedCustomer | null): boolean {
  if (!customer) return false;
  return customer.type === "SYSTEM" || !!customer.isSystemGenerated;
}

export function normalizeCustomerPhone(phone: string): string {
  return phone.trim().replace(/\s+/g, "");
}

function cachedCustomerToSelected(c: CachedCustomer): SelectedCustomer {
  return {
    type: c.isSystemGenerated ? "SYSTEM" : "EXISTING",
    id: c.id,
    name: c.name,
    phone: c.phone,
    shopName: c.shopName,
    balanceDebtSYP: toDecimal(c.cachedBalanceDebtSYP).toNumber(),
    balanceDebtUSD:
      c.cachedBalanceDebtUSD !== undefined ? toDecimal(c.cachedBalanceDebtUSD).toNumber() : undefined,
    isSystemGenerated: c.isSystemGenerated,
  };
}

// Used by READ paths only — see the tenant-scoping policy note above.
function resolveTenantId(tenantId?: string): string {
  return tenantId && tenantId.trim() ? tenantId.trim() : DEFAULT_TENANT_CACHE_KEY;
}

export function calculateCartTotals(
  items: CartLineItem[],
  exchangeRate: MoneyInput | null
): CartTotalsResult {
  let itemCount = 0;
  const lineItems: CartTotalsResult["lineItems"] = [];
  const lineTotalsSYP: string[] = [];

  const hasValidRate = exchangeRate !== null && compareMoney(exchangeRate, 0) > 0;

  for (const item of items) {
    itemCount += item.quantity;
    const lineTotalSYP = multiplyMoney(item.unitPriceSYP, item.quantity);
    lineTotalsSYP.push(lineTotalSYP);

    let lineTotalUSD: string | null = null;
    if (hasValidRate) {
      lineTotalUSD = convertCurrency(lineTotalSYP, exchangeRate, "SYP", "USD");
    }

    lineItems.push({
      id: item.id,
      lineTotalSYP,
      lineTotalUSD,
    });
  }

  const totalSYP = sumMoney(lineTotalsSYP);
  const totalUSD = hasValidRate ? convertCurrency(totalSYP, exchangeRate, "SYP", "USD") : null;

  return {
    totalSYP,
    totalUSD,
    itemCount,
    lineItems,
  };
}

/**
 * Resolves the billed wholesale price for a product unit in SYP.
 * Always selects priceWholesale (never priceRetail).
 *
 * [v3.6] AUTHORITATIVE resolver. A rate is only required when the unit is
 * priced in USD (to convert it into SYP) — a unit already priced in SYP
 * resolves with no rate needed at all, the reverse of the pre-v3.6
 * direction.
 */
export function resolveUnitPriceSYP(
  unit: CachedProductUnit,
  product?: CachedProduct,
  exchangeRate?: MoneyInput | null
): string {
  if (unit.pricingCurrency !== "SYP" && unit.pricingCurrency !== "USD") {
    throw new Error(
      "لا يمكن تحديد عملة التسعير لهذه الوحدة (SYP أو USD) — يرجى مزامنة بيانات المنتج أو مراجعته."
    );
  }

  if (unit.pricingCurrency === "USD") {
    if (!exchangeRate || compareMoney(exchangeRate, 0) <= 0) {
      throw new Error(
        "لا يمكن احتساب سعر هذا المنتج بالليرة السورية لأنه مسعّر بالدولار ولا يوجد سعر صرف يومي محفوظ حالياً."
      );
    }
    return convertCurrency(unit.priceWholesale, exchangeRate, "USD", "SYP");
  }

  const rawPrice = unit.priceWholesale ?? product?.priceWholesale;
  if (rawPrice === undefined || rawPrice === null) {
    throw new Error(
      "لا يوجد سعر جملة محدد لهذه الوحدة — لا يمكن إضافتها إلى السلة. الرجاء مراجعة بيانات المنتج."
    );
  }
  return serializeMoney(rawPrice);
}

/**
 * Resolves the same unit's price in USD, for DISPLAY ONLY.
 *
 * [v3.6] Never throws for a missing rate — unlike resolveUnitPriceSYP,
 * USD no longer gates anything, so a missing rate simply means "no USD
 * figure to show yet" (null), not a blocked action.
 */
export function resolveUnitPriceUSD(
  unit: CachedProductUnit,
  product?: CachedProduct,
  exchangeRate?: MoneyInput | null
): string | null {
  if (!exchangeRate || compareMoney(exchangeRate, 0) <= 0) {
    return null;
  }
  const priceSYP = resolveUnitPriceSYP(unit, product, exchangeRate);
  return convertCurrency(priceSYP, exchangeRate, "SYP", "USD");
}

/**
 * Resolves billed wholesale (always) and optional retail (display-only) in
 * both SYP (authoritative) and USD (derived). Uses the same currency
 * conversion path as the catalog so USD-priced units are never written
 * into the cart as if they were already SYP.
 */
export function resolveCartLinePrices(
  unit: CachedProductUnit,
  product: CachedProduct,
  exchangeRate?: MoneyInput | null
): {
  unitPriceSYP: string;
  unitPriceUSD: string | null;
  priceRetailSYP?: string;
  priceRetailUSD?: string | null;
} {
  const unitPriceSYP = resolveUnitPriceSYP(unit, product, exchangeRate);
  const unitPriceUSD = resolveUnitPriceUSD(unit, product, exchangeRate);

  if (unit.priceRetail === undefined || unit.priceRetail === null || unit.priceRetail === "") {
    return { unitPriceSYP, unitPriceUSD };
  }

  const retailUnit = { ...unit, priceWholesale: unit.priceRetail };
  const priceRetailSYP = resolveUnitPriceSYP(retailUnit, product, exchangeRate);
  const priceRetailUSD = resolveUnitPriceUSD(retailUnit, product, exchangeRate);
  return { unitPriceSYP, unitPriceUSD, priceRetailSYP, priceRetailUSD };
}

export async function getOfflineProducts(
  tenantId?: string,
  query?: string
): Promise<PosProductItem[]> {
  const scopedTenantId = resolveTenantId(tenantId);
  if (!isOfflineDbSupported()) return [];

  const db = getOfflineDb();
  const products = await db.cachedProducts.where("tenantId").equals(scopedTenantId).toArray();

  const enriched: PosProductItem[] = products.map((p) => {
    // [FIX — critical] Each batch's `quantity` is recorded in ITS OWN
    // unit (via batch.unitId), not necessarily the product's base unit.
    // Summing raw quantities across batches recorded in different units
    // (e.g. one batch of "5 كرتونة", another of "5 قطعة") previously
    // produced 5 + 5 = 10 instead of the correct 5×12 + 5 = 65. Every
    // batch must be converted to the base unit via its own unit's
    // conversionFactor BEFORE summing.
    const unitById = new Map(p.units.map((u) => [u.id, u]));
    const totalStock = (p.batches || []).reduce((acc, b) => {
      const unit = unitById.get(b.unitId);
      const factor = unit ? Number(unit.conversionFactor) || 1 : 1;
      return acc + (Number(b.quantity) || 0) * factor;
    }, 0);
    return {
      ...p,
      totalCachedStock: totalStock,
    };
  });

  if (!query || !query.trim()) {
    return enriched;
  }

  const cleanQuery = query.trim().toLowerCase();
  return enriched.filter((p) => {
    if (p.name.toLowerCase().includes(cleanQuery)) return true;
    if (
      p.units?.some(
        (u) =>
          u.unitName.toLowerCase().includes(cleanQuery) ||
          (u.barcode && u.barcode.toLowerCase().includes(cleanQuery))
      )
    ) {
      return true;
    }
    return false;
  });
}

export async function getOfflineCustomers(
  tenantId?: string,
  query?: string
): Promise<SelectedCustomer[]> {
  const scopedTenantId = resolveTenantId(tenantId);
  if (!isOfflineDbSupported()) return [];

  const db = getOfflineDb();
  const [cachedList, offlineList] = await Promise.all([
    db.cachedCustomers.where("tenantId").equals(scopedTenantId).toArray(),
    db.offlineCustomers.where("tenantId").equals(scopedTenantId).toArray(),
  ]);

  const all: SelectedCustomer[] = [
    ...cachedList.map(cachedCustomerToSelected),
    ...offlineList.map((c) => ({
      type: "WALK_IN" as const,
      id: c.offlineId,
      name: c.name,
      phone: c.phone,
      shopName: c.shopName,
      balanceDebtSYP: 0,
      isSystemGenerated: false,
    })),
  ];

  if (!query || !query.trim()) {
    return all;
  }

  const clean = query.trim().toLowerCase();
  return all.filter(
    (c) =>
      c.name.toLowerCase().includes(clean) ||
      (c.shopName && c.shopName.toLowerCase().includes(clean)) ||
      (c.phone && c.phone.toLowerCase().includes(clean))
  );
}

export async function findMatchingCustomerByPhone(
  tenantId?: string,
  phone?: string
): Promise<DuplicatePhoneMatch | null> {
  if (!phone || !phone.trim()) return null;
  const cleanPhone = normalizeCustomerPhone(phone);
  if (!cleanPhone) return null;
  const scopedTenantId = resolveTenantId(tenantId);

  if (isOfflineDbSupported()) {
    const db = getOfflineDb();

    const cachedMatch = await db.cachedCustomers
      .where("tenantId")
      .equals(scopedTenantId)
      .filter((c) => !!c.phone && normalizeCustomerPhone(c.phone) === cleanPhone)
      .first();

    if (cachedMatch) {
      return {
        customer: cachedCustomerToSelected(cachedMatch),
        source: "CACHED",
      };
    }

    const offlineMatch = await db.offlineCustomers
      .where("tenantId")
      .equals(scopedTenantId)
      .filter((c) => !!c.phone && normalizeCustomerPhone(c.phone) === cleanPhone)
      .first();

    if (offlineMatch) {
      return {
        customer: {
          type: "WALK_IN",
          id: offlineMatch.offlineId,
          name: offlineMatch.name,
          phone: offlineMatch.phone,
          shopName: offlineMatch.shopName,
          balanceDebtSYP: 0,
          isSystemGenerated: false,
        },
        source: "OFFLINE",
      };
    }
  }

  if (typeof window !== "undefined" && typeof navigator !== "undefined" && navigator.onLine) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(`/api/customers/lookup?phone=${encodeURIComponent(cleanPhone)}`, {
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (res.ok) {
        const data = await res.json();
        if (data.customer) {
          return {
            customer: {
              type: data.customer.isSystemGenerated ? "SYSTEM" : "EXISTING",
              id: data.customer.id,
              name: data.customer.name,
              phone: data.customer.phone,
              shopName: data.customer.shopName,
              balanceDebtSYP: 0,
              isSystemGenerated: data.customer.isSystemGenerated,
            },
            source: "ONLINE",
          };
        }
      }
    } catch {
      // Network error or abort — ignore silently and rely on offline check
    }
  }

  return null;
}

export async function getSystemCashCustomer(
  tenantId?: string
): Promise<SelectedCustomer | null> {
  const scopedTenantId = resolveTenantId(tenantId);
  if (!isOfflineDbSupported()) return null;

  const db = getOfflineDb();
  const match = await db.cachedCustomers
    .where("tenantId")
    .equals(scopedTenantId)
    .filter((c) => !!c.isSystemGenerated)
    .first();

  return match ? cachedCustomerToSelected(match) : null;
}

export async function createOfflineWalkInCustomer(
  tenantId: string | undefined,
  data: {
    name: string;
    phone?: string;
    shopName?: string;
  }
): Promise<SelectedCustomer> {
  if (!tenantId || !tenantId.trim()) {
    throw new Error("لا يمكن إنشاء زبون جديد دون تحديد هوية المتجر (تسجيل الدخول مطلوب).");
  }
  const scopedTenantId = tenantId.trim();

  if (!isOfflineDbSupported()) {
    throw new Error("IndexedDB is not supported in this browser environment.");
  }
  if (!data.name || !data.name.trim()) {
    throw new Error("اسم الزبون مطلوب.");
  }

  const db = getOfflineDb();
  const newCustomerRecord = createOfflineCustomerRecord({
    tenantId: scopedTenantId,
    name: data.name.trim(),
    phone: data.phone?.trim() || undefined,
    shopName: data.shopName?.trim() || undefined,
  });

  await db.offlineCustomers.add(newCustomerRecord);

  return {
    type: "WALK_IN",
    id: newCustomerRecord.offlineId,
    name: newCustomerRecord.name,
    phone: newCustomerRecord.phone,
    shopName: newCustomerRecord.shopName,
    balanceDebtSYP: 0,
    isSystemGenerated: false,
  };
}

export async function submitOfflineSale(
  tenantId: string | undefined,
  payload: OfflineSalePayload
): Promise<OfflineInvoice> {
  if (!tenantId || !tenantId.trim()) {
    throw new Error("لا يمكن إتمام عملية البيع دون تحديد هوية المتجر (تسجيل الدخول مطلوب).");
  }
  const scopedTenantId = tenantId.trim();

  if (!isOfflineDbSupported()) {
    throw new Error("IndexedDB is not supported.");
  }

  if (!payload.items || payload.items.length === 0) {
    throw new Error("لا يمكن إتمام عملية البيع لسلة فارغة.");
  }

  if (compareMoney(payload.exchangeRateUsed, 0) <= 0) {
    throw new Error("لا يمكن إتمام البيع بدون تحديد سعر الصرف اليومي.");
  }

  // [v3.6] AUTHORITATIVE check now runs on debtAmountSYP.
  const hasDebt = compareMoney(payload.debtAmountSYP, 0) > 0;
  let customer = payload.customer ?? null;

  if (hasDebt && (!customer || isSystemCashCustomer(customer))) {
    throw new Error("البيع على الحساب أو الدفع الجزئي يتطلب اختيار أو تسجيل زبون حقيقي.");
  }

  if (!customer || isSystemCashCustomer(customer)) {
    const system =
      customer && customer.id ? customer : await getSystemCashCustomer(scopedTenantId);
    if (!system || !system.id) {
      throw new Error(
        "لا يوجد زبون نقدي نظامي في الذاكرة المحلية. يرجى مزامنة بيانات الزبائن أو تحميل البيانات التجريبية."
      );
    }
    customer = system;
  }

  // [v3.6] AUTHORITATIVE check now runs entirely in SYP.
  const expectedDebt = subtractMoney(payload.totalSYP, payload.paidAmountSYP);
  if (compareMoney(expectedDebt, payload.debtAmountSYP) !== 0) {
    throw new Error(
      "قيمة الدين المحسوبة لا تطابق الفرق بين إجمالي الفاتورة بالليرة والمبلغ المدفوع بالليرة — يرجى مراجعة حسابات السلة قبل المتابعة."
    );
  }

  // [v3.6] REMOVED: the old cross-check that compared a caller-supplied
  // totalUSD against totalSYP ÷ rate. There is no longer a second,
  // independently-supplied USD figure for it to drift from —
  // createOfflineInvoiceRecord (db.ts) now derives totalUSD/paidAmountUSD/
  // debtAmountUSD itself, from these exact SYP figures and this exact
  // exchangeRateUsed, so a mismatch is structurally impossible rather
  // than something this function has to catch after the fact.

  const invoiceItems = payload.items.map((item) => ({
    productId: item.product.id,
    unitId: item.unitId,
    quantity: item.quantity,
    unitPriceSYP: item.unitPriceSYP,
  }));

  const isWalkIn = customer.type === "WALK_IN";
  const customerId = !isWalkIn ? customer.id : undefined;
  const offlineCustomerId = isWalkIn ? customer.id : undefined;

  const invoiceRecord = createOfflineInvoiceRecord({
    tenantId: scopedTenantId,
    offlineId: generateOfflineId(),
    customerId,
    offlineCustomerId,
    items: invoiceItems,
    totalSYP: payload.totalSYP,
    exchangeRateUsed: payload.exchangeRateUsed,
    paidAmountSYP: payload.paidAmountSYP,
    debtAmountSYP: payload.debtAmountSYP,
    paymentMethod: payload.paymentMethod,
    createdAt: new Date(),
    status: "PENDING",
  });

  const db = getOfflineDb();
  await db.offlineInvoices.add(invoiceRecord);

  return invoiceRecord;
}

export async function getOfflineInvoicesList(tenantId?: string): Promise<OfflineInvoice[]> {
  const scopedTenantId = resolveTenantId(tenantId);
  if (!isOfflineDbSupported()) return [];

  const db = getOfflineDb();
  const items = await db.offlineInvoices.where("tenantId").equals(scopedTenantId).toArray();
  return items.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

/**
 * `tenantId` is REQUIRED, not optional with a sentinel fallback. This
 * function performs real writes (bulkPut into cachedProducts /
 * cachedCustomers) — unlike the pure-read functions above, running it
 * without a real tenantId would durably seed demo data under the shared
 * "global_tenant" bucket, where it would then silently satisfy any FUTURE
 * read that also forgot to pass a real tenantId (masking that bug instead
 * of surfacing it) and would never be cleaned up by any per-tenant flow.
 */
export async function seedSampleOfflineData(tenantId: string): Promise<void> {
  if (!tenantId || !tenantId.trim()) {
    throw new Error("لا يمكن تحميل بيانات تجريبية دون تحديد هوية المتجر (تسجيل الدخول مطلوب).");
  }
  const scopedTenantId = tenantId.trim();

  if (!isOfflineDbSupported()) return;

  const db = getOfflineDb();
  const productCount = await db.cachedProducts.where("tenantId").equals(scopedTenantId).count();

  if (productCount === 0) {
    const sampleProducts: CachedProduct[] = [
      createCachedProductRecord({
        tenantId: scopedTenantId,
        id: "prod-1",
        name: "سكر أبيض ناعم (الأسرة)",
        priceWholesale: 1.2,
        units: [
          { id: "unit-1-1", unitName: "كيس (1 كغ)", conversionFactor: 1, pricingCurrency: "USD", priceWholesale: 1.2, priceRetail: 1.5, barcode: "6291001001" },
          { id: "unit-1-2", unitName: "شوال (10 كغ)", conversionFactor: 10, pricingCurrency: "USD", priceWholesale: 11.5, priceRetail: 14.0, barcode: "6291001002" },
          { id: "unit-1-3", unitName: "شوال كبير (50 كغ)", conversionFactor: 50, pricingCurrency: "USD", priceWholesale: 55.0, barcode: "6291001003" },
        ],
        batches: [
          { id: "batch-1-1", unitId: "unit-1-1", batchNumber: "B2026-01", quantity: 150, expiryDate: "2027-01-01" },
          { id: "batch-1-2", unitId: "unit-1-2", batchNumber: "B2026-02", quantity: 40, expiryDate: "2027-06-01" },
        ],
      }),
      createCachedProductRecord({
        tenantId: scopedTenantId,
        id: "prod-2",
        name: "زيت دوار الشمس (عافية 1.5 لتر)",
        priceWholesale: 3.5,
        units: [
          { id: "unit-2-1", unitName: "عبوة (1.5 لتر)", conversionFactor: 1, pricingCurrency: "USD", priceWholesale: 3.5, priceRetail: 4.2, barcode: "6292002001" },
          { id: "unit-2-2", unitName: "كرتونة (6 عبوات)", conversionFactor: 6, pricingCurrency: "USD", priceWholesale: 20.0, priceRetail: 24.0, barcode: "6292002002" },
        ],
        batches: [
          { id: "batch-2-1", unitId: "unit-2-1", batchNumber: "AF-998", quantity: 85, expiryDate: "2026-12-31" },
        ],
      }),
      createCachedProductRecord({
        tenantId: scopedTenantId,
        id: "prod-3",
        name: "شاي أسود فرط (الكبوس 450 غرام)",
        priceWholesale: 4.8,
        units: [
          { id: "unit-3-1", unitName: "باكيت (450 غ)", conversionFactor: 1, pricingCurrency: "USD", priceWholesale: 4.8, priceRetail: 5.5, barcode: "6293003001" },
          { id: "unit-3-2", unitName: "كرتونة (24 باكيت)", conversionFactor: 24, pricingCurrency: "USD", priceWholesale: 110.0, barcode: "6293003002" },
        ],
        batches: [
          { id: "batch-3-1", unitId: "unit-3-1", batchNumber: "KBS-44", quantity: 60, expiryDate: "2028-02-15" },
        ],
      }),
      createCachedProductRecord({
        tenantId: scopedTenantId,
        id: "prod-4",
        name: "أرز بسمتي هندي (أبو كاس 5 كغ)",
        priceWholesale: 8.5,
        units: [
          { id: "unit-4-1", unitName: "كيس (5 كغ)", conversionFactor: 1, pricingCurrency: "USD", priceWholesale: 8.5, priceRetail: 10.0, barcode: "6294004001" },
          { id: "unit-4-2", unitName: "كرتونة (4 أكياس)", conversionFactor: 4, pricingCurrency: "USD", priceWholesale: 33.0, barcode: "6294004002" },
        ],
        batches: [
          { id: "batch-4-1", unitId: "unit-4-1", batchNumber: "RICE-2026", quantity: 120, expiryDate: "2027-09-30" },
        ],
      }),
      createCachedProductRecord({
        tenantId: scopedTenantId,
        id: "prod-5",
        name: "حليب مجفف كامل الدسم (نيدو 900 غرام)",
        priceWholesale: 7.2,
        units: [
          { id: "unit-5-1", unitName: "علبة (900 غ)", conversionFactor: 1, pricingCurrency: "USD", priceWholesale: 7.2, priceRetail: 8.5, barcode: "6295005001" },
          { id: "unit-5-2", unitName: "كرتونة (12 علبة)", conversionFactor: 12, pricingCurrency: "USD", priceWholesale: 84.0, barcode: "6295005002" },
        ],
        batches: [
          { id: "batch-5-1", unitId: "unit-5-1", batchNumber: "NID-110", quantity: 45, expiryDate: "2026-11-20" },
        ],
      }),
      createCachedProductRecord({
        tenantId: scopedTenantId,
        id: "prod-6",
        name: "معكرونة إيطالية (سباغيتي 500 غ)",
        priceWholesale: 0.85,
        units: [
          { id: "unit-6-1", unitName: "كيس (500 غ)", conversionFactor: 1, pricingCurrency: "USD", priceWholesale: 0.85, priceRetail: 1.1, barcode: "6296006001" },
          { id: "unit-6-2", unitName: "طرد (20 كيس)", conversionFactor: 20, pricingCurrency: "USD", priceWholesale: 16.0, barcode: "6296006002" },
        ],
        batches: [
          { id: "batch-6-1", unitId: "unit-6-1", batchNumber: "PST-88", quantity: 300, expiryDate: "2027-05-10" },
        ],
      }),
      createCachedProductRecord({
        tenantId: scopedTenantId,
        id: "prod-7",
        name: "طحين سميد فاخر (كيس 1 كغ)",
        priceWholesale: 18000,
        units: [
          {
            id: "unit-7-1",
            unitName: "كيس (1 كغ)",
            conversionFactor: 1,
            pricingCurrency: "SYP",
            priceWholesale: 18000,
            priceRetail: 21000,
            barcode: "6297007001",
          },
          {
            id: "unit-7-2",
            unitName: "كرتونة (10 أكياس)",
            conversionFactor: 10,
            pricingCurrency: "SYP",
            priceWholesale: 172000,
            barcode: "6297007002",
          },
        ],
        batches: [
          { id: "batch-7-1", unitId: "unit-7-1", batchNumber: "FLR-2026-01", quantity: 200, expiryDate: "2027-03-01" },
        ],
      }),
    ];

    await db.cachedProducts.bulkPut(sampleProducts);
  }

  const customerCount = await db.cachedCustomers.where("tenantId").equals(scopedTenantId).count();
  if (customerCount === 0) {
    const sampleCustomers: CachedCustomer[] = [
      createCachedCustomerRecord({ tenantId: scopedTenantId, id: "sys-cust-1", name: "زبون نقدي عام", phone: "0000000000", cachedBalanceDebtSYP: 0, cachedBalanceDebtUSD: 0, isSystemGenerated: true }),
      createCachedCustomerRecord({ tenantId: scopedTenantId, id: "cust-1", name: "سوبرماركت الأمانة", phone: "0944111222", shopName: "فرع الميدان", cachedBalanceDebtSYP: 5250000, cachedBalanceDebtUSD: 350.0 }),
      createCachedCustomerRecord({ tenantId: scopedTenantId, id: "cust-2", name: "بقالية النور والبركة", phone: "0933222333", shopName: "فرع القصاع", cachedBalanceDebtSYP: 1807500, cachedBalanceDebtUSD: 120.5 }),
      createCachedCustomerRecord({ tenantId: scopedTenantId, id: "cust-3", name: "ميني ماركت الشام الحديث", phone: "0955444555", shopName: "شارع بغداد", cachedBalanceDebtSYP: 0, cachedBalanceDebtUSD: 0.0 }),
      createCachedCustomerRecord({ tenantId: scopedTenantId, id: "cust-4", name: "مستودع الفجر للمواد الغذائية", phone: "0988777666", shopName: "سوق الهال", cachedBalanceDebtSYP: 13350000, cachedBalanceDebtUSD: 890.0 }),
    ];
    await db.cachedCustomers.bulkPut(sampleCustomers);
  }

  const settingsCount = await db.cachedTenantSettings.where("tenantId").equals(scopedTenantId).count();
  if (settingsCount === 0) {
    await setCachedDailyExchangeRate(15000, scopedTenantId);
  }
}