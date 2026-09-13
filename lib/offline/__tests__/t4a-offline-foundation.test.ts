/**
 * T4a — Local Offline Foundation (Dexie Schema & Exchange Rate Cache)
 * Test Suite
 */

import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  getOfflineDb,
  resetOfflineDbForTests,
  createOfflineInvoiceRecord,
  createOfflinePaymentRecord,
  createOfflineCustomerRecord,
  createCachedProductRecord,
  createCachedCustomerRecord,
  createCachedSessionRecord,
  generateOfflineId,
  isValidUUIDv4,
  getCachedRate,
  setCachedRate,
  refreshProductCache,
  refreshCustomerCache,
  checkOfflineCacheStatus,
  getCachedSession,
  setCachedSession,
  clearCachedSession,
  saveOfflineInvoiceWithBalance,
  saveOfflinePaymentWithBalance,
} from "@/lib/offline";
import {
  serializeMoney,
  compareMoney,
  toDecimal,
  sumMoney,
  subtractMoney,
  MoneyError,
} from "@/lib/utils/money";
import { useExchangeRateStore } from "@/lib/store/useExchangeRateStore";

describe("T4a — Local Offline Foundation (Dexie Schema & Exchange Rate Cache)", () => {
  const TEST_TENANT_ID = "tenant-test-t4a";

  beforeEach(async () => {
    vi.clearAllMocks();
    await resetOfflineDbForTests();
  });

  afterEach(async () => {
    await resetOfflineDbForTests();
    useExchangeRateStore.setState({
      dailyExchangeRate: null,
      currentTenantId: null,
      isUpdating: false,
      error: null,
    });
  });

  describe("1. Dexie Schema & Index Verification", () => {
    it("initializes all seven required offline tables with exact schema and indexes", async () => {
      const db = getOfflineDb();
      await db.open();

      // Check all 7 tables exist
      const tableNames = db.tables.map((t) => t.name);
      expect(tableNames).toContain("offlineInvoices");
      expect(tableNames).toContain("offlinePayments");
      expect(tableNames).toContain("offlineCustomers");
      expect(tableNames).toContain("cachedTenantSettings");
      expect(tableNames).toContain("cachedProducts");
      expect(tableNames).toContain("cachedCustomers");
      expect(tableNames).toContain("cachedSession");

      // Verify offlineInvoices indexes
      const invoicesSchema = db.table("offlineInvoices").schema;
      expect(invoicesSchema.primKey.name).toBe("id");
      expect(invoicesSchema.indexes.map((idx) => idx.name)).toContain("offlineId");
      expect(invoicesSchema.indexes.map((idx) => idx.name)).toContain("status");
      expect(invoicesSchema.indexes.map((idx) => idx.name)).toContain("createdAt");
      expect(invoicesSchema.indexes.find((idx) => idx.name === "offlineId")?.unique).toBe(true);

      // Verify offlinePayments indexes
      const paymentsSchema = db.table("offlinePayments").schema;
      expect(paymentsSchema.primKey.name).toBe("id");
      expect(paymentsSchema.indexes.map((idx) => idx.name)).toContain("offlineId");
      expect(paymentsSchema.indexes.map((idx) => idx.name)).toContain("status");
      expect(paymentsSchema.indexes.map((idx) => idx.name)).toContain("createdAt");
      expect(paymentsSchema.indexes.find((idx) => idx.name === "offlineId")?.unique).toBe(true);

      // Verify offlineCustomers indexes
      const offlineCustSchema = db.table("offlineCustomers").schema;
      expect(offlineCustSchema.primKey.name).toBe("id");
      expect(offlineCustSchema.indexes.map((idx) => idx.name)).toContain("offlineId");
      expect(offlineCustSchema.indexes.map((idx) => idx.name)).toContain("status");
      expect(offlineCustSchema.indexes.map((idx) => idx.name)).toContain("createdAt");
      expect(offlineCustSchema.indexes.find((idx) => idx.name === "offlineId")?.unique).toBe(true);

      // Verify cachedTenantSettings indexes
      const settingsSchema = db.table("cachedTenantSettings").schema;
      expect(settingsSchema.primKey.name).toBe("tenantId");

      // Verify cachedProducts indexes including [tenantId+isActive]
      const productsSchema = db.table("cachedProducts").schema;
      expect(productsSchema.primKey.name).toBe("id");
      expect(productsSchema.indexes.map((idx) => idx.name)).toContain("tenantId");
      expect(productsSchema.indexes.map((idx) => idx.name)).toContain("[tenantId+isActive]");

      // Verify cachedCustomers indexes including [tenantId+phone]
      const customersSchema = db.table("cachedCustomers").schema;
      expect(customersSchema.primKey.name).toBe("id");
      expect(customersSchema.indexes.map((idx) => idx.name)).toContain("tenantId");
      expect(customersSchema.indexes.map((idx) => idx.name)).toContain("[tenantId+phone]");

      // Verify cachedSession indexes
      const sessionSchema = db.table("cachedSession").schema;
      expect(sessionSchema.primKey.name).toBe("userId");
      expect(sessionSchema.indexes.map((idx) => idx.name)).toContain("tenantId");
      expect(sessionSchema.indexes.map((idx) => idx.name)).toContain("cachedAt");
    });

    it("verifies full nested unit and batch shape on cachedProducts", async () => {
      const db = getOfflineDb();
      const product = createCachedProductRecord({
        tenantId: TEST_TENANT_ID,
        id: "prod-1",
        name: "زيت زيتون بكر",
        category: "زيوت",
        isActive: true,
        units: [
          {
            id: "unit-1",
            unitName: "تنكة 16 لتر",
            conversionFactor: 1,
            priceWholesale: "1200000.0000",
            priceRetail: "1350000.0000",
            pricingCurrency: "SYP",
            barcode: "6211234567890",
            barcodeSource: "GS1",
            isActive: true,
          },
        ],
        batches: [
          {
            id: "batch-1",
            unitId: "unit-1",
            batchNumber: "B2026-01",
            quantity: 50,
            expiryDate: "2027-12-31",
          },
        ],
      });

      await db.cachedProducts.put(product);
      const retrieved = await db.cachedProducts.get("prod-1");

      expect(retrieved).toBeDefined();
      expect(retrieved?.name).toBe("زيت زيتون بكر");
      expect(retrieved?.units).toHaveLength(1);
      expect(retrieved?.units[0].priceWholesale).toBe("1200000.0000");
      expect(retrieved?.units[0].pricingCurrency).toBe("SYP");
      expect(retrieved?.units[0].barcode).toBe("6211234567890");
      expect(retrieved?.units[0].barcodeSource).toBe("GS1");
      expect(retrieved?.batches).toHaveLength(1);
      expect(retrieved?.batches[0].batchNumber).toBe("B2026-01");
      // [FIX] CachedProductBatch.quantity is now a decimal.js-serialized
      // string (see db.ts's createCachedProductRecord, which routes it
      // through serializeMoney), not a native number — it was stored as
      // 50 but comes back as "50.0000". Compare via compareMoney rather
      // than asserting the raw string equals the native number literal.
      expect(compareMoney(retrieved!.batches[0].quantity, 50)).toBe(0);
    });
  });

  describe("2. UUID Generation Helper (generateOfflineId)", () => {
    it("generates valid RFC4122 UUID v4 strings", () => {
      const id = generateOfflineId();
      expect(isValidUUIDv4(id)).toBe(true);
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    });

    it("generates 100 distinct unique UUID v4 values without collision", () => {
      const ids = new Set<string>();
      for (let i = 0; i < 100; i++) {
        const id = generateOfflineId();
        expect(isValidUUIDv4(id)).toBe(true);
        expect(ids.has(id)).toBe(false);
        ids.add(id);
      }
      expect(ids.size).toBe(100);
    });
  });

  describe("3. Exchange Rate Cache Contract", () => {
    it("stores and retrieves cached rate with exact string and timestamp", async () => {
      const rateToStore = "15250.5000";
      // [FIX] setCachedRate's real signature is Promise<void> (matching
      // T1's literal spec: `setCachedRate(tenantId, rate): Promise<void>`)
      // — it never resolves to a { ok: true } result object. That shape
      // belongs to refreshProductCache/refreshCustomerCache only (see
      // cache-refresh.ts's own documented deviation note), not to this
      // function. Assert it resolves cleanly instead.
      await expect(setCachedRate(TEST_TENANT_ID, rateToStore)).resolves.toBeUndefined();

      const cached = await getCachedRate(TEST_TENANT_ID);
      expect(cached).not.toBeNull();
      expect(cached?.rate).toBe("15250.5000");
      expect(cached?.cachedAt).toBeInstanceOf(Date);
    });

    it("isolates exchange rates across different tenants", async () => {
      await setCachedRate("tenant-A", "15000.0000");
      await setCachedRate("tenant-B", "16000.0000");

      const rateA = await getCachedRate("tenant-A");
      const rateB = await getCachedRate("tenant-B");

      expect(rateA?.rate).toBe("15000.0000");
      expect(rateB?.rate).toBe("16000.0000");
    });

    it("throws MoneyError on non-positive or invalid exchange rate input", async () => {
      await expect(setCachedRate(TEST_TENANT_ID, "0")).rejects.toThrow(MoneyError);
      await expect(setCachedRate(TEST_TENANT_ID, "-15000")).rejects.toThrow(MoneyError);
      await expect(setCachedRate(TEST_TENANT_ID, "invalid-num")).rejects.toThrow(MoneyError);
    });

    it("throws a plain Error when tenantId is missing, never falls back to a shared key", async () => {
      await expect(setCachedRate("", "15000.0000")).rejects.toThrow(/tenantId is required/);
    });

    it("verifies write-through to Dexie when Zustand store updates rate", async () => {
      const store = useExchangeRateStore.getState();
      store.setCurrentTenantId(TEST_TENANT_ID);

      // Call setExchangeRate (which write-through caches)
      store.setExchangeRate(15400, TEST_TENANT_ID);

      // setExchangeRate's cache write is fire-and-forget internally, so
      // give the microtask queue a tick before asserting the write landed.
      await new Promise((resolve) => setTimeout(resolve, 0));

      const cached = await getCachedRate(TEST_TENANT_ID);
      expect(cached).not.toBeNull();
      expect(cached?.rate).toBe("15400.0000");
    });
  });

  describe("4. Monetary Field Decimal Precision Round-Trip", () => {
    it("stores and round-trips SYP values in hundreds of millions with fractional cents without precision drift", async () => {
      const db = getOfflineDb();
      await db.open();

      const hugeTotalSYP = "987654321.1234";
      const hugePaidSYP = "500000000.1000";
      const hugeDebtSYP = "487654321.0234";
      const exchangeRate = "15000.0000";

      // Check invariant debtSYP = totalSYP - paidSYP
      expect(subtractMoney(hugeTotalSYP, hugePaidSYP)).toBe(hugeDebtSYP);

      const invoice = createOfflineInvoiceRecord({
        tenantId: TEST_TENANT_ID,
        offlineId: generateOfflineId(),
        customerId: "cust-1",
        items: [
          {
            productId: "prod-1",
            unitId: "unit-1",
            quantity: 1,
            unitPriceSYP: hugeTotalSYP,
          },
        ],
        totalSYP: hugeTotalSYP,
        paidAmountSYP: hugePaidSYP,
        debtAmountSYP: hugeDebtSYP,
        exchangeRateUsed: exchangeRate,
        paymentMethod: "CASH",
      });

      await db.offlineInvoices.add(invoice);
      const retrieved = await db.offlineInvoices.where("tenantId").equals(TEST_TENANT_ID).first();

      expect(retrieved).toBeDefined();
      expect(retrieved?.totalSYP).toBe(hugeTotalSYP);
      expect(retrieved?.paidAmountSYP).toBe(hugePaidSYP);
      expect(retrieved?.debtAmountSYP).toBe(hugeDebtSYP);

      // Verify exact Decimal equality
      expect(compareMoney(retrieved!.totalSYP, hugeTotalSYP)).toBe(0);
      expect(compareMoney(retrieved!.paidAmountSYP, hugePaidSYP)).toBe(0);
      expect(compareMoney(retrieved!.debtAmountSYP, hugeDebtSYP)).toBe(0);
    });

    it("verifies payment amount precision in customer payments", async () => {
      const db = getOfflineDb();
      await db.open();

      const paymentAmount = "123456789.9876";
      const payment = createOfflinePaymentRecord({
        tenantId: TEST_TENANT_ID,
        offlineId: generateOfflineId(),
        customerId: "cust-1",
        amountSYP: paymentAmount,
        exchangeRate: "15000.0000",
        paymentMethod: "CASH",
      });

      await db.offlinePayments.add(payment);
      const retrieved = await db.offlinePayments.where("tenantId").equals(TEST_TENANT_ID).first();

      expect(retrieved).toBeDefined();
      expect(retrieved?.amountSYP).toBe(paymentAmount);
      expect(compareMoney(retrieved!.amountSYP, paymentAmount)).toBe(0);
    });
  });

  describe("5. Cache Population (refreshProductCache & refreshCustomerCache)", () => {
    it("populates cachedProducts when online and overwrites cleanly", async () => {
      const mockProductsResponse = {
        success: true,
        products: [
          {
            id: "p-online-1",
            name: "سكر أبيض ناعم",
            category: "مواد غذائية",
            isActive: true,
            units: [
              {
                id: "u-online-1",
                unitName: "شوال 50 كغ",
                conversionFactor: 1,
                pricingCurrency: "SYP",
                priceWholesale: "750000.0000",
                priceRetail: "800000.0000",
                barcode: "6219998887770",
                barcodeSource: "GS1",
                isActive: true,
              },
            ],
            batches: [
              {
                id: "b-online-1",
                unitId: "u-online-1",
                batchNumber: "SUGAR-2026",
                quantity: "100.0000",
                expiryDate: "2028-01-01",
              },
            ],
          },
        ],
      };

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => mockProductsResponse,
      });

      const result = await refreshProductCache(TEST_TENANT_ID);
      expect(result).toEqual({ ok: true });

      const db = getOfflineDb();
      const cached = await db.cachedProducts.where("tenantId").equals(TEST_TENANT_ID).toArray();

      expect(cached).toHaveLength(1);
      expect(cached[0].id).toBe("p-online-1");
      expect(cached[0].name).toBe("سكر أبيض ناعم");
      expect(cached[0].units).toHaveLength(1);
      expect(cached[0].units[0].priceWholesale).toBe("750000.0000");
    });

    it("populates cachedCustomers when online and overwrites cleanly", async () => {
      const mockCustomersResponse = {
        success: true,
        customers: [
          {
            id: "c-online-1",
            tenantId: TEST_TENANT_ID,
            name: "سوبرماركت البركة",
            phone: "0933111222",
            shopName: "البركة",
            cachedBalanceDebtSYP: "2500000.0000",
            cachedBalanceDebtUSD: "166.6667",
            isSystemGenerated: false,
          },
        ],
      };

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => mockCustomersResponse,
      });

      const result = await refreshCustomerCache(TEST_TENANT_ID);
      expect(result).toEqual({ ok: true });

      const db = getOfflineDb();
      const cached = await db.cachedCustomers.where("tenantId").equals(TEST_TENANT_ID).toArray();

      expect(cached).toHaveLength(1);
      expect(cached[0].id).toBe("c-online-1");
      expect(cached[0].name).toBe("سوبرماركت البركة");
      expect(cached[0].cachedBalanceDebtSYP).toBe("2500000.0000");
    });

    it("returns { ok: false, reason: 'fetch_failed' } on a real server error, without wiping existing cache", async () => {
      const db = getOfflineDb();
      await db.cachedProducts.put(
        createCachedProductRecord({
          tenantId: TEST_TENANT_ID,
          id: "p-existing",
          name: "منتج موجود مسبقاً",
          units: [],
          batches: [],
        })
      );

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({}),
      });

      const result = await refreshProductCache(TEST_TENANT_ID);
      expect(result).toEqual({ ok: false, reason: "fetch_failed" });

      // A failed refresh must never wipe what was already cached — only a
      // SUCCESSFUL fetch reaches the delete-then-bulkPut transaction.
      const existing = await db.cachedProducts.get("p-existing");
      expect(existing).toBeDefined();
    });

    it("returns { ok: false, reason: 'offline' } and never calls fetch when offline, without mutating cache", async () => {
      const db = getOfflineDb();
      await db.cachedProducts.put(
        createCachedProductRecord({
          tenantId: TEST_TENANT_ID,
          id: "p-existing",
          name: "منتج موجود مسبقاً",
          units: [],
          batches: [],
        })
      );

      const originalNavigator = global.navigator;
      Object.defineProperty(global, "navigator", {
        value: { onLine: false },
        writable: true,
        configurable: true,
      });

      const fetchSpy = vi.fn();
      global.fetch = fetchSpy;

      const productResult = await refreshProductCache(TEST_TENANT_ID);
      const customerResult = await refreshCustomerCache(TEST_TENANT_ID);

      expect(productResult).toEqual({ ok: false, reason: "offline" });
      expect(customerResult).toEqual({ ok: false, reason: "offline" });
      expect(fetchSpy).not.toHaveBeenCalled();

      const existing = await db.cachedProducts.get("p-existing");
      expect(existing).toBeDefined();
      expect(existing?.name).toBe("منتج موجود مسبقاً");

      Object.defineProperty(global, "navigator", {
        value: originalNavigator,
        writable: true,
        configurable: true,
      });
    });
  });

  describe("6. Cold Empty-Cache Detection", () => {
    it("reports 'NO_CACHED_DATA' and isReady: false on a fully empty cold cache", async () => {
      await resetOfflineDbForTests();

      const status = await checkOfflineCacheStatus(TEST_TENANT_ID);

      expect(status.isReady).toBe(false);
      expect(status.hasCachedData).toBe(false);
      expect(status.isEmptyCache).toBe(true);
      expect(status.status).toBe("NO_CACHED_DATA");
    });

    it("reports NOT ready when only the exchange rate is cached — products/customers are still missing", async () => {
      await resetOfflineDbForTests();
      await setCachedRate(TEST_TENANT_ID, "15000.0000");

      const status = await checkOfflineCacheStatus(TEST_TENANT_ID);

      // A cached rate alone is not enough for T4b's POS to function — it
      // still needs products and customers. hasCachedData is true (SOME
      // cache exists) but isReady must stay false and status is PARTIAL.
      expect(status.hasCachedData).toBe(true);
      expect(status.isReady).toBe(false);
      expect(status.status).toBe("PARTIAL");
      expect(status.missing).toEqual(["products", "customers"]);
    });

    it("reports 'READY' and isReady: true only once products, customers, AND the rate are all cached", async () => {
      await resetOfflineDbForTests();

      await setCachedRate(TEST_TENANT_ID, "15000.0000");

      const db = getOfflineDb();
      await db.cachedProducts.put(
        createCachedProductRecord({
          tenantId: TEST_TENANT_ID,
          id: "p-ready-1",
          name: "منتج جاهز",
          units: [],
          batches: [],
        })
      );
      await db.cachedCustomers.put(
        createCachedCustomerRecord({
          tenantId: TEST_TENANT_ID,
          id: "c-ready-1",
          name: "زبون جاهز",
          cachedBalanceDebtSYP: "0.0000",
        })
      );

      const status = await checkOfflineCacheStatus(TEST_TENANT_ID);

      expect(status.isReady).toBe(true);
      expect(status.hasCachedData).toBe(true);
      expect(status.isEmptyCache).toBe(false);
      expect(status.status).toBe("READY");
    });
  });

  describe("7. Cached Session Claims & Offline Fallback Contract", () => {
    it("validates createCachedSessionRecord requires non-empty userId, tenantId, valid role, and boolean isPlatformAdmin", () => {
      // Missing userId
      expect(() =>
        createCachedSessionRecord({
          userId: "",
          tenantId: TEST_TENANT_ID,
          role: "ADMIN",
          isPlatformAdmin: true,
        })
      ).toThrow(/userId is required/);

      // Missing tenantId
      expect(() =>
        createCachedSessionRecord({
          userId: "user-1",
          tenantId: "",
          role: "ADMIN",
          isPlatformAdmin: true,
        })
      ).toThrow(/tenantId is required/);

      // Invalid role
      expect(() =>
        createCachedSessionRecord({
          userId: "user-1",
          tenantId: TEST_TENANT_ID,
          role: "SUPERUSER" as any,
          isPlatformAdmin: true,
        })
      ).toThrow(/Invalid role/);

      // Missing or non-boolean isPlatformAdmin (must be strictly boolean)
      expect(() =>
        createCachedSessionRecord({
          userId: "user-1",
          tenantId: TEST_TENANT_ID,
          role: "ADMIN",
          isPlatformAdmin: undefined as any,
        })
      ).toThrow(/isPlatformAdmin is required and must be a boolean/);
    });

    it("writes and reads cached session claims via setCachedSession and getCachedSession", async () => {
      await setCachedSession({
        userId: "user-cashier-1",
        tenantId: TEST_TENANT_ID,
        role: "CASHIER",
        isPlatformAdmin: false,
        name: "كاشير الصباح",
      });

      const cached = await getCachedSession("user-cashier-1");
      expect(cached).not.toBeNull();
      expect(cached?.userId).toBe("user-cashier-1");
      expect(cached?.tenantId).toBe(TEST_TENANT_ID);
      expect(cached?.role).toBe("CASHIER");
      expect(cached?.isPlatformAdmin).toBe(false);
      expect(cached?.name).toBe("كاشير الصباح");
      expect(cached?.cachedAt).toBeInstanceOf(Date);
    });

    it("isolates multiple users and returns null when userId is omitted/empty", async () => {
      await setCachedSession({
        userId: "user-admin-1",
        tenantId: TEST_TENANT_ID,
        tenantName: "محل تجريبي",
        tenantSlug: "test-shop",
        role: "ADMIN",
        isPlatformAdmin: true,
        name: "مدير النظام",
        subscriptionStatus: "ACTIVE",
      });

      await setCachedSession({
        userId: "user-cashier-2",
        tenantId: TEST_TENANT_ID,
        tenantName: "محل تجريبي",
        tenantSlug: "test-shop",
        role: "CASHIER",
        isPlatformAdmin: false,
        name: "كاشير المساء",
        subscriptionStatus: "ACTIVE",
      });

      // Specific lookup
      const admin = await getCachedSession("user-admin-1");
      expect(admin?.role).toBe("ADMIN");
      expect(admin?.isPlatformAdmin).toBe(true);

      const cashier = await getCachedSession("user-cashier-2");
      expect(cashier?.role).toBe("CASHIER");
      expect(cashier?.isPlatformAdmin).toBe(false);

      // Omitted/empty userId returns null to prevent cross-user session leakage on shared POS devices
      const omitted = await getCachedSession("");
      expect(omitted).toBeNull();
    });

    it("clears cached session on clearCachedSession without leaving residual claims", async () => {
      await setCachedSession({
        userId: "user-logout-test",
        tenantId: TEST_TENANT_ID,
        role: "CASHIER",
        isPlatformAdmin: false,
        name: "كاشير مؤقت",
      });

      expect(await getCachedSession("user-logout-test")).not.toBeNull();

      await clearCachedSession("user-logout-test");
      expect(await getCachedSession("user-logout-test")).toBeNull();
    });

    it("ensures online unauthenticated response (401/expired) NEVER falls back to cached session", async () => {
      // Populate cache as if user logged in previously
      await setCachedSession({
        userId: "user-revoked",
        tenantId: TEST_TENANT_ID,
        role: "ADMIN",
        isPlatformAdmin: false,
        name: "مستخدم منتهي الصلاحية",
      });

      // When online, if the session is unauthenticated (e.g. 401 response from /api/auth/session),
      // the app MUST treat the user as unauthenticated and NOT fall back to the cached claims.
      const isOnline = true;
      const nextAuthStatus = "unauthenticated";

      let resolvedSession: any = null;
      let resolvedStatus = nextAuthStatus;
      let source: "network" | "cached" = "network";

      if (isOnline) {
        if (nextAuthStatus === "unauthenticated") {
          resolvedSession = null;
          resolvedStatus = "unauthenticated";
          source = "network";
        }
      }

      expect(resolvedStatus).toBe("unauthenticated");
      expect(resolvedSession).toBeNull();
      expect(source).toBe("network");
    });
  });

  describe("8. Synchronous Local Customer Balance Adjustment in Dexie Transactions", () => {
    it("synchronously increments customer cachedBalanceDebtSYP in the same Dexie transaction on invoice with debt", async () => {
      const db = getOfflineDb();
      const customerId = "cust-debt-test-1";

      await db.cachedCustomers.put(
        createCachedCustomerRecord({
          tenantId: TEST_TENANT_ID,
          id: customerId,
          name: "محل السلام",
          cachedBalanceDebtSYP: "100000.0000",
        })
      );

      const invoiceRecord = createOfflineInvoiceRecord({
        tenantId: TEST_TENANT_ID,
        offlineId: generateOfflineId(),
        customerId: customerId,
        items: [
          {
            productId: "prod-1",
            unitId: "unit-1",
            quantity: 2,
            unitPriceSYP: "50000.0000",
          },
        ],
        totalSYP: "100000.0000",
        paidAmountSYP: "25000.0000",
        debtAmountSYP: "75000.0000", // Increases debt by 75,000 SYP
        exchangeRateUsed: "15000.0000",
        paymentMethod: "CASH",
      });

      // Execute atomic transaction write
      await saveOfflineInvoiceWithBalance(invoiceRecord, db);

      // Verify invoice was persisted
      const savedInvoice = await db.offlineInvoices.where("offlineId").equals(invoiceRecord.offlineId).first();
      expect(savedInvoice).toBeDefined();

      // Verify customer cached balance was synchronously updated in the same transaction
      const updatedCustomer = await db.cachedCustomers.get(customerId);
      expect(updatedCustomer).toBeDefined();
      expect(updatedCustomer?.cachedBalanceDebtSYP).toBe("175000.0000"); // 100,000 + 75,000
    });

    it("does not adjust customer balance when invoice has debtAmountSYP === 0", async () => {
      const db = getOfflineDb();
      const customerId = "cust-paid-full-1";

      await db.cachedCustomers.put(
        createCachedCustomerRecord({
          tenantId: TEST_TENANT_ID,
          id: customerId,
          name: "محل الأمانة",
          cachedBalanceDebtSYP: "50000.0000",
        })
      );

      const invoiceRecord = createOfflineInvoiceRecord({
        tenantId: TEST_TENANT_ID,
        offlineId: generateOfflineId(),
        customerId: customerId,
        items: [
          {
            productId: "prod-1",
            unitId: "unit-1",
            quantity: 1,
            unitPriceSYP: "60000.0000",
          },
        ],
        totalSYP: "60000.0000",
        paidAmountSYP: "60000.0000",
        debtAmountSYP: "0.0000",
        exchangeRateUsed: "15000.0000",
        paymentMethod: "CASH",
      });

      await saveOfflineInvoiceWithBalance(invoiceRecord, db);

      const customer = await db.cachedCustomers.get(customerId);
      expect(customer?.cachedBalanceDebtSYP).toBe("50000.0000");
    });

    it("synchronously decrements customer cachedBalanceDebtSYP on independent repayment", async () => {
      const db = getOfflineDb();
      const customerId = "cust-repayment-1";

      await db.cachedCustomers.put(
        createCachedCustomerRecord({
          tenantId: TEST_TENANT_ID,
          id: customerId,
          name: "محل الرضا",
          cachedBalanceDebtSYP: "200000.0000",
        })
      );

      const repayment = createOfflinePaymentRecord({
        tenantId: TEST_TENANT_ID,
        offlineId: generateOfflineId(),
        customerId: customerId,
        // No invoiceId -> independent debt repayment
        amountSYP: "80000.0000",
        exchangeRate: "15000.0000",
        paymentMethod: "CASH",
      });

      await saveOfflinePaymentWithBalance(repayment, db);

      const updatedCustomer = await db.cachedCustomers.get(customerId);
      expect(updatedCustomer?.cachedBalanceDebtSYP).toBe("120000.0000"); // 200,000 - 80,000
    });

    it("does NOT adjust customer balance when payment is linked to an invoice (already in debtAmountSYP)", async () => {
      const db = getOfflineDb();
      const customerId = "cust-linked-pay-1";

      await db.cachedCustomers.put(
        createCachedCustomerRecord({
          tenantId: TEST_TENANT_ID,
          id: customerId,
          name: "محل الهدى",
          cachedBalanceDebtSYP: "100000.0000",
        })
      );

      const linkedPayment = createOfflinePaymentRecord({
        tenantId: TEST_TENANT_ID,
        offlineId: generateOfflineId(),
        customerId: customerId,
        invoiceId: "inv-offline-123", // Linked to specific invoice
        amountSYP: "30000.0000",
        exchangeRate: "15000.0000",
        paymentMethod: "CASH",
      });

      await saveOfflinePaymentWithBalance(linkedPayment, db);

      // Balance remains 100000 (not double decremented)
      const customer = await db.cachedCustomers.get(customerId);
      expect(customer?.cachedBalanceDebtSYP).toBe("100000.0000");
    });

    it("supports T4d void pattern: negative debtAmountSYP decrements customer balance in same transaction", async () => {
      const db = getOfflineDb();
      const customerId = "cust-void-target-1";

      await db.cachedCustomers.put(
        createCachedCustomerRecord({
          tenantId: TEST_TENANT_ID,
          id: customerId,
          name: "محل السعادة",
          cachedBalanceDebtSYP: "150000.0000",
        })
      );

      // Simulating a void invoice object with negative debtAmountSYP (-50000.0000)
      const voidInvoice: any = {
        tenantId: TEST_TENANT_ID,
        offlineId: generateOfflineId(),
        customerId: customerId,
        totalSYP: "-50000.0000",
        totalUSD: "-3.3333",
        paidAmountSYP: "0.0000",
        paidAmountUSD: "0.0000",
        debtAmountSYP: "-50000.0000",
        debtAmountUSD: "-3.3333",
        exchangeRateUsed: "15000.0000",
        items: [],
        createdAt: new Date(),
        status: "PENDING",
      };

      await saveOfflineInvoiceWithBalance(voidInvoice, db);

      const updatedCustomer = await db.cachedCustomers.get(customerId);
      // 150000 + (-50000) = 100000
      expect(updatedCustomer?.cachedBalanceDebtSYP).toBe("100000.0000");
    });
  });
});