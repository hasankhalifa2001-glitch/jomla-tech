/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * T6c §5 — Daily subscription reconciliation cron tests.
 *
 *   - Idempotent, safe to run twice.
 *   - Flips only stored ACTIVE tenants whose expiresAt + grace has passed
 *     (and their ACTIVE subscription rows → EXPIRED).
 *   - System-rejects stale receipt-less offers (PENDING_APPROVAL, no receipt,
 *     older than the offer-validity window).
 *   - Protected by CRON_SECRET: missing/wrong → 401, no work done.
 *
 * MOCKED: prisma from @/lib/db, process.env.CRON_SECRET.
 * REAL: the GET handler + isAuthorizedCron.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const DAY_MS = 24 * 60 * 60 * 1000;
const GRACE_DAYS = 5;
const OFFER_VALIDITY_HOURS = 24;

const SECRET = "test-cron-secret-12345";

const now = new Date("2026-10-20T12:00:00.000Z");
// lockCutoff = now - 5 days = 2026-10-15T12:00:00.000Z
const lockCutoff = new Date(now.getTime() - GRACE_DAYS * DAY_MS);
// offerCutoff = now - 24h = 2026-10-19T12:00:00.000Z
const offerCutoff = new Date(now.getTime() - OFFER_VALIDITY_HOURS * 60 * 60 * 1000);

const { prismaMock } = vi.hoisted(() => {
  const prismaMock: any = {
    tenant: {
      findMany: vi.fn(),
      updateMany: vi.fn(),
    },
    subscription: {
      updateMany: vi.fn(),
    },
  };
  return { prismaMock };
});

vi.mock("@/lib/db", () => ({
  prisma: prismaMock,
}));

vi.mock("@/lib/config/subscription", () => ({
  SUBSCRIPTION_GRACE_DAYS: 5,
  SUBSCRIPTION_OFFER_VALIDITY_HOURS: 24,
}));

import { GET as cronGet } from "@/app/api/cron/reconcile-subscriptions/route";

function makeReq(authorization?: string) {
  return new NextRequest("http://localhost/api/cron/reconcile-subscriptions", {
    headers: authorization ? { authorization } : {},
  }) as any;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers().setSystemTime(now);
  process.env.CRON_SECRET = SECRET;
});

afterEach(() => {
  delete process.env.CRON_SECRET;
  vi.useRealTimers();
});

describe("T6c — cron reconcile-subscriptions", () => {
  it("missing CRON_SECRET header → 401", async () => {
    const res = await cronGet(makeReq());
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe("UNAUTHORIZED");
    expect(prismaMock.tenant.findMany).not.toHaveBeenCalled();
  });

  it("wrong CRON_SECRET → 401", async () => {
    const res = await cronGet(makeReq("Bearer wrong-secret"));
    expect(res.status).toBe(401);
    expect(prismaMock.tenant.findMany).not.toHaveBeenCalled();
  });

  it("correct secret → 200 and flips stale tenants + offers", async () => {
    prismaMock.tenant.findMany.mockResolvedValue([
      { id: "tenant-stale-1" },
      { id: "tenant-stale-2" },
    ]);
    prismaMock.tenant.updateMany.mockResolvedValue({ count: 2 });
    prismaMock.subscription.updateMany
      .mockResolvedValueOnce({ count: 3 })
      .mockResolvedValue({ count: 0 });

    const res = await cronGet(makeReq(`Bearer ${SECRET}`));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.tenantsExpired).toBe(2);
    expect(json.subscriptionsExpired).toBe(3);
    expect(json.offersRejected).toBe(0);
  });

  it("queries stale tenants with correct lock cutoff (expiresAt + grace passed)", async () => {
    prismaMock.tenant.findMany.mockResolvedValue([
      { id: "tenant-stale-1" },
    ]);
    prismaMock.tenant.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.subscription.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValue({ count: 0 });

    await cronGet(makeReq(`Bearer ${SECRET}`));
    const findManyCall = prismaMock.tenant.findMany.mock.calls[0][0];
    expect(findManyCall.where.subscriptionStatus).toBe("ACTIVE");
    expect(findManyCall.where.expiresAt).toMatchObject({
      not: null,
      lt: lockCutoff,
    });
  });

  it("is idempotent: second run flips nothing new", async () => {
    prismaMock.tenant.findMany.mockResolvedValue([
      { id: "tenant-stale-1" },
      { id: "tenant-stale-2" },
    ]);
    prismaMock.tenant.updateMany.mockResolvedValue({ count: 2 });
    prismaMock.subscription.updateMany
      .mockResolvedValueOnce({ count: 3 })
      .mockResolvedValue({ count: 0 });

    // First run flips 2 tenants.
    let res = await cronGet(makeReq(`Bearer ${SECRET}`));
    let json = await res.json();
    expect(json.tenantsExpired).toBe(2);

    // Second run: findMany returns same tenants, but tenant.updateMany with
    // where subscriptionStatus="ACTIVE" matches 0 (already EXPIRED).
    prismaMock.tenant.updateMany.mockResolvedValueOnce({ count: 0 });
    prismaMock.subscription.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValue({ count: 0 });

    res = await cronGet(makeReq(`Bearer ${SECRET}`));
    json = await res.json();
    expect(json.tenantsExpired).toBe(0);
    expect(json.subscriptionsExpired).toBe(0);
  });

  it("does not flip tenants that are not ACTIVE or not past grace", async () => {
    // findMany returns empty (no stale tenants).
    prismaMock.tenant.findMany.mockResolvedValueOnce([]);
    // offers updateMany still runs (outside the if block) → mock it.
    prismaMock.subscription.updateMany.mockResolvedValue({ count: 0 });
    const res = await cronGet(makeReq(`Bearer ${SECRET}`));
    const json = await res.json();
    expect(json.tenantsExpired).toBe(0);
    expect(json.subscriptionsExpired).toBe(0);
    expect(json.offersRejected).toBe(0);
    expect(prismaMock.tenant.updateMany).not.toHaveBeenCalled();
  });

  it("rejects stale receipt-less offers older than validity window", async () => {
    prismaMock.tenant.findMany.mockResolvedValue([
      { id: "tenant-stale-1" },
    ]);
    prismaMock.tenant.updateMany.mockResolvedValue({ count: 1 });
    // subscription.updateMany called twice: tenant subs ({count:3}), then offers ({count:5}).
    prismaMock.subscription.updateMany
      .mockResolvedValueOnce({ count: 3 })
      .mockResolvedValueOnce({ count: 5 });
    const res = await cronGet(makeReq(`Bearer ${SECRET}`));
    const json = await res.json();
    expect(json.offersRejected).toBe(5);
    const updateCall = prismaMock.subscription.updateMany.mock.calls[1][0];
    expect(updateCall.where.status).toBe("PENDING_APPROVAL");
    expect(updateCall.where.receiptImageURL).toBe(null);
    expect(updateCall.where.createdAt).toMatchObject({ lt: offerCutoff });
    expect(updateCall.data.status).toBe("REJECTED");
    expect(updateCall.data.rejectionReason).toBe("انتهت صلاحية العرض دون إرفاق إيصال.");
  });
});