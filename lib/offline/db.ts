/* eslint-disable @typescript-eslint/no-explicit-any */
/* db.ts */
import Dexie, { type Table } from "dexie";
import { generateOfflineId } from "./id";
import {
  serializeMoney,
  compareMoney,
  subtractMoney,
  convertCurrency,
  type MoneyInput,
} from "../utils/money";

export type OfflineSyncStatus = "PENDING" | "SYNCED" | "FAILED";

export type PaymentMethod =
  | "CASH"
  | "SHAM_CASH"
  | "SYRIATEL_CASH"
  | "BANK_TRANSFER"
  | "OTHER";

// ============================================================================
// [v3.6] CURRENCY RE-ANCHORING — mirrors schema.prisma's Invoice/
// CustomerPayment/InvoiceItem models. SYP is now the authoritative currency
// on every offline financial record below. USD fields are retained purely
// as a derived, informational figure (still computed via the record's own
// frozen exchangeRateUsed/exchangeRate, just no longer load-bearing) —
// never validated against, never gates any action, and — critically —
// NEVER independently supplied by a caller anymore. Every factory function
// below computes the USD fields itself via convertCurrency from the SYP
// figure it was actually given, so there is no longer any way for a
// caller-supplied USD number to drift from the SYP number it's supposed to
// mirror. (Through v3.5 this file took both totalUSD/totalSYP etc. as
// caller-supplied inputs and trusted them independently — that's what let
// pos-service.ts's old cross-check "expectedTotalSYP === totalSYP" fail
// silently in the wrong direction; see pos-service.ts for the removed
// check.)
// ============================================================================

export interface OfflineInvoiceItem {
  productId: string;
  unitId: string;
  quantity: number;
  // [v3.6] AUTHORITATIVE.
  unitPriceSYP: string;
  // [v3.6] Derived/informational — unitPriceSYP ÷ exchangeRateUsed.
  unitPriceUSD: string;
}

export interface OfflineInvoice {
  id?: number;
  tenantId: string;
  offlineId: string;
  customerId?: string;
  offlineCustomerId?: string;
  items: OfflineInvoiceItem[];
  // [v3.6] AUTHORITATIVE.
  totalSYP: string;
  // [v3.6] Derived/informational.
  totalUSD: string;
  exchangeRateUsed: string;
  // [v3.6] AUTHORITATIVE.
  paidAmountSYP: string;
  // [v3.6] Derived/informational.
  paidAmountUSD: string;
  // [v3.6] AUTHORITATIVE.
  debtAmountSYP: string;
  // [v3.6] Derived/informational.
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
  // [v3.6] AUTHORITATIVE. (Schema-wise nothing changed here — both fields
  // already existed side by side — only which one is treated as the
  // source of truth changed, same as CustomerPayment in schema.prisma.)
  amountSYP: string;
  // [v3.6] Derived/informational.
  amountUSD: string;
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
  // [v3.6] AUTHORITATIVE. NEW field — did not exist before v3.6, since
  // through v3.5 USD was the only balance figure cached client-side.
  cachedBalanceDebtSYP: string;
  // [v3.6] Derived/informational, and now optional — this is a
  // client-side display cache, not something computed fresh here (a
  // customer's accumulated debt spans many invoices at many different
  // historical rates, so there's no single rate this file could use to
  // derive it accurately). Populated from whatever the server/sync last
  // reported.
  cachedBalanceDebtUSD?: string;
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

    // [v3.6] SYP CURRENCY RE-ANCHORING MIGRATION.
    // No index changes needed (SYP fields aren't indexed), so the
    // `.stores()` call below is identical to v4 — this version exists
    // purely to run the `.upgrade()` backfill.
    this.version(5)
      .stores({
        offlineInvoices: "++id, &offlineId, tenantId, customerId, offlineCustomerId, status, createdAt",
        offlinePayments: "++id, &offlineId, tenantId, customerId, offlineCustomerId, status, createdAt",
        offlineCustomers: "++id, &offlineId, tenantId, status, createdAt",
        cachedTenantSettings: "tenantId, cachedAt",
        cachedProducts: "id, tenantId, name",
        cachedCustomers: "id, tenantId, name, phone, isSystemGenerated",
      })
      .upgrade(async (tx) => {
        // offlineInvoices: each row already carries its own frozen
        // exchangeRateUsed, so backfilling unitPriceSYP/paidAmountSYP/
        // debtAmountSYP from the existing USD fields + that rate is an
        // EXACT reconstruction, not an approximation.
        const invoices = await tx.table("offlineInvoices").toArray();
        for (const inv of invoices as Array<Record<string, any>>) {
          if (
            inv.paidAmountSYP !== undefined &&
            inv.debtAmountSYP !== undefined &&
            (inv.items || []).every((it: Record<string, any>) => it.unitPriceSYP !== undefined)
          ) {
            continue; // already migrated
          }

          const rate = inv.exchangeRateUsed;
          if (!rate || compareMoney(rate, 0) <= 0) {
            console.warn(
              `[OfflineDatabase v5 migration] offlineInvoices row id=${inv.id} has no valid ` +
              `exchangeRateUsed — cannot backfill paidAmountSYP/debtAmountSYP/unitPriceSYP. ` +
              `This row will fail validation on its next sync attempt until manually reconciled.`
            );
            continue;
          }

          const updatedItems = (inv.items || []).map((item: Record<string, any>) => ({
            ...item,
            unitPriceSYP:
              item.unitPriceSYP ?? convertCurrency(item.unitPriceUSD, rate, "USD", "SYP"),
          }));

          await tx.table("offlineInvoices").update(inv.id, {
            items: updatedItems,
            paidAmountSYP:
              inv.paidAmountSYP ?? convertCurrency(inv.paidAmountUSD, rate, "USD", "SYP"),
            debtAmountSYP:
              inv.debtAmountSYP ?? convertCurrency(inv.debtAmountUSD, rate, "USD", "SYP"),
          });
        }

        // cachedCustomers: this cache has no per-record exchange rate of
        // its own — a customer's accumulated debt spans many invoices,
        // each at a different historical rate — so converting the old
        // cachedBalanceDebtUSD using TODAY's cached rate is only an
        // approximation. That's acceptable ONLY because this field is a
        // client-side display cache, never authoritative (the real
        // balance is always recomputed server-side). Logged loudly per
        // row, same "don't guess silently" pattern as the v4 migration
        // above, so it's never mistaken for an exact figure.
        const settingsRows = await tx.table("cachedTenantSettings").toArray();
        const rateByTenant = new Map<string, string>(
          settingsRows.map((r: Record<string, any>) => [r.tenantId, r.dailyExchangeRate])
        );

        const customers = await tx.table("cachedCustomers").toArray();
        for (const cust of customers as Array<Record<string, any>>) {
          if (cust.cachedBalanceDebtSYP !== undefined) continue;

          const rate = rateByTenant.get(cust.tenantId);
          if (!rate || compareMoney(rate, 0) <= 0) {
            console.warn(
              `[OfflineDatabase v5 migration] cachedCustomers row id=${cust.id} (tenant=` +
              `${cust.tenantId}) has no cached exchange rate to convert from — ` +
              `cachedBalanceDebtSYP set to "0.0000" as a placeholder. This is a display-only ` +
              `cache; it will be corrected on the next online customer sync.`
            );
            await tx.table("cachedCustomers").update(cust.id, { cachedBalanceDebtSYP: "0.0000" });
            continue;
          }

          console.warn(
            `[OfflineDatabase v5 migration] cachedCustomers row id=${cust.id}: approximating ` +
            `cachedBalanceDebtSYP from cachedBalanceDebtUSD using TODAY's cached rate (${rate}), ` +
            `not the historical rate(s) that balance actually accrued at. Display-only; will ` +
            `be corrected on the next online customer sync.`
          );
          await tx.table("cachedCustomers").update(cust.id, {
            cachedBalanceDebtSYP: convertCurrency(
              cust.cachedBalanceDebtUSD ?? "0",
              rate,
              "USD",
              "SYP"
            ),
          });
        }
      });
  }
}

let offlineDbInstance: OfflineDatabase | null = null;

export function getOfflineDb(): OfflineDatabase {
  if (typeof indexedDB === "undefined") {
    throw new Error("Offline database is only available in the browser.");
  }
  if (!offlineDbInstance) {
    offlineDbInstance = new OfflineDatabase();
  }
  return offlineDbInstance;
}

export function isOfflineDbSupported(): boolean {
  return typeof indexedDB !== "undefined";
}

/** Closes and deletes the Dexie instance so tests can start from an empty DB. */
export async function resetOfflineDbForTests(): Promise<void> {
  if (offlineDbInstance) {
    offlineDbInstance.close();
    offlineDbInstance = null;
  }
  if (typeof indexedDB === "undefined") return;

  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase("JomlaTechOffline");
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error("Failed to delete offline DB"));
    request.onblocked = () => resolve();
  });
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
    unitPriceSYP: MoneyInput;
  }>;
  totalSYP: MoneyInput;
  exchangeRateUsed: MoneyInput;
  paidAmountSYP: MoneyInput;
  debtAmountSYP: MoneyInput;
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

  const rateUsed = serializeMoney(data.exchangeRateUsed);
  if (compareMoney(rateUsed, 0) <= 0) {
    throw new Error("exchangeRateUsed must be strictly greater than 0.");
  }

  // [v3.6] AUTHORITATIVE checks now run on the SYP fields — mirrors
  // schema.prisma: "debtAmountSYP ≈ totalSYP − paidAmountSYP is the
  // authoritative validation at sync; the USD-side equivalent is checked
  // only as a sanity/display signal and never fails a sync on its own."
  const paidSYP = serializeMoney(data.paidAmountSYP);
  if (compareMoney(paidSYP, 0) > 0 && !data.paymentMethod) {
    throw new Error("paymentMethod is required whenever paidAmountSYP > 0.");
  }
  if (compareMoney(paidSYP, 0) === 0 && data.paymentMethod) {
    throw new Error(
      "paymentMethod must not be set on a fully-on-credit sale (paidAmountSYP === 0)."
    );
  }

  const debtSYP = serializeMoney(data.debtAmountSYP);
  if (compareMoney(debtSYP, 0) < 0) {
    throw new Error(
      "debtAmountSYP must not be negative on a plain sale — negative debt is only valid on a void record."
    );
  }

  const totalSYP = serializeMoney(data.totalSYP);

  // [v3.6] USD is derived HERE, from the SYP figures actually supplied,
  // via the same frozen exchangeRateUsed — never taken as a separate
  // caller-supplied input. This is what makes a totalUSD/totalSYP
  // mismatch structurally impossible, rather than something a separate
  // cross-check has to catch after the fact.
  const totalUSD = convertCurrency(totalSYP, rateUsed, "SYP", "USD");
  const paidAmountUSD = convertCurrency(paidSYP, rateUsed, "SYP", "USD");
  const debtAmountUSD = convertCurrency(debtSYP, rateUsed, "SYP", "USD");

  return {
    tenantId: data.tenantId,
    offlineId: data.offlineId || generateOfflineId(),
    customerId: data.customerId,
    offlineCustomerId: data.offlineCustomerId,
    items: data.items.map((item) => ({
      productId: item.productId,
      unitId: item.unitId,
      quantity: item.quantity,
      unitPriceSYP: serializeMoney(item.unitPriceSYP),
      unitPriceUSD: convertCurrency(item.unitPriceSYP, rateUsed, "SYP", "USD"),
    })),
    totalSYP,
    totalUSD,
    exchangeRateUsed: rateUsed,
    paidAmountSYP: paidSYP,
    paidAmountUSD,
    debtAmountSYP: debtSYP,
    debtAmountUSD,
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
    unitPriceSYP: MoneyInput;
  }>;
  originalTotalSYP?: MoneyInput;
  totalSYP?: MoneyInput;
  exchangeRateUsed: MoneyInput;
  originalPaidAmountSYP?: MoneyInput;
  originalDebtAmountSYP?: MoneyInput;
  paidAmountSYP?: MoneyInput;
  debtAmountSYP?: MoneyInput;
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

  const totalSYP =
    data.originalTotalSYP !== undefined
      ? subtractMoney("0", data.originalTotalSYP)
      : serializeMoney(data.totalSYP ?? "0");
  const paidSYP =
    data.originalPaidAmountSYP !== undefined
      ? subtractMoney("0", data.originalPaidAmountSYP)
      : data.paidAmountSYP !== undefined
        ? serializeMoney(data.paidAmountSYP)
        : "0.0000";
  const debtSYP =
    data.originalDebtAmountSYP !== undefined
      ? subtractMoney("0", data.originalDebtAmountSYP)
      : data.debtAmountSYP !== undefined
        ? serializeMoney(data.debtAmountSYP)
        : "0.0000";

  // [v3.6] Derived, same as the sale factory above.
  const totalUSD = convertCurrency(totalSYP, rateUsed, "SYP", "USD");
  const paidAmountUSD = convertCurrency(paidSYP, rateUsed, "SYP", "USD");
  const debtAmountUSD = convertCurrency(debtSYP, rateUsed, "SYP", "USD");

  return {
    tenantId: data.tenantId,
    offlineId: data.offlineId || generateOfflineId(),
    customerId: data.customerId,
    offlineCustomerId: data.offlineCustomerId,
    items: data.items.map((item) => ({
      productId: item.productId,
      unitId: item.unitId,
      quantity: item.quantity,
      unitPriceSYP: serializeMoney(item.unitPriceSYP),
      unitPriceUSD: convertCurrency(item.unitPriceSYP, rateUsed, "SYP", "USD"),
    })),
    totalSYP,
    totalUSD,
    exchangeRateUsed: rateUsed,
    paidAmountSYP: paidSYP,
    paidAmountUSD,
    debtAmountSYP: debtSYP,
    debtAmountUSD,
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

  const rate = serializeMoney(data.exchangeRate);
  if (compareMoney(rate, 0) <= 0) {
    throw new Error("exchangeRate must be strictly greater than 0.");
  }

  // [v3.6] AUTHORITATIVE check now runs on amountSYP, not amountUSD.
  const amountSYP = serializeMoney(data.amountSYP);
  if (compareMoney(amountSYP, 0) <= 0) {
    throw new Error("amountSYP must be strictly greater than 0 for a payment record.");
  }

  // [v3.6] Derived, never independently supplied.
  const amountUSD = convertCurrency(amountSYP, rate, "SYP", "USD");

  return {
    tenantId: data.tenantId,
    offlineId: data.offlineId || generateOfflineId(),
    customerId: data.customerId,
    offlineCustomerId: data.offlineCustomerId,
    amountSYP,
    amountUSD,
    exchangeRate: rate,
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
    // NOTE: pricingCurrency here is unrelated to which currency is
    // AUTHORITATIVE for the ledger (SYP, per v3.6) — it's the merchant's
    // own per-unit pricing choice (schema.prisma: "Two different products
    // can sit in two different currencies at the same time... zero
    // coupling"). Both stay valid; resolveUnitPriceSYP/resolveUnitPriceUSD
    // in pos-service.ts convert whichever currency a unit is priced in
    // into the ledger's SYP-primary figures at cart time.
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
  cachedBalanceDebtSYP: MoneyInput;
  cachedBalanceDebtUSD?: MoneyInput;
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
    cachedBalanceDebtSYP: serializeMoney(data.cachedBalanceDebtSYP),
    cachedBalanceDebtUSD:
      data.cachedBalanceDebtUSD !== undefined
        ? serializeMoney(data.cachedBalanceDebtUSD)
        : undefined,
    isSystemGenerated: data.isSystemGenerated,
  };
}