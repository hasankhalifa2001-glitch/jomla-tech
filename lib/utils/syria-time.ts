/**
 * lib/utils/syria-time.ts
 *
 * T4h - THE single shared definition of "a day" for merchant-facing date
 * boundaries: the dashboard's "today" KPI window and its 7/30 day trend
 * buckets, and (since v4.7) the goods-receiving dates through
 * lib/inventory/date-utils.ts.
 *
 * WHO USES IT TODAY, AND WHO DOES NOT YET
 * Used by: lib/data/analytics.ts (dashboard) and lib/inventory/date-utils.ts
 * (batchNumber prefix, receipt purchase dates).
 * NOT yet used by the sales log (T4c2): app/api/invoices/route.ts still derives
 * its default "today" range in UTC (defaultTodayRangeUTC) and
 * components/sales-log/sales-log-utils.ts derives it in the BROWSER's local
 * zone, so a sale rung up at 00:30 Damascus time can still be filed under the
 * previous day there. That is a known gap, deliberately left for a separate
 * task; localDayRange() below is the drop-in replacement when it is fixed.
 * Update this paragraph when that happens.
 *
 * WHY THIS EXISTS
 * Tenant carries NO timezone column (schema.prisma), so every "today" in this
 * codebase used to be anchored to UTC. For Syria (UTC+3) that misaligns the
 * day boundary by three hours around midnight: a sale rung up at 00:30 local
 * was filed under YESTERDAY. The fix is one explicit business-day definition
 * shared by every caller, instead of each route deriving its own.
 *
 * SYRIA IS A FIXED UTC+3 OFFSET
 * Syria has observed a permanent UTC+3 since October 2022 - there is no DST
 * transition to model, so a FIXED offset is exactly correct (and, unlike Intl
 * zone conversion, it is deterministic, dependency-free and cheap). Every
 * function below assumes a local day is exactly 24 hours at a constant
 * offset (addLocalDays is plain millisecond arithmetic). If Syria ever
 * reintroduces DST, changing SYRIA_UTC_OFFSET_HOURS is NOT enough: this
 * module's arithmetic must be rewritten around real zone conversion.
 *
 * ([v4.7] lib/inventory/date-utils.ts's getBusinessDate() DELEGATES to
 * localDayKey() below: the batchNumber date prefix, the receipt form's default
 * purchase date, and the purchase-date "not in the future" / "not too old"
 * rules all read that one function - so this module remains the single
 * definition of "a day" for both instants and ranges, with no second
 * derivation anywhere. localDayKey() itself does not guard against an Invalid
 * Date (it would return "NaN-NaN-NaN"); business code should call it through
 * date-utils.ts, whose getBusinessDate()/getMinPurchaseDate() do.)
 */

/** Syria's permanent offset from UTC, in hours. Change here only. */
export const SYRIA_UTC_OFFSET_HOURS = 3;

const OFFSET_MS = SYRIA_UTC_OFFSET_HOURS * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Shifts an instant by the offset so its UTC getters read the LOCAL calendar
 *  date. Internal - callers use the functions below. */
function shiftByOffset(instant: Date): Date {
    return new Date(instant.getTime() + OFFSET_MS);
}

/** The Syria calendar date of `instant`, as "YYYY-MM-DD". */
export function localDayKey(instant: Date): string {
    const shifted = shiftByOffset(instant);
    const y = shifted.getUTCFullYear();
    const m = String(shifted.getUTCMonth() + 1).padStart(2, "0");
    const d = String(shifted.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
}

/** Pure millisecond arithmetic - a fixed offset means a local day is exactly
 *  24h, with no DST transition to reconcile. */
export function addLocalDays(instant: Date, days: number): Date {
    return new Date(instant.getTime() + days * DAY_MS);
}

/** The instant of Syria-local midnight that starts `instant`'s local day. */
export function startOfLocalDay(instant: Date): Date {
    const shifted = shiftByOffset(instant);
    const midnightShifted = Date.UTC(
        shifted.getUTCFullYear(),
        shifted.getUTCMonth(),
        shifted.getUTCDate()
    );
    return new Date(midnightShifted - OFFSET_MS);
}

/** The LAST millisecond of `instant`'s local day - the INCLUSIVE upper bound
 *  an `lte` filter expects. */
export function endOfLocalDay(instant: Date): Date {
    return new Date(startOfLocalDay(instant).getTime() + DAY_MS - 1);
}

/** `{ from, to }` covering all of `instant`'s local day, as an INCLUSIVE pair
 *  (`to` = 23:59:59.999 local) - a drop-in Prisma `{ gte, lte }` filter. */
export function localDayRange(instant: Date): { from: Date; to: Date } {
    return { from: startOfLocalDay(instant), to: endOfLocalDay(instant) };
}