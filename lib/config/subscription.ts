/**
 * lib/config/subscription.ts
 *
 * T6a — single adjustable settings file for the merchant subscription
 * checkout. Owner-tunable limits live here and nowhere else, so a change is
 * a single edit rather than a scavenger hunt.
 *
 * Tiers are keyed by `tier` (the value sent by the client and stored on
 * `Subscription.tier`). `priceUSD` is the platform's list price; the amount
 * actually charged in SYP is computed server-side as
 * `roundToWholeLira(priceUSD × platform exchange rate)` and frozen at request
 * time — the client-supplied price/amount is always ignored.
 *
 * SHAM_CASH_WALLET is the platform's Sham Cash collection number displayed
 * to the merchant during the payment step. REPLACE THE PLACEHOLDER before
 * going live.
 */

export const SUBSCRIPTION_TIERS: Record<
  string,
  { label: string; priceUSD: string; durationDays: number }
> = {
  // D1 — monthly plan.
  monthly: {
    label: "شهري",
    priceUSD: "10",
    durationDays: 30,
  },
  // D1 — yearly plan (two months free vs. twelve monthly payments).
  yearly: {
    label: "سنوي",
    priceUSD: "100",
    durationDays: 365,
  },
};

export type SubscriptionTier = keyof typeof SUBSCRIPTION_TIERS;

/**
 * Sham Cash collection number shown on the payment panel. Merchants transfer
 * the exact SYP amount to this number and write the reference code in the
 * transfer note.
 */
export const SHAM_CASH_WALLET = "+963900000000";

/**
 * D5 — how long a PENDING_APPROVAL offer remains valid before it is
 * system-rejected (if it still has no receipt). The SYP amount is frozen at
 * request time, so a short window limits how far the lira can drift between
 * the request and the transfer. Also the window used to flag stale offers
 * for the reviewer (T6b).
 */
export const SUBSCRIPTION_OFFER_VALIDITY_HOURS = 24;

/**
 * D7 — days after expiry during which the tenant remains in GRACE (system
 * still running, warnings shown) before full lockout.
 */
export const SUBSCRIPTION_GRACE_DAYS = 5;

/**
 * Days before expiry at which the renewal warning is shown.
 */
export const SUBSCRIPTION_RENEWAL_WARNING_DAYS = 7;

/**
 * Maximum receipt upload size in bytes (400 KB).
 */
export const SUBSCRIPTION_RECEIPT_MAX_BYTES = 400000;

/**
 * Allowed receipt mime types. The server verifies magic bytes independently
 * — the client mime/filename is never trusted.
 */
export const SUBSCRIPTION_RECEIPT_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

/**
 * Per-tenant rate limit for subscription-create requests.
 */
export const SUBSCRIPTION_RATE_LIMIT = {
  requests: 10,
  windowMinutes: 60,
} as const;

/**
 * Upstash key prefix namespaced per tenant for the subscription create limit.
 */
export function subscriptionRateLimitKey(tenantId: string): string {
  return `ratelimit:billing:subscribe:${tenantId}`;
}

/**
 * [T6b] Sane upper bound for the platform exchange rate
 * (Tenant.dailyExchangeRate of the platform-internal tenant).
 * Decimal string so comparisons stay in decimal.js via lib/utils/money.ts —
 * never a native float. Mirrors the merchant top-bar ceiling (1_000_000)
 * so a data-entry slip (e.g. an extra zero) is rejected loudly instead of
 * silently repricing every subscription offer.
 */
export const PLATFORM_RATE_MAX = "1000000";

/**
 * [T6b] Relative-change threshold above which a platform-rate PUT requires
 * an explicit { confirm: true }. 0.25 = 25%.
 */
export const PLATFORM_RATE_CONFIRM_THRESHOLD = 0.25;

/**
 * Returns the tier config for a given tier key, or undefined when unknown.
 * Own-property check: names like "constructor" or "__proto__" must never
 * resolve to Object.prototype members.
 */
export function getTierConfig(tier: string) {
  return Object.prototype.hasOwnProperty.call(SUBSCRIPTION_TIERS, tier)
    ? SUBSCRIPTION_TIERS[tier]
    : undefined;
}


export const SUBSCRIPTION_OFFER_EXPIRED_REASON = "انتهت صلاحية العرض دون إرفاق إيصال.";