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
 * [v3.4] unitPriceUSD stored as decimal.js-serialized string.
 */
export interface OfflineInvoiceItem {
  productId: string;
  unitId: string;
  quantity: number;
  unitPriceUSD: string | number;
}

/**
 * Offline invoice record stored in Dexie queue.
 * NOTE: An invoice for a walk-in customer stores offlineCustomerId;
 * an invoice for an existing customer stores the real customerId directly. Never both.
 * [v3.4] Every monetary field stored as decimal.js-serialized string.
 */
export interface OfflineInvoice {
  id?: number;
  offlineId: string; // UUID v4
  customerId?: string;
  offlineCustomerId?: string;
  items: OfflineInvoiceItem[];
  totalUSD: string | number;
  totalSYP: string | number;
  exchangeRateUsed: string | number;
  paidAmountUSD: string | number;
  debtAmountUSD: string | number;
  // Describes ONLY the method used for the paid portion at sale time
  // (paidAmountUSD). The "sale type" toggle in T4b's UI (Cash / Credit /
  // Partial) is a separate UI-level concept that determines paidAmountUSD
  // — it never gets stored as a value here. Optional/undefined for a
  // fully-on-credit sale (paidAmountUSD === 0), which has no payment
  // method to record at all.
  paymentMethod?: PaymentMethod;
  voidsOfflineInvoiceId?: string;
  voidReason?: string;
  createdAt: Date;
  status: OfflineSyncStatus;
  failureReason?: string;
}

/**
 * Offline payment record stored in Dexie queue.
 * [v3.4] Every monetary field stored as decimal.js-serialized string.
 */
export interface OfflinePayment {
  id?: number;
  offlineId: string; // UUID v4
  customerId?: string;
  offlineCustomerId?: string;
  amountUSD: string | number;
  amountSYP: string | number;
  exchangeRate: string | number;
  paymentMethod: PaymentMethod;
  receiptNo?: string;
  notes?: string;
  createdAt: Date;
  status: OfflineSyncStatus;
  failureReason?: string;
}

/**
 * Offline walk-in customer record stored in Dexie queue.
 */
export interface OfflineCustomer {
  id?: number;
  offlineId: string; // UUID v4
  name: string;
  phone?: string;
  shopName?: string;
  createdAt: Date;
  status: OfflineSyncStatus;
  failureReason?: string;
}

/**
 * Cached tenant settings including daily exchange rate.
 * [v3.4] dailyExchangeRate stored as decimal.js-serialized string.
 */
export interface CachedTenantSettings {
  tenantId: string;
  dailyExchangeRate: string | number;
  cachedAt: Date;
}

export interface CachedProductUnit {
  id: string;
  unitName: string;
  conversionFactor: number;
  priceWholesale: string | number;
  priceRetail?: string | number;
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

export interface CachedProduct {
  id: string;
  name: string;
  category?: string;
  units: CachedProductUnit[];
  batches: CachedProductBatch[];
  priceWholesale?: string | number;
}

export interface CachedCustomer {
  id: string;
  name: string;
  shopName?: string;
  cachedBalanceDebtUSD: string | number;
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

    // Version 1 (Initial schema)
    this.version(1).stores({
      offlineInvoices: "++id, offlineId, customerId, status, createdAt",
      cachedProducts: "id, name",
      cachedCustomers: "id, name",
    });

    // Version 2 (Full T4 Offline Foundation schema)
    this.version(2).stores({
      offlineInvoices: "++id, &offlineId, customerId, offlineCustomerId, status, createdAt",
      offlinePayments: "++id, &offlineId, customerId, offlineCustomerId, status, createdAt",
      offlineCustomers: "++id, &offlineId, status, createdAt",
      cachedTenantSettings: "tenantId, cachedAt",
      cachedProducts: "id, name",
      cachedCustomers: "id, name",
    });
  }
}

let offlineDbInstance: OfflineDatabase | null = null;

/**
 * Returns the singleton OfflineDatabase instance for client-side storage.
 */
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
 * Factory helper for creating a PLAIN SALE offline invoice entry, with
 * strict validation:
 * 1. Guarantees a valid UUID v4 via generateOfflineId().
 * 2. Enforces customerId XOR offlineCustomerId (never both).
 * 3. Enforces that items do not carry batchId (FIFO resolves on server at sync).
 * 4. Enforces paymentMethod is present if and only if paidAmountUSD > 0 —
 *    a fully-on-credit sale has no payment method to record, and a paid
 *    sale must always say how it was paid.
 *
 * Do NOT use this for a void/refund — use createOfflineVoidRecord below,
 * which enforces the different (negated-quantity, no-payment-method)
 * shape a void requires.
 */
export function createOfflineInvoiceRecord(data: {
  offlineId?: string;
  customerId?: string;
  offlineCustomerId?: string;
  items: OfflineInvoiceItem[];
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
    paidAmountUSD: serializeMoney(data.paidAmountUSD),
    debtAmountUSD: serializeMoney(data.debtAmountUSD),
    paymentMethod: data.paymentMethod,
    createdAt: data.createdAt || new Date(),
    status: data.status || "PENDING",
    failureReason: data.failureReason,
  };
}

/**
 * Factory helper for creating a VOID/REFUND offline invoice entry —
 * separate from createOfflineInvoiceRecord because a void's shape is
 * fundamentally different, not just a variant:
 * - `voidsOfflineInvoiceId` is required (this is what makes it a void).
 * - `voidReason` is required (T4d: audit trail is mandatory).
 * - Line item quantities must be the NEGATED mirror of the original
 *   sale's items — enforced here by requiring every quantity be < 0,
 *   rather than leaving it to the caller to remember to negate them.
 * - A void never has a paymentMethod — it reverses stock and debt, not a
 *   cash movement (see T4d Scope 8: a void never generates a
 *   CustomerPayment).
 *
 * FIX (critical): `paidAmountUSD` and `debtAmountUSD` on a void are NOT
 * simply 0 / totalUSD — they must be the exact negation of the ORIGINAL
 * invoice's values, or the customer's balance sum will not net out to
 * zero after a full reversal. Concretely, for an original invoice with
 * totalUSD=40, paidAmountUSD=20, debtAmountUSD=20 (half paid, half on
 * credit), the correct void is totalUSD=-40, paidAmountUSD=-20,
 * debtAmountUSD=-20 — summing the two invoices' debtAmountUSD gives
 * 20 + (-20) = 0, exactly cancelling the original. Using paidAmountUSD=0
 * and debtAmountUSD=totalUSD (an earlier, incorrect version of this
 * function) only happens to work when the original sale was 100% on
 * credit (originalPaidAmountUSD === 0) — for any partially or fully paid
 * original, it silently leaves the customer's balance off by exactly the
 * amount that was originally paid. This is why `originalPaidAmountUSD`
 * and `originalDebtAmountUSD` are REQUIRED inputs here, not derived from
 * `totalUSD` alone — callers must read these off the invoice being
 * voided.
 */
export function createOfflineVoidRecord(data: {
  offlineId?: string;
  voidsOfflineInvoiceId: string;
  voidReason: string;
  customerId?: string;
  offlineCustomerId?: string;
  items: OfflineInvoiceItem[];
  totalUSD: MoneyInput;
  totalSYP: MoneyInput;
  exchangeRateUsed: MoneyInput;
  originalPaidAmountUSD: MoneyInput;
  originalDebtAmountUSD: MoneyInput;
  createdAt?: Date;
  status?: OfflineSyncStatus;
  failureReason?: string;
}): OfflineInvoice {
  if (data.customerId && data.offlineCustomerId) {
    throw new Error("Offline void cannot have both customerId and offlineCustomerId.");
  }

  if (!data.voidsOfflineInvoiceId) {
    throw new Error("voidsOfflineInvoiceId is required for a void record.");
  }

  if (!data.voidReason || !data.voidReason.trim()) {
    throw new Error("voidReason is required for a void record.");
  }

  // Strictly < 0 (not <= 0): a zero-quantity void line item reverses
  // nothing and shouldn't exist on a void's item list at all.
  if (data.items.some((item) => item.quantity >= 0)) {
    throw new Error(
      "A void's line items must be the negated mirror of the original sale " +
      "(quantity strictly less than 0 for every item) — got a zero or " +
      "positive quantity."
    );
  }

  return {
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

/**
 * Factory helper for creating offline payment entries with generateOfflineId().
 */
export function createOfflinePaymentRecord(data: {
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
  if (data.customerId && data.offlineCustomerId) {
    throw new Error("Offline payment cannot have both customerId and offlineCustomerId.");
  }

  return {
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

/**
 * Factory helper for creating offline customer entries with generateOfflineId().
 */
export function createOfflineCustomerRecord(data: {
  offlineId?: string;
  name: string;
  phone?: string;
  shopName?: string;
  createdAt?: Date;
  status?: OfflineSyncStatus;
  failureReason?: string;
}): OfflineCustomer {
  return {
    offlineId: data.offlineId || generateOfflineId(),
    name: data.name,
    phone: data.phone,
    shopName: data.shopName,
    createdAt: data.createdAt || new Date(),
    status: data.status || "PENDING",
    failureReason: data.failureReason,
  };
}