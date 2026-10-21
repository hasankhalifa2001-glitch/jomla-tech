/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * T6c — /api/sync D10 rule:
 *   - locked tenant syncs an item created before lockAt, fails one created
 *     after with the Arabic reason "انتهى الاشتراك قبل تسجيل هذه العملية";
 *   - PENDING tenant fails all;
 *   - ordering/idempotency unaffected; voids follow the same rule.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const ARABIC_REASON = "انتهى الاشتراك قبل تسجيل هذه العملية";

const { mockSessionState, tenantRow, calls, EXPIRES_AT, LOCK_AT, PRE_LOCK, POST_LOCK } = vi.hoisted(() => {
  // Fixed "now": 2026-10-20. Tenant expired 2026-10-10 → lockAt 2026-10-15.
  const EXPIRES_AT = new Date("2026-10-10T12:00:00.000Z");
  const LOCK_AT = new Date("2026-10-15T12:00:00.000Z");
  const PRE_LOCK = "2026-10-12T10:00:00.000Z";
  const POST_LOCK = "2026-10-18T10:00:00.000Z";
  const calls: { customers: any[]; invoices: any[]; payments: any[] } = {
    customers: [],
    invoices: [],
    payments: [],
  };
  const tenantRow: { current: any } = {
    current: { subscriptionStatus: "ACTIVE", expiresAt: EXPIRES_AT },
  };
  return {
    mockSessionState: {
      session: { user: { id: "admin-1", role: "ADMIN", tenantId: "tenant-1" } } as any,
    },
    tenantRow,
    calls,
    EXPIRES_AT,
    LOCK_AT,
    PRE_LOCK,
    POST_LOCK,
  };
});

const fakeTx = {
  customer: {
    findFirst: vi.fn(async () => null),
    create: vi.fn(async ({ data }: any) => {
      calls.customers.push(data);
      return { id: `c-${data.offlineId}` };
    }),
  },
  invoice: {
    findFirst: vi.fn(async () => null),
    create: vi.fn(async () => ({ id: "inv-1" })),
  },
  user: { findFirst: vi.fn(async () => ({ id: "admin-1", role: "ADMIN" })) },
};

vi.mock("@/auth", () => ({
  auth: vi.fn(async () => mockSessionState.session),
}));

vi.mock("@/lib/db/tenant-scope", () => ({
  getTenantDb: vi.fn(() => ({
    tenant: { findUnique: vi.fn(async () => tenantRow.current) },
  })),
  tenantScopedRawQuery: vi.fn(async () => []),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    $transaction: vi.fn(async (cb: any) => cb(fakeTx)),
    customer: { findFirst: vi.fn(async () => null) },
    user: { findFirst: vi.fn(async () => ({ id: "admin-1", role: "ADMIN" })) },
  },
  getTenantDb: vi.fn(() => ({
    tenant: { findUnique: vi.fn(async () => tenantRow.current) },
  })),
}));

vi.mock("@/lib/inventory/fifo", () => ({
  commitFifoAllocation: vi.fn(async () => ({ allocations: [], remainingQty: "0" })),
}));
vi.mock("@/lib/inventory/batch-locking", () => ({
  lockBatchesForFifoAllocations: vi.fn(async () => undefined),
}));
vi.mock("@/lib/inventory/base-unit", () => ({
  requireBaseUnit: vi.fn(async () => ({ id: "u-base" })),
  MissingBaseUnitError: class extends Error {},
}));
vi.mock("@/lib/inventory/units", () => ({
  getUnitConversionFactor: vi.fn(async () => "1"),
  toBaseUnit: (q: string) => ({ toFixed: () => q }),
  fromBaseUnit: (q: string) => ({ toFixed: () => q }),
}));
vi.mock("@/lib/customers/resolve-active", () => ({
  resolveActiveCustomerId: vi.fn(async (_tx: any, _t: any, id: string) => id),
}));
vi.mock("@/lib/ledger/repayment", () => ({
  recordRepaymentIdempotent: vi.fn(async () => ({ paymentId: "pay-1" })),
}));

import { POST as syncHandler } from "@/app/api/sync/route";

function syncReq(body: unknown) {
  return new (require("next/server").NextRequest)("http://localhost/api/sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as any;
}

function customerItem(offlineId: string, createdAt: string) {
  return { offlineId, name: "زبون", createdAt };
}

describe("T6c — sync D10 per-item lock rule", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    calls.customers.length = 0;
    tenantRow.current = { subscriptionStatus: "ACTIVE", expiresAt: EXPIRES_AT };
    vi.useRealTimers();
  });

  it("locked tenant: pre-lock item SYNCED, post-lock item FAILED with Arabic reason", async () => {
    const req = syncReq({
      customers: [customerItem("pre-1", PRE_LOCK), customerItem("post-1", POST_LOCK)],
      invoices: [],
      payments: [],
    });
    const res = await syncHandler(req);
    const json = await res.json();
    expect(json.success).toBe(false);
    const byId = Object.fromEntries(json.customers.map((r: any) => [r.offlineId, r]));
    expect(byId["pre-1"].status).toBe("SYNCED");
    expect(byId["post-1"].status).toBe("FAILED");
    expect(byId["post-1"].error).toBe(ARABIC_REASON);
    // Only the pre-lock item reached the DB.
    expect(calls.customers.map((c: any) => c.offlineId)).toEqual(["pre-1"]);
  });

  it("PENDING tenant fails everything", async () => {
    tenantRow.current = { subscriptionStatus: "PENDING", expiresAt: null };
    const req = syncReq({
      customers: [customerItem("pre-1", PRE_LOCK)],
      invoices: [],
      payments: [],
    });
    const res = await syncHandler(req);
    const json = await res.json();
    expect(json.customers[0].status).toBe("FAILED");
    expect(json.customers[0].error).toBe(ARABIC_REASON);
    expect(calls.customers).toEqual([]);
  });

  it("writable tenant processes everything as before (no subscription failures)", async () => {
    tenantRow.current = {
      subscriptionStatus: "ACTIVE",
      expiresAt: new Date(Date.now() + 30 * DAY_MS),
    };
    const req = syncReq({
      customers: [customerItem("a", PRE_LOCK), customerItem("b", POST_LOCK)],
      invoices: [],
      payments: [],
    });
    const res = await syncHandler(req);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.customers.every((r: any) => r.status === "SYNCED")).toBe(true);
  });
});
