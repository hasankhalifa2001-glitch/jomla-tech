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
  unitPriceUSD: string;
  priceRetailUSD?: string;
}

export interface CartTotalsResult {
  totalUSD: string;
  totalSYP: string | null;
  itemCount: number;
  lineItems: Array<{
    id: string;
    lineTotalUSD: string;
    lineTotalSYP: string | null;
  }>;
}

export interface OfflineSalePayload {
  customer?: SelectedCustomer | null;
  items: CartLineItem[];
  totalUSD: MoneyInput;
  totalSYP: MoneyInput;
  exchangeRateUsed: MoneyInput;
  paidAmountUSD: MoneyInput;
  debtAmountUSD: MoneyInput;
  paymentMethod?: PaymentMethod;
}

export interface DuplicatePhoneMatch {
  customer: SelectedCustomer;
  source: "CACHED" | "OFFLINE" | "ONLINE";
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
  const lineTotalsUSD: string[] = [];

  const hasValidRate = exchangeRate !== null && compareMoney(exchangeRate, 0) > 0;

  for (const item of items) {
    itemCount += item.quantity;
    const lineTotalUSD = multiplyMoney(item.unitPriceUSD, item.quantity);
    lineTotalsUSD.push(lineTotalUSD);

    let lineTotalSYP: string | null = null;
    if (hasValidRate) {
      lineTotalSYP = convertCurrency(lineTotalUSD, exchangeRate, "USD", "SYP");
    }

    lineItems.push({
      id: item.id,
      lineTotalUSD,
      lineTotalSYP,
    });
  }

  const totalUSD = sumMoney(lineTotalsUSD);
  const totalSYP = hasValidRate ? convertCurrency(totalUSD, exchangeRate, "USD", "SYP") : null;

  return {
    totalUSD,
    totalSYP,
    itemCount,
    lineItems,
  };
}

/**
 * Resolves the billed wholesale price for a product unit in USD.
 * Always selects priceWholesale (never priceRetail).
 */
export function resolveUnitPriceUSD(
  unit: CachedProductUnit,
  product?: CachedProduct,
  exchangeRate?: MoneyInput | null
): string {
  if (unit.pricingCurrency !== "SYP" && unit.pricingCurrency !== "USD") {
    throw new Error(
      "لا يمكن تحديد عملة التسعير لهذه الوحدة (SYP أو USD) — يرجى مزامنة بيانات المنتج أو مراجعته."
    );
  }

  if (unit.pricingCurrency === "SYP") {
    if (!exchangeRate || compareMoney(exchangeRate, 0) <= 0) {
      throw new Error(
        "لا يمكن احتساب سعر هذا المنتج بالدولار لأنه مسعّر بالليرة السورية ولا يوجد سعر صرف يومي محفوظ حالياً."
      );
    }
    return convertCurrency(unit.priceWholesale, exchangeRate, "SYP", "USD");
  }

  const rawPrice = unit.priceWholesale ?? product?.priceWholesale;
  if (rawPrice === undefined || rawPrice === null) {
    throw new Error(
      "لا يوجد سعر جملة محدد لهذه الوحدة — لا يمكن إضافتها إلى السلة. الرجاء مراجعة بيانات المنتج."
    );
  }
  return serializeMoney(rawPrice);
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
    const totalStock = (p.batches || []).reduce((acc, b) => acc + (Number(b.quantity) || 0), 0);
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
    ...cachedList.map((c) => ({
      type: (c.isSystemGenerated ? "SYSTEM" : "EXISTING") as SelectedCustomer["type"],
      id: c.id,
      name: c.name,
      phone: c.phone,
      shopName: c.shopName,
      balanceDebtUSD: toDecimal(c.cachedBalanceDebtUSD).toNumber(),
      isSystemGenerated: c.isSystemGenerated,
    })),
    ...offlineList.map((c) => ({
      type: "WALK_IN" as const,
      id: c.offlineId,
      name: c.name,
      phone: c.phone,
      shopName: c.shopName,
      balanceDebtUSD: 0,
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
  const cleanPhone = phone.trim();
  const scopedTenantId = resolveTenantId(tenantId);

  if (isOfflineDbSupported()) {
    const db = getOfflineDb();

    const cachedMatch = await db.cachedCustomers
      .where("tenantId")
      .equals(scopedTenantId)
      .filter((c) => !!c.phone && c.phone.trim() === cleanPhone)
      .first();

    if (cachedMatch) {
      return {
        customer: {
          type: cachedMatch.isSystemGenerated ? "SYSTEM" : "EXISTING",
          id: cachedMatch.id,
          name: cachedMatch.name,
          phone: cachedMatch.phone,
          shopName: cachedMatch.shopName,
          balanceDebtUSD: toDecimal(cachedMatch.cachedBalanceDebtUSD).toNumber(),
          isSystemGenerated: cachedMatch.isSystemGenerated,
        },
        source: "CACHED",
      };
    }

    const offlineMatch = await db.offlineCustomers
      .where("tenantId")
      .equals(scopedTenantId)
      .filter((c) => !!c.phone && c.phone.trim() === cleanPhone)
      .first();

    if (offlineMatch) {
      return {
        customer: {
          type: "WALK_IN",
          id: offlineMatch.offlineId,
          name: offlineMatch.name,
          phone: offlineMatch.phone,
          shopName: offlineMatch.shopName,
          balanceDebtUSD: 0,
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
              balanceDebtUSD: 0,
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
    balanceDebtUSD: 0,
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

  if (!payload.customer) {
    throw new Error("يجب اختيار زبون (نقدي أو حقيقي) قبل إتمام عملية البيع.");
  }

  const isSystemGeneratedCashCustomer =
    payload.customer.type === "SYSTEM" || payload.customer.isSystemGenerated;

  if (compareMoney(payload.debtAmountUSD, 0) > 0 && isSystemGeneratedCashCustomer) {
    throw new Error("البيع على الحساب أو الدفع الجزئي يتطلب اختيار أو تسجيل زبون حقيقي.");
  }

  const expectedDebt = subtractMoney(payload.totalUSD, payload.paidAmountUSD);
  if (compareMoney(expectedDebt, payload.debtAmountUSD) !== 0) {
    throw new Error(
      "قيمة الدين المحسوبة لا تطابق الفرق بين إجمالي الفاتورة والمبلغ المدفوع — يرجى مراجعة حسابات السلة قبل المتابعة."
    );
  }

  const expectedTotalSYP = convertCurrency(payload.totalUSD, payload.exchangeRateUsed, "USD", "SYP");
  if (compareMoney(expectedTotalSYP, payload.totalSYP) !== 0) {
    throw new Error(
      "قيمة الإجمالي بالليرة السورية لا تطابق إجمالي الدولار مضروباً بسعر الصرف المستخدم — يرجى مراجعة حسابات السلة."
    );
  }

  const invoiceItems = payload.items.map((item) => ({
    productId: item.product.id,
    unitId: item.unitId,
    quantity: item.quantity,
    unitPriceUSD: item.unitPriceUSD,
  }));

  const isWalkIn = payload.customer.type === "WALK_IN";
  const customerId = !isWalkIn ? payload.customer.id : undefined;
  const offlineCustomerId = isWalkIn ? payload.customer.id : undefined;

  const invoiceRecord = createOfflineInvoiceRecord({
    tenantId: scopedTenantId,
    offlineId: generateOfflineId(),
    customerId,
    offlineCustomerId,
    items: invoiceItems,
    totalUSD: payload.totalUSD,
    totalSYP: payload.totalSYP,
    exchangeRateUsed: payload.exchangeRateUsed,
    paidAmountUSD: payload.paidAmountUSD,
    debtAmountUSD: payload.debtAmountUSD,
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
      // [FIX] `pricingCurrency: "USD"` added explicitly to every unit
      // below (prod-1 through prod-6). Previously omitted entirely, which
      // was harmless only as long as nothing actually checked it — once
      // ProductCatalog.tsx / CartPanel.tsx were fixed to resolve prices
      // through resolveUnitPriceUSD() (which strictly rejects any
      // pricingCurrency that isn't exactly "SYP" or "USD"), every one of
      // these six sample products would have thrown "لا يمكن تحديد عملة
      // التسعير" instead of displaying a price. These products' prices
      // were always intended as USD (matching the small dollar-range
      // values used, e.g. 1.2, 3.5, 8.5), so "USD" is the correct,
      // explicit tag — not a new decision, just making an implicit
      // assumption explicit and machine-checkable. prod-7 (طحين) already
      // tagged its units "SYP" correctly and needs no change.
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
      // prod-7: the only sample product priced in SYP — already tagged
      // pricingCurrency: "SYP" correctly before this fix; unchanged.
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
      createCachedCustomerRecord({ tenantId: scopedTenantId, id: "sys-cust-1", name: "زبون نقدي عام", phone: "0000000000", cachedBalanceDebtUSD: 0, isSystemGenerated: true }),
      createCachedCustomerRecord({ tenantId: scopedTenantId, id: "cust-1", name: "سوبرماركت الأمانة", phone: "0944111222", shopName: "فرع الميدان", cachedBalanceDebtUSD: 350.0 }),
      createCachedCustomerRecord({ tenantId: scopedTenantId, id: "cust-2", name: "بقالية النور والبركة", phone: "0933222333", shopName: "فرع القصاع", cachedBalanceDebtUSD: 120.5 }),
      createCachedCustomerRecord({ tenantId: scopedTenantId, id: "cust-3", name: "ميني ماركت الشام الحديث", phone: "0955444555", shopName: "شارع بغداد", cachedBalanceDebtUSD: 0.0 }),
      createCachedCustomerRecord({ tenantId: scopedTenantId, id: "cust-4", name: "مستودع الفجر للمواد الغذائية", phone: "0988777666", shopName: "سوق الهال", cachedBalanceDebtUSD: 890.0 }),
    ];
    await db.cachedCustomers.bulkPut(sampleCustomers);
  }

  const settingsCount = await db.cachedTenantSettings.where("tenantId").equals(scopedTenantId).count();
  if (settingsCount === 0) {
    await setCachedDailyExchangeRate(15000, scopedTenantId);
  }
}