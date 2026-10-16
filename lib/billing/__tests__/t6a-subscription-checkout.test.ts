/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
const S = vi.hoisted(() => ({
  session: null as any,
  tenants: {} as Record<string, any>,
  subs: [] as any[],
  users: {} as Record<string, any>,
  uploads: [] as string[],
  removed: [] as string[],
  signedArgs: [] as any[],
  failCreateOnce: null as any,
  createCalls: 0,
  subSeq: 0,
}));
function matchSub(row: any, where: any): boolean {
  if (!where) return true;
  if (where.id !== undefined && row.id !== where.id) return false;
  if (where.status !== undefined && row.status !== where.status) return false;
  if (where.receiptImageURL !== undefined) {
    if (where.receiptImageURL === null && row.receiptImageURL !== null) return false;
    if (where.receiptImageURL !== null && row.receiptImageURL !== where.receiptImageURL) return false;
  }
  if (where.createdAt?.lt !== undefined && !(row.createdAt < where.createdAt.lt)) return false;
  return true;
}

function dbFor(tenantId: string): any {
  const scoped = (rows: any[]) => rows.filter((r) => r.tenantId === tenantId);
  const subscription = {
    updateMany: vi.fn(async (args: any) => {
      let n = 0;
      for (const r of scoped(S.subs)) {
        if (!matchSub(r, args.where)) continue;
        Object.assign(r, args.data);
        r.updatedAt = new Date();
        n += 1;
      }
      return { count: n };
    }),
    count: vi.fn(async (a: any) => scoped(S.subs).filter((r) => matchSub(r, a.where)).length),
    create: vi.fn(async (args: any) => {
      S.createCalls += 1;
      if (S.failCreateOnce) {
        const e = S.failCreateOnce;
        S.failCreateOnce = null;
        throw e;
      }
      S.subSeq += 1;
      const now = new Date();
      const row = { id: "sub-" + S.subSeq, createdAt: now, updatedAt: now, ...args.data };
      S.subs.push(row);
      return row;
    }),
    findFirst: vi.fn(async (args: any) => scoped(S.subs).filter((r) => matchSub(r, args.where))[0] ?? null),
    findMany: vi.fn(async (args: any) => {
      let rows = scoped(S.subs).filter((r) => matchSub(r, args.where ?? {}));
      rows = [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      if (args.take !== undefined) rows = rows.slice(0, args.take);
      return rows;
    }),
  };
  const tenant = {
    findUnique: vi.fn(async (args: any) => {
      const t = S.tenants[args.where.id];
      return t ? { id: args.where.id, ...t } : null;
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
  uploadFileToStorage: vi.fn(async (p: any) => {
    S.uploads.push(p.key);
    return "https://storage.test/" + p.key;
  }),
  removeFileFromStorage: vi.fn(async (k: string) => {
    S.removed.push(k);
  }),
  createSignedUrl: vi.fn(async (p: any) => {
    S.signedArgs.push(p);
    return "https://storage.test/signed/" + p.key;
  }),
}));
import { POST as createSubscription } from "@/app/api/billing/subscriptions/route";
import { POST as uploadReceipt, GET as getReceiptUrl } from "@/app/api/billing/subscriptions/[id]/receipt/route";
import { GET as getBillingStatus } from "@/app/api/billing/status/route";
import { isLockoutExemptPath } from "@/lib/auth/tenant";
import { multiplyMoney, roundToWholeLira } from "@/lib/utils/money";
import { generateReferenceCode, isReferenceCodeCollision } from "@/lib/utils/subscription-reference";
import { SUBSCRIPTION_OFFER_VALIDITY_HOURS, SUBSCRIPTION_RECEIPT_MAX_BYTES, SHAM_CASH_WALLET } from "@/lib/config/subscription";
const TENANT_A = "tenant-A";
const TENANT_B = "tenant-B";
const TENANT_P = "tenant-P";
const TENANT_E = "tenant-E";
function setSession(role: "ADMIN" | "CASHIER", tenantId: string) {
  S.session = { user: { id: "user-" + tenantId, role, tenantId } };
}
function seedTenant(id: string, status: string, rate: string | null) {
  S.tenants[id] = { subscriptionStatus: status, dailyExchangeRate: rate, expiresAt: null };
  S.users["user-" + id] = { isActive: true };
}
function seedSub(overrides: any = {}) {
  S.subSeq += 1;
  const now = new Date();
  const row = {
    id: "sub-" + S.subSeq, tenantId: TENANT_A, tier: "monthly", durationDays: 30,
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
function multipartReq(buf: Buffer, filename: string, mime: string) {
  const fd = new FormData();
  fd.append("file", new File([new Uint8Array(buf)], filename, { type: mime }));
  return new Request("http://test/x", { method: "POST", body: fd }) as any;
}
const paramsFor = (id: string) => ({ params: Promise.resolve({ id }) });
beforeEach(() => {
  S.session = null; S.tenants = {}; S.subs = []; S.users = {};
  S.uploads = []; S.removed = []; S.signedArgs = [];
  S.failCreateOnce = null; S.createCalls = 0; S.subSeq = 0;
  seedTenant(TENANT_A, "ACTIVE", "11500");
  seedTenant(TENANT_B, "ACTIVE", "12000");
  seedTenant(TENANT_P, "PENDING", "11500");
  seedTenant(TENANT_E, "EXPIRED", "11500");
});
describe("T6a gates + exemption", () => {
  it("CASHIER 403 everywhere", async () => {
    setSession("CASHIER", TENANT_A);
    const sub = seedSub();
    expect((await createSubscription(jsonReq({ tier: "monthly" }))).status).toBe(403);
    expect((await uploadReceipt(multipartReq(Buffer.from([1,2,3,4,5,6,7,8,9,10,11,12]), "r.jpg", "image/jpeg"), paramsFor(sub.id))).status).toBe(403);
    expect((await getReceiptUrl(new Request("http://test/") as any, paramsFor(sub.id))).status).toBe(403);
    expect((await getBillingStatus()).status).toBe(403);
  });
  it("unauthenticated 401 everywhere", async () => {
    S.session = null;
    expect((await createSubscription(jsonReq({ tier: "monthly" }))).status).toBe(401);
    expect((await getBillingStatus()).status).toBe(401);
  });
  it("PENDING and EXPIRED ADMIN can create + upload", async () => {
    for (const t of [TENANT_P, TENANT_E]) {
      setSession("ADMIN", t);
      const res = await createSubscription(jsonReq({ tier: "monthly" }));
      expect(res.status).toBe(200);
      const body = await res.json();
      const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 2, 3]);
      const up = await uploadReceipt(multipartReq(jpeg, "r.jpg", "image/jpeg"), paramsFor(body.id));
      expect(up.status).toBe(200);
      expect((await getBillingStatus()).status).toBe(200);
    }
  });
  it("named exemption list covers billing only", () => {
    expect(isLockoutExemptPath("/api/billing/subscriptions")).toBe(true);
    expect(isLockoutExemptPath("/api/billing/subscriptions/abc/receipt")).toBe(true);
    expect(isLockoutExemptPath("/api/billing/status")).toBe(true);
    expect(isLockoutExemptPath("/api/inventory/products")).toBe(false);
  });
  it("deactivated ADMIN 403", async () => {
    setSession("ADMIN", TENANT_A);
    S.users["user-" + TENANT_A] = { isActive: false };
    const res = await createSubscription(jsonReq({ tier: "monthly" }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("ACCOUNT_DEACTIVATED");
  });
});
describe("T6a amount", () => {
  it("frozen half-up whole lira", async () => {
    setSession("ADMIN", TENANT_A);
    const res = await createSubscription(jsonReq({ tier: "monthly" }));
    expect(res.status).toBe(200);
    expect((await res.json()).amountSYP).toBe("172500");
    expect(roundToWholeLira(multiplyMoney("10.5", "1"))).toBe("11");
    expect(roundToWholeLira(multiplyMoney("10.4", "1"))).toBe("10");
    expect(roundToWholeLira(multiplyMoney("15", "11500.333"))).toBe("172505");
  });
  it("client price ignored", async () => {
    setSession("ADMIN", TENANT_A);
    const res = await createSubscription(jsonReq({ tier: "monthly", amountSYP: "1", price: 999 }));
    expect(res.status).toBe(200);
    expect((await res.json()).amountSYP).toBe("172500");
  });
  it("unknown tier 400", async () => {
    setSession("ADMIN", TENANT_A);
    const res = await createSubscription(jsonReq({ tier: "weekly" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("INVALID_TIER");
  });
  it.each([null, "", "0", "-5"])("bad rate %s 422 nothing written", async (rate) => {
    setSession("ADMIN", TENANT_A);
    S.tenants[TENANT_A].dailyExchangeRate = rate as any;
    const res = await createSubscription(jsonReq({ tier: "monthly" }));
    expect(res.status).toBe(422);
    expect(S.subs.length).toBe(0);
    expect(S.createCalls).toBe(0);
  });
});
describe("T6a reference codes", () => {
  it("format + alphabet", () => {
    for (let i = 0; i < 30; i++) {
      const code = generateReferenceCode();
      expect(code).toMatch(/^JT-[2-9A-HJ-NP-Z]{8}$/);
    }
  });
  it("retry on referenceCode P2002", async () => {
    setSession("ADMIN", TENANT_A);
    S.failCreateOnce = { code: "P2002", meta: { target: ["referenceCode"] } };
    const res = await createSubscription(jsonReq({ tier: "monthly" }));
    expect(res.status).toBe(200);
    expect(S.createCalls).toBe(2);
  });
  it("unrelated P2002 not a collision", () => {
    expect(isReferenceCodeCollision({ code: "P2002", meta: { target: ["email"] } })).toBe(false);
    expect(isReferenceCodeCollision({ code: "P2002", meta: { target: ["referenceCode"] } })).toBe(true);
    expect(isReferenceCodeCollision({ code: "P2002", meta: { target: "referenceCode" } })).toBe(true);
    expect(isReferenceCodeCollision({ code: "P2002" })).toBe(false);
  });
});

describe("T6a open-request guard", () => {
  it("second create 409", async () => {
    setSession("ADMIN", TENANT_A);
    seedSub();
    const res = await createSubscription(jsonReq({ tier: "yearly" }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("OPEN_REQUEST_EXISTS");
  });
  it("stale without receipt auto-rejected, new create succeeds", async () => {
    setSession("ADMIN", TENANT_A);
    const stale = seedSub({ createdAt: new Date(Date.now() - (SUBSCRIPTION_OFFER_VALIDITY_HOURS + 1) * 3600e3) });
    const res = await createSubscription(jsonReq({ tier: "yearly" }));
    expect(res.status).toBe(200);
    expect(stale.status).toBe("REJECTED");
    expect(stale.rejectionReason).toBe("انتهت صلاحية العرض");
    expect(stale.reviewedByUserId).toBeNull();
  });
  it("stale WITH receipt blocks", async () => {
    setSession("ADMIN", TENANT_A);
    const w = seedSub({ createdAt: new Date(Date.now() - 100 * 3600e3), receiptImageURL: "receipts/x.jpg" });
    const res = await createSubscription(jsonReq({ tier: "yearly" }));
    expect(res.status).toBe(409);
    expect(w.status).toBe("PENDING_APPROVAL");
  });
});
describe("T6a receipt", () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 2, 3]);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0, 0, 0, 13, 1, 2]);
  const webp = Buffer.from([82, 73, 70, 70, 16, 0, 0, 0, 87, 69, 66, 80, 1, 2]);
  const exe = Buffer.from([77, 90, 144, 0, 3, 0, 0, 0, 4, 0, 0, 0, 255, 255]);
  it("oversize 400", async () => {
    setSession("ADMIN", TENANT_A);
    const sub = seedSub();
    const big = Buffer.alloc(SUBSCRIPTION_RECEIPT_MAX_BYTES + 1, 7);
    big[0] = 0xff; big[1] = 0xd8; big[2] = 0xff;
    const res = await uploadReceipt(multipartReq(big, "r.jpg", "image/jpeg"), paramsFor(sub.id));
    expect(res.status).toBe(400);
    expect(S.uploads.length).toBe(0);
  });
  it("exe-as-jpg 400; evil name + lying mime with real magic accepted", async () => {
    setSession("ADMIN", TENANT_A);
    const sub = seedSub();
    expect((await uploadReceipt(multipartReq(exe, "r.jpg", "image/jpeg"), paramsFor(sub.id))).status).toBe(400);
    const ok = await uploadReceipt(multipartReq(jpeg, "p.exe", "application/octet-stream"), paramsFor(sub.id));
    expect(ok.status).toBe(200);
    expect(S.uploads[0]).toMatch(new RegExp("^receipts/" + TENANT_A + "/" + sub.id + "-[0-9a-f]+\\.jpg$"));
  });
  it("png/webp accepted", async () => {
    setSession("ADMIN", TENANT_A);
    const a = seedSub();
    expect((await uploadReceipt(multipartReq(png, "r.png", "image/png"), paramsFor(a.id))).status).toBe(200);
    expect(S.uploads[0]).toMatch(/\.png$/);
    const b = seedSub();
    expect((await uploadReceipt(multipartReq(webp, "r.webp", "image/webp"), paramsFor(b.id))).status).toBe(200);
    expect(S.uploads[1]).toMatch(/\.webp$/);
  });
  it("non-pending 409 before upload (nothing to clean); race cleans up", async () => {
    setSession("ADMIN", TENANT_A);
    const sub = seedSub({ status: "APPROVED", receiptImageURL: "receipts/" + TENANT_A + "/old.jpg" });
    const res = await uploadReceipt(multipartReq(jpeg, "r.jpg", "image/jpeg"), paramsFor(sub.id));
    expect(res.status).toBe(409);
    // Pre-check rejects before any upload: no orphan possible.
    expect(S.uploads.length).toBe(0);
    expect(sub.receiptImageURL).toBe("receipts/" + TENANT_A + "/old.jpg");
  });
  it("replace deletes old after write", async () => {
    setSession("ADMIN", TENANT_A);
    const sub = seedSub({ receiptImageURL: "receipts/" + TENANT_A + "/old.jpg" });
    const res = await uploadReceipt(multipartReq(png, "r.png", "image/png"), paramsFor(sub.id));
    expect(res.status).toBe(200);
    expect(S.removed).toContain("receipts/" + TENANT_A + "/old.jpg");
  });
  it("past validity without receipt OFFER_EXPIRED", async () => {
    setSession("ADMIN", TENANT_A);
    const sub = seedSub({ createdAt: new Date(Date.now() - 100 * 3600e3) });
    const res = await uploadReceipt(multipartReq(jpeg, "r.jpg", "image/jpeg"), paramsFor(sub.id));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("OFFER_EXPIRED");
  });
  it("GET signed TTL <= 300", async () => {
    setSession("ADMIN", TENANT_A);
    const sub = seedSub({ receiptImageURL: "receipts/" + TENANT_A + "/x.jpg" });
    const res = await getReceiptUrl(new Request("http://test/") as any, paramsFor(sub.id));
    expect(res.status).toBe(200);
    expect(S.signedArgs[0].seconds).toBeLessThanOrEqual(300);
  });
});

describe("T6a status + cross-tenant + scans", () => {
  it("status returns open request with computed validity", async () => {
    setSession("ADMIN", TENANT_A);
    const open = seedSub();
    const body = await (await getBillingStatus()).json();
    expect(body.status).toBe("ACTIVE");
    expect(body.openRequest.id).toBe(open.id);
    const expected = open.createdAt.getTime() + SUBSCRIPTION_OFFER_VALIDITY_HOURS * 3600e3;
    expect(Math.abs(new Date(body.openRequest.expiresOfferAt).getTime() - expected)).toBeLessThan(5000);
    expect(body.recentRequests.length).toBe(1);
  });
  it("PENDING tenant sees PENDING; wallet matches config", async () => {
    setSession("ADMIN", TENANT_P);
    const statusBody = await (await getBillingStatus()).json();
    expect(statusBody.status).toBe("PENDING");
    expect(statusBody.wallet).toBe(SHAM_CASH_WALLET);
    const created = await (await createSubscription(jsonReq({ tier: "monthly" }))).json();
    expect(created.wallet).toBe(SHAM_CASH_WALLET);
  });
  it("T7: tenant B can never touch tenant A rows", async () => {
    setSession("ADMIN", TENANT_A);
    const aSub = seedSub();
    const withReceipt = seedSub({ receiptImageURL: "receipts/" + TENANT_A + "/a.jpg" });
    setSession("ADMIN", TENANT_B);
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 2, 3]);
    // Other tenant's id is invisible to tenant B's scoped client → 404, no upload at all.
    expect((await uploadReceipt(multipartReq(jpeg, "r.jpg", "image/jpeg"), paramsFor(aSub.id))).status).toBe(404);
    expect(S.uploads.length).toBe(0);
    expect((await getReceiptUrl(new Request("http://test/") as any, paramsFor(withReceipt.id))).status).toBe(404);
    expect(S.signedArgs.length).toBe(0);
    const body = await (await getBillingStatus()).json();
    expect(body.openRequest).toBeNull();
    expect(body.recentRequests).toEqual([]);
  });
  it("static scans", () => {
    const root = path.resolve(__dirname, "../../..");
    const read = (p: string) => readFileSync(path.join(root, p), "utf8");
    const createSrc = read("app/api/billing/subscriptions/route.ts");
    const receiptSrc = read("app/api/billing/subscriptions/[id]/receipt/route.ts");
    const statusSrc = read("app/api/billing/status/route.ts");
    const refSrc = read("lib/utils/subscription-reference.ts");
    const all = createSrc + receiptSrc + statusSrc;
    expect(createSrc).toContain("tx.subscription.create");
    expect(all).not.toMatch(/new Decimal\(/);
    expect(createSrc).toContain("multiplyMoney");
    expect(createSrc).toContain("roundToWholeLira");
    expect(receiptSrc).toContain("receiptImageURL: key");
    expect(receiptSrc).not.toMatch(/getPublicUrl/);
    const m = receiptSrc.match(/seconds:\s*(\d+)/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeLessThanOrEqual(300);
    expect(refSrc).toContain("referenceCode");
    expect(receiptSrc).toContain("receipts/${tenantId}/");
  });
});

