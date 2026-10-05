import { describe, it, expect } from "vitest";
import {
    buildServerDatePrefix,
    constructBatchNumber,
    parseBatchNumber,
} from "../batch-number";
import { isRealCalendarDate } from "../date-utils";

/**
 * All instants below are in SEPTEMBER/AUGUST/FEBRUARY-midday on purpose:
 * Syria is UTC+3 in summer under both the old (DST) and the current
 * (permanent UTC+3, since 2022) tz rules, so these tests do not depend on
 * how recent the runtime's ICU/tzdata is. They also do not depend on the
 * machine's own TZ, because the formatter pins Asia/Damascus explicitly.
 */
describe("buildServerDatePrefix — Asia/Damascus calendar date", () => {
    it("returns the Damascus date for a midday instant", () => {
        expect(buildServerDatePrefix(new Date("2026-09-28T12:00:00Z"))).toBe("2026-09-28");
    });

    it("is still the same day one second before Damascus midnight (20:59:59Z)", () => {
        expect(buildServerDatePrefix(new Date("2026-09-28T20:59:59Z"))).toBe("2026-09-28");
    });

    it("rolls to the NEXT day at Damascus midnight (21:00:00Z) — the bug a UTC host used to have", () => {
        expect(buildServerDatePrefix(new Date("2026-09-28T21:00:00Z"))).toBe("2026-09-29");
    });

    it("gives the Damascus date for a 01:00-local receipt (22:00Z the day before)", () => {
        expect(buildServerDatePrefix(new Date("2026-09-27T22:00:00Z"))).toBe("2026-09-28");
    });

    it("handles a month boundary", () => {
        expect(buildServerDatePrefix(new Date("2026-08-31T22:00:00Z"))).toBe("2026-09-01");
    });

    it("handles a leap day", () => {
        expect(buildServerDatePrefix(new Date("2028-02-29T10:00:00Z"))).toBe("2028-02-29");
    });

    it("always pads month and day to two digits", () => {
        expect(buildServerDatePrefix(new Date("2026-01-05T10:00:00Z"))).toBe("2026-01-05");
    });
});

describe("constructBatchNumber", () => {
    const at = new Date("2026-09-28T12:00:00Z");

    it("joins date prefix and suffix", () => {
        expect(constructBatchNumber("INV4471", at)).toBe("2026-09-28-INV4471");
    });

    it("trims the suffix", () => {
        expect(constructBatchNumber("  INV4471  ", at)).toBe("2026-09-28-INV4471");
    });

    it("keeps dashes inside the suffix", () => {
        expect(constructBatchNumber("A-B-1", at)).toBe("2026-09-28-A-B-1");
    });

    it.each([{ v: "" }, { v: "   " }, { v: "\t\n" }])("throws on blank suffix %j", ({ v }) => {
        expect(() => constructBatchNumber(v, at)).toThrow();
    });
});

describe("parseBatchNumber", () => {
    it("round-trips constructBatchNumber", () => {
        const built = constructBatchNumber("INV4471", new Date("2026-09-28T12:00:00Z"));
        expect(parseBatchNumber(built)).toEqual({ datePrefix: "2026-09-28", suffix: "INV4471" });
    });

    it("keeps everything after the date as the suffix (dashes included)", () => {
        expect(parseBatchNumber("2026-09-28-A-B")).toEqual({
            datePrefix: "2026-09-28",
            suffix: "A-B",
        });
    });

    it.each([
        { name: "no date prefix", v: "INV4471" },
        { name: "date without suffix", v: "2026-09-28" },
        { name: "date with empty suffix", v: "2026-09-28-" },
        { name: "impossible month/day", v: "2026-13-45-x" },
        { name: "Feb 31", v: "2026-02-31-x" },
        { name: "Apr 31", v: "2026-04-31-x" },
        { name: "Feb 29 in a non-leap year", v: "2027-02-29-x" },
        { name: "control character in suffix", v: "2026-09-28-A\rB" },
        { name: "empty string", v: "" },
    ])("returns null for $name", ({ v }) => {
        expect(parseBatchNumber(v)).toBeNull();
    });

    it("accepts Feb 29 in a leap year", () => {
        expect(parseBatchNumber("2028-02-29-x")).toEqual({ datePrefix: "2028-02-29", suffix: "x" });
    });
});

describe("isRealCalendarDate", () => {
    it.each(["2026-09-28", "2028-02-29", "2026-12-31"])("accepts %s", (v) => {
        expect(isRealCalendarDate(v)).toBe(true);
    });

    it.each(["2026-02-31", "2027-02-29", "2026-13-01", "2026-00-10", "2026-09-00", "2026-9-28", "abc", ""])(
        "rejects %s",
        (v) => {
            expect(isRealCalendarDate(v)).toBe(false);
        }
    );
});