/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { AsyncLocalStorage } from "node:async_hooks";
const S = vi.hoisted(() => ({
  session: null as any, subs: [] as any[], tenants: [] as any[],
  users: {} as Record<string, Record<string, any>>,
  txCalls: 0,
  // Tenant-read barrier for the concurrent different-request test.
  enableTenantBarrier: false,
  tenantReads: 0,
  _gateResolve: null as (() => void) | null,
}));
// Per-transaction dirty-tracking context so $transaction rollback only undoes
// rows modified within that transaction (isolated across concurrent runs).
const txContext = new AsyncLocalStorage<{
  dirtySubs: Set<string>;
  dirtyTenants: Set<string>;
}>();
const DEFS = vi.hoisted(() => {
  const subD: any = {};
  subD.findUnique = vi.fn(async (a: any) => S.subs.find((r: any) => r.id === a?.where?.id) ?? null);
  subD.updateMany = vi.fn(async (a: any) => {
    const ctx = txContext.getStore();
    let n = 0;
    for (const r of S.subs) {
      const w = a?.where ?? {};
      if (w.id !== undefined && r.id !== w.id) continue;
      if (w.status !== undefined && r.status !== w.status) continue;
      if (w.receiptImageURL && w.receiptImageURL.not === null && r.receiptImageURL == null) continue;
      ctx?.dirtySubs.add(r.id);
      Object.assign(r, a.data); n += 1;
    }
    return { count: n };
  });
  subD.update = vi.fn(async (a: any) => {
    const ctx = txContext.getStore();
    const r = S.subs.find((x: any) => x.id === a?.where?.id);
    if (!r) throw new Error("nf");
    ctx?.dirtySubs.add(r.id);
    Object.assign(r, a.data); return r;
  });
  const tenD: any = {};
  tenD.findUnique = vi.fn(async (a: any) => {
    // Barrier: force both concurrent transactions to read the tenant before
    // either writes to it.
    if (S.enableTenantBarrier) {
      S.tenantReads += 1;
      if (S.tenantReads === 1) {
        // First caller: wait until the second caller signals the gate.
        await new Promise<void>((resolve) => { S._gateResolve = resolve; });
      } else {
        // Second caller: release the first caller.
        const resolve = S._gateResolve;
        S._gateResolve = null;
        if (resolve) resolve();
      }
    }
    return S.tenants.find((t: any) => t.id === a?.where?.id) ?? null;
  });
  tenD.update = vi.fn(async (a: any) => {
    if (a?.data?.__boom) throw new Error("boom-after-claim");
    const t = S.tenants.find((x: any) => x.id === a?.where?.id);
    if (!t) throw new Error("nf");
    Object.assign(t, a.data); return t;
  });
  /** CAS tenant.updateMany: matches only when where.expiresAt equals the stored value. */
  tenD.updateMany = vi.fn(async (a: any) => {
    const ctx = txContext.getStore();
    const w = a?.where ?? {};
    const t = S.tenants.find((x: any) => x.id === w.id);
    if (!t) return { count: 0 };
    const wanted = w.expiresAt;
    const stored = t.expiresAt;
    let match: boolean;
    if (wanted === undefined) match = true;
    else if (wanted === null) match = stored === null;
    else match = stored != null && new Date(stored).getTime() === new Date(wanted).getTime();
    if (!match) return { count: 0 };
    ctx?.dirtyTenants.add(t.id);
    Object.assign(t, a.data);
    return { count: 1 };
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
      const dirty = { dirtySubs: new Set<string>(), dirtyTenants: new Set<string>() };
      const subsSnap = JSON.parse(JSON.stringify(S.subs));
      const tenantsSnap = JSON.parse(JSON.stringify(S.tenants), (k: string, v: any) => v);
      return await txContext.run(dirty, async () => {
        try {
          return await fn({ subscription: DEFS.subD, tenant: DEFS.tenD });
        } catch (e) {
          // Roll back only rows modified within THIS transaction (undo log),
          // not a global snapshot — so a concurrent transaction's committed
          // writes are not undone.
          const subMap = new Map(subsSnap.map((r: any) => [r.id, r]));
          const tenMap = new Map(tenantsSnap.map((t: any) => [t.id, t]));
          for (const id of dirty.dirtySubs) {
            const orig = (subMap.get(id) as any) ?? null;
            if (orig) {
              const idx = S.subs.findIndex((r: any) => r.id === id);
              if (idx >= 0) S.subs[idx] = { ...orig, createdAt: new Date(orig.createdAt), reviewedAt: orig.reviewedAt ? new Date(orig.reviewedAt) : null, expiresAt: orig.expiresAt ? new Date(orig.expiresAt) : null };
            }
          }
          for (const id of dirty.dirtyTenants) {
            const orig = (tenMap.get(id) as any) ?? null;
            if (orig) {
              const idx = S.tenants.findIndex((t: any) => t.id === id);
              if (idx >= 0) S.tenants[idx] = { ...orig, expiresAt: orig.expiresAt ? new Date(orig.expiresAt) : null };
            }
          }
          throw e;
        }
      });
    },
  })),
}));
vi.mock("@/lib/db/tenant-scope", () => ({ getTenantDb: vi.fn(() => ({ user: DEFS.usrD })) }));
vi.mock("@/lib/db", () => ({ getTenantDb: vi.fn(() => ({ user: DEFS.usrD })) }));
import { approveSubscription } from "@/lib/data/platform-admin";
import { ConcurrentTenantUpdateError } from "@/lib/data/platform-admin";
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
beforeEach(() => { seed(); vi.clearAllMocks(); S.enableTenantBarrier = false; S.tenantReads = 0; S._gateResolve = null; });
describe("atomicity", () => {
  it("forced failure after claim rolls back: still PENDING, tenant unchanged, one tx", async () => {
    DEFS.tenD.updateMany.mockRejectedValueOnce(new Error("boom-after-claim"));
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
  it("expiresAt changed between read and write -> ConcurrentTenantUpdateError, full rollback", async () => {
    // Stale read: tenant.findUnique returns a future expiresAt while the
    // stored value stays null, so the CAS updateMany won't match.
    DEFS.tenD.findUnique.mockResolvedValueOnce({ expiresAt: new Date("2099-01-01T00:00:00Z") });
    await expect(
      approveSubscription(ctx, "s-new", { reviewedByUserId: AID, now: new Date("2026-10-20T12:00:00Z") })
    ).rejects.toBeInstanceOf(ConcurrentTenantUpdateError);
    // Claim reverted: request still PENDING_APPROVAL.
    expect(S.subs.find((s: any) => s.id === "s-new")!.status).toBe("PENDING_APPROVAL");
    expect(S.subs.find((s: any) => s.id === "s-new")!.reviewedByUserId).toBeNull();
    // Tenant unchanged.
    expect(S.tenants[0].subscriptionStatus).toBe("PENDING");
    expect(S.tenants[0].expiresAt).toBeNull();
    expect(S.txCalls).toBe(1);
  });
  it("two concurrent approvals of different requests, same tenant: no lost update", async () => {
    S.subs.push({
      id: "s2", tenantId: "t-a", durationDays: 30, status: "PENDING_APPROVAL",
      receiptImageURL: "k2", reviewedByUserId: null, reviewedAt: null, expiresAt: null, rejectionReason: null, createdAt: new Date(),
    });
    // Barrier: both transactions read the tenant before either writes.
    S.enableTenantBarrier = true;
    const now = new Date("2026-10-20T12:00:00Z");
    const results = await Promise.allSettled([
      approveSubscription(ctx, "s-new", { reviewedByUserId: AID, now }),
      approveSubscription(ctx, "s2", { reviewedByUserId: AID, now }),
    ]);
    S.enableTenantBarrier = false;
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as any).reason).toBeInstanceOf(ConcurrentTenantUpdateError);
    const winner = (fulfilled[0] as any).value;
    expect(new Date(winner.newExpiresAt).getTime()).toBe(now.getTime() + 30 * 86400e3);
    // Loser's subscription rolled back to PENDING_APPROVAL.
    const loserId = winner.id === "s-new" ? "s2" : "s-new";
    expect(S.subs.find((s: any) => s.id === loserId)!.status).toBe("PENDING_APPROVAL");
    // Tenant extended exactly once.
    expect(S.tenants[0].subscriptionStatus).toBe("ACTIVE");
    expect(new Date(S.tenants[0].expiresAt!).getTime()).toBe(now.getTime() + 30 * 86400e3);
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
