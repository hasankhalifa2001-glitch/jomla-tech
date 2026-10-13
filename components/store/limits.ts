/**
 * components/store/limits.ts
 * TODO(T5a phase 1): once lib/config/storefront.ts exists, replace this file's
 * body with:
 *   export { STORE_MAX_LINES_PER_ORDER, STORE_MAX_QTY_PER_LINE } from "@/lib/config/storefront";
 * Single source of truth for the limits must be lib/config/storefront.ts.
 */
export const STORE_MAX_LINES_PER_ORDER = 50;
export const STORE_MAX_QTY_PER_LINE = "10000";