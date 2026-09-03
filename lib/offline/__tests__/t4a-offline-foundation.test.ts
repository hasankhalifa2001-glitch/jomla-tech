/**
 * T4a Acceptance Test: Monetary Precision Round-Trip
 *
 * Verifies that every monetary field in the Dexie offline schema
 * round-trips through lib/utils/money.ts without precision loss.
 *
 * The acceptance criterion reads:
 *   "Every monetary field in Dexie round-trips through lib/utils/money.ts
 *    without precision loss, verified by a test that stores and re-reads
 *    a SYP value in the hundreds of millions with fractional cents and
 *    asserts exact equality."
 *
 * Because Dexie stores monetary values as plain strings (the output of
 * serializeMoney()), and reads them back as those same strings (consumed
 * by toDecimal()), the round-trip under test is:
 *   input → serializeMoney() → string → toDecimal() → Decimal → .toString()
 * If the final Decimal exactly equals the original input (not just
 * "close enough"), the round-trip is lossless.
 */

import { describe, it, expect } from "vitest";
import {
  serializeMoney,
  toDecimal,
  addMoney,
  subtractMoney,
  multiplyMoney,
  divideMoney,
  convertCurrency,
  compareMoney,
  sumMoney,
  formatMoney,
  MoneyError,
} from "@/lib/utils/money";
import {
  createOfflineInvoiceRecord,
  createOfflinePaymentRecord,
  createOfflineCustomerRecord,
  createOfflineVoidRecord,
} from "@/lib/offline/db";
import { generateOfflineId, isValidUUIDv4 } from "@/lib/offline/id";

// ---------------------------------------------------------------------------
// 1. Core money.ts round-trip precision
// ---------------------------------------------------------------------------
describe("money.ts — serialization round-trip precision", () => {
  it("round-trips a SYP value in the hundreds of millions with fractional cents", () => {
    // 456,789,123.4567 — hundreds of millions, four fractional digits
    const original = "456789123.4567";

    const serialized = serializeMoney(original);
    const deserialized = toDecimal(serialized);

    // Exact equality — not "close", not "within epsilon"
    expect(deserialized.toString()).toBe("456789123.4567");
    expect(serialized).toBe("456789123.4567");
  });

  it("round-trips extreme precision values without drift", () => {
    const edgeCases = [
      "0.0001",              // smallest representable fractional cent at 4dp
      "999999999.9999",       // just under a billion
      "123456789.0000",       // integer value serialized with trailing zeros
      "0.1234",               // fractional-only
      "100000000.0001",       // hundred million + smallest fraction
    ];

    for (const value of edgeCases) {
      const serialized = serializeMoney(value);
      const roundTripped = toDecimal(serialized).toFixed(4);
      expect(roundTripped).toBe(value);
    }
  });

  it("preserves precision through arithmetic operations", () => {
    const a = "456789123.4567";
    const b = "123456789.0123";

    const sum = addMoney(a, b);
    expect(sum).toBe("580245912.4690");

    const diff = subtractMoney(a, b);
    expect(diff).toBe("333332334.4444");

    // Verify the sum/difference are internally consistent
    const backToA = addMoney(diff, b);
    expect(backToA).toBe(a);
  });

  it("preserves precision through multiplication", () => {
    // 15000 SYP/USD × $18.50 = 277,500.0000 SYP
    const rate = "15000";
    const usd = "18.5000";
    const syp = multiplyMoney(rate, usd);
    expect(syp).toBe("277500.0000");
  });

  it("preserves precision through division", () => {
    const syp = "277500.0000";
    const rate = "15000";
    const usd = divideMoney(syp, rate);
    expect(usd).toBe("18.5000");
  });

  it("convertCurrency USD→SYP and SYP→USD round-trips exactly", () => {
    const usdAmount = "18.5000";
    const rate = "15000";

    const sypResult = convertCurrency(usdAmount, rate, "USD", "SYP");
    expect(sypResult).toBe("277500.0000");

    const usdBack = convertCurrency(sypResult, rate, "SYP", "USD");
    expect(usdBack).toBe("18.5000");
  });

  it("compareMoney works correctly on large values", () => {
    expect(compareMoney("456789123.4567", "456789123.4567")).toBe(0);
    expect(compareMoney("456789123.4568", "456789123.4567")).toBe(1);
    expect(compareMoney("456789123.4566", "456789123.4567")).toBe(-1);
  });

  it("sumMoney aggregates without precision loss", () => {
    const values = [
      "100000000.1111",
      "200000000.2222",
      "300000000.3333",
      "56789123.4567",
    ];
    const total = sumMoney(values);
    expect(total).toBe("656789124.1233");
  });

  it("formatMoney formats hundreds-of-millions SYP correctly", () => {
    // Smoke test — just ensures it doesn't throw on large values
    const formatted = formatMoney("456789123.4567", "SYP");
    expect(typeof formatted).toBe("string");
    expect(formatted.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 2. money.ts error handling (fail-loud contract)
// ---------------------------------------------------------------------------
describe("money.ts — fail-loud error handling", () => {
  it("throws MoneyError for empty string", () => {
    expect(() => serializeMoney("" as unknown as string)).toThrow(MoneyError);
  });

  it("throws MoneyError for NaN", () => {
    expect(() => serializeMoney(NaN)).toThrow(MoneyError);
  });

  it("throws MoneyError for Infinity", () => {
    expect(() => serializeMoney(Infinity)).toThrow(MoneyError);
  });

  it("throws MoneyError for non-numeric string", () => {
    expect(() => serializeMoney("abc")).toThrow(MoneyError);
  });

  it("throws MoneyError for division by zero", () => {
    expect(() => divideMoney("100", "0")).toThrow(MoneyError);
  });

  it("throws MoneyError for zero exchange rate", () => {
    expect(() => convertCurrency("100", "0", "USD", "SYP")).toThrow(MoneyError);
  });

  it("throws MoneyError for negative exchange rate", () => {
    expect(() => convertCurrency("100", "-15000", "USD", "SYP")).toThrow(MoneyError);
  });
});

// ---------------------------------------------------------------------------
// 3. UUID generation (generateOfflineId)
// ---------------------------------------------------------------------------
describe("generateOfflineId — UUID v4", () => {
  it("produces valid UUID v4 strings", () => {
    for (let i = 0; i < 50; i++) {
      const id = generateOfflineId();
      expect(isValidUUIDv4(id)).toBe(true);
    }
  });

  it("produces unique values", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(generateOfflineId());
    }
    expect(ids.size).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// 4. Factory helpers — monetary fields serialized correctly
// ---------------------------------------------------------------------------
describe("createOfflineInvoiceRecord — monetary field serialization", () => {
  it("serializes all monetary fields as decimal.js strings", () => {
    const record = createOfflineInvoiceRecord({
      tenantId: "tenant-1",
      customerId: "c1",
      items: [
        { productId: "p1", unitId: "u1", quantity: 10, unitPriceUSD: 18.5 },
      ],
      totalUSD: 185,
      totalSYP: 2775000,
      exchangeRateUsed: 15000,
      paidAmountUSD: 185,
      debtAmountUSD: 0,
      paymentMethod: "CASH",
    });

    expect(record.totalUSD).toBe("185.0000");
    expect(record.totalSYP).toBe("2775000.0000");
    expect(record.exchangeRateUsed).toBe("15000.0000");
    expect(record.paidAmountUSD).toBe("185.0000");
    expect(record.debtAmountUSD).toBe("0.0000");
    expect(record.items[0].unitPriceUSD).toBe("18.5000");
    expect(typeof record.offlineId).toBe("string");
    expect(isValidUUIDv4(record.offlineId)).toBe(true);
  });

  it("rejects having both customerId and offlineCustomerId", () => {
    expect(() =>
      createOfflineInvoiceRecord({
        tenantId: "tenant-1",
        customerId: "c1",
        offlineCustomerId: "oc1",
        items: [
          { productId: "p1", unitId: "u1", quantity: 1, unitPriceUSD: 1 },
        ],
        totalUSD: 1,
        totalSYP: 15000,
        exchangeRateUsed: 15000,
        paidAmountUSD: 1,
        debtAmountUSD: 0,
        paymentMethod: "CASH",
      })
    ).toThrow("cannot have both");
  });

  it("requires paymentMethod when paidAmountUSD > 0", () => {
    expect(() =>
      createOfflineInvoiceRecord({
        tenantId: "tenant-1",
        customerId: "c1",
        items: [
          { productId: "p1", unitId: "u1", quantity: 1, unitPriceUSD: 10 },
        ],
        totalUSD: 10,
        totalSYP: 150000,
        exchangeRateUsed: 15000,
        paidAmountUSD: 10,
        debtAmountUSD: 0,
        // paymentMethod intentionally omitted
      })
    ).toThrow("paymentMethod is required");
  });

  it("rejects paymentMethod when paidAmountUSD === 0", () => {
    expect(() =>
      createOfflineInvoiceRecord({
        tenantId: "tenant-1",
        customerId: "c1",
        items: [
          { productId: "p1", unitId: "u1", quantity: 1, unitPriceUSD: 10 },
        ],
        totalUSD: 10,
        totalSYP: 150000,
        exchangeRateUsed: 15000,
        paidAmountUSD: 0,
        debtAmountUSD: 10,
        paymentMethod: "CASH",
      })
    ).toThrow("paymentMethod must not be set");
  });

  it("round-trips a SYP totalSYP in hundreds of millions through the factory", () => {
    const record = createOfflineInvoiceRecord({
      tenantId: "tenant-1",
      customerId: "c1",
      items: [
        { productId: "p1", unitId: "u1", quantity: 1, unitPriceUSD: "30000.4567" },
      ],
      totalUSD: "30000.4567",
      totalSYP: "456789123.4567",
      exchangeRateUsed: "15226.1234",
      paidAmountUSD: "30000.4567",
      debtAmountUSD: "0",
      paymentMethod: "CASH",
    });

    // Exact string equality — no floating-point drift
    expect(record.totalSYP).toBe("456789123.4567");
    expect(record.exchangeRateUsed).toBe("15226.1234");
    expect(record.items[0].unitPriceUSD).toBe("30000.4567");

    // Simulate Dexie read: the stored string passes through toDecimal()
    const readBack = toDecimal(record.totalSYP);
    expect(readBack.toFixed(4)).toBe("456789123.4567");
  });
});

describe("createOfflinePaymentRecord — monetary field serialization", () => {
  it("serializes all monetary fields as decimal.js strings", () => {
    const record = createOfflinePaymentRecord({
      tenantId: "tenant-1",
      customerId: "c1",
      amountUSD: 50.25,
      amountSYP: 753750,
      exchangeRate: 15000,
      paymentMethod: "CASH",
    });

    expect(record.amountUSD).toBe("50.2500");
    expect(record.amountSYP).toBe("753750.0000");
    expect(record.exchangeRate).toBe("15000.0000");
    expect(record.status).toBe("PENDING");
    expect(isValidUUIDv4(record.offlineId)).toBe(true);
  });
});

describe("createOfflineCustomerRecord", () => {
  it("creates a valid offline customer with UUID", () => {
    const record = createOfflineCustomerRecord({
      tenantId: "tenant-1",
      name: "Test Customer",
      phone: "+963912345678",
      shopName: "Test Shop",
    });

    expect(record.name).toBe("Test Customer");
    expect(record.phone).toBe("+963912345678");
    expect(record.status).toBe("PENDING");
    expect(isValidUUIDv4(record.offlineId)).toBe(true);
  });

  it("rejects empty tenantId", () => {
    expect(() =>
      createOfflineCustomerRecord({
        tenantId: "",
        name: "Test",
      })
    ).toThrow("tenantId is required");
  });
});

describe("createOfflineVoidRecord — monetary field serialization", () => {
  it("serializes void with negated monetary fields", () => {
    const record = createOfflineVoidRecord({
      tenantId: "tenant-1",
      customerId: "c1",
      voidsOfflineInvoiceId: "some-uuid",
      voidReason: "Customer returned the product",
      items: [
        { productId: "p1", unitId: "u1", quantity: -5, unitPriceUSD: 10 },
      ],
      totalUSD: -50,
      totalSYP: -750000,
      exchangeRateUsed: 15000,
      originalPaidAmountUSD: 50,
      originalDebtAmountUSD: 0,
    });

    expect(record.totalUSD).toBe("-50.0000");
    expect(record.totalSYP).toBe("-750000.0000");
    // paidAmountUSD should be negated (0 - originalPaidAmountUSD)
    expect(record.paidAmountUSD).toBe("-50.0000");
    // debtAmountUSD should be negated (0 - originalDebtAmountUSD)
    expect(record.debtAmountUSD).toBe("0.0000");
    expect(record.voidsOfflineInvoiceId).toBe("some-uuid");
    expect(record.voidReason).toBe("Customer returned the product");
    expect(record.status).toBe("PENDING");
  });

  it("rejects void items with non-negative quantities", () => {
    expect(() =>
      createOfflineVoidRecord({
        tenantId: "tenant-1",
        customerId: "c1",
        voidsOfflineInvoiceId: "some-uuid",
        voidReason: "Test",
        items: [
          { productId: "p1", unitId: "u1", quantity: 5, unitPriceUSD: 10 },
        ],
        totalUSD: 50,
        totalSYP: 750000,
        exchangeRateUsed: 15000,
        originalPaidAmountUSD: 50,
        originalDebtAmountUSD: 0,
      })
    ).toThrow("quantity strictly less than 0");
  });
});
