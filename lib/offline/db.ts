/* eslint-disable @typescript-eslint/no-explicit-any */
/* db.ts */
import Dexie, { type Table } from "dexie";
import { generateOfflineId } from "./id";
import {
  serializeMoney,
  compareMoney,
  subtractMoney,
  multiplyMoney,
  sumMoney,
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
// CURRENCY MODEL — mirrors schema.prisma's Invoice/CustomerPayment/
// InvoiceItem models. SYP is the authoritative currency on every offline
// financial record below. USD fields are purely a derived, informational
// figure (computed via the record's own frozen exchangeRateUsed/
// exchangeRate) — never validated against, never gates any action, and
// never independently supplied by a caller. Every factory function below
// computes the USD fields itself via convertCurrency from the SYP figure
// it was actually given, so a caller-supplied USD number can never drift
// from the SYP number it's supposed to mirror.
//
// Both invoice-shaped factories also enforce, at construction time, two
// authoritative invariants T1's acceptance criteria require at the
// client-factory layer (not just the sync endpoint / not just a
// higher-level service function):
//   1. debtAmountSYP must equal totalSYP − paidAmountSYP.
//   2. An invoice may reference the system-generated cash customer only
//      when debtAmountSYP = 0 (T1: "An invoice may reference the
//      system-generated customer only when debtAmountSYP = 0").
// Both are what block a malformed invoice from ever being persisted
// locally, at the earliest possible point — the factory itself, not a
// caller several layers up that might forget to check.
//
// [FIX] createOfflineInvoiceRecord/createOfflineVoidRecord previously only
// checked that debtAmountSYP was internally consistent with the caller-
// supplied totalSYP/paidAmountSYP — nothing verified that totalSYP itself
// actually equalled the sum of the cart's own line items. A caller could
// pass an arbitrary totalSYP (e.g. a UI bug computing the wrong subtotal)
// as long as it was self-consistent with paid/debt, and this factory would
// accept it silently. Both factories now recompute the total from
// quantity × unitPriceSYP across every item and reject a mismatch.
//
// [FIX — review pass 3] The system-customer/zero-debt rule above was
// previously enforced ONLY in lib/offline/pos-service.ts's
// submitOfflineSale() — a caller-side check, one layer above this file.
// createOfflineInvoiceRecord itself had no way to even know whether the
// customerId/offlineCustomerId it was given belonged to the system
// customer, so a direct call to this factory (a future feature, a test,
// T4d's void logic, anything that doesn't route through
// submitOfflineSale) could construct an invoice violating this rule with
// nothing here to stop it — the exact same "one enforcement layer instead
// of two" gap already fixed for the totalSYP-matches-items check above.
// Both factories now take an explicit `isSystemCustomer` flag and enforce
// the rule directly, matching the defense-in-depth already applied to
// every other financial invariant in this file.
//
// [FIX — review pass 4] createOfflineVoidRecord previously had no check
// that the void's own (negated) debtAmountSYP was ever <= 0. Every other
// financial invariant in this file is enforced directly at the factory
// rather than trusted from the caller (see the two notes above) — this
// closes the same class of gap for the void's debt sign. A void only
// ever reverses debt that was already validated as >= 0 at the original
// sale's creation (createOfflineInvoiceRecord's own debtSYP < 0 guard),
// so a positive debtAmountSYP reaching this factory always indicates an
// upstream bug (e.g. a caller passing an already-negated value through
// originalDebtAmountSYP by mistake, double-negating it) — this factory no
// longer trusts that upstream logic is correct and rejects it directly.
// ============================================================================

export interface OfflineInvoiceItem {
  productId: string;
  unitId: string;
  /**
   * Decimal-serialized string, never a native JS number. Mirrors
   * ProductBatch.quantity's Decimal(18,4) precision server-side — a
   * weighed/measured product (e.g. produce sold by the kilogram) can carry
   * a fractional quantity, and multiplying a native-number quantity
   * against a decimal.js price would risk reintroducing float drift
   * before the value ever reaches lib/utils/money.ts.
   */
  quantity: string;
  /** AUTHORITATIVE. */
  unitPriceSYP: string;
  /** Derived/informational — unitPriceSYP converted at exchangeRateUsed. */
  unitPriceUSD: string;
}

export interface OfflineInvoice {
  id?: number;
  tenantId: string;
  offlineId: string;
  customerId?: string;
  offlineCustomerId?: string;
  items: OfflineInvoiceItem[];
  /** AUTHORITATIVE. */
  totalSYP: string;
  /** Derived/informational. */
  totalUSD: string;
  exchangeRateUsed: string;
  /** AUTHORITATIVE. */
  paidAmountSYP: string;
  /** Derived/informational. */
  paidAmountUSD: string;
  /** AUTHORITATIVE. */
  debtAmountSYP: string;
  /** Derived/informational. */
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
  invoiceId?: string;
  offlineInvoiceId?: string;
  /** AUTHORITATIVE. */
  amountSYP: string;
  /** Derived/informational. */
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
  isActive?: boolean;
}

export interface CachedProductBatch {
  id: string;
  unitId: string;
  batchNumber: string;
  /**
   * Decimal-serialized string, never a native JS number — mirrors
   * ProductBatch.quantity's Decimal(18,4) precision server-side. See the
   * matching note on OfflineInvoiceItem.quantity above.
   */
  quantity: string;
  expiryDate?: string;
}

export interface CachedProduct {
  id: string;
  tenantId: string;
  name: string;
  category?: string;
  isActive?: boolean;
  units: CachedProductUnit[];
  batches: CachedProductBatch[];
  // NOTE: no top-level priceWholesale here — per T1's Local Offline
  // Database Schema, pricing lives only on each CachedProductUnit
  // (a single product can carry multiple packaging units at different
  // prices/currencies). Always resolve price from the specific unit
  // being sold (units[i].priceWholesale).
}

export interface CachedCustomer {
  id: string;
  tenantId: string;
  name: string;
  phone?: string;
  shopName?: string;
  /** AUTHORITATIVE client-side balance cache. */
  cachedBalanceDebtSYP: string;
  /** Derived/informational, optional — display cache only. */
  cachedBalanceDebtUSD?: string;
  isSystemGenerated?: boolean;
}

export interface CachedSession {
  userId: string;
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  role: "ADMIN" | "CASHIER";
  /** Required boolean — prevents ambiguous offline routing state. */
  isPlatformAdmin: boolean;
  name?: string;
  subscriptionStatus: "ACTIVE" | "EXPIRED" | "PENDING";
  cachedAt: Date;
}

export class OfflineDatabase extends Dexie {
  offlineInvoices!: Table<OfflineInvoice, number>;
  offlinePayments!: Table<OfflinePayment, number>;
  offlineCustomers!: Table<OfflineCustomer, number>;
  cachedTenantSettings!: Table<CachedTenantSettings, string>;
  cachedProducts!: Table<CachedProduct, string>;
  cachedCustomers!: Table<CachedCustomer, string>;
  cachedSession!: Table<CachedSession, string>;

  constructor() {
    super("JomlaTechOffline");

    this.version(1).stores({
      offlineInvoices:
        "++id, &offlineId, tenantId, customerId, offlineCustomerId, status, createdAt",
      offlinePayments:
        "++id, &offlineId, tenantId, customerId, offlineCustomerId, status, createdAt",
      offlineCustomers: "++id, &offlineId, tenantId, status, createdAt",
      cachedTenantSettings: "tenantId, cachedAt",
      cachedProducts: "id, tenantId, isActive, [tenantId+isActive]",
      cachedCustomers: "id, tenantId, phone, isSystemGenerated, [tenantId+phone]",
      cachedSession: "userId, tenantId, cachedAt",
    });

    // [NOTE — review pass 4] cachedSession currently lives inside
    // version(1). This is only correct as long as no prior build has ever
    // shipped to a real device with a version(1) schema that lacked this
    // table. The moment this offline layer is deployed to even one real
    // pilot device, ANY further table/field addition — including a future
    // one, not just this one — must land as a NEW version(N).stores({...})
    // block with a matching .upgrade() migration, never as an edit to an
    // already-shipped version(N) block. Dexie will not retroactively
    // create a table on a device that already opened this database at
    // version 1 without it.
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
  /**
   * [FIX — review pass 3] True when customerId/offlineCustomerId above
   * refers to the tenant's system-generated "زبون نقدي" customer. The
   * caller (lib/offline/pos-service.ts's submitOfflineSale, or any future
   * caller) is responsible for resolving this — this factory has no way
   * to look the customer up itself — but once told, it enforces T1's rule
   * directly rather than trusting every caller to have already checked
   * it upstream. Defaults to false (an ordinary real-customer invoice).
   */
  isSystemCustomer?: boolean;
  items: Array<{
    productId: string;
    unitId: string;
    quantity: MoneyInput;
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
  if (!data.customerId && !data.offlineCustomerId) {
    throw new Error(
      "Offline invoice must reference a customer via either customerId or offlineCustomerId."
    );
  }
  if (!data.items || data.items.length === 0) {
    throw new Error("An offline invoice must have at least one line item.");
  }

  // Serialize every item's quantity/price through the decimal.js boundary
  // immediately — quantity is no longer trusted as a native JS number.
  const serializedItems = data.items.map((item) => ({
    productId: item.productId,
    unitId: item.unitId,
    quantity: serializeMoney(item.quantity),
    unitPriceSYP: serializeMoney(item.unitPriceSYP),
  }));

  if (serializedItems.some((item) => compareMoney(item.quantity, 0) <= 0)) {
    throw new Error("Every line item on a sale must have a strictly positive quantity.");
  }

  const rateUsed = serializeMoney(data.exchangeRateUsed);
  if (compareMoney(rateUsed, 0) <= 0) {
    throw new Error("exchangeRateUsed must be strictly greater than 0.");
  }

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

  // [FIX] T1: "An invoice may reference the system-generated customer
  // only when debtAmountSYP = 0." Previously only checked one layer up,
  // in pos-service.ts's submitOfflineSale — see the file-header note.
  // Enforced here directly so no caller of this factory can bypass it.
  if (data.isSystemCustomer && compareMoney(debtSYP, 0) > 0) {
    throw new Error(
      "An invoice cannot reference the system-generated cash customer while " +
      "debtAmountSYP > 0 — a sale carrying debt requires a real, identified customer."
    );
  }

  const totalSYP = serializeMoney(data.totalSYP);

  // [FIX] totalSYP must actually equal the sum of quantity × unitPriceSYP
  // across every line item — previously unchecked (see file-header note).
  const computedTotal = sumMoney(
    serializedItems.map((item) => multiplyMoney(item.quantity, item.unitPriceSYP))
  );
  if (compareMoney(computedTotal, totalSYP) !== 0) {
    throw new Error(
      `totalSYP (${totalSYP}) must equal the sum of item.quantity × item.unitPriceSYP ` +
      `(${computedTotal}).`
    );
  }

  if (compareMoney(subtractMoney(totalSYP, paidSYP), debtSYP) !== 0) {
    throw new Error("debtAmountSYP must equal totalSYP − paidAmountSYP (SYP is authoritative).");
  }

  const totalUSD = convertCurrency(totalSYP, rateUsed, "SYP", "USD");
  const paidAmountUSD = convertCurrency(paidSYP, rateUsed, "SYP", "USD");
  const debtAmountUSD = convertCurrency(debtSYP, rateUsed, "SYP", "USD");

  return {
    tenantId: data.tenantId,
    offlineId: data.offlineId || generateOfflineId(),
    customerId: data.customerId,
    offlineCustomerId: data.offlineCustomerId,
    items: serializedItems.map((item) => ({
      productId: item.productId,
      unitId: item.unitId,
      quantity: item.quantity,
      unitPriceSYP: item.unitPriceSYP,
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
  /**
   * [FIX — review pass 3] Same flag/rationale as
   * createOfflineInvoiceRecord above. In ordinary operation a void's
   * debtAmountSYP is the negation of an original sale's debtAmountSYP
   * (which was itself already validated as >= 0 at creation, and forced
   * to exactly 0 whenever isSystemCustomer was true) — so this check
   * should never actually trigger for a void produced through the normal
   * flow. It's included anyway for the same defense-in-depth reason as
   * the totalSYP-matches-items check below: this factory should not rely
   * on every possible caller having already re-verified an invariant it
   * can cheaply check itself.
   */
  isSystemCustomer?: boolean;
  items: Array<{
    productId: string;
    unitId: string;
    quantity: MoneyInput;
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

  const serializedItems = data.items.map((item) => ({
    productId: item.productId,
    unitId: item.unitId,
    quantity: serializeMoney(item.quantity),
    unitPriceSYP: serializeMoney(item.unitPriceSYP),
  }));

  if (serializedItems.some((item) => compareMoney(item.quantity, 0) >= 0)) {
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

  // [FIX — review pass 4] A void only ever reverses debt — its own
  // debtAmountSYP must never end up positive. The original sale this void
  // reverses already had its debtAmountSYP validated as >= 0 at creation
  // (createOfflineInvoiceRecord's own guard above), so after negation this
  // value should always be <= 0. A positive value reaching this point
  // means something upstream double-negated, or passed an already-negative
  // originalDebtAmountSYP by mistake — reject it here directly rather than
  // trusting the caller got the sign right, matching the defense-in-depth
  // already applied to every other invariant in this file.
  if (compareMoney(debtSYP, 0) > 0) {
    throw new Error(
      "debtAmountSYP on a void record must not be positive — a void only ever " +
      "reverses debt, never creates it."
    );
  }

  // [FIX] Same system-customer/zero-debt rule as createOfflineInvoiceRecord
  // — see this parameter's doc comment above for why this should be
  // unreachable in normal operation but is still checked directly here.
  if (data.isSystemCustomer && compareMoney(debtSYP, 0) > 0) {
    throw new Error(
      "A void record cannot reference the system-generated cash customer while " +
      "debtAmountSYP > 0 — a sale carrying debt requires a real, identified customer."
    );
  }

  // [FIX] Same total-matches-line-items check as createOfflineInvoiceRecord,
  // applied to the void's own (negated) totalSYP — only meaningful when
  // totalSYP wasn't itself derived from originalTotalSYP above, since in
  // that branch totalSYP is a straight negation, not a fresh sum.
  if (data.originalTotalSYP === undefined) {
    const computedTotal = sumMoney(
      serializedItems.map((item) => multiplyMoney(item.quantity, item.unitPriceSYP))
    );
    if (compareMoney(computedTotal, totalSYP) !== 0) {
      throw new Error(
        `totalSYP (${totalSYP}) must equal the sum of item.quantity × item.unitPriceSYP ` +
        `(${computedTotal}).`
      );
    }
  }

  if (compareMoney(subtractMoney(totalSYP, paidSYP), debtSYP) !== 0) {
    throw new Error(
      "debtAmountSYP must equal totalSYP − paidAmountSYP on the reversing void row as well."
    );
  }

  const totalUSD = convertCurrency(totalSYP, rateUsed, "SYP", "USD");
  const paidAmountUSD = convertCurrency(paidSYP, rateUsed, "SYP", "USD");
  const debtAmountUSD = convertCurrency(debtSYP, rateUsed, "SYP", "USD");

  return {
    tenantId: data.tenantId,
    offlineId: data.offlineId || generateOfflineId(),
    customerId: data.customerId,
    offlineCustomerId: data.offlineCustomerId,
    items: serializedItems.map((item) => ({
      productId: item.productId,
      unitId: item.unitId,
      quantity: item.quantity,
      unitPriceSYP: item.unitPriceSYP,
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
  invoiceId?: string;
  offlineInvoiceId?: string;
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
  if (!data.customerId && !data.offlineCustomerId) {
    throw new Error(
      "Offline payment must reference a customer via either customerId or offlineCustomerId."
    );
  }

  const rate = serializeMoney(data.exchangeRate);
  if (compareMoney(rate, 0) <= 0) {
    throw new Error("exchangeRate must be strictly greater than 0.");
  }

  const amountSYP = serializeMoney(data.amountSYP);
  if (compareMoney(amountSYP, 0) <= 0) {
    throw new Error("amountSYP must be strictly greater than 0 for a payment record.");
  }

  const amountUSD = convertCurrency(amountSYP, rate, "SYP", "USD");

  return {
    tenantId: data.tenantId,
    offlineId: data.offlineId || generateOfflineId(),
    customerId: data.customerId,
    offlineCustomerId: data.offlineCustomerId,
    invoiceId: data.invoiceId,
    offlineInvoiceId: data.offlineInvoiceId,
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
  isActive?: boolean;
  units: Array<{
    id: string;
    unitName: string;
    conversionFactor: number;
    priceWholesale: MoneyInput;
    priceRetail?: MoneyInput;
    pricingCurrency?: "USD" | "SYP";
    barcode?: string;
    barcodeSource?: "GS1" | "INTERNAL";
    isActive?: boolean;
  }>;
  batches: Array<{
    id: string;
    unitId: string;
    batchNumber: string;
    quantity: MoneyInput;
    expiryDate?: string;
  }>;
}): CachedProduct {
  if (!data.tenantId || !data.tenantId.trim()) {
    throw new Error("tenantId is required to create a cached product record.");
  }

  return {
    id: data.id,
    tenantId: data.tenantId,
    name: data.name,
    category: data.category,
    isActive: data.isActive !== false,
    // pricingCurrency here is a merchant's own per-unit pricing choice —
    // unrelated to which currency is authoritative for the ledger (SYP).
    // Two units of the same product can sit in different currencies at
    // the same time; POS-side code resolves each unit's own price into
    // the ledger's SYP-primary figures at cart time.
    units: data.units.map((u) => ({
      id: u.id,
      unitName: u.unitName,
      conversionFactor: u.conversionFactor,
      priceWholesale: serializeMoney(u.priceWholesale),
      priceRetail: u.priceRetail !== undefined ? serializeMoney(u.priceRetail) : undefined,
      pricingCurrency: u.pricingCurrency,
      barcode: u.barcode,
      barcodeSource: u.barcodeSource,
      isActive: u.isActive,
    })),
    // [FIX] quantity is now routed through serializeMoney like every other
    // decimal-precision field in this factory, instead of being passed
    // through untouched as a raw, unvalidated `number` — see
    // CachedProductBatch.quantity's doc comment above.
    batches: data.batches.map((b) => ({
      id: b.id,
      unitId: b.unitId,
      batchNumber: b.batchNumber,
      quantity: serializeMoney(b.quantity),
      expiryDate: b.expiryDate,
    })),
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

export function createCachedSessionRecord(data: {
  userId: string;
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  role: "ADMIN" | "CASHIER";
  isPlatformAdmin: boolean;
  name?: string;
  subscriptionStatus: "ACTIVE" | "EXPIRED" | "PENDING";
  cachedAt?: Date;
}): CachedSession {
  if (!data.userId || !data.userId.trim()) {
    throw new Error("userId is required to create a cached session record.");
  }
  if (!data.tenantId || !data.tenantId.trim()) {
    throw new Error("tenantId is required to create a cached session record.");
  }
  if (data.role !== "ADMIN" && data.role !== "CASHIER") {
    throw new Error(`Invalid role '${data.role}': must be ADMIN or CASHIER.`);
  }
  if (typeof data.isPlatformAdmin !== "boolean") {
    throw new Error("isPlatformAdmin is required and must be a boolean.");
  }

  return {
    userId: data.userId.trim(),
    tenantId: data.tenantId.trim(),
    tenantName: data.tenantName,
    tenantSlug: data.tenantSlug,
    role: data.role,
    isPlatformAdmin: data.isPlatformAdmin,
    name: data.name,
    subscriptionStatus: data.subscriptionStatus,
    cachedAt: data.cachedAt ? new Date(data.cachedAt) : new Date(),
  };
}