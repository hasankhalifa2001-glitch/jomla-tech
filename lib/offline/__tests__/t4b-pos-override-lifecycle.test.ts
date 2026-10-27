/**
 * calculateCartTotals with by-amount overrides (D1/D2/D3) and the
 * no-slack rule for carts without overrides.
 */
import { describe, expect, it } from "vitest";
import {
  calculateCartTotals,
  addUnitToLine,
  type CartLineItem,
} from "@/lib/offline/pos-service";

function line(id: string, overrides: Partial<CartLineItem> = {}): CartLineItem {
  const base: CartLineItem = {
    id,
    product: { id: "prod-rice", tenantId: "t1", name: "رز", units: [], batches: [] },
    unitId: "unit-kg",
    unitName: "كغ",
    conversionFactor: "1",
    quantity: 1,
    unitPriceSYP: "15000.0000",
    unitPriceUSD: null,
    pricingCurrency: "SYP",
  };
  return { ...base, ...overrides };
}

describe("calculateCartTotals — by-amount override", () => {
  it("uses the typed amount as the line total (5000, not 4999.5)", () => {
    const totals = calculateCartTotals(
      [line("l1", { quantity: 0.3333, lineTotalOverrideSYP: "5000.0000" })],
      null
    );
    expect(totals.totalSYP).toBe("5000.0000");
    expect(totals.lineItems[0].lineTotalSYP).toBe("5000.0000");
  });

  it("a line WITHOUT override gets zero slack: 0.3333 x 15000 = 4999.5000", () => {
    const totals = calculateCartTotals([line("l1", { quantity: 0.3333 })], null);
    expect(totals.totalSYP).toBe("4999.5000");
  });

  it("rejects an override outside the half-step tolerance (4000 for 0.3333 kg)", () => {
    expect(() =>
      calculateCartTotals(
        [line("l1", { quantity: 0.3333, lineTotalOverrideSYP: "4000.0000" })],
        null
      )
    ).toThrow();
  });

  it("accepts the boundary (diff 0.75) and rejects one 4-dp step beyond", () => {
    const at = line("l1", { quantity: 0.3333, lineTotalOverrideSYP: "5000.2500" });
    const over = line("l1", { quantity: 0.3333, lineTotalOverrideSYP: "5000.2501" });
    expect(() => calculateCartTotals([at], null)).not.toThrow();
    expect(() => calculateCartTotals([over], null)).toThrow();
  });

  it("rejects an override on a non-base unit (D1)", () => {
    // The message reads "…متاح فقط للوحدة الأساسية." — in Arabic "للوحدة" is
    // ل + الوحدة fused, so it does NOT contain the substring "الوحدة". Match
    // the phrase as it is actually written.
    expect(() =>
      calculateCartTotals(
        [line("l1", { conversionFactor: "24", quantity: 1, lineTotalOverrideSYP: "15000.0000" })],
        null
      )
    ).toThrow(/للوحدة الأساسية/);
  });

  it("rejects a zero or negative override", () => {
    expect(() =>
      calculateCartTotals([line("l1", { quantity: 1, lineTotalOverrideSYP: "0" })], null)
    ).toThrow();
  });

  it("mixes override and normal lines; only the override line is adjusted", () => {
    const totals = calculateCartTotals(
      [
        line("l1", { quantity: 0.3333, lineTotalOverrideSYP: "5000.0000" }),
        line("l2", { quantity: 2, unitPriceSYP: "1000.0000" }),
      ],
      null
    );
    expect(totals.totalSYP).toBe("7000.0000");
  });
});

describe("addUnitToLine — money.ts arithmetic", () => {
  it("keeps fractional quantities exact and grows the override by the price", () => {
    const once = addUnitToLine(
      [line("l1", { quantity: 0.3333, lineTotalOverrideSYP: "5000.0000" })],
      "l1"
    );
    expect(once[0].quantity).toBe(1.3333);
    expect(once[0].lineTotalOverrideSYP).toBe("20000.0000");
    // the grown line still satisfies the per-line tolerance
    expect(() => calculateCartTotals(once, null)).not.toThrow();
  });
});