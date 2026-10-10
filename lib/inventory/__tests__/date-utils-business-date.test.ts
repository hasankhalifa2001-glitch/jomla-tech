import { describe, it, expect, vi, afterEach } from "vitest";
import {
    isRealCalendarDate,
    getBusinessDate,
    isFutureBusinessDate,
    isTooOldBusinessDate,
    MAX_BACKDATE_DAYS,
    businessDateToDbDate,
    formatDbDate,
} from "../date-utils";
import {
    buildServerDatePrefix,
    constructBatchNumber,
    BATCH_DATE_TIME_ZONE,
} from "../batch-number";

/**
 * [v4.7, Phase 1] Business-date (Damascus) boundaries.
 *
 * The server may run in UTC; the merchant's "today" is the Damascus
 * calendar day. Syria is a fixed UTC+3 since 2022 (lib/utils/syria-time.ts,
 * whose localDayKey() getBusinessDate() delegates to), so:
 *   - 21:00Z..23:59Z on day D is already D+1,
 *   - 00:00Z..20:59Z on day D is still day D.
 * There is deliberately NO second day derivation here — see the source scan
 * at the bottom.
 */

describe("getBusinessDate - Damascus day boundary", () => {
    it("UTC 21:30 on day D is already D+1 in Damascus", () => {
        expect(getBusinessDate(new Date("2026-06-15T21:30:00Z"))).toBe("2026-06-16");
    });

    it("UTC 20:59 on day D is still day D in Damascus", () => {
        expect(getBusinessDate(new Date("2026-06-15T20:59:00Z"))).toBe("2026-06-15");
    });

    it("UTC 21:00 exactly (Damascus midnight) is already the next day", () => {
        expect(getBusinessDate(new Date("2026-06-15T21:00:00Z"))).toBe("2026-06-16");
    });

    it("UTC 20:59:59.999 stays on day D", () => {
        expect(getBusinessDate(new Date("2026-06-15T20:59:59.999Z"))).toBe("2026-06-15");
    });

    it("early UTC morning stays on the same calendar day", () => {
        expect(getBusinessDate(new Date("2026-06-15T00:00:00Z"))).toBe("2026-06-15");
    });
});

describe("businessDateToDbDate - strict format validation and UTC midnight", () => {
    it("returns UTC midnight, what Prisma expects for @db.Date", () => {
        expect(businessDateToDbDate("2026-06-15").toISOString()).toBe(
            "2026-06-15T00:00:00.000Z"
        );
    });

    it("round-trips with formatDbDate", () => {
        for (const d of ["2026-06-15", "2028-02-29", "1999-12-31", "2026-01-01"]) {
            expect(formatDbDate(businessDateToDbDate(d))).toBe(d);
        }
    });

    it.each([
        "2026-02-30",
        "2026-02-29",
        "2026-13-01",
        "2026-00-10",
        "2026-06-00",
        "2026-6-15",
        "15-06-2026",
        "",
        "2026-06-15x",
    ])("rejects impossible or malformed date %j", (bad) => {
        expect(isRealCalendarDate(bad)).toBe(false);
        expect(() => businessDateToDbDate(bad)).toThrow();
    });
});

describe("formatDbDate - always UTC, never a local/merchant zone", () => {
    it("shows the stored calendar day of a @db.Date value", () => {
        // 2026-06-15T00:00:00Z displayed in any zone west of UTC would show
        // 2026-06-14 - formatDbDate must not.
        expect(formatDbDate(new Date("2026-06-15T00:00:00.000Z"))).toBe("2026-06-15");
    });

    it("does not shift the day for an instant late in the UTC day", () => {
        expect(formatDbDate(new Date("2026-06-15T23:59:59.999Z"))).toBe("2026-06-15");
    });
});

describe("isFutureBusinessDate - string comparison only", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("tomorrow is future; today and yesterday are not", () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-06-15T10:00:00Z"));
        expect(getBusinessDate()).toBe("2026-06-15");
        expect(isFutureBusinessDate("2026-06-16")).toBe(true);
        expect(isFutureBusinessDate("2026-06-15")).toBe(false);
        expect(isFutureBusinessDate("2026-06-14")).toBe(false);
    });

    it("crosses at Damascus midnight (21:00Z), not at UTC midnight", () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-06-15T22:00:00Z"));
        expect(getBusinessDate()).toBe("2026-06-16");
        expect(isFutureBusinessDate("2026-06-16")).toBe(false);
        expect(isFutureBusinessDate("2026-06-17")).toBe(true);
    });
});

describe("isTooOldBusinessDate - MAX_BACKDATE_DAYS (730) boundary", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("the back-date window is exactly 730 business days", () => {
        expect(MAX_BACKDATE_DAYS).toBe(730);
    });

    it("accepts the cutoff day itself (exactly 730 days ago), rejects 731+", () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-06-15T10:00:00Z"));
        expect(getBusinessDate()).toBe("2026-06-15");
        // 2026-06-15 minus 730 days = 2024-06-15 (both 2024→2025 and
        // 2025→2026 are 365-day spans from mid-June): still accepted.
        expect(isTooOldBusinessDate("2024-06-15")).toBe(false);
        // One day older: rejected.
        expect(isTooOldBusinessDate("2024-06-14")).toBe(true);
        // Long past the window: rejected. Recent dates and today: accepted.
        expect(isTooOldBusinessDate("2020-01-01")).toBe(true);
        expect(isTooOldBusinessDate("2026-06-14")).toBe(false);
        expect(isTooOldBusinessDate("2026-06-15")).toBe(false);
    });

    it("computes the cutoff in BUSINESS days (shifts with Damascus midnight)", () => {
        vi.useFakeTimers();
        // 22:00Z on 2026-06-15 is already 2026-06-16 in Damascus, so the
        // cutoff moves to 2024-06-16 — an instant that was fine a minute
        // earlier (2024-06-15) is now too old.
        vi.setSystemTime(new Date("2026-06-15T22:00:00Z"));
        expect(getBusinessDate()).toBe("2026-06-16");
        expect(isTooOldBusinessDate("2024-06-16")).toBe(false);
        expect(isTooOldBusinessDate("2024-06-15")).toBe(true);
    });
});

describe("batchNumber date prefix uses the same shared business date", () => {
    it("buildServerDatePrefix is getBusinessDate for the same instant", () => {
        const at = new Date("2026-06-15T21:30:00Z");
        expect(buildServerDatePrefix(at)).toBe(getBusinessDate(at));
        expect(buildServerDatePrefix(at)).toBe("2026-06-16");
    });

    it("constructBatchNumber prefixes the Damascus day", () => {
        expect(constructBatchNumber("INV1", new Date("2026-06-15T21:30:00Z"))).toBe(
            "2026-06-16-INV1"
        );
        expect(constructBatchNumber("INV1", new Date("2026-06-15T20:59:00Z"))).toBe(
            "2026-06-15-INV1"
        );
    });

    it("re-exports the business timezone under the historical batch-number name", () => {
        expect(BATCH_DATE_TIME_ZONE).toBe("Asia/Damascus");
    });
});

// ---------------------------------------------------------------------------
// The implementation itself: ONE definition of a day. getBusinessDate()
// delegates to lib/utils/syria-time.ts's localDayKey() (fixed UTC+3,
// deliberately not Intl-based); formatDbDate()'s FIXED "UTC" formatter is
// @db.Date column serialization, never a business-day zone conversion.
// ---------------------------------------------------------------------------
describe("source: date-utils delegates the day to syria-time (one definition)", () => {
    it("delegates getBusinessDate to localDayKey; no Intl day formatter remains", async () => {
        const fs = await import("node:fs");
        const path = await import("node:path");
        const src = fs.readFileSync(
            path.join(process.cwd(), "lib/inventory/date-utils.ts"),
            "utf8"
        );
        // The single shared day definition lives in syria-time.ts:
        expect(src).toContain('from "@/lib/utils/syria-time"');
                // getBusinessDate() delegates to localDayKey(). An Invalid-Date guard
        // sits between the signature and the return (an invalid `now` must
        // throw instead of becoming 'NaN-NaN-NaN'), so the match is
        // bounded-lazy rather than backslash-s-only - the delegation itself
        // is the invariant under test.
        expect(src).toMatch(
            /function getBusinessDate\(now: Date = new Date\(\)\): string \{[\s\S]{0,300}?return localDayKey\(now\);/
        );
        // The back-date boundary is computed from the same definition: the
        // cutoff itself lives in getMinPurchaseDate() - THE one place it is
        // computed (GET /api/receipts/defaults returns it as minDate) - and
        // isTooOldBusinessDate() is a pure YYYY-MM-DD string comparison
        // against it, in the same delegation chain:
        expect(src).toMatch(
            /function isTooOldBusinessDate\([^)]*\)[^{]*\{[^}]*return dateStr < getMinPurchaseDate\(now\);/
        );
        expect(src).toMatch(
            /function getMinPurchaseDate\([^)]*\)[^{]*\{[\s\S]{0,300}?return localDayKey\(addLocalDays\(now, -MAX_BACKDATE_DAYS\)\);/
        );
        // The ONLY Intl formatter left is the fixed UTC one for @db.Date:
        expect(src).toContain('timeZone: "UTC"');
        expect(src).not.toContain("timeZone: BUSINESS_TIME_ZONE");
        expect(src).not.toContain("damascusFormatter");
        // No offset arithmetic lives in this file — that belongs to syria-time:
        expect(src).not.toContain("60 * 60 * 1000");
        expect(src).not.toContain("getTime() +");
    });
});