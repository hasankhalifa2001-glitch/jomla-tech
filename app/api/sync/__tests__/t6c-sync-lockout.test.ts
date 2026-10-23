/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { SUBSCRIPTION_GRACE_DAYS } from "@/lib/config/subscription";

/**
 * T6c — /api/sync D10 rule, INTEGRATION with the REAL getFreshEffectiveStatus
 * (deliberately NOT mocked here: the route reads the tenant row and the real
 * helper decides the status, so route ↔ helper wiring is what is verified).
 * Per-record coverage (sales / voids / payments) lives in
 * lib/offline/__tests__/t4c-sync-engine.test.ts, where the status is injected.
 *
 *   - locked tenant syncs an item created before lockAt, fails one created
 *     after with the Arabic reason "انتهى الاشتراك قبل تسجيل هذه العملية";
 *   - PENDING tenant fails all;
 *   - GRACE and ACTIVE tenants process everything as before;
 *   - a locked tenant with no usable lock moment fails closed.
 *
 * All dates are derived from SUBSCRIPTION_GRACE_DAYS and a FIXED fake clock,
 * so the suite neither depends on today's date nor on the grace config value.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const ARABIC_REASON = "انتهى الاشتراك قبل تسجيل هذه العملية";

// Timeline (all derived):
//   EXPIRES_AT  = 2026-10-01T12:00Z
//   LOCK_AT     = EXPIRES_AT + grace days
//   PRE_LOCK    = LOCK_AT - 1 day     (created before the lock moment)
//   POST_LOCK   = LOCK_AT + 1 day     (created after the lock moment)
//   NOW         = LOCK_AT + 2 days    (fake clock: tenant is past the lock)
const EXPIRES_AT = new Date("2026-10-01T12:00:00.000Z");
const LOCK_AT = new Date(EXPIRES_AT.getTime() + SUBSCRIPTION_GRACE_DAYS * DAY_MS);
const PRE_LOCK = new Date(LOCK_AT.getTime() - DAY_MS).toISOString();
const POST_LOCK = new Date(LOCK_AT.getTime() + DAY_MS).toISOString();
const NOW = new Date(LOCK_AT.getTime() + 2 * DAY_MS);

const { mockSessionState, tenantRow, calls } = vi.hoisted(() => {
  const calls: { customers: any[]; invoices: any[]; payments: any[] } = {
    customers: [],
    invoices: [],
    payments: [],
  };
  const tenantRow: { current: any } = { current: null };
  return {
    mockSessionState: {
      session: { user: { id: "admin-1", role: "ADMIN", tenantId: "tenant-1" } } as any,
    },
    tenantRow,
    calls,
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
  MissingBaseUnitError: class extends Error { },
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
  return new NextRequest("http://localhost/api/sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function customerItem(offlineId: string, createdAt: string) {
  return { offlineId, name: "زبون", createdAt };
}

async function syncCustomers(...items: Array<{ offlineId: string; createdAt: string }>) {
  const res = await syncHandler(
    syncReq({ customers: items.map((i) => customerItem(i.offlineId, i.createdAt)), invoices: [], payments: [] })
  );
  return res.json();
}

describe("T6c — sync D10 per-item lock rule (real getFreshEffectiveStatus)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    calls.customers.length = 0;
    // Fake ONLY Date (not timers/promises) so the clock is fixed but async
    // code keeps running normally.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    tenantRow.current = { subscriptionStatus: "ACTIVE", expiresAt: EXPIRES_AT };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("locked tenant: pre-lock item SYNCED, post-lock item FAILED with Arabic reason", async () => {
    const json = await syncCustomers(
      { offlineId: "pre-1", createdAt: PRE_LOCK },
      { offlineId: "post-1", createdAt: POST_LOCK }
    );

    expect(json.success).toBe(false);
    const byId = Object.fromEntries(json.customers.map((r: any) => [r.offlineId, r]));
    expect(byId["pre-1"].status).toBe("SYNCED");
    expect(byId["post-1"].status).toBe("FAILED");
    expect(byId["post-1"].error).toBe(ARABIC_REASON);
    // Only the pre-lock item reached the DB.
    expect(calls.customers.map((c: any) => c.offlineId)).toEqual(["pre-1"]);
  });

  it("item created exactly at lockAt is still processed (boundary is inclusive)", async () => {
    const json = await syncCustomers({ offlineId: "edge", createdAt: LOCK_AT.toISOString() });
    expect(json.customers[0].status).toBe("SYNCED");
  });

  it("item created 1 ms after lockAt is rejected", async () => {
    const json = await syncCustomers({
      offlineId: "late",
      createdAt: new Date(LOCK_AT.getTime() + 1).toISOString(),
    });
    expect(json.customers[0].status).toBe("FAILED");
    expect(json.customers[0].error).toBe(ARABIC_REASON);
    expect(calls.customers).toEqual([]);
  });

  it("PENDING tenant fails everything, even very old items", async () => {
    tenantRow.current = { subscriptionStatus: "PENDING", expiresAt: null };
    const json = await syncCustomers({ offlineId: "old", createdAt: "2020-01-01T00:00:00.000Z" });

    expect(json.customers[0].status).toBe("FAILED");
    expect(json.customers[0].error).toBe(ARABIC_REASON);
    expect(calls.customers).toEqual([]);
  });

  it("stored EXPIRED with no expiresAt fails closed (no usable lock moment → reject)", async () => {
    tenantRow.current = { subscriptionStatus: "EXPIRED", expiresAt: null };
    const json = await syncCustomers({ offlineId: "old", createdAt: PRE_LOCK });

    expect(json.customers[0].status).toBe("FAILED");
    expect(calls.customers).toEqual([]);
  });

  it("GRACE tenant (expired but inside the grace window) processes everything", async () => {
    // Expired 12 hours ago → still inside the grace window for any grace >= 1 day.
    tenantRow.current = {
      subscriptionStatus: "ACTIVE",
      expiresAt: new Date(NOW.getTime() - DAY_MS / 2),
    };
    const json = await syncCustomers(
      { offlineId: "a", createdAt: PRE_LOCK },
      { offlineId: "b", createdAt: POST_LOCK }
    );

    expect(json.success).toBe(true);
    expect(json.customers.every((r: any) => r.status === "SYNCED")).toBe(true);
  });

  it("ACTIVE tenant processes everything as before (no subscription failures)", async () => {
    tenantRow.current = {
      subscriptionStatus: "ACTIVE",
      expiresAt: new Date(NOW.getTime() + 30 * DAY_MS),
    };
    const json = await syncCustomers(
      { offlineId: "a", createdAt: PRE_LOCK },
      { offlineId: "b", createdAt: POST_LOCK }
    );

    expect(json.success).toBe(true);
    expect(json.customers.every((r: any) => r.status === "SYNCED")).toBe(true);
  });
});