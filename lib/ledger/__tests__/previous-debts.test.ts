/**
 * lib/ledger/__tests__/previous-debts.test.ts
 *
 * Pure helpers behind the previous-debts screen (node environment, no DOM).
 * Covers: amount parsing (Arabic-Indic digits, separators, garbage), the
 * "has unsaved entries" decision that drives beforeunload, the retry-reuses-
 * the-same-key behaviour, and the non-blocking duplicate-name / duplicate-phone
 * hints.
 *
 * normalizeArabic / normalizePhone are mocked with small deterministic stand-ins
 * so these tests pin the HELPERS' logic, not the real normalizers' rules (which
 * have their own suites). Delete the two vi.mock blocks to run against the real
 * ones.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/utils/arabic-search", () => ({
    normalizeArabic: (s: string) =>
        s
            .replace(/[أإآ]/g, "ا")
            .replace(/ى/g, "ي")
            .replace(/ة/g, "ه")
            .toLowerCase(),
}));

vi.mock("@/lib/utils/phone", () => ({
    normalizePhone: (raw: string) => {
        const digits = raw.replace(/\D/g, "");
        if (!digits) return null;
        return digits.replace(/^(00963|963)/, "0");
    },
}));

import { compareMoney } from "@/lib/utils/money";
import {
    filterSuggestions,
    findDuplicateByName,
    findDuplicateByPhone,
    hasUnsavedEntries,
    markForRetry,
    parseAmountInput,
    sanitizeAmountInput,
    type RowStatus,
} from "@/lib/ledger/previous-debts";

const sameMoney = (actual: string | null, expected: string) => {
    expect(actual).not.toBeNull();
    expect(compareMoney(actual as string, expected)).toBe(0);
};

describe("sanitizeAmountInput", () => {
    it("converts Arabic-Indic digits to ASCII", () => {
        expect(sanitizeAmountInput("٥٢٥٠٠٠٠")).toBe("5250000");
    });

    it("converts Persian digits to ASCII", () => {
        expect(sanitizeAmountInput("۱۲۳")).toBe("123");
    });

    it("drops thousands separators and spaces", () => {
        expect(sanitizeAmountInput("5,250,000")).toBe("5250000");
        expect(sanitizeAmountInput("5 250 000")).toBe("5250000");
        expect(sanitizeAmountInput("٥٬٢٥٠٬٠٠٠")).toBe("5250000");
    });

    it("rejects letters, signs and symbols", () => {
        expect(sanitizeAmountInput("12abc3")).toBe("123");
        expect(sanitizeAmountInput("-500")).toBe("500");
        expect(sanitizeAmountInput("$٧٠٠")).toBe("700");
        expect(sanitizeAmountInput("abc")).toBe("");
    });

    it("maps the Arabic decimal mark and keeps a single dot", () => {
        expect(sanitizeAmountInput("1٫5")).toBe("1.5");
        expect(sanitizeAmountInput("1.2.3")).toBe("1.23");
    });

    it("keeps at most 4 decimals (the Decimal(18,4) column)", () => {
        expect(sanitizeAmountInput("1.123456")).toBe("1.1234");
    });
});

describe("parseAmountInput", () => {
    it("parses a plain and an Arabic-Indic amount to the same value", () => {
        sameMoney(parseAmountInput("5250000"), "5250000");
        sameMoney(parseAmountInput("٥٢٥٠٠٠٠"), "5250000");
        sameMoney(parseAmountInput("5,250,000"), "5250000");
    });

    it("parses decimals exactly", () => {
        sameMoney(parseAmountInput("1250.5"), "1250.5");
        sameMoney(parseAmountInput(".5"), "0.5");
        sameMoney(parseAmountInput("5."), "5");
    });

    it("returns null for empty, zero, garbage and lone dot", () => {
        expect(parseAmountInput("")).toBeNull();
        expect(parseAmountInput("   ")).toBeNull();
        expect(parseAmountInput("0")).toBeNull();
        expect(parseAmountInput("0.0000")).toBeNull();
        expect(parseAmountInput("٠")).toBeNull();
        expect(parseAmountInput("abc")).toBeNull();
        expect(parseAmountInput(".")).toBeNull();
    });

    it("never returns a negative amount (the sign is stripped, direction is the caller's job)", () => {
        sameMoney(parseAmountInput("-500"), "500");
    });
});

describe("hasUnsavedEntries (drives the beforeunload warning)", () => {
    const rows = (...statuses: RowStatus[]) => statuses.map((status) => ({ status }));

    it("is false with no rows", () => {
        expect(hasUnsavedEntries([])).toBe(false);
    });

    it("is false when every row is saved", () => {
        expect(hasUnsavedEntries(rows("saved", "saved"))).toBe(false);
    });

    it.each<RowStatus>(["queued", "saving", "failed"])("is true while a row is %s", (status) => {
        expect(hasUnsavedEntries(rows("saved", status))).toBe(true);
    });
});

describe("markForRetry (a retry reuses the SAME idempotency key)", () => {
    it("re-queues the row without touching its key or payload", () => {
        const failed = {
            id: "r1",
            idempotencyKey: "11111111-1111-4111-8111-111111111111",
            amountSYP: "5250000.0000",
            status: "failed" as RowStatus,
            error: "تعذّر الاتصال بالخادم.",
        };
        const again = markForRetry(failed);
        expect(again.idempotencyKey).toBe(failed.idempotencyKey);
        expect(again.amountSYP).toBe(failed.amountSYP);
        expect(again.status).toBe("queued");
        expect(again.error).toBeUndefined();
    });

    it("does not mutate the original row", () => {
        const failed = { idempotencyKey: "k", status: "failed" as RowStatus, error: "x" };
        markForRetry(failed);
        expect(failed.status).toBe("failed");
        expect(failed.error).toBe("x");
    });
});

describe("filterSuggestions", () => {
    const customers = [
        { id: "1", name: "أحمد", shopName: "سوبرماركت الشروق" },
        { id: "2", name: "محمد", shopName: null },
        { id: "3", name: "أحمد سليم", shopName: null },
    ];

    it("matches names Arabic-normalized (أ == ا)", () => {
        expect(filterSuggestions("احمد", customers).map((c) => c.id)).toEqual(["1", "3"]);
    });

    it("also matches the shop name", () => {
        expect(filterSuggestions("الشروق", customers).map((c) => c.id)).toEqual(["1"]);
    });

    it("returns nothing for an empty / blank query", () => {
        expect(filterSuggestions("", customers)).toEqual([]);
        expect(filterSuggestions("   ", customers)).toEqual([]);
    });

    it("respects the limit", () => {
        expect(filterSuggestions("احمد", customers, 1)).toHaveLength(1);
    });
});

describe("findDuplicateByName (non-blocking hint)", () => {
    const customers = [
        { id: "1", name: "أحمد" },
        { id: "2", name: "محمد" },
    ];

    it("matches after Arabic normalization and trimming", () => {
        expect(findDuplicateByName("  احمد ", customers)?.id).toBe("1");
    });

    it("returns null for blank input or no match", () => {
        expect(findDuplicateByName("", customers)).toBeNull();
        expect(findDuplicateByName("   ", customers)).toBeNull();
        expect(findDuplicateByName("سامر", customers)).toBeNull();
    });

    it("does not treat a partial name as a duplicate", () => {
        expect(findDuplicateByName("اح", customers)).toBeNull();
    });
});

describe("findDuplicateByPhone (non-blocking hint)", () => {
    const customers = [
        { id: "1", phone: "0944123456" },
        { id: "2", phone: null },
        { id: "3", phone: "0933 111 222" },
    ];

    it("matches different formats of the same number", () => {
        expect(findDuplicateByPhone("0944 123 456", customers)?.id).toBe("1");
        expect(findDuplicateByPhone("+963 944 123 456", customers)?.id).toBe("1");
    });

    it("skips customers without a phone", () => {
        expect(findDuplicateByPhone("0933111222", customers)?.id).toBe("3");
    });

    it("returns null for blank / invalid / unknown numbers and never throws", () => {
        expect(findDuplicateByPhone("", customers)).toBeNull();
        expect(findDuplicateByPhone("abc", customers)).toBeNull();
        expect(findDuplicateByPhone("0999999999", customers)).toBeNull();
        expect(() => findDuplicateByPhone("🙂", customers)).not.toThrow();
    });
});