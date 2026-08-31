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
 */

import {
  getOfflineDb,
  isOfflineDbSupported,
  createOfflineCustomerRecord,
  createOfflineInvoiceRecord,
  type PaymentMethod,
  type CachedProduct,
  type CachedCustomer,
  type OfflineCustomer,
  type OfflineInvoice,
  type OfflineInvoiceItem,
} from "./db";
import { generateOfflineId } from "./id";

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
  unitPriceUSD: number;
}

export interface OfflineSalePayload {
  customer?: SelectedCustomer | null;
  items: CartLineItem[];
  totalUSD: number;
  totalSYP: number;
  exchangeRateUsed: number;
  paidAmountUSD: number;
  debtAmountUSD: number;
  paymentMethod?: PaymentMethod;
}

/**
 * Retrieves all cached products from Dexie, optionally filtering by search query (name, barcode, unit).
 */
export async function getOfflineProducts(query?: string): Promise<PosProductItem[]> {
  if (!isOfflineDbSupported()) return [];

  const db = getOfflineDb();
  const products = await db.cachedProducts.toArray();

  const enriched: PosProductItem[] = products.map((p) => {
    // Informational stock calculation across all batches
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
    // Match product name
    if (p.name.toLowerCase().includes(cleanQuery)) return true;
    // Match barcodes or unit names
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
 * Searches customer records across cached existing customers and newly created offline customers.
 */
export async function getOfflineCustomers(query?: string): Promise<SelectedCustomer[]> {
  if (!isOfflineDbSupported()) return [];

  const db = getOfflineDb();
  const [cachedList, offlineList] = await Promise.all([
    db.cachedCustomers.toArray(),
    db.offlineCustomers.toArray(),
  ]);

  const all: SelectedCustomer[] = [
    ...cachedList.map((c) => ({
      type: "EXISTING" as const,
      id: c.id,
      name: c.name,
      shopName: c.shopName,
      balanceDebtUSD: Number(c.cachedBalanceDebtUSD) || 0,
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
export async function createOfflineWalkInCustomer(data: {
  name: string;
  phone?: string;
  shopName?: string;
}): Promise<SelectedCustomer> {
  if (!isOfflineDbSupported()) {
    throw new Error("IndexedDB is not supported in this browser environment.");
  }

  if (!data.name || !data.name.trim()) {
    throw new Error("اسم الزبون مطلوب.");
  }

  const db = getOfflineDb();
  const newCustomerRecord = createOfflineCustomerRecord({
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
 */
export async function submitOfflineSale(payload: OfflineSalePayload): Promise<OfflineInvoice> {
  if (!isOfflineDbSupported()) {
    throw new Error("IndexedDB is not supported.");
  }

  if (!payload.items || payload.items.length === 0) {
    throw new Error("لا يمكن إتمام عملية البيع لسلة فارغة.");
  }

  if (!payload.exchangeRateUsed || payload.exchangeRateUsed <= 0) {
    throw new Error("لا يمكن إتمام البيع بدون سعر صرف يومي محدد.");
  }

  // If debt is incurred, a customer is required
  if (payload.debtAmountUSD > 0 && !payload.customer) {
    throw new Error("البيع على الحساب أو الدفع الجزئي يتطلب اختيار أو تسجيل زبون.");
  }

  // Format line items strictly without batchId
  const invoiceItems: OfflineInvoiceItem[] = payload.items.map((item) => ({
    productId: item.product.id,
    unitId: item.unitId,
    quantity: item.quantity,
    unitPriceUSD: item.unitPriceUSD,
  }));

  const isWalkIn = payload.customer?.type === "WALK_IN";
  const customerId = payload.customer && !isWalkIn ? payload.customer.id : undefined;
  const offlineCustomerId = payload.customer && isWalkIn ? payload.customer.id : undefined;

  const invoiceRecord = createOfflineInvoiceRecord({
    offlineId: generateOfflineId(),
    customerId,
    offlineCustomerId,
    items: invoiceItems,
    totalUSD: Number(payload.totalUSD.toFixed(4)),
    totalSYP: Number(payload.totalSYP.toFixed(4)),
    exchangeRateUsed: payload.exchangeRateUsed,
    paidAmountUSD: Number(payload.paidAmountUSD.toFixed(4)),
    debtAmountUSD: Number(payload.debtAmountUSD.toFixed(4)),
    paymentMethod: payload.paymentMethod,
    createdAt: new Date(),
    status: "PENDING",
  });

  const db = getOfflineDb();
  await db.offlineInvoices.add(invoiceRecord);

  return invoiceRecord;
}

/**
 * Inspects all offline invoices in Dexie.
 */
export async function getOfflineInvoicesList(): Promise<OfflineInvoice[]> {
  if (!isOfflineDbSupported()) return [];
  const db = getOfflineDb();
  return db.offlineInvoices.orderBy("createdAt").reverse().toArray();
}

/**
 * Development & Testing helper: Seeds demo catalog & customer data into Dexie
 * if the local database is empty, allowing instant offline testing.
 */
export async function seedSampleOfflineData(): Promise<void> {
  if (!isOfflineDbSupported()) return;

  const db = getOfflineDb();
  const productCount = await db.cachedProducts.count();

  if (productCount === 0) {
    const sampleProducts: CachedProduct[] = [
      {
        id: "prod-1",
        name: "سكر أبيض ناعم (الأسرة)",
        priceWholesale: 1.2,
        priceUSD: 1.2,
        units: [
          { id: "unit-1-1", unitName: "كيس (1 كغ)", conversionFactor: 1, priceWholesale: 1.2, priceUSD: 1.2, barcode: "6291001001" },
          { id: "unit-1-2", unitName: "شوال (10 كغ)", conversionFactor: 10, priceWholesale: 11.5, priceUSD: 11.5, barcode: "6291001002" },
          { id: "unit-1-3", unitName: "شوال كبير (50 كغ)", conversionFactor: 50, priceWholesale: 55.0, priceUSD: 55.0, barcode: "6291001003" },
        ],
        batches: [
          { id: "batch-1-1", unitId: "unit-1-1", batchNumber: "B2026-01", quantity: 150, expiryDate: "2027-01-01" },
          { id: "batch-1-2", unitId: "unit-1-2", batchNumber: "B2026-02", quantity: 40, expiryDate: "2027-06-01" },
        ],
      },
      {
        id: "prod-2",
        name: "زيت دوار الشمس (عافية 1.5 لتر)",
        priceWholesale: 3.5,
        priceUSD: 3.5,
        units: [
          { id: "unit-2-1", unitName: "عبوة (1.5 لتر)", conversionFactor: 1, priceWholesale: 3.5, priceUSD: 3.5, barcode: "6292002001" },
          { id: "unit-2-2", unitName: "كرتونة (6 عبوات)", conversionFactor: 6, priceWholesale: 20.0, priceUSD: 20.0, barcode: "6292002002" },
        ],
        batches: [
          { id: "batch-2-1", unitId: "unit-2-1", batchNumber: "AF-998", quantity: 85, expiryDate: "2026-12-31" },
        ],
      },
      {
        id: "prod-3",
        name: "شاي أسود فرط (الكبوس 450 غرام)",
        priceWholesale: 4.8,
        priceUSD: 4.8,
        units: [
          { id: "unit-3-1", unitName: "باكيت (450 غ)", conversionFactor: 1, priceWholesale: 4.8, priceUSD: 4.8, barcode: "6293003001" },
          { id: "unit-3-2", unitName: "كرتونة (24 باكيت)", conversionFactor: 24, priceWholesale: 110.0, priceUSD: 110.0, barcode: "6293003002" },
        ],
        batches: [
          { id: "batch-3-1", unitId: "unit-3-1", batchNumber: "KBS-44", quantity: 60, expiryDate: "2028-02-15" },
        ],
      },
      {
        id: "prod-4",
        name: "أرز بسمتي هندي (أبو كاس 5 كغ)",
        priceWholesale: 8.5,
        priceUSD: 8.5,
        units: [
          { id: "unit-4-1", unitName: "كيس (5 كغ)", conversionFactor: 1, priceWholesale: 8.5, priceUSD: 8.5, barcode: "6294004001" },
          { id: "unit-4-2", unitName: "كرتونة (4 أكياس)", conversionFactor: 4, priceWholesale: 33.0, priceUSD: 33.0, barcode: "6294004002" },
        ],
        batches: [
          { id: "batch-4-1", unitId: "unit-4-1", batchNumber: "RICE-2026", quantity: 120, expiryDate: "2027-09-30" },
        ],
      },
      {
        id: "prod-5",
        name: "حليب مجفف كامل الدسم (نيدو 900 غرام)",
        priceWholesale: 7.2,
        priceUSD: 7.2,
        units: [
          { id: "unit-5-1", unitName: "علبة (900 غ)", conversionFactor: 1, priceWholesale: 7.2, priceUSD: 7.2, barcode: "6295005001" },
          { id: "unit-5-2", unitName: "كرتونة (12 علبة)", conversionFactor: 12, priceWholesale: 84.0, priceUSD: 84.0, barcode: "6295005002" },
        ],
        batches: [
          { id: "batch-5-1", unitId: "unit-5-1", batchNumber: "NID-110", quantity: 45, expiryDate: "2026-11-20" },
        ],
      },
      {
        id: "prod-6",
        name: "معكرونة إيطالية (سباغيتي 500 غ)",
        priceWholesale: 0.85,
        priceUSD: 0.85,
        units: [
          { id: "unit-6-1", unitName: "كيس (500 غ)", conversionFactor: 1, priceWholesale: 0.85, priceUSD: 0.85, barcode: "6296006001" },
          { id: "unit-6-2", unitName: "طرد (20 كيس)", conversionFactor: 20, priceWholesale: 16.0, priceUSD: 16.0, barcode: "6296006002" },
        ],
        batches: [
          { id: "batch-6-1", unitId: "unit-6-1", batchNumber: "PST-88", quantity: 300, expiryDate: "2027-05-10" },
        ],
      },
    ];

    await db.cachedProducts.bulkPut(sampleProducts);
  }

  const customerCount = await db.cachedCustomers.count();
  if (customerCount === 0) {
    const sampleCustomers: CachedCustomer[] = [
      { id: "cust-1", name: "سوبرماركت الأمانة", shopName: "فرع الميدان", cachedBalanceDebtUSD: 350.0 },
      { id: "cust-2", name: "بقالية النور والبركة", shopName: "فرع القصاع", cachedBalanceDebtUSD: 120.5 },
      { id: "cust-3", name: "ميني ماركت الشام الحديث", shopName: "شارع بغداد", cachedBalanceDebtUSD: 0.0 },
      { id: "cust-4", name: "مستودع الفجر للمواد الغذائية", shopName: "سوق الهال", cachedBalanceDebtUSD: 890.0 },
    ];
    await db.cachedCustomers.bulkPut(sampleCustomers);
  }

  // Set default exchange rate if none exists
  const settingsCount = await db.cachedTenantSettings.count();
  if (settingsCount === 0) {
    await db.cachedTenantSettings.put({
      tenantId: "global_tenant",
      dailyExchangeRate: 15000,
      cachedAt: new Date(),
    });
  }
}
