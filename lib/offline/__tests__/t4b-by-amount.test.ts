/**
 * lib/offline/__tests__/t4b-by-amount.test.ts
 *
 * Phase 3 — by-amount (بيع بالمبلغ): the pure cart funnel, the service-level
 * defenses in submitOfflineSale, and the exactness of derived quantities.
 * Vitest, node environment, Dexie via fake-indexeddb.
 *
 * Covered here:
 *   - applyLineAmountOverride: derives quantity + amount; rejects a non-base unit
 *     (D1), an amount below the minimum quantity (D5) and a price <= 0.
 *   - setLineQuantity: 4-dp normalization, <= 0 rejection, drops the override.
 *   - clearLineOverride: the key is REMOVED (not left as undefined).
 *   - reconcileLineOverride (D9): unchanged / rederived / cleared.
 *   - addUnitToLine: ten repeats on an amount line keep the line consistent; a
 *     normal line stays exact at 4 dp.
 *   - changeLineUnit: drops the override, keeps the quantity.
 *   - No sequence of funnel calls leaves a cart that calculateCartTotals rejects.
 *   - Stock (D6): totalCachedStock drops by exactly the derived quantity;
 *     cartExceedsKnownStock, including two units of one product.
 *   - submitOfflineSale defenses (4.3): tampered total, total beyond the cart
 *     total, override on a non-base unit, a cached unit whose factor is not 1
 *     while the cart line claims 1, and a product missing from the cache —
 *     every rejection with zero writes.
 *   - Round trip: every 4-dp quantity survives String -> Number -> serializeMoney;
 *     a by-amount invoice keeps "0.3333" / "5000.0000" as exact strings in Dexie.
 *
 * Assertions that already live in sibling suites are not repeated here:
 * calculateCartTotals tolerance boundary / D1 / mixed carts
 * (t4b-pos-override-lifecycle.test.ts), the sync payload of a by-amount sale and
 * its void (t4d-offline-void.test.ts), and the amount parser / formatters (the
 * Phase 4 UI helper tests).
 */

import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getOfflineDb,
  resetOfflineDbForTests,
  createCachedCustomerRecord,
} from "@/lib/offline";
import { createCachedProductRecord } from "@/lib/offline/db";
import {
  addUnitToLine,
  applyLineAmountOverride,
  calculateCartTotals,
  cartExceedsKnownStock,
  changeLineUnit,
  clearLineOverride,
  getOfflineProducts,
  reconcileLineOverride,
  setLineQuantity,
  submitOfflineSale,
  type CartLineItem,
  type OfflineSalePayload,
  type SelectedCustomer,
} from "@/lib/offline/pos-service";
import {
  QuantityFromAmountError,
  multiplyMoney,
  quantityFromAmount,
  serializeMoney,
  subtractMoney,
} from "@/lib/utils/money";

const TENANT_ID = "tenant-by-amount-t4b";

// ----------------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------------

/** A cached product with ONE unit and ONE batch. Defaults model "rice, per kg". */
function makeProduct(
  overrides: Partial<{
    id: string;
    unitId: string;
    unitName: string;
    factor: string;
    price: string;
    stock: string;
  }> = {}
) {
  const id = overrides.id ?? "prod-rice";
  const unitId = overrides.unitId ?? "unit-kg";
  return createCachedProductRecord({
    tenantId: TENANT_ID,
    id,
    name: `منتج ${id}`,
    units: [
      {
        id: unitId,
        unitName: overrides.unitName ?? "كغ",
        conversionFactor: overrides.factor ?? "1",
        priceWholesale: overrides.price ?? "15000.0000",
        pricingCurrency: "SYP",
        isActive: true,
      },
    ],
    batches: [
      {
        id: `batch-${id}`,
        unitId,
        batchNumber: "T-1",
        quantity: overrides.stock ?? "10.0000",
      },
    ],
  });
}

/** A product whose ONLY unit is a carton of 24 (a non-base unit). */
function makeCartonProduct(id: string) {
  return makeProduct({
    id,
    unitId: "unit-carton",
    unitName: "كرتونة",
    factor: "24",
    price: "625.0000",
  });
}

async function seedRice() {
  await getOfflineDb().cachedProducts.add(makeProduct());
}

async function seedCustomer(id = "cust-byamount"): Promise<SelectedCustomer> {
  await getOfflineDb().cachedCustomers.add(
    createCachedCustomerRecord({
      tenantId: TENANT_ID,
      id,
      name: "زبون اختبار",
      phone: "0999000000",
      cachedBalanceDebtSYP: "0.0000",
      hasPriorInvoices: true,
    })
  );
  return {
    type: "EXISTING",
    id,
    name: "زبون اختبار",
    phone: "0999000000",
    balanceDebtSYP: 0,
    hasPriorInvoices: true,
  };
}

/** A base-unit cart line: 0.3333 kg at 15,000 SYP/kg, no override. */
function baseLine(overrides: Partial<CartLineItem> = {}): CartLineItem {
  return {
    id: "l1",
    product: makeProduct(),
    unitId: "unit-kg",
    unitName: "كغ",
    conversionFactor: "1",
    quantity: 0.3333,
    unitPriceSYP: "15000.0000",
    unitPriceUSD: null,
    pricingCurrency: "SYP",
    ...overrides,
  };
}

/** The same line sold by amount: 5,000 SYP for 0.3333 kg. */
function amountLine(overrides: Partial<CartLineItem> = {}): CartLineItem {
  return baseLine({ lineTotalOverrideSYP: "5000.0000", ...overrides });
}

/** A fully-paid cash sale payload for the given cart. */
function cashSale(
  customer: SelectedCustomer,
  items: CartLineItem[],
  totalSYP: string
): OfflineSalePayload {
  return {
    customer,
    items,
    totalSYP,
    exchangeRateUsed: null,
    paidAmountSYP: totalSYP,
    debtAmountSYP: "0.0000",
    paymentMethod: "CASH",
  };
}

async function countInvoices(): Promise<number> {
  return getOfflineDb().offlineInvoices.where("tenantId").equals(TENANT_ID).count();
}

/** quantity x price minus the line's override: the "gap" the tolerance exists for. */
function overrideGap(line: CartLineItem): string {
  return subtractMoney(
    multiplyMoney(line.unitPriceSYP, serializeMoney(line.quantity)),
    line.lineTotalOverrideSYP as string
  );
}

beforeEach(async () => {
  await resetOfflineDbForTests();
});

afterEach(async () => {
  await resetOfflineDbForTests();
});

// ----------------------------------------------------------------------------
// applyLineAmountOverride
// ----------------------------------------------------------------------------

describe("T4b by-amount — applyLineAmountOverride", () => {
  it("derives 0.3333 kg and stores the amount for 5000 @ 15000", () => {
    const items = applyLineAmountOverride([baseLine({ quantity: 1 })], "l1", "5000");

    expect(items[0].quantity).toBe(0.3333);
    expect(items[0].lineTotalOverrideSYP).toBe("5000.0000");
    expect(() => calculateCartTotals(items, null)).not.toThrow();
    expect(calculateCartTotals(items, null).totalSYP).toBe("5000.0000");
  });

  it("rejects an override on a non-base unit (D1)", () => {
    const carton = baseLine({
      unitId: "unit-carton",
      unitName: "كرتونة",
      conversionFactor: "24",
      unitPriceSYP: "625.0000",
      quantity: 8,
    });

    expect(() => applyLineAmountOverride([carton], "l1", "5000")).toThrow(
      /للوحدة الأساسية/
    );
  });

  it("rejects an amount below the minimum derived quantity (D5)", () => {
    expect(() => applyLineAmountOverride([baseLine()], "l1", "0.5")).toThrow(
      /الكمية الدنيا/
    );
  });

  it("rejects a unit price of zero or less", () => {
    expect(() =>
      applyLineAmountOverride([baseLine({ unitPriceSYP: "0" })], "l1", "5000")
    ).toThrow(QuantityFromAmountError);

    expect(() =>
      applyLineAmountOverride([baseLine({ unitPriceSYP: "-5" })], "l1", "5000")
    ).toThrow(QuantityFromAmountError);
  });

  it("rejects an unknown cart line", () => {
    expect(() => applyLineAmountOverride([baseLine()], "nope", "5000")).toThrow();
  });
});

// ----------------------------------------------------------------------------
// setLineQuantity / clearLineOverride
// ----------------------------------------------------------------------------

describe("T4b by-amount — setLineQuantity", () => {
  it("normalizes to 4 dp", () => {
    const items = setLineQuantity([baseLine()], "l1", "0.33334");
    expect(items[0].quantity).toBe(0.3333);
  });

  it("rejects zero, negative, and a value that normalizes to zero", () => {
    expect(() => setLineQuantity([baseLine()], "l1", "0")).toThrow(/أكبر من الصفر/);
    expect(() => setLineQuantity([baseLine()], "l1", "-1")).toThrow(/أكبر من الصفر/);
    expect(() => setLineQuantity([baseLine()], "l1", "0.00004")).toThrow(/أكبر من الصفر/);
  });

  it("drops any amount override, so the line reverts to quantity x price", () => {
    const items = setLineQuantity([amountLine()], "l1", "0.5");

    expect(items[0].quantity).toBe(0.5);
    expect("lineTotalOverrideSYP" in items[0]).toBe(false);
    expect(calculateCartTotals(items, null).totalSYP).toBe(multiplyMoney("0.5", "15000.0000"));
  });
});

describe("T4b by-amount — clearLineOverride", () => {
  it("keeps the quantity, REMOVES the key, and the total reverts to quantity x price", () => {
    const items = clearLineOverride([amountLine()], "l1");

    expect(items[0].quantity).toBe(0.3333);
    expect("lineTotalOverrideSYP" in items[0]).toBe(false);
    expect(calculateCartTotals(items, null).totalSYP).toBe("4999.5000");
  });
});

// ----------------------------------------------------------------------------
// reconcileLineOverride (D9)
// ----------------------------------------------------------------------------

describe("T4b by-amount — reconcileLineOverride (D9)", () => {
  it("unchanged price -> unchanged, quantity and amount kept", () => {
    const result = reconcileLineOverride([amountLine()], "l1");

    expect(result.outcome).toBe("unchanged");
    expect(result.items[0].quantity).toBe(0.3333);
    expect(result.items[0].lineTotalOverrideSYP).toBe("5000.0000");
  });

  it("a price change keeps the AMOUNT and re-derives the quantity", () => {
    const result = reconcileLineOverride(
      [amountLine({ unitPriceSYP: "10000.0000" })],
      "l1"
    );

    expect(result.outcome).toBe("rederived");
    expect(result.items[0].quantity).toBe(0.5);
    expect(result.items[0].lineTotalOverrideSYP).toBe("5000.0000");
    expect(calculateCartTotals(result.items, null).totalSYP).toBe("5000.0000");
  });

  it("a price that makes the derived quantity < 0.0001 clears the override", () => {
    const result = reconcileLineOverride(
      [amountLine({ unitPriceSYP: "200000000.0000" })],
      "l1"
    );

    expect(result.outcome).toBe("cleared");
    expect(result.items[0].quantity).toBe(0.3333);
    expect("lineTotalOverrideSYP" in result.items[0]).toBe(false);
    expect(calculateCartTotals(result.items, null).totalSYP).toBe("66660000.0000");
  });

  it("an override on a non-base unit is cleared", () => {
    const result = reconcileLineOverride(
      [
        amountLine({
          unitId: "unit-carton",
          unitName: "كرتونة",
          conversionFactor: "24",
          unitPriceSYP: "625.0000",
          quantity: 8,
        }),
      ],
      "l1"
    );

    expect(result.outcome).toBe("cleared");
    expect("lineTotalOverrideSYP" in result.items[0]).toBe(false);
  });

  it("a line without an override is unchanged", () => {
    const result = reconcileLineOverride([baseLine()], "l1");

    expect(result.outcome).toBe("unchanged");
    expect(result.items[0].quantity).toBe(0.3333);
  });
});

// ----------------------------------------------------------------------------
// addUnitToLine / changeLineUnit
// ----------------------------------------------------------------------------

describe("T4b by-amount — addUnitToLine", () => {
  it("amount line: ten repeats keep quantity x price - amount unchanged and the cart totalable", () => {
    let items = [amountLine()];
    const initialGap = overrideGap(items[0]);
    expect(initialGap).toBe("-0.5000");

    for (let i = 0; i < 10; i++) {
      items = addUnitToLine(items, "l1");
      expect(() => calculateCartTotals(items, null)).not.toThrow();
      expect(overrideGap(items[0])).toBe(initialGap);
    }

    expect(items[0].quantity).toBe(10.3333);
    expect(items[0].lineTotalOverrideSYP).toBe("155000.0000");
    expect(calculateCartTotals(items, null).totalSYP).toBe("155000.0000");
  });

  it("normal line: 4-dp quantities stay exact after many repeats and no override appears", () => {
    let items = [baseLine()];

    for (let i = 0; i < 10; i++) {
      items = addUnitToLine(items, "l1");
    }

    expect(items[0].quantity).toBe(10.3333);
    expect("lineTotalOverrideSYP" in items[0]).toBe(false);
    expect(calculateCartTotals(items, null).totalSYP).toBe(
      multiplyMoney("15000.0000", "10.3333")
    );
  });
});

describe("T4b by-amount — changeLineUnit", () => {
  it("drops the override, keeps the quantity, applies the new unit fields", () => {
    const items = changeLineUnit([amountLine()], "l1", {
      unitId: "unit-carton",
      unitName: "كرتونة",
      conversionFactor: "24",
      unitPriceSYP: "360000.0000",
      unitPriceUSD: null,
      pricingCurrency: "SYP",
    });

    expect(items[0]).toMatchObject({
      unitId: "unit-carton",
      unitName: "كرتونة",
      conversionFactor: "24",
      unitPriceSYP: "360000.0000",
      quantity: 0.3333,
    });
    expect("lineTotalOverrideSYP" in items[0]).toBe(false);
    expect(() => calculateCartTotals(items, null)).not.toThrow();
  });
});

describe("T4b by-amount — the funnel never leaves a cart that calculateCartTotals rejects", () => {
  it("holds across a long mixed sequence of funnel calls", () => {
    const steps: Array<[string, (cart: CartLineItem[]) => CartLineItem[]]> = [
      ["amount 5000", (c) => applyLineAmountOverride(c, "l1", "5000")],
      ["add one unit", (c) => addUnitToLine(c, "l1")],
      ["amount 7500", (c) => applyLineAmountOverride(c, "l1", "7500")],
      ["quantity 0.5", (c) => setLineQuantity(c, "l1", "0.5")],
      ["amount 20000", (c) => applyLineAmountOverride(c, "l1", "20000")],
      ["clear override", (c) => clearLineOverride(c, "l1")],
      ["amount 3000", (c) => applyLineAmountOverride(c, "l1", "3000")],
      [
        "price drops to 12000, reconcile",
        (c) =>
          reconcileLineOverride(
            c.map((line) => ({ ...line, unitPriceSYP: "12000.0000" })),
            "l1"
          ).items,
      ],
      [
        "change to carton",
        (c) =>
          changeLineUnit(c, "l1", {
            unitId: "unit-carton",
            unitName: "كرتونة",
            conversionFactor: "24",
            unitPriceSYP: "360000.0000",
            unitPriceUSD: null,
            pricingCurrency: "SYP",
          }),
      ],
    ];

    let cart: CartLineItem[] = [baseLine({ quantity: 1 })];
    for (const [name, step] of steps) {
      cart = step(cart);
      expect(() => calculateCartTotals(cart, null), `after "${name}"`).not.toThrow();
    }
  });
});

// ----------------------------------------------------------------------------
// Stock (D6)
// ----------------------------------------------------------------------------

describe("T4b by-amount — stock (D6)", () => {
  beforeEach(seedRice);

  it("a by-amount sale drops totalCachedStock by exactly 0.3333 (10 -> 9.6667)", async () => {
    const customer = await seedCustomer();
    await submitOfflineSale(TENANT_ID, cashSale(customer, [amountLine()], "5000.0000"));

    const rice = (await getOfflineProducts(TENANT_ID)).find((p) => p.id === "prod-rice");

    expect(rice).toBeDefined();
    expect(rice!.totalCachedStock).toBe(9.6667);
  });

  it("cartExceedsKnownStock: true when the cart's base total is above stock", () => {
    const items = [
      baseLine({ id: "l1", quantity: 2 }),
      baseLine({ id: "l2", quantity: 1 }),
    ];
    const result = cartExceedsKnownStock(items, "prod-rice", 2.5);

    expect(result.exceeds).toBe(true);
    expect(result.baseTotal).toBe("3.0000");
    expect(result.stock).toBe("2.5000");
  });

  it("cartExceedsKnownStock: false when the cart's base total is at or below stock", () => {
    const items = [baseLine({ id: "l1", quantity: 2 })];

    expect(cartExceedsKnownStock(items, "prod-rice", 5).exceeds).toBe(false);
    expect(cartExceedsKnownStock(items, "prod-rice", 2).exceeds).toBe(false);
  });

  it("cartExceedsKnownStock: two units of one product are summed in base units", () => {
    const carton = baseLine({
      id: "l2",
      unitId: "unit-carton",
      unitName: "كرتونة",
      conversionFactor: "24",
      unitPriceSYP: "360000.0000",
      quantity: 1,
    });
    const items = [baseLine({ id: "l1", quantity: 1 }), carton];

    const atLimit = cartExceedsKnownStock(items, "prod-rice", 25);
    expect(atLimit.baseTotal).toBe("25.0000");
    expect(atLimit.exceeds).toBe(false);

    expect(cartExceedsKnownStock(items, "prod-rice", 24.9999).exceeds).toBe(true);
  });

  it("cartExceedsKnownStock: lines of OTHER products are ignored", () => {
    const other = baseLine({ id: "l9", product: makeProduct({ id: "prod-other" }), quantity: 50 });
    const items = [baseLine({ id: "l1", quantity: 1 }), other];

    expect(cartExceedsKnownStock(items, "prod-rice", 1).exceeds).toBe(false);
  });
});

// ----------------------------------------------------------------------------
// submitOfflineSale defenses (4.3) — every rejection writes nothing
// ----------------------------------------------------------------------------

describe("T4b by-amount — submitOfflineSale", () => {
  beforeEach(seedRice);

  it("accepts a by-amount cart: total 5000, quantity 0.3333, no override stored on the item", async () => {
    const customer = await seedCustomer();
    const sale = await submitOfflineSale(
      TENANT_ID,
      cashSale(customer, [amountLine()], "5000.0000")
    );

    expect(sale.totalSYP).toBe("5000.0000");
    expect(sale.items[0].quantity).toBe("0.3333");
    expect(sale.items[0]).not.toHaveProperty("lineTotalOverrideSYP");
    expect(await countInvoices()).toBe(1);
  });

  it("rejects the un-overridden total 4999.5 (a tampered total)", async () => {
    const customer = await seedCustomer();

    await expect(
      submitOfflineSale(TENANT_ID, cashSale(customer, [amountLine()], "4999.5000"))
    ).rejects.toThrow(/لا يطابق/);
    expect(await countInvoices()).toBe(0);
  });

  it("rejects a total above the cart total, even by one ten-thousandth", async () => {
    const customer = await seedCustomer();

    await expect(
      submitOfflineSale(TENANT_ID, cashSale(customer, [amountLine()], "5000.0001"))
    ).rejects.toThrow(/لا يطابق/);
    expect(await countInvoices()).toBe(0);
  });

  it("rejects an override on a non-base unit", async () => {
    await getOfflineDb().cachedProducts.add(makeCartonProduct("prod-carton"));
    const customer = await seedCustomer("cust-carton");
    const carton = baseLine({
      product: makeCartonProduct("prod-carton"),
      unitId: "unit-carton",
      unitName: "كرتونة",
      conversionFactor: "24",
      unitPriceSYP: "625.0000",
      quantity: 8,
      lineTotalOverrideSYP: "5000.0000",
    });

    await expect(
      submitOfflineSale(TENANT_ID, cashSale(customer, [carton], "5000.0000"))
    ).rejects.toThrow(/للوحدة الأساسية/);
    expect(await countInvoices()).toBe(0);
  });

  it("rejects an override whose CACHED unit factor is not 1, even when the cart line claims 1 (4.3)", async () => {
    await getOfflineDb().cachedProducts.add(makeCartonProduct("prod-liar"));
    const customer = await seedCustomer("cust-liar");
    const liar = baseLine({
      product: makeCartonProduct("prod-liar"),
      unitId: "unit-carton",
      unitName: "كرتونة",
      // The cart line CLAIMS the base unit; the cached catalog says 24.
      conversionFactor: "1",
      unitPriceSYP: "15000.0000",
      quantity: 0.3333,
      lineTotalOverrideSYP: "5000.0000",
    });

    await expect(
      submitOfflineSale(TENANT_ID, cashSale(customer, [liar], "5000.0000"))
    ).rejects.toThrow(/للوحدة الأساسية/);
    expect(await countInvoices()).toBe(0);
  });

  it("rejects an override when its product is not in the cached catalog at all (4.3)", async () => {
    const customer = await seedCustomer();
    const ghost = amountLine({ product: makeProduct({ id: "prod-ghost" }) });

    await expect(
      submitOfflineSale(TENANT_ID, cashSale(customer, [ghost], "5000.0000"))
    ).rejects.toThrow(/التحقق من وحدة الصنف/);
    expect(await countInvoices()).toBe(0);
  });
});

// ----------------------------------------------------------------------------
// Round trips
// ----------------------------------------------------------------------------

describe("T4b by-amount — exact round trips", () => {
  it(
    "every 4-dp quantity from 0.0001 to 40.0000 survives String -> Number -> serializeMoney",
    () => {
      // Integer loop: i / 10000 is the nearest double to the intended decimal,
      // so toFixed(4) reproduces it with no accumulated float drift.
      const failures: string[] = [];
      for (let i = 1; i <= 400000; i++) {
        const text = (i / 10000).toFixed(4);
        if (serializeMoney(Number(text)) !== text) failures.push(text);
      }
      expect(failures).toEqual([]);
    },
    30000
  );

  it("a sparse sweep up to 9999.9999 survives the same trip", () => {
    const failures: string[] = [];
    for (let i = 400000; i <= 99999999; i += 9973) {
      const text = (i / 10000).toFixed(4);
      if (serializeMoney(Number(text)) !== text) failures.push(text);
    }
    expect(failures).toEqual([]);
  });

  it("quantityFromAmount outputs survive the same trip", () => {
    const cases: Array<[string, string]> = [
      ["5000", "15000"],
      ["3000", "15000"],
      ["15000", "15000"],
      ["1", "20000"], // 0.00005 rounds half-up to the 0.0001 minimum
      ["12345678", "15000"],
    ];

    for (const [amount, price] of cases) {
      const quantity = quantityFromAmount(amount, price);
      expect(serializeMoney(Number(quantity))).toBe(quantity);
    }
  });

  it("a by-amount invoice keeps 0.3333 and 5000.0000 as exact decimal strings in Dexie", async () => {
    await seedRice();
    const customer = await seedCustomer();
    const sale = await submitOfflineSale(
      TENANT_ID,
      cashSale(customer, [amountLine()], "5000.0000")
    );

    const stored = await getOfflineDb()
      .offlineInvoices.where("offlineId")
      .equals(sale.offlineId)
      .first();

    expect(stored).toBeDefined();
    expect(stored!.items[0].quantity).toBe("0.3333");
    expect(stored!.totalSYP).toBe("5000.0000");
    expect(stored!.items[0]).not.toHaveProperty("lineTotalOverrideSYP");
  });
});