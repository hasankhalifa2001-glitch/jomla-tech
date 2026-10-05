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
 * [FIX — business timezone] The date prefix used to be read from the
 * server's LOCAL clock (getFullYear/getMonth/getDate). On a UTC host
 * (Vercel, Docker) a batch received at 01:00 in Syria therefore got
 * YESTERDAY's date. The prefix is now always the calendar date in
 * BATCH_DATE_TIME_ZONE, independent of where the server runs. Syria has
 * used a permanent UTC+3 since 2022, so there is no DST edge case.
 * Still always the SERVER's clock instant — never client-supplied, never
 * re-derived later.
 */

import { isRealCalendarDate } from "./date-utils";


/** The merchant's business timezone. Change here only — nowhere else. */
export const BATCH_DATE_TIME_ZONE = "Asia/Damascus";

const DATE_PREFIX_REGEX = /^\d{4}-\d{2}-\d{2}$/;

// Matches an already-stored batchNumber back into its two parts. The ONE
// sanctioned way to recover an existing batch's original creation-date
// prefix (used by the PATCH edit path) — never used to construct a NEW
// date prefix; that only happens via buildServerDatePrefix() below.
const BATCH_NUMBER_PATTERN = /^(\d{4}-\d{2}-\d{2})-(.+)$/;

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

const dateFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: BATCH_DATE_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
});

/**
 * The calendar date of `date` in BATCH_DATE_TIME_ZONE, as YYYY-MM-DD —
 * the ONLY sanctioned source for a batchNumber's date prefix. Never taken
 * from the client device, a request body, or a "purchase date" note.
 */
export function buildServerDatePrefix(date: Date = new Date()): string {
    const parts = dateFormatter.formatToParts(date);
    const get = (type: "year" | "month" | "day") =>
        parts.find((p) => p.type === type)?.value ?? "";
    return `${get("year")}-${get("month")}-${get("day")}`;
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