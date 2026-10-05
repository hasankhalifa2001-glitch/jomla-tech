/**
 * lib/inventory/date-utils.ts
 *
 * Tiny, dependency-free date helpers shared by batch-number.ts and
 * batch-creation.ts. Lives in its own file so that batch-number.ts can
 * validate dates without importing batch-creation.ts (which already
 * imports batch-number.ts — that would be a circular import).
 */

/**
 * True only for a REAL calendar date in strict YYYY-MM-DD form.
 * `new Date("2026-02-31")` does not return Invalid Date in V8 — it silently
 * rolls over to 2026-03-03 — so `isNaN(new Date(x))` alone lets impossible
 * dates through.
 */
export function isRealCalendarDate(value: string): boolean {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) return false;
    const y = Number(match[1]);
    const m = Number(match[2]);
    const d = Number(match[3]);
    const parsed = new Date(Date.UTC(y, m - 1, d));
    return (
        parsed.getUTCFullYear() === y &&
        parsed.getUTCMonth() === m - 1 &&
        parsed.getUTCDate() === d
    );
}