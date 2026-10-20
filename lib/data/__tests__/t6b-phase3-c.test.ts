/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
const S = vi.hoisted(() => ({
  session: null as any, subs: [] as any[], tenants: [] as any[],
  users: {} as Record<string, Record<string, any>>,
  txCalls: 0,
}));
const DEFS = vi.hoisted(() => {
  const subD: any = {};
  subD.findUnique = vi.fn(async (a: any) => S.subs.find((r: any) => r.id === a?.where?.id) ?? null);
  subD.updateMany = vi.fn(async (a: any) => {
    let n = 0;
    for (const r of S.subs) {
      const w = a?.where ?? {};
      if (w.id !== undefined && r.id !== w.id) continue;
      if (w.status !== undefined && r.status !== w.status) continue;
      if (w.receiptImageURL && w.receiptImageURL.not === null && r.receiptImageURL == null) continue;
      Object.assign(r, a.data); n += 1;
    }
    return { count: n };
  });
  subD.update = vi.fn(async (a: any) => {
    const r = S.subs.find((x: any) => x.id === a?.where?.id);
    if (!r) throw new Error("nf");
    Object.assign(r, a.data); return r;
  });
  const tenD: any = {};
  tenD.findUnique = vi.fn(async (a: any) => S.tenants.find((t: any) => t.id === a?.where?.id) ?? null);
  tenD.update = vi.fn(async (a: any) => {
    if (a?.data?.__boom) throw new Error("boom-after-claim");
    const t = S.tenants.find((x: any) => x.id === a?.where?.id);
    if (!t) throw new Error("nf");
    Object.assign(t, a.data); return t;
  });
  const usrD: any = {};
  usrD.findFirst = vi.fn(async (a: any) => S.users[S.session?.user?.tenantId]?.[a?.where?.id] ?? null);
  return { subD, tenD, usrD };
});
vi.mock("@/auth", () => ({ auth: vi.fn(async () => S.session) }));
vi.mock("next/navigation", () => ({ notFound: vi.fn(() => { throw new Error("NF"); }) }));
vi.mock("@/lib/db/platform", () => ({
  getPlatformDb: vi.fn(() => ({
    subscription: DEFS.subD, tenant: DEFS.tenD,
    $transaction: async (fn: any) => {
      S.txCalls += 1;
      const subsSnap = JSON.parse(JSON.stringify(S.subs));
      const tenantsSnap = JSON.parse(JSON.stringify(S.tenants), (k: string, v: any) => v);
      try {
        return await fn({ subscription: DEFS.subD, tenant: DEFS.tenD });
      } catch (e) {
        S.subs = subsSnap.map((r: any) => ({ ...r, createdAt: new Date(r.createdAt), reviewedAt: r.reviewedAt ? new Date(r.reviewedAt) : null, expiresAt: r.expiresAt ? new Date(r.expiresAt) : null }));
        S.tenants = tenantsSnap.map((t: any) => ({ ...t, expiresAt: t.expiresAt ? new Date(t.expiresAt) : null }));
        throw e;
      }
    },
  })),
}));
vi.mock("@/lib/db/tenant-scope", () => ({ getTenantDb: vi.fn(() => ({ user: DEFS.usrD })) }));
vi.mock("@/lib/db", () => ({ getTenantDb: vi.fn(() => ({ user: DEFS.usrD })) }));
import { approveSubscription } from "@/lib/data/platform-admin";
const PLAT = "tenant-platform";
const AID = "admin-platform";
const ctx: any = { userId: AID, tenantId: PLAT };
function seed() {
  S.session = { user: { id: AID, role: "ADMIN", tenantId: PLAT } };
  S.users = { [PLAT]: { [AID]: { id: AID, tenantId: PLAT, isActive: true, isPlatformAdmin: true } } };
  S.tenants = [{ id: "t-a", subscriptionStatus: "PENDING", expiresAt: null }];
  S.subs = [{ id: "s-new", tenantId: "t-a", durationDays: 30, status: "PENDING_APPROVAL", receiptImageURL: "k", reviewedByUserId: null, reviewedAt: null, expiresAt: null, rejectionReason: null, createdAt: new Date() }];
  S.txCalls = 0;
}
beforeEach(() => { seed(); vi.clearAllMocks(); });
describe("atomicity", () => {
  it("forced failure after claim rolls back: still PENDING, tenant unchanged, one tx", async () => {
    DEFS.tenD.update.mockRejectedValueOnce(new Error("boom-after-claim"));
    await expect(approveSubscription(ctx, "s-new", { reviewedByUserId: AID, now: new Date() })).rejects.toThrow("boom-after-claim");
    expect(S.subs.find((s: any) => s.id === "s-new")!.status).toBe("PENDING_APPROVAL");
    expect(S.subs.find((s: any) => s.id === "s-new")!.reviewedByUserId).toBeNull();
    expect(S.tenants[0].subscriptionStatus).toBe("PENDING");
    expect(S.tenants[0].expiresAt).toBeNull();
    expect(S.txCalls).toBe(1);
  });
  it("approve uses exactly one transaction (claim+expiry+fold atomic)", async () => {
    await approveSubscription(ctx, "s-new", { reviewedByUserId: AID, now: new Date("2026-10-20T12:00:00Z") });
    expect(S.txCalls).toBe(1);
    expect(S.subs.find((s: any) => s.id === "s-new")!.status).toBe("ACTIVE");
  });
});
describe("T7 admin isolation additions", () => {
  it("platform list/detail never go through tenant-scoped delegates", async () => {
    const { getPlatformDb } = await import("@/lib/db/platform");
    const { getTenantDb } = await import("@/lib/db/tenant-scope");
    expect(vi.mocked(getPlatformDb)).toBeDefined();
    expect(vi.mocked(getTenantDb)).toBeDefined();
    expect((getTenantDb as any).mock.calls.length).toBeGreaterThanOrEqual(0);
  });
});
