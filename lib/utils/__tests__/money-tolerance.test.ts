/**
 * Phase 1 unit tests for the D2/D3 tolerance helpers in lib/utils/money.ts.
 *
 * Covers:
 *   - quantityFromAmount(): amount / unitPriceSYP rounded once (HALF_UP) to 4 dp
 *   - D5 rejections: price <= 0, amount <= 0, derived quantity < 0.0001
 *   - invoiceTotalTolerance(): SUM(|price| x 0.00005) over lines, rounded UP once
 *   - isTotalWithinTolerance(): inclusive |expected - actual| <= tolerance sum
 *   - sumMoney([]) format ("0.0000", same as every other money helper)
 *   - Invariant sweep: the error of quantityFromAmount() never leaves the
 *     tolerance computed by invoiceTotalTolerance() (the link between D2 and D3)
 *
 * NOTE: that the tolerance constant/logic is defined ONLY in lib/utils/money.ts
 * is enforced by a static source scan (added in Phase 2), not by this file.
 */

import { describe, expect, it } from "vitest";
import {
  QUANTITY_HALF_STEP,
  QuantityFromAmountError,
  invoiceTotalTolerance,
  isTotalWithinTolerance,
  multiplyMoney,
  quantityFromAmount,
  sumMoney,
} from "@/lib/utils/money";

describe("QUANTITY_HALF_STEP (D2)", () => {
  it("is exactly 0.00005, half of the 4-decimal quantity step", () => {
    expect(QUANTITY_HALF_STEP).toBe("0.00005");
  });
});

describe("sumMoney", () => {
  it("returns the 4-dp zero string for an empty list", () => {
    expect(sumMoney([])).toBe("0.0000");
  });

  it("sums values at 4 dp", () => {
    expect(sumMoney(["1.5", "2.25"])).toBe("3.7500");
  });
});

describe("quantityFromAmount (D2/D3/D5)", () => {
  it("derives 0.3333 kg for 5,000 SYP at 15,000 SYP/kg", () => {
    expect(quantityFromAmount("5000", "15000")).toBe("0.3333");
  });

  it("handles exact divisions", () => {
    expect(quantityFromAmount("3000", "15000")).toBe("0.2000");
    expect(quantityFromAmount("15000", "15000")).toBe("1.0000");
    expect(quantityFromAmount("75000", "15000")).toBe("5.0000");
  });

  it("handles large SYP values with fractions", () => {
    // 12,345,678 / 15,000 = 823.0452
    expect(quantityFromAmount("12345678", "15000")).toBe("823.0452");
  });

  it("rounds HALF_UP at the 4th decimal edge", () => {
    // 1 / 20,000 = 0.00005 -> HALF_UP rounds to 0.0001
    expect(quantityFromAmount("1", "20000")).toBe("0.0001");
    // 1 / 30,000 = 0.0000333... -> rounds down to 0.0000, but that's < 0.0001 -> D5 reject
    expect(() => quantityFromAmount("1", "30000")).toThrow(
      QuantityFromAmountError
    );
  });

  it("rejects price <= 0", () => {
    expect(() => quantityFromAmount("100", "0")).toThrow(
      QuantityFromAmountError
    );
    expect(() => quantityFromAmount("100", "-5")).toThrow(
      QuantityFromAmountError
    );
    expect(() => quantityFromAmount("100", "-0.0001")).toThrow(
      QuantityFromAmountError
    );
  });

  it("rejects amount <= 0", () => {
    expect(() => quantityFromAmount("0", "15000")).toThrow(
      QuantityFromAmountError
    );
    expect(() => quantityFromAmount("-100", "15000")).toThrow(
      QuantityFromAmountError
    );
  });

  it("rejects derived quantity below 0.0001 minimum (D5)", () => {
    // 1 / 50,000 = 0.00002 -> rounds to 0.0000 < 0.0001
    expect(() => quantityFromAmount("1", "50000")).toThrow(
      QuantityFromAmountError
    );
    // 2 / 50,000 = 0.00004 -> rounds to 0.0000 < 0.0001
    expect(() => quantityFromAmount("2", "50000")).toThrow(
      QuantityFromAmountError
    );
    // 3 / 50,000 = 0.00006 -> rounds to 0.0001 (passes D5)
    expect(quantityFromAmount("3", "50000")).toBe("0.0001");
  });

  it("throws QuantityFromAmountError (a MoneyError subclass)", () => {
    try {
      quantityFromAmount("0", "15000");
    } catch (err) {
      expect(err).toBeInstanceOf(QuantityFromAmountError);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).name).toBe("QuantityFromAmountError");
      return;
    }
    throw new Error("expected quantityFromAmount to throw");
  });
});

describe("invoiceTotalTolerance (D2/D3)", () => {
  it("sums |price| x 0.00005 over every line", () => {
    // 15,000 x 0.00005 = 0.7500
    expect(invoiceTotalTolerance(["15000"])).toBe("0.7500");
    // 15,000 x 0.00005 = 0.7500 ; 30,000 x 0.00005 = 1.5000 ; total = 2.2500
    expect(invoiceTotalTolerance(["15000", "30000"])).toBe("2.2500");
    // duplicates are counted per line (D3)
    expect(invoiceTotalTolerance(["15000", "15000"])).toBe("1.5000");
  });

  it("handles empty invoice (no lines) -> zero tolerance", () => {
    expect(invoiceTotalTolerance([])).toBe("0.0000");
  });

  it("rounds the tolerance UP, never down (fractional price)", () => {
    // 10,000.0001 x 0.00005 = 0.500000005 -> CEIL to 4 dp = 0.5001
    // (a plain 4-dp HALF_UP round would have produced 0.5000, below the true value)
    expect(invoiceTotalTolerance(["10000.0001"])).toBe("0.5001");
  });

  it("rounds once over the full sum, not per line", () => {
    // each line: 10,000.0001 x 0.00005 = 0.500000005 ; sum = 1.00000001 -> CEIL = 1.0001
    expect(invoiceTotalTolerance(["10000.0001", "10000.0001"])).toBe("1.0001");
  });

  it("uses |price| (sign of the price never reduces the tolerance)", () => {
    expect(invoiceTotalTolerance(["-15000"])).toBe("0.7500");
  });

  it("odd price 15001: tolerance rounds UP to 0.7501 (CEIL)", () => {
    // 15001 x 0.00005 = 0.75005 -> CEIL to 4 dp = 0.7501
    expect(invoiceTotalTolerance(["15001"])).toBe("0.7501");
  });

  it("odd price 7: tolerance rounds UP to 0.0004 (CEIL)", () => {
    // 7 x 0.00005 = 0.00035 -> CEIL to 4 dp = 0.0004
    expect(invoiceTotalTolerance(["7"])).toBe("0.0004");
  });
});

describe("isTotalWithinTolerance (D2/D3)", () => {
  const prices = ["15000"]; // tolerance = 0.7500

  it("accepts exact match", () => {
    expect(isTotalWithinTolerance("5000", "5000", prices)).toBe(true);
  });

  it("accepts difference within tolerance (inclusive)", () => {
    // diff = 0.5 <= 0.75 -> accepted
    expect(isTotalWithinTolerance("5000", "4999.5", prices)).toBe(true);
    // diff = 0.75 == tolerance -> inclusive, accepted
    expect(isTotalWithinTolerance("5000", "4999.25", prices)).toBe(true);
  });

  it("rejects difference above tolerance", () => {
    // diff = 1.0 > 0.75 -> rejected
    expect(isTotalWithinTolerance("5000", "4999.0", prices)).toBe(false);
    // diff = 0.8 > 0.75 -> rejected
    expect(isTotalWithinTolerance("5000", "4999.2", prices)).toBe(false);
  });

  it("rejects one 4-dp unit beyond the boundary", () => {
    // diff = 0.7501 > 0.7500 -> rejected
    expect(isTotalWithinTolerance("5000", "4999.2499", prices)).toBe(false);
  });

  it("works for voids (expected is negated) using absolute difference", () => {
    // void: expected = -5000, actual items total negated = -4999.5 -> diff = 0.5
    expect(isTotalWithinTolerance("-5000", "-4999.5", prices)).toBe(true);
  });

  it("uses per-line prices including duplicates", () => {
    // two lines @ 15,000 -> tolerance = 1.5000; diff = 1.0 <= 1.5 -> accepted
    expect(
      isTotalWithinTolerance("10000", "9999.0", ["15000", "15000"])
    ).toBe(true);
    // diff = 1.6 > 1.5 -> rejected
    expect(
      isTotalWithinTolerance("10000", "9998.4", ["15000", "15000"])
    ).toBe(false);
  });

  it("scales with price (a cheaper line allows less slack)", () => {
    // price 1,000 -> tolerance 0.0500 ; diff 0.06 -> rejected, diff 0.05 -> accepted
    expect(isTotalWithinTolerance("100", "99.94", ["1000"])).toBe(false);
    expect(isTotalWithinTolerance("100", "99.95", ["1000"])).toBe(true);
  });
});

/**
 * Deterministic pseudo-random generator (LCG) so the sweep below is
 * reproducible. The native numbers here only GENERATE test inputs; every
 * monetary computation under test goes through lib/utils/money.ts.
 */
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe("quantityFromAmount x tolerance invariant (D3)", () => {
  it("derived quantity x price never leaves the invoice tolerance", () => {
    const rnd = lcg(20261026);
    let checked = 0;

    for (let i = 0; i < 10000; i++) {
      // even: integer SYP price; odd: fractional 4-dp price (USD-converted case)
      const price =
        i % 2 === 0
          ? String(1 + Math.floor(rnd() * 2_000_000))
          : (1 + rnd() * 500_000).toFixed(4);
      const amount = String(1 + Math.floor(rnd() * 500_000));

      let quantity: string;
      try {
        quantity = quantityFromAmount(amount, price);
      } catch (err) {
        if (err instanceof QuantityFromAmountError) continue; // D5 reject
        throw err;
      }

      const lineTotal = multiplyMoney(quantity, price);
      expect(isTotalWithinTolerance(amount, lineTotal, [price])).toBe(true);
      checked++;
    }

    // guard against the sweep silently skipping almost everything
    expect(checked).toBeGreaterThan(9000);
  });
});