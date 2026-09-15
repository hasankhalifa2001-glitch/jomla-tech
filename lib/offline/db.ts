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
//
// [FIX — review pass 5] Two gaps closed:
//   1. createOfflineVoidRecord's isSystemCustomer check previously read
//      `compareMoney(debtSYP, 0) > 0` — but by that point in the function,
//      the void-debt-sign guard immediately above it has already
//      unconditionally rejected any positive debtSYP, regardless of
//      isSystemCustomer. That made the isSystemCustomer branch dead code:
//      it could never actually fire, despite its comment claiming to
//      provide defense-in-depth. The one residual case actually worth
//      catching — a NEGATIVE debtSYP paired with isSystemCustomer (the
//      system customer must never carry debt OR credit, not just "no
//      positive debt") — was not checked by anything. Changed to `!== 0`,
//      which is both reachable and meaningful.
//   2. createOfflinePaymentRecord's new invoiceId/offlineInvoiceId fields
//      had no mutual-exclusivity check, unlike every other paired
//      offline/synced identifier in this file (customerId/
//      offlineCustomerId above). A payment record can legitimately
//      reference neither (an independent repayment) or exactly one (a
//      sale-time payment tied to either a not-yet-synced local invoice or
//      an already-synced server one) — never both at once. Added the same
//      guard pattern already used for customerId/offlineCustomerId.
//
// [ADDED — offline credit-sale gate] CachedCustomer.hasPriorInvoices and
// createCachedCustomerRecord's matching parameter are new in this
// revision — see CachedCustomer.hasPriorInvoices's own doc comment below
// for the full reasoning. Consumed by lib/offline/pos-service.ts's
// submitOfflineSale() to decide whether a customer may be extended
// offline credit at all.
//
// [FIX — review pass 6, closes a real compile/runtime break] pos-service.ts's
// submitOfflineSale() (T4b) computes `requiresExchangeRate =
// cartNeedsExchangeRate(payload.items)` and, for a cart composed entirely
// of SYP-priced units, calls this factory with `exchangeRateUsed:
// undefined` and `requiresExchangeRate: false` — matching T4b's own
// acceptance criterion: "checkout blocks only for a USD-priced item with
// no cached rate, never for SYP-only carts." Neither factory below
// previously accepted a `requiresExchangeRate` parameter at all, and both
// UNCONDITIONALLY required `exchangeRateUsed` to serialize to a
// strictly-positive value — so a SYP-only cart's `exchangeRateUsed:
// undefined` hit `serializeMoney(undefined)` and threw immediately,
// failing the exact scenario this whole conditional design exists to
// support. Fixed by:
//   1. Adding `requiresExchangeRate?: boolean` to both factories, default
//      `true` when omitted — this preserves the OLD, stricter behavior
//      for every existing caller that doesn't pass it explicitly (a rate
//      is still mandatory unless a caller deliberately opts out).
//   2. `exchangeRateUsed` is now `MoneyInput | null` (optional) on both
//      factories. When absent/null AND requiresExchangeRate is false, no
//      rate is required and every USD-derived field (totalUSD,
//      paidAmountUSD, debtAmountUSD, each item's unitPriceUSD, and
//      exchangeRateUsed itself) is stored as `null` — genuinely "no rate
//      was available or needed," never a fabricated placeholder number.
//   3. OfflineInvoice.exchangeRateUsed/totalUSD/paidAmountUSD/
//      debtAmountUSD and OfflineInvoiceItem.unitPriceUSD are now
//      `string | null` accordingly. This is a TypeScript-level shape
//      change only — none of these fields are part of any Dexie index key
//      (see the version(1).stores() indexes below), so this does NOT
//      require a Dexie version() bump/.upgrade() migration; it only
//      requires every consumer of these fields (T4c's sync engine, T4f's
//      receipt rendering, any future ledger/report screen) to handle a
//      `null` USD figure the same way the UI already must for a live
//      cart line with no cached rate (T1: "omitted entirely, not shown as
//      an error").
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
   * [FIX — review pass 6] Now nullable: null whenever the parent
   * invoice's exchangeRateUsed is null (a SYP-only sale that never needed
   * a rate) — see the file-header FIX note above.
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
  /** Derived/informational. [FIX — review pass 6] Now nullable — see file-header note. */
  totalUSD: string | null;
  /** [FIX — review pass 6] Now nullable — null for a SYP-only sale that
   * never needed a rate to resolve. See the file-header FIX note above. */
  exchangeRateUsed: string | null;
  /** AUTHORITATIVE. */
  paidAmountSYP: string;
  /** Derived/informational. [FIX — review pass 6] Now nullable. */
  paidAmountUSD: string | null;
  /** AUTHORITATIVE. */
  debtAmountSYP: string;
  /** Derived/informational. [FIX — review pass 6] Now nullable. */
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
  /**
   * [ADDED — offline credit-sale gate] True when this customer has at
   * least one Invoice on the server, of any status — i.e. an established,
   * documented relationship with the merchant, not merely a row that
   * exists in the customer table. Populated by /api/customers (which
   * already fetches each customer's invoices to compute
   * cachedBalanceDebtSYP, so this costs no extra query) and consumed by
   * lib/offline/pos-service.ts's submitOfflineSale(): an offline credit
   * sale (debtAmountSYP > 0) is only permitted against a customer where
   * this is true. See pos-service.ts's isEligibleForCredit() for the full
   * commercial reasoning (credit is extended to known, documented
   * customers — never to a customer this device cannot yet verify has
   * ever transacted with the merchant at all, walk-in or otherwise).
   *
   * This is a monotonic fact once true (a customer's first invoice
   * doesn't un-happen), so a stale cached copy can only ever be wrong in
   * the safe direction: a genuinely-established customer whose very
   * first invoice hasn't reached this device's cache yet would show
   * false here and be temporarily blocked from an offline credit sale —
   * an over-cautious false negative, never an under-cautious false
   * positive that would incorrectly allow credit.
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
    //
    // [NOTE — review pass 6] This does NOT apply to review pass 6's
    // OfflineInvoice/OfflineInvoiceItem USD-field nullability change
    // above — those fields are not part of any index key in the
    // stores({...}) call above (only offlineId/tenantId/customerId/
    // offlineCustomerId/status/createdAt are indexed on offlineInvoices),
    // so Dexie's physical schema is completely unaffected. Only a change
    // to an INDEXED key ever requires a version bump; a plain value
    // field's TypeScript type (or even its presence/absence on a given
    // record) is something Dexie has never enforced.
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
  /**
   * [ADDED — review pass 6] True when at least one line item was priced
   * in USD, meaning a real, strictly-positive exchangeRateUsed is
   * mandatory to resolve it. Defaults to `true` when omitted — this
   * preserves the OLD, stricter behavior (a rate was always required) for
   * every existing/future caller that doesn't explicitly pass `false`.
   * pos-service.ts's submitOfflineSale() computes this via
   * cartNeedsExchangeRate(payload.items) and passes it through explicitly
   * — see the file-header FIX note above for the full scenario this
   * unblocks (a SYP-only cart submitting with no cached rate).
   */
  requiresExchangeRate?: boolean;
  items: Array<{
    productId: string;
    unitId: string;
    quantity: MoneyInput;
    unitPriceSYP: MoneyInput;
  }>;
  totalSYP: MoneyInput;
  /**
   * [FIX — review pass 6] Now optional/nullable. Required to be a real,
   * strictly-positive value ONLY when requiresExchangeRate is true (the
   * default). When requiresExchangeRate is explicitly false and this is
   * omitted/null, every USD-derived field on the resulting record
   * (totalUSD, paidAmountUSD, debtAmountUSD, each item's unitPriceUSD,
   * and this field itself) is stored as `null`.
   */
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

  // [FIX — review pass 6] Conditional exchange-rate requirement — see
  // this parameter's doc comment and the file-header FIX note above.
  // requiresExchangeRate defaults to true (old, stricter behavior) unless
  // a caller explicitly opts out for a cart that never needed a rate.
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
  // (debtSYP is already guaranteed >= 0 by the guard immediately above,
  // so `> 0` here is equivalent to `!== 0` for this factory — unlike the
  // void factory below, where debtSYP's valid range is different.)
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

  // [FIX — review pass 6] Every USD-derived figure is now conditional on
  // rateUsed actually being available — null (never a fabricated number)
  // when this is a SYP-only sale that opted out via requiresExchangeRate.
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
  /**
   * [ADDED — review pass 6] Mirrors createOfflineInvoiceRecord's own
   * parameter — a void of a SYP-only original sale never needed a rate
   * either, and must be voidable without one. Defaults to `true` (old,
   * stricter behavior) when omitted. A caller voiding an invoice should
   * pass through whatever the ORIGINAL invoice's own requirement was
   * (e.g. `originalInvoice.exchangeRateUsed !== null`).
   */
  requiresExchangeRate?: boolean;
  items: Array<{
    productId: string;
    unitId: string;
    quantity: MoneyInput;
    unitPriceSYP: MoneyInput;
  }>;
  originalTotalSYP?: MoneyInput;
  totalSYP?: MoneyInput;
  /**
   * [FIX — review pass 6] Now optional/nullable — see
   * createOfflineInvoiceRecord's matching parameter doc comment above for
   * the full reasoning.
   */
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

  // [FIX — review pass 6] Same conditional exchange-rate logic as
  // createOfflineInvoiceRecord — see that function's matching block for
  // the full reasoning.
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

  // [FIX — review pass 5] Changed from `> 0` to `!== 0`. debtSYP is
  // already guaranteed <= 0 by the guard immediately above, so a `> 0`
  // condition here could never actually fire — it was dead code despite
  // claiming to provide defense-in-depth. The one residual case actually
  // worth catching is a NEGATIVE debtSYP paired with isSystemCustomer:
  // the system-generated cash customer must never carry debt OR credit,
  // not merely "no positive debt" — `!== 0` is both reachable and
  // actually enforces that.
  if (data.isSystemCustomer && compareMoney(debtSYP, 0) !== 0) {
    throw new Error(
      "A void record cannot reference the system-generated cash customer while " +
      "debtAmountSYP is nonzero — the system customer must never carry debt or credit."
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

  // [FIX — review pass 6] Conditional on rateUsed, same as
  // createOfflineInvoiceRecord above.
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
  // [FIX — review pass 5] Same mutual-exclusivity guard as
  // customerId/offlineCustomerId above, now applied to invoiceId/
  // offlineInvoiceId. A payment record legitimately references neither
  // (an independent repayment) or exactly one (a sale-time payment tied
  // to a not-yet-synced local invoice, or an already-synced server one)
  // — never both at once.
  if (data.invoiceId && data.offlineInvoiceId) {
    throw new Error("Offline payment cannot have both invoiceId and offlineInvoiceId.");
  }

  // [NOTE] A payment record's own exchangeRate is deliberately left
  // REQUIRED and non-nullable, unlike the invoice/void factories above.
  // A repayment is always collected and logged at a real, known moment in
  // time — it is never assembled from a cart that might contain zero
  // USD-priced lines — so there is no equivalent "this specific record
  // never needed a rate" case to accommodate here.
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
  /** [ADDED — offline credit-sale gate] See CachedCustomer.hasPriorInvoices's
   * doc comment above. Defaults to false (no credit) rather than true if
   * omitted — never assume prior usage that wasn't explicitly confirmed
   * by the caller. */
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