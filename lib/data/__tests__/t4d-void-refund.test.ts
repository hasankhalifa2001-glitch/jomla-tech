/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from "fs";
import path from "path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import Decimal from "decimal.js";
import { Prisma } from "@prisma/client";
import { sumMoney } from "@/lib/utils/money";

/**
 * T4d v4.1 — Void / Refund (ONLINE path): POST /api/ledger/voids.
 *
 * Deliberately REAL, not mocked:
 *   - app/api/ledger/voids/route.ts — the actual handler under test.
 *   - lib/inventory/units.ts — so getUnitConversionFactor()/toBaseUnit() are
 *     exercised as written, and every restored quantity is asserted against an
 *     INDEPENDENT decimal.js reference computed in this file.
 *   - lib/auth/role-matrix.ts — so the CASHIER rejection is the real
 *     capability-matrix decision, not a stubbed boolean.
 *
 * Only the Prisma boundary (getTenantDb / tenantScopedRawQuery), the session,
 * and assertTenantWritable are faked.
 *
 *   COVERAGE → ACCEPTANCE CRITERIA
 *   1. 3 cartons × factor 24 restores exactly 72 base units (exact-equality
 *      against an independent decimal.js reference), and 2.5 × 3.3 → "8.25".
 *   2. The factor always comes from item.unitId — never requireBaseUnit().
 *   3. The increment targets exactly item.batchId, once per distinct batch.
 *   4. Void InvoiceItem.quantity stays in the SOLD unit ("-3.0000"), distinct
 *      from the base-unit figure applied to ProductBatch.quantity ("72.0000").
 *   5. CASHIER → 403 with zero writes attempted.
 *   6. PENDING_REVIEW → 400 INVALID_STATE, with $transaction never opened.
 *   7. VOIDED keeps its pre-existing, more specific message; COMPLETED proceeds.
 *   8. Double-void: pre-check → 400; P2002 on voidsInvoiceId → 409; an
 *      unrelated P2002 → 500.
 *   9. No CustomerPayment row is ever written (dynamic + static).
 *   10. Monetary zero-sum via sumMoney([original, void]) === "0.0000".
 *   11. voidReason survives verbatim (trimmed); userId is the voiding ADMIN;
 *      the original invoice is never updated.
 *   12. The batch lock is acquired exactly once, before any increment, with
 *      ORDER BY id ASC / FOR UPDATE over the sorted, de-duplicated ids.
 *   13. Single-entry-point scan: every non-test reference to the void endpoint
 *      or ledger:void_invoice lives under components/sales-log/, and T4e's
 *      ledger screen contains no void trigger.
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
  const fakeProductUnit: any = { findUniqueOrThrow: vi.fn() };

  const fakeTx = {
    invoice: fakeInvoice,
    invoiceItem: fakeInvoiceItem,
    productBatch: fakeProductBatch,
    productUnit: fakeProductUnit,
  };

  const fakeDb: any = {
    invoice: fakeInvoice,
    invoiceItem: fakeInvoiceItem,
    productBatch: fakeProductBatch,
    productUnit: fakeProductUnit,
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

const FACTOR_BY_UNIT: Record<string, string> = { "unit-carton": "24" };

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

function makeItem(overrides: Record<string, unknown> = {}) {
  return {
    id: "item-1",
    productId: "prod-1",
    unitId: "unit-carton",
    batchId: "batch-1",
    quantity: "3",
    unitPriceSYP: "50000.0000",
    unitPriceUSD: "3.3333",
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
    factors?: Record<string, string>;
  } = {}
) {
  const items = overrides.items ?? [makeItem()];
  const factors = overrides.factors ?? FACTOR_BY_UNIT;
  const original = makeOriginalInvoice({ items, ...(overrides.invoice ?? {}) });

  fakeInvoice.findUnique.mockResolvedValue(original);
  fakeInvoice.findFirst.mockResolvedValue(null); // no existing void row
  fakeInvoice.create.mockResolvedValue({ id: "inv-void-1" });
  fakeInvoiceItem.create.mockImplementation(async (args: any) => {
    callLog.push(`void-item:${args?.data?.quantity}`);
    return {};
  });
  fakeProductUnit.findUniqueOrThrow.mockImplementation(async (args: any) => {
    const unitId = args?.where?.id;
    callLog.push(`unit-lookup:${unitId}`);
    return { conversionFactor: factors[unitId] ?? "1" };
  });

  return original;
}

const createData = () => fakeInvoice.create.mock.calls[0][0].data;
const increments = () =>
  fakeProductBatch.update.mock.calls.map((c: any) => c[0].data.quantity.increment);
const incrementedBatchIds = () =>
  fakeProductBatch.update.mock.calls.map((c: any) => c[0].where.id);

/** An independent decimal.js reference — deliberately NOT the code under test.
 *  The route passes `toBaseUnit(...).toString()` straight into the increment,
 *  so decimal.js's own canonical string ("72", "8.25") is the reference. */
function referenceBaseQty(soldQty: string, factor: string): string {
  return new Decimal(soldQty).times(new Decimal(factor)).toString();
}

beforeEach(() => {
  vi.clearAllMocks();
  callLog.length = 0;
  lockCalls.length = 0;
  mockSessionState.session = null;
  mockAssertTenantWritable.mockResolvedValue("ACTIVE");
});

describe("T4d v4.1 — inventory restoration uses unit conversion, never inversion", () => {
  it("restores exactly 3 × 24 = 72 base units, matching an independent decimal.js reference", async () => {
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

    expect(increments()).toEqual([referenceBaseQty("3", "24")]);
    expect(increments()[0]).toBe("72");
    // The naive inversion this architecture exists to prevent would restore "3".
    expect(increments()[0]).not.toBe("3");
  });

  it("keeps full precision on a fractional quantity: 2.5 × 3.3 → 8.25", async () => {
    setSession(ADMIN_ID, "ADMIN");
    arrangeSuccess({
      items: [makeItem({ unitId: "unit-frac", quantity: "2.5", batchId: "batch-frac" })],
      factors: { "unit-frac": "3.3" },
    });

    const res = await voidInvoice(
      makeRequest({ invoiceId: "inv-original", voidReason: VOID_REASON })
    );
    expect(res.status).toBe(200);

    expect(increments()).toEqual([referenceBaseQty("2.5", "3.3")]);
    expect(increments()[0]).toBe("8.25");
    // Zero rounding loss: the same figure at the schema's Decimal(18,4) precision.
    expect(new Decimal(increments()[0]).toFixed(4)).toBe("8.2500");
  });

  it("resolves the factor via item.unitId — never the product's base unit", async () => {
    setSession(ADMIN_ID, "ADMIN");
    arrangeSuccess();

    await voidInvoice(makeRequest({ invoiceId: "inv-original", voidReason: VOID_REASON }));

    // A base unit would have carried factor 1; this proves the SOLD unit was fetched.
    expect(fakeProductUnit.findUniqueOrThrow).toHaveBeenCalledTimes(1);
    expect(fakeProductUnit.findUniqueOrThrow.mock.calls[0][0].where).toMatchObject({
      id: "unit-carton",
      tenantId: TENANT_ID,
    });
    expect(callLog.filter((e) => e.startsWith("unit-lookup:"))).toEqual([
      "unit-lookup:unit-carton",
    ]);
  });

  it("increments exactly item.batchId, once per distinct batch, on a FIFO-split invoice", async () => {
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
    expect(increments()).toEqual(["24", "48"]);
    expect(increments()).toEqual([
      referenceBaseQty("1", "24"),
      referenceBaseQty("2", "24"),
    ]);
  });

  it("never invokes a FIFO re-allocation — restoration is a direct increment", async () => {
    setSession(ADMIN_ID, "ADMIN");
    arrangeSuccess();

    await voidInvoice(makeRequest({ invoiceId: "inv-original", voidReason: VOID_REASON }));

    const routeSource = fs.readFileSync(
      path.resolve(process.cwd(), "app/api/ledger/voids/route.ts"),
      "utf-8"
    );
    expect(routeSource).not.toContain("commitFifoAllocation");
    expect(routeSource).not.toContain("requireBaseUnit");

    // Every write in the transaction is an increment, never a decrement/set.
    for (const call of fakeProductBatch.update.mock.calls as any[]) {
      expect(call[0].data.quantity).toHaveProperty("increment");
      expect(call[0].data.quantity).not.toHaveProperty("decrement");
    }
  });

  it("keeps the void InvoiceItem.quantity in the SOLD unit, distinct from the base-unit restore", async () => {
    setSession(ADMIN_ID, "ADMIN");
    arrangeSuccess();

    await voidInvoice(makeRequest({ invoiceId: "inv-original", voidReason: VOID_REASON }));

    const itemData = fakeInvoiceItem.create.mock.calls[0][0].data;
    expect(itemData.quantity).toBe("-3.0000"); // sold unit: −3 cartons
    expect(itemData.unitId).toBe("unit-carton"); // same sold unit, never a base unit
    expect(itemData.batchId).toBe("batch-1");
    expect(itemData.quantity).not.toBe(increments()[0]);
    expect(increments()[0]).toBe("72");
    // Price deliberately never negated — that would double-negate the line total.
    expect(itemData.unitPriceSYP).toBe("50000.0000");
    expect(itemData.unitPriceUSD).toBe("3.3333");
  });

  it("collapses to one value only when the sold unit IS the base unit (factor 1)", async () => {
    setSession(ADMIN_ID, "ADMIN");
    arrangeSuccess({
      items: [makeItem({ unitId: "unit-piece", quantity: "7", batchId: "batch-p" })],
      factors: { "unit-piece": "1" },
    });

    await voidInvoice(makeRequest({ invoiceId: "inv-original", voidReason: VOID_REASON }));

    expect(fakeInvoiceItem.create.mock.calls[0][0].data.quantity).toBe("-7.0000");
    expect(increments()[0]).toBe("7");
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

    const routeSource = fs.readFileSync(
      path.resolve(process.cwd(), "app/api/ledger/voids/route.ts"),
      "utf-8"
    );
    expect(routeSource).not.toContain("customerPayment");
    expect(routeSource).not.toContain("CustomerPayment");
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

  it("keeps every UI reference to the void flow under components/sales-log/", () => {
    const uiFiles = [
      ...collectFiles("components", /\.(ts|tsx)$/),
      ...collectFiles("app", /\.tsx$/),
    ].filter((file) => !file.includes("__tests__"));

    expect(uiFiles.length).toBeGreaterThan(0);

    const offenders = uiFiles.filter((file) => {
      const source = fs.readFileSync(file, "utf-8");
      const mentionsVoidFlow =
        source.includes("/api/ledger/voids") || source.includes("ledger:void_invoice");
      if (!mentionsVoidFlow) return false;
      return !file.includes(path.join("components", "sales-log"));
    });

    // No POS screen, no ledger screen, no other dashboard page reaches the
    // online void action. (Non-UI files — the route itself, the role matrix,
    // the T4c2 cross-reference comments in app/api/invoices/** — are outside
    // this scan by design: the guarantee is about UI reachability.)
    expect(offenders).toEqual([]);
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
