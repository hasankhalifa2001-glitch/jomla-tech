/* eslint-disable @typescript-eslint/no-explicit-any -- test mocks: the
   tenant-scoped Prisma delegates below are hand-written fakes that READ
   the `tenantId` out of the `where` they are handed and filter an
   in-memory dataset by it, exactly as the real tenant-scope extension
   guarantees at runtime. */

/**
 * T7 — cross-tenant isolation for the T6a merchant subscription checkout.
 *
 * Billing introduced three authenticated surfaces (POST
 * /api/billing/subscriptions, POST+GET
 * /api/billing/subscriptions/[id]/receipt, GET /api/billing/status). A
 * session for tenant A must NEVER read, create against, or fetch the
 * receipt of tenant B's subscription rows, even by guessing an id.
 *
 * TECHNIQUE (mirrors lib/data/__tests__/t7-cross-tenant-orders.test.ts):
 * the fake delegates below ACTUALLY ENFORCE tenantId — each holds a shared
 * dataset with BOTH tenants' rows and filters by the `tenantId` present in
 * the incoming `where` (mirroring the getTenantDb() extension, which
 * injects tenantId into every query). So "tenant A never sees/touches
 * tenant B" holds only because the route itself passed tenantId; a route
 * bug that omitted it would surface as wrong rows.
 *
 * The fake `create` stores EXACTLY the tenantId the route put in `data`
 * (it does not overwrite it), so a route that forgot or mis-set tenantId
 * would fail the "created row belongs to the caller's tenant" assertion.
 *
 * MOCKED: getTenantDb, auth, storage private-bucket helpers.
 * REAL: the three billing route handlers + platform-rate reader.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const TENANT_A = "tenant-A";
const TENANT_B = "tenant-B";

const S = vi.hoisted(() => ({
  session: null as any,
  subs: [] as any[],
  tenants: {} as Record<string, any>,
  users: {} as Record<string, any>,
  uploads: [] as string[],
  signedArgs: [] as any[],
  subSeq: 0,
}));

function matchSub(row: any, where: any): boolean {
  if (!where) return true;
  // The real extension injects tenantId; the fake enforces it the same way:
  // a query without tenantId matches nothing (fail closed).
  if (where.tenantId === undefined) return false;
  if (row.tenantId !== where.tenantId) return false;
  if (where.id !== undefined && row.id !== where.id) return false;
  if (where.status !== undefined && row.status !== where.status) return false;
  if (where.createdAt?.lt !== undefined && !(row.createdAt < where.createdAt.lt)) return false;
  return true;
}

function dbFor(tenantId: string): any {
  const scoped = (rows: any[]) => rows.filter((r) => r.tenantId === tenantId);
  const subscription = {
    updateMany: vi.fn(async (args: any) => {
      let n = 0;
      for (const r of scoped(S.subs)) {
        if (!matchSub(r, { ...args.where, tenantId })) continue;
        Object.assign(r, args.data);
        r.updatedAt = new Date();
        n += 1;
      }
      return { count: n };
    }),
    count: vi.fn(async (a: any) => scoped(S.subs).filter((r) => matchSub(r, { ...a.where, tenantId })).length),
    create: vi.fn(async (args: any) => {
      S.subSeq += 1;
      const now = new Date();
      // NOTE: tenantId comes from args.data (what the ROUTE supplied). It is
      // deliberately not overwritten here.
      const row = {
        id: "sub-" + S.subSeq, createdAt: now, updatedAt: now,
        receiptImageURL: null, rejectionReason: null, ...args.data,
      };
      S.subs.push(row);
      return row;
    }),
    findFirst: vi.fn(async (args: any) => scoped(S.subs).filter((r) => matchSub(r, { ...args.where, tenantId }))[0] ?? null),
    findMany: vi.fn(async (args: any) => {
      let rows = scoped(S.subs).filter((r) => matchSub(r, { ...(args.where ?? {}), tenantId }));
      rows = [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      if (args.take !== undefined) rows = rows.slice(0, args.take);
      return rows;
    }),
  };
  const tenant = {
    findUnique: vi.fn(async (args: any) => {
      if (args.where.slug === "platform-internal") return { dailyExchangeRate: "11500" };
      if (args.where.id !== undefined && args.where.id !== tenantId) return null;
      const t = S.tenants[args.where.id ?? tenantId];
      return t ? { id: tenantId, ...t } : null;
    }),
  };
  const user = {
    findUnique: vi.fn(async (args: any) => {
      const u = S.users[args.where.id];
      return u ? { isActive: u.isActive } : null;
    }),
  };
  const db: any = { subscription, tenant, user };
  db.$transaction = vi.fn(async (cb: any) => cb(db));
  return db;
}

vi.mock("@/auth", () => ({ auth: vi.fn(async () => S.session) }));
vi.mock("@/lib/db", () => ({ getTenantDb: vi.fn((t: string) => dbFor(t)) }));
vi.mock("@/lib/db/tenant-scope", () => ({
  getTenantDb: vi.fn((t: string) => dbFor(t)),
  tenantScopedRawQuery: vi.fn(async () => []),
}));
vi.mock("@/lib/storage", () => ({
  uploadPrivateReceipt: vi.fn(async ({ key }: any) => {
    S.uploads.push(key);
    return key;
  }),
  removePrivateReceipt: vi.fn(async () => true),
  createReceiptSignedUrl: vi.fn(async (key: string, seconds?: number) => {
    S.signedArgs.push({ key, seconds: seconds ?? 300 });
    return "https://storage.test/signed/" + key;
  }),
}));

import { POST as createSubscription } from "@/app/api/billing/subscriptions/route";
import { POST as uploadReceipt, GET as getReceiptUrl } from "@/app/api/billing/subscriptions/[id]/receipt/route";
import { GET as getBillingStatus } from "@/app/api/billing/status/route";

function setSession(tenantId: string) {
  S.session = { user: { id: "user-" + tenantId, role: "ADMIN", tenantId } };
}

function seedSub(tenantId: string, overrides: any = {}) {
  S.subSeq += 1;
  const now = new Date();
  const row = {
    id: "sub-" + S.subSeq, tenantId, tier: "monthly", durationDays: 30,
    amountUSD: "15", amountSYP: "172500", exchangeRateUsed: "11500",
    referenceCode: "JT-SEED" + String(S.subSeq).padStart(4, "0"),
    status: "PENDING_APPROVAL", expiresAt: null, receiptImageURL: null,
    rejectionReason: null, reviewedByUserId: null, reviewedAt: null,
    createdAt: now, updatedAt: now, ...overrides,
  };
  S.subs.push(row);
  return row;
}

function jsonReq(body: unknown) {
  return new Request("http://test/api/billing/subscriptions", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }) as any;
}

function multipartReq(buf: Buffer) {
  const fd = new FormData();
  fd.append("file", new File([new Uint8Array(buf)], "r.jpg", { type: "image/jpeg" }));
  return new Request("http://test/x", { method: "POST", body: fd }) as any;
}

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 2, 3]);
const paramsFor = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  S.session = null; S.subs = []; S.uploads = []; S.signedArgs = []; S.subSeq = 0;
  S.tenants = {
    [TENANT_A]: { subscriptionStatus: "ACTIVE", dailyExchangeRate: "11500", expiresAt: null },
    [TENANT_B]: { subscriptionStatus: "ACTIVE", dailyExchangeRate: "11500", expiresAt: null },
  };
  S.users = { ["user-" + TENANT_A]: { isActive: true }, ["user-" + TENANT_B]: { isActive: true } };
});

describe("T7 cross-tenant billing isolation", () => {
  it("tenant B can never read tenant A rows", async () => {
    setSession(TENANT_A);
    const aSub = seedSub(TENANT_A);
    const aWithReceipt = seedSub(TENANT_A, { receiptImageURL: `receipts/${TENANT_A}/a.jpg` });
    setSession(TENANT_B);
    expect((await uploadReceipt(multipartReq(JPEG), paramsFor(aSub.id))).status).toBe(404);
    expect(S.uploads.length).toBe(0);
    expect((await getReceiptUrl(new Request("http://test/") as any, paramsFor(aWithReceipt.id))).status).toBe(404);
    expect(S.signedArgs.length).toBe(0);
    const body = await (await getBillingStatus()).json();
    expect(body.openRequest).toBeNull();
    expect(body.recentRequests).toEqual([]);
  });

  it("tenant B cannot create against tenant A (route supplies the caller's tenantId)", async () => {
    setSession(TENANT_A);
    seedSub(TENANT_A);
    setSession(TENANT_B);
    // A client-supplied tenantId must be ignored.
    const res = await createSubscription(jsonReq({ tier: "monthly", tenantId: TENANT_A } as any));
    expect(res.status).toBe(200);
    const body = await res.json();
    const created = S.subs.find((r: any) => r.id === body.id);
    expect(created.tenantId).toBe(TENANT_B);
    expect(S.subs.filter((r: any) => r.tenantId === TENANT_A).length).toBe(1);
  });

  it("symmetric: tenant A can never touch tenant B rows", async () => {
    setSession(TENANT_B);
    const bSub = seedSub(TENANT_B);
    const bWithReceipt = seedSub(TENANT_B, { receiptImageURL: `receipts/${TENANT_B}/b.jpg` });
    setSession(TENANT_A);
    expect((await uploadReceipt(multipartReq(JPEG), paramsFor(bSub.id))).status).toBe(404);
    expect((await getReceiptUrl(new Request("http://test/") as any, paramsFor(bWithReceipt.id))).status).toBe(404);
    const body = await (await getBillingStatus()).json();
    expect(body.openRequest).toBeNull();
    expect(body.recentRequests).toEqual([]);
  });

  describe("T6c — lockout exemption with cross-tenant isolation", () => {
    it("locked tenant A can still reach billing status (exemption) but never tenant B rows", async () => {
      // Tenant A is locked (EXPIRED, past grace).
      S.tenants[TENANT_A] = {
        subscriptionStatus: "EXPIRED",
        dailyExchangeRate: "11500",
        expiresAt: new Date("2026-01-01T00:00:00.000Z"),
      };
      setSession(TENANT_A);

      // Billing status must still work for a locked tenant (exemption).
      const statusA = await (await getBillingStatus()).json();
      expect(statusA.openRequest).toBeNull();

      // Tenant A must NOT see tenant B's subscription requests.
      setSession(TENANT_B);
      seedSub(TENANT_B);
      setSession(TENANT_A);
      const statusA2 = await (await getBillingStatus()).json();
      expect(statusA2.recentRequests).toEqual([]);
      expect(statusA2.openRequest).toBeNull();
    });
  });
});