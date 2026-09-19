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
// [FIX — review pass 8, this revision] Two real gaps closed:
//
//   1. Neither createOfflineInvoiceRecord nor createOfflineVoidRecord ever
//      checked the SIGN of paidAmountSYP — every other financial field in
//      this file has an explicit, dedicated sign guard (debtAmountSYP >= 0
//      on a plain sale, debtAmountSYP <= 0 on a void, amountSYP > 0 on a
//      payment record), but paidAmountSYP had none. Without it, a caller
//      could submit e.g. totalSYP=100, paidAmountSYP=-10,
//      debtAmountSYP=110 — every EXISTING check in this file passes that
//      combination (110 >= 0 is true; 100 − (−10) = 110 matches the
//      supplied debtAmountSYP), yet it describes a nonsensical state: a
//      100 SYP sale somehow generating 110 SYP of debt via a "negative
//      payment." Fixed by adding an explicit, dedicated guard on
//      paidAmountSYP in both factories — >= 0 on the plain sale, <= 0 on
//      the void (mirroring its own negated-sign convention, exactly the
//      same treatment already applied to debtAmountSYP on each factory).
//      This also transitively guarantees debtAmountSYP can never exceed
//      totalSYP on a plain sale (since debtSYP = totalSYP − paidSYP, and
//      paidSYP >= 0 forces debtSYP <= totalSYP) without needing a
//      separate explicit check for that.
//
// See all prior review-pass notes preserved below for the full history of
// this file's defense-in-depth financial-invariant checks.
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
  /**
   * Derived/informational — unitPriceSYP converted at exchangeRateUsed.
   * Nullable: null whenever the parent invoice's exchangeRateUsed is null
   * (a SYP-only sale that never needed a rate).
   */
  unitPriceUSD: string | null;
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
  totalUSD: string | null;
  /** null for a SYP-only sale that never needed a rate to resolve. */
  exchangeRateUsed: string | null;
  /** AUTHORITATIVE. */
  paidAmountSYP: string;
  /** Derived/informational. */
  paidAmountUSD: string | null;
  /** AUTHORITATIVE. */
  debtAmountSYP: string;
  /** Derived/informational. */
  debtAmountUSD: string | null;
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
  /**
   * Decimal-serialized string, never a native JS number — mirrors
   * ProductUnit.conversionFactor's server-side precision. Any client-side
   * conversion of a sale-unit quantity into the product's base unit —
   * while offline, before this record ever reaches the server — must go
   * through the same decimal.js discipline as every other quantity/price
   * figure in this file.
   */
  conversionFactor: string;
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
   * ProductBatch.quantity's Decimal(18,4) precision server-side.
   *
   * [NOTE] Under v4.0, ProductBatch.unitId is always the product's
   * current base unit for any batch created after the base-unit
   * architecture was adopted — see schema.prisma's ProductBatch.unitId
   * note. A batch may still reference a NON-base unit only as a legacy
   * artifact of data created before v4.0 (unitId cannot be rewritten
   * retroactively by a migration without a full manual audit — see
   * UNIT-ARCHITECTURE.md §8). getOfflineProducts() below converts via
   * each batch's own unit's conversionFactor specifically to stay correct
   * for that legacy case; for any batch created under v4.0, that unit's
   * conversionFactor is structurally always "1", making the conversion a
   * no-op.
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
  /**
   * True when this customer has at least one Invoice on the server, of
   * any status — an established, documented relationship with the
   * merchant. Populated by /api/customers and consumed by
   * lib/offline/pos-service.ts's submitOfflineSale(): an offline credit
   * sale (debtAmountSYP > 0) is only permitted against a customer where
   * this is true. See pos-service.ts's isEligibleForCredit().
   *
   * Optional/undefined only for backward compatibility with any
   * previously-cached row written before this field existed; treated as
   * `false` (no credit) wherever it's read, never as "unknown, allow it."
   */
  hasPriorInvoices?: boolean;
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

    // Any future table/field addition must land as a NEW
    // version(N).stores({...}) block with a matching .upgrade()
    // migration, never as an edit to an already-shipped version(N) block
    // — Dexie will not retroactively create a table/index on a device
    // that already opened this database at an earlier version. This does
    // NOT apply to a plain value field's TypeScript type or nullability
    // (e.g. OfflineInvoice's USD fields, CachedProductUnit.conversionFactor's
    // type) as long as that field is not part of any indexed key above —
    // only offlineId/tenantId/customerId/offlineCustomerId/status/
    // createdAt are indexed on offlineInvoices, and only id/tenantId/
    // isActive on cachedProducts.
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
    // [FIX — review pass 9] Reject, not resolve, on "blocked." This
    // function's ENTIRE purpose is guaranteeing a genuinely clean slate
    // before a test runs — a blocked delete means another open
    // connection (e.g. a previous test's un-closed instance, or a
    // leftover browser tab) prevented the database from actually being
    // removed. Resolving anyway would let a subsequent test silently run
    // against stale, un-reset state, and any failure it then produces
    // would have no visible connection back to this function as the real
    // cause. Failing loud here, with a message naming the actual reason,
    // surfaces the problem at its source instead of as a mysterious
    // downstream test failure.
    request.onblocked = () =>
      reject(
        new Error(
          "resetOfflineDbForTests: deleteDatabase was blocked by another " +
          "open connection to 'JomlaTechOffline' — close every other tab/" +
          "instance holding this database open before resetting, or call " +
          "offlineDbInstance.close() on it first."
        )
      );
  });
}

export function createOfflineInvoiceRecord(data: {
  tenantId: string;
  offlineId?: string;
  customerId?: string;
  offlineCustomerId?: string;
  isSystemCustomer?: boolean;
  requiresExchangeRate?: boolean;
  items: Array<{
    productId: string;
    unitId: string;
    quantity: MoneyInput;
    unitPriceSYP: MoneyInput;
  }>;
  totalSYP: MoneyInput;
  exchangeRateUsed?: MoneyInput | null;
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

  const serializedItems = data.items.map((item) => ({
    productId: item.productId,
    unitId: item.unitId,
    quantity: serializeMoney(item.quantity),
    unitPriceSYP: serializeMoney(item.unitPriceSYP),
  }));

  if (serializedItems.some((item) => compareMoney(item.quantity, 0) <= 0)) {
    throw new Error("Every line item on a sale must have a strictly positive quantity.");
  }

  const requiresExchangeRate = data.requiresExchangeRate ?? true;

  let rateUsed: string | null = null;
  if (data.exchangeRateUsed !== undefined && data.exchangeRateUsed !== null) {
    rateUsed = serializeMoney(data.exchangeRateUsed);
    if (compareMoney(rateUsed, 0) <= 0) {
      throw new Error("exchangeRateUsed must be strictly greater than 0 when provided.");
    }
  }

  if (requiresExchangeRate && rateUsed === null) {
    throw new Error(
      "exchangeRateUsed is required — this sale contains at least one USD-priced item " +
      "(or requiresExchangeRate was not explicitly disabled)."
    );
  }

  const paidSYP = serializeMoney(data.paidAmountSYP);

  // [FIX — review pass 8] paidAmountSYP had no dedicated sign guard,
  // unlike every other financial field in this file. Without this, e.g.
  // totalSYP=100, paidAmountSYP=-10, debtAmountSYP=110 passed every
  // existing check (110 >= 0; 100 − (−10) = 110) despite describing a
  // nonsensical state — a 100 SYP sale generating 110 SYP of debt via a
  // negative "payment." This also transitively guarantees debtAmountSYP
  // can never exceed totalSYP on a plain sale, since debtSYP = totalSYP
  // − paidSYP and paidSYP >= 0 forces debtSYP <= totalSYP.
  if (compareMoney(paidSYP, 0) < 0) {
    throw new Error("paidAmountSYP must not be negative.");
  }

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

  if (data.isSystemCustomer && compareMoney(debtSYP, 0) > 0) {
    throw new Error(
      "An invoice cannot reference the system-generated cash customer while " +
      "debtAmountSYP > 0 — a sale carrying debt requires a real, identified customer."
    );
  }

  const totalSYP = serializeMoney(data.totalSYP);

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

  const totalUSD = rateUsed !== null ? convertCurrency(totalSYP, rateUsed, "SYP", "USD") : null;
  const paidAmountUSD =
    rateUsed !== null ? convertCurrency(paidSYP, rateUsed, "SYP", "USD") : null;
  const debtAmountUSD =
    rateUsed !== null ? convertCurrency(debtSYP, rateUsed, "SYP", "USD") : null;

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
      unitPriceUSD:
        rateUsed !== null ? convertCurrency(item.unitPriceSYP, rateUsed, "SYP", "USD") : null,
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
  isSystemCustomer?: boolean;
  requiresExchangeRate?: boolean;
  items: Array<{
    productId: string;
    unitId: string;
    quantity: MoneyInput;
    unitPriceSYP: MoneyInput;
  }>;
  originalTotalSYP?: MoneyInput;
  totalSYP?: MoneyInput;
  exchangeRateUsed?: MoneyInput | null;
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

  const requiresExchangeRate = data.requiresExchangeRate ?? true;

  let rateUsed: string | null = null;
  if (data.exchangeRateUsed !== undefined && data.exchangeRateUsed !== null) {
    rateUsed = serializeMoney(data.exchangeRateUsed);
    if (compareMoney(rateUsed, 0) <= 0) {
      throw new Error("exchangeRateUsed must be strictly greater than 0 when provided.");
    }
  }

  if (requiresExchangeRate && rateUsed === null) {
    throw new Error(
      "exchangeRateUsed is required to void this invoice — the original sale " +
      "contained at least one USD-priced item (or requiresExchangeRate was not " +
      "explicitly disabled to match the original invoice)."
    );
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

  // [FIX — review pass 8] Mirrors the debtAmountSYP guard immediately
  // below: paidAmountSYP on a void record must never end up positive — a
  // void only ever reverses a previously-collected (non-negative)
  // payment, never creates a new positive one. The same class of gap as
  // createOfflineInvoiceRecord's own missing paidAmountSYP sign check
  // above, just mirrored for the void's negated-sign convention. A
  // positive value reaching this point means something upstream failed
  // to negate correctly (or passed an already-negative
  // originalPaidAmountSYP by mistake, double-negating it).
  if (compareMoney(paidSYP, 0) > 0) {
    throw new Error(
      "paidAmountSYP on a void record must not be positive — a void only ever " +
      "reverses a previously-collected payment, never creates one."
    );
  }

  if (compareMoney(debtSYP, 0) > 0) {
    throw new Error(
      "debtAmountSYP on a void record must not be positive — a void only ever " +
      "reverses debt, never creates it."
    );
  }

  if (data.isSystemCustomer && compareMoney(debtSYP, 0) !== 0) {
    throw new Error(
      "A void record cannot reference the system-generated cash customer while " +
      "debtAmountSYP is nonzero — the system customer must never carry debt or credit."
    );
  }

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
    throw new Error(
      "debtAmountSYP must equal totalSYP − paidAmountSYP on the reversing void row as well."
    );
  }

  const totalUSD = rateUsed !== null ? convertCurrency(totalSYP, rateUsed, "SYP", "USD") : null;
  const paidAmountUSD =
    rateUsed !== null ? convertCurrency(paidSYP, rateUsed, "SYP", "USD") : null;
  const debtAmountUSD =
    rateUsed !== null ? convertCurrency(debtSYP, rateUsed, "SYP", "USD") : null;

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
      unitPriceUSD:
        rateUsed !== null ? convertCurrency(item.unitPriceSYP, rateUsed, "SYP", "USD") : null,
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
  if (data.invoiceId && data.offlineInvoiceId) {
    throw new Error("Offline payment cannot have both invoiceId and offlineInvoiceId.");
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
    conversionFactor: MoneyInput;
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
    units: data.units.map((u) => ({
      id: u.id,
      unitName: u.unitName,
      conversionFactor: serializeMoney(u.conversionFactor),
      priceWholesale: serializeMoney(u.priceWholesale),
      priceRetail: u.priceRetail !== undefined ? serializeMoney(u.priceRetail) : undefined,
      pricingCurrency: u.pricingCurrency,
      barcode: u.barcode,
      barcodeSource: u.barcodeSource,
      isActive: u.isActive,
    })),
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
  hasPriorInvoices?: boolean;
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
    hasPriorInvoices: data.hasPriorInvoices === true,
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