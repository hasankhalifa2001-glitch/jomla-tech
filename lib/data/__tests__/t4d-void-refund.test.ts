/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from "fs";
import path from "path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import Decimal from "decimal.js";
import { Prisma } from "@prisma/client";
import { sumMoney } from "@/lib/utils/money";

/**
 * T4d v4.1 (+ v4.8 baseQuantity restore) — Void / Refund (ONLINE path):
 * POST /api/ledger/voids.
 *
 * Deliberately REAL, not mocked:
 *   - app/api/ledger/voids/route.ts — the actual handler under test.
 *   - lib/auth/role-matrix.ts — so the CASHIER rejection is the real
 *     capability-matrix decision, not a stubbed boolean.
 *   - lib/customers/resolve-active.ts — the real merge-chain resolver.
 *
 * Only the Prisma boundary (getTenantDb / tenantScopedRawQuery), the session,
 * and assertTenantWritable are faked.
 *
 * [v4.8] WHAT CHANGED IN THIS FILE: the route no longer converts the sold-unit
 * `quantity` back into base units (that used a ROUNDED share for FIFO-split
 * sales: 0.8333 x 24 = 19.9992). It restores the stored
 * InvoiceItem.baseQuantity — the exact amount deducted at sale time. So:
 *   - every fixture line now carries `baseQuantity` and `costAmountSYP`
 *     (the route reads both; without them the handler threw and answered 500);
 *   - the old "factor comes from item.unitId" assertions are gone, replaced by
 *     "the route reads NO unit factor at all";
 *   - a regression test pins the rounding case the change exists to fix;
 *   - static source scans ignore comments, so a comment that EXPLAINS a rule
 *     ("never commitFifoAllocation") is not mistaken for code that breaks it.
 *
 *   COVERAGE → ACCEPTANCE CRITERIA
 *   1. 3 cartons restore exactly the stored 72 base units; 2.5 x 3.3 → "8.25".
 *   2. [v4.8] A FIFO-split line (0.8333 cartons, baseQuantity 20) restores 20,
 *      never the re-derived 19.9992; a two-batch split sums exactly.
 *   3. The route reads no unit factor and never calls FIFO / requireBaseUnit.
 *   4. The increment targets exactly item.batchId, one per line.
 *   5. Void InvoiceItem.quantity stays in the SOLD unit ("-3.0000"), while
 *      baseQuantity and costAmountSYP are negated and zero-sum with the original.
 *   6. CASHIER → 403 with zero writes attempted.
 *   7. PENDING_REVIEW → 400 INVALID_STATE, with $transaction never opened.
 *   8. VOIDED keeps its pre-existing, more specific message; COMPLETED proceeds.
 *   9. Double-void: pre-check → 400; P2002 on voidsInvoiceId → 409; an
 *      unrelated P2002 → 500.
 *  10. No CustomerPayment row is ever written (dynamic + static).
 *  11. Monetary zero-sum via sumMoney([original, void]) === "0.0000".
 *  12. voidReason survives verbatim (trimmed); userId is the voiding ADMIN;
 *      the original invoice is never updated.
 *  13. The batch lock is acquired exactly once, before any increment, with
 *      ORDER BY id ASC / FOR UPDATE over the sorted, de-duplicated ids.
 *  14. Single-entry-point scan: the void ENDPOINT is referenced only under
 *      components/sales-log/ (the offline POS panel must never call it, spec
 *      §6.4); T4e's ledger screen contains no void trigger.
 */

const {
  mockSessionState,
  mockGetTenantDb,
  mockTenantScopedRawQuery,
  mockAssertTenantWritable,
  callLog,
  lockCalls,
  fakeInvoice,
  fakeInvoiceItem,
  fakeProductBatch,
  fakeProductUnit,
  fakeCustomer,
  fakeCustomerMergeLog,
} = vi.hoisted(() => {
  const callLog: string[] = [];
  const lockCalls: Array<{
    tx: unknown;
    tenantId: string;
    build: (condition: unknown) => any;
  }> = [];

  const fakeInvoice: any = {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  };
  const fakeInvoiceItem: any = { create: vi.fn() };
  const fakeProductBatch: any = {
    update: vi.fn(async (args: any) => {
      callLog.push(`batch-increment:${args?.where?.id}`);
      return {};
    }),
  };
  // [v4.8] The void route must not read any unit factor. These stay as spies so
  // a regression (the route reaching for ProductUnit again) is detectable.
  const fakeProductUnit: any = {
    findUniqueOrThrow: vi.fn(),
    findUnique: vi.fn(),
    findFirst: vi.fn(),
  };

  // [T4e v4.4 §1 / §3.1] The void route resolves the written customerId
  // through resolveActiveCustomerId(tx, ...) — which reads CustomerMergeLog
  // ONLY, never Customer. Both models are modelled here so (a) the unmerged
  // default keeps every pre-existing assertion byte-identical, and (b) the
  // "zero writes to Customer" invariant can be asserted dynamically.
  const fakeCustomerMergeLog: any = { findFirst: vi.fn() };

  // Every Customer surface the route *could* reach — reads included, because
  // §3.1 states a void "never reads or writes any field on Customer".
  const customerCall = (method: string) =>
    vi.fn(async () => {
      callLog.push(`customer:${method}`);
      return undefined;
    });
  const fakeCustomer: any = {
    findFirst: customerCall("findFirst"),
    findUnique: customerCall("findUnique"),
    findMany: customerCall("findMany"),
    create: customerCall("create"),
    update: customerCall("update"),
    updateMany: customerCall("updateMany"),
    upsert: customerCall("upsert"),
    delete: customerCall("delete"),
    deleteMany: customerCall("deleteMany"),
  };

  const fakeTx = {
    invoice: fakeInvoice,
    invoiceItem: fakeInvoiceItem,
    productBatch: fakeProductBatch,
    productUnit: fakeProductUnit,
    customer: fakeCustomer,
    customerMergeLog: fakeCustomerMergeLog,
  };

  const fakeDb: any = {
    invoice: fakeInvoice,
    invoiceItem: fakeInvoiceItem,
    productBatch: fakeProductBatch,
    productUnit: fakeProductUnit,
    customer: fakeCustomer,
    customerMergeLog: fakeCustomerMergeLog,
    $transaction: vi.fn(async (cb: any) => {
      callLog.push("transaction");
      return cb(fakeTx);
    }),
  };

  // [NOTE] The SQL builder callback is CAPTURED here, never invoked: this
  // factory is hoisted above the file's static imports, so referencing the
  // Prisma namespace inside it would hit the temporal dead zone. The tests
  // invoke the captured builder later, with Prisma fully initialised, to
  // inspect the SQL it would have sent.
  const mockTenantScopedRawQuery = vi.fn(
    async (tx: unknown, tenantId: string, build: (condition: unknown) => any) => {
      lockCalls.push({ tx, tenantId, build });
      callLog.push("lock");
      return [];
    }
  );

  return {
    mockSessionState: { session: null as any },
    mockGetTenantDb: vi.fn(() => fakeDb),
    mockTenantScopedRawQuery,
    mockAssertTenantWritable: vi.fn(async () => "ACTIVE"),
    callLog,
    lockCalls,
    fakeInvoice,
    fakeInvoiceItem,
    fakeProductBatch,
    fakeProductUnit,
    fakeCustomer,
    fakeCustomerMergeLog,
  };
});

vi.mock("@/lib/db/tenant-scope", () => ({
  getTenantDb: mockGetTenantDb,
  tenantScopedRawQuery: mockTenantScopedRawQuery,
}));

vi.mock("@/auth", () => ({
  auth: vi.fn(async () => mockSessionState.session),
}));

vi.mock("@/lib/auth/tenant", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/tenant")>();
  return { ...actual, assertTenantWritable: mockAssertTenantWritable };
});

import { POST as voidInvoice } from "@/app/api/ledger/voids/route";
// Re-exported unchanged by the partial mock above, so this is the REAL error
// class the route narrows on.
import { SubscriptionLockedError } from "@/lib/auth/tenant";

const TENANT_ID = "tenant-1";
const ADMIN_ID = "user-admin-voiding";
const VOID_REASON = "إرجاع كامل من الزبون";

/** The carton's factor, used ONLY by this file's fixtures and independent
 *  reference math — the route under test never sees it. */
const CARTON_FACTOR = "24";

function setSession(userId: string, role: "ADMIN" | "CASHIER") {
  mockSessionState.session = { user: { id: userId, role, tenantId: TENANT_ID } };
}

function makeRequest(body: unknown) {
  return new Request("http://localhost/api/ledger/voids", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * A stored InvoiceItem row. [v4.8] It carries `baseQuantity` (the exact amount
 * deducted from the batch at sale time) and `costAmountSYP` (the frozen cost
 * basis) — the route reads both. By default baseQuantity is quantity x 24
 * computed HERE, independently of the route; pass `baseQuantity` explicitly to
 * model a rounded FIFO split or a base-unit sale.
 */
function makeItem(overrides: Record<string, unknown> = {}) {
  const quantity = String(overrides.quantity ?? "3");
  return {
    id: "item-1",
    productId: "prod-1",
    unitId: "unit-carton",
    batchId: "batch-1",
    quantity,
    baseQuantity: new Decimal(quantity).times(CARTON_FACTOR).toFixed(4),
    unitPriceSYP: "50000.0000",
    unitPriceUSD: "3.3333",
    costAmountSYP: "90000.0000",
    ...overrides,
  };
}

function makeOriginalInvoice(overrides: Record<string, unknown> = {}) {
  return {
    id: "inv-original",
    tenantId: TENANT_ID,
    userId: "user-cashier",
    customerId: "cust-1",
    status: "COMPLETED",
    totalSYP: "150000.0000",
    totalUSD: "10.0000",
    exchangeRateUsed: "15000.0000",
    paidAmountSYP: "50000.0000",
    paidAmountUSD: "3.3333",
    debtAmountSYP: "100000.0000",
    debtAmountUSD: "6.6667",
    isPaid: false,
    voidsInvoiceId: null,
    voidReason: null,
    items: [makeItem()],
    ...overrides,
  };
}

/** Arranges the fully-successful path, returning the original invoice row. */
function arrangeSuccess(
  overrides: {
    items?: any[];
    invoice?: Record<string, unknown>;
  } = {}
) {
  const items = overrides.items ?? [makeItem()];
  const original = makeOriginalInvoice({ items, ...(overrides.invoice ?? {}) });

  fakeInvoice.findUnique.mockResolvedValue(original);
  fakeInvoice.findFirst.mockResolvedValue(null); // no existing void row
  fakeInvoice.create.mockResolvedValue({ id: "inv-void-1" });
  fakeInvoiceItem.create.mockImplementation(async (args: any) => {
    callLog.push(`void-item:${args?.data?.quantity}`);
    return {};
  });

  return original;
}

const createData = () => fakeInvoice.create.mock.calls[0][0].data;
const increments = () =>
  fakeProductBatch.update.mock.calls.map((c: any) => c[0].data.quantity.increment);
const incrementedBatchIds = () =>
  fakeProductBatch.update.mock.calls.map((c: any) => c[0].where.id);

/** An independent decimal.js reference — deliberately NOT the code under test. */
function referenceBaseQty(soldQty: string, factor: string): string {
  return new Decimal(soldQty).times(new Decimal(factor)).toFixed(4);
}

/**
 * Removes block comments and line comments, so a static scan inspects CODE.
 * The route and several UI files carry long comments that explain a rule by
 * naming the thing they forbid ("never commitFifoAllocation",
 * "never POST /api/ledger/voids") — a raw substring check would flag the
 * explanation as a violation of itself.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/([^:"'`])\/\/.*$/gm, "$1");
}

function readRouteCode(): string {
  return stripComments(
    fs.readFileSync(path.resolve(process.cwd(), "app/api/ledger/voids/route.ts"), "utf-8")
  );
}

/**
 * [T4e v4.4 §1] Switches the harness into "this customer was merged away"
 * state — the exact shape a CustomerMergeLog row has, chased one hop (a chain
 * back to an already-seen id terminates the recursion, same as production).
 * Every resolution is recorded in the shared callLog so a test can prove the
 * lookup happened INSIDE the void transaction, not from a cached value.
 */
function arrangeMergedCustomer(survivorByMergedId: Record<string, string>) {
  fakeCustomerMergeLog.findFirst.mockImplementation(async ({ where }: any) => {
    callLog.push(`resolve-customer:${where.mergedCustomerId}`);
    const survivor = survivorByMergedId[where.mergedCustomerId];
    return survivor ? { survivingCustomerId: survivor } : null;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  callLog.length = 0;
  lockCalls.length = 0;
  mockSessionState.session = null;
  mockAssertTenantWritable.mockResolvedValue("ACTIVE");
  // Default: this customer was never merged, so resolveActiveCustomerId() is a
  // pure pass-through and every pre-T4e assertion below is unchanged.
  fakeCustomerMergeLog.findFirst.mockResolvedValue(null);
});

describe("T4d v4.8 — inventory restoration uses the STORED baseQuantity, never a re-derived one", () => {
  it("restores exactly the stored 72 base units for 3 cartons, matching an independent reference", async () => {
    setSession(ADMIN_ID, "ADMIN");
    arrangeSuccess();

    const res = await voidInvoice(
      makeRequest({ invoiceId: "inv-original", voidReason: VOID_REASON })
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      success: true,
      voidInvoiceId: "inv-void-1",
      voidItemsCount: 1,
    });

    expect(increments()).toEqual([referenceBaseQty("3", CARTON_FACTOR)]);
    expect(increments()[0]).toBe("72.0000");
    // The naive inversion this architecture exists to prevent would restore "3".
    expect(increments()[0]).not.toBe("3");
  });

  it("keeps full precision on a fractional quantity: 2.5 × 3.3 → 8.2500", async () => {
    setSession(ADMIN_ID, "ADMIN");
    arrangeSuccess({
      items: [
        makeItem({
          unitId: "unit-frac",
          quantity: "2.5",
          batchId: "batch-frac",
          baseQuantity: referenceBaseQty("2.5", "3.3"),
        }),
      ],
    });

    const res = await voidInvoice(
      makeRequest({ invoiceId: "inv-original", voidReason: VOID_REASON })
    );
    expect(res.status).toBe(200);

    expect(increments()).toEqual(["8.2500"]);
    expect(new Decimal(increments()[0]).toString()).toBe("8.25");
  });

  it("[v4.8 regression] a FIFO-split line restores its stored baseQuantity (20), never the re-derived 19.9992", async () => {
    setSession(ADMIN_ID, "ADMIN");
    // One carton sold across two batches: this line is the 0.8333-carton share
    // whose exact deduction was 20 base units. quantity x factor would restore
    // 19.9992 and silently corrupt the batch.
    arrangeSuccess({
      items: [makeItem({ quantity: "0.8333", baseQuantity: "20.0000" })],
    });

    const res = await voidInvoice(
      makeRequest({ invoiceId: "inv-original", voidReason: VOID_REASON })
    );
    expect(res.status).toBe(200);

    const rederived = new Decimal("0.8333").times(CARTON_FACTOR).toFixed(4);
    expect(rederived).toBe("19.9992");
    expect(increments()).toEqual(["20.0000"]);
    expect(increments()[0]).not.toBe(rederived);
  });

  it("a two-batch FIFO split restores each batch exactly and the parts sum to the carton", async () => {
    setSession(ADMIN_ID, "ADMIN");
    arrangeSuccess({
      items: [
        makeItem({ id: "i-1", batchId: "batch-a", quantity: "0.8333", baseQuantity: "20.0000" }),
        makeItem({ id: "i-2", batchId: "batch-b", quantity: "0.1667", baseQuantity: "4.0000" }),
      ],
    });

    const res = await voidInvoice(
      makeRequest({ invoiceId: "inv-original", voidReason: VOID_REASON })
    );
    expect(res.status).toBe(200);

    expect(incrementedBatchIds()).toEqual(["batch-a", "batch-b"]);
    expect(increments()).toEqual(["20.0000", "4.0000"]);
    // One whole carton = 24 base units, restored with zero drift.
    expect(sumMoney(increments())).toBe("24.0000");
  });

  it("reads no unit factor at all — the void route never touches ProductUnit", async () => {
    setSession(ADMIN_ID, "ADMIN");
    arrangeSuccess();

    await voidInvoice(makeRequest({ invoiceId: "inv-original", voidReason: VOID_REASON }));

    expect(fakeProductUnit.findUniqueOrThrow).not.toHaveBeenCalled();
    expect(fakeProductUnit.findUnique).not.toHaveBeenCalled();
    expect(fakeProductUnit.findFirst).not.toHaveBeenCalled();
    expect(callLog.filter((e) => e.startsWith("unit-lookup:"))).toEqual([]);
  });

  it("increments exactly each line's batchId, in line order, on a multi-line invoice", async () => {
    setSession(ADMIN_ID, "ADMIN");
    arrangeSuccess({
      items: [
        makeItem({ id: "i-1", batchId: "batch-b", quantity: "1" }),
        makeItem({ id: "i-2", batchId: "batch-a", quantity: "2" }),
      ],
    });

    const res = await voidInvoice(
      makeRequest({ invoiceId: "inv-original", voidReason: VOID_REASON })
    );
    expect(res.status).toBe(200);
    expect(fakeInvoiceItem.create).toHaveBeenCalledTimes(2);

    expect([...incrementedBatchIds()].sort()).toEqual(["batch-a", "batch-b"]);
    expect(increments()).toEqual(["24.0000", "48.0000"]);
    expect(increments()).toEqual([
      referenceBaseQty("1", CARTON_FACTOR),
      referenceBaseQty("2", CARTON_FACTOR),
    ]);
  });

  it("never invokes FIFO allocation, base-unit lookup or unit conversion — restoration is a direct increment", async () => {
    setSession(ADMIN_ID, "ADMIN");
    arrangeSuccess();

    await voidInvoice(makeRequest({ invoiceId: "inv-original", voidReason: VOID_REASON }));

    // Comments are stripped first: the route's own comments name these
    // functions to explain that it does NOT use them.
    const code = readRouteCode();
    expect(code).not.toMatch(/commitFifoAllocation/);
    expect(code).not.toMatch(/previewFifoAllocation/);
    expect(code).not.toMatch(/requireBaseUnit/);
    expect(code).not.toMatch(/getUnitConversionFactor/);
    expect(code).not.toMatch(/toBaseUnit/);
    expect(code).not.toMatch(/\.conversionFactor/);

    // Every write in the transaction is an increment, never a decrement/set.
    for (const call of fakeProductBatch.update.mock.calls as any[]) {
      expect(call[0].data.quantity).toHaveProperty("increment");
      expect(call[0].data.quantity).not.toHaveProperty("decrement");
    }
  });

  it("keeps the void InvoiceItem.quantity in the SOLD unit and negates baseQuantity separately", async () => {
    setSession(ADMIN_ID, "ADMIN");
    arrangeSuccess();

    await voidInvoice(makeRequest({ invoiceId: "inv-original", voidReason: VOID_REASON }));

    const itemData = fakeInvoiceItem.create.mock.calls[0][0].data;
    expect(itemData.quantity).toBe("-3.0000"); // sold unit: −3 cartons
    expect(itemData.baseQuantity).toBe("-72.0000"); // exact base-unit amount, negated
    expect(itemData.unitId).toBe("unit-carton"); // same sold unit, never a base unit
    expect(itemData.batchId).toBe("batch-1");
    expect(itemData.quantity).not.toBe(itemData.baseQuantity);
    expect(increments()[0]).toBe("72.0000");
    // Price deliberately never negated — that would double-negate the line total.
    expect(itemData.unitPriceSYP).toBe("50000.0000");
    expect(itemData.unitPriceUSD).toBe("3.3333");
  });

  it("negates the frozen cost basis and base quantity exactly — original + void is zero per line", async () => {
    setSession(ADMIN_ID, "ADMIN");
    const original = arrangeSuccess({
      items: [makeItem({ costAmountSYP: "90000.0000" })],
    });

    const res = await voidInvoice(
      makeRequest({ invoiceId: original.id, voidReason: VOID_REASON })
    );
    expect(res.status).toBe(200);

    const itemData = fakeInvoiceItem.create.mock.calls[0][0].data;
    expect(itemData.costAmountSYP).toBe("-90000.0000");
    expect(sumMoney([original.items[0].costAmountSYP, itemData.costAmountSYP])).toBe("0.0000");
    expect(sumMoney([original.items[0].baseQuantity, itemData.baseQuantity])).toBe("0.0000");
    expect(sumMoney([original.items[0].quantity, itemData.quantity])).toBe("0.0000");
  });

  it("restores 1:1 when the sold unit IS the base unit", async () => {
    setSession(ADMIN_ID, "ADMIN");
    arrangeSuccess({
      items: [
        makeItem({
          unitId: "unit-piece",
          quantity: "7",
          batchId: "batch-p",
          baseQuantity: "7.0000",
        }),
      ],
    });

    await voidInvoice(makeRequest({ invoiceId: "inv-original", voidReason: VOID_REASON }));

    const itemData = fakeInvoiceItem.create.mock.calls[0][0].data;
    expect(itemData.quantity).toBe("-7.0000");
    expect(itemData.baseQuantity).toBe("-7.0000");
    expect(increments()[0]).toBe("7.0000");
  });
});

describe("T4d v4.1 — the void row's shape (money, reason, actor, append-only)", () => {
  it("stores the exact inverted monetary figures, so the ledger zero-sums", async () => {
    setSession(ADMIN_ID, "ADMIN");
    const original = arrangeSuccess();

    const res = await voidInvoice(
      makeRequest({ invoiceId: original.id, voidReason: VOID_REASON })
    );
    expect(res.status).toBe(200);

    const data = createData();

    expect(data.status).toBe("VOIDED");
    expect(data.isSynced).toBe(true);
    expect(data.voidsInvoiceId).toBe(original.id);
    // The voiding ADMIN — never the original cashier.
    expect(data.userId).toBe(ADMIN_ID);
    expect(data.customerId).toBe(original.customerId);
    expect(data.exchangeRateUsed).toBe(original.exchangeRateUsed);
    expect(data.isPaid).toBe(original.isPaid);

    expect(data.totalSYP).toBe("-150000.0000");
    expect(data.totalUSD).toBe("-10.0000");
    expect(data.paidAmountSYP).toBe("-50000.0000");
    expect(data.paidAmountUSD).toBe("-3.3333");
    expect(data.debtAmountSYP).toBe("-100000.0000");
    expect(data.debtAmountUSD).toBe("-6.6667");

    // Aggregating original + void through the ledger zeroes every figure out.
    expect(sumMoney([original.totalSYP, data.totalSYP])).toBe("0.0000");
    expect(sumMoney([original.paidAmountSYP, data.paidAmountSYP])).toBe("0.0000");
    expect(sumMoney([original.debtAmountSYP, data.debtAmountSYP])).toBe("0.0000");
  });

  it("keeps voidReason verbatim (trimmed) and never updates the original invoice", async () => {
    setSession(ADMIN_ID, "ADMIN");
    arrangeSuccess();

    const res = await voidInvoice(
      makeRequest({ invoiceId: "inv-original", voidReason: `   ${VOID_REASON}   ` })
    );

    expect(res.status).toBe(200);
    expect(createData().voidReason).toBe(VOID_REASON);
    expect(createData().voidReason).not.toContain("  ");

    // Invoice is strictly append-only: exactly one create, never an update.
    expect(fakeInvoice.create).toHaveBeenCalledTimes(1);
    expect(fakeInvoice.update).not.toHaveBeenCalled();
  });

  it("never writes a CustomerPayment record (dynamic + static)", async () => {
    setSession(ADMIN_ID, "ADMIN");
    arrangeSuccess();

    await voidInvoice(makeRequest({ invoiceId: "inv-original", voidReason: VOID_REASON }));

    expect(callLog.every((e) => !e.toLowerCase().includes("payment"))).toBe(true);

    const code = readRouteCode();
    expect(code).not.toContain("customerPayment");
    expect(code).not.toContain("CustomerPayment");
  });
});

describe("T4d v4.1 — only a COMPLETED invoice may be voided", () => {
  it("rejects PENDING_REVIEW with INVALID_STATE and never opens a transaction", async () => {
    setSession(ADMIN_ID, "ADMIN");
    arrangeSuccess({ invoice: { status: "PENDING_REVIEW" } });

    const res = await voidInvoice(
      makeRequest({ invoiceId: "inv-original", voidReason: VOID_REASON })
    );
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe("INVALID_STATE");
    expect(json.message).toBe(
      "لا يمكن إلغاء إلا الفواتير المكتملة — الفواتير قيد المراجعة تُرفض عبر مسار الطلبات."
    );

    // Zero write/lock attempts, and no wasted round-trip either: the new check
    // runs BEFORE the existing-void lookup (cheapest rejection first).
    expect(callLog).not.toContain("transaction");
    expect(lockCalls).toHaveLength(0);
    expect(fakeInvoice.create).not.toHaveBeenCalled();
    expect(fakeProductBatch.update).not.toHaveBeenCalled();
    expect(fakeInvoice.findFirst).not.toHaveBeenCalled();
  });

  it("still rejects a VOIDED row with the pre-existing, more specific message — the new check never shadows it", async () => {
    setSession(ADMIN_ID, "ADMIN");
    arrangeSuccess({ invoice: { status: "VOIDED" } });

    const res = await voidInvoice(
      makeRequest({ invoiceId: "inv-original", voidReason: VOID_REASON })
    );
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe("INVALID_STATE");
    expect(json.message).toBe("لا يمكن إلغاء فاتورة إلغاء أو فاتورة غير صالحة للإلغاء.");
    expect(callLog).not.toContain("transaction");
  });

  it("still rejects a row that is itself a void of something else", async () => {
    setSession(ADMIN_ID, "ADMIN");
    arrangeSuccess({
      invoice: { status: "COMPLETED", voidsInvoiceId: "inv-earlier" },
    });

    const res = await voidInvoice(
      makeRequest({ invoiceId: "inv-original", voidReason: VOID_REASON })
    );
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.message).toBe("لا يمكن إلغاء فاتورة إلغاء أو فاتورة غير صالحة للإلغاء.");
  });

  it("still proceeds for COMPLETED — the new guard does not block the happy path", async () => {
    setSession(ADMIN_ID, "ADMIN");
    arrangeSuccess();

    const res = await voidInvoice(
      makeRequest({ invoiceId: "inv-original", voidReason: VOID_REASON })
    );

    expect(res.status).toBe(200);
    expect(callLog).toContain("transaction");
  });

  it("still rejects an invoice with no line items", async () => {
    setSession(ADMIN_ID, "ADMIN");
    arrangeSuccess({ items: [] });

    const res = await voidInvoice(
      makeRequest({ invoiceId: "inv-original", voidReason: VOID_REASON })
    );
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.message).toBe("هذه الفاتورة لا تحتوي على أي عناصر لاسترجاعها.");
  });
});

describe("T4d v4.1 — ADMIN-only and input validation (raw API calls)", () => {
  it("rejects a CASHIER with 403 and zero writes attempted", async () => {
    setSession("user-cashier", "CASHIER");
    arrangeSuccess();

    const res = await voidInvoice(
      makeRequest({ invoiceId: "inv-original", voidReason: VOID_REASON })
    );
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json.error).toBe("FORBIDDEN");

    // Rejected before the invoice is even read — no lookup, no lock, no write.
    expect(fakeInvoice.findUnique).not.toHaveBeenCalled();
    expect(fakeInvoice.create).not.toHaveBeenCalled();
    expect(fakeInvoiceItem.create).not.toHaveBeenCalled();
    expect(fakeProductBatch.update).not.toHaveBeenCalled();
    expect(lockCalls).toHaveLength(0);
    expect(callLog).toHaveLength(0);
  });

  it("rejects an unauthenticated request with 401", async () => {
    mockSessionState.session = null;

    const res = await voidInvoice(
      makeRequest({ invoiceId: "inv-original", voidReason: VOID_REASON })
    );

    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("UNAUTHORIZED");
  });

  it("rejects a missing invoiceId or a blank voidReason with VALIDATION_ERROR", async () => {
    setSession(ADMIN_ID, "ADMIN");
    arrangeSuccess();

    const bodies = [
      { voidReason: VOID_REASON },
      { invoiceId: "inv-original" },
      { invoiceId: "inv-original", voidReason: "   " },
    ];

    for (const body of bodies) {
      const res = await voidInvoice(makeRequest(body));
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe("VALIDATION_ERROR");
      expect(json.message).toBe("يجب تحديد الفاتورة وسبب الإلغاء.");
    }

    expect(callLog).toHaveLength(0);
  });

  it("rejects a locked (non-ACTIVE) tenant subscription with 403", async () => {
    setSession(ADMIN_ID, "ADMIN");
    arrangeSuccess();
    mockAssertTenantWritable.mockRejectedValueOnce(new SubscriptionLockedError("EXPIRED"));

    const res = await voidInvoice(
      makeRequest({ invoiceId: "inv-original", voidReason: VOID_REASON })
    );

    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("SUBSCRIPTION_LOCKED");
    expect(fakeInvoice.findUnique).not.toHaveBeenCalled();
  });

  it("returns 404 for an invoice that does not exist", async () => {
    setSession(ADMIN_ID, "ADMIN");
    fakeInvoice.findUnique.mockResolvedValue(null);

    const res = await voidInvoice(
      makeRequest({ invoiceId: "inv-missing", voidReason: VOID_REASON })
    );

    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("NOT_FOUND");
  });
});

describe("T4d v4.1 — double-void prevention (application pre-check + DB constraint)", () => {
  it("rejects a second void at the application pre-check with 400 and no writes", async () => {
    setSession(ADMIN_ID, "ADMIN");
    arrangeSuccess();
    // An existing void row points AT the invoice being voided (the correct
    // direction — not a check on the target's own voidsInvoiceId).
    fakeInvoice.findFirst.mockResolvedValue({ id: "inv-void-existing" });

    const res = await voidInvoice(
      makeRequest({ invoiceId: "inv-original", voidReason: VOID_REASON })
    );
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toBe("INVALID_STATE");
    expect(json.message).toBe("لا يمكن إلغاء هذه الفاتورة لأنها ملغاة بالفعل.");

    expect(fakeInvoice.findFirst.mock.calls[0][0].where).toMatchObject({
      voidsInvoiceId: "inv-original",
      tenantId: TENANT_ID,
    });
    expect(callLog).not.toContain("transaction");
    expect(fakeInvoice.create).not.toHaveBeenCalled();
  });

  it("translates a genuine P2002 on voidsInvoiceId into 409 CONCURRENCY_ERROR", async () => {
    setSession(ADMIN_ID, "ADMIN");
    arrangeSuccess();
    fakeInvoice.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "6.19.3",
        meta: { target: ["voidsInvoiceId"] },
      })
    );

    const res = await voidInvoice(
      makeRequest({ invoiceId: "inv-original", voidReason: VOID_REASON })
    );
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.error).toBe("CONCURRENCY_ERROR");
    expect(json.message).toBe("هذه الفاتورة تم إلغاؤها بالفعل من قِبل مستخدم آخر.");
  });

  it("never mislabels an unrelated P2002 as 'already voided' — it stays a 500", async () => {
    setSession(ADMIN_ID, "ADMIN");
    arrangeSuccess();
    fakeInvoice.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "6.19.3",
        meta: { target: ["offlineId"] },
      })
    );

    const res = await voidInvoice(
      makeRequest({ invoiceId: "inv-original", voidReason: VOID_REASON })
    );
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error).toBe("SERVER_ERROR");
  });
});

describe("T4d v4.1 — the batch lock precedes every increment, ORDER BY id ASC", () => {
  it("locks exactly once over the sorted, de-duplicated batch ids, before any increment", async () => {
    setSession(ADMIN_ID, "ADMIN");
    arrangeSuccess({
      items: [
        makeItem({ id: "i-1", batchId: "batch-z", quantity: "1" }),
        makeItem({ id: "i-2", batchId: "batch-a", quantity: "1" }),
        makeItem({ id: "i-3", batchId: "batch-z", quantity: "1" }), // duplicate batch
      ],
    });

    const res = await voidInvoice(
      makeRequest({ invoiceId: "inv-original", voidReason: VOID_REASON })
    );
    expect(res.status).toBe(200);

    expect(lockCalls).toHaveLength(1);
    expect(lockCalls[0].tenantId).toBe(TENANT_ID);

    const lockIndex = callLog.indexOf("lock");
    const firstIncrementIndex = callLog.findIndex((e) => e.startsWith("batch-increment:"));
    expect(lockIndex).toBeGreaterThan(-1);
    expect(firstIncrementIndex).toBeGreaterThan(-1);
    expect(lockIndex).toBeLessThan(firstIncrementIndex);

    // The SQL the route would have sent: tenant-scoped, ascending, FOR UPDATE,
    // over the de-duplicated id list in sorted order.
    const built = lockCalls[0].build(Prisma.raw("1=1"));
    expect(built.sql).toContain('SELECT id FROM "ProductBatch"');
    expect(built.sql).toContain("ORDER BY id ASC");
    expect(built.sql).toContain("FOR UPDATE");
    expect(built.values).toEqual(["batch-a", "batch-z"]);
  });
});

describe("T4d v4.1 — single entry point for the online void action (static scans)", () => {
  function collectFiles(relativeDir: string, filePattern: RegExp): string[] {
    const collected: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (filePattern.test(entry.name)) collected.push(full);
      }
    };
    walk(path.join(process.cwd(), relativeDir));
    return collected;
  }

  const SALES_LOG_DIR = path.join("components", "sales-log");
  const OFFLINE_PANEL = path.join("components", "pos", "offline-void-panel.tsx");

  function uiFiles(): string[] {
    return [
      ...collectFiles("components", /\.(ts|tsx)$/),
      ...collectFiles("app", /\.tsx$/),
    ].filter((file) => !file.includes("__tests__"));
  }

  it("keeps every UI reference to the void ENDPOINT under components/sales-log/ (comments ignored)", () => {
    const files = uiFiles();
    expect(files.length).toBeGreaterThan(0);

    const offenders = files.filter((file) => {
      const code = stripComments(fs.readFileSync(file, "utf-8"));
      if (!code.includes("/api/ledger/voids")) return false;
      return !file.includes(SALES_LOG_DIR);
    });

    // No POS screen (the offline void panel included — it writes to local
    // Dexie through submitOfflineVoid(), spec §6.4), no ledger screen, no other
    // dashboard page reaches the online void endpoint. Non-UI files — the route
    // itself, the role matrix, cross-reference comments — are outside this scan
    // by design: the guarantee is about UI reachability.
    expect(offenders).toEqual([]);
  });

  it("limits the ledger:void_invoice capability string in UI code to the two sanctioned void surfaces", () => {
    const offenders = uiFiles().filter((file) => {
      const code = stripComments(fs.readFileSync(file, "utf-8"));
      if (!code.includes("ledger:void_invoice")) return false;
      return !file.includes(SALES_LOG_DIR) && !file.endsWith(OFFLINE_PANEL);
    });

    expect(offenders).toEqual([]);
  });

  it("keeps the offline void panel off the online endpoint (spec §6.4)", () => {
    const panelPath = path.resolve(process.cwd(), OFFLINE_PANEL);
    expect(fs.existsSync(panelPath)).toBe(true);

    const code = stripComments(fs.readFileSync(panelPath, "utf-8"));
    expect(code).not.toContain("/api/ledger/voids");
  });

  it("leaves T4e's ledger screen without any void trigger", () => {
    const ledgerPage = fs.readFileSync(
      path.resolve(process.cwd(), "app/(dashboard)/ledger/page.tsx"),
      "utf-8"
    );

    expect(ledgerPage).not.toContain("voidsInvoiceId");
    expect(ledgerPage).not.toContain("/api/ledger/voids");
    expect(ledgerPage).not.toContain("submitOfflineVoid");
  });

  it("confirms T4c2 still owns both the button predicate and the modal", () => {
    const table = fs.readFileSync(
      path.resolve(process.cwd(), "components/sales-log/invoice-log-table.tsx"),
      "utf-8"
    );
    expect(table).toContain("function canVoidInvoice");
    expect(table).toContain('row.status === "COMPLETED"');

    const modal = fs.readFileSync(
      path.resolve(process.cwd(), "components/sales-log/void-invoice-modal.tsx"),
      "utf-8"
    );
    expect(modal).toContain("/api/ledger/voids");
  });
});

// ============================================================================
// T4e Addendum v4.4 §3.1 — a void never touches Customer fields.
//
// A void writes exactly one thing: a new Invoice row (+ its items + inventory
// restored). It never reads or writes name / phone / shopName / isActive, so a
// prior merge's contact-field state (v4.3 §4) and T4e's WhatsApp statement
// feature are entirely unaffected by any later void of that customer's
// invoices. Stated explicitly so it is never mistaken for a bug and "fixed".
// ============================================================================
describe("T4e v4.4 §3.1 — a void performs zero reads and zero writes on Customer", () => {
  it("never touches the Customer table (dynamic)", async () => {
    setSession(ADMIN_ID, "ADMIN");
    const original = arrangeSuccess();

    const res = await voidInvoice(
      makeRequest({ invoiceId: original.id, voidReason: VOID_REASON })
    );
    expect(res.status).toBe(200);

    // No Customer method — read or write — was invoked at any point.
    expect(callLog.filter((e) => e.startsWith("customer:"))).toEqual([]);
    for (const method of [
      "findFirst",
      "findUnique",
      "findMany",
      "create",
      "update",
      "updateMany",
      "upsert",
      "delete",
      "deleteMany",
    ]) {
      expect(
        fakeCustomer[method],
        `Customer.${method} must never be called by the void writer`
      ).not.toHaveBeenCalled();
    }

    // The only customer-adjacent read the writer performs is the merge log —
    // i.e. it resolves WHERE the row belongs without ever touching Customer.
    expect(fakeCustomerMergeLog.findFirst).toHaveBeenCalled();
  });

  it("contains no Customer read or write of any kind (static)", () => {
    const routeSource = fs.readFileSync(
      path.resolve(process.cwd(), "app/api/ledger/voids/route.ts"),
      "utf-8"
    );

    // No Customer model access on either the tenant-scoped handle or the
    // transaction client. (A bare "Customer" substring check is impossible
    // here: resolveActiveCustomerId and originalInvoice.customerId both
    // legitimately contain it — hence the anchored patterns.)
    expect(routeSource).not.toMatch(/\b(?:tx|db)\.customer\b/);
    expect(routeSource).not.toMatch(
      /\bcustomer\s*\.\s*(create|update|updateMany|upsert|delete|deleteMany)\b/
    );

    // It does write the void invoice, with the customer resolved through the
    // one sanctioned path — the exact call §1 requires.
    expect(routeSource).toContain(
      "resolveActiveCustomerId(tx, tenantId, originalInvoice.customerId)"
    );
  });
});

// ============================================================================
// T4e Addendum v4.4 §1 — Void customerId resolution.
//
// The void writer is one of the write paths required to resolve its target
// customer through resolveActiveCustomerId() INSIDE the transaction that
// performs the write — never copied verbatim from the original invoice's
// stored customerId, never read from an earlier cached value.
//
// THE DISCRIMINATING SETUP: the original invoice is read (before the
// transaction) still carrying the PRE-merge customerId. That is the only
// arrangement that can fail — if the route copied `originalInvoice.customerId`
// straight into the void row, the assertions below would see
// "cust-merged-away" instead of the survivor. A setup in which the merged-away
// invoice had already been re-pointed by the merge would let a copy-verbatim
// implementation pass, so it proves nothing and is deliberately not used.
// ============================================================================
describe("T4e v4.4 §1 — the void row lands on the customer's CURRENT survivor", () => {
  const MERGED_AWAY = "cust-merged-away";
  const SURVIVOR = "cust-survivor";

  it("resolves to the surviving customer when the original customer was merged away after the sale", async () => {
    setSession(ADMIN_ID, "ADMIN");
    const original = arrangeSuccess({ invoice: { customerId: MERGED_AWAY } });
    arrangeMergedCustomer({ [MERGED_AWAY]: SURVIVOR });

    const res = await voidInvoice(
      makeRequest({ invoiceId: original.id, voidReason: VOID_REASON })
    );
    expect(res.status).toBe(200);

    const data = createData();
    expect(data.customerId).toBe(SURVIVOR);
    expect(data.customerId).not.toBe(MERGED_AWAY);

    // Resolution ran INSIDE the void transaction — after the batch lock and
    // before Invoice.create() — reading the merge state as of that instant,
    // never a value cached before the transaction opened.
    const resolveIndex = callLog.indexOf(`resolve-customer:${MERGED_AWAY}`);
    expect(resolveIndex).toBeGreaterThan(callLog.indexOf("transaction"));
    expect(resolveIndex).toBeGreaterThan(callLog.indexOf("lock"));

    // The lookup was tenant-scoped and asked the one question the helper asks.
    expect(fakeCustomerMergeLog.findFirst.mock.calls[0][0]).toEqual({
      where: { tenantId: TENANT_ID, mergedCustomerId: MERGED_AWAY },
      select: { survivingCustomerId: true },
    });
  });

  it("zero-sums the survivor's ledger — the regression case beside T4d's own monetary zero-sum test", async () => {
    setSession(ADMIN_ID, "ADMIN");
    const original = arrangeSuccess({ invoice: { customerId: MERGED_AWAY } });
    arrangeMergedCustomer({ [MERGED_AWAY]: SURVIVOR });

    const res = await voidInvoice(
      makeRequest({ invoiceId: original.id, voidReason: VOID_REASON })
    );
    expect(res.status).toBe(200);

    const data = createData();

    // The ledger equation is computed PER CUSTOMER, so the zero-sum property
    // only holds because the original (already re-pointed by the merge, per
    // T4e Scope item 6) and the new void row sit on the SAME customer.
    expect(data.customerId).toBe(SURVIVOR);
    expect(sumMoney([original.totalSYP, data.totalSYP])).toBe("0.0000");
    expect(sumMoney([original.paidAmountSYP, data.paidAmountSYP])).toBe("0.0000");
    expect(sumMoney([original.debtAmountSYP, data.debtAmountSYP])).toBe("0.0000");
    expect(data.debtAmountSYP).toBe("-100000.0000");
  });

  it("creates no balance on the deactivated, merged-away customer", async () => {
    setSession(ADMIN_ID, "ADMIN");
    const original = arrangeSuccess({ invoice: { customerId: MERGED_AWAY } });
    arrangeMergedCustomer({ [MERGED_AWAY]: SURVIVOR });

    const res = await voidInvoice(
      makeRequest({ invoiceId: original.id, voidReason: VOID_REASON })
    );
    expect(res.status).toBe(200);
    const data = createData();

    // Miniature per-customer ledger: SUM(Invoice.debtAmountSYP) over the rows
    // that now carry each customerId. The merge already zeroed the merged-away
    // customer by re-pointing the original off it; the void must not put
    // anything back on it.
    const ledger = [
      // The original sale, as re-pointed by the merge (T4e Scope item 6).
      { customerId: SURVIVOR, debtAmountSYP: original.debtAmountSYP },
      // Wherever the void row actually went.
      { customerId: data.customerId, debtAmountSYP: data.debtAmountSYP },
    ];
    const balanceOf = (customerId: string) =>
      // The "0.0000" seed stands in for SQL's SUM over zero rows: this
      // codebase's normalized zero at the schema's Decimal(18,4) precision.
      sumMoney([
        "0.0000",
        ...ledger.filter((r) => r.customerId === customerId).map((r) => r.debtAmountSYP),
      ]);

    expect(balanceOf(MERGED_AWAY)).toBe("0.0000");
    expect(balanceOf(SURVIVOR)).toBe("0.0000");
  });
});

// ============================================================================
// PASTE AT THE END of lib/data/__tests__/t4d-void-refund.test.ts
//
// No new imports needed: this block reuses the file's own helpers
// (setSession, arrangeSuccess, makeItem, voidInvoice, makeRequest, createData,
// increments, incrementedBatchIds, readRouteCode, fakeInvoiceItem, sumMoney,
// VOID_REASON, ADMIN_ID).
//
// By-amount (بيع بالمبلغ): 0.3333 kg @ 15,000 = 4,999.5, but the customer paid
// 5,000 and the stored invoice says 5,000. The online void builds the reversal
// from the STORED original, so it must reverse 5,000 exactly (never 4,999.5)
// and restore exactly the stored baseQuantity.
// ============================================================================
describe("T4d — إلغاء بيع بالمبلغ أونلاين (0.3333 كغ @ 15000 بإجمالي 5000)", () => {
  const BY_AMOUNT_INVOICE = {
    totalSYP: "5000.0000",
    totalUSD: null,
    exchangeRateUsed: null,
    paidAmountSYP: "5000.0000",
    paidAmountUSD: null,
    debtAmountSYP: "0.0000",
    debtAmountUSD: null,
    isPaid: true,
  };

  const kgItem = (overrides: Record<string, unknown> = {}) =>
    makeItem({
      unitId: "unit-kg",
      batchId: "batch-kg",
      quantity: "0.3333",
      baseQuantity: "0.3333", // what was actually deducted — the default (x24) would be wrong here
      unitPriceSYP: "15000.0000",
      unitPriceUSD: null,
      costAmountSYP: "3.3330",
      ...overrides,
    });

  it("يعكس إجمالي/مدفوع/دين الأصل المخزّن بالضبط (-5000 لا -4999.5) والصافي صفر", async () => {
    setSession(ADMIN_ID, "ADMIN");
    const original = arrangeSuccess({ items: [kgItem()], invoice: BY_AMOUNT_INVOICE });

    const res = await voidInvoice(
      makeRequest({ invoiceId: original.id, voidReason: VOID_REASON })
    );
    expect(res.status).toBe(200);

    const data = createData();
    expect(data.totalSYP).toBe("-5000.0000");
    expect(data.paidAmountSYP).toBe("-5000.0000");
    expect(data.debtAmountSYP).toBe("0.0000");
    // The route never derives the total from quantity x price:
    expect(data.totalSYP).not.toBe("-4999.5000");

    // No rate on the original -> no rate and no USD on the void either.
    expect(data.exchangeRateUsed).toBeNull();
    expect(data.totalUSD).toBeNull();

    expect(sumMoney([original.totalSYP, data.totalSYP])).toBe("0.0000");
    expect(sumMoney([original.paidAmountSYP, data.paidAmountSYP])).toBe("0.0000");
    expect(sumMoney([original.debtAmountSYP, data.debtAmountSYP])).toBe("0.0000");
  });

  it("سطر الإلغاء: الكمية و baseQuantity والتكلفة سالب الأصل، والسعر كما هو، والصافي صفر لكل حقل", async () => {
    setSession(ADMIN_ID, "ADMIN");
    const original = arrangeSuccess({ items: [kgItem()], invoice: BY_AMOUNT_INVOICE });

    await voidInvoice(makeRequest({ invoiceId: original.id, voidReason: VOID_REASON }));

    const itemData = fakeInvoiceItem.create.mock.calls[0][0].data;
    expect(itemData.quantity).toBe("-0.3333");
    expect(itemData.baseQuantity).toBe("-0.3333");
    expect(itemData.costAmountSYP).toBe("-3.3330");
    expect(itemData.unitPriceSYP).toBe("15000.0000"); // never negated
    expect(itemData.unitPriceUSD).toBeNull();

    const o = original.items[0];
    expect(sumMoney([o.quantity, itemData.quantity])).toBe("0.0000");
    expect(sumMoney([o.baseQuantity, itemData.baseQuantity])).toBe("0.0000");
    expect(sumMoney([o.costAmountSYP, itemData.costAmountSYP])).toBe("0.0000");
  });

  it("المخزون يرجع بـ baseQuantity المخزّنة بالضبط (0.3333) لنفس الدفعة", async () => {
    setSession(ADMIN_ID, "ADMIN");
    const original = arrangeSuccess({ items: [kgItem()], invoice: BY_AMOUNT_INVOICE });

    await voidInvoice(makeRequest({ invoiceId: original.id, voidReason: VOID_REASON }));

    expect(incrementedBatchIds()).toEqual(["batch-kg"]);
    expect(increments()).toEqual(["0.3333"]);
  });

  it("بيع بالمبلغ موزّع على دفعتين: كل دفعة ترجع بالضبط ومجموعها 0.3333، والإجمالي المعكوس 5000", async () => {
    setSession(ADMIN_ID, "ADMIN");
    const original = arrangeSuccess({
      items: [
        kgItem({ id: "i-a", batchId: "batch-a", quantity: "0.2000", baseQuantity: "0.2000", costAmountSYP: "2.0000" }),
        kgItem({ id: "i-b", batchId: "batch-b", quantity: "0.1333", baseQuantity: "0.1333", costAmountSYP: "1.3330" }),
      ],
      invoice: BY_AMOUNT_INVOICE,
    });

    const res = await voidInvoice(
      makeRequest({ invoiceId: original.id, voidReason: VOID_REASON })
    );
    expect(res.status).toBe(200);

    expect(incrementedBatchIds()).toEqual(["batch-a", "batch-b"]);
    expect(increments()).toEqual(["0.2000", "0.1333"]);
    expect(sumMoney(increments())).toBe("0.3333");

    // The invoice total comes from the stored invoice (5000), not from summing
    // the two lines (0.2 x 15000 + 0.1333 x 15000 = 4999.95).
    expect(createData().totalSYP).toBe("-5000.0000");

    const voidCosts = fakeInvoiceItem.create.mock.calls.map((c: any) => c[0].data.costAmountSYP);
    expect(sumMoney([...original.items.map((i: any) => i.costAmountSYP), ...voidCosts])).toBe("0.0000");
  });

  it("[static] المسار لا يعيد حساب الإجمالي من السطور ولا يستعمل التسامح أبداً — يبقى مشتقاً من الأصل المخزّن", () => {
    const code = readRouteCode();
    expect(code).not.toMatch(/isTotalWithinTolerance|invoiceTotalTolerance|quantityFromAmount|QUANTITY_HALF_STEP/);
    expect(code).not.toMatch(/multiplyMoney/);
    expect(code).not.toMatch(/0\.00005/);
  });
});