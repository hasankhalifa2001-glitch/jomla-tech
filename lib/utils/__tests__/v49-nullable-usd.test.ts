/**
 * [v4.9] Unit tests for deriveUsd / negateNullableMoney (lib/utils/money.ts).
 *
 * deriveUsd is the ONLY place that decides "USD unavailable": null/empty/<=0
 * rate -> null (never a sentinel 0/1), otherwise exact decimal.js conversion.
 * negateNullableMoney: null stays null (void rows), otherwise subtractMoney("0", x).
 */
import { describe, expect, it } from "vitest";
import { convertCurrency, deriveUsd, negateNullableMoney } from "@/lib/utils/money";

describe("deriveUsd (v4.9)", () => {
  it("null / undefined / empty rate -> null", () => {
    expect(deriveUsd("5800", null)).toBeNull();
    expect(deriveUsd("5800", undefined)).toBeNull();
    expect(deriveUsd("5800", "")).toBeNull();
    expect(deriveUsd("5800", "   ")).toBeNull();
  });

  it("zero / negative rate -> null (never 0/1 sentinel)", () => {
    expect(deriveUsd("5800", "0")).toBeNull();
    expect(deriveUsd("5800", "0.0000")).toBeNull();
    expect(deriveUsd("5800", "-5")).toBeNull();
    expect(deriveUsd("5800", "-0.5")).toBeNull();
  });

  it("non-numeric rate -> null", () => {
    expect(deriveUsd("5800", "abc")).toBeNull();
  });

  it("valid rate -> exact decimal.js result (same as convertCurrency SYP->USD)", () => {
    expect(deriveUsd("5800", "11600")).toBe(convertCurrency("5800", "11600", "SYP", "USD"));
    expect(deriveUsd("5800", "11600")).toBe("0.5000");
    expect(deriveUsd("24000", "135")).toBe("177.7778");
  });
});

describe("negateNullableMoney (v4.9)", () => {
  it("null / undefined stays null", () => {
    expect(negateNullableMoney(null)).toBeNull();
    expect(negateNullableMoney(undefined)).toBeNull();
  });

  it("value -> subtractMoney('0', x)", () => {
    expect(negateNullableMoney("5.5000")).toBe("-5.5000");
    expect(negateNullableMoney("0.0000")).toBe("0.0000");
  });
});
