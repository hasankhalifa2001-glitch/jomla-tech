/**
 * lib/config/storefront.ts
 *
 * T5a - the ONE adjustable settings file for the public B2B storefront and
 * the rate-limited order-submission endpoint. Owner-tunable limits live here
 * and nowhere else, so a change is a single edit rather than a scavenger hunt.
 * Consumed by T5a now and by T5b/T5c later (the per-phone cap, the pending
 * window and the error-code set are shared). No schema change.
 */

export const STORE_IP_RATE_LIMIT = { requests: 10, windowMinutes: 10 } as const;
export const STORE_MAX_PENDING_PER_UNVERIFIED_PHONE = 3;
export const STORE_MAX_LINES_PER_ORDER = 50;
export const STORE_MAX_QTY_PER_LINE = "10000"; // Decimal string, in the sale unit
export const STORE_PAGE_SIZE = 24;
export const STORE_HOME_NEWEST_COUNT = 8;
export const STORE_HOME_BESTSELLERS_COUNT = 8;
export const STORE_BESTSELLERS_WINDOW_DAYS = 30;
export const STORE_BESTSELLERS_MIN_PRODUCTS = 3;
export const STORE_DUPLICATE_SUBMIT_WINDOW_SECONDS = 120;
export const STORE_CATALOG_CACHE_SECONDS = 60;
export const STORE_BESTSELLERS_CACHE_SECONDS = 900;
// Lenient, per IP, public READS only.
export const STORE_READ_RATE_LIMIT = { requests: 60, windowMinutes: 1 } as const;
// Internal filter key for products with no category. normalizeCategory() must
// never produce this value from a real category name (see its unit tests).
export const STORE_UNCATEGORIZED_KEY = "__none__";

export const STORE_ERROR = {
  STORE_UNAVAILABLE: "STORE_UNAVAILABLE",
  RATE_LIMITED: "RATE_LIMITED",
  PENDING_LIMIT: "PENDING_LIMIT",
  VALIDATION_ERROR: "VALIDATION_ERROR",
  INVALID_LINE: "INVALID_LINE",
  ALREADY_REVIEWED: "ALREADY_REVIEWED",
  INSUFFICIENT_STOCK: "INSUFFICIENT_STOCK",
  RATE_REQUIRED: "RATE_REQUIRED",
  PRODUCT_INACTIVE: "PRODUCT_INACTIVE",
  INVALID_CUSTOMER: "INVALID_CUSTOMER",
  INVALID_PAYMENT: "INVALID_PAYMENT",
  FORBIDDEN: "FORBIDDEN",
  TENANT_NOT_WRITABLE: "TENANT_NOT_WRITABLE",
} as const;

export type StoreErrorCode = (typeof STORE_ERROR)[keyof typeof STORE_ERROR];