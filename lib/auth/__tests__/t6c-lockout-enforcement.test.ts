/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * T6c — launch-blocking: a direct mutating API call on a locked tenant →
 * 403 independent of JWT staleness and of any page redirect; GRACE is
 * writable; billing/exemption routes stay reachable when locked.
 *
 * REAL: assertTenantWritable + isLockoutExemptPath + one mutating route
 * (POST /api/inventory/batches) + the billing status route.
 * MOCKED: Prisma boundary (getTenantDb / tenant db) and the session.
 *
 * CLOCK: the guard reads the real clock, so Date is pinned with fake timers
 * (Date only; promises keep working). Without this the "GRACE is writable"
 * case silently turns into a failure once real time passes lockAt.
 *
 * Tests tagged [probe] check fail-closed behaviour the spec implies; a
 * failure there is a real gap in the code, not a broken test.
 */

const H = vi.hoisted(() => {
  const mockTenantFindUnique = vi.fn();
  const mockProductBatch = { create: vi.fn(async () => ({ id: "b-1" })) };
  const makeDb = () => ({
    tenant: { findUnique: mockTenantFindUnique },
    productBatch: mockProductBatch,
    user: {
      findUnique: vi.fn(async () => ({ isActive: true })),
      findFirst: vi.fn(async () => ({ isActive: true })),
    },
    subscription: {
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
      count: vi.fn(async () => 0),
    },
    product: { findFirst: vi.fn(async () => null) },
    productUnit: { findMany: vi.fn(async () => []) },
  });
  return {
    mockTenantFindUnique,
    mockProductBatch,
    makeDb,
    sessionState: {
      session: {
        user: {
          id: "admin-1",
          role: "ADMIN",
          tenantId: "tenant-1",
          // JWT claims. Tests overwrite these to prove the DB is the authority.
          subscriptionStatus: "ACTIVE",
          subscriptionExpiresAt: null,
        },
      } as any,
    },
  };
});

vi.mock("@/lib/db/tenant-scope", () => ({
  getTenantDb: vi.fn(() => H.makeDb()),
  tenantScopedRawQuery: vi.fn(async () => []),
}));
vi.mock("@/lib/db", () => ({
  prisma: {},
  getTenantDb: vi.fn(() => H.makeDb()),
}));
vi.mock("@/auth", () => ({
  auth: vi.fn(async () => H.sessionState.session),
}));
vi.mock("@/lib/storage", () => ({
  RECEIPT_SIGNED_URL_MAX_SECONDS: 300,
  createReceiptSignedUrl: vi.fn(),
  uploadPrivateReceipt: vi.fn(),
  removePrivateReceipt: vi.fn(),
  uploadFileToStorage: vi.fn(),
  buildStorageKey: vi.fn(),
  ALLOWED_IMAGE_TYPES: [],
  MAX_UPLOAD_BYTES: 0,
}));

import {
  assertTenantWritable,
  isLockoutExemptPath,
  SubscriptionLockedError,
  SUBSCRIPTION_LOCKOUT_EXEMPT_API_PREFIXES,
  SUBSCRIPTION_LOCKOUT_EXEMPT_PAGE_PREFIXES,
} from "@/lib/auth/tenant";
import { SUBSCRIPTION_GRACE_DAYS } from "@/lib/config/subscription";
import { POST as createBatchHandler } from "@/app/api/inventory/batches/route";
import { GET as billingStatusHandler } from "@/app/api/billing/status/route";

const DAY_MS = 24 * 60 * 60 * 1000;
const GRACE_MS = SUBSCRIPTION_GRACE_DAYS * DAY_MS;
const NOW = new Date("2026-10-20T12:00:00.000Z");
const EXPIRED_LONG_AGO = new Date(NOW.getTime() - 30 * DAY_MS);
const IN_GRACE = new Date(NOW.getTime() - 2 * DAY_MS);
const FUTURE = new Date(NOW.getTime() + 10 * DAY_MS);

type TenantRow = { subscriptionStatus: string; expiresAt: Date | null };

const LOCKED: Array<[string, TenantRow]> = [
  ["stored PENDING", { subscriptionStatus: "PENDING", expiresAt: null }],
  ["stored EXPIRED", { subscriptionStatus: "EXPIRED", expiresAt: EXPIRED_LONG_AGO }],
  ["ACTIVE, long past grace", { subscriptionStatus: "ACTIVE", expiresAt: EXPIRED_LONG_AGO }],
  [
    "ACTIVE, 1ms past lockAt",
    { subscriptionStatus: "ACTIVE", expiresAt: new Date(NOW.getTime() - GRACE_MS - 1) },
  ],
];

const WRITABLE: Array<[string, TenantRow]> = [
  ["ACTIVE before expiry", { subscriptionStatus: "ACTIVE", expiresAt: FUTURE }],
  ["ACTIVE with null expiresAt (platform-internal)", { subscriptionStatus: "ACTIVE", expiresAt: null }],
  ["GRACE (2 days after expiry)", { subscriptionStatus: "ACTIVE", expiresAt: IN_GRACE }],
  [
    "exactly at lockAt (still GRACE)",
    { subscriptionStatus: "ACTIVE", expiresAt: new Date(NOW.getTime() - GRACE_MS) },
  ],
];

function batchReq() {
  return new Request("http://localhost/api/inventory/batches", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ productId: "p-1", batchNumber: "B-1", quantity: "1" }),
  });
}

function setJwtClaims(status: string, expiresAt: Date | null) {
  H.sessionState.session.user.subscriptionStatus = status;
  H.sessionState.session.user.subscriptionExpiresAt = expiresAt;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
  H.mockTenantFindUnique.mockReset();
  setJwtClaims("ACTIVE", null); // stale-looking token by default
});

afterEach(() => {
  vi.useRealTimers();
});

describe("T6c — assertTenantWritable (real guard, fresh DB read)", () => {
  it.each(LOCKED)("throws SubscriptionLockedError: %s", async (_name, row) => {
    H.mockTenantFindUnique.mockResolvedValue(row);
    await expect(assertTenantWritable("tenant-1")).rejects.toBeInstanceOf(SubscriptionLockedError);
  });

  it.each(WRITABLE)("is writable: %s", async (_name, row) => {
    H.mockTenantFindUnique.mockResolvedValue(row);
    await expect(assertTenantWritable("tenant-1")).resolves.toBeDefined();
  });

  it("GRACE is writable (no 403)", async () => {
    H.mockTenantFindUnique.mockResolvedValue({ subscriptionStatus: "ACTIVE", expiresAt: IN_GRACE });
    await expect(assertTenantWritable("tenant-1")).resolves.toBe("ACTIVE");
  });

  it("exact lock boundary through the real guard: now == lockAt writable, +1ms locked", async () => {
    H.mockTenantFindUnique.mockResolvedValue({
      subscriptionStatus: "ACTIVE",
      expiresAt: new Date(NOW.getTime() - GRACE_MS), // lockAt == NOW
    });
    await expect(assertTenantWritable("tenant-1")).resolves.toBeDefined();
    vi.setSystemTime(new Date(NOW.getTime() + 1));
    await expect(assertTenantWritable("tenant-1")).rejects.toBeInstanceOf(SubscriptionLockedError);
  });

  it("reads the DB on every call (no per-process status cache)", async () => {
    H.mockTenantFindUnique.mockResolvedValueOnce({ subscriptionStatus: "ACTIVE", expiresAt: FUTURE });
    await expect(assertTenantWritable("tenant-1")).resolves.toBeDefined();
    H.mockTenantFindUnique.mockResolvedValueOnce({ subscriptionStatus: "EXPIRED", expiresAt: EXPIRED_LONG_AGO });
    await expect(assertTenantWritable("tenant-1")).rejects.toBeInstanceOf(SubscriptionLockedError);
    expect(H.mockTenantFindUnique).toHaveBeenCalledTimes(2);
  });

  it("[probe] a missing tenant row fails closed", async () => {
    H.mockTenantFindUnique.mockResolvedValue(null);
    await expect(assertTenantWritable("tenant-1")).rejects.toThrow();
  });
});

describe("T6c — direct mutating API call (launch-blocking)", () => {
  it.each(LOCKED)("403 SUBSCRIPTION_LOCKED and zero writes: %s (JWT says ACTIVE)", async (_name, row) => {
    // The token claims ACTIVE (set in beforeEach): the 403 must come from the fresh DB read.
    H.mockTenantFindUnique.mockResolvedValue(row);
    const res = await createBatchHandler(batchReq());
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("SUBSCRIPTION_LOCKED");
    expect(H.mockTenantFindUnique).toHaveBeenCalled(); // decided from the DB, not the token
    expect(H.mockProductBatch.create).not.toHaveBeenCalled(); // blocked BEFORE any write
  });

  it.each(WRITABLE)("not blocked by the lock: %s", async (_name, row) => {
    H.mockTenantFindUnique.mockResolvedValue(row);
    const res = await createBatchHandler(batchReq());
    // The mocked catalog may still yield 400/404 further down; what matters is that
    // the subscription lock did not reject it (and that the route is not simply
    // returning 403/401 for every request).
    expect(res.status).not.toBe(403);
    expect(res.status).not.toBe(401);
    expect(H.mockTenantFindUnique).toHaveBeenCalled();
  });

  it.each([
    ["EXPIRED", EXPIRED_LONG_AGO],
    ["PENDING", null],
  ] as const)("stale JWT in the other direction: token says %s, DB says ACTIVE → not blocked", async (claim, exp) => {
    // Mid-session unblock: approval happened after the token was issued.
    setJwtClaims(claim, exp);
    H.mockTenantFindUnique.mockResolvedValue({ subscriptionStatus: "ACTIVE", expiresAt: FUTURE });
    const res = await createBatchHandler(batchReq());
    expect(res.status).not.toBe(403);
    expect(res.status).not.toBe(401);
  });
});

describe("T6c — lockout exemptions", () => {
  it("exempt paths stay reachable when locked (named constants)", () => {
    expect(isLockoutExemptPath("/api/billing/status")).toBe(true);
    expect(isLockoutExemptPath("/api/billing/subscriptions")).toBe(true);
    expect(isLockoutExemptPath("/api/billing/subscriptions/x/receipt")).toBe(true);
    expect(isLockoutExemptPath("/account-locked")).toBe(true);
    expect(isLockoutExemptPath("/settings/billing")).toBe(true);
    expect(isLockoutExemptPath("/login")).toBe(true);
    expect(isLockoutExemptPath("/register")).toBe(true);
    // Future T7 data-export surface must already be exempt.
    expect(isLockoutExemptPath("/api/export")).toBe(true);
    expect(isLockoutExemptPath("/settings/export")).toBe(true);
    // The exemption lives in ONE named constant pair.
    expect(SUBSCRIPTION_LOCKOUT_EXEMPT_API_PREFIXES).toContain("/api/billing/status");
    expect(SUBSCRIPTION_LOCKOUT_EXEMPT_PAGE_PREFIXES).toContain("/account-locked");
  });

  it("matching respects path-segment boundaries (near-miss names are NOT exempt)", () => {
    expect(isLockoutExemptPath("/api/billing/subscriptionsFoo")).toBe(false);
    expect(isLockoutExemptPath("/api/billing/statusX")).toBe(false);
    expect(isLockoutExemptPath("/api/billingX/status")).toBe(false);
    expect(isLockoutExemptPath("/account-lockedX")).toBe(false);
  });

  it("mutating and sync routes stay guarded", () => {
    for (const p of [
      "/api/inventory/batches",
      "/api/inventory/products",
      "/api/sync",
      "/api/orders",
      "/api/upload/receipt",
    ]) {
      expect(isLockoutExemptPath(p), p).toBe(false);
    }
  });

  it.each([
    ["PENDING", { subscriptionStatus: "PENDING", expiresAt: null }, "PENDING"],
    ["EXPIRED", { subscriptionStatus: "ACTIVE", expiresAt: EXPIRED_LONG_AGO }, "EXPIRED"],
  ] as const)("the billing status route answers 200 for a locked (%s) ADMIN", async (_n, row, expected) => {
    H.mockTenantFindUnique.mockResolvedValue(row);
    const res = await billingStatusHandler();
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe(expected);
  });
});