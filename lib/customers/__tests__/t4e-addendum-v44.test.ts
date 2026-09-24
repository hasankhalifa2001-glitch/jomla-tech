/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from "fs";
import path from "path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { sumMoney, subtractMoney } from "@/lib/utils/money";

/**
 * T4e Addendum (v4.4) — the two gaps where T4d's void flow meets T4e's merge
 * flow (§1, §2), the two documented already-correct behaviors (§3.1, §3.2),
 * and the merge-vs-in-flight-sync race (§4).
 *
 * WHAT THIS FILE DRIVES FOR REAL (not modelled):
 *   - app/api/sync/route.ts           — T4c's engine, both ordered sub-phases
 *                                       (non-void first, then voids).
 *   - app/api/ledger/merge/route.ts   — T4e's merge transaction.
 *   - lib/customers/resolve-active.ts — the shared resolution helper.
 *   - lib/inventory/units.ts          — real getUnitConversionFactor(), so the
 *                                       seeded ProductUnit row must satisfy its
 *                                       exact query shape.
 *   - lib/utils/money.ts              — real decimal arithmetic.
 *
 * ONLY the persistence boundary is replaced, and it is replaced by a
 * STATEFUL in-memory store rather than by per-call stubs: a row written by one
 * sub-phase (the sale) must be genuinely visible to the next sub-phase (its
 * matching void, which looks the original up by offlineId), and a merge that
 * "commits" between two orderings must really change what the next resolution
 * reads. A stateless mock cannot express either property.
 */

const rootDir = path.resolve(__dirname, "../../../");

const {
  store,
  resolutionLog,
  writeLog,
  resetStore,
  seedLedgerFixture,
  mockSessionState,
  fakePrisma,
  mockGetTenantDb,
  mockTenantScopedRawQuery,
  mockAssertTenantWritable,
} = vi.hoisted(() => {
  type Row = Record<string, any>;

  let idSeq = 0;
  const nextId = (prefix: string) => `${prefix}-${++idSeq}`;

  const store = {
    customers: [] as Row[],
    invoices: [] as Row[],
    invoiceItems: [] as Row[],
    payments: [] as Row[],
    mergeLogs: [] as Row[],
    mergeLogItems: [] as Row[],
    orders: [] as Row[],
    batches: [] as Row[],
    productUnits: [] as Row[],
    tenants: [] as Row[],
  };

  // Every resolveActiveCustomerId() lookup, in order — the evidence that a
  // given write path resolved FOR ITSELF instead of reusing a cached value.
  const resolutionLog: string[] = [];
  const writeLog: string[] = [];

  /** Exact 4-decimal string arithmetic for the in-memory store's own
   *  bookkeeping — money is never touched by native float arithmetic, even
   *  inside a test store. Built from BigInt() calls rather than BigInt
   *  literals, because this project targets ES2017. */
  const SCALE = BigInt(10000);
  const ZERO = BigInt(0);
  function addScaled(a: string, b: string): string {
    const toUnits = (v: string): bigint => {
      const neg = v.trim().startsWith("-");
      const [int, frac = ""] = v.trim().replace("-", "").split(".");
      const units = BigInt(int || "0") * SCALE + BigInt((frac + "0000").slice(0, 4));
      return neg ? -units : units;
    };
    const total = toUnits(a) + toUnits(b);
    const neg = total < ZERO;
    const abs = neg ? -total : total;
    return `${neg ? "-" : ""}${abs / SCALE}.${(abs % SCALE).toString().padStart(4, "0")}`;
  }

  function matches(row: Row, where?: Row): boolean {
    if (!where) return true;
    return Object.entries(where).every(([key, cond]) => {
      if (cond && typeof cond === "object" && !Array.isArray(cond)) {
        if ("in" in cond) return (cond.in as any[]).includes(row[key]);
        if ("equals" in cond) return row[key] === cond.equals;
        return false;
      }
      return row[key] === cond;
    });
  }

  const findOne = (rows: Row[], where?: Row) => rows.find((r) => matches(r, where));

  function project(row: Row | undefined, args?: Row): any {
    if (!row) return null;
    const select = args?.select;
    if (!select) return row;
    const out: Row = {};
    for (const key of Object.keys(select)) out[key] = row[key];
    return out;
  }

  /** Applies a Prisma `data` payload, honouring increment/decrement/set on the
   *  scalar fields the routes actually mutate. */
  function applyData(row: Row, data: Row) {
    for (const [key, value] of Object.entries(data)) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        if ("increment" in value) {
          row[key] = addScaled(row[key] ?? "0", String((value as any).increment));
          continue;
        }
        if ("decrement" in value) {
          row[key] = addScaled(row[key] ?? "0", `-${(value as any).decrement}`);
          continue;
        }
        if ("set" in value) {
          row[key] = (value as any).set;
          continue;
        }
      }
      row[key] = value;
    }
  }

  function withRelations(row: Row | undefined, args?: Row): any {
    if (!row) return null;
    const out: Row = { ...row };
    if (args?.include?.items) {
      out.items = store.invoiceItems.filter((i) => i.invoiceId === row.id);
    }
    return out;
  }

  // --------------------------------------------------------------------------
  // The store-backed client. Handed to BOTH mocked entry points:
  //   - `@/lib/db`'s raw `prisma` (T4c's sync engine, the documented
  //     category-5 raw-client call site), and
  //   - `getTenantDb()` (T4e's merge route).
  // It doubles as its own transaction client, which is what makes a
  // multi-sub-phase batch observable as a real sequence of state changes.
  // --------------------------------------------------------------------------
  const fakePrisma: any = {
    customer: {
      findFirst: async (args: any) => project(findOne(store.customers, args?.where), args),
      findUnique: async (args: any) => project(findOne(store.customers, args?.where), args),
      findMany: async (args: any) =>
        store.customers.filter((r) => matches(r, args?.where)).map((r) => project(r, args)),
      create: async (args: any) => {
        const row = { id: nextId("cust"), isActive: true, isSystemGenerated: false, ...args.data };
        store.customers.push(row);
        writeLog.push(`customer.create:${row.id}`);
        return project(row, args);
      },
      update: async (args: any) => {
        const row = findOne(store.customers, args?.where);
        if (!row) throw new Error("customer.update: no matching row");
        applyData(row, args.data);
        writeLog.push(`customer.update:${row.id}`);
        return project(row, args);
      },
      updateMany: async (args: any) => {
        const rows = store.customers.filter((r) => matches(r, args?.where));
        rows.forEach((r) => applyData(r, args.data));
        writeLog.push(`customer.updateMany:${rows.length}`);
        return { count: rows.length };
      },
    },

    customerMergeLog: {
      findFirst: async (args: any) => {
        const entry = `resolveActiveCustomerId:${args?.where?.mergedCustomerId}`;
        // Recorded in BOTH logs: resolutionLog isolates the helper's calls,
        // while writeLog interleaves them with the writes so a test can prove
        // WHICH write resolved for itself, and in what order.
        resolutionLog.push(entry);
        writeLog.push(entry);
        return project(findOne(store.mergeLogs, args?.where), args);
      },
      create: async (args: any) => {
        const row = { id: nextId("merge-log"), ...args.data };
        store.mergeLogs.push(row);
        writeLog.push(`customerMergeLog.create:${row.id}`);
        return row;
      },
    },

    customerMergeLogItem: {
      createMany: async (args: any) => {
        store.mergeLogItems.push(...args.data);
        writeLog.push(`customerMergeLogItem.createMany:${args.data.length}`);
        return { count: args.data.length };
      },
    },

    invoice: {
      findFirst: async (args: any) => withRelations(findOne(store.invoices, args?.where), args),
      findMany: async (args: any) =>
        store.invoices.filter((r) => matches(r, args?.where)).map((r) => project(r, args)),
      create: async (args: any) => {
        const row = { id: nextId("inv"), ...args.data };
        store.invoices.push(row);
        writeLog.push(`invoice.create:${row.offlineId ?? row.id}->${row.customerId}`);
        return project(row, args);
      },
      update: async (args: any) => {
        const row = findOne(store.invoices, args?.where);
        if (!row) throw new Error("invoice.update: no matching row");
        applyData(row, args.data);
        writeLog.push(`invoice.update:${row.id}`);
        return project(row, args);
      },
      updateMany: async (args: any) => {
        const rows = store.invoices.filter((r) => matches(r, args?.where));
        rows.forEach((r) => applyData(r, args.data));
        writeLog.push(`invoice.updateMany:${rows.length}`);
        return { count: rows.length };
      },
    },

    invoiceItem: {
      create: async (args: any) => {
        const row = { id: nextId("item"), ...args.data };
        store.invoiceItems.push(row);
        return row;
      },
    },

    customerPayment: {
      findFirst: async (args: any) => project(findOne(store.payments, args?.where), args),
      findMany: async (args: any) =>
        store.payments.filter((r) => matches(r, args?.where)).map((r) => project(r, args)),
      create: async (args: any) => {
        const row = { id: nextId("pay"), ...args.data };
        store.payments.push(row);
        writeLog.push(`customerPayment.create:${row.offlineId ?? row.id}->${row.customerId}`);
        return row;
      },
      updateMany: async (args: any) => {
        const rows = store.payments.filter((r) => matches(r, args?.where));
        rows.forEach((r) => applyData(r, args.data));
        writeLog.push(`customerPayment.updateMany:${rows.length}`);
        return { count: rows.length };
      },
    },

    b2BOrderRequest: {
      findFirst: async (args: any) => project(findOne(store.orders, args?.where), args),
      findMany: async (args: any) =>
        store.orders.filter((r) => matches(r, args?.where)).map((r) => project(r, args)),
      update: async (args: any) => {
        const row = findOne(store.orders, args?.where);
        if (!row) throw new Error("b2BOrderRequest.update: no matching row");
        applyData(row, args.data);
        return project(row, args);
      },
      // Faithful: the `where` clause is APPLIED, never ignored — which is what
      // makes §3.2's negative assertion meaningful rather than tautological.
      updateMany: async (args: any) => {
        const rows = store.orders.filter((r) => matches(r, args?.where));
        rows.forEach((r) => applyData(r, args.data));
        writeLog.push(`b2BOrderRequest.updateMany:${rows.length}`);
        return { count: rows.length };
      },
    },

    productBatch: {
      findMany: async (args: any) =>
        store.batches.filter((r) => matches(r, args?.where)).map((r) => project(r, args)),
      update: async (args: any) => {
        const row = findOne(store.batches, args?.where);
        if (!row) throw new Error("productBatch.update: no matching row");
        applyData(row, args.data);
        return row;
      },
    },

    // The REAL getUnitConversionFactor() calls exactly this, so it must be
    // answered from the store — that is what keeps the sync engine's unit
    // conversion genuine rather than stubbed away.
    productUnit: {
      findUniqueOrThrow: async (args: any) => {
        const row = findOne(store.productUnits, args?.where);
        if (!row) throw new Error("productUnit.findUniqueOrThrow: no matching row");
        return project(row, args);
      },
    },

    tenant: {
      findUnique: async (args: any) => project(findOne(store.tenants, args?.where), args),
    },

    $transaction: async (cb: any) => cb(fakePrisma),
  };

  function resetStore() {
    for (const rows of Object.values(store)) rows.length = 0;
    resolutionLog.length = 0;
    writeLog.length = 0;
    idSeq = 0;
  }

  /**
   * The shared ledger fixture: one surviving customer, one duplicate that has
   * ALREADY been merged away into it (exactly the server-side state at the
   * moment a stale device syncs), the units/batch a carton sale needs, and
   * nothing else. Tests add orders/invoices as their scenario requires.
   */
  function seedLedgerFixture() {
    store.customers.push(
      { id: "cust-a", tenantId: "tenant-1", name: "المحل الأساسي", isActive: true, isSystemGenerated: false },
      {
        id: "cust-b",
        tenantId: "tenant-1",
        name: "المحل المكرر",
        offlineId: "off-cust-1",
        isActive: true,
        isSystemGenerated: false,
      }
    );
    store.productUnits.push(
      { id: "unit-carton", tenantId: "tenant-1", productId: "prod-1", conversionFactor: "24" },
      { id: "unit-base", tenantId: "tenant-1", productId: "prod-1", conversionFactor: "1" }
    );
    store.batches.push({ id: "batch-1", tenantId: "tenant-1", productId: "prod-1", quantity: "1000.0000" });
    store.tenants.push({ id: "tenant-1", dailyExchangeRate: "15000.0000" });
  }

  const mockSessionState: { current: any } = {
    current: {
      user: { id: "admin-user-1", email: "admin@test.com", role: "ADMIN", tenantId: "tenant-1" },
    },
  };

  return {
    store,
    resolutionLog,
    writeLog,
    resetStore,
    seedLedgerFixture,
    mockSessionState,
    fakePrisma,
    mockGetTenantDb: vi.fn(() => fakePrisma),
    mockTenantScopedRawQuery: vi.fn(async () => []),
    mockAssertTenantWritable: vi.fn(async () => "ACTIVE"),
  };
});

// The raw client (T4c's documented category-5 exception). Partial mock: the
// real module's other exports stay available to any transitive consumer.
vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { ...actual, prisma: fakePrisma };
});

// getTenantDb() (the merge route) and the row-locking helper both resolve to
// the same stateful store.
vi.mock("@/lib/db/tenant-scope", () => ({
  getTenantDb: mockGetTenantDb,
  tenantScopedRawQuery: mockTenantScopedRawQuery,
}));

vi.mock("@/auth", () => ({
  auth: vi.fn(async () => mockSessionState.current),
}));

vi.mock("@/lib/auth/tenant", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { ...actual, assertTenantWritable: mockAssertTenantWritable };
});

// Inventory is stubbed ONLY where a real call would need a real database
// (row locking / FIFO allocation / base-unit lookup). units.ts stays REAL, so
// the sold-unit → base-unit conversion below is genuinely exercised.
vi.mock("@/lib/inventory/batch-locking", () => ({
  lockBatchesForFifoAllocations: vi.fn(async () => undefined),
}));

vi.mock("@/lib/inventory/fifo", () => ({
  commitFifoAllocation: vi.fn(async (_tx: unknown, args: { requestedQty: string }) => ({
    allocations: [{ batchId: "batch-1", allocatedQty: args.requestedQty }],
    isSufficient: true,
    remainingQty: "0",
  })),
}));

vi.mock("@/lib/inventory/base-unit", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    requireBaseUnit: vi.fn(async () => ({ id: "unit-base", conversionFactor: "1" })),
  };
});

import { POST as syncPost } from "@/app/api/sync/route";
import { POST as mergePost } from "@/app/api/ledger/merge/route";

const TENANT_ID = "tenant-1";
const SURVIVOR = "cust-a";
const DUPLICATE = "cust-b";
const DUPLICATE_OFFLINE_ID = "off-cust-1";
const SALE_OFFLINE_ID = "off-sale-1";
const VOID_OFFLINE_ID = "off-void-1";

/** The sync handler is typed against NextRequest, but only ever calls
 *  req.json() — a plain Request is sufficient at runtime, so the mismatch is
 *  bridged here once (matching how this codebase's route tests construct
 *  requests) rather than asserted away at every call site. */
type SyncPostRequest = Parameters<typeof syncPost>[0];

function makeSyncRequest(body: unknown): SyncPostRequest {
  return new Request("http://localhost/api/sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as SyncPostRequest;
}

function makeMergeRequest() {
  return new Request("http://localhost/api/ledger/merge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ survivingCustomerId: SURVIVOR, mergedCustomerId: DUPLICATE }),
  });
}

/** A fully-unpaid credit sale: 3 cartons × 50,000 SYP (factor 24 → 72 base). */
function saleInvoicePayload(overrides: Record<string, unknown> = {}) {
  return {
    offlineId: SALE_OFFLINE_ID,
    offlineCustomerId: DUPLICATE_OFFLINE_ID,
    items: [
      {
        productId: "prod-1",
        unitId: "unit-carton",
        quantity: 3,
        unitPriceSYP: "50000.0000",
        unitPriceUSD: null,
      },
    ],
    totalSYP: "150000.0000",
    totalUSD: null,
    exchangeRateUsed: "15000.0000",
    paidAmountSYP: "0.0000",
    paidAmountUSD: null,
    debtAmountSYP: "150000.0000",
    debtAmountUSD: null,
    createdAt: "2026-09-20T10:00:00.000Z",
    ...overrides,
  };
}

/** Its matching full void — negated, same prices, ADMIN-only. */
function voidInvoicePayload(overrides: Record<string, unknown> = {}) {
  return {
    offlineId: VOID_OFFLINE_ID,
    offlineCustomerId: DUPLICATE_OFFLINE_ID,
    items: [
      {
        productId: "prod-1",
        unitId: "unit-carton",
        quantity: -3,
        unitPriceSYP: "50000.0000",
        unitPriceUSD: null,
      },
    ],
    totalSYP: "-150000.0000",
    totalUSD: null,
    exchangeRateUsed: "15000.0000",
    paidAmountSYP: "0.0000",
    paidAmountUSD: null,
    debtAmountSYP: "-150000.0000",
    debtAmountUSD: null,
    voidsOfflineInvoiceId: SALE_OFFLINE_ID,
    voidReason: "إرجاع كامل من الزبون",
    createdAt: "2026-09-20T11:00:00.000Z",
    ...overrides,
  };
}

function syncBatch() {
  return makeSyncRequest({
    customers: [],
    payments: [],
    invoices: [saleInvoicePayload(), voidInvoicePayload()],
  });
}

/**
 * Reproduces the server-side state the addendum describes: the duplicate is
 * ALREADY merged away — deactivated, with a CustomerMergeLog row pointing at
 * the survivor — at the moment the batch is queued/synced.
 */
function commitPreExistingMerge() {
  store.mergeLogs.push({
    id: "merge-log-seed",
    tenantId: TENANT_ID,
    survivingCustomerId: SURVIVOR,
    mergedCustomerId: DUPLICATE,
    performedByUserId: "admin-user-1",
  });
  const duplicate = store.customers.find((c) => c.id === DUPLICATE);
  if (duplicate) duplicate.isActive = false;
}

/** The per-customer ledger equation: SUM(Invoice.debtAmountSYP) − SUM(CustomerPayment.amountSYP). */
function balanceSYP(customerId: string): string {
  const debt = sumMoney([
    "0.0000",
    ...store.invoices.filter((i) => i.customerId === customerId).map((i) => i.debtAmountSYP),
  ]);
  const paid = sumMoney([
    "0.0000",
    ...store.payments.filter((p) => p.customerId === customerId).map((p) => p.amountSYP),
  ]);
  return subtractMoney(debt, paid);
}

beforeEach(() => {
  vi.clearAllMocks();
  resetStore();
  seedLedgerFixture();
  mockSessionState.current = {
    user: { id: "admin-user-1", email: "admin@test.com", role: "ADMIN", tenantId: TENANT_ID },
  };
});

// ============================================================================
// T4e v4.4 §2 — the sync engine's void sub-pass is explicitly covered.
//
// v4.1 split T4c's invoice pass into two ORDERED sub-phases (non-void first,
// then voids) so a void can resolve its original at all. §2 requires that BOTH
// sub-phases independently call resolveActiveCustomerId, each resolved fresh
// rather than reusing a value from earlier in the same batch — a merge could
// complete in the gap between the two sub-phases of a single batch.
// ============================================================================
describe("T4e v4.4 §2 — both sync sub-phases resolve the customer for themselves", () => {
  it("lands the sale AND its matching void on the survivor, one resolution per sub-phase", async () => {
    commitPreExistingMerge();

    const res = await syncPost(syncBatch());
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.success).toBe(true);
    // Sub-phase order is what lets a void find its own original in one batch.
    expect(body.invoices).toEqual([
      { offlineId: SALE_OFFLINE_ID, status: "SYNCED", realId: expect.any(String) },
      { offlineId: VOID_OFFLINE_ID, status: "SYNCED", realId: expect.any(String) },
    ]);

    const sale = store.invoices.find((i) => i.offlineId === SALE_OFFLINE_ID)!;
    const voidRow = store.invoices.find((i) => i.offlineId === VOID_OFFLINE_ID)!;

    // Sub-phase A — the non-void pass.
    expect(sale.status).toBe("COMPLETED");
    expect(sale.customerId).toBe(SURVIVOR);

    // Sub-phase B — the void pass.
    expect(voidRow.status).toBe("VOIDED");
    expect(voidRow.voidsInvoiceId).toBe(sale.id);
    expect(voidRow.customerId).toBe(SURVIVOR);

    // Neither sub-phase reused the other's result. Timeline: the sale pass
    // resolved (cust-b → cust-a, chasing one hop), wrote its invoice, and only
    // THEN did the void pass resolve for itself — reading the customerId out
    // of the original row it just looked up. A carry-over implementation would
    // show no resolution at all between the two writes.
    const saleWriteIndex = writeLog.indexOf(`invoice.create:${SALE_OFFLINE_ID}->${SURVIVOR}`);
    const voidWriteIndex = writeLog.indexOf(`invoice.create:${VOID_OFFLINE_ID}->${SURVIVOR}`);
    const voidResolveIndex = writeLog.lastIndexOf(`resolveActiveCustomerId:${SURVIVOR}`);

    expect(saleWriteIndex).toBeGreaterThan(-1);
    expect(voidWriteIndex).toBeGreaterThan(-1);
    expect(voidResolveIndex).toBeGreaterThan(saleWriteIndex);
    expect(voidWriteIndex).toBeGreaterThan(voidResolveIndex);

    // Two sub-phases, three helper lookups: the sale pass's own chain is
    // cust-b → cust-a, then the void pass resolves cust-a for itself.
    expect(resolutionLog).toEqual([
      `resolveActiveCustomerId:${DUPLICATE}`,
      `resolveActiveCustomerId:${SURVIVOR}`,
      `resolveActiveCustomerId:${SURVIVOR}`,
    ]);
  });

  it("both ordered sub-phase code paths call the helper (static source scan)", () => {
    const source = fs.readFileSync(path.join(rootDir, "app/api/sync/route.ts"), "utf-8");

    // The two ordered sub-phase loops, A before B, splitting on exactly the
    // void marker.
    const subPhaseA = source.indexOf("Sub-phase A");
    const subPhaseB = source.indexOf("Sub-phase B");
    expect(subPhaseA).toBeGreaterThan(-1);
    expect(subPhaseB).toBeGreaterThan(subPhaseA);
    const loops = source.slice(subPhaseA, subPhaseB + 400);
    expect(loops).toContain("!inv.voidsOfflineInvoiceId");
    expect(loops).toContain("inv.voidsOfflineInvoiceId");

    // The VOID sub-phase path: a direct call whose input is the original
    // invoice's OWN customerId — resolved fresh at write time, never from the
    // batch-level map the sale/payment passes share.
    const voidBranchStart = source.indexOf("if (isVoid) {");
    const saleBranchMarker = source.indexOf("// ---- SALE PATH");
    expect(voidBranchStart).toBeGreaterThan(-1);
    expect(saleBranchMarker).toBeGreaterThan(voidBranchStart);
    const voidBranch = source.slice(voidBranchStart, saleBranchMarker);
    expect(voidBranch).toContain("const targetCustomerId = await resolveActiveCustomerId(");
    expect(voidBranch).toContain("originalInvoice.customerId");
    expect(voidBranch).not.toContain("customerMap");

    // The NON-VOID sub-phase path: resolved through resolveTargetCustomerId().
    const saleBranch = source.slice(saleBranchMarker);
    expect(saleBranch).toContain("resolveTargetCustomerId(");

    // ...whose every mapped/matched branch routes through the same helper —
    // three call sites, one per resolution branch.
    const helperStart = source.indexOf("async function resolveTargetCustomerId(");
    const helperEnd = source.indexOf("export async function POST(");
    expect(helperStart).toBeGreaterThan(-1);
    expect(helperEnd).toBeGreaterThan(helperStart);
    const helperBody = source.slice(helperStart, helperEnd);
    expect(helperBody.match(/resolveActiveCustomerId\(/g) ?? []).toHaveLength(3);
  });
});

// ============================================================================
// T4e v4.4 §3.2 — B2BOrderRequest.matchedCustomerId on an already-APPROVED
// order is HISTORICAL ONLY and is deliberately not refreshed by a later merge.
//
// v4.2 scoped the refresh to `WHERE status = 'PENDING_REVIEW'`. Once an order
// has been approved, the field has already served its only documented purpose
// (a pre-approval hint for the reviewing admin) and carries no downstream
// effect on any calculation — so leaving it stale is a display-only historical
// artifact, not a correctness gap. This is a deliberate NEGATIVE test.
// ============================================================================
describe("T4e v4.4 §3.2 — an APPROVED order keeps its historical matchedCustomerId", () => {
  it("refreshes only the PENDING_REVIEW order and leaves the APPROVED one untouched", async () => {
    store.orders.push(
      {
        id: "order-pending",
        tenantId: TENANT_ID,
        status: "PENDING_REVIEW",
        matchedCustomerId: DUPLICATE,
      },
      {
        id: "order-approved",
        tenantId: TENANT_ID,
        status: "APPROVED",
        matchedCustomerId: DUPLICATE,
        // Approval already produced a real invoice — itself later covered by
        // §1/§2 should it ever be voided.
        resultingInvoiceId: "inv-approved-1",
      }
    );

    const res = await mergePost(makeMergeRequest());
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);

    // The pre-approval hint is genuinely refreshed...
    expect(store.orders.find((o) => o.id === "order-pending")!.matchedCustomerId).toBe(SURVIVOR);
    // ...while the approved order's field is intentionally left behind.
    expect(store.orders.find((o) => o.id === "order-approved")!.matchedCustomerId).toBe(DUPLICATE);

    // The store applies the `where` clause faithfully, so exactly one order
    // matched — and no other write touched the order table at all.
    expect(writeLog.filter((e) => e.startsWith("b2BOrderRequest."))).toEqual([
      "b2BOrderRequest.updateMany:1",
    ]);
  });

  it("scopes the refresh with status: PENDING_REVIEW, with no unguarded order write (static)", () => {
    const source = fs.readFileSync(
      path.join(rootDir, "app/api/ledger/merge/route.ts"),
      "utf-8"
    );

    expect(source).toContain('status: "PENDING_REVIEW"');
    // Exactly one B2BOrderRequest write in the whole merge route, and it is
    // the guarded updateMany — never a single-row update.
    expect(source.match(/b2BOrderRequest\.\w+\(/g)).toEqual(["b2BOrderRequest.updateMany("]);
    expect(source).not.toMatch(/b2BOrderRequest\.update\(/);
  });
});

// ============================================================================
// T4e v4.4 §4 — the merge-vs-in-flight-sync race, pinned down.
//
// No new mechanism and no lock: correctness comes from resolveActiveCustomerId
// being called INSIDE the same transaction as the write it resolves for, so
// whichever of the two transactions commits first, the result is consistent.
// Both orderings are exercised against the same racing pair, and both must
// produce an identical, zero-discrepancy final ledger.
// ============================================================================
describe("T4e v4.4 §4 — merge vs. in-flight sync: correct under either commit order", () => {
  function finalState() {
    return {
      customers: store.customers
        .map((c) => ({ id: c.id, isActive: c.isActive }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      invoices: store.invoices
        .map((i) => ({ offlineId: i.offlineId, customerId: i.customerId, status: i.status }))
        .sort((a, b) => String(a.offlineId).localeCompare(String(b.offlineId))),
      balanceSurvivorSYP: balanceSYP(SURVIVOR),
      balanceMergedAwaySYP: balanceSYP(DUPLICATE),
    };
  }

  it("sync commits first: the merge that follows re-points the freshly written rows", async () => {
    const syncRes = await syncPost(syncBatch());
    expect(syncRes.status).toBe(200);

    // At that instant the merge had not happened, so both rows correctly land
    // on what was then the customer of record.
    expect(store.invoices.map((i) => i.customerId)).toEqual([DUPLICATE, DUPLICATE]);

    const mergeRes = await mergePost(makeMergeRequest());
    expect(mergeRes.status).toBe(200);
    // Running afterwards, the merge sees and re-points exactly the two rows
    // the sync had just written — the pre-existing merge-transaction scope,
    // applied to work that arrived after it was queued.
    expect((await mergeRes.json()).repointedInvoicesCount).toBe(2);

    const state = finalState();
    expect(state.invoices.map((i) => i.customerId)).toEqual([SURVIVOR, SURVIVOR]);
    expect(state.balanceSurvivorSYP).toBe("0.0000");
    expect(state.balanceMergedAwaySYP).toBe("0.0000");
  });

  it("merge commits first: the sync write resolves straight to the survivor", async () => {
    const mergeRes = await mergePost(makeMergeRequest());
    expect(mergeRes.status).toBe(200);
    // Nothing had been written yet, so there was nothing for it to re-point.
    expect((await mergeRes.json()).repointedInvoicesCount).toBe(0);

    const syncRes = await syncPost(syncBatch());
    expect(syncRes.status).toBe(200);

    const state = finalState();
    expect(state.invoices.map((i) => i.customerId)).toEqual([SURVIVOR, SURVIVOR]);
    expect(state.balanceSurvivorSYP).toBe("0.0000");
    expect(state.balanceMergedAwaySYP).toBe("0.0000");
  });

  it("both commit orderings converge on an identical, zero-discrepancy ledger", async () => {
    // Ordering 1 — sync first, then merge.
    await syncPost(syncBatch());
    await mergePost(makeMergeRequest());
    const syncFirst = finalState();

    // Ordering 2 — merge first, then sync, from a clean fixture.
    resetStore();
    seedLedgerFixture();
    await mergePost(makeMergeRequest());
    await syncPost(syncBatch());
    const mergeFirst = finalState();

    // This equality IS the guarantee: the outcome is determined entirely by
    // commit order, and both outcomes are correct — no lock between the two
    // transactions is required for that to hold.
    expect(syncFirst).toEqual(mergeFirst);

    expect(syncFirst.invoices).toHaveLength(2);
    expect(syncFirst.invoices.every((i) => i.customerId === SURVIVOR)).toBe(true);
    expect(syncFirst.customers.find((c) => c.id === DUPLICATE)!.isActive).toBe(false);
    // sale debt (+150,000) + its void (−150,000) = a fully consistent zero.
    expect(syncFirst.balanceSurvivorSYP).toBe("0.0000");
    expect(syncFirst.balanceMergedAwaySYP).toBe("0.0000");
  });
});




