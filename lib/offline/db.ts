/* db.ts */
import Dexie, { type Table } from "dexie";
import { generateOfflineId } from "./id";
import { serializeMoney, compareMoney, subtractMoney, type MoneyInput } from "../utils/money";

export type OfflineSyncStatus = "PENDING" | "SYNCED" | "FAILED";

export type PaymentMethod =
  | "CASH"
  | "SHAM_CASH"
  | "SYRIATEL_CASH"
  | "BANK_TRANSFER"
  | "OTHER";

export interface OfflineInvoiceItem {
  productId: string;
  unitId: string;
  quantity: number;
  unitPriceUSD: string;
}

export interface OfflineInvoice {
  id?: number;
  tenantId: string;
  offlineId: string;
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

export interface OfflinePayment {
  id?: number;
  tenantId: string;
  offlineId: string;
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

export interface OfflineCustomer {
  id?: number;
  tenantId: string;
  offlineId: string;
  name: string;
  phone?: string;
  shopName?: string;
  createdAt: Date;
  status: OfflineSyncStatus;
  failureReason?: string;
}

export interface CachedTenantSettings {
  tenantId: string;
  dailyExchangeRate: string;
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

export interface CachedProduct {
  id: string;
  tenantId: string;
  name: string;
  category?: string;
  units: CachedProductUnit[];
  batches: CachedProductBatch[];
  priceWholesale?: string;
}

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

    this.version(4)
      .stores({
        offlineInvoices: "++id, &offlineId, tenantId, customerId, offlineCustomerId, status, createdAt",
        offlinePayments: "++id, &offlineId, tenantId, customerId, offlineCustomerId, status, createdAt",
        offlineCustomers: "++id, &offlineId, tenantId, status, createdAt",
        cachedTenantSettings: "tenantId, cachedAt",
        cachedProducts: "id, tenantId, name",
        cachedCustomers: "id, tenantId, name, phone, isSystemGenerated",
      })
      // [FIX] Reworked to compute the REAL per-table count of rows missing
      // tenantId FIRST, unconditionally, before deciding anything based on
      // distinctTenantIds. The previous version returned silently (no
      // warning at all) whenever cachedTenantSettings had zero rows,
      // assuming that meant "nothing to backfill" — but a device that was
      // used entirely offline since a pre-v2 install (cachedTenantSettings
      // didn't exist before v2) could have real PENDING offlineInvoices
      // sitting there with zero cachedTenantSettings rows to infer a
      // tenant from. That specific case now still can't be safely
      // auto-backfilled (there's genuinely no tenant to attribute it to),
      // but it is no longer silent — a loud warning is always printed
      // whenever real affected rows exist, regardless of how many distinct
      // tenants cachedTenantSettings knows about (zero, one, or several).
      .upgrade(async (tx) => {
        const tenantSettingsRows = await tx.table("cachedTenantSettings").toArray();
        const distinctTenantIds = Array.from(
          new Set(tenantSettingsRows.map((r: { tenantId: string }) => r.tenantId).filter(Boolean))
        );

        const tablesToBackfill = [
          "offlineInvoices",
          "offlinePayments",
          "offlineCustomers",
          "cachedProducts",
          "cachedCustomers",
        ] as const;

        const affected: Record<string, Array<Record<string, unknown>>> = {};
        let totalAffected = 0;
        for (const tableName of tablesToBackfill) {
          const rows = await tx.table(tableName).toArray();
          const missing = rows.filter((r: { tenantId?: string }) => !r.tenantId);
          if (missing.length > 0) {
            affected[tableName] = missing;
            totalAffected += missing.length;
          }
        }

        if (totalAffected === 0) {
          // Genuinely nothing at risk — a fresh device, or one where every
          // pre-existing row already happens to carry a tenantId.
          return;
        }

        if (distinctTenantIds.length !== 1) {
          const perTableCounts = Object.entries(affected)
            .map(([t, rows]) => `${t}: ${rows.length}`)
            .join(", ");
          console.warn(
            `[OfflineDatabase v4 migration] Could not safely backfill tenantId: found ` +
            `${distinctTenantIds.length} distinct cached tenant(s) on this device, but ` +
            `${totalAffected} row(s) are missing tenantId (${perTableCounts}). These records ` +
            `will keep tenantId unset and will not appear in any tenant-scoped query until ` +
            `manually reconciled.`
          );
          return;
        }

        const resolvedTenantId = distinctTenantIds[0];
        for (const [tableName, rows] of Object.entries(affected)) {
          console.warn(
            `[OfflineDatabase v4 migration] Backfilling tenantId="${resolvedTenantId}" onto ` +
            `${rows.length} pre-existing row(s) in "${tableName}".`
          );
          await Promise.all(
            rows.map((row) =>
              tx.table(tableName).update((row.id ?? row.offlineId) as string | number, {
                tenantId: resolvedTenantId,
              })
            )
          );
        }
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
  // [FIX] Invoice.customerId is required and non-nullable server-side —
  // a factory-level guard, independent of whatever the caller (currently
  // pos-service.ts's submitOfflineSale) already checks, so this stays
  // safe even if called directly by a future caller that skips that
  // higher-level check.
  if (!data.customerId && !data.offlineCustomerId) {
    throw new Error(
      "Offline invoice must reference a customer via either customerId or offlineCustomerId."
    );
  }
  if (!data.items || data.items.length === 0) {
    throw new Error("An offline invoice must have at least one line item.");
  }
  if (data.items.some((item) => item.quantity <= 0)) {
    throw new Error("Every line item on a sale must have a strictly positive quantity.");
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

  const debtUSD = serializeMoney(data.debtAmountUSD);
  if (compareMoney(debtUSD, 0) < 0) {
    throw new Error(
      "debtAmountUSD must not be negative on a plain sale — negative debt is only valid on a void record."
    );
  }

  const rateUsed = serializeMoney(data.exchangeRateUsed);
  if (compareMoney(rateUsed, 0) <= 0) {
    throw new Error("exchangeRateUsed must be strictly greater than 0.");
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
    exchangeRateUsed: rateUsed,
    paidAmountUSD: paidUSD,
    debtAmountUSD: debtUSD,
    paymentMethod: data.paymentMethod,
    createdAt: data.createdAt || new Date(),
    status: data.status || "PENDING",
    failureReason: data.failureReason,
  };
}

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
  originalTotalUSD: MoneyInput;
  originalTotalSYP: MoneyInput;
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
  // [FIX] Same "at least one" requirement as the sale factory.
  if (!data.customerId && !data.offlineCustomerId) {
    throw new Error(
      "Offline void must reference a customer via either customerId or offlineCustomerId."
    );
  }
  if (!data.voidsOfflineInvoiceId) {
    throw new Error("voidsOfflineInvoiceId is required for a void record.");
  }
  if (!data.voidReason || !data.voidReason.trim()) {
    throw new Error("voidReason is required for a void record.");
  }
  if (!data.items || data.items.length === 0) {
    throw new Error("An offline void record must have at least one line item.");
  }
  if (data.items.some((item) => item.quantity >= 0)) {
    throw new Error(
      "A void's line items must be the negated mirror of the original sale " +
      "(quantity strictly less than 0 for every item) — got a zero or " +
      "positive quantity."
    );
  }

  const rateUsed = serializeMoney(data.exchangeRateUsed);
  if (compareMoney(rateUsed, 0) <= 0) {
    throw new Error("exchangeRateUsed must be strictly greater than 0.");
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
    totalUSD: subtractMoney("0", data.originalTotalUSD),
    totalSYP: subtractMoney("0", data.originalTotalSYP),
    exchangeRateUsed: rateUsed,
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
  // [FIX] Same "at least one" requirement — a repayment must always be
  // attributable to a specific customer.
  if (!data.customerId && !data.offlineCustomerId) {
    throw new Error(
      "Offline payment must reference a customer via either customerId or offlineCustomerId."
    );
  }

  const amountUSD = serializeMoney(data.amountUSD);
  // [FIX] A logged repayment of zero or negative amount has no valid
  // meaning — matches this file's own "fail fast with a clear reason"
  // pattern applied everywhere else.
  if (compareMoney(amountUSD, 0) <= 0) {
    throw new Error("amountUSD must be strictly greater than 0 for a payment record.");
  }

  return {
    tenantId: data.tenantId,
    offlineId: data.offlineId || generateOfflineId(),
    customerId: data.customerId,
    offlineCustomerId: data.offlineCustomerId,
    amountUSD,
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
  // [FIX] An empty-name walk-in customer is unusable everywhere downstream
  // (the ledger, receipts, WhatsApp statement). pos-service.ts's caller
  // already checks this, but this factory now enforces it standalone too.
  if (!data.name || !data.name.trim()) {
    throw new Error("name is required to create an offline customer record.");
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