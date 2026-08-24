import Dexie, { type Table } from "dexie";

export type OfflineInvoiceStatus = "PENDING" | "SYNCED";

export interface OfflineInvoiceItem {
  productId: string;
  unitId: string;
  quantity: number;
  unitPriceUSD: number;
}

export interface OfflineInvoice {
  id?: number;
  offlineId: string;
  customerId: string;
  items: OfflineInvoiceItem[];
  totalUSD: number;
  totalSYP: number;
  exchangeRate: number;
  paidAmountUSD: number;
  debtAmountUSD: number;
  createdAt: Date;
  status: OfflineInvoiceStatus;
}

export interface CachedProductUnit {
  id: string;
  unitName: string;
  conversionFactor: number;
  priceUSD: number;
  barcode?: string;
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
  units: CachedProductUnit[];
  batches: CachedProductBatch[];
  priceUSD: number;
}

export interface CachedCustomer {
  id: string;
  name: string;
  shopName?: string;
  cachedBalanceDebtUSD: number;
}

export class OfflineDatabase extends Dexie {
  offlineInvoices!: Table<OfflineInvoice, number>;
  cachedProducts!: Table<CachedProduct, string>;
  cachedCustomers!: Table<CachedCustomer, string>;

  constructor() {
    super("JomlaTechOffline");

    this.version(1).stores({
      offlineInvoices: "++id, offlineId, customerId, status, createdAt",
      cachedProducts: "id, name",
      cachedCustomers: "id, name",
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
