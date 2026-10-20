/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * T6c — launch-blocking: a direct mutating API call on a locked tenant →
 * 403 independent of JWT staleness and of any page redirect; GRACE is
 * writable; billing/exemption routes stay reachable when locked.
 *
 * REAL: assertTenantWritable + isLockoutExemptPath + one mutating route
 * (POST /api/inventory/batches) + the billing status route.
 * MOCKED: Prisma boundary (getTenantDb/tenant db), session.
 */

const { mockTenantFindUnique, mockSessionState, mockProductBatch } = vi.hoisted(() => {
  const mockTenantFindUnique = vi.fn();
  const mockProductBatch = { create: vi.fn(async () => ({ id: "b-1" })) };
  return {
    mockTenantFindUnique,
    mockProductBatch,
    mockSessionState: {
      session: {
        user: {
          id: "admin-1",
          role: "ADMIN",
          tenantId: "tenant-1",
          // STALE JWT: claims ACTIVE while the DB may be past grace — the
          // 403 must come from the fresh DB read, not the token.
          subscriptionStatus: "ACTIVE",
          subscriptionExpiresAt: null,
        },
      } as any,
    },
  };
});

vi.mock("@/lib/db/tenant-scope", () => ({
  getTenantDb: vi.fn(() => ({
    tenant: { findUnique: mockTenantFindUnique },
    productBatch: mockProductBatch,
  })),
  tenantScopedRawQuery: vi.fn(async () => []),
}));

vi.mock("@/lib/db", () => ({
  prisma: {},
  getTenantDb: vi.fn(() => ({
    tenant: { findUnique: mockTenantFindUnique },
    productBatch: mockProductBatch,
    product: { findFirst: vi.fn(async () => null) },
    productUnit: { findMany: vi.fn(async () => []) },
  })),
}));

vi.mock("@/auth", () => ({
  auth: vi.fn(async () => mockSessionState.session),
}));

import {
  assertTenantWritable,
  isLockoutExemptPath,
  SubscriptionLockedError,
  SUBSCRIPTION_LOCKOUT_EXEMPT_API_PREFIXES,
  SUBSCRIPTION_LOCKOUT_EXEMPT_PAGE_PREFIXES,
} from "@/lib/auth/tenant";
import { POST as createBatchHandler } from "@/app/api/inventory/batches/route";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-10-20T12:00:00.000Z");
const EXPIRED_LONG_AGO = new Date(NOW.getTime() - 30 * DAY_MS);
const IN_GRACE = new Date(NOW.getTime() - 2 * DAY_MS);

function batchReq() {
  return new Request("http://localhost/api/inventory/batches", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ productId: "p-1", batchNumber: "B-1", quantity: "1" }),
  });
}

describe("T6c — lockout enforcement (launch-blocking)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionState.session.user.subscriptionStatus = "ACTIVE";
  });

  it("403 on a locked tenant independent of JWT staleness", async () => {
    // DB: stored ACTIVE but expired 30 days ago (grace = 5d → locked).
    mockTenantFindUnique.mockResolvedValue({
      subscriptionStatus: "ACTIVE",
      expiresAt: EXPIRED_LONG_AGO,
    });
    const res = await createBatchHandler(batchReq());
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("SUBSCRIPTION_LOCKED");
  });

  it("assertTenantWritable throws for stored PENDING/EXPIRED and past-grace ACTIVE", async () => {
    mockTenantFindUnique.mockResolvedValue({ subscriptionStatus: "PENDING", expiresAt: null });
    await expect(assertTenantWritable("tenant-1")).rejects.toBeInstanceOf(SubscriptionLockedError);

    mockTenantFindUnique.mockResolvedValue({
      subscriptionStatus: "EXPIRED",
      expiresAt: EXPIRED_LONG_AGO,
    });
    await expect(assertTenantWritable("tenant-1")).rejects.toBeInstanceOf(SubscriptionLockedError);

    mockTenantFindUnique.mockResolvedValue({
      subscriptionStatus: "ACTIVE",
      expiresAt: EXPIRED_LONG_AGO,
    });
    await expect(assertTenantWritable("tenant-1")).rejects.toBeInstanceOf(SubscriptionLockedError);
  });

  it("GRACE is writable (no 403)", async () => {
    mockTenantFindUnique.mockResolvedValue({
      subscriptionStatus: "ACTIVE",
      expiresAt: IN_GRACE,
    });
    await expect(assertTenantWritable("tenant-1")).resolves.toBe("ACTIVE");
  });

  it("billing/exemption routes stay reachable when locked", () => {
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
    // And the exemption lives in ONE named constant pair.
    expect(SUBSCRIPTION_LOCKOUT_EXEMPT_API_PREFIXES).toContain("/api/billing/status");
    expect(SUBSCRIPTION_LOCKOUT_EXEMPT_PAGE_PREFIXES).toContain("/account-locked");
    // Non-exempt mutating routes stay guarded.
    expect(isLockoutExemptPath("/api/inventory/batches")).toBe(false);
    expect(isLockoutExemptPath("/api/sync")).toBe(false);
  });
});

