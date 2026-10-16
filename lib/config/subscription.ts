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
 * `roundToWholeLira(priceUSD × dailyExchangeRate)` and frozen at request
 * time — the client-supplied price/amount is always ignored.
 *
 * SHAM_CASH_WALLET is the platform's Sham Cash collection number displayed
 * to the merchant during the payment step.
 */

export const SUBSCRIPTION_TIERS: Record<
  string,
  { label: string; priceUSD: string; durationDays: number }
> = {
  // D1 — monthly plan.
  monthly: {
    label: "شهري",
    priceUSD: "15",
    durationDays: 30,
  },
  // D1 — yearly plan (two months free vs. twelve monthly payments).
  yearly: {
    label: "سنوي",
    priceUSD: "150",
    durationDays: 365,
  },
} as const;

export type SubscriptionTier = keyof typeof SUBSCRIPTION_TIERS;

/**
 * Sham Cash collection number shown on the payment panel. Merchants transfer
 * the exact SYP amount to this number and write the reference code in the
 * transfer note.
 */
export const SHAM_CASH_WALLET = "+963900000000";

/**
 * How long a PENDING_APPROVAL offer remains valid before it is
 * system-rejected (if it still has no receipt). Also the window used to
 * detect stale offers during system rejection.
 */
export const SUBSCRIPTION_OFFER_VALIDITY_HOURS = 72;

/**
 * Days after expiry during which the tenant remains in GRACE (system still
 * running, warnings shown) before full lockout.
 */
export const SUBSCRIPTION_GRACE_DAYS = 7;

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
 * Returns the tier config for a given tier key, or undefined when unknown.
 */
export function getTierConfig(tier: string) {
  return SUBSCRIPTION_TIERS[tier];
}
