/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
const S = vi.hoisted(() => ({
  session: null as any, subs: [] as any[], tenants: [] as any[],
  users: {} as Record<string, Record<string, any>>,
  reports: [] as any[], entries: [] as any[], platformRow: null as any,
}));
const DEFS = vi.hoisted(() => {
  const subD: any = {};
  subD.findUnique = vi.fn(async (a: any) => S.subs.find((r: any) => r.id === a?.where?.id) ?? null);
  subD.updateMany = vi.fn(async (a: any) => {
    let n = 0;
    for (const r of S.subs) {
      const w = a?.where ?? {};
      if (w.id !== undefined) {
        if (typeof w.id === "string" && r.id !== w.id) continue;
        if (typeof w.id === "object" && w.id !== null && w.id.not !== undefined && r.id === w.id.not) continue;
      }
      if (w.tenantId !== undefined && r.tenantId !== w.tenantId) continue;
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
  tenD.findUnique = vi.fn(async (a: any) => {
    if (a?.where?.slug === "platform-internal") return S.platformRow;
    return S.tenants.find((t: any) => t.id === a?.where?.id) ?? null;
  });
  tenD.update = vi.fn(async (a: any) => {
    if (a?.where?.slug === "platform-internal") {
      S.platformRow = { ...(S.platformRow ?? {}), dailyExchangeRate: a.data.dailyExchangeRate, updatedAt: new Date("2026-10-20T12:00:00Z") };
      return S.platformRow;
    }
    const t = S.tenants.find((x: any) => x.id === a?.where?.id);
    if (!t) throw new Error("nf");
    Object.assign(t, a.data); return t;
  });
  const usrD: any = {};
  usrD.findFirst = vi.fn(async (a: any) => S.users[S.session?.user?.tenantId]?.[a?.where?.id] ?? null);
  const repD: any = {};
  repD.findUnique = vi.fn(async (a: any) => S.reports.find((r: any) => r.id === a?.where?.id) ?? null);
  repD.updateMany = vi.fn(async (a: any) => {
    let n = 0;
    for (const r of S.reports) {
      const w = a?.where ?? {};
      if (w.id !== undefined && r.id !== w.id) continue;
      if (w.status !== undefined && r.status !== w.status) continue;
      Object.assign(r, a.data); n += 1;
    }
    return { count: n };
  });
  const entD: any = {};
  entD.update = vi.fn(async (a: any) => {
    const e = S.entries.find((x: any) => x.id === a?.where?.id);
    if (!e) throw new Error("nf");
    Object.assign(e, a.data); return e;
  });
  return { subD, tenD, usrD, repD, entD };
});
vi.mock("@/auth", () => ({ auth: vi.fn(async () => S.session) }));
vi.mock("next/navigation", () => ({ notFound: vi.fn(() => { throw new Error("NF"); }) }));
vi.mock("@/lib/db/platform", () => ({
  getPlatformDb: vi.fn(() => ({
    subscription: DEFS.subD, tenant: DEFS.tenD,
    productCatalogEntryReport: DEFS.repD, productCatalogEntry: DEFS.entD,
    $transaction: async (fn: any) => fn({ subscription: DEFS.subD, tenant: DEFS.tenD, productCatalogEntryReport: DEFS.repD, productCatalogEntry: DEFS.entD }),
  })),
}));
vi.mock("@/lib/db/tenant-scope", () => ({ getTenantDb: vi.fn(() => ({ user: DEFS.usrD })) }));
vi.mock("@/lib/db", () => ({ getTenantDb: vi.fn(() => ({ user: DEFS.usrD })) }));

import { POST as approveH } from "@/app/api/admin/subscriptions/[id]/approve/route";
import { POST as rejectH } from "@/app/api/admin/subscriptions/[id]/reject/route";
import { PUT as ratePutH, GET as rateGetH } from "@/app/api/admin/platform-rate/route";
import { POST as rslvH } from "@/app/api/admin/catalog-reports/[id]/resolve/route";
import { POST as dsmH } from "@/app/api/admin/catalog-reports/[id]/dismiss/route";
import { approveSubscription, rejectSubscription } from "@/lib/data/platform-admin";
import { SubscriptionAlreadyReviewedError } from "@/lib/data/platform-admin";
import { SubscriptionReceiptRequiredError } from "@/lib/data/platform-admin";
import { SubscriptionNotFoundError } from "@/lib/data/platform-admin";
import { resolveCatalogReport, dismissCatalogReport } from "@/lib/data/platform-admin";
import { CatalogReportNotFoundError } from "@/lib/data/platform-admin";
import { CatalogReportAlreadyProcessedError } from "@/lib/data/platform-admin";
import { setPlatformRate, InvalidPlatformRateError } from "@/lib/data/platform-admin";
const PLAT = "tenant-platform";
const AID = "admin-platform";
const DAY = 86400e3;
const pFor = (id: string) => ({ params: Promise.resolve({ id }) });
const pReq = (b?: unknown) => new NextRequest("http://localhost/x", { method: "POST", body: b === undefined ? undefined : JSON.stringify(b) });
function seed() {
  S.session = { user: { id: AID, role: "ADMIN", tenantId: PLAT } };
  S.users = { [PLAT]: { [AID]: { id: AID, tenantId: PLAT, isActive: true, isPlatformAdmin: true } } };
  S.tenants = [
    { id: PLAT, slug: "platform-internal", subscriptionStatus: "ACTIVE", expiresAt: null },
    { id: "t-a", slug: "s-a", name: "AAA", subscriptionStatus: "PENDING", expiresAt: null },
    { id: "t-b", slug: "s-b", name: "BBB", subscriptionStatus: "ACTIVE", expiresAt: new Date("2026-11-01T00:00:00Z") },
  ];
  S.platformRow = { dailyExchangeRate: "15000", updatedAt: new Date("2026-10-19T00:00:00Z") };
  S.subs = [
    { id: "s-new", tenantId: "t-a", durationDays: 30, status: "PENDING_APPROVAL", receiptImageURL: "k1", reviewedByUserId: null, reviewedAt: null, expiresAt: null, rejectionReason: null, createdAt: new Date() },
    { id: "s-norcp", tenantId: "t-a", durationDays: 30, status: "PENDING_APPROVAL", receiptImageURL: null, reviewedByUserId: null, reviewedAt: null, expiresAt: null, rejectionReason: null, createdAt: new Date() },
    { id: "s-old", tenantId: "t-a", durationDays: 30, status: "ACTIVE", receiptImageURL: "k", reviewedByUserId: AID, reviewedAt: new Date(), expiresAt: new Date(), rejectionReason: null, createdAt: new Date() },
  ];
  S.entries = [{ id: "e1", name: "old", category: "c", imageUrl: null, addedByTenantId: "t-a" }];
  S.reports = [{ id: "r1", catalogEntryId: "e1", reportedByTenantId: "t-b", reason: "x", suggestedName: "new", suggestedCategory: null, suggestedImageUrl: null, status: "PENDING", createdAt: new Date(), resolvedAt: null }];
}
beforeEach(() => { seed(); vi.clearAllMocks(); });
describe("auth", () => {
  it("non-platform ADMIN + CASHIER 403; deactivated 403; stale JWT 403", async () => {
    S.users = { "t-a": { x: { id: "x", tenantId: "t-a", isActive: true, isPlatformAdmin: false } } };
    S.session = { user: { id: "x", role: "ADMIN", tenantId: "t-a" } };
    expect((await approveH(pReq(), pFor("s-new"))).status).toBe(403);
    expect((await rejectH(pReq({ reason: "سبب كاف" }), pFor("s-new"))).status).toBe(403);
    expect((await rateGetH()).status).toBe(403);
    expect((await rslvH(pReq({ apply: true }), pFor("r1"))).status).toBe(403);
    expect((await dsmH(pReq(), pFor("r1"))).status).toBe(403);
    S.session = { user: { id: "x", role: "CASHIER", tenantId: "t-a" } };
    expect((await approveH(pReq(), pFor("s-new"))).status).toBe(403);
    S.users = { [PLAT]: { [AID]: { id: AID, tenantId: PLAT, isActive: false, isPlatformAdmin: true } } };
    S.session = { user: { id: AID, role: "ADMIN", tenantId: PLAT } };
    expect((await approveH(pReq(), pFor("s-new"))).status).toBe(403);
    S.users = { [PLAT]: { [AID]: { id: AID, tenantId: PLAT, isActive: true, isPlatformAdmin: false } } };
    expect((await approveH(pReq(), pFor("s-new"))).status).toBe(403);
  });
});
describe("approve", () => {
  const ctx: any = { userId: AID, tenantId: PLAT };
  it("first approval null expiry = now+duration, folds others", async () => {
    const now = new Date("2026-10-20T12:00:00Z");
    const r = await approveSubscription(ctx, "s-new", { reviewedByUserId: AID, now });
    expect(new Date(r.newExpiresAt).getTime()).toBe(now.getTime() + 30 * DAY);
    expect(S.tenants.find((t: any) => t.id === "t-a")!.subscriptionStatus).toBe("ACTIVE");
    expect(S.subs.find((s: any) => s.id === "s-old")!.status).toBe("EXPIRED");
  });
  it("stacking + frozen duration", async () => {
    const t = S.tenants.find((x: any) => x.id === "t-b")!;
    t.subscriptionStatus = "PENDING";
    S.subs.push({ id: "sr", tenantId: "t-b", durationDays: 30, status: "PENDING_APPROVAL", receiptImageURL: "k", reviewedByUserId: null, reviewedAt: null, expiresAt: null, rejectionReason: null, createdAt: new Date() });
    const now = new Date("2026-10-20T12:00:00Z");
    const r = await approveSubscription(ctx, "sr", { reviewedByUserId: AID, now });
    expect(new Date(r.newExpiresAt).getTime()).toBe(new Date("2026-11-01T00:00:00Z").getTime() + 30 * DAY);
    t.expiresAt = new Date("2026-01-01T00:00:00Z");
    S.subs.push({ id: "sl", tenantId: "t-b", durationDays: 45, status: "PENDING_APPROVAL", receiptImageURL: "k", reviewedByUserId: null, reviewedAt: null, expiresAt: null, rejectionReason: null, createdAt: new Date() });
    const r2 = await approveSubscription(ctx, "sl", { reviewedByUserId: AID, now });
    expect(new Date(r2.newExpiresAt).getTime()).toBe(now.getTime() + 45 * DAY);
  });
  it("no receipt 409; double approve one wins; race one wins; 404+400", async () => {
    await expect(approveSubscription(ctx, "s-norcp", { reviewedByUserId: AID, now: new Date() })).rejects.toBeInstanceOf(SubscriptionReceiptRequiredError);
    expect((await approveH(pReq(), pFor("s-norcp"))).status).toBe(409);
    const now = new Date("2026-10-20T12:00:00Z");
    const both = await Promise.allSettled([
      approveSubscription(ctx, "s-new", { reviewedByUserId: AID, now }),
      approveSubscription(ctx, "s-new", { reviewedByUserId: AID, now }),
    ]);
    expect(both.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(both.filter((r) => r.status === "rejected")).toHaveLength(1);
    seed(); vi.clearAllMocks();
    const race = await Promise.allSettled([
      approveSubscription(ctx, "s-new", { reviewedByUserId: AID, now: new Date() }),
      rejectSubscription(ctx, "s-new", { reason: "سبب كاف للرفض", reviewedByUserId: AID, now: new Date() }),
    ]);
    expect(race.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    await expect(approveSubscription(ctx, "nope", { reviewedByUserId: AID, now: new Date() })).rejects.toBeInstanceOf(SubscriptionNotFoundError);
    for (const bad of [{}, { reason: "ab" }]) expect((await rejectH(pReq(bad), pFor("s-new"))).status).toBe(400);
  });
});
describe("reject+rate+catalog", () => {
  const ctx: any = { userId: AID, tenantId: PLAT };
  it("reject 4 fields, tenant untouched", async () => {
    const now = new Date("2026-10-20T12:00:00Z");
    await rejectSubscription(ctx, "s-norcp", { reason: "سبب كاف", reviewedByUserId: AID, now });
    expect(S.subs.find((s: any) => s.id === "s-norcp")!.status).toBe("REJECTED");
    expect(S.tenants.find((t: any) => t.id === "t-a")!.subscriptionStatus).toBe("PENDING");
    await rejectSubscription(ctx, "s-new", { reason: "سبب كاف للرفض", reviewedByUserId: AID, now: new Date() });
    await expect(rejectSubscription(ctx, "s-new", { reason: "سبب اخر كاف", reviewedByUserId: AID, now: new Date() })).rejects.toBeInstanceOf(SubscriptionAlreadyReviewedError);
  });
  it("rate validation + confirm", async () => {
    for (const bad of ["0", "abc", "1000001"]) expect((await ratePutH(pReq({ rate: bad })))).toBeTruthy();
    await expect(setPlatformRate({ userId: AID, tenantId: PLAT } as any, { rate: "0" })).rejects.toBeInstanceOf(InvalidPlatformRateError);
    expect((await ratePutH(pReq({ rate: "16000" }))).status).toBe(200);
    expect((await ratePutH(pReq({ rate: "30000" }))).status).toBe(409);
  });
  it("catalog race-safe, dismiss never mutates", async () => {
    await resolveCatalogReport(ctx, "r1", { apply: true, now: new Date() });
    expect(S.entries[0].name).toBe("new");
    seed(); vi.clearAllMocks();
    await dismissCatalogReport(ctx, "r1", { now: new Date() });
    expect(DEFS.entD.update).not.toHaveBeenCalled();
    await expect(dismissCatalogReport(ctx, "r1", { now: new Date() })).rejects.toBeInstanceOf(CatalogReportAlreadyProcessedError);
    await expect(dismissCatalogReport(ctx, "nope", { now: new Date() })).rejects.toBeInstanceOf(CatalogReportNotFoundError);
    expect((await rslvH(pReq({ apply: false }), pFor("r1"))).status).toBe(409);
    expect((await dsmH(pReq(), pFor("nope"))).status).toBe(404);
  });
});
