/**
 * Quantity precision for "sell by amount" (بيع بالمبلغ).
 *
 * The cart stores CartLineItem.quantity as a JS `number` (a deliberate,
 * unchanged type), so every 4-dp quantity makes this trip:
 *
 *     decimal string  ->  Number(...)  ->  serializeMoney(...)  ->  string
 *
 * and must come back identical. These tests prove that trip is lossless over
 * the realistic range, that quantityFromAmount's output survives it, that the
 * derived quantity always lands inside the ONE tolerance defined in money.ts
 * (half a quantity step x price), and that decimal addition of 4-dp quantities
 * never drifts.
 *
 * No literal for the tolerance lives here: it is always asked of
 * isTotalWithinTolerance (money.ts). Quantities are built from INTEGER counts
 * of 0.0001, so the test inputs themselves never go through float arithmetic.
 */
import { describe, expect, it } from "vitest";
import {
  QuantityFromAmountError,
  addMoney,
  isTotalWithinTolerance,
  multiplyMoney,
  quantityFromAmount,
  serializeMoney,
} from "@/lib/utils/money";

/** `units` is an integer count of 0.0001; returns the exact 4-dp string. */
function fourDp(units: number): string {
  const whole = Math.floor(units / 10000);
  const fraction = String(units % 10000).padStart(4, "0");
  return `${whole}.${fraction}`;
}

/** Returns every value in [from, to] (integer units of 0.0001) that does NOT
 * survive String -> Number -> serializeMoney. An empty array means lossless. */
function roundTripFailures(from: number, to: number, stride: number): string[] {
  const failures: string[] = [];
  for (let units = from; units <= to; units += stride) {
    const text = fourDp(units);
    if (serializeMoney(Number(text)) !== text) failures.push(text);
  }
  return failures;
}

describe("String -> Number -> serializeMoney round trip (CartLineItem.quantity)", () => {
  it("is lossless for EVERY quantity from 0.0001 to 2.0000", () => {
    expect(roundTripFailures(1, 20_000, 1)).toEqual([]);
  });

  it("is lossless from 0.0001 to 40.0000 (stride 7, coprime to the 10^4 grid)", () => {
    expect(roundTripFailures(1, 400_000, 7)).toEqual([]);
  });

  it("is lossless up to the 9999.9999 ceiling (stride 9973)", () => {
    expect(roundTripFailures(1, 99_999_999, 9_973)).toEqual([]);
    // The exact edges, explicitly.
    for (const edge of ["0.0001", "0.9999", "1.0000", "9999.9999"]) {
      expect(serializeMoney(Number(edge))).toBe(edge);
    }
  });
});

describe("quantityFromAmount output survives the same trip", () => {
  const prices = ["1", "7", "250", "15000", "15001", "33333"];
  const amounts = ["1", "3", "10", "100", "999", "5000", "12345", "99999"];

  it("for a grid of amounts x prices", () => {
    let checked = 0;
    for (const price of prices) {
      for (const amount of amounts) {
        let quantity: string;
        try {
          quantity = quantityFromAmount(amount, price);
        } catch (err) {
          // Below the 0.0001 minimum (D5): rejected, nothing to round-trip.
          expect(err).toBeInstanceOf(QuantityFromAmountError);
          continue;
        }
        checked += 1;
        expect(serializeMoney(Number(quantity))).toBe(quantity);
      }
    }
    // The grid is not allowed to degenerate into "everything was rejected".
    expect(checked).toBeGreaterThan(40);
  });
});

describe("the derived quantity always lands inside the single tolerance", () => {
  it("|amount - quantity x price| <= half a quantity step x price, for every integer amount 1..3000", () => {
    // Integer prices keep quantity x price exact at 4 dp, so this exercises
    // the tolerance itself (not an extra rounding of the product).
    const prices = ["1", "7", "15000", "15001", "33333", "99999"];
    const violations: string[] = [];
    let checked = 0;

    for (const price of prices) {
      for (let amount = 1; amount <= 3000; amount++) {
        let quantity: string;
        try {
          quantity = quantityFromAmount(String(amount), price);
        } catch {
          continue; // D5 rejection
        }
        checked += 1;
        if (!isTotalWithinTolerance(String(amount), multiplyMoney(quantity, price), [price])) {
          violations.push(`${amount} @ ${price} -> ${quantity}`);
        }
      }
    }

    expect(checked).toBeGreaterThan(15_000);
    expect(violations).toEqual([]);
  });

  it("the documented example: 5000 @ 15001 -> 0.3333 (4999.8333, 0.1667 off)", () => {
    const quantity = quantityFromAmount("5000", "15001");
    expect(quantity).toBe("0.3333");
    expect(multiplyMoney(quantity, "15001")).toBe("4999.8333");
    expect(isTotalWithinTolerance("5000", "4999.8333", ["15001"])).toBe(true);
    // A genuinely different amount must NOT pass.
    expect(isTotalWithinTolerance("5000", "4999.0000", ["15001"])).toBe(false);
  });
});

describe("minimum quantity (D5) and invalid inputs", () => {
  it("accepts exactly 0.0001 and rejects anything that rounds below it", () => {
    expect(quantityFromAmount("1", "7")).toBe("0.1429");
    expect(quantityFromAmount("0.0005", "7")).toBe("0.0001");
    // 0.00035 / 7 = 0.00005 exactly: half-up lands ON the minimum.
    expect(quantityFromAmount("0.00035", "7")).toBe("0.0001");
    // 0.000349 / 7 = 0.0000498...: rounds to 0.0000 -> rejected.
    expect(() => quantityFromAmount("0.000349", "7")).toThrow(QuantityFromAmountError);
    expect(() => quantityFromAmount("0.0001", "7")).toThrow(QuantityFromAmountError);
  });

  it("the D5 rejection carries the Arabic minimum-quantity message", () => {
    expect(() => quantityFromAmount("0.0001", "7")).toThrow(/الكمية الدنيا/);
  });

  it("rejects a price or amount that is zero or negative", () => {
    expect(() => quantityFromAmount("5000", "0")).toThrow(QuantityFromAmountError);
    expect(() => quantityFromAmount("5000", "-15000")).toThrow(QuantityFromAmountError);
    expect(() => quantityFromAmount("0", "15000")).toThrow(QuantityFromAmountError);
    expect(() => quantityFromAmount("-5000", "15000")).toThrow(QuantityFromAmountError);
  });
});

describe("decimal addition of 4-dp quantities (what the stepper and scan-repeat do)", () => {
  it("adds exactly where native arithmetic would not", () => {
    expect(addMoney("0.1", "0.2")).toBe("0.3000");
    expect(addMoney("0.3333", "0.6667")).toBe("1.0000");
    expect(addMoney("9.9999", "0.0001")).toBe("10.0000");
    expect(addMoney("1.3333", "1.3333")).toBe("2.6666");
  });

  it("10,000 additions of 0.0001 land on exactly 1.0000 (no float drift)", () => {
    let total = "0.0000";
    for (let i = 0; i < 10_000; i++) total = addMoney(total, "0.0001");
    expect(total).toBe("1.0000");
  });

  it("scan-repeat on a 0.3333 line, 1000 times, through the Number() hop the cart uses", () => {
    // The cart keeps quantity as a number and converts once per write, exactly
    // like addUnitToLine: Number(addMoney(quantity, "1")).
    let quantity = 0.3333;
    for (let i = 0; i < 1000; i++) quantity = Number(addMoney(quantity, "1"));
    expect(serializeMoney(quantity)).toBe("1000.3333");
  });

  it("addMoney of two grid values equals the integer-unit sum (20,000 deterministic pairs)", () => {
    const mismatches: string[] = [];
    for (let i = 1; i <= 20_000; i++) {
      const a = ((i * 7919) % 400_000) + 1;
      const b = ((i * 104_729) % 400_000) + 1;
      const expected = fourDp(a + b);
      const actual = addMoney(fourDp(a), fourDp(b));
      if (actual !== expected) mismatches.push(`${fourDp(a)} + ${fourDp(b)}: ${actual} != ${expected}`);
    }
    expect(mismatches).toEqual([]);
  });
});