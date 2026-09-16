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
 * TENANT SCOPING POLICY:
 * - WRITE paths (submitOfflineSale, createOfflineWalkInCustomer,
 *   seedSampleOfflineData) require a real, non-empty tenantId and throw
 *   otherwise. A write is the only path that can create durable,
 *   tenant-attributable data — falling back to a shared sentinel key here
 *   risks silently filing a real sale, customer, or seeded demo data under
 *   a bucket no legitimate tenant will ever query again.
 * - READ paths (getOfflineProducts, getOfflineCustomers,
 *   getOfflineInvoicesList, findMatchingCustomerByPhone) fall back to a
 *   local, read-only sentinel key via resolveTenantId() when no tenantId
 *   is given. This is safe specifically because nothing in this file ever
 *   WRITES under that sentinel — every write path above requires a real
 *   tenantId and throws otherwise — so a read that falls back to it can
 *   only ever resolve to an empty result, never another tenant's data.
 *   This is deliberately a private constant local to this file, not
 *   shared with exchange-rate.ts's own tenant-scoping — that module's
 *   former shared cache key was a real cross-tenant leak precisely
 *   because it WAS written to from more than one call path; that
 *   reasoning does not apply here.
 *
 *   [FIX — review pass 3] resolveTenantId() previously fell back to this
 *   sentinel silently, with no signal to the developer that a read
 *   happened without a real tenantId. Silence here is safe (see above)
 *   but not necessarily correct — a screen that forgot to pass tenantId
 *   (e.g. a session/tenant context not yet loaded) would render an empty
 *   list with no error, no warning, nothing to explain why. A dev-only
 *   console.warn now fires on that fallback, so a missing-tenantId bug
 *   surfaces during development instead of only manifesting as "why is
 *   the POS showing zero products" days later.
 *
 * [v3.6] CURRENCY RE-ANCHORING — mirrors schema.prisma and db.ts. SYP is
 * now the authoritative currency for cart line items, cart totals, and
 * the sale payload. USD fields are derived/display-only, computed from
 * the SYP figure via the cached exchange rate, and are `null` whenever no
 * exchange rate is cached yet — unlike SYP, USD must never throw just
 * because a rate is missing, since it no longer gates anything.
 *
 * [FIX] Deactivated-unit enforcement (T3 acceptance criteria: "Deactivating
 * a ProductUnit (isActive = false) removes it from POS and storefront
 * pickers immediately, while every past InvoiceItem/ProductBatch
 * referencing it remains fully readable and unaffected"). Two layers:
 *   1. getSellableUnits() — the filter a picker UI should build its "add
 *      to cart" unit list from.
 *   2. resolveUnitPriceSYP() — a hard stop that throws if asked to price
 *      a deactivated unit at all, so a caller that forgot to filter (or a
 *      stale cached copy) can never actually add one to a cart or bill it.
 *
 * [FIX — ADDED, review pass] Two additional gaps closed in this revision:
 *   1. submitOfflineSale() previously validated debtAmountSYP against
 *      totalSYP/paidAmountSYP, but never validated that totalSYP itself
 *      matched the actual sum of the cart's line items. A caller (a UI
 *      bug, stale state, or a directly-constructed payload) could submit
 *      a totalSYP that was internally consistent with paidAmountSYP/
 *      debtAmountSYP yet completely disconnected from what the cart
 *      actually contains. submitOfflineSale now recomputes the expected
 *      total via the same calculateCartTotals() this file already
 *      exposes, and rejects any mismatch before ever constructing the
 *      offline invoice record.
 *   2. getOfflineCustomers() previously merged cachedCustomers with EVERY
 *      row in offlineCustomers regardless of sync status. Once T4c's sync
 *      engine marks a walk-in row SYNCED (after creating/matching a real
 *      Customer that then lands in cachedCustomers on the next catalog
 *      refresh), that same customer could appear twice in the picker —
 *      once as WALK_IN (the now-stale local row) and once as EXISTING
 *      (the synced server copy). offlineCustomers is now filtered to
 *      exclude SYNCED rows before merging, so a synced walk-in customer
 *      is represented exactly once, via its real cachedCustomers copy.
 *
 * [FIX — review pass 2]
 *   1. This file previously imported DEFAULT_TENANT_CACHE_KEY from
 *      ./exchange-rate for use in resolveTenantId(). That constant was
 *      removed from exchange-rate.ts entirely (it was a genuine
 *      cross-tenant leak there — the old key WAS written to, from
 *      multiple call sites, whenever a caller forgot to pass tenantId).
 *      This file now defines its own private, read-only sentinel
 *      (READ_ONLY_UNSCOPED_KEY) — safe here specifically because nothing
 *      in this file ever writes under it (see TENANT SCOPING POLICY
 *      above), unlike the old exchange-rate.ts key.
 *   2. seedSampleOfflineData() previously passed a top-level
 *      `priceWholesale` field into every createCachedProductRecord(...)
 *      call across all 7 sample products. createCachedProductRecord's
 *      signature (db.ts) has no such field — per T1's Local Offline
 *      Database Schema, pricing lives only on each unit
 *      (CachedProductUnit.priceWholesale), never on the product itself,
 *      since a single product can carry units priced very differently
 *      (e.g. 1.2$ per كيس vs 55$ per شوال كبير). Removed from all 7
 *      product literals — each unit's own priceWholesale (already
 *      correctly present in every `units: [...]` array below) is
 *      untouched and remains the real, authoritative price.
 *   3. submitOfflineSale() now normalizes paymentMethod defensively
 *      before constructing the invoice record — undefined whenever
 *      paidAmountSYP is exactly 0 — rather than trusting the caller (the
 *      POS UI) to have already cleared it for a fully-on-credit sale.
 *      createOfflineInvoiceRecord (db.ts) throws if paymentMethod is set
 *      on a paidAmountSYP === 0 sale; this normalization makes that
 *      invariant hold here regardless of what the UI passed in.
 *
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
  type CachedProductUnit,
  type OfflineInvoice,
} from "./db";
import { setCachedRate } from "./exchange-rate";
import { generateOfflineId } from "./id";
import { saveOfflineInvoiceWithBalance, saveOfflinePaymentWithBalance } from "./transaction-helpers";
import { refreshProductCache } from "./cache-refresh";
import {
  compareMoney,
  toDecimal,
  multiplyMoney,
  subtractMoney,
  sumMoney,
  convertCurrency,
  serializeMoney,
  type MoneyInput,
} from "../utils/money";

export interface PosProductItem extends CachedProduct {
  totalCachedStock: number;
}

export interface SelectedCustomer {
  type: "EXISTING" | "WALK_IN" | "SYSTEM";
  id: string;
  name: string;
  phone?: string;
  shopName?: string;
  // [v3.6] AUTHORITATIVE. undefined means "not known from this lookup" —
  // NEVER assume undefined means zero; only an explicit 0 is a confirmed
  // zero balance. See findMatchingCustomerByPhone's ONLINE branch.
  balanceDebtSYP?: number;
  // [v3.6] Derived/informational, when available.
  balanceDebtUSD?: number;
  isSystemGenerated?: boolean;
  /**
   * [T4b — offline credit-sale gate] Mirrors
   * CachedCustomer.hasPriorInvoices (db.ts) — true only when this
   * customer has at least one real Invoice on the server. undefined means
   * "unknown from this source" (e.g. a WALK_IN customer, which has no
   * CachedCustomer row at all, or an ONLINE phone-lookup match, which
   * doesn't carry this field) and must NEVER be treated as eligible for
   * credit — see isEligibleForCredit() below, which only ever accepts an
   * explicit `true`.
   */
  hasPriorInvoices?: boolean;
}

export interface CartLineItem {
  id: string;
  product: CachedProduct;
  unitId: string;
  unitName: string;
  conversionFactor: number;
  quantity: number;
  // [v3.6] AUTHORITATIVE.
  unitPriceSYP: string;
  // [v3.6] Derived/informational — null if no exchange rate was cached
  // when this line was added to the cart.
  unitPriceUSD: string | null;
  // [T4b] The merchant's own pricing denomination for this specific unit —
  // does NOT mean USD is authoritative on the cart; SYP always is.
  // Used by cartNeedsExchangeRate() to determine whether checkout can
  // proceed without a cached rate (SYP-only carts can; USD-priced items
  // need a rate to resolve their unitPriceSYP in the first place).
  pricingCurrency: "USD" | "SYP";
  priceRetailSYP?: string;
  priceRetailUSD?: string | null;
}

export interface CartTotalsResult {
  // [v3.6] AUTHORITATIVE — always computable, since every line's
  // unitPriceSYP was already resolved (with a rate, if needed) at
  // add-to-cart time.
  totalSYP: string;
  // [v3.6] Derived/informational — null only if the caller passes no
  // exchange rate to this function itself (e.g. rendering the cart
  // before a rate has loaded).
  totalUSD: string | null;
  itemCount: number;
  lineItems: Array<{
    id: string;
    lineTotalSYP: string;
    lineTotalUSD: string | null;
  }>;
}

export interface OfflineSalePayload {
  customer?: SelectedCustomer | null;
  items: CartLineItem[];
  // [v3.6] AUTHORITATIVE fields only. totalUSD/paidAmountUSD/debtAmountUSD
  // are deliberately NOT part of this payload anymore — they're derived
  // downstream by createOfflineInvoiceRecord from these SYP figures plus
  // exchangeRateUsed, removing the possibility of two independently-
  // supplied numbers drifting apart (see the removed cross-check note in
  // submitOfflineSale below).
  totalSYP: MoneyInput;
  /**
   * [FIX — review pass 4, T4b] Now nullable. A cart composed entirely of
   * SYP-priced units (cartNeedsExchangeRate(items) === false) has no rate
   * to give — pass `null` rather than inventing a placeholder value. When
   * the cart DOES contain a USD-priced item, this must be a real,
   * strictly-positive rate or submitOfflineSale rejects the sale before
   * ever constructing an invoice record.
   */
  exchangeRateUsed: MoneyInput | null;
  paidAmountSYP: MoneyInput;
  debtAmountSYP: MoneyInput;
  paymentMethod?: PaymentMethod;
}

export interface DuplicatePhoneMatch {
  customer: SelectedCustomer;
  source: "CACHED" | "OFFLINE" | "ONLINE";
}

// ============================================================================
// [FIX] Stock-display helpers.
//
// ProductBatch/CachedProductBatch.quantity is stored in whatever unit that
// specific batch was recorded in (a batch recorded as "5 كرتونة" stores
// quantity: 5, NOT 5 × conversionFactor). Any code that needs a single
// TOTAL figure across batches recorded in different units (e.g. one batch
// in كرتونة, another in قطعة, for the same product) MUST convert each
// batch to the product's base unit (conversionFactor === 1) via its own
// unit's conversionFactor BEFORE summing — never sum raw `quantity`
// values across batches blindly, since that silently treats "5 كرتونة"
// and "5 قطعة" as the same 5.
//

// ============================================================================

export interface StockBreakdownPart {
  unitName: string;
  count: number;
}

/**
 * Breaks a total, base-unit stock quantity into a human-readable
 * multi-unit breakdown — largest packaging unit first, remainder in
 * smaller units, down to the base (conversionFactor === 1) unit. e.g. for
 * a product with "قطعة" (factor 1) and "كرتونة" (factor 12), a
 * totalBaseQuantity of 65 becomes [{count: 5, unitName: "كرتونة"},
 * {count: 5, unitName: "قطعة"}].
 *
 * Deliberately unit-name-agnostic (works for "شوال"/"طرد"/"باكيت", not
 * just "كرتونة"/"قطعة") since ProductUnit.unitName is merchant-defined
 * free text, not a fixed enum.
 *
 * [NOTE] If `units` contains no conversionFactor === 1 entry at all (a
 * product defined entirely in packaging units above the base — unusual,
 * but not schema-impossible), any leftover remainder is labeled "قطعة" as
 * a display fallback even though no such unit actually exists on this
 * product. This is a cosmetic labeling edge case, not a stock-accuracy
 * bug — the numeric `count` is still correct; only the unit name shown
 * for the remainder may not match a real unit on this specific product.
 */
export function breakdownStockByUnits(
  totalBaseQuantity: number,
  units: CachedProductUnit[]
): StockBreakdownPart[] {
  if (!totalBaseQuantity || totalBaseQuantity <= 0) return [];

  if (!units || units.length === 0) {
    return [{ unitName: "قطعة", count: totalBaseQuantity }];
  }

  // Sort descending by conversionFactor so we greedily divide from the
  // largest packaging unit down to the smallest.
  const sortedUnits = [...units].sort(
    (a, b) => (Number(b.conversionFactor) || 1) - (Number(a.conversionFactor) || 1)
  );

  // [FIX — review pass 5] `remaining` is now tracked as a decimal.js
  // instance throughout the entire loop, never as a native JS number
  // that gets multiplied/subtracted with `*`/`-`. Every step — the
  // division to find how many whole packaging units fit, and the
  // subtraction of what was just allocated — happens in exact decimal
  // arithmetic. `Number(...)` is applied only once per emitted part,
  // to the already decimal-exact string, purely for display.
  let remaining = toDecimal(totalBaseQuantity);
  const parts: StockBreakdownPart[] = [];

  for (const unit of sortedUnits) {
    const factor = Number(unit.conversionFactor) || 1;
    if (factor <= 1) continue; // base unit is handled explicitly below

    const count = Math.floor(toDecimal(remaining.dividedBy(factor).toFixed(10)).toNumber());
    if (count > 0) {
      parts.push({ unitName: unit.unitName, count });
      remaining = toDecimal(subtractMoney(remaining, multiplyMoney(count, factor)));
    }
  }

  // Whatever's left over is expressed in the base unit — even if that's
  // the whole quantity (product has no packaging unit above factor 1).
  const baseUnit = sortedUnits.find((u) => (Number(u.conversionFactor) || 1) === 1);
  const rawRemainingCount = remaining.toNumber();

  // [FIX — precision display] `rawRemainingCount` can carry a tiny
  // rounding artifact (e.g. 22.0008 instead of a clean 22) that
  // originates upstream in getOfflineProducts — converting a batch
  // quantity stored in a NON-base unit (e.g. 3.9167 طرد) into the base
  // unit (× conversionFactor) necessarily reproduces whatever rounding
  // ProductBatch.quantity's own Decimal(18,4) precision already forced
  // at write time (2 ÷ 24 has no exact 4-decimal representation — see
  // fifo.ts's own FIX note on this same limit). That artifact is always
  // FAR smaller than any real-world countable unit (a merchant never
  // legitimately sells 0.0008 of a single قطعة).
  //
  // A genuinely fractional base-unit quantity DOES exist for the
  // opposite reason — a weighed/measured product (e.g. 2.75 كغ) — and
  // must never be silently rounded away; the whole point of storing
  // quantity as Decimal(18,4) is to keep that fraction exact.
  //
  // The two cases are distinguishable by SIZE alone: a rounding artifact
  // from a unit-conversion is always well under 0.01 of a single base
  // unit; a real, deliberately fractional quantity is not. Snapping only
  // when within this tight epsilon of the nearest whole number corrects
  // the display artifact without ever touching a real fraction.
  const nearestWhole = Math.round(rawRemainingCount);
  const isRoundingArtifact = Math.abs(rawRemainingCount - nearestWhole) < 0.001;
  const remainingCount = isRoundingArtifact ? nearestWhole : rawRemainingCount;

  if (remainingCount > 0 || parts.length === 0) {
    parts.push({
      unitName: baseUnit ? baseUnit.unitName : "قطعة",
      count: remainingCount,
    });
  }

  return parts;
}

/** Renders a StockBreakdownPart[] as e.g. "5 كرتونة و5 قطعة". */
export function formatStockBreakdown(parts: StockBreakdownPart[]): string {
  if (parts.length === 0) return "0";
  return parts.map((p) => `${p.count} ${p.unitName}`).join(" و");
}

export function isSystemCashCustomer(customer?: SelectedCustomer | null): boolean {
  if (!customer) return false;
  return customer.type === "SYSTEM" || !!customer.isSystemGenerated;
}

/**
 * [FIX — review pass 4, T4b] A sale may carry debt (debtAmountSYP > 0)
 * ONLY against a customer with a documented, verifiable prior
 * relationship with the merchant — a real Invoice already exists for
 * them on the server. Deliberately requires `hasPriorInvoices === true`
 * explicitly (never `!!customer.hasPriorInvoices` alone would be enough
 * to document the intent, but the strict `=== true` check is what
 * actually matters): any other value — `undefined`, `false`, or a stale
 * client that never carried this field — is treated as NOT eligible.
 *
 * This structurally covers two distinct risky cases with one check:
 *   1. A WALK_IN customer — created moments ago by this same cashier,
 *      with no CachedCustomer row and therefore no hasPriorInvoices value
 *      at all. Extending credit to an identity this device (or the
 *      server, until the next sync) has never verified defeats the whole
 *      point of tracking who owes what.
 *   2. A synced EXISTING customer whose row exists in cachedCustomers but
 *      who has never actually had an invoice — e.g. a customer record an
 *      ADMIN created ahead of time from a different screen. Their `type`
 *      reads "EXISTING," which an earlier, narrower check
 *      (type !== "WALK_IN") would have wrongly treated as sufficient on
 *      its own.
 *
 * The system-generated cash customer is handled separately by
 * isSystemCashCustomer() and is never even offered a debt path in the UI
 * — this function is only ever consulted once that case has already been
 * ruled out by the caller.
 */
export function isEligibleForCredit(customer: SelectedCustomer | null | undefined): boolean {
  if (!customer) return false;
  if (isSystemCashCustomer(customer)) return false;
  return customer.hasPriorInvoices === true;
}

export function normalizeCustomerPhone(phone: string): string {
  return phone.trim().replace(/\s+/g, "");
}

// [FIX — ADDED] The filter a picker UI (POS "add to cart" unit selector,
// the storefront's unit dropdown) should build its list from — a
// deactivated unit disappears from here immediately, matching T3's
// acceptance criteria. This is the intended, proactive filtering point;
// resolveUnitPriceSYP below is the hard backstop for a caller that skips
// this (e.g. an older UI screen not yet updated, or a stale in-memory
// reference held from before a re-sync marked a unit inactive).
export function getSellableUnits(product: CachedProduct): CachedProductUnit[] {
  return (product.units || []).filter((u) => u.isActive !== false);
}

function cachedCustomerToSelected(c: CachedCustomer): SelectedCustomer {
  return {
    type: c.isSystemGenerated ? "SYSTEM" : "EXISTING",
    id: c.id,
    name: c.name,
    phone: c.phone,
    shopName: c.shopName,
    balanceDebtSYP: toDecimal(c.cachedBalanceDebtSYP).toNumber(),
    balanceDebtUSD:
      c.cachedBalanceDebtUSD !== undefined ? toDecimal(c.cachedBalanceDebtUSD).toNumber() : undefined,
    isSystemGenerated: c.isSystemGenerated,
    // [FIX — review pass 4, T4b] Carried through from the cached record so
    // isEligibleForCredit() can inspect it without a second lookup.
    hasPriorInvoices: c.hasPriorInvoices === true,
  };
}

// [FIX — review pass 2] Private, read-only sentinel local to this file —
// see the TENANT SCOPING POLICY note at the top of this file for why this
// is safe here (nothing in this file ever writes under it) despite the
// equivalent shared key in exchange-rate.ts having been removed for the
// opposite reason (it WAS written to there). Used only by READ paths.
const READ_ONLY_UNSCOPED_KEY = "unscoped_read_only";

// Used by READ paths only — see the tenant-scoping policy note above.
// [FIX — review pass 3] Now warns in development when falling back, so a
// missing-tenantId bug upstream (a session/tenant context not yet loaded)
// surfaces as a visible signal instead of silently rendering empty lists.
function resolveTenantId(tenantId?: string): string {
  if (!tenantId || !tenantId.trim()) {
    if (process.env.NODE_ENV !== "production") {
      console.warn(
        "[pos-service] Read called without a tenantId — resolving to an " +
        "empty, unscoped result. This usually indicates a missing " +
        "session/tenant context upstream."
      );
    }
    return READ_ONLY_UNSCOPED_KEY;
  }
  return tenantId.trim();
}

export function calculateCartTotals(
  items: CartLineItem[],
  exchangeRate: MoneyInput | null
): CartTotalsResult {
  let itemCount = 0;
  const lineItems: CartTotalsResult["lineItems"] = [];
  const lineTotalsSYP: string[] = [];

  const hasValidRate = exchangeRate !== null && compareMoney(exchangeRate, 0) > 0;

  for (const item of items) {
    // [NOTE] itemCount sums raw quantities across line items regardless
    // of each line's own unit — it's a display-only counter ("3 items in
    // cart"), never a monetary or stock figure, so mixing units here
    // (e.g. 3 كرتونة + 2 قطعة = 5) is a cosmetic ambiguity at most, not a
    // correctness bug. Every monetary computation below stays strictly
    // per-line via unitPriceSYP × quantity, which is unaffected.
    itemCount += item.quantity;
    const lineTotalSYP = multiplyMoney(item.unitPriceSYP, item.quantity);
    lineTotalsSYP.push(lineTotalSYP);

    let lineTotalUSD: string | null = null;
    if (hasValidRate) {
      lineTotalUSD = convertCurrency(lineTotalSYP, exchangeRate, "SYP", "USD");
    }

    lineItems.push({
      id: item.id,
      lineTotalSYP,
      lineTotalUSD,
    });
  }

  const totalSYP = sumMoney(lineTotalsSYP);
  const totalUSD = hasValidRate ? convertCurrency(totalSYP, exchangeRate, "SYP", "USD") : null;

  return {
    totalSYP,
    totalUSD,
    itemCount,
    lineItems,
  };
}

/**
 * Resolves the billed wholesale price for a product unit in SYP.
 * Always selects priceWholesale (never priceRetail).
 *
 * [v3.6] AUTHORITATIVE resolver. A rate is only required when the unit is
 * priced in USD (to convert it into SYP) — a unit already priced in SYP
 * resolves with no rate needed at all, the reverse of the pre-v3.6
 * direction.
 *
 * `product` is accepted for signature compatibility with callers (and
 * with resolveUnitPriceUSD/resolveCartLinePrices below) but is no longer
 * read — see the [FIX] note above the removed fallback.
 */
export function resolveUnitPriceSYP(
  unit: CachedProductUnit,
  product?: CachedProduct,
  exchangeRate?: MoneyInput | null
): string {
  // [FIX — ADDED] Hard stop for a deactivated unit. T3's acceptance
  // criteria: "Deactivating a ProductUnit (isActive = false) removes it
  // from POS and storefront pickers immediately." getSellableUnits()
  // above is where a picker UI should filter this proactively — this
  // check is the backstop that makes it impossible to actually price
  // (and therefore sell) a deactivated unit even if a caller skips that
  // filter or holds a stale reference from before a re-sync.
  if (unit.isActive === false) {
    throw new Error(
      "لا يمكن بيع هذه الوحدة — تم إيقافها من قبل التاجر. يرجى اختيار وحدة أخرى."
    );
  }

  if (unit.pricingCurrency !== "SYP" && unit.pricingCurrency !== "USD") {
    throw new Error(
      "لا يمكن تحديد عملة التسعير لهذه الوحدة (SYP أو USD) — يرجى مزامنة بيانات المنتج أو مراجعته."
    );
  }

  if (unit.pricingCurrency === "USD") {
    if (!exchangeRate || compareMoney(exchangeRate, 0) <= 0) {
      throw new Error(
        "لا يمكن احتساب سعر هذا المنتج بالليرة السورية لأنه مسعّر بالدولار ولا يوجد سعر صرف يومي محفوظ حالياً."
      );
    }
    return convertCurrency(unit.priceWholesale, exchangeRate, "USD", "SYP");
  }

  // [FIX — REMOVED silent cross-unit fallback] This used to read
  // `unit.priceWholesale ?? product?.priceWholesale`. product.priceWholesale
  // is a single product-level figure that isn't part of any specific
  // packaging unit — a single product can have very different prices per
  // unit (e.g. 1.2$ per كيس vs 55$ per شوال كبير in the seeded demo
  // data). Silently falling back to it whenever THIS unit's own
  // priceWholesale happened to be missing from the cache could bill a
  // large packaging unit at its small unit's price (or vice versa) with
  // no error at all — exactly the kind of silent mispricing the missing-
  // exchange-rate branch above is deliberately NOT allowed to do. This
  // now fails loud instead, the same policy applied consistently.
  if (unit.priceWholesale === undefined || unit.priceWholesale === null) {
    throw new Error(
      "لا يوجد سعر جملة محدد لهذه الوحدة تحديداً — لا يمكن إضافتها إلى السلة. الرجاء مزامنة بيانات المنتج أو مراجعتها."
    );
  }
  return serializeMoney(unit.priceWholesale);
}

/**
 * Resolves the same unit's price in USD, for DISPLAY ONLY.
 *
 * [v3.6] Never throws for a missing rate — unlike resolveUnitPriceSYP,
 * USD no longer gates anything, so a missing rate simply means "no USD
 * figure to show yet" (null), not a blocked action.
 *
 * Still throws for a deactivated unit — it delegates to
 * resolveUnitPriceSYP, which is where that hard stop lives.
 */
export function resolveUnitPriceUSD(
  unit: CachedProductUnit,
  product?: CachedProduct,
  exchangeRate?: MoneyInput | null
): string | null {
  if (!exchangeRate || compareMoney(exchangeRate, 0) <= 0) {
    return null;
  }
  const priceSYP = resolveUnitPriceSYP(unit, product, exchangeRate);
  return convertCurrency(priceSYP, exchangeRate, "SYP", "USD");
}

/**
 * Resolves billed wholesale (always) and optional retail (display-only) in
 * both SYP (authoritative) and USD (derived). Uses the same currency
 * conversion path as the catalog so USD-priced units are never written
 * into the cart as if they were already SYP.
 *
 * Throws (via resolveUnitPriceSYP) if `unit` is deactivated.
 */
export function resolveCartLinePrices(
  unit: CachedProductUnit,
  product: CachedProduct,
  exchangeRate?: MoneyInput | null
): {
  unitPriceSYP: string;
  unitPriceUSD: string | null;
  // [T4b] Merchant's denomination for THIS unit — included so callers can
  // call cartNeedsExchangeRate() without re-inspecting CachedProductUnit.
  pricingCurrency: "USD" | "SYP";
  priceRetailSYP?: string;
  priceRetailUSD?: string | null;
} {
  const unitPriceSYP = resolveUnitPriceSYP(unit, product, exchangeRate);
  const unitPriceUSD = resolveUnitPriceUSD(unit, product, exchangeRate);
  const pricingCurrency: "USD" | "SYP" =
    unit.pricingCurrency === "USD" ? "USD" : "SYP";

  if (unit.priceRetail === undefined || unit.priceRetail === null || unit.priceRetail === "") {
    return { unitPriceSYP, unitPriceUSD, pricingCurrency };
  }

  const retailUnit = { ...unit, priceWholesale: unit.priceRetail };
  const priceRetailSYP = resolveUnitPriceSYP(retailUnit, product, exchangeRate);
  const priceRetailUSD = resolveUnitPriceUSD(retailUnit, product, exchangeRate);
  return { unitPriceSYP, unitPriceUSD, pricingCurrency, priceRetailSYP, priceRetailUSD };
}

/**
 * Returns true when at least one cart line item was priced in USD,
 * meaning a valid cached exchange rate is REQUIRED for checkout.
 *
 * A cart composed entirely of SYP-priced units resolves fully without a
 * rate (resolveUnitPriceSYP returns the price directly); checkout for
 * such a cart must never be blocked solely because no rate is cached.
 *
 * T4b acceptance criteria: "checkout blocks only for a USD-priced item
 * with no cached rate, never for SYP-only carts."
 */
export function cartNeedsExchangeRate(items: CartLineItem[]): boolean {
  return items.some((item) => item.pricingCurrency === "USD");
}

export async function getOfflineProducts(
  tenantId?: string,
  query?: string
): Promise<PosProductItem[]> {
  const scopedTenantId = resolveTenantId(tenantId);
  if (!isOfflineDbSupported()) return [];

  const db = getOfflineDb();
  const products = await db.cachedProducts.where("tenantId").equals(scopedTenantId).toArray();

  const enriched: PosProductItem[] = products.map((p) => {
    // [FIX — critical] Each batch's `quantity` is recorded in ITS OWN
    // unit (via batch.unitId), not necessarily the product's base unit.
    // Summing raw quantities across batches recorded in different units
    // (e.g. one batch of "5 كرتونة", another of "5 قطعة") previously
    // produced 5 + 5 = 10 instead of the correct 5×12 + 5 = 65. Every
    // batch must be converted to the base unit via its own unit's
    // conversionFactor BEFORE summing.
    //
    // [NOTE] This lookup deliberately uses the FULL, unfiltered p.units
    // list (including deactivated ones) — a batch recorded under a unit
    // that's since been deactivated still physically exists and must
    // still count toward total stock; only NEW sales against that unit
    // are blocked (see getSellableUnits/resolveUnitPriceSYP above). Total
    // stock accuracy and "can this unit still be sold" are independent
    // questions.
    //

    const unitById = new Map(p.units.map((u) => [u.id, u]));
    const perBatchBaseQuantities = (p.batches || []).map((b) => {
      const unit = unitById.get(b.unitId);
      const factor = unit ? unit.conversionFactor || 1 : 1;
      return multiplyMoney(b.quantity || "0", factor);
    });
    const totalStock = toDecimal(sumMoney(perBatchBaseQuantities)).toNumber();

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

export async function getOfflineCustomers(
  tenantId?: string,
  query?: string
): Promise<SelectedCustomer[]> {
  const scopedTenantId = resolveTenantId(tenantId);
  if (!isOfflineDbSupported()) return [];

  const db = getOfflineDb();
  const [cachedList, offlineList] = await Promise.all([
    db.cachedCustomers.where("tenantId").equals(scopedTenantId).toArray(),
    // [FIX — ADDED, review pass] Filter out offlineCustomers rows already
    // marked SYNCED before merging. Once T4c's sync engine syncs a
    // walk-in customer, that same person also exists as a real Customer
    // in cachedCustomers (once the catalog/customer cache next refreshes)
    // — without this filter, the still-present SYNCED row in
    // offlineCustomers would surface the same person a second time in
    // this list (once as WALK_IN, once as EXISTING). A row that failed to
    // sync (FAILED) or hasn't synced yet (PENDING) still has no
    // corresponding cachedCustomers row, so those are kept.
    db.offlineCustomers
      .where("tenantId")
      .equals(scopedTenantId)
      .filter((c) => c.status !== "SYNCED")
      .toArray(),
  ]);

  const all: SelectedCustomer[] = [
    ...cachedList.map(cachedCustomerToSelected),
    ...offlineList.map((c) => ({
      type: "WALK_IN" as const,
      id: c.offlineId,
      name: c.name,
      phone: c.phone,
      shopName: c.shopName,
      balanceDebtSYP: 0,
      isSystemGenerated: false,
      // [FIX — review pass 4, T4b] Explicit false — a WALK_IN customer has
      // no CachedCustomer row and therefore no documented invoice history
      // this device can verify. See isEligibleForCredit().
      hasPriorInvoices: false,
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

export async function findMatchingCustomerByPhone(
  tenantId?: string,
  phone?: string
): Promise<DuplicatePhoneMatch | null> {
  if (!phone || !phone.trim()) return null;
  const cleanPhone = normalizeCustomerPhone(phone);
  if (!cleanPhone) return null;
  const scopedTenantId = resolveTenantId(tenantId);

  if (isOfflineDbSupported()) {
    const db = getOfflineDb();

    const cachedMatch = await db.cachedCustomers
      .where("tenantId")
      .equals(scopedTenantId)
      .filter((c) => !!c.phone && normalizeCustomerPhone(c.phone) === cleanPhone)
      .first();

    if (cachedMatch) {
      return {
        customer: cachedCustomerToSelected(cachedMatch),
        source: "CACHED",
      };
    }

    const offlineMatch = await db.offlineCustomers
      .where("tenantId")
      .equals(scopedTenantId)
      .filter((c) => !!c.phone && normalizeCustomerPhone(c.phone) === cleanPhone)
      .first();

    if (offlineMatch) {
      return {
        customer: {
          type: "WALK_IN",
          id: offlineMatch.offlineId,
          name: offlineMatch.name,
          phone: offlineMatch.phone,
          shopName: offlineMatch.shopName,
          balanceDebtSYP: 0,
          isSystemGenerated: false,
          // [FIX — review pass 4, T4b] Same reasoning as getOfflineCustomers above.
          hasPriorInvoices: false,
        },
        source: "OFFLINE",
      };
    }
  }

  if (typeof window !== "undefined" && typeof navigator !== "undefined" && navigator.onLine) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(`/api/customers/lookup?phone=${encodeURIComponent(cleanPhone)}`, {
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (res.ok) {
        const data = await res.json();
        if (data.customer) {
          return {
            customer: {
              type: data.customer.isSystemGenerated ? "SYSTEM" : "EXISTING",
              id: data.customer.id,
              name: data.customer.name,
              phone: data.customer.phone,
              shopName: data.customer.shopName,
              // [FIX — review pass 3] Was hardcoded to 0, indistinguishable
              // from a genuinely zero balance. /api/customers/lookup does
              // not currently return a balance figure at all, so this is
              // honestly "unknown", not "confirmed zero" — leaving it
              // undefined lets a caller/UI show "balance unavailable"
              // instead of a misleading "0 دين" for a customer who may
              // actually owe money.
              balanceDebtSYP: undefined,
              isSystemGenerated: data.customer.isSystemGenerated,
              // [FIX — review pass 4, T4b] /api/customers/lookup does not
              // currently return hasPriorInvoices either — left undefined
              // (unknown), never assumed true. isEligibleForCredit() only
              // ever accepts an explicit `true`, so this ONLINE match is
              // correctly treated as not-yet-eligible for an offline
              // credit sale until the customer cache actually syncs it.
              hasPriorInvoices: undefined,
            },
            source: "ONLINE",
          };
        }
      }
    } catch {
      // Network error or abort — ignore silently and rely on offline check
    }
  }

  return null;
}

export async function getSystemCashCustomer(
  tenantId?: string
): Promise<SelectedCustomer | null> {
  const scopedTenantId = resolveTenantId(tenantId);
  if (!isOfflineDbSupported()) return null;

  const db = getOfflineDb();
  const match = await db.cachedCustomers
    .where("tenantId")
    .equals(scopedTenantId)
    .filter((c) => !!c.isSystemGenerated)
    .first();

  return match ? cachedCustomerToSelected(match) : null;
}

export async function createOfflineWalkInCustomer(
  tenantId: string | undefined,
  data: {
    name: string;
    phone?: string;
    shopName?: string;
  }
): Promise<SelectedCustomer> {
  if (!tenantId || !tenantId.trim()) {
    throw new Error("لا يمكن إنشاء زبون جديد دون تحديد هوية المتجر (تسجيل الدخول مطلوب).");
  }
  const scopedTenantId = tenantId.trim();

  if (!isOfflineDbSupported()) {
    throw new Error("IndexedDB is not supported in this browser environment.");
  }
  if (!data.name || !data.name.trim()) {
    throw new Error("اسم الزبون مطلوب.");
  }

  const db = getOfflineDb();
  const newCustomerRecord = createOfflineCustomerRecord({
    tenantId: scopedTenantId,
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
    balanceDebtSYP: 0,
    isSystemGenerated: false,
    // [FIX — review pass 4, T4b] Same reasoning as getOfflineCustomers above.
    hasPriorInvoices: false,
  };
}

export async function submitOfflineSale(
  tenantId: string | undefined,
  payload: OfflineSalePayload
): Promise<OfflineInvoice> {
  if (!tenantId || !tenantId.trim()) {
    throw new Error("لا يمكن إتمام عملية البيع دون تحديد هوية المتجر (تسجيل الدخول مطلوب).");
  }
  const scopedTenantId = tenantId.trim();

  if (!isOfflineDbSupported()) {
    throw new Error("IndexedDB is not supported.");
  }

  if (!payload.items || payload.items.length === 0) {
    throw new Error("لا يمكن إتمام عملية البيع لسلة فارغة.");
  }

  // [FIX — review pass 4, T4b] Conditional exchange-rate requirement — a
  // rate is only ever needed to resolve a USD-priced item's SYP price. A
  // cart composed entirely of SYP-priced units must never be blocked
  // here just because no rate is cached yet (T4b acceptance criteria).
  // requiresExchangeRate is passed through to createOfflineInvoiceRecord
  // (db.ts) below, which must enforce the same conditional rule at its
  // own layer rather than trusting this check alone — matching the
  // defense-in-depth already applied to isSystemCustomer.
  const requiresExchangeRate = cartNeedsExchangeRate(payload.items);
  if (
    requiresExchangeRate &&
    (payload.exchangeRateUsed === null || compareMoney(payload.exchangeRateUsed, 0) <= 0)
  ) {
    throw new Error(
      "لا يمكن إتمام البيع بدون تحديد سعر الصرف اليومي — مطلوب لعناصر مسعّرة بالدولار في السلة."
    );
  }

  // [FIX — ADDED, review pass] Recompute the expected total directly from
  // the cart's own line items — via the same calculateCartTotals() this
  // file already exposes to the UI — and reject any mismatch against the
  // caller-supplied payload.totalSYP. Without this, the debt/paid/total
  // cross-check below only verifies the three payload fields are
  // consistent WITH EACH OTHER; it says nothing about whether totalSYP
  // actually reflects what's in payload.items. A caller could submit a
  // totalSYP disconnected from the real cart contents (stale UI state, a
  // client bug, or a directly-constructed payload) and this function
  // would previously have accepted it as long as the three SYP fields
  // agreed among themselves.
  const computedTotals = calculateCartTotals(payload.items, payload.exchangeRateUsed);
  if (compareMoney(computedTotals.totalSYP, payload.totalSYP) !== 0) {
    throw new Error(
      "إجمالي الفاتورة المرسل لا يطابق مجموع أسعار عناصر السلة الفعلية — يرجى إعادة حساب السلة قبل المتابعة."
    );
  }

  // [v3.6] AUTHORITATIVE check now runs on debtAmountSYP.
  const hasDebt = compareMoney(payload.debtAmountSYP, 0) > 0;
  let customer = payload.customer ?? null;

  if (hasDebt) {
    if (!customer || isSystemCashCustomer(customer)) {
      throw new Error("البيع على الحساب أو الدفع الجزئي يتطلب اختيار أو تسجيل زبون حقيقي.");
    }
    // [FIX — review pass 4, T4b] Replaces the old "not WALK_IN" check,
    // which missed an EXISTING-but-never-invoiced customer — see
    // isEligibleForCredit()'s own doc comment for the full reasoning.
    if (!isEligibleForCredit(customer)) {
      throw new Error(
        "البيع بالدين يتطلب زبونًا موثّقًا بفاتورة سابقة على السيرفر — يرجى مزامنة بيانات الزبائن أو اختيار زبون آخر."
      );
    }
  }

  if (!customer || isSystemCashCustomer(customer)) {
    const system =
      customer && customer.id ? customer : await getSystemCashCustomer(scopedTenantId);
    if (!system || !system.id) {
      throw new Error(
        "لا يوجد زبون نقدي نظامي في الذاكرة المحلية. يرجى مزامنة بيانات الزبائن أو تحميل البيانات التجريبية."
      );
    }
    customer = system;
  }

  // [v3.6] AUTHORITATIVE check now runs entirely in SYP.
  const expectedDebt = subtractMoney(payload.totalSYP, payload.paidAmountSYP);
  if (compareMoney(expectedDebt, payload.debtAmountSYP) !== 0) {
    throw new Error(
      "قيمة الدين المحسوبة لا تطابق الفرق بين إجمالي الفاتورة بالليرة والمبلغ المدفوع بالليرة — يرجى مراجعة حسابات السلة قبل المتابعة."
    );
  }

  // [v3.6] REMOVED: the old cross-check that compared a caller-supplied
  // totalUSD against totalSYP ÷ rate. There is no longer a second,
  // independently-supplied USD figure for it to drift from —
  // createOfflineInvoiceRecord (db.ts) now derives totalUSD/paidAmountUSD/
  // debtAmountUSD itself, from these exact SYP figures and this exact
  // exchangeRateUsed, so a mismatch is structurally impossible rather
  // than something this function has to catch after the fact.

  // [FIX — ADDED, review pass 2] Normalize paymentMethod defensively
  // rather than trusting the caller to have already cleared it for a
  // fully-on-credit sale. createOfflineInvoiceRecord (db.ts) throws if
  // paymentMethod is set while paidAmountSYP === 0 — this makes that
  const normalizedPaymentMethod =
    compareMoney(payload.paidAmountSYP, 0) === 0 ? undefined : payload.paymentMethod;

  const invoiceItems = payload.items.map((item) => ({
    productId: item.product.id,
    unitId: item.unitId,
    quantity: item.quantity,
    unitPriceSYP: item.unitPriceSYP,
  }));

  const isWalkIn = customer.type === "WALK_IN";
  const customerId = !isWalkIn ? customer.id : undefined;
  const offlineCustomerId = isWalkIn ? customer.id : undefined;
  // [FIX — review pass 3] Resolved once here and passed through explicitly
  // to createOfflineInvoiceRecord, which now enforces T1's "system
  // customer only with zero debt" rule directly — see db.ts's file-header
  // note. This call site is where that information is actually known (the
  // `customer` resolved above), so it's the right place to supply it
  // rather than leaving the factory to trust the debt check alone.
  const isSystemCustomer = isSystemCashCustomer(customer);

  const invoiceRecord = createOfflineInvoiceRecord({
    tenantId: scopedTenantId,
    offlineId: generateOfflineId(),
    customerId,
    offlineCustomerId,
    isSystemCustomer,
    // [FIX — review pass 4, T4b] Passed through so db.ts's factory applies
    // the same conditional exchange-rate rule at its own layer — see this
    // file's header note and db.ts's matching parameter (REQUIRES the
    // corresponding db.ts update; this call will not type-check until
    // createOfflineInvoiceRecord accepts requiresExchangeRate).
    requiresExchangeRate,
    items: invoiceItems,
    totalSYP: payload.totalSYP,
    exchangeRateUsed: payload.exchangeRateUsed ?? undefined,
    paidAmountSYP: payload.paidAmountSYP,
    debtAmountSYP: payload.debtAmountSYP,
    paymentMethod: normalizedPaymentMethod,
    createdAt: new Date(),
    status: "PENDING",
  });

  const db = getOfflineDb();
  await saveOfflineInvoiceWithBalance(invoiceRecord, db);

  return invoiceRecord;
}

export async function getOfflineInvoicesList(tenantId?: string): Promise<OfflineInvoice[]> {
  const scopedTenantId = resolveTenantId(tenantId);
  if (!isOfflineDbSupported()) return [];

  const db = getOfflineDb();
  const items = await db.offlineInvoices.where("tenantId").equals(scopedTenantId).toArray();
  return items.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

/**
 * `tenantId` is REQUIRED, not optional with a sentinel fallback. This
 * function performs real writes (bulkPut into cachedProducts /
 * cachedCustomers) — unlike the pure-read functions above, running it
 * without a real tenantId would durably seed demo data under a shared
 * bucket, where it would then silently satisfy any FUTURE read that also
 * forgot to pass a real tenantId (masking that bug instead of surfacing
 * it) and would never be cleaned up by any per-tenant flow.
 */
export async function seedSampleOfflineData(tenantId: string): Promise<void> {
  if (!tenantId || !tenantId.trim()) {
    throw new Error("لا يمكن تحميل بيانات تجريبية دون تحديد هوية المتجر (تسجيل الدخول مطلوب).");
  }
  const scopedTenantId = tenantId.trim();

  if (!isOfflineDbSupported()) return;

  const db = getOfflineDb();
  const productCount = await db.cachedProducts.where("tenantId").equals(scopedTenantId).count();

  if (productCount === 0) {
    const sampleProducts: CachedProduct[] = [
      createCachedProductRecord({
        tenantId: scopedTenantId,
        id: "prod-1",
        name: "سكر أبيض ناعم (الأسرة)",
        units: [
          { id: "unit-1-1", unitName: "كيس (1 كغ)", conversionFactor: 1, pricingCurrency: "USD", priceWholesale: 1.2, priceRetail: 1.5, barcode: "6291001001" },
          { id: "unit-1-2", unitName: "شوال (10 كغ)", conversionFactor: 10, pricingCurrency: "USD", priceWholesale: 11.5, priceRetail: 14.0, barcode: "6291001002" },
          { id: "unit-1-3", unitName: "شوال كبير (50 كغ)", conversionFactor: 50, pricingCurrency: "USD", priceWholesale: 55.0, barcode: "6291001003" },
        ],
        batches: [
          { id: "batch-1-1", unitId: "unit-1-1", batchNumber: "B2026-01", quantity: 150, expiryDate: "2027-01-01" },
          { id: "batch-1-2", unitId: "unit-1-2", batchNumber: "B2026-02", quantity: 40, expiryDate: "2027-06-01" },
        ],
      }),
      createCachedProductRecord({
        tenantId: scopedTenantId,
        id: "prod-2",
        name: "زيت دوار الشمس (عافية 1.5 لتر)",
        units: [
          { id: "unit-2-1", unitName: "عبوة (1.5 لتر)", conversionFactor: 1, pricingCurrency: "USD", priceWholesale: 3.5, priceRetail: 4.2, barcode: "6292002001" },
          { id: "unit-2-2", unitName: "كرتونة (6 عبوات)", conversionFactor: 6, pricingCurrency: "USD", priceWholesale: 20.0, priceRetail: 24.0, barcode: "6292002002" },
        ],
        batches: [
          { id: "batch-2-1", unitId: "unit-2-1", batchNumber: "AF-998", quantity: 85, expiryDate: "2026-12-31" },
        ],
      }),
      createCachedProductRecord({
        tenantId: scopedTenantId,
        id: "prod-3",
        name: "شاي أسود فرط (الكبوس 450 غرام)",
        units: [
          { id: "unit-3-1", unitName: "باكيت (450 غ)", conversionFactor: 1, pricingCurrency: "USD", priceWholesale: 4.8, priceRetail: 5.5, barcode: "6293003001" },
          { id: "unit-3-2", unitName: "كرتونة (24 باكيت)", conversionFactor: 24, pricingCurrency: "USD", priceWholesale: 110.0, barcode: "6293003002" },
        ],
        batches: [
          { id: "batch-3-1", unitId: "unit-3-1", batchNumber: "KBS-44", quantity: 60, expiryDate: "2028-02-15" },
        ],
      }),
      createCachedProductRecord({
        tenantId: scopedTenantId,
        id: "prod-4",
        name: "أرز بسمتي هندي (أبو كاس 5 كغ)",
        units: [
          { id: "unit-4-1", unitName: "كيس (5 كغ)", conversionFactor: 1, pricingCurrency: "USD", priceWholesale: 8.5, priceRetail: 10.0, barcode: "6294004001" },
          { id: "unit-4-2", unitName: "كرتونة (4 أكياس)", conversionFactor: 4, pricingCurrency: "USD", priceWholesale: 33.0, barcode: "6294004002" },
        ],
        batches: [
          { id: "batch-4-1", unitId: "unit-4-1", batchNumber: "RICE-2026", quantity: 120, expiryDate: "2027-09-30" },
        ],
      }),
      createCachedProductRecord({
        tenantId: scopedTenantId,
        id: "prod-5",
        name: "حليب مجفف كامل الدسم (نيدو 900 غرام)",
        units: [
          { id: "unit-5-1", unitName: "علبة (900 غ)", conversionFactor: 1, pricingCurrency: "USD", priceWholesale: 7.2, priceRetail: 8.5, barcode: "6295005001" },
          { id: "unit-5-2", unitName: "كرتونة (12 علبة)", conversionFactor: 12, pricingCurrency: "USD", priceWholesale: 84.0, barcode: "6295005002" },
        ],
        batches: [
          { id: "batch-5-1", unitId: "unit-5-1", batchNumber: "NID-110", quantity: 45, expiryDate: "2026-11-20" },
        ],
      }),
      createCachedProductRecord({
        tenantId: scopedTenantId,
        id: "prod-6",
        name: "معكرونة إيطالية (سباغيتي 500 غ)",
        units: [
          { id: "unit-6-1", unitName: "كيس (500 غ)", conversionFactor: 1, pricingCurrency: "USD", priceWholesale: 0.85, priceRetail: 1.1, barcode: "6296006001" },
          { id: "unit-6-2", unitName: "طرد (20 كيس)", conversionFactor: 20, pricingCurrency: "USD", priceWholesale: 16.0, barcode: "6296006002" },
        ],
        batches: [
          { id: "batch-6-1", unitId: "unit-6-1", batchNumber: "PST-88", quantity: 300, expiryDate: "2027-05-10" },
        ],
      }),
      createCachedProductRecord({
        tenantId: scopedTenantId,
        id: "prod-7",
        name: "طحين سميد فاخر (كيس 1 كغ)",
        units: [
          {
            id: "unit-7-1",
            unitName: "كيس (1 كغ)",
            conversionFactor: 1,
            pricingCurrency: "SYP",
            priceWholesale: 18000,
            priceRetail: 21000,
            barcode: "6297007001",
          },
          {
            id: "unit-7-2",
            unitName: "كرتونة (10 أكياس)",
            conversionFactor: 10,
            pricingCurrency: "SYP",
            priceWholesale: 172000,
            barcode: "6297007002",
          },
        ],
        batches: [
          { id: "batch-7-1", unitId: "unit-7-1", batchNumber: "FLR-2026-01", quantity: 200, expiryDate: "2027-03-01" },
        ],
      }),
    ];

    await db.cachedProducts.bulkPut(sampleProducts);
  }

  const customerCount = await db.cachedCustomers.where("tenantId").equals(scopedTenantId).count();
  if (customerCount === 0) {
    const sampleCustomers: CachedCustomer[] = [
      createCachedCustomerRecord({ tenantId: scopedTenantId, id: "sys-cust-1", name: "زبون نقدي عام", phone: "0000000000", cachedBalanceDebtSYP: 0, cachedBalanceDebtUSD: 0, isSystemGenerated: true }),
      // [FIX — review pass 4, T4b] hasPriorInvoices: true on the demo
      // customers below — the seeded balances imply real invoice history,
      // so their eligibility for an offline credit sale should reflect
      // that in the demo data, matching what /api/customers would
      // actually report for an equivalent real customer.
      createCachedCustomerRecord({ tenantId: scopedTenantId, id: "cust-1", name: "سوبرماركت الأمانة", phone: "0944111222", shopName: "فرع الميدان", cachedBalanceDebtSYP: 5250000, cachedBalanceDebtUSD: 350.0, hasPriorInvoices: true }),
      createCachedCustomerRecord({ tenantId: scopedTenantId, id: "cust-2", name: "بقالية النور والبركة", phone: "0933222333", shopName: "فرع القصاع", cachedBalanceDebtSYP: 1807500, cachedBalanceDebtUSD: 120.5, hasPriorInvoices: true }),
      createCachedCustomerRecord({ tenantId: scopedTenantId, id: "cust-3", name: "ميني ماركت الشام الحديث", phone: "0955444555", shopName: "شارع بغداد", cachedBalanceDebtSYP: 0, cachedBalanceDebtUSD: 0.0, hasPriorInvoices: true }),
      createCachedCustomerRecord({ tenantId: scopedTenantId, id: "cust-4", name: "مستودع الفجر للمواد الغذائية", phone: "0988777666", shopName: "سوق الهال", cachedBalanceDebtSYP: 13350000, cachedBalanceDebtUSD: 890.0, hasPriorInvoices: true }),
    ];
    await db.cachedCustomers.bulkPut(sampleCustomers);
  }

  const settingsCount = await db.cachedTenantSettings.where("tenantId").equals(scopedTenantId).count();
  if (settingsCount === 0) {
    // [FIX — review pass 3] Calls the canonical setCachedRate(tenantId,
    // rate) directly — scopedTenantId is already validated and non-empty
    // here, so there's no reason for new code to go through the legacy
    // (rate, tenantId) wrapper meant for old call sites.
    await setCachedRate(scopedTenantId, 15000);
  }
}

/**
 * Convenience helper for POS UI to trigger a fresh sync-down of products
 * and report the count of updated products.
 */
export async function syncProductsFromServer(
  tenantId: string
): Promise<{ success: boolean; count: number; reason?: string }> {
  if (!tenantId || !tenantId.trim()) {
    return { success: false, count: 0, reason: "NO_TENANT" };
  }
  const result = await refreshProductCache(tenantId);
  if (result.ok) {
    const db = getOfflineDb();
    const count = await db.cachedProducts.where("tenantId").equals(tenantId.trim()).count();
    return { success: true, count };
  }
  return {
    success: false,
    count: 0,
    reason: result.reason === "offline" ? "OFFLINE" : result.reason,
  };
}