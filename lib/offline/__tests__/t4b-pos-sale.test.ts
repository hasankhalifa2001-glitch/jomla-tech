/**
 * T4b POS Sale Flow — Acceptance Criteria Tests
 *
 * Covers all vitest-verifiable acceptance criteria from T4b:
 *
 *   1. A large-value SYP cart total matches an independent decimal.js
 *      reference EXACTLY (no float drift).
 *   2. Cart & dual-currency calculation:
 *      - SYP-priced units resolve unitPriceSYP without rate.
 *      - USD-priced units need a valid cached rate or fail loud.
 *      - cartNeedsExchangeRate() returns false for SYP-only carts, true for USD carts.
 *      - priceWholesale is always billed; priceRetail is display-only.
 *   3. Customer selection & payment rules:
 *      - System customer shortcut is strictly cash-only (zero debt).
 *      - Any credit/partial payment forces a real customer.
 *   4. Walk-in customer creation with soft duplicate-phone check (cached + offline).
 *   5. Checkout writes to Dexie offlineInvoices with status: PENDING,
 *      no batchId written, and updates customer balance.
 */

import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Decimal from "decimal.js";
import {
  getOfflineDb,
  resetOfflineDbForTests,
  createCachedProductRecord,
  createCachedCustomerRecord,
} from "@/lib/offline";
import {
  calculateCartTotals,
  cartNeedsExchangeRate,
  resolveUnitPriceSYP,
  resolveCartLinePrices,
  submitOfflineSale,
  createOfflineWalkInCustomer,
  findMatchingCustomerByPhone,
  type CartLineItem,
} from "@/lib/offline/pos-service";

describe("T4b — Offline-First POS Interface (Sale Flow + Walk-in Customer)", () => {
  const TEST_TENANT_ID = "tenant-pos-t4b-test";

  beforeEach(async () => {
    vi.clearAllMocks();
    await resetOfflineDbForTests();
  });

  afterEach(async () => {
    await resetOfflineDbForTests();
  });

  describe("1. Large-Value SYP Cart Total Precision (decimal.js Reference)", () => {
    it("matches an independent decimal.js reference exactly with zero floating-point drift on large values", () => {
      // Create sample high-value SYP line items
      const mockProduct = createCachedProductRecord({
        tenantId: TEST_TENANT_ID,
        id: "prod-high-value",
        name: "منتج جملة عالي القيمة",
        units: [
          {
            id: "unit-1",
            unitName: "شاحنة",
            conversionFactor: 1000,
            priceWholesale: "187543210.7500",
            priceRetail: "195000000.0000",
            pricingCurrency: "SYP",
            isActive: true,
          },
        ],
        batches: [],
      });

      const lineItems: CartLineItem[] = [
        {
          id: "line-1",
          product: mockProduct,
          unitId: "unit-1",
          unitName: "شاحنة",
          conversionFactor: "1000",
          quantity: 43,
          unitPriceSYP: "187543210.7500",
          unitPriceUSD: null,
          pricingCurrency: "SYP",
          priceRetailSYP: "195000000.0000",
        },
        {
          id: "line-2",
          product: mockProduct,
          unitId: "unit-1",
          unitName: "شاحنة",
          conversionFactor: "1000",
          quantity: 125,
          unitPriceSYP: "29481235.5000",
          unitPriceUSD: null,
          pricingCurrency: "SYP",
          priceRetailSYP: "31000000.0000",
        },
        {
          id: "line-3",
          product: mockProduct,
          unitId: "unit-1",
          unitName: "شاحنة",
          conversionFactor: "1000",
          quantity: 999,
          unitPriceSYP: "1234567.8900",
          unitPriceUSD: null,
          pricingCurrency: "SYP",
        },
      ];

      // Independent decimal.js computation:
      // total = (43 * 187543210.7500) + (125 * 29481235.5000) + (999 * 1234567.8900)
      let decRef = new Decimal(0);
      for (const item of lineItems) {
        const lineVal = new Decimal(item.quantity).times(new Decimal(item.unitPriceSYP));
        decRef = decRef.plus(lineVal);
      }
      const expectedTotalSYP = decRef.toFixed(4);

      const cartTotals = calculateCartTotals(lineItems, null);

      expect(cartTotals.totalSYP).toBe(expectedTotalSYP);
      expect(cartTotals.itemCount).toBe(43 + 125 + 999);
      expect(cartTotals.lineItems).toHaveLength(3);

      // Ensure wholesale price was billed, not retail price
      expect(cartTotals.totalSYP).not.toBe(
        new Decimal(43).times(195000000).plus(new Decimal(125).times(31000000)).toFixed(4)
      );
      // Secondary USD is null when no rate is provided
      expect(cartTotals.totalUSD).toBeNull();
    });
  });

  describe("2. Dual-Currency Calculation & Rate Gating", () => {
    const sypProduct = createCachedProductRecord({
      tenantId: TEST_TENANT_ID,
      id: "prod-syp",
      name: "سكر أبيض محلي",
      units: [
        {
          id: "unit-syp-1",
          unitName: "شوال",
          conversionFactor: 50,
          priceWholesale: "750000.0000",
          priceRetail: "780000.0000",
          pricingCurrency: "SYP",
          isActive: true,
        },
      ],
      batches: [],
    });

    const usdProduct = createCachedProductRecord({
      tenantId: TEST_TENANT_ID,
      id: "prod-usd",
      name: "زيت عباد الشمس مستورد",
      units: [
        {
          id: "unit-usd-1",
          unitName: "كرتونة",
          conversionFactor: 12,
          priceWholesale: "32.5000",
          priceRetail: "35.0000",
          pricingCurrency: "USD",
          isActive: true,
        },
      ],
      batches: [],
    });

    it("resolves SYP-priced units without an exchange rate", () => {
      const unit = sypProduct.units[0];
      const resolved = resolveCartLinePrices(unit, sypProduct, null);

      expect(resolved.unitPriceSYP).toBe("750000.0000");
      expect(resolved.unitPriceUSD).toBeNull();
      expect(resolved.pricingCurrency).toBe("SYP");
      expect(resolved.priceRetailSYP).toBe("780000.0000");
    });

    it("fails loud when resolving USD-priced unit without a valid exchange rate", () => {
      const unit = usdProduct.units[0];

      expect(() => {
        resolveUnitPriceSYP(unit, usdProduct, null);
      }).toThrow(/لا يمكن احتساب سعر هذا المنتج بالليرة السورية/);

      expect(() => {
        resolveUnitPriceSYP(unit, usdProduct, 0);
      }).toThrow(/لا يمكن احتساب سعر هذا المنتج بالليرة السورية/);
    });

    it("accurately converts USD-priced unit when a valid exchange rate is provided", () => {
      const unit = usdProduct.units[0];
      const rate = 15000;
      const resolved = resolveCartLinePrices(unit, usdProduct, rate);

      // 32.5000 * 15000 = 487500.0000
      expect(resolved.unitPriceSYP).toBe("487500.0000");
      expect(resolved.unitPriceUSD).toBe("32.5000");
      expect(resolved.pricingCurrency).toBe("USD");
      // Retail: 35.0000 * 15000 = 525000.0000
      expect(resolved.priceRetailSYP).toBe("525000.0000");
      expect(resolved.priceRetailUSD).toBe("35.0000");
    });

    it("cartNeedsExchangeRate correctly detects whether rate is mandatory", () => {
      const sypCartItem: CartLineItem = {
        id: "cart-1",
        product: sypProduct,
        unitId: "unit-syp-1",
        unitName: "شوال",
        conversionFactor: "50",
        quantity: 2,
        unitPriceSYP: "750000.0000",
        unitPriceUSD: null,
        pricingCurrency: "SYP",
      };

      const usdCartItem: CartLineItem = {
        id: "cart-2",
        product: usdProduct,
        unitId: "unit-usd-1",
        unitName: "كرتونة",
        conversionFactor: "12",
        quantity: 1,
        unitPriceSYP: "487500.0000",
        unitPriceUSD: "32.5000",
        pricingCurrency: "USD",
      };

      // Only SYP items -> no rate needed
      expect(cartNeedsExchangeRate([sypCartItem])).toBe(false);

      // Mixed or USD only -> rate needed
      expect(cartNeedsExchangeRate([usdCartItem])).toBe(true);
      expect(cartNeedsExchangeRate([sypCartItem, usdCartItem])).toBe(true);
    });
  });

  describe("3. Customer Selection & Debt Invariants", () => {
    it("system customer cannot carry any debt (strictly cash-only)", async () => {
      const sypProduct = createCachedProductRecord({
        tenantId: TEST_TENANT_ID,
        id: "prod-syp-item",
        name: "منتج نقدي",
        units: [
          {
            id: "unit-syp-c",
            unitName: "قطعة",
            conversionFactor: 1,
            priceWholesale: "10000.0000",
            pricingCurrency: "SYP",
            isActive: true,
          },
        ],
        batches: [],
      });

      const cartItem: CartLineItem = {
        id: "c-1",
        product: sypProduct,
        unitId: "unit-syp-c",
        unitName: "قطعة",
        conversionFactor: "1",
        quantity: 2,
        unitPriceSYP: "10000.0000",
        unitPriceUSD: null,
        pricingCurrency: "SYP",
      };

      const systemCustomer = {
        type: "SYSTEM" as const,
        id: "sys-cust-1",
        name: "زبون نقدي (افتراضي)",
        isSystemGenerated: true,
      };

      // Attempt partial payment with system customer -> must throw
      await expect(
        submitOfflineSale(TEST_TENANT_ID, {
          customer: systemCustomer,
          items: [cartItem],
          totalSYP: "20000.0000",
          exchangeRateUsed: "15000.0000",
          paidAmountSYP: "15000.0000",
          debtAmountSYP: "5000.0000",
          paymentMethod: "CASH",
        })
      ).rejects.toThrow(/البيع على الحساب أو الدفع الجزئي يتطلب اختيار أو تسجيل زبون حقيقي/);

      // Attempt full credit with system customer -> must throw
      await expect(
        submitOfflineSale(TEST_TENANT_ID, {
          customer: systemCustomer,
          items: [cartItem],
          totalSYP: "20000.0000",
          exchangeRateUsed: "15000.0000",
          paidAmountSYP: "0.0000",
          debtAmountSYP: "20000.0000",
        })
      ).rejects.toThrow(/البيع على الحساب أو الدفع الجزئي يتطلب اختيار أو تسجيل زبون حقيقي/);

      // Full cash payment with system customer -> succeeds
      const sale = await submitOfflineSale(TEST_TENANT_ID, {
        customer: systemCustomer,
        items: [cartItem],
        totalSYP: "20000.0000",
        exchangeRateUsed: "15000.0000",
        paidAmountSYP: "20000.0000",
        debtAmountSYP: "0.0000",
        paymentMethod: "CASH",
      });

      expect(sale.status).toBe("PENDING");
      expect(sale.debtAmountSYP).toBe("0.0000");
    });
  });

  describe("4. Walk-in Customer & Duplicate-Phone Checks", () => {
    it("creates an offline walk-in customer stored in Dexie", async () => {
      const walkIn = await createOfflineWalkInCustomer(TEST_TENANT_ID, {
        name: "أحمد السوري",
        phone: "0991234567",
        shopName: "بقالية النور",
      });

      expect(walkIn.type).toBe("WALK_IN");
      expect(walkIn.name).toBe("أحمد السوري");
      expect(walkIn.phone).toBe("0991234567");
      expect(walkIn.shopName).toBe("بقالية النور");
      expect(walkIn.balanceDebtSYP).toBe(0);

      const db = getOfflineDb();
      const savedInDb = await db.offlineCustomers.where("offlineId").equals(walkIn.id).first();
      expect(savedInDb).toBeDefined();
      expect(savedInDb?.name).toBe("أحمد السوري");
      expect(savedInDb?.status).toBe("PENDING");
    });

    it("detects duplicate phone from cachedCustomers and offlineCustomers", async () => {
      const db = getOfflineDb();

      // Seed an existing cached customer
      await db.cachedCustomers.add(
        createCachedCustomerRecord({
          tenantId: TEST_TENANT_ID,
          id: "cust-cached-1",
          name: "سامر التاجر",
          phone: "0944112233",
          cachedBalanceDebtSYP: "50000.0000",
        })
      );

      // Check duplicate matching cached customer (with spaces)
      const cachedMatch = await findMatchingCustomerByPhone(TEST_TENANT_ID, "0944 112 233");
      expect(cachedMatch).not.toBeNull();
      expect(cachedMatch?.source).toBe("CACHED");
      expect(cachedMatch?.customer.name).toBe("سامر التاجر");

      // Seed an offline walk-in customer
      await createOfflineWalkInCustomer(TEST_TENANT_ID, {
        name: "خالد المحمد",
        phone: "0988776655",
      });

      // Check duplicate matching offline walk-in customer (with spaces)
      const offlineMatch = await findMatchingCustomerByPhone(TEST_TENANT_ID, " 0988776655 ");
      expect(offlineMatch).not.toBeNull();
      expect(offlineMatch?.source).toBe("OFFLINE");
      expect(offlineMatch?.customer.name).toBe("خالد المحمد");
    });
  });

  describe("5. Offline Checkout Execution & PENDING Persistence", () => {
    it("writes sale to offlineInvoices with status: PENDING, without batchId, and updates customer balance", async () => {
      const db = getOfflineDb();

      // Add a cached customer for credit sale
      await db.cachedCustomers.add(
        createCachedCustomerRecord({
          tenantId: TEST_TENANT_ID,
          id: "cust-real-1",
          name: "عمر الفاروق",
          phone: "0933555777",
          cachedBalanceDebtSYP: "100000.0000",
        })
      );

      const customer = {
        type: "EXISTING" as const,
        id: "cust-real-1",
        name: "عمر الفاروق",
        phone: "0933555777",
        balanceDebtSYP: 100000,
        hasPriorInvoices: true,
      };

      const product = createCachedProductRecord({
        tenantId: TEST_TENANT_ID,
        id: "prod-sugar",
        name: "سكر 50 كغ",
        units: [
          {
            id: "unit-sugar-bag",
            unitName: "شوال",
            conversionFactor: 1,
            priceWholesale: "600000.0000",
            pricingCurrency: "SYP",
            isActive: true,
          },
        ],
        batches: [],
      });

      const cartItem: CartLineItem = {
        id: "item-1",
        product,
        unitId: "unit-sugar-bag",
        unitName: "شوال",
        conversionFactor: "1",
        quantity: 2,
        unitPriceSYP: "600000.0000",
        unitPriceUSD: null,
        pricingCurrency: "SYP",
      };

      // Total = 1,200,000 SYP. Paid = 500,000 SYP. Debt = 700,000 SYP.
      const invoice = await submitOfflineSale(TEST_TENANT_ID, {
        customer,
        items: [cartItem],
        totalSYP: "1200000.0000",
        exchangeRateUsed: "15000.0000",
        paidAmountSYP: "500000.0000",
        debtAmountSYP: "700000.0000",
        paymentMethod: "CASH",
      });

      expect(invoice.status).toBe("PENDING");
      expect(invoice.totalSYP).toBe("1200000.0000");
      expect(invoice.paidAmountSYP).toBe("500000.0000");
      expect(invoice.debtAmountSYP).toBe("700000.0000");
      expect(invoice.customerId).toBe("cust-real-1");

      // Critical invariant: NO batchId is written to invoice or invoice items
      expect((invoice as any).batchId).toBeUndefined();
      for (const item of invoice.items) {
        expect((item as any).batchId).toBeUndefined();
      }

      // Verify invoice exists in Dexie
      const savedInDb = await db.offlineInvoices.where("offlineId").equals(invoice.offlineId).first();
      expect(savedInDb).toBeDefined();
      expect(savedInDb?.status).toBe("PENDING");

      // Verify customer debt balance was updated in Dexie (100000 + 700000 = 800000.0000)
      const updatedCustomer = await db.cachedCustomers.get("cust-real-1");
      expect(updatedCustomer?.cachedBalanceDebtSYP).toBe("800000.0000");
    });
  });
});
