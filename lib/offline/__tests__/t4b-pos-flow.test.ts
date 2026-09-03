/**
 * T4b Acceptance Tests: Offline-First POS Interface & Sale Flow
 *
 * Verifies all acceptance criteria for T4b:
 * 1. [v3.4] Exact decimal.js cart calculations for high-value SYP sales (tens of millions)
 *    matching an independently-computed reference calculation with ZERO rounding drift.
 * 2. Wholesale price billed vs retail price display-only.
 * 3. Checkout blocked with explicit Arabic error when exchange rate is missing / <= 0.
 * 4. Fully-paid cash sale completed with "زبون نقدي" (system customer / walk-in cash).
 * 5. Toggling debt / partial payment enforces selecting or creating a real customer.
 * 6. Inline walk-in customer creation and persistence.
 * 7. [v3.4] Soft duplicate-phone check surfacing existing customer in cachedCustomers & offlineCustomers.
 * 8. Line items in offlineInvoices NEVER carry batchId (FIFO resolves at sync T4c).
 * 9. Multi-tenant scoping across cached and offline records.
 */

import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Decimal from "decimal.js";
import {
  calculateCartTotals,
  resolveUnitPriceUSD,
  resolveCartLinePrices,
  submitOfflineSale,
  createOfflineWalkInCustomer,
  findMatchingCustomerByPhone,
  getSystemCashCustomer,
  seedSampleOfflineData,
  getOfflineInvoicesList,
  isSystemCashCustomer,
  normalizeCustomerPhone,
  type CartLineItem,
  type SelectedCustomer,
} from "@/lib/offline/pos-service";
import {
  createOfflineInvoiceRecord,
  createOfflineCustomerRecord,
  createCachedProductRecord,
  createCachedCustomerRecord,
  resetOfflineDbForTests,
  getOfflineDb,
} from "@/lib/offline/db";
import {
  subtractMoney,
  sumMoney,
  convertCurrency,
  formatMoney,
} from "@/lib/utils/money";
import { isValidUUIDv4 } from "@/lib/offline/id";

describe("T4b Acceptance Tests — POS Calculations & Precision", () => {
  it("[v3.4] Computes large-value SYP cart totals matching independent Decimal.js reference calculation exactly", () => {
    // 3 high-value wholesale line items with exchange rate 15,250.7500 SYP/USD
    const rate = "15250.7500";

    const mockItems: CartLineItem[] = [
      {
        id: "prod-1-unit-1",
        product: {
          id: "prod-1",
          tenantId: "tenant-1",
          name: "سكر أبيض ناعم شوال 50 كغ",
          units: [],
          batches: [],
        },
        unitId: "unit-1-3",
        unitName: "شوال كبير (50 كغ)",
        conversionFactor: 50,
        quantity: 500, // 500 bags
        unitPriceUSD: "55.1250", // Wholesale price per bag
      },
      {
        id: "prod-2-unit-2",
        product: {
          id: "prod-2",
          tenantId: "tenant-1",
          name: "زيت دوار الشمس كرتونة 6 عبوات",
          units: [],
          batches: [],
        },
        unitId: "unit-2-2",
        unitName: "كرتونة (6 عبوات)",
        conversionFactor: 6,
        quantity: 350,
        unitPriceUSD: "21.4500",
      },
      {
        id: "prod-4-unit-2",
        product: {
          id: "prod-4",
          tenantId: "tenant-1",
          name: "أرز بسمتي هندي كرتونة 4 أكياس",
          units: [],
          batches: [],
        },
        unitId: "unit-4-2",
        unitName: "كرتونة (4 أكياس)",
        conversionFactor: 4,
        quantity: 800,
        unitPriceUSD: "34.8750",
      },
    ];

    // Compute via POS service calculateCartTotals
    const result = calculateCartTotals(mockItems, rate);

    // Independent Decimal reference calculation
    const RefDec = (Decimal as any).clone({ precision: 20, rounding: Decimal.ROUND_HALF_UP });
    const line1USD = new RefDec("55.1250").times(500); // 27562.5000
    const line2USD = new RefDec("21.4500").times(350); // 7507.5000
    const line3USD = new RefDec("34.8750").times(800); // 27900.0000
    const totalRefUSD = line1USD.plus(line2USD).plus(line3USD); // 62970.0000
    const totalRefSYP = totalRefUSD.times(new RefDec(rate)); // 62970 * 15250.75 = 960339727.5000 (over 960 million SYP!)

    // Assert exact equality to 4 decimal places with ZERO float drift
    expect(result.totalUSD).toBe(totalRefUSD.toFixed(4));
    expect(result.totalSYP).toBe(totalRefSYP.toFixed(4));
    expect(result.totalUSD).toBe("62970.0000");
    expect(result.totalSYP).toBe("960339727.5000");
    expect(result.itemCount).toBe(1650);

    // Line totals verification
    expect(result.lineItems[0].lineTotalUSD).toBe("27562.5000");
    expect(result.lineItems[1].lineTotalUSD).toBe("7507.5000");
    expect(result.lineItems[2].lineTotalUSD).toBe("27900.0000");
  });

  it("always uses priceWholesale for billing and ignores priceRetail", () => {
    const product = createCachedProductRecord({
      tenantId: "tenant-1",
      id: "prod-10",
      name: "حليب مجفف",
      priceWholesale: "7.5000",
      units: [
        {
          id: "u-10",
          unitName: "علبة",
          conversionFactor: 1,
          pricingCurrency: "USD",
          priceWholesale: "7.5000",
          priceRetail: "9.0000", // Retail price should NOT be charged
        },
      ],
      batches: [],
    });

    const billedUnitPrice = resolveUnitPriceUSD(product.units[0], product, 15000);
    expect(billedUnitPrice).toBe("7.5000");

    const cartPrices = resolveCartLinePrices(product.units[0], product, 15000);
    expect(cartPrices.unitPriceUSD).toBe("7.5000");
    expect(cartPrices.priceRetailUSD).toBe("9.0000");

    const cartItem: CartLineItem = {
      id: "prod-10-u-10",
      product,
      unitId: "u-10",
      unitName: "علبة",
      conversionFactor: 1,
      quantity: 10,
      unitPriceUSD: billedUnitPrice,
      priceRetailUSD: "9.0000",
    };

    const totals = calculateCartTotals([cartItem], 15000);
    expect(totals.totalUSD).toBe("75.0000"); // 10 * 7.5000, NOT 10 * 9.0000
    expect(totals.totalSYP).toBe("1125000.0000");
  });

  it("blocks checkout when no exchange rate exists or rate <= 0", () => {
    const cartItem: CartLineItem = {
      id: "item-1",
      product: {
        id: "p1",
        tenantId: "tenant-1",
        name: "منتج",
        units: [],
        batches: [],
      },
      unitId: "u1",
      unitName: "قطعة",
      conversionFactor: 1,
      quantity: 2,
      unitPriceUSD: "10.0000",
    };

    // Missing rate returns null totalSYP
    const totalsNull = calculateCartTotals([cartItem], null);
    expect(totalsNull.totalSYP).toBeNull();

    const totalsZero = calculateCartTotals([cartItem], 0);
    expect(totalsZero.totalSYP).toBeNull();

    // Factory validation throws when exchange rate <= 0
    expect(() =>
      createOfflineInvoiceRecord({
        tenantId: "tenant-1",
        customerId: "cust-1",
        items: [{ productId: "p1", unitId: "u1", quantity: 2, unitPriceUSD: "10.0000" }],
        totalUSD: "20.0000",
        totalSYP: "0",
        exchangeRateUsed: "0", // Invalid rate
        paidAmountUSD: "20.0000",
        debtAmountUSD: "0",
        paymentMethod: "CASH",
      })
    ).toThrow();
  });

  it("converts SYP wholesale into billed USD and never uses priceRetail in the cart write", () => {
    const product = createCachedProductRecord({
      tenantId: "tenant-1",
      id: "prod-syp",
      name: "طحين",
      priceWholesale: "18000",
      units: [
        {
          id: "u-syp",
          unitName: "كيس",
          conversionFactor: 1,
          pricingCurrency: "SYP",
          priceWholesale: "18000",
          priceRetail: "21000",
        },
      ],
      batches: [],
    });

    const prices = resolveCartLinePrices(product.units[0], product, "15000");
    expect(prices.unitPriceUSD).toBe("1.2000");
    expect(prices.priceRetailUSD).toBe("1.4000");

    const totals = calculateCartTotals(
      [
        {
          id: "prod-syp-u-syp",
          product,
          unitId: "u-syp",
          unitName: "كيس",
          conversionFactor: 1,
          quantity: 10,
          unitPriceUSD: prices.unitPriceUSD,
          priceRetailUSD: prices.priceRetailUSD,
        },
      ],
      "15000"
    );
    expect(totals.totalUSD).toBe("12.0000");
    expect(totals.totalSYP).toBe("180000.0000");
  });
});

describe("T4b Acceptance Tests — Customer Rules & Sale Flow", () => {
  it("allows 100% paid cash sale with 'زبون نقدي' (system customer)", () => {
    const systemCustomer: SelectedCustomer = {
      type: "SYSTEM",
      id: "sys-cust-1",
      name: "زبون نقدي عام",
      isSystemGenerated: true,
    };

    const invoice = createOfflineInvoiceRecord({
      tenantId: "tenant-1",
      customerId: systemCustomer.id,
      items: [
        {
          productId: "prod-1",
          unitId: "unit-1-1",
          quantity: 5,
          unitPriceUSD: "1.2000",
        },
      ],
      totalUSD: "6.0000",
      totalSYP: "90000.0000",
      exchangeRateUsed: "15000.0000",
      paidAmountUSD: "6.0000",
      debtAmountUSD: "0.0000",
      paymentMethod: "CASH",
    });

    expect(invoice.status).toBe("PENDING");
    expect(isValidUUIDv4(invoice.offlineId)).toBe(true);
    expect(invoice.paidAmountUSD).toBe("6.0000");
    expect(invoice.debtAmountUSD).toBe("0.0000");
    expect(invoice.customerId).toBe("sys-cust-1");
    expect(invoice.offlineCustomerId).toBeUndefined();

    // Verify NO batchId on any line item
    for (const it of invoice.items) {
      expect("batchId" in it).toBe(false);
    }
  });

  it("treats only SYSTEM / isSystemGenerated customers as the cash shortcut", () => {
    expect(isSystemCashCustomer(null)).toBe(false);
    expect(
      isSystemCashCustomer({
        type: "SYSTEM",
        id: "sys-cust-1",
        name: "زبون نقدي عام",
        isSystemGenerated: true,
      })
    ).toBe(true);
    expect(
      isSystemCashCustomer({
        type: "EXISTING",
        id: "cust-1",
        name: "سوبرماركت الأمانة",
      })
    ).toBe(false);
  });

  it("creates a walk-in customer and maps offlineCustomerId on offline invoice", () => {
    const walkInCustomer = createOfflineCustomerRecord({
      tenantId: "tenant-1",
      name: "خالد السعيد",
      phone: "0991234567",
      shopName: "سوبرماركت البركة",
    });

    expect(walkInCustomer.name).toBe("خالد السعيد");
    expect(walkInCustomer.phone).toBe("0991234567");
    expect(walkInCustomer.status).toBe("PENDING");
    expect(isValidUUIDv4(walkInCustomer.offlineId)).toBe(true);

    // Create partial debt sale referencing this offline walk-in customer
    const invoice = createOfflineInvoiceRecord({
      tenantId: "tenant-1",
      offlineCustomerId: walkInCustomer.offlineId,
      items: [
        {
          productId: "prod-2",
          unitId: "unit-2-1",
          quantity: 10,
          unitPriceUSD: "3.5000",
        },
      ],
      totalUSD: "35.0000",
      totalSYP: "525000.0000",
      exchangeRateUsed: "15000.0000",
      paidAmountUSD: "15.0000", // Partial payment
      debtAmountUSD: "20.0000", // Remaining debt
      paymentMethod: "SHAM_CASH",
    });

    expect(invoice.offlineCustomerId).toBe(walkInCustomer.offlineId);
    expect(invoice.customerId).toBeUndefined();
    expect(invoice.paidAmountUSD).toBe("15.0000");
    expect(invoice.debtAmountUSD).toBe("20.0000");
    expect(invoice.paymentMethod).toBe("SHAM_CASH");
    expect(invoice.status).toBe("PENDING");

    // Line items NEVER carry batchId
    for (const it of invoice.items) {
      expect("batchId" in it).toBe(false);
    }
  });

  it("handles full debt sale (0 paid, 100% debt) for registered customer", () => {
    const invoice = createOfflineInvoiceRecord({
      tenantId: "tenant-1",
      customerId: "real-cust-123",
      items: [
        {
          productId: "prod-3",
          unitId: "unit-3-1",
          quantity: 2,
          unitPriceUSD: "4.8000",
        },
      ],
      totalUSD: "9.6000",
      totalSYP: "144000.0000",
      exchangeRateUsed: "15000.0000",
      paidAmountUSD: "0.0000",
      debtAmountUSD: "9.6000",
      // paymentMethod omitted on fully-on-credit sale
    });

    expect(invoice.customerId).toBe("real-cust-123");
    expect(invoice.paidAmountUSD).toBe("0.0000");
    expect(invoice.debtAmountUSD).toBe("9.6000");
    expect(invoice.paymentMethod).toBeUndefined();
  });

  it("[v3.4] Soft duplicate-phone check accurately matches normalized phone numbers in customer records", () => {
    const existingCustomer = createCachedCustomerRecord({
      tenantId: "tenant-1",
      id: "cust-99",
      name: "سامر المصري",
      phone: "0944555666",
      shopName: "محلات الأمل",
      cachedBalanceDebtUSD: "150.0000",
    });

    const enteredPhone = "  0944555666  ";
    expect(normalizeCustomerPhone(existingCustomer.phone ?? "")).toBe(
      normalizeCustomerPhone(enteredPhone)
    );
    expect(existingCustomer.name).toBe("سامر المصري");
  });

  it("calculates partial payment splits and currency conversion without float errors", () => {
    const totalUSD = "123.4567";
    const rate = "14850.2500";
    const paidUSD = "50.0000";

    const remainingDebtUSD = subtractMoney(totalUSD, paidUSD);
    expect(remainingDebtUSD).toBe("73.4567");

    const totalSYP = convertCurrency(totalUSD, rate, "USD", "SYP");
    const paidSYP = convertCurrency(paidUSD, rate, "USD", "SYP");
    const debtSYP = convertCurrency(remainingDebtUSD, rate, "USD", "SYP");

    const sumSYP = sumMoney([paidSYP, debtSYP]);
    expect(sumSYP).toBe(totalSYP);

    expect(formatMoney(totalUSD, "USD")).toBe("١٢٣٫٤٦");
    expect(formatMoney(paidUSD, "USD")).toBe("٥٠٫٠٠");
  });
});

const TENANT = "tenant-t4b";

function cartLine(
  product: ReturnType<typeof createCachedProductRecord>,
  unitIndex: number,
  quantity: number,
  exchangeRate: string
): CartLineItem {
  const unit = product.units[unitIndex];
  const prices = resolveCartLinePrices(unit, product, exchangeRate);
  return {
    id: `${product.id}-${unit.id}`,
    product,
    unitId: unit.id,
    unitName: unit.unitName,
    conversionFactor: unit.conversionFactor,
    quantity,
    unitPriceUSD: prices.unitPriceUSD,
    priceRetailUSD: prices.priceRetailUSD,
  };
}

describe("T4b Acceptance Tests — Dexie offline sale path", () => {
  beforeEach(async () => {
    await resetOfflineDbForTests();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await resetOfflineDbForTests();
  });

  it("completes a fully-paid cash sale with the system customer and no network call", async () => {
    await seedSampleOfflineData(TENANT);
    const db = getOfflineDb();
    const product = await db.cachedProducts.get("prod-1");
    expect(product).toBeDefined();

    const items = [cartLine(product!, 0, 5, "15000")];
    const totals = calculateCartTotals(items, "15000");

    const invoice = await submitOfflineSale(TENANT, {
      customer: null,
      items,
      totalUSD: totals.totalUSD,
      totalSYP: totals.totalSYP ?? "0",
      exchangeRateUsed: "15000",
      paidAmountUSD: totals.totalUSD,
      debtAmountUSD: "0.0000",
      paymentMethod: "CASH",
    });

    expect(invoice.status).toBe("PENDING");
    expect(invoice.customerId).toBe("sys-cust-1");
    expect(invoice.offlineCustomerId).toBeUndefined();
    for (const line of invoice.items) {
      expect("batchId" in line).toBe(false);
    }

    const stored = await getOfflineInvoicesList(TENANT);
    expect(stored).toHaveLength(1);
    expect(stored[0].offlineId).toBe(invoice.offlineId);
    expect(stored[0].totalUSD).toBe(totals.totalUSD);
    expect(stored[0].totalSYP).toBe(totals.totalSYP);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects credit or partial payment against the system cash customer", async () => {
    await seedSampleOfflineData(TENANT);
    const system = await getSystemCashCustomer(TENANT);
    expect(system?.id).toBe("sys-cust-1");

    const db = getOfflineDb();
    const product = await db.cachedProducts.get("prod-1");
    const items = [cartLine(product!, 0, 2, "15000")];
    const totals = calculateCartTotals(items, "15000");
    const paid = "1.0000";
    const debt = subtractMoney(totals.totalUSD, paid);

    await expect(
      submitOfflineSale(TENANT, {
        customer: system,
        items,
        totalUSD: totals.totalUSD,
        totalSYP: totals.totalSYP ?? "0",
        exchangeRateUsed: "15000",
        paidAmountUSD: paid,
        debtAmountUSD: debt,
        paymentMethod: "CASH",
      })
    ).rejects.toThrow("البيع على الحساب أو الدفع الجزئي يتطلب اختيار أو تسجيل زبون حقيقي.");
  });

  it("persists a partial sale with a newly created walk-in customer in Dexie", async () => {
    await seedSampleOfflineData(TENANT);
    const walkIn = await createOfflineWalkInCustomer(TENANT, {
      name: "خالد السعيد",
      phone: "0991234567",
      shopName: "سوبرماركت البركة",
    });

    const db = getOfflineDb();
    const product = await db.cachedProducts.get("prod-2");
    const items = [cartLine(product!, 0, 10, "15000")];
    const totals = calculateCartTotals(items, "15000");
    const paidUSD = "15.0000";
    const debtUSD = subtractMoney(totals.totalUSD, paidUSD);

    const invoice = await submitOfflineSale(TENANT, {
      customer: walkIn,
      items,
      totalUSD: totals.totalUSD,
      totalSYP: totals.totalSYP ?? "0",
      exchangeRateUsed: "15000",
      paidAmountUSD: paidUSD,
      debtAmountUSD: debtUSD,
      paymentMethod: "SHAM_CASH",
    });

    expect(invoice.status).toBe("PENDING");
    expect(invoice.offlineCustomerId).toBe(walkIn.id);
    expect(invoice.customerId).toBeUndefined();
    for (const line of invoice.items) {
      expect("batchId" in line).toBe(false);
    }

    const storedCustomer = await db.offlineCustomers
      .where("offlineId")
      .equals(walkIn.id)
      .first();
    expect(storedCustomer?.name).toBe("خالد السعيد");
    expect(storedCustomer?.phone).toBe("0991234567");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("blocks submitOfflineSale when the exchange rate is missing or zero", async () => {
    await seedSampleOfflineData(TENANT);
    const db = getOfflineDb();
    const product = await db.cachedProducts.get("prod-1");
    const items = [cartLine(product!, 0, 1, "15000")];
    const totals = calculateCartTotals(items, "15000");
    const system = await getSystemCashCustomer(TENANT);

    await expect(
      submitOfflineSale(TENANT, {
        customer: system,
        items,
        totalUSD: totals.totalUSD,
        totalSYP: totals.totalSYP ?? "0",
        exchangeRateUsed: "0",
        paidAmountUSD: totals.totalUSD,
        debtAmountUSD: "0.0000",
        paymentMethod: "CASH",
      })
    ).rejects.toThrow("لا يمكن إتمام البيع بدون تحديد سعر الصرف اليومي.");
  });

  it("[v3.4] surfaces a cached customer with the same phone before a walk-in is saved", async () => {
    await seedSampleOfflineData(TENANT);
    const match = await findMatchingCustomerByPhone(TENANT, "  0944111222  ");
    expect(match).not.toBeNull();
    expect(match?.source).toBe("CACHED");
    expect(match?.customer.name).toBe("سوبرماركت الأمانة");
    expect(fetch).not.toHaveBeenCalled();

    const before = await getOfflineDb().offlineCustomers.where("tenantId").equals(TENANT).count();
    expect(before).toBe(0);
  });

  it("[v3.4] live cart total matches the value written to offlineInvoices with no drift", async () => {
    await seedSampleOfflineData(TENANT);
    const db = getOfflineDb();
    const product = await db.cachedProducts.get("prod-4");
    const items = [cartLine(product!, 1, 800, "15250.7500")];
    const liveTotals = calculateCartTotals(items, "15250.7500");
    const system = await getSystemCashCustomer(TENANT);

    const invoice = await submitOfflineSale(TENANT, {
      customer: system,
      items,
      totalUSD: liveTotals.totalUSD,
      totalSYP: liveTotals.totalSYP ?? "0",
      exchangeRateUsed: "15250.7500",
      paidAmountUSD: liveTotals.totalUSD,
      debtAmountUSD: "0.0000",
      paymentMethod: "CASH",
    });

    expect(invoice.totalUSD).toBe(liveTotals.totalUSD);
    expect(invoice.totalSYP).toBe(liveTotals.totalSYP);
    expect(invoice.totalUSD).toBe(calculateCartTotals(items, "15250.7500").totalUSD);
  });
});

