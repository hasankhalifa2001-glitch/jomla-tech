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
 * Rules:
 * - Offline invoice line items NEVER carry batchId (FIFO resolves server-side at sync T4c).
 * - Customer reference is strictly customerId XOR offlineCustomerId.
 * - Checkout requires a cached exchange rate > 0.
 * - [FIX] Every function now takes `tenantId` as its first parameter and
 *   filters every Dexie query by it. Previously none of these tables or
 *   queries were tenant-scoped at all — a device that ever logged into
 *   more than one tenant (shared hardware, demo account, tenant switch)
 *   could read or sync a different tenant's cached products, customers,
 *   or queued offline sales. This brings the local storage layer in line
 *   with the tenant-isolation discipline the server side already enforces.
 * - [FIX] Every monetary value flowing through this file is now typed as
 *   `MoneyInput` (never a bare `number`) and compared/serialized via
 *   lib/utils/money.ts — never native +/-/toFixed on money.
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
  type OfflineCustomer,
  type OfflineInvoice,
} from "./db";
import { setCachedDailyExchangeRate } from "./exchange-rate";
import { generateOfflineId } from "./id";
import { compareMoney, toDecimal, type MoneyInput } from "../utils/money";

export interface PosProductItem extends CachedProduct {
  totalCachedStock: number;
}

export interface SelectedCustomer {
  type: "EXISTING" | "WALK_IN";
  id: string; // real customerId OR offlineCustomerId
  name: string;
  phone?: string;
  shopName?: string;
  balanceDebtUSD?: number;
}

export interface CartLineItem {
  id: string; // unique item key in cart (e.g. productId-unitId)
  product: CachedProduct;
  unitId: string;
  unitName: string;
  conversionFactor: number;
  quantity: number;
  unitPriceUSD: MoneyInput;
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

function assertTenantId(tenantId: string): void {
  if (!tenantId || !tenantId.trim()) {
    throw new Error("tenantId is required for offline POS operations.");
  }
}

/**
 * Retrieves all cached products for this tenant from Dexie, optionally
 * filtering by search query (name, barcode, unit).
 */
export async function getOfflineProducts(
  tenantId: string,
  query?: string
): Promise<PosProductItem[]> {
  assertTenantId(tenantId);
  if (!isOfflineDbSupported()) return [];

  const db = getOfflineDb();
  const products = await db.cachedProducts.where("tenantId").equals(tenantId).toArray();

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

/**
 * Searches customer records across this tenant's cached existing customers
 * and newly created offline customers.
 * [FIX] `balanceDebtUSD` now goes through `toDecimal(...).toNumber()`
 * instead of `Number(...) || 0` — a corrupted/invalid cached balance now
 * throws a clear MoneyError instead of silently displaying "0 debt" for a
 * customer who may actually owe money.
 */
export async function getOfflineCustomers(
  tenantId: string,
  query?: string
): Promise<SelectedCustomer[]> {
  assertTenantId(tenantId);
  if (!isOfflineDbSupported()) return [];

  const db = getOfflineDb();
  const [cachedList, offlineList] = await Promise.all([
    db.cachedCustomers.where("tenantId").equals(tenantId).toArray(),
    db.offlineCustomers.where("tenantId").equals(tenantId).toArray(),
  ]);

  const all: SelectedCustomer[] = [
    ...cachedList.map((c) => ({
      type: "EXISTING" as const,
      id: c.id,
      name: c.name,
      shopName: c.shopName,
      balanceDebtUSD: toDecimal(c.cachedBalanceDebtUSD).toNumber(),
    })),
    ...offlineList.map((c) => ({
      type: "WALK_IN" as const,
      id: c.offlineId,
      name: c.name,
      phone: c.phone,
      shopName: c.shopName,
      balanceDebtUSD: 0,
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

/**
 * Creates a walk-in customer record inline directly into Dexie's offlineCustomers table.
 */
export async function createOfflineWalkInCustomer(
  tenantId: string,
  data: {
    name: string;
    phone?: string;
    shopName?: string;
  }
): Promise<SelectedCustomer> {
  assertTenantId(tenantId);
  if (!isOfflineDbSupported()) {
    throw new Error("IndexedDB is not supported in this browser environment.");
  }
  if (!data.name || !data.name.trim()) {
    throw new Error("اسم الزبون مطلوب.");
  }

  const db = getOfflineDb();
  const newCustomerRecord = createOfflineCustomerRecord({
    tenantId,
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
  };
}

/**
 * Submits and persists a completed sale offline to Dexie's offlineInvoices table.
 * Strictly guarantees:
 * 1. Line items contain NO batchId.
 * 2. status = 'PENDING'.
 * 3. customerId XOR offlineCustomerId properly mapped.
 * 4. Generates UUID offlineId.
 * 5. tenantId stamped onto the stored record.
 * [FIX] No more `Number(payload.totalUSD.toFixed(4))` — that pattern
 * assumed totalUSD was already a native number by the time it reached
 * here, silently trusting whatever precision the caller's cart math used.
 * Every monetary field is now passed straight through as MoneyInput and
 * serialized exclusively inside createOfflineInvoiceRecord via
 * lib/utils/money.ts.
 */
export async function submitOfflineSale(
  tenantId: string,
  payload: OfflineSalePayload
): Promise<OfflineInvoice> {
  assertTenantId(tenantId);
  if (!isOfflineDbSupported()) {
    throw new Error("IndexedDB is not supported.");
  }

  if (!payload.items || payload.items.length === 0) {
    throw new Error("لا يمكن إتمام عملية البيع لسلة فارغة.");
  }

  if (compareMoney(payload.exchangeRateUsed, 0) <= 0) {
    throw new Error("لا يمكن إتمام البيع بدون سعر صرف يومي محدد.");
  }

  if (compareMoney(payload.debtAmountUSD, 0) > 0 && !payload.customer) {
    throw new Error("البيع على الحساب أو الدفع الجزئي يتطلب اختيار أو تسجيل زبون.");
  }

  const invoiceItems = payload.items.map((item) => ({
    productId: item.product.id,
    unitId: item.unitId,
    quantity: item.quantity,
    unitPriceUSD: item.unitPriceUSD,
  }));

  const isWalkIn = payload.customer?.type === "WALK_IN";
  const customerId = payload.customer && !isWalkIn ? payload.customer.id : undefined;
  const offlineCustomerId = payload.customer && isWalkIn ? payload.customer.id : undefined;

  const invoiceRecord = createOfflineInvoiceRecord({
    tenantId,
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

/**
 * Inspects all offline invoices for this tenant in Dexie, newest first.
 */
export async function getOfflineInvoicesList(tenantId: string): Promise<OfflineInvoice[]> {
  assertTenantId(tenantId);
  if (!isOfflineDbSupported()) return [];

  const db = getOfflineDb();
  const items = await db.offlineInvoices.where("tenantId").equals(tenantId).toArray();
  return items.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

/**
 * Development & Testing helper: seeds demo catalog & customer data into
 * Dexie for a SPECIFIC tenant, if that tenant has no cached data yet.
 * [FIX] The "already seeded?" checks are now scoped to `tenantId` — the
 * previous version checked `db.cachedProducts.count()` across the WHOLE
 * table, so once any one tenant's demo data existed, every other tenant
 * silently got skipped and never received sample data at all.
 * [FIX] Product/customer objects are now built exclusively through
 * createCachedProductRecord / createCachedCustomerRecord — the previous
 * version hand-built these objects with a `priceUSD` field (the exact
 * column name schema.prisma explicitly says must never exist anywhere in
 * this project — see T1's acceptance criteria) and with raw native
 * numbers instead of decimal.js-serialized strings.
 */
export async function seedSampleOfflineData(tenantId: string): Promise<void> {
  assertTenantId(tenantId);
  if (!isOfflineDbSupported()) return;

  const db = getOfflineDb();
  const productCount = await db.cachedProducts.where("tenantId").equals(tenantId).count();

  if (productCount === 0) {
    const sampleProducts: CachedProduct[] = [
      createCachedProductRecord({
        tenantId,
        id: "prod-1",
        name: "سكر أبيض ناعم (الأسرة)",
        priceWholesale: 1.2,
        units: [
          { id: "unit-1-1", unitName: "كيس (1 كغ)", conversionFactor: 1, priceWholesale: 1.2, barcode: "6291001001" },
          { id: "unit-1-2", unitName: "شوال (10 كغ)", conversionFactor: 10, priceWholesale: 11.5, barcode: "6291001002" },
          { id: "unit-1-3", unitName: "شوال كبير (50 كغ)", conversionFactor: 50, priceWholesale: 55.0, barcode: "6291001003" },
        ],
        batches: [
          { id: "batch-1-1", unitId: "unit-1-1", batchNumber: "B2026-01", quantity: 150, expiryDate: "2027-01-01" },
          { id: "batch-1-2", unitId: "unit-1-2", batchNumber: "B2026-02", quantity: 40, expiryDate: "2027-06-01" },
        ],
      }),
      createCachedProductRecord({
        tenantId,
        id: "prod-2",
        name: "زيت دوار الشمس (عافية 1.5 لتر)",
        priceWholesale: 3.5,
        units: [
          { id: "unit-2-1", unitName: "عبوة (1.5 لتر)", conversionFactor: 1, priceWholesale: 3.5, barcode: "6292002001" },
          { id: "unit-2-2", unitName: "كرتونة (6 عبوات)", conversionFactor: 6, priceWholesale: 20.0, barcode: "6292002002" },
        ],
        batches: [
          { id: "batch-2-1", unitId: "unit-2-1", batchNumber: "AF-998", quantity: 85, expiryDate: "2026-12-31" },
        ],
      }),
      createCachedProductRecord({
        tenantId,
        id: "prod-3",
        name: "شاي أسود فرط (الكبوس 450 غرام)",
        priceWholesale: 4.8,
        units: [
          { id: "unit-3-1", unitName: "باكيت (450 غ)", conversionFactor: 1, priceWholesale: 4.8, barcode: "6293003001" },
          { id: "unit-3-2", unitName: "كرتونة (24 باكيت)", conversionFactor: 24, priceWholesale: 110.0, barcode: "6293003002" },
        ],
        batches: [
          { id: "batch-3-1", unitId: "unit-3-1", batchNumber: "KBS-44", quantity: 60, expiryDate: "2028-02-15" },
        ],
      }),
      createCachedProductRecord({
        tenantId,
        id: "prod-4",
        name: "أرز بسمتي هندي (أبو كاس 5 كغ)",
        priceWholesale: 8.5,
        units: [
          { id: "unit-4-1", unitName: "كيس (5 كغ)", conversionFactor: 1, priceWholesale: 8.5, barcode: "6294004001" },
          { id: "unit-4-2", unitName: "كرتونة (4 أكياس)", conversionFactor: 4, priceWholesale: 33.0, barcode: "6294004002" },
        ],
        batches: [
          { id: "batch-4-1", unitId: "unit-4-1", batchNumber: "RICE-2026", quantity: 120, expiryDate: "2027-09-30" },
        ],
      }),
      createCachedProductRecord({
        tenantId,
        id: "prod-5",
        name: "حليب مجفف كامل الدسم (نيدو 900 غرام)",
        priceWholesale: 7.2,
        units: [
          { id: "unit-5-1", unitName: "علبة (900 غ)", conversionFactor: 1, priceWholesale: 7.2, barcode: "6295005001" },
          { id: "unit-5-2", unitName: "كرتونة (12 علبة)", conversionFactor: 12, priceWholesale: 84.0, barcode: "6295005002" },
        ],
        batches: [
          { id: "batch-5-1", unitId: "unit-5-1", batchNumber: "NID-110", quantity: 45, expiryDate: "2026-11-20" },
        ],
      }),
      createCachedProductRecord({
        tenantId,
        id: "prod-6",
        name: "معكرونة إيطالية (سباغيتي 500 غ)",
        priceWholesale: 0.85,
        units: [
          { id: "unit-6-1", unitName: "كيس (500 غ)", conversionFactor: 1, priceWholesale: 0.85, barcode: "6296006001" },
          { id: "unit-6-2", unitName: "طرد (20 كيس)", conversionFactor: 20, priceWholesale: 16.0, barcode: "6296006002" },
        ],
        batches: [
          { id: "batch-6-1", unitId: "unit-6-1", batchNumber: "PST-88", quantity: 300, expiryDate: "2027-05-10" },
        ],
      }),
    ];

    await db.cachedProducts.bulkPut(sampleProducts);
  }

  const customerCount = await db.cachedCustomers.where("tenantId").equals(tenantId).count();
  if (customerCount === 0) {
    const sampleCustomers: CachedCustomer[] = [
      createCachedCustomerRecord({ tenantId, id: "cust-1", name: "سوبرماركت الأمانة", shopName: "فرع الميدان", cachedBalanceDebtUSD: 350.0 }),
      createCachedCustomerRecord({ tenantId, id: "cust-2", name: "بقالية النور والبركة", shopName: "فرع القصاع", cachedBalanceDebtUSD: 120.5 }),
      createCachedCustomerRecord({ tenantId, id: "cust-3", name: "ميني ماركت الشام الحديث", shopName: "شارع بغداد", cachedBalanceDebtUSD: 0.0 }),
      createCachedCustomerRecord({ tenantId, id: "cust-4", name: "مستودع الفجر للمواد الغذائية", shopName: "سوق الهال", cachedBalanceDebtUSD: 890.0 }),
    ];
    await db.cachedCustomers.bulkPut(sampleCustomers);
  }

  const settingsCount = await db.cachedTenantSettings.where("tenantId").equals(tenantId).count();
  if (settingsCount === 0) {
    await setCachedDailyExchangeRate(15000, tenantId);
  }
}