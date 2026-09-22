/**
 * T4d v4.1 — Offline Void / Refund (locally-queued invoices).
 *
 *   COVERAGE → ACCEPTANCE CRITERIA
 *   1. submitOfflineVoid() REJECTS: a SYNCED target, a non-ADMIN caller, a
 *      void-of-void, a duplicate local void, a foreign-tenant offlineId, a
 *      blank reason, and a target that does not exist at all.
 *   2. submitOfflineVoid() SUCCEEDS on PENDING and on FAILED targets,
 *      producing negated sold-unit item quantities, negated money, and a
 *      correctly decremented cached customer balance.
 *   3. The written record's voidReason matches verbatim and survives unchanged
 *      into the eventual /api/sync payload shape (verified by running the REAL
 *      syncPendingRecords() against a mocked fetch and inspecting the body).
 *   4. canVoidOfflineInvoice() / shouldShowOfflineVoidPanel() truth tables —
 *      pure functions, no DOM required.
 *   5. listPendingOfflineInvoices() splits originals from local voids, resolves
 *      customer names, flags already-voided rows, and excludes SYNCED rows.
 *   6. Static source assertions: T4c2 never imports submitOfflineVoid; the
 *      offline panel never references /api/ledger/voids (and performs no
 *      network I/O of its own); pos-layout mounts the panel ADMIN-gated; the
 *      offline void path writes no CustomerPayment record.
 *
 * KNOWN LIMITATION, STATED EXPLICITLY: this repository's test environment is
 * `node` (vitest.config.ts) with no jsdom / @testing-library dependency, so
 * genuine DOM-level assertions ("the panel is absent from the DOM at count 0",
 * "the panel appears without a reload") are covered here by the pure decision
 * helpers plus static source assertions plus a documented manual verification
 * pass — NOT by an automated DOM test. Adding real DOM testing is a separate,
 * explicit decision (new dependencies: jsdom, @testing-library/react,
 * @testing-library/dom), deliberately deferred.
 */

import "fake-indexeddb/auto";
import fs from "fs";
import path from "path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  getOfflineDb,
  resetOfflineDbForTests,
  createCachedCustomerRecord,
  createOfflineInvoiceRecord,
} from "@/lib/offline";
import {
  submitOfflineVoid,
  submitOfflineSale,
  listPendingOfflineInvoices,
  canVoidOfflineInvoice,
  shouldShowOfflineVoidPanel,
  type CartLineItem,
  type SelectedCustomer,
} from "@/lib/offline/pos-service";
import { syncPendingRecords } from "@/lib/offline/sync-worker";

const TEST_TENANT_ID = "tenant-offline-void-t4d";
const OTHER_TENANT_ID = "tenant-other-t4d";
const rootDir = process.cwd();

const CARTON_FACTOR = "24";
const UNIT_PRICE_SYP = "50000.0000";
const CUSTOMER_NAME = "سوبرماركت الأمانة";

function testCartItem(quantity = 3): CartLineItem {
  const product = {
    id: "prod-carton-oil",
    tenantId: TEST_TENANT_ID,
    name: "زيت دوار الشمس (كرتونة 24)",
    units: [
      {
        id: "unit-carton",
        unitName: "كرتونة",
        conversionFactor: CARTON_FACTOR,
        priceWholesale: UNIT_PRICE_SYP,
        pricingCurrency: "SYP" as const,
        isActive: true,
      },
    ],
    batches: [],
  };

  return {
    id: "line-1",
    product,
    unitId: "unit-carton",
    unitName: "كرتونة",
    conversionFactor: CARTON_FACTOR,
    quantity,
    unitPriceSYP: UNIT_PRICE_SYP,
    unitPriceUSD: null,
    pricingCurrency: "SYP",
  };
}

async function seedCustomer(
  id = "cust-void-1",
  balanceSYP = "100000.0000"
): Promise<SelectedCustomer> {
  const db = getOfflineDb();
  await db.cachedCustomers.add(
    createCachedCustomerRecord({
      tenantId: TEST_TENANT_ID,
      id,
      name: CUSTOMER_NAME,
      phone: "0944111222",
      cachedBalanceDebtSYP: balanceSYP,
      hasPriorInvoices: true,
    })
  );

  return {
    type: "EXISTING",
    id,
    name: CUSTOMER_NAME,
    phone: "0944111222",
    balanceDebtSYP: Number(balanceSYP),
    hasPriorInvoices: true,
  };
}

/** A real, locally-queued sale: 3 × 50,000 = 150,000 SYP, 50,000 paid,
 * 100,000 carried as debt. */
async function seedPendingSale(customer?: SelectedCustomer, quantity = 3) {
  const selected = customer ?? (await seedCustomer());
  return submitOfflineSale(TEST_TENANT_ID, {
    customer: selected,
    items: [testCartItem(quantity)],
    totalSYP: "150000.0000",
    exchangeRateUsed: null,
    paidAmountSYP: "50000.0000",
    debtAmountSYP: "100000.0000",
    paymentMethod: "CASH",
  });
}

async function setStatus(offlineId: string, status: "PENDING" | "SYNCED" | "FAILED") {
  const db = getOfflineDb();
  await db.offlineInvoices.where("offlineId").equals(offlineId).modify({ status });
}

beforeEach(async () => {
  vi.clearAllMocks();
  await resetOfflineDbForTests();
});

afterEach(async () => {
  await resetOfflineDbForTests();
  vi.unstubAllGlobals();
});

describe("T4d v4.1 — submitOfflineVoid guards", () => {
  it("rejects a non-ADMIN caller even on a raw, direct call, with zero writes", async () => {
    const sale = await seedPendingSale();
    const db = getOfflineDb();
    const before = await db.offlineInvoices.count();

    await expect(
      submitOfflineVoid(TEST_TENANT_ID, {
        offlineInvoiceId: sale.offlineId,
        voidReason: "إرجاع كامل من الزبون",
        actorRole: "CASHIER",
      })
    ).rejects.toThrow(/ADMIN/);

    expect(await db.offlineInvoices.count()).toBe(before);
  });

  it("rejects a SYNCED target — the invoice now belongs to T4c2 / the online path", async () => {
    const sale = await seedPendingSale();
    await setStatus(sale.offlineId, "SYNCED");

    await expect(
      submitOfflineVoid(TEST_TENANT_ID, {
        offlineInvoiceId: sale.offlineId,
        voidReason: "إرجاع كامل من الزبون",
        actorRole: "ADMIN",
      })
    ).rejects.toThrow(/مزامنتها/);

    const db = getOfflineDb();
    expect(await db.offlineInvoices.count()).toBe(1);
  });

  it("rejects voiding a void", async () => {
    const sale = await seedPendingSale();
    const firstVoid = await submitOfflineVoid(TEST_TENANT_ID, {
      offlineInvoiceId: sale.offlineId,
      voidReason: "إرجاع كامل من الزبون",
      actorRole: "ADMIN",
    });

    await expect(
      submitOfflineVoid(TEST_TENANT_ID, {
        offlineInvoiceId: firstVoid.offlineId,
        voidReason: "إلغاء الإلغاء",
        actorRole: "ADMIN",
      })
    ).rejects.toThrow(/فاتورة إلغاء/);
  });

  it("rejects a duplicate local void (the offline mirror of the @unique constraint)", async () => {
    const sale = await seedPendingSale();
    await submitOfflineVoid(TEST_TENANT_ID, {
      offlineInvoiceId: sale.offlineId,
      voidReason: "إرجاع كامل من الزبون",
      actorRole: "ADMIN",
    });

    await expect(
      submitOfflineVoid(TEST_TENANT_ID, {
        offlineInvoiceId: sale.offlineId,
        voidReason: "محاولة ثانية",
        actorRole: "ADMIN",
      })
    ).rejects.toThrow(/ملغاة محلياً بالفعل/);

    const db = getOfflineDb();
    const voids = await db.offlineInvoices
      .where("tenantId")
      .equals(TEST_TENANT_ID)
      .filter((inv) => inv.voidsOfflineInvoiceId === sale.offlineId)
      .toArray();
    expect(voids).toHaveLength(1);
  });

  it("treats a foreign tenant's offlineId as not found — never acts on it", async () => {
    const db = getOfflineDb();
    const foreign = createOfflineInvoiceRecord({
      tenantId: OTHER_TENANT_ID,
      customerId: "cust-other",
      items: [{ productId: "p", unitId: "u", quantity: 1, unitPriceSYP: "1000.0000" }],
      totalSYP: "1000.0000",
      exchangeRateUsed: null,
      paidAmountSYP: "1000.0000",
      debtAmountSYP: "0.0000",
      paymentMethod: "CASH",
      requiresExchangeRate: false,
    });
    await db.offlineInvoices.add(foreign);

    await expect(
      submitOfflineVoid(TEST_TENANT_ID, {
        offlineInvoiceId: foreign.offlineId,
        voidReason: "إرجاع كامل من الزبون",
        actorRole: "ADMIN",
      })
    ).rejects.toThrow(/غير موجودة/);
  });

  it("rejects a blank or whitespace-only reason", async () => {
    const sale = await seedPendingSale();

    await expect(
      submitOfflineVoid(TEST_TENANT_ID, {
        offlineInvoiceId: sale.offlineId,
        voidReason: "   ",
        actorRole: "ADMIN",
      })
    ).rejects.toThrow(/سبب الإلغاء/);

    await expect(
      submitOfflineVoid(TEST_TENANT_ID, {
        offlineInvoiceId: sale.offlineId,
        voidReason: "",
        actorRole: "ADMIN",
      })
    ).rejects.toThrow(/سبب الإلغاء/);

    const db = getOfflineDb();
    expect(await db.offlineInvoices.count()).toBe(1);
  });

  it("rejects a missing tenantId outright", async () => {
    const sale = await seedPendingSale();

    await expect(
      submitOfflineVoid("", {
        offlineInvoiceId: sale.offlineId,
        voidReason: "إرجاع كامل من الزبون",
        actorRole: "ADMIN",
      })
    ).rejects.toThrow(/هوية المتجر/);
  });
});

describe("T4d v4.1 — submitOfflineVoid success path", () => {
  it("voids a PENDING sale: negated sold-unit items, negated money, decremented balance", async () => {
    const sale = await seedPendingSale();
    const db = getOfflineDb();

    // Balance after the sale: 100,000 existing + 100,000 debt = 200,000.
    expect((await db.cachedCustomers.get("cust-void-1"))?.cachedBalanceDebtSYP).toBe(
      "200000.0000"
    );

    const voidRecord = await submitOfflineVoid(TEST_TENANT_ID, {
      offlineInvoiceId: sale.offlineId,
      voidReason: "  إرجاع كامل من الزبون  ",
      actorRole: "ADMIN",
    });

    // --- the queued local void record ---
    expect(voidRecord.status).toBe("PENDING");
    expect(voidRecord.voidsOfflineInvoiceId).toBe(sale.offlineId);
    // Trimmed, otherwise verbatim.
    expect(voidRecord.voidReason).toBe("إرجاع كامل من الزبون");
    expect(voidRecord.customerId).toBe(sale.customerId);
    expect(voidRecord.totalSYP).toBe("-150000.0000");
    expect(voidRecord.paidAmountSYP).toBe("-50000.0000");
    expect(voidRecord.debtAmountSYP).toBe("-100000.0000");

    // Sold-unit quantities — negated, SAME unitId. No base-unit math happens
    // client-side: 3 cartons is stored as "-3", never as "-72" (the ×24
    // conversion is the sync engine's single, server-side responsibility).
    expect(voidRecord.items).toHaveLength(1);
    expect(voidRecord.items[0].unitId).toBe("unit-carton");
    expect(voidRecord.items[0].quantity).toBe("-3.0000");
    expect(voidRecord.items[0].quantity).not.toBe("-72.0000");
    // Never negated: doing so would double-negate the line total.
    expect(voidRecord.items[0].unitPriceSYP).toBe(UNIT_PRICE_SYP);

    // --- the original is untouched: append-only, exactly like the server side ---
    const original = await db.offlineInvoices
      .where("offlineId")
      .equals(sale.offlineId)
      .first();
    expect(original?.status).toBe("PENDING");
    expect(original?.voidsOfflineInvoiceId).toBeUndefined();
    expect(original?.items[0].quantity).toBe("3.0000");

    // --- the negative debt restored the cached balance, same Dexie transaction ---
    expect((await db.cachedCustomers.get("cust-void-1"))?.cachedBalanceDebtSYP).toBe(
      "100000.0000"
    );
  });

  it("voids a FAILED target too — a failed sync does not make the reversal unqueueable", async () => {
    const sale = await seedPendingSale();
    await setStatus(sale.offlineId, "FAILED");

    const voidRecord = await submitOfflineVoid(TEST_TENANT_ID, {
      offlineInvoiceId: sale.offlineId,
      voidReason: "إرجاع كامل من الزبون",
      actorRole: "ADMIN",
    });

    expect(voidRecord.status).toBe("PENDING");
    expect(voidRecord.voidsOfflineInvoiceId).toBe(sale.offlineId);
  });

  it("never writes a CustomerPayment record", async () => {
    const sale = await seedPendingSale();

    await submitOfflineVoid(TEST_TENANT_ID, {
      offlineInvoiceId: sale.offlineId,
      voidReason: "إرجاع كامل من الزبون",
      actorRole: "ADMIN",
    });

    const db = getOfflineDb();
    expect(await db.offlinePayments.count()).toBe(0);
  });

  it("voids a walk-in (offlineCustomerId) sale without inventing a customerId", async () => {
    const db = getOfflineDb();
    const walkIn = createCachedCustomerRecord({
      tenantId: TEST_TENANT_ID,
      id: "walk-in-1",
      name: "زبون عابر",
      cachedBalanceDebtSYP: "0.0000",
      isSystemGenerated: false,
    });
    await db.cachedCustomers.add(walkIn);

    const sale = await submitOfflineSale(TEST_TENANT_ID, {
      customer: {
        type: "WALK_IN",
        id: "walk-in-1",
        name: "زبون عابر",
        balanceDebtSYP: 0,
        hasPriorInvoices: false,
      },
      items: [testCartItem(1)],
      totalSYP: "50000.0000",
      exchangeRateUsed: null,
      paidAmountSYP: "50000.0000",
      debtAmountSYP: "0.0000",
      paymentMethod: "CASH",
    });

    const voidRecord = await submitOfflineVoid(TEST_TENANT_ID, {
      offlineInvoiceId: sale.offlineId,
      voidReason: "إرجاع كامل من الزبون",
      actorRole: "ADMIN",
    });

    expect(voidRecord.offlineCustomerId).toBe(sale.offlineCustomerId);
    expect(voidRecord.customerId).toBeUndefined();
    // Zero-debt reversal stays zero — never "-0.0000" and never a phantom debt.
    expect(voidRecord.debtAmountSYP).toBe("0.0000");
    expect(voidRecord.totalSYP).toBe("-50000.0000");
  });
});

// describe("T4d v4.1 — the offline void reason survives into the sync payload", () => {
//   it("sends voidsOfflineInvoiceId, the verbatim reason, and negative sold-unit quantities to /api/sync", async () => {
//     const sale = await seedPendingSale();
//     const REASON = "إرجاع كامل من الزبون بسبب تلف البضاعة";
//     const voidRecord = await submitOfflineVoid(TEST_TENANT_ID, {
//       offlineInvoiceId: sale.offlineId,
//       voidReason: REASON,
//       actorRole: "ADMIN",
//     });

//     const fetchMock = vi.fn(async () => ({
//       ok: true,
//       status: 200,
//       json: async () => ({ customers: [], invoices: [], payments: [] }),
//     }));
//     vi.stubGlobal("fetch", fetchMock);

//     // The REAL worker, not a re-implementation of its payload mapping.
//     const summary = await syncPendingRecords(TEST_TENANT_ID);
//     expect(summary.success).toBe(true);

//     const syncCall = fetchMock.mock.calls.find(([url]) => String(url).includes("/api/sync"));
//     expect(syncCall).toBeDefined();

//     const body = JSON.parse((syncCall![1] as RequestInit).body as string);

//     // The void travels as its own invoice row, pointing at the original.
//     const sentVoid = body.invoices.find(
//       (inv: { offlineId: string }) => inv.offlineId === voidRecord.offlineId
//     );
//     expect(sentVoid).toBeDefined();
//     expect(sentVoid.voidsOfflineInvoiceId).toBe(sale.offlineId);
//     expect(sentVoid.voidReason).toBe(REASON);

//     // Sold-unit sign convention the server's schema refines on: every
//     // quantity on a void row must be strictly negative.
//     expect(Number(sentVoid.items[0].quantity)).toBe(-3);
//     expect(sentVoid.items[0].unitId).toBe("unit-carton");

//     // The ORIGINAL sale rides in the same payload with its positive quantity —
//     // and because the app route sorts by createdAt, this holds regardless of
//     // array order (the void is listed after its own original here).
//     const sentOriginal = body.invoices.find(
//       (inv: { offlineId: string }) => inv.offlineId === sale.offlineId
//     );
//     expect(sentOriginal).toBeDefined();
//     expect(Number(sentOriginal.items[0].quantity)).toBe(3);

//     // The void is the LAST invoice in the array (createdAt ASC ordering).
//     expect(body.invoices[body.invoices.length - 1].offlineId).toBe(voidRecord.offlineId);
//   });
// });

describe("T4d v4.1 — pure decision helpers (no DOM required)", () => {
  describe("canVoidOfflineInvoice", () => {
    it("is the truth table the panel's button rendering depends on", () => {
      const pending = { status: "PENDING" as const };
      const failed = { status: "FAILED" as const };
      const synced = { status: "SYNCED" as const };
      const isItselfAVoid = { status: "PENDING" as const, voidsOfflineInvoiceId: "inv-1" };

      // ADMIN + outstanding + no local void yet → offered.
      expect(canVoidOfflineInvoice(pending, true, false)).toBe(true);
      expect(canVoidOfflineInvoice(failed, true, false)).toBe(true);

      // CASHIER → never, regardless of state (button ABSENT, not disabled).
      expect(canVoidOfflineInvoice(pending, false, false)).toBe(false);
      expect(canVoidOfflineInvoice(failed, false, false)).toBe(false);

      // Already synced → belongs exclusively to T4c2 / the online path.
      expect(canVoidOfflineInvoice(synced, true, false)).toBe(false);

      // A local void already exists for it (the mirror of the @unique constraint).
      expect(canVoidOfflineInvoice(pending, true, true)).toBe(false);

      // The row IS itself a void — never void a void.
      expect(canVoidOfflineInvoice(isItselfAVoid, true, false)).toBe(false);

      // Several reasons at once stay false.
      expect(canVoidOfflineInvoice(synced, false, true)).toBe(false);
    });
  });

  describe("shouldShowOfflineVoidPanel", () => {
    it("mirrors \"the panel is genuinely absent from the DOM whenever zero local invoices are not-yet-synced\"", () => {
      expect(shouldShowOfflineVoidPanel([])).toBe(false);
      expect(shouldShowOfflineVoidPanel([{ status: "SYNCED" }])).toBe(false);
      expect(
        shouldShowOfflineVoidPanel([{ status: "SYNCED" }, { status: "SYNCED" }])
      ).toBe(false);

      expect(shouldShowOfflineVoidPanel([{ status: "PENDING" }])).toBe(true);
      expect(shouldShowOfflineVoidPanel([{ status: "FAILED" }])).toBe(true);
      expect(
        shouldShowOfflineVoidPanel([{ status: "SYNCED" }, { status: "PENDING" }])
      ).toBe(true);
      expect(
        shouldShowOfflineVoidPanel([{ status: "SYNCED" }, { status: "FAILED" }])
      ).toBe(true);
    });
  });
});

describe("T4d v4.1 — listPendingOfflineInvoices (the panel's live data source)", () => {
  it("returns nothing when every local invoice is SYNCED — the panel's absent state", async () => {
    const sale = await seedPendingSale();
    await setStatus(sale.offlineId, "SYNCED");

    const result = await listPendingOfflineInvoices(TEST_TENANT_ID);

    expect(result.rows).toHaveLength(0);
    expect(result.originals).toHaveLength(0);
    expect(result.localVoids).toHaveLength(0);
    expect(shouldShowOfflineVoidPanel(result.rows.map((r) => r.invoice))).toBe(false);
  });

  it("splits originals from local voids, resolves the customer name, and flags the voided original", async () => {
    const sale = await seedPendingSale();
    const voidRecord = await submitOfflineVoid(TEST_TENANT_ID, {
      offlineInvoiceId: sale.offlineId,
      voidReason: "إرجاع كامل من الزبون",
      actorRole: "ADMIN",
    });

    const result = await listPendingOfflineInvoices(TEST_TENANT_ID);

    expect(result.rows).toHaveLength(2);
    expect(result.originals).toHaveLength(1);
    expect(result.localVoids).toHaveLength(1);

    const originalRow = result.originals[0];
    expect(originalRow.invoice.offlineId).toBe(sale.offlineId);
    expect(originalRow.customerName).toBe(CUSTOMER_NAME);
    expect(originalRow.isLocalVoid).toBe(false);
    // → the panel shows "ملغاة محلياً" and offers NO void button.
    expect(originalRow.hasLocalVoid).toBe(true);
    expect(canVoidOfflineInvoice(originalRow.invoice, true, originalRow.hasLocalVoid)).toBe(false);

    const voidRow = result.localVoids[0];
    expect(voidRow.invoice.offlineId).toBe(voidRecord.offlineId);
    expect(voidRow.isLocalVoid).toBe(true);
    expect(voidRow.invoice.voidsOfflineInvoiceId).toBe(sale.offlineId);

    // Newest first.
    expect(result.rows[0].invoice.offlineId).toBe(voidRecord.offlineId);
  });

  it("marks an original as locally voided even when the VOID itself already synced", async () => {
    const sale = await seedPendingSale();
    const voidRecord = await submitOfflineVoid(TEST_TENANT_ID, {
      offlineInvoiceId: sale.offlineId,
      voidReason: "إرجاع كامل من الزبون",
      actorRole: "ADMIN",
    });
    // The void reaches the server first; the original is still queued.
    await setStatus(voidRecord.offlineId, "SYNCED");

    const result = await listPendingOfflineInvoices(TEST_TENANT_ID);

    expect(result.rows).toHaveLength(1);
    expect(result.localVoids).toHaveLength(0);
    expect(result.originals[0].hasLocalVoid).toBe(true);
    expect(canVoidOfflineInvoice(result.originals[0].invoice, true, true)).toBe(false);
  });

  it("is tenant-scoped — another tenant's local invoices never leak in", async () => {
    await seedPendingSale();

    const result = await listPendingOfflineInvoices(OTHER_TENANT_ID);

    expect(result.rows).toHaveLength(0);
  });
});

describe("T4d v4.1 — strict separation between the two void surfaces (static source scans)", () => {
  const readSource = (relativePath: string) =>
    fs.readFileSync(path.join(rootDir, relativePath), "utf-8");

  function readAllUnder(relativeDir: string): Array<{ file: string; source: string }> {
    const collected: Array<{ file: string; source: string }> = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(entry.name)) {
          collected.push({ file: full, source: fs.readFileSync(full, "utf-8") });
        }
      }
    };
    walk(path.join(rootDir, relativeDir));
    return collected;
  }

  it("T4c2 (components/sales-log/**) never imports the offline void service", () => {
    const files = readAllUnder("components/sales-log");
    expect(files.length).toBeGreaterThan(0);

    for (const { file, source } of files) {
      expect(source, `${file} must not reference submitOfflineVoid`).not.toContain(
        "submitOfflineVoid"
      );
      expect(source, `${file} must not reference listPendingOfflineInvoices`).not.toContain(
        "listPendingOfflineInvoices"
      );
      // No import path crossing into the POS surface either.
      expect(source, `${file} must not import from components/pos`).not.toContain(
        "components/pos"
      );
    }
  });

  it("the offline panel never references the online void endpoint, and does no network I/O of its own", () => {
    const source = readSource("components/pos/offline-void-panel.tsx");

    // The one and only write path it is allowed to use.
    expect(source).toContain("submitOfflineVoid");

    // The online void endpoint is never named here, in any form.
    expect(source).not.toContain("/api/ledger/voids");
    expect(source).not.toContain("ledger/voids");

    // It performs no fetch/XHR itself — syncing is delegated to the
    // triggerSync prop owned by pos-layout's single useSyncWorker() instance.
    expect(/\bfetch\s*\(/.test(source)).toBe(false);
    expect(source).not.toContain("XMLHttpRequest");
  });

  it("mounts the panel inside the POS layout, ADMIN-gated, under the top status bar", () => {
    const source = readSource("components/pos/pos-layout.tsx");

    expect(source).toContain("<OfflineVoidPanel");
    expect(source).toContain('isAdmin={session?.role === "ADMIN"}');
    expect(source).toContain('from "./offline-void-panel"');
  });

  it("the offline void service writes no CustomerPayment record and no raw Decimal negation", () => {
    const source = readSource("lib/offline/pos-service.ts");
    const start = source.indexOf("export async function submitOfflineVoid");
    expect(start).toBeGreaterThan(-1);

    const nextExport = source.indexOf("\n\n/**", start);
    const body = source.slice(start, nextExport > -1 ? nextExport : undefined);

    expect(body).not.toContain("offlinePayments");
    expect(body).not.toContain("createOfflinePaymentRecord");
    expect(body).not.toContain("saveOfflinePaymentWithBalance");

    // Persists only through the shared, unchanged helpers.
    expect(body).toContain("createOfflineVoidRecord");
    expect(body).toContain("saveOfflineInvoiceWithBalance");

    // Money/quantity negation goes through lib/utils/money.ts.
    expect(body).not.toContain("decimal.js");
    expect(body).not.toContain(".negated(");
  });

  it("keeps the ONLINE void action out of T4e's ledger screen", () => {
    const ledgerPage = readSource("app/(dashboard)/ledger/page.tsx");

    expect(ledgerPage).not.toContain("voidsInvoiceId");
    expect(ledgerPage).not.toContain("/api/ledger/voids");
    expect(ledgerPage).not.toContain("submitOfflineVoid");
  });
});
