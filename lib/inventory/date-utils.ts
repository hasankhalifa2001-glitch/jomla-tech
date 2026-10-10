/**
 * lib/inventory/date-utils.ts
 *
 * Tiny, dependency-free date helpers shared by batch-number.ts,
 * batch-creation.ts and the receiving gateway (lib/data/receipts.ts). Lives in
 * its own file so that batch-number.ts can validate dates without importing
 * batch-creation.ts (which already imports batch-number.ts — that would be a
 * circular import).
 *
 * [v4.7] THE single shared definition of the merchant's BUSINESS DATE: the
 * Damascus calendar day of a given instant. This module deliberately does NOT
 * derive that day itself — getBusinessDate() DELEGATES to
 * lib/utils/syria-time.ts's localDayKey() (the platform's ONE definition of
 * "a day": fixed UTC+3, deliberately not Intl-based, already used by the
 * dashboard). There must never be a second definition: the batchNumber date
 * prefix, the default purchase date, and the purchase-date "not in the
 * future" / "not too old" rules all read this one module, so they can never
 * disagree. Do not re-derive this arithmetic anywhere else; import it from
 * here (for a RANGE boundary, import syria-time.ts directly).
 *
 * Every rule that needs "today" takes an optional `now` instant (default: the
 * server clock). A caller that evaluates SEVERAL rules for one request (e.g.
 * the receipt schema: future AND too-old) should capture `now` ONCE and pass
 * it to all of them, so a Damascus-midnight crossing can never make two
 * rules disagree about which day it is.
 *
 * The only Intl usage left here is formatDbDate()'s FIXED "UTC" formatter: a
 * @db.Date column is stored as UTC midnight and must ALWAYS be read back in
 * UTC — that is column serialization, not a business-day zone conversion.
 */

import { addLocalDays, localDayKey } from "@/lib/utils/syria-time";

/**
 * Earliest year a calendar date may carry. `Date.UTC(y, ...)` treats years
 * 0–99 as 1900–1999, so a literal "0099-01-01" would otherwise be judged by
 * an accident of that quirk; this makes the rejection explicit and permanent.
 */
const MIN_CALENDAR_YEAR = 1000;

/**
 * True only for a REAL calendar date in strict YYYY-MM-DD form.
 * `new Date("2026-02-31")` does not return Invalid Date in V8 — it silently
 * rolls over to 2026-03-03 — so `isNaN(new Date(x))` alone lets impossible
 * dates through. Years before 1000 are rejected outright (see
 * MIN_CALENDAR_YEAR).
 */
export function isRealCalendarDate(value: string): boolean {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) return false;
    const y = Number(match[1]);
    const m = Number(match[2]);
    const d = Number(match[3]);
    if (y < MIN_CALENDAR_YEAR) return false;
    const parsed = new Date(Date.UTC(y, m - 1, d));
    return (
        parsed.getUTCFullYear() === y &&
        parsed.getUTCMonth() === m - 1 &&
        parsed.getUTCDate() === d
    );
}

/**
 * The merchant's timezone as an IANA label ("Asia/Damascus"), kept for
 * documentation and for BATCH_DATE_TIME_ZONE's historical name in
 * batch-number.ts. NOTHING may convert zones with it: the actual day
 * arithmetic lives in lib/utils/syria-time.ts (fixed UTC+3), whose
 * localDayKey() getBusinessDate() delegates to below.
 */
export const BUSINESS_TIME_ZONE = "Asia/Damascus";

// A @db.Date column is stored as UTC midnight, so it must ALWAYS be read
// back in UTC — formatting it in any local/merchant zone would shift the
// calendar day. See formatDbDate().
const utcFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
});

function formatYmd(date: Date, formatter: Intl.DateTimeFormat): string {
    const parts = formatter.formatToParts(date);
    const get = (type: "year" | "month" | "day") =>
        parts.find((p) => p.type === type)?.value ?? "";
    return `${get("year")}-${get("month")}-${get("day")}`;
}

/**
 * The merchant's calendar day of `now`, as 'YYYY-MM-DD' — THE business date.
 * [v4.7] Delegates to syria-time.ts's localDayKey() (fixed UTC+3), so this
 * can never drift from the dashboard's "today". Always the SERVER's clock
 * instant unless a caller passes one explicitly — never client-supplied.
 *
 * @throws {Error} on an Invalid Date. localDayKey() would otherwise return the
 *   string "NaN-NaN-NaN", which would then sail through every string
 *   comparison below and be stored as a batchNumber prefix.
 */
export function getBusinessDate(now: Date = new Date()): string {
    if (Number.isNaN(now.getTime())) {
        throw new Error("getBusinessDate: received an Invalid Date.");
    }
    return localDayKey(now);
}

/**
 * True when `dateStr` is strictly after the business date of `now`. PURE
 * STRING COMPARISON — 'YYYY-MM-DD' strings sort in calendar order, so no Date
 * construction, no zone conversion, no Date arithmetic of any kind.
 *
 * Callers MUST validate the format first with isRealCalendarDate() (the
 * receipt schemas do both, in that order): a malformed value is not a date
 * at all, and this function deliberately leaves rejecting it to the format
 * rule rather than guessing.
 */
export function isFutureBusinessDate(dateStr: string, now: Date = new Date()): boolean {
    return dateStr > getBusinessDate(now);
}

/**
 * How far back a goods-receiving purchase date may go: 730 days (two years),
 * counted in BUSINESS days via syria-time's addLocalDays/localDayKey — never
 * raw ms subtraction — so the boundary moves together with the platform's one
 * definition of a day.
 */
export const MAX_BACKDATE_DAYS = 730;

/**
 * The EARLIEST accepted purchase date ('YYYY-MM-DD') as of `now`: exactly
 * MAX_BACKDATE_DAYS business days before today. THE one place this boundary is
 * computed — isTooOldBusinessDate() below validates against it, and
 * GET /api/receipts/defaults returns it as `minDate` for the date pickers'
 * `min`, so a client's picker bound and the server's validation can never
 * disagree.
 */
export function getMinPurchaseDate(now: Date = new Date()): string {
    if (Number.isNaN(now.getTime())) {
        throw new Error("getMinPurchaseDate: received an Invalid Date.");
    }
    return localDayKey(addLocalDays(now, -MAX_BACKDATE_DAYS));
}

/**
 * True when `dateStr` is OLDER than MAX_BACKDATE_DAYS before the business
 * date of `now`. The cutoff day itself (exactly 730 days ago) is still
 * accepted; 731+ days ago is rejected. Like isFutureBusinessDate this is a
 * pure 'YYYY-MM-DD' string comparison against getMinPurchaseDate() — callers
 * MUST validate the format with isRealCalendarDate() first (the receipt
 * schemas do, in declaration order).
 */
export function isTooOldBusinessDate(dateStr: string, now: Date = new Date()): boolean {
    return dateStr < getMinPurchaseDate(now);
}

/**
 * Converts a 'YYYY-MM-DD' business date to the UTC-midnight instant Prisma
 * expects for a @db.Date column. STRICT: rejects impossible calendar dates
 * ("2026-02-30", "2026-13-01") and wrong shapes — V8's date parsing
 * silently rolls those over instead of failing, so the strict
 * isRealCalendarDate() check is the actual guard, not a nicety.
 *
 * @throws {Error} on any value that is not a real YYYY-MM-DD calendar date.
 */
export function businessDateToDbDate(dateStr: string): Date {
    if (!isRealCalendarDate(dateStr)) {
        throw new Error(
            `businessDateToDbDate: "${dateStr}" is not a valid YYYY-MM-DD calendar date.`
        );
    }
    const [y, m, d] = dateStr.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d));
}

/**
 * Formats a @db.Date value (stored as UTC midnight) as 'YYYY-MM-DD', always
 * with timeZone: "UTC". A browser west of UTC displaying the raw Date in its
 * own zone would show the PREVIOUS day (2026-06-15T00:00:00Z is still
 * 2026-06-14 there) — this function exists so that can never happen.
 * Round-trips exactly with businessDateToDbDate().
 */
export function formatDbDate(d: Date): string {
    return formatYmd(d, utcFormatter);
}

/**
 * Whole calendar days from TODAY'S Syria business day to a stored @db.Date
 * value (UTC midnight). 0 = expires today, negative = already expired.
 * Pure date-to-date arithmetic, so it does not flicker with the time of day
 * or the viewer's time zone (a raw `exp - now` diff did both).
 */
export function daysUntilBusinessDate(dbDate: Date, now: Date = new Date()): number {
    const [y, m, d] = getBusinessDate(now).split("-").map(Number);
    const todayUtc = Date.UTC(y, m - 1, d);
    const target = Date.UTC(
        dbDate.getUTCFullYear(),
        dbDate.getUTCMonth(),
        dbDate.getUTCDate()
    );
    return Math.round((target - todayUtc) / 86_400_000);
}
