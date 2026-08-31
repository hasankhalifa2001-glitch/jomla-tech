import Dexie, { type Table } from "dexie";
import { generateOfflineId } from "./id";
import { serializeMoney, compareMoney, subtractMoney, type MoneyInput } from "../utils/money";

export type OfflineSyncStatus = "PENDING" | "SYNCED" | "FAILED";

// Mirrors the server-side `PaymentMethod` enum (schema) exactly.
export type PaymentMethod =
  | "CASH"
  | "SHAM_CASH"
  | "SYRIATEL_CASH"
  | "BANK_TRANSFER"
  | "OTHER";

/**
 * Offline invoice line item.
 * NOTE: Line items NEVER carry batchId — FIFO resolves server-side at sync (T4c), not locally.
 * unitPriceUSD is ALWAYS a decimal.js-serialized string in storage.
 */
export interface OfflineInvoiceItem {
  productId: string;
  unitId: string;
  quantity: number;
  unitPriceUSD: string;
}

/**
 * Offline invoice record stored in Dexie queue.
 * [FIX] Added `tenantId` — every locally-cached/queued record must be
 * scoped to the tenant it belongs to, so a device that has ever logged
 * into more than one tenant (shared/reused hardware, demo accounts, a
 * tenant switch) can never read or sync another tenant's queued sale.
 * This mirrors the server's tenant-isolation philosophy at the local
 * storage layer, which previously had none at all.
 */
export interface OfflineInvoice {
  id?: number;
  tenantId: string;
  offlineId: string; // UUID v4
  customerId?: string;
  offlineCustomerId?: string;
  items: OfflineInvoiceItem[];
  totalUSD: string;
  totalSYP: string;
  exchangeRateUsed: string;
  paidAmountUSD: string;
  debtAmountUSD: string;
  paymentMethod?: PaymentMethod;
  voidsOfflineInvoiceId?: string;
  voidReason?: string;
  createdAt: Date;
  status: OfflineSyncStatus;
  failureReason?: string;
}

/** [FIX] tenantId added — same reasoning as OfflineInvoice. */
export interface OfflinePayment {
  id?: number;
  tenantId: string;
  offlineId: string; // UUID v4
  customerId?: string;
  offlineCustomerId?: string;
  amountUSD: string;
  amountSYP: string;
  exchangeRate: string;
  paymentMethod: PaymentMethod;
  receiptNo?: string;
  notes?: string;
  createdAt: Date;
  status: OfflineSyncStatus;
  failureReason?: string;
}

/** [FIX] tenantId added — same reasoning as OfflineInvoice. */
export interface OfflineCustomer {
  id?: number;
  tenantId: string;
  offlineId: string; // UUID v4
  name: string;
  phone?: string;
  shopName?: string;
  createdAt: Date;
  status: OfflineSyncStatus;
  failureReason?: string;
}

export interface CachedTenantSettings {
  tenantId: string;
  dailyExchangeRate: string; // decimal.js-serialized — never a native number
  cachedAt: Date;
}

export interface CachedProductUnit {
  id: string;
  unitName: string;
  conversionFactor: number;
  priceWholesale: string;
  priceRetail?: string;
  pricingCurrency?: "USD" | "SYP";
  barcode?: string;
  barcodeSource?: "GS1" | "INTERNAL";
}

export interface CachedProductBatch {
  id: string;
  unitId: string;
  batchNumber: string;
  quantity: number;
  expiryDate?: string;
}

/** [FIX] tenantId added — a product cached from tenant A's catalog must
 * never surface in tenant B's POS search on the same device. */
export interface CachedProduct {
  id: string;
  tenantId: string;
  name: string;
  category?: string;
  units: CachedProductUnit[];
  batches: CachedProductBatch[];
  priceWholesale?: string;
}

/**
 * [FIX] tenantId added — same reasoning as CachedProduct.
 * `phone` (T4b's soft duplicate-phone check) and `isSystemGenerated`
 * (T4b's one-tap "زبون نقدي" shortcut) were added in the previous pass.
 */
export interface CachedCustomer {
  id: string;
  tenantId: string;
  name: string;
  phone?: string;
  shopName?: string;
  cachedBalanceDebtUSD: string;
  isSystemGenerated?: boolean;
}

export class OfflineDatabase extends Dexie {
  offlineInvoices!: Table<OfflineInvoice, number>;
  offlinePayments!: Table<OfflinePayment, number>;
  offlineCustomers!: Table<OfflineCustomer, number>;
  cachedTenantSettings!: Table<CachedTenantSettings, string>;
  cachedProducts!: Table<CachedProduct, string>;
  cachedCustomers!: Table<CachedCustomer, string>;

  constructor() {
    super("JomlaTechOffline");

    this.version(1).stores({
      offlineInvoices: "++id, offlineId, customerId, status, createdAt",
      cachedProducts: "id, name",
      cachedCustomers: "id, name",
    });

    this.version(2).stores({
      offlineInvoices: "++id, &offlineId, customerId, offlineCustomerId, status, createdAt",
      offlinePayments: "++id, &offlineId, customerId, offlineCustomerId, status, createdAt",
      offlineCustomers: "++id, &offlineId, status, createdAt",
      cachedTenantSettings: "tenantId, cachedAt",
      cachedProducts: "id, name",
      cachedCustomers: "id, name",
    });

    this.version(3).stores({
      offlineInvoices: "++id, &offlineId, customerId, offlineCustomerId, status, createdAt",
      offlinePayments: "++id, &offlineId, customerId, offlineCustomerId, status, createdAt",
      offlineCustomers: "++id, &offlineId, status, createdAt",
      cachedTenantSettings: "tenantId, cachedAt",
      cachedProducts: "id, name",
      cachedCustomers: "id, name, phone, isSystemGenerated",
    });

    // [FIX] Version 4: `tenantId` added as an indexed field on every
    // locally-stored table that previously had no tenant scoping at all
    // (offlineInvoices, offlinePayments, offlineCustomers, cachedProducts,
    // cachedCustomers). Every table is repeated in full — Dexie requires
    // the complete store definition on every version bump, it does not
    // diff against the previous version. cachedTenantSettings already
    // used tenantId as its primary key and needs no change here.
    this.version(4).stores({
      offlineInvoices: "++id, &offlineId, tenantId, customerId, offlineCustomerId, status, createdAt",
      offlinePayments: "++id, &offlineId, tenantId, customerId, offlineCustomerId, status, createdAt",
      offlineCustomers: "++id, &offlineId, tenantId, status, createdAt",
      cachedTenantSettings: "tenantId, cachedAt",
      cachedProducts: "id, tenantId, name",
      cachedCustomers: "id, tenantId, name, phone, isSystemGenerated",
    });
  }
}

let offlineDbInstance: OfflineDatabase | null = null;

export function getOfflineDb(): OfflineDatabase {
  if (typeof window === "undefined") {
    throw new Error("Offline database is only available in the browser.");
  }
  if (!offlineDbInstance) {
    offlineDbInstance = new OfflineDatabase();
  }
  return offlineDbInstance;
}

export function isOfflineDbSupported(): boolean {
  return typeof window !== "undefined" && typeof indexedDB !== "undefined";
}

/**
 * Factory helper for creating a PLAIN SALE offline invoice entry.
 * [FIX] `tenantId` is now a required input, stamped onto the stored record.
 */
export function createOfflineInvoiceRecord(data: {
  tenantId: string;
  offlineId?: string;
  customerId?: string;
  offlineCustomerId?: string;
  items: Array<{
    productId: string;
    unitId: string;
    quantity: number;
    unitPriceUSD: MoneyInput;
  }>;
  totalUSD: MoneyInput;
  totalSYP: MoneyInput;
  exchangeRateUsed: MoneyInput;
  paidAmountUSD: MoneyInput;
  debtAmountUSD: MoneyInput;
  paymentMethod?: PaymentMethod;
  createdAt?: Date;
  status?: OfflineSyncStatus;
  failureReason?: string;
}): OfflineInvoice {
  if (!data.tenantId || !data.tenantId.trim()) {
    throw new Error("tenantId is required to create an offline invoice record.");
  }
  if (data.customerId && data.offlineCustomerId) {
    throw new Error("Offline invoice cannot have both customerId and offlineCustomerId.");
  }

  const paidUSD = serializeMoney(data.paidAmountUSD);
  if (compareMoney(paidUSD, 0) > 0 && !data.paymentMethod) {
    throw new Error("paymentMethod is required whenever paidAmountUSD > 0.");
  }
  if (compareMoney(paidUSD, 0) === 0 && data.paymentMethod) {
    throw new Error(
      "paymentMethod must not be set on a fully-on-credit sale (paidAmountUSD === 0)."
    );
  }

  return {
    tenantId: data.tenantId,
    offlineId: data.offlineId || generateOfflineId(),
    customerId: data.customerId,
    offlineCustomerId: data.offlineCustomerId,
    items: data.items.map((item) => ({
      productId: item.productId,
      unitId: item.unitId,
      quantity: item.quantity,
      unitPriceUSD: serializeMoney(item.unitPriceUSD),
    })),
    totalUSD: serializeMoney(data.totalUSD),
    totalSYP: serializeMoney(data.totalSYP),
    exchangeRateUsed: serializeMoney(data.exchangeRateUsed),
    paidAmountUSD: paidUSD,
    debtAmountUSD: serializeMoney(data.debtAmountUSD),
    paymentMethod: data.paymentMethod,
    createdAt: data.createdAt || new Date(),
    status: data.status || "PENDING",
    failureReason: data.failureReason,
  };
}

/**
 * Factory helper for creating a VOID/REFUND offline invoice entry.
 * [FIX] `tenantId` required, same as createOfflineInvoiceRecord.
 */
export function createOfflineVoidRecord(data: {
  tenantId: string;
  offlineId?: string;
  voidsOfflineInvoiceId: string;
  voidReason: string;
  customerId?: string;
  offlineCustomerId?: string;
  items: Array<{
    productId: string;
    unitId: string;
    quantity: number;
    unitPriceUSD: MoneyInput;
  }>;
  totalUSD: MoneyInput;
  totalSYP: MoneyInput;
  exchangeRateUsed: MoneyInput;
  originalPaidAmountUSD: MoneyInput;
  originalDebtAmountUSD: MoneyInput;
  createdAt?: Date;
  status?: OfflineSyncStatus;
  failureReason?: string;
}): OfflineInvoice {
  if (!data.tenantId || !data.tenantId.trim()) {
    throw new Error("tenantId is required to create an offline void record.");
  }
  if (data.customerId && data.offlineCustomerId) {
    throw new Error("Offline void cannot have both customerId and offlineCustomerId.");
  }
  if (!data.voidsOfflineInvoiceId) {
    throw new Error("voidsOfflineInvoiceId is required for a void record.");
  }
  if (!data.voidReason || !data.voidReason.trim()) {
    throw new Error("voidReason is required for a void record.");
  }
  if (data.items.some((item) => item.quantity >= 0)) {
    throw new Error(
      "A void's line items must be the negated mirror of the original sale " +
      "(quantity strictly less than 0 for every item) — got a zero or " +
      "positive quantity."
    );
  }

  return {
    tenantId: data.tenantId,
    offlineId: data.offlineId || generateOfflineId(),
    customerId: data.customerId,
    offlineCustomerId: data.offlineCustomerId,
    items: data.items.map((item) => ({
      productId: item.productId,
      unitId: item.unitId,
      quantity: item.quantity,
      unitPriceUSD: serializeMoney(item.unitPriceUSD),
    })),
    totalUSD: serializeMoney(data.totalUSD),
    totalSYP: serializeMoney(data.totalSYP),
    exchangeRateUsed: serializeMoney(data.exchangeRateUsed),
    paidAmountUSD: subtractMoney("0", data.originalPaidAmountUSD),
    debtAmountUSD: subtractMoney("0", data.originalDebtAmountUSD),
    paymentMethod: undefined,
    voidsOfflineInvoiceId: data.voidsOfflineInvoiceId,
    voidReason: data.voidReason,
    createdAt: data.createdAt || new Date(),
    status: data.status || "PENDING",
    failureReason: data.failureReason,
  };
}

/** [FIX] `tenantId` required. */
export function createOfflinePaymentRecord(data: {
  tenantId: string;
  offlineId?: string;
  customerId?: string;
  offlineCustomerId?: string;
  amountUSD: MoneyInput;
  amountSYP: MoneyInput;
  exchangeRate: MoneyInput;
  paymentMethod: PaymentMethod;
  receiptNo?: string;
  notes?: string;
  createdAt?: Date;
  status?: OfflineSyncStatus;
  failureReason?: string;
}): OfflinePayment {
  if (!data.tenantId || !data.tenantId.trim()) {
    throw new Error("tenantId is required to create an offline payment record.");
  }
  if (data.customerId && data.offlineCustomerId) {
    throw new Error("Offline payment cannot have both customerId and offlineCustomerId.");
  }

  return {
    tenantId: data.tenantId,
    offlineId: data.offlineId || generateOfflineId(),
    customerId: data.customerId,
    offlineCustomerId: data.offlineCustomerId,
    amountUSD: serializeMoney(data.amountUSD),
    amountSYP: serializeMoney(data.amountSYP),
    exchangeRate: serializeMoney(data.exchangeRate),
    paymentMethod: data.paymentMethod,
    receiptNo: data.receiptNo,
    notes: data.notes,
    createdAt: data.createdAt || new Date(),
    status: data.status || "PENDING",
    failureReason: data.failureReason,
  };
}

/** [FIX] `tenantId` required. */
export function createOfflineCustomerRecord(data: {
  tenantId: string;
  offlineId?: string;
  name: string;
  phone?: string;
  shopName?: string;
  createdAt?: Date;
  status?: OfflineSyncStatus;
  failureReason?: string;
}): OfflineCustomer {
  if (!data.tenantId || !data.tenantId.trim()) {
    throw new Error("tenantId is required to create an offline customer record.");
  }

  return {
    tenantId: data.tenantId,
    offlineId: data.offlineId || generateOfflineId(),
    name: data.name,
    phone: data.phone,
    shopName: data.shopName,
    createdAt: data.createdAt || new Date(),
    status: data.status || "PENDING",
    failureReason: data.failureReason,
  };
}

/** [FIX] `tenantId` required. */
export function createCachedProductRecord(data: {
  tenantId: string;
  id: string;
  name: string;
  category?: string;
  units: Array<{
    id: string;
    unitName: string;
    conversionFactor: number;
    priceWholesale: MoneyInput;
    priceRetail?: MoneyInput;
    pricingCurrency?: "USD" | "SYP";
    barcode?: string;
    barcodeSource?: "GS1" | "INTERNAL";
  }>;
  batches: CachedProductBatch[];
  priceWholesale?: MoneyInput;
}): CachedProduct {
  if (!data.tenantId || !data.tenantId.trim()) {
    throw new Error("tenantId is required to create a cached product record.");
  }

  return {
    id: data.id,
    tenantId: data.tenantId,
    name: data.name,
    category: data.category,
    units: data.units.map((u) => ({
      id: u.id,
      unitName: u.unitName,
      conversionFactor: u.conversionFactor,
      priceWholesale: serializeMoney(u.priceWholesale),
      priceRetail: u.priceRetail !== undefined ? serializeMoney(u.priceRetail) : undefined,
      pricingCurrency: u.pricingCurrency,
      barcode: u.barcode,
      barcodeSource: u.barcodeSource,
    })),
    batches: data.batches,
    priceWholesale:
      data.priceWholesale !== undefined ? serializeMoney(data.priceWholesale) : undefined,
  };
}

/** [FIX] `tenantId` required. */
export function createCachedCustomerRecord(data: {
  tenantId: string;
  id: string;
  name: string;
  phone?: string;
  shopName?: string;
  cachedBalanceDebtUSD: MoneyInput;
  isSystemGenerated?: boolean;
}): CachedCustomer {
  if (!data.tenantId || !data.tenantId.trim()) {
    throw new Error("tenantId is required to create a cached customer record.");
  }

  return {
    id: data.id,
    tenantId: data.tenantId,
    name: data.name,
    phone: data.phone,
    shopName: data.shopName,
    cachedBalanceDebtUSD: serializeMoney(data.cachedBalanceDebtUSD),
    isSystemGenerated: data.isSystemGenerated,
  };
}