/**
 * Pure UI helpers for by-amount entry (lib/pos/by-amount-ui.ts). These tests
 * import the REAL production functions — nothing is re-implemented here.
 */
import { describe, expect, it } from "vitest";
import {
    QUICK_WEIGHT_BUTTONS,
    describeAmountLine,
    formatAmountInputWhileTyping,
    formatQuantityText,
    lineMode,
    parseAmountInput,
} from "@/lib/pos/by-amount-ui";

describe("parseAmountInput", () => {
    it("accepts ASCII digits", () => {
        expect(parseAmountInput("5000")).toBe("5000");
        expect(parseAmountInput("0")).toBe("0");
        expect(parseAmountInput("15000.5")).toBe("15000.5");
    });

    it("accepts Arabic-Indic and Persian digits, and mixes", () => {
        expect(parseAmountInput("٥٠٠٠")).toBe("5000");
        expect(parseAmountInput("۵۰۰۰")).toBe("5000");
        expect(parseAmountInput("٥0٠٠")).toBe("5000");
    });

    it("strips thousands separators: comma, Arabic thousands separator, Arabic comma, spaces", () => {
        expect(parseAmountInput("5,000")).toBe("5000");
        expect(parseAmountInput("٥٬٠٠٠")).toBe("5000");
        expect(parseAmountInput("٥،٠٠٠")).toBe("5000");
        expect(parseAmountInput("5 000")).toBe("5000");
        expect(parseAmountInput("1,234,567")).toBe("1234567");
        expect(parseAmountInput("١٬٢٣٤٬٥٦٧")).toBe("1234567");
    });

    it("a thousands separator is never read as a decimal point (5,000 is five thousand, not 5.000)", () => {
        expect(parseAmountInput("5,000")).not.toBe("5.000");
        expect(parseAmountInput("1,234.5")).toBe("1234.5");
    });

    it("treats . and ٫ as the single decimal separator, up to 4 decimals", () => {
        expect(parseAmountInput("0.5")).toBe("0.5");
        expect(parseAmountInput("٠٫٥")).toBe("0.5");
        expect(parseAmountInput("12.3456")).toBe("12.3456");
        expect(parseAmountInput(".5")).toBe("0.5");
    });

    it("a trailing decimal separator parses as the integer (mid-typing)", () => {
        expect(parseAmountInput("5000.")).toBe("5000");
    });

    it("strips leading zeros but keeps a value", () => {
        expect(parseAmountInput("0005000")).toBe("5000");
        expect(parseAmountInput("000")).toBe("0");
        expect(parseAmountInput("007.5")).toBe("7.5");
    });

    it("rejects garbage with null", () => {
        for (const bad of [
            "",
            "   ",
            ".",
            "abc",
            "5000abc",
            "abc5000",
            "1.2.3",
            "1٫2.3",
            "-5",
            "-",
            "+5",
            "5-",
            "1.23456", // 5 decimals
            "5e3",
            "٥٠٠٠٠٠٠٠٠٠٠٠٠٠٠٠", // 15 integer digits
        ]) {
            expect(parseAmountInput(bad), JSON.stringify(bad)).toBeNull();
        }
    });

    it("accepts exactly 14 integer digits, rejects 15", () => {
        expect(parseAmountInput("99999999999999")).toBe("99999999999999");
        expect(parseAmountInput("999999999999999")).toBeNull();
    });
});

describe("formatAmountInputWhileTyping", () => {
    it("groups thousands with ASCII commas", () => {
        expect(formatAmountInputWhileTyping("5")).toBe("5");
        expect(formatAmountInputWhileTyping("500")).toBe("500");
        expect(formatAmountInputWhileTyping("5000")).toBe("5,000");
        expect(formatAmountInputWhileTyping("1234567")).toBe("1,234,567");
    });

    it("converts Arabic digits and re-groups any separator style", () => {
        expect(formatAmountInputWhileTyping("٥٠٠٠")).toBe("5,000");
        expect(formatAmountInputWhileTyping("٥٬٠٠٠")).toBe("5,000");
        expect(formatAmountInputWhileTyping("5 000")).toBe("5,000");
        expect(formatAmountInputWhileTyping("1,2,3,4,5")).toBe("12,345");
    });

    it("keeps a trailing decimal separator and the decimals typed so far", () => {
        expect(formatAmountInputWhileTyping("5000.")).toBe("5,000.");
        expect(formatAmountInputWhileTyping("5000٫")).toBe("5,000.");
        expect(formatAmountInputWhileTyping("5000.5")).toBe("5,000.5");
        expect(formatAmountInputWhileTyping(".")).toBe("0.");
        expect(formatAmountInputWhileTyping(".5")).toBe("0.5");
    });

    it("caps decimals at 4 and drops non-numeric characters", () => {
        expect(formatAmountInputWhileTyping("12345.67891")).toBe("12,345.6789");
        expect(formatAmountInputWhileTyping("abc")).toBe("");
        expect(formatAmountInputWhileTyping("")).toBe("");
        expect(formatAmountInputWhileTyping("5x0y0z0")).toBe("5,000");
    });

    it("normalizes leading zeros", () => {
        expect(formatAmountInputWhileTyping("007")).toBe("7");
        expect(formatAmountInputWhileTyping("000")).toBe("0");
        expect(formatAmountInputWhileTyping("0.5")).toBe("0.5");
    });

    it("is idempotent on its own output", () => {
        for (const input of ["5000", "5000.", "5,000.5", "1234567.1234", "٥٠٠٠", ".", "", "0", "007"]) {
            const once = formatAmountInputWhileTyping(input);
            expect(formatAmountInputWhileTyping(once), JSON.stringify(input)).toBe(once);
        }
    });

    it("its output always parses back to the same number the cashier typed", () => {
        expect(parseAmountInput(formatAmountInputWhileTyping("٥٠٠٠"))).toBe("5000");
        expect(parseAmountInput(formatAmountInputWhileTyping("1234567.5"))).toBe("1234567.5");
    });
});

describe("formatQuantityText", () => {
    it("keeps all 4 decimals that matter, never rounding below 4 dp", () => {
        expect(formatQuantityText(0.3333)).toBe("0.3333");
        expect(formatQuantityText("0.3333")).toBe("0.3333");
        expect(formatQuantityText(0.3333)).not.toBe("0.333");
        expect(formatQuantityText("0.0001")).toBe("0.0001");
        expect(formatQuantityText(1000.3333)).toBe("1000.3333");
    });

    it("trims trailing zeros and a dangling decimal point", () => {
        expect(formatQuantityText(0.2)).toBe("0.2");
        expect(formatQuantityText("0.2000")).toBe("0.2");
        expect(formatQuantityText(0.5)).toBe("0.5");
        expect(formatQuantityText(1)).toBe("1");
        expect(formatQuantityText("1.0000")).toBe("1");
        expect(formatQuantityText(2.25)).toBe("2.25");
        expect(formatQuantityText(10)).toBe("10");
        expect(formatQuantityText(100)).toBe("100");
    });

    it("zero reads as 0", () => {
        expect(formatQuantityText(0)).toBe("0");
        expect(formatQuantityText("0.0000")).toBe("0");
    });

    it("a float artifact never reaches the screen", () => {
        expect(formatQuantityText(1.3333000000000002)).toBe("1.3333");
        expect(formatQuantityText(0.1 + 0.2)).toBe("0.3");
    });
});

describe("lineMode", () => {
    it("is 'amount' iff an override is present", () => {
        expect(lineMode({ lineTotalOverrideSYP: "5000.0000" })).toBe("amount");
        expect(lineMode({ lineTotalOverrideSYP: "0.0000" })).toBe("amount");
        expect(lineMode({})).toBe("quantity");
        expect(lineMode({ lineTotalOverrideSYP: undefined })).toBe("quantity");
    });
});

describe("describeAmountLine", () => {
    it("describes an amount line for the large '5,000 ل.س ← 0.3333 كغ' display", () => {
        expect(
            describeAmountLine({ lineTotalOverrideSYP: "5000.0000", quantity: 0.3333, unitName: "كغ" })
        ).toEqual({ amountSYP: "5000.0000", quantityText: "0.3333", unitName: "كغ" });
    });

    it("normalizes the amount to 4 dp and trims the quantity", () => {
        expect(
            describeAmountLine({ lineTotalOverrideSYP: "5000", quantity: 0.5, unitName: "كغ" })
        ).toEqual({ amountSYP: "5000.0000", quantityText: "0.5", unitName: "كغ" });
    });

    it("returns null for a line that is not sold by amount", () => {
        expect(describeAmountLine({ quantity: 0.3333, unitName: "كغ" })).toBeNull();
    });
});

describe("QUICK_WEIGHT_BUTTONS (D7)", () => {
    it("are ¼, ½ and 1, as exact decimal strings", () => {
        expect(QUICK_WEIGHT_BUTTONS.map((b) => b.label)).toEqual(["¼", "½", "1"]);
        expect(QUICK_WEIGHT_BUTTONS.map((b) => b.quantity)).toEqual(["0.25", "0.5", "1"]);
    });

    it("each quantity is already in its shortest exact form", () => {
        for (const button of QUICK_WEIGHT_BUTTONS) {
            expect(formatQuantityText(button.quantity)).toBe(button.quantity);
        }
    });
});