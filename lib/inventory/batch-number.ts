/**
 * lib/inventory/batch-number.ts
 *
 * [v4.4, Spec Addendum Section 10] THE ONLY SANCTIONED MODULE for
 * constructing or parsing a ProductBatch.batchNumber value.
 *
 * Format: "{server-date}-{merchant-supplied suffix}", e.g.
 * "2026-09-27-1" or "2026-09-27-INV4471".
 *
 * WHY THIS FILE EXISTS: Section 10's acceptance criteria require that
 * every batch-creation path — T3a's single-batch entry, the multi-product
 * receipt screen (Section 11), and T3d's CSV import (Section 10.2) —
 * construct this format through ONE identical, shared implementation,
 * never three independent ones.
 *
 * [FIX — business timezone] The date prefix is the merchant's BUSINESS
 * date (the Asia/Damascus calendar day), never the server's local clock
 * and never a client-supplied value. Since [v4.7] it is computed by
 * lib/inventory/date-utils.ts's getBusinessDate() — the ONE shared
 * business-date implementation that also drives the receipt form's default
 * purchase date and the purchase-date "not in the future" / "not too old"
 * rules — so the batchNumber prefix and a receipt's purchase-date default
 * can never disagree. getBusinessDate() delegates to lib/utils/syria-time.ts's
 * localDayKey() (fixed UTC+3, deliberately not Intl-based — the same "day"
 * the dashboard and the sales log use), so this feature never introduces a
 * second definition of a day. Still always the SERVER's clock instant —
 * never client-supplied, never re-derived later.
 */

import { isRealCalendarDate, BUSINESS_TIME_ZONE, getBusinessDate } from "./date-utils";

/** The merchant's business timezone. [v4.7] Alias of date-utils's
 *  BUSINESS_TIME_ZONE — kept under this historical name for existing
 *  importers; the single source of truth lives in date-utils.ts. */
export const BATCH_DATE_TIME_ZONE = BUSINESS_TIME_ZONE;

const DATE_PREFIX_REGEX = /^\d{4}-\d{2}-\d{2}$/;

// Matches an already-stored batchNumber back into its two parts. The ONE
// sanctioned way to recover an existing batch's original creation-date
// prefix (used by the PATCH edit path) — never used to construct a NEW
// date prefix; that only happens via buildServerDatePrefix() below.
const BATCH_NUMBER_PATTERN = /^(\d{4}-\d{2}-\d{2})-(.+)$/;

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * The calendar date of `date` in BATCH_DATE_TIME_ZONE, as YYYY-MM-DD —
 * the ONLY sanctioned source for a batchNumber's date prefix. Never taken
 * from the client device, a request body, or a "purchase date" note.
 *
 * [v4.7] Delegates to getBusinessDate() so the prefix and every other
 * business-date calculation share one implementation.
 */
export function buildServerDatePrefix(date: Date = new Date()): string {
    return getBusinessDate(date);
}

/**
 * Builds a full batchNumber from a merchant-supplied suffix. The ONE
 * function every creation path must call.
 *
 * @throws {Error} if suffix is empty/blank — a hard backstop; callers
 *   should still validate at the schema layer for a friendly message.
 */
export function constructBatchNumber(merchantSuffix: string, date: Date = new Date()): string {
    const trimmed = merchantSuffix.trim();
    if (trimmed.length === 0) {
        throw new Error(
            "constructBatchNumber: merchantSuffix must not be empty — every " +
            "batchNumber requires a non-empty merchant-supplied part."
        );
    }
    return `${buildServerDatePrefix(date)}-${trimmed}`;
}

export interface ParsedBatchNumber {
    datePrefix: string;
    suffix: string;
}

/**
 * Splits an already-stored batchNumber into its date prefix and merchant
 * suffix. Returns null when the value is not a valid batchNumber: wrong
 * shape, an impossible date (2026-13-45, 2026-02-31), or control
 * characters in the suffix. Callers must surface a clear error on null —
 * never silently fall back to today's date.
 */
export function parseBatchNumber(batchNumber: string): ParsedBatchNumber | null {
    const match = batchNumber.match(BATCH_NUMBER_PATTERN);
    if (!match) return null;
    const [, datePrefix, suffix] = match;
    if (!isRealCalendarDate(datePrefix)) return null;
    if (CONTROL_CHARS.test(suffix)) return null;
    return { datePrefix, suffix };
}

/** Re-exported so callers that only need format validation (e.g. a CSV
 * template hint) don't have to duplicate the regex themselves. */
export { DATE_PREFIX_REGEX };