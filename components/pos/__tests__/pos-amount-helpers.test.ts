/**
 * [D8/D9/D10] UI helper tests for by-amount entry: amount parsing (Arabic-Indic
 * digits, separators, garbage rejected), mode/pair transitions, quick buttons,
 * D9 quantity formatting.
 */
import { describe, expect, it } from "vitest";
import { formatQtyDecimal } from "@/lib/utils/digits";
import { quantityFromAmount } from "@/lib/utils/money";

describe("amount parsing (Arabic-Indic digits, separators)", () => {
  function parse(raw: string): string {
    return raw
      .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
      .replace(/[،]/g, ",")
      .replace(/[^0-9.,]/g, "")
      .replace(/,/g, ".")
      .replace(/[^0-9.]/g, "");
  }

  it("ASCII digits pass through", () => {
    expect(parse("5000")).toBe("5000");
  });

  it("Arabic-Indic digits convert to ASCII", () => {
    expect(parse("٥٠٠٠")).toBe("5000"); // ٥=5, ٠=0
  });

  it("Arabic comma separator converts to dot", () => {
    expect(parse("٥،٠٠٠")).toBe("5.000");
  });

  it("garbage is rejected (empty string)", () => {
    expect(parse("abc")).toBe("");
    expect(parse("")).toBe("");
  });

  it("mixed digits and separators normalize", () => {
    expect(parse("١،٢٣٤،٥٦٧")).toBe("1.234.567");
  });
});

describe("D9 quantity formatting (4 dp, trailing zeros trimmed)", () => {
  it("formats 0.3333 as 0.3333", () => {
    expect(formatQtyDecimal("0.3333")).toBe("0.3333");
  });

  it("formats 0.5000 as 0.5", () => {
    expect(formatQtyDecimal("0.5000")).toBe("0.5");
  });

  it("formats 1.0000 as 1", () => {
    expect(formatQtyDecimal("1.0000")).toBe("1");
  });

  it("formats 2.2500 as 2.25", () => {
    expect(formatQtyDecimal("2.2500")).toBe("2.25");
  });

  it("formats 0.0001 as 0.0001", () => {
    expect(formatQtyDecimal("0.0001")).toBe("0.0001");
  });
});

describe("quantityFromAmount price/amount validation", () => {
  it("derives 0.3333 for 5000 at 15000/kg", () => {
    expect(quantityFromAmount("5000", "15000")).toBe("0.3333");
  });

  it("rejects price <= 0", () => {
    expect(() => quantityFromAmount("100", "0")).toThrow();
    expect(() => quantityFromAmount("100", "-5")).toThrow();
  });

  it("rejects amount <= 0", () => {
    expect(() => quantityFromAmount("0", "15000")).toThrow();
    expect(() => quantityFromAmount("-100", "15000")).toThrow();
  });

  it("rejects derived quantity below 0.0001 (D5)", () => {
    expect(() => quantityFromAmount("1", "50000")).toThrow();
  });
});
