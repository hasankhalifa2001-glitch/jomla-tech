/**
 * lib/utils/syria-time.ts
 *
 * T4h - THE single shared definition of "a day" for every merchant-facing
 * date boundary in the system: the dashboard's "today" KPI window, its 7/30
 * day trend buckets, and app/api/invoices/route.ts's default date range.
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
 * zone conversion, it is deterministic, dependency-free and cheap). If Syria
 * ever reintroduces DST, this ONE constant is what must change; nothing else
 * in the codebase encodes an offset.
 *
 * (lib/inventory/batch-number.ts's buildServerDatePrefix() also uses the
 * Asia/Damascus calendar, for a batchNumber's date prefix. It is deliberately
 * left as-is: it formats ONE date into a stored, immutable string rather than
 * building a query range. This module is the one to use for any RANGE
 * boundary.)
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