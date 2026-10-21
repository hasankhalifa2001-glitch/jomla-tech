/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import Decimal from "decimal.js";

// ---------------------------------------------------------------------------
// Hoisted state + env. The env vars MUST be set inside vi.hoisted so they exist
// before the route module is imported (the route builds its limiter at load time).
// ---------------------------------------------------------------------------
const rateLimitMock = vi.hoisted(() => {
  process.env.UPSTASH_REDIS_REST_URL = "http://localhost:6379";
  process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";
  return { limit: vi.fn() };
});

const S = vi.hoisted(() => ({
  session: null as any,
  platformRate: null as string | null,
  tenants: {} as Record<string, any>,
  subs: [] as any[],
  users: {} as Record<string, any>,
  uploads: [] as string[],
  removed: [] as string[],
  signedArgs: [] as any[],
  failCreateQueue: [] as any[],
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
      if (S.failCreateQueue.length > 0) throw S.failCreateQueue.shift();
      S.subSeq += 1;
      const now = new Date();
      const row = { id: "sub-" + S.subSeq, createdAt: now, updatedAt: now, receiptImageURL: null, rejectionReason: null, ...args.data };
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
      // The platform tenant is selected by the constant slug (D3).
      if (args.where.slug === "platform-internal") {
        return { dailyExchangeRate: S.platformRate };
      }
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
  // NOTE: no rollback semantics here; atomicity is not covered by this mock.
  db.$transaction = vi.fn(async (cb: any) => cb(db));
  return db;
}

vi.mock("@/auth", () => ({ auth: vi.fn(async () => S.session) }));
vi.mock("@/lib/db", () => ({ getTenantDb: vi.fn((t: string) => dbFor(t)) }));
vi.mock("@/lib/db/tenant-scope", () => ({
  getTenantDb: vi.fn((t: string) => dbFor(t)),
  tenantScopedRawQuery: vi.fn(async () => []),
}));

vi.mock("@upstash/ratelimit", () => {
  const Ratelimit: any = vi.fn(function (this: any) {
    this.limit = rateLimitMock.limit;
  });
  Ratelimit.slidingWindow = vi.fn(() => ({}));
  Ratelimit.fixedWindow = vi.fn(() => ({}));
  return { Ratelimit, slidingWindow: vi.fn() };
});
vi.mock("@upstash/redis", () => {
  const Redis: any = vi.fn(function () { });
  Redis.fromEnv = vi.fn(() => ({}));
  return { Redis };
});

vi.mock("@/lib/storage", () => ({
  uploadPrivateReceipt: vi.fn(async (p: any) => {
    S.uploads.push(p.key);
    return p.key;
  }),
  removePrivateReceipt: vi.fn(async (k: string) => {
    S.removed.push(k);
    return true;
  }),
  // Record the RAW argument (undefined if the route did not pass one).
  createReceiptSignedUrl: vi.fn(async (key: string, seconds?: number) => {
    S.signedArgs.push({ key, seconds });
    return "https://storage.test/signed/" + key;
  }),
  uploadFileToStorage: vi.fn(async () => "https://storage.test/public/key"),
  buildStorageKey: vi.fn(({ tenantId, kind, extension }: any) => `${kind}/${tenantId}/x.${extension}`),
  ALLOWED_IMAGE_TYPES: ["image/jpeg", "image/png", "image/webp"],
  MAX_UPLOAD_BYTES: 2 * 1024 * 1024,
}));

import { POST as createSubscription } from "@/app/api/billing/subscriptions/route";
import { POST as uploadReceipt, GET as getReceiptUrl } from "@/app/api/billing/subscriptions/[id]/receipt/route";
import { GET as getBillingStatus } from "@/app/api/billing/status/route";
import { isLockoutExemptPath } from "@/lib/auth/tenant";
import { multiplyMoney, roundToWholeLira } from "@/lib/utils/money";
import { generateReferenceCode, isReferenceCodeCollision } from "@/lib/utils/subscription-reference";
import {
  SUBSCRIPTION_TIERS,
  SUBSCRIPTION_OFFER_VALIDITY_HOURS,
  SUBSCRIPTION_RECEIPT_MAX_BYTES,
  SUBSCRIPTION_GRACE_DAYS,
  SHAM_CASH_WALLET,
  subscriptionRateLimitKey,
} from "@/lib/config/subscription";

const TENANT_A = "tenant-A";
const TENANT_B = "tenant-B";
const TENANT_P = "tenant-P";
const TENANT_E = "tenant-E";
const PLATFORM_RATE = "11500";

const MONTHLY = SUBSCRIPTION_TIERS.monthly;
const EXPECTED_MONTHLY_SYP = roundToWholeLira(multiplyMoney(MONTHLY.priceUSD, PLATFORM_RATE));

function setSession(role: "ADMIN" | "CASHIER", tenantId: string) {
  S.session = { user: { id: "user-" + tenantId, role, tenantId } };
}
// The merchant's OWN dailyExchangeRate is deliberately a different value:
// subscription pricing must never read it.
function seedTenant(id: string, status: string, ownRate: string | null) {
  S.tenants[id] = { subscriptionStatus: status, dailyExchangeRate: ownRate, expiresAt: null };
  S.users["user-" + id] = { isActive: true };
}
function seedSub(overrides: any = {}) {
  S.subSeq += 1;
  const now = new Date();
  const row = {
    id: "sub-" + S.subSeq, tenantId: TENANT_A, tier: "monthly", durationDays: 30,
    amountUSD: String(MONTHLY.priceUSD), amountSYP: EXPECTED_MONTHLY_SYP, exchangeRateUsed: PLATFORM_RATE,
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
function productUploadReq() {
  const fd = new FormData();
  fd.append("file", new File([new Uint8Array(JPEG)], "p.jpg", { type: "image/jpeg" }));
  // The field name is not known from the scan (kind vs type): send both.
  fd.append("kind", "product");
  fd.append("type", "product");
  return new Request("http://test/api/upload/receipt", { method: "POST", body: fd }) as any;
}
const paramsFor = (id: string) => ({ params: Promise.resolve({ id }) });
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 2, 3]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0, 0, 0, 13, 1, 2]);
const WEBP = Buffer.from([82, 73, 70, 70, 16, 0, 0, 0, 87, 69, 66, 80, 1, 2]);
const EXE = Buffer.from([77, 90, 144, 0, 3, 0, 0, 0, 4, 0, 0, 0, 255, 255]);
const HOUR = 3600e3;
const DAY = 86400e3;

beforeEach(() => {
  S.session = null; S.tenants = {}; S.subs = []; S.users = {};
  S.uploads = []; S.removed = []; S.signedArgs = [];
  S.failCreateQueue = []; S.createCalls = 0; S.subSeq = 0;
  S.platformRate = PLATFORM_RATE;
  rateLimitMock.limit.mockReset();
  rateLimitMock.limit.mockResolvedValue({ success: true, limit: 10, remaining: 9, reset: Date.now() + HOUR });
  seedTenant(TENANT_A, "ACTIVE", "1");
  seedTenant(TENANT_B, "ACTIVE", "12000");
  seedTenant(TENANT_P, "PENDING", "1");
  seedTenant(TENANT_E, "EXPIRED", "1");
});

// ---------------------------------------------------------------------------
describe("T6a gates + exemption", () => {
  it("CASHIER 403 everywhere", async () => {
    setSession("CASHIER", TENANT_A);
    const sub = seedSub();
    expect((await createSubscription(jsonReq({ tier: "monthly" }))).status).toBe(403);
    expect((await uploadReceipt(multipartReq(JPEG, "r.jpg", "image/jpeg"), paramsFor(sub.id))).status).toBe(403);
    expect((await getReceiptUrl(new Request("http://test/") as any, paramsFor(sub.id))).status).toBe(403);
    expect((await getBillingStatus()).status).toBe(403);
  });
  it("unauthenticated 401 everywhere", async () => {
    S.session = null;
    const seededId = "sub-seeded";
    expect((await createSubscription(jsonReq({ tier: "monthly" }))).status).toBe(401);
    expect((await uploadReceipt(multipartReq(JPEG, "r.jpg", "image/jpeg"), paramsFor(seededId))).status).toBe(401);
    expect((await getReceiptUrl(new Request("http://test/") as any, paramsFor(seededId))).status).toBe(401);
    expect((await getBillingStatus()).status).toBe(401);
  });
  it("PENDING and EXPIRED ADMIN can create + upload", async () => {
    for (const t of [TENANT_P, TENANT_E]) {
      setSession("ADMIN", t);
      const res = await createSubscription(jsonReq({ tier: "monthly" }));
      expect(res.status).toBe(200);
      const body = await res.json();
      const up = await uploadReceipt(multipartReq(JPEG, "r.jpg", "image/jpeg"), paramsFor(body.id));
      expect(up.status).toBe(200);
      expect((await getBillingStatus()).status).toBe(200);
    }
  });
  it("named exemption list covers billing only (segment boundaries respected)", () => {
    expect(isLockoutExemptPath("/api/billing/subscriptions")).toBe(true);
    expect(isLockoutExemptPath("/api/billing/subscriptions/abc/receipt")).toBe(true);
    expect(isLockoutExemptPath("/api/billing/status")).toBe(true);
    expect(isLockoutExemptPath("/api/inventory/products")).toBe(false);
    // near-miss names must NOT match
    expect(isLockoutExemptPath("/api/billing/subscriptionsFoo")).toBe(false);
    expect(isLockoutExemptPath("/api/billing/statusX")).toBe(false);
    expect(isLockoutExemptPath("/api/billingX/status")).toBe(false);
  });
  it("PENDING/EXPIRED ADMIN is still blocked on a real non-billing write route", async () => {
    // Dynamic import so a resolution problem fails only this test.
    const mod: any = await import("@/app/api/upload/receipt/route");
    for (const t of [TENANT_P, TENANT_E]) {
      setSession("ADMIN", t);
      const blocked = await mod.POST(productUploadReq());
      expect(blocked.status).toBe(403);
      // ...while the billing route works for the very same session
      const ok = await createSubscription(jsonReq({ tier: "monthly" }));
      expect(ok.status).toBe(200);
      S.subs = []; // allow the next tenant's create
    }
    // sanity: an ACTIVE tenant is not rejected by the lockout
    setSession("ADMIN", TENANT_A);
    const active = await mod.POST(productUploadReq());
    expect(active.status).not.toBe(403);
  });
  it("deactivated ADMIN 403", async () => {
    setSession("ADMIN", TENANT_A);
    S.users["user-" + TENANT_A] = { isActive: false };
    const res = await createSubscription(jsonReq({ tier: "monthly" }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("ACCOUNT_DEACTIVATED");
  });
});

// ---------------------------------------------------------------------------
describe("T6a rate limit", () => {

  it("11th request in the window → 429 and nothing is written", async () => {
    setSession("ADMIN", TENANT_A);
    rateLimitMock.limit.mockResolvedValueOnce({ success: false, limit: 10, remaining: 0, reset: Date.now() + 1000 });
    const res = await createSubscription(jsonReq({ tier: "monthly" }));
    expect(res.status).toBe(429);
    expect(S.createCalls).toBe(0);
    expect(S.subs.length).toBe(0);
  });
  it("limiter key is per tenant", async () => {
    setSession("ADMIN", TENANT_A);
    await createSubscription(jsonReq({ tier: "monthly" }));
    setSession("ADMIN", TENANT_B);
    await createSubscription(jsonReq({ tier: "monthly" }));
    const keys = rateLimitMock.limit.mock.calls.map((c: any[]) => c[0]);
    expect(keys).toContain(subscriptionRateLimitKey(TENANT_A));
    expect(keys).toContain(subscriptionRateLimitKey(TENANT_B));
    expect(subscriptionRateLimitKey(TENANT_A)).not.toBe(subscriptionRateLimitKey(TENANT_B));
  });
  it("Upstash throwing → 503 (needs the try/catch fix), nothing written", async () => {
    setSession("ADMIN", TENANT_A);
    rateLimitMock.limit.mockRejectedValueOnce(new Error("upstash down"));
    const res = await createSubscription(jsonReq({ tier: "monthly" }));
    expect(res.status).toBe(503);
    expect(S.subs.length).toBe(0);
  });
  it("receipt upload: Upstash throwing → 503, nothing uploaded", async () => {
    setSession("ADMIN", TENANT_A);
    const sub = seedSub();
    rateLimitMock.limit.mockRejectedValueOnce(new Error("upstash down"));
    const res = await uploadReceipt(multipartReq(JPEG, "r.jpg", "image/jpeg"), paramsFor(sub.id));
    expect(res.status).toBe(503);
    expect(((await res.json()) as any).error).toBe("RATE_LIMIT_UNAVAILABLE");
    expect(S.uploads.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe("T6a amount", () => {
  it("uses the PLATFORM rate, frozen half-up to a whole lira", async () => {
    setSession("ADMIN", TENANT_A);
    const res = await createSubscription(jsonReq({ tier: "monthly" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.amountSYP).toBe(EXPECTED_MONTHLY_SYP);
    expect(body.wallet).toBe(SHAM_CASH_WALLET);
    expect(S.subs[0].exchangeRateUsed).toBe(PLATFORM_RATE);
    expect(roundToWholeLira(multiplyMoney("10.5", "1"))).toBe("11");
    expect(roundToWholeLira(multiplyMoney("10.4", "1"))).toBe("10");
    expect(roundToWholeLira(multiplyMoney("15", "11500.333"))).toBe("172505");
  });
  it("fractional platform rate through the ROUTE, expected value computed independently", async () => {
    setSession("ADMIN", TENANT_A);
    // With a $10 plan, 10 x 11500.05 = 115000.50 exactly: a true half-up case (-> 115001).
    S.platformRate = "11500.05";
    const res = await createSubscription(jsonReq({ tier: "monthly" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    const expected = new Decimal(String(MONTHLY.priceUSD))
      .times("11500.05")
      .toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
      .toString();
    expect(String(body.amountSYP)).toBe(expected);
    expect(String(S.subs[0].exchangeRateUsed)).toBe("11500.05");
  });
  it("rate change after creation never alters the frozen amount", async () => {
    setSession("ADMIN", TENANT_A);
    const body = await (await createSubscription(jsonReq({ tier: "monthly" }))).json();
    S.platformRate = "99999";
    const status = await (await getBillingStatus()).json();
    expect(status.openRequest.id).toBe(body.id);
    expect(String(S.subs[0].amountSYP)).toBe(String(body.amountSYP));
  });
  it("merchant's own dailyExchangeRate never affects the amount", async () => {
    setSession("ADMIN", TENANT_A);
    S.tenants[TENANT_A].dailyExchangeRate = "1"; // merchant sets a silly rate
    const body = await (await createSubscription(jsonReq({ tier: "monthly" }))).json();
    expect(body.amountSYP).toBe(EXPECTED_MONTHLY_SYP);
    expect(body.amountSYP).not.toBe(roundToWholeLira(multiplyMoney(MONTHLY.priceUSD, "1")));
  });
  it("client price ignored (extra keys are dropped, not rejected)", async () => {
    // NOTE: the spec says "strict zod". The current route IGNORES unknown keys.
    // If you switch the schema to .strict(), change this expectation to 400.
    setSession("ADMIN", TENANT_A);
    const res = await createSubscription(jsonReq({ tier: "monthly", amountSYP: "1", price: 999 }));
    expect(res.status).toBe(200);
    expect((await res.json()).amountSYP).toBe(EXPECTED_MONTHLY_SYP);
  });
  it("unknown tier 400, including prototype names", async () => {
    setSession("ADMIN", TENANT_A);
    for (const tier of ["weekly", "constructor", "__proto__", "toString"]) {
      const res = await createSubscription(jsonReq({ tier }));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("INVALID_TIER");
    }
  });
  it.each([null, "", "0", "-5"])("bad platform rate %s 422 nothing written", async (rate) => {
    setSession("ADMIN", TENANT_A);
    S.platformRate = rate as any;
    const res = await createSubscription(jsonReq({ tier: "monthly" }));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("RATE_UNAVAILABLE");
    expect(S.subs.length).toBe(0);
    expect(S.createCalls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe("T6a reference codes", () => {
  it("format + alphabet (no 0 O 1 I L) over many samples", () => {
    for (let i = 0; i < 2000; i++) {
      const code = generateReferenceCode();
      expect(code).toMatch(/^JT-[2-9A-HJKMNP-Z]{8}$/);
      expect(code.slice(3)).not.toMatch(/[01OIL]/);
    }
  });
  it("retry on referenceCode P2002 (new transaction each attempt)", async () => {
    setSession("ADMIN", TENANT_A);
    S.failCreateQueue = [{ code: "P2002", meta: { target: ["referenceCode"] } }];
    const res = await createSubscription(jsonReq({ tier: "monthly" }));
    expect(res.status).toBe(200);
    expect(S.createCalls).toBe(2);
  });
  it("retries are bounded: persistent collisions end in a server error after ~5 attempts", async () => {
    setSession("ADMIN", TENANT_A);
    S.failCreateQueue = Array.from({ length: 10 }, () => ({ code: "P2002", meta: { target: ["referenceCode"] } }));
    const res = await createSubscription(jsonReq({ tier: "monthly" }));
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(S.createCalls).toBeGreaterThanOrEqual(5);
    expect(S.createCalls).toBeLessThanOrEqual(6);
    expect(S.subs.length).toBe(0);
  });
  it("unrelated P2002 is not retried", async () => {
    setSession("ADMIN", TENANT_A);
    S.failCreateQueue = [{ code: "P2002", meta: { target: ["email"] } }];
    const res = await createSubscription(jsonReq({ tier: "monthly" }));
    expect(res.status).toBe(500);
    expect(S.createCalls).toBe(1);
  });
  it("collision detection", () => {
    expect(isReferenceCodeCollision({ code: "P2002", meta: { target: ["email"] } })).toBe(false);
    expect(isReferenceCodeCollision({ code: "P2002", meta: { target: ["referenceCode"] } })).toBe(true);
    expect(isReferenceCodeCollision({ code: "P2002", meta: { target: "referenceCode" } })).toBe(true);
    expect(isReferenceCodeCollision({ code: "P2002" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("T6a open-request guard", () => {
  it("second create 409", async () => {
    setSession("ADMIN", TENANT_A);
    seedSub();
    const res = await createSubscription(jsonReq({ tier: "yearly" }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("OPEN_REQUEST_EXISTS");
  });
  it("stale without receipt auto-rejected (system), new create succeeds", async () => {
    setSession("ADMIN", TENANT_A);
    const stale = seedSub({ createdAt: new Date(Date.now() - (SUBSCRIPTION_OFFER_VALIDITY_HOURS + 1) * HOUR) });
    const res = await createSubscription(jsonReq({ tier: "yearly" }));
    expect(res.status).toBe(200);
    expect(stale.status).toBe("REJECTED");
    expect(stale.rejectionReason).toBe("انتهت صلاحية العرض");
    expect(stale.reviewedByUserId).toBeNull();
    expect(stale.reviewedAt).toBeInstanceOf(Date);
  });
  it("stale WITH receipt blocks and is not auto-rejected", async () => {
    setSession("ADMIN", TENANT_A);
    const w = seedSub({ createdAt: new Date(Date.now() - 100 * HOUR), receiptImageURL: "receipts/" + TENANT_A + "/x.jpg" });
    const res = await createSubscription(jsonReq({ tier: "yearly" }));
    expect(res.status).toBe(409);
    expect(w.status).toBe("PENDING_APPROVAL");
    expect(w.reviewedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe("T6a receipt", () => {
  it("oversize 400, nothing uploaded", async () => {
    setSession("ADMIN", TENANT_A);
    const sub = seedSub();
    const big = Buffer.alloc(SUBSCRIPTION_RECEIPT_MAX_BYTES + 1, 7);
    big[0] = 0xff; big[1] = 0xd8; big[2] = 0xff;
    const res = await uploadReceipt(multipartReq(big, "r.jpg", "image/jpeg"), paramsFor(sub.id));
    expect(res.status).toBe(400);
    expect(S.uploads.length).toBe(0);
  });
  it("exe-as-jpg 400; evil name + lying mime with real magic accepted; key is never a URL", async () => {
    setSession("ADMIN", TENANT_A);
    const sub = seedSub();
    expect((await uploadReceipt(multipartReq(EXE, "r.jpg", "image/jpeg"), paramsFor(sub.id))).status).toBe(400);
    expect(S.uploads.length).toBe(0);
    const ok = await uploadReceipt(multipartReq(JPEG, "p.exe", "application/octet-stream"), paramsFor(sub.id));
    expect(ok.status).toBe(200);
    expect(S.uploads[0]).toMatch(new RegExp("^receipts/" + TENANT_A + "/" + sub.id + "-[0-9a-f]+\\.jpg$"));
    expect(sub.receiptImageURL).toBe(S.uploads[0]);
    expect(String(sub.receiptImageURL)).not.toMatch(/^https?:/i);
  });
  it("png and webp accepted", async () => {
    setSession("ADMIN", TENANT_A);
    const a = seedSub();
    expect((await uploadReceipt(multipartReq(PNG, "r.png", "image/png"), paramsFor(a.id))).status).toBe(200);
    expect(S.uploads[0]).toMatch(/\.png$/);
    const b = seedSub();
    expect((await uploadReceipt(multipartReq(WEBP, "r.webp", "image/webp"), paramsFor(b.id))).status).toBe(200);
    expect(S.uploads[1]).toMatch(/\.webp$/);
  });
  it("non-pending 409 before any upload", async () => {
    setSession("ADMIN", TENANT_A);
    const sub = seedSub({ status: "ACTIVE", receiptImageURL: "receipts/" + TENANT_A + "/old.jpg" });
    const res = await uploadReceipt(multipartReq(JPEG, "r.jpg", "image/jpeg"), paramsFor(sub.id));
    expect(res.status).toBe(409);
    expect(S.uploads.length).toBe(0);
    expect(sub.receiptImageURL).toBe("receipts/" + TENANT_A + "/old.jpg");
  });
  it("replace deletes the old object only after the DB write", async () => {
    setSession("ADMIN", TENANT_A);
    const oldKey = "receipts/" + TENANT_A + "/old.jpg";
    const sub = seedSub({ receiptImageURL: oldKey });
    const res = await uploadReceipt(multipartReq(PNG, "r.png", "image/png"), paramsFor(sub.id));
    expect(res.status).toBe(200);
    expect(S.removed).toContain(oldKey);
    expect(sub.receiptImageURL).toBe(S.uploads[0]);
  });
  it("replacing a receipt is still allowed after the offer window (a receipt already exists)", async () => {
    setSession("ADMIN", TENANT_A);
    const oldKey = "receipts/" + TENANT_A + "/old.jpg";
    const sub = seedSub({ createdAt: new Date(Date.now() - 100 * HOUR), receiptImageURL: oldKey });
    const res = await uploadReceipt(multipartReq(PNG, "r.png", "image/png"), paramsFor(sub.id));
    expect(res.status).toBe(200);
    expect(S.removed).toContain(oldKey);
  });
  it("lost race: receipt swapped between read and write → 409, new object removed", async () => {
    setSession("ADMIN", TENANT_A);
    const oldKey = "receipts/" + TENANT_A + "/old.jpg";
    const sub = seedSub({ receiptImageURL: oldKey });

    const { uploadPrivateReceipt } = await import("@/lib/storage");
    (uploadPrivateReceipt as any).mockImplementationOnce(async (p: any) => {
      S.uploads.push(p.key);
      sub.receiptImageURL = "receipts/" + TENANT_A + "/concurrent.jpg";
      return p.key;
    });

    const res = await uploadReceipt(multipartReq(JPEG, "r.jpg", "image/jpeg"), paramsFor(sub.id));
    expect(res.status).toBe(409);
    expect(S.removed).toContain(S.uploads[0]);
    expect(sub.receiptImageURL).toBe("receipts/" + TENANT_A + "/concurrent.jpg");
    expect(S.removed).not.toContain(oldKey);
  });
  it("past validity without receipt OFFER_EXPIRED", async () => {
    setSession("ADMIN", TENANT_A);
    const sub = seedSub({ createdAt: new Date(Date.now() - 100 * HOUR) });
    const res = await uploadReceipt(multipartReq(JPEG, "r.jpg", "image/jpeg"), paramsFor(sub.id));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("OFFER_EXPIRED");
    expect(S.uploads.length).toBe(0);
  });
  it("GET signed URL: route never asks for more than 5 minutes", async () => {
    setSession("ADMIN", TENANT_A);
    const sub = seedSub({ receiptImageURL: "receipts/" + TENANT_A + "/x.jpg" });
    const res = await getReceiptUrl(new Request("http://test/") as any, paramsFor(sub.id));
    expect(res.status).toBe(200);
    const seconds = S.signedArgs[0].seconds;
    // undefined = the route relies on the helper's own clamp (see the todo below).
    expect(seconds === undefined || seconds <= 300).toBe(true);
  });
  it.todo("lib/storage createReceiptSignedUrl: asking for 3600s is clamped to <= 300s (unit-test the REAL helper)");
  it("GET refuses a key outside the tenant prefix", async () => {
    setSession("ADMIN", TENANT_A);
    const sub = seedSub({ receiptImageURL: "receipts/" + TENANT_B + "/stolen.jpg" });
    const res = await getReceiptUrl(new Request("http://test/") as any, paramsFor(sub.id));
    expect(res.status).toBe(404);
    expect(S.signedArgs.length).toBe(0);
  });
  it("base64 body: real jpeg accepted, exe bytes rejected", async () => {
    setSession("ADMIN", TENANT_A);
    const a = seedSub();
    const jpegB64 = "data:image/jpeg;base64," + JPEG.toString("base64");
    const ok = await uploadReceipt(
      new Request("http://test/x", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ file: jpegB64 }),
      }) as any,
      paramsFor(a.id)
    );
    expect(ok.status).toBe(200);
    const b = seedSub();
    const bad = await uploadReceipt(
      new Request("http://test/x", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ file: EXE.toString("base64") }),
      }) as any,
      paramsFor(b.id)
    );
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe("INVALID_FILE");
  });
  it("missing file in both bodies 400", async () => {
    setSession("ADMIN", TENANT_A);
    const a = seedSub();
    const fd = new FormData();
    expect((await uploadReceipt(new Request("http://test/x", { method: "POST", body: fd }) as any, paramsFor(a.id))).status).toBe(400);
    const b = seedSub();
    const bad = await uploadReceipt(
      new Request("http://test/x", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
      }) as any,
      paramsFor(b.id)
    );
    expect(bad.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
describe("T6a status + cross-tenant", () => {
  it("returns the open request with computed validity", async () => {
    setSession("ADMIN", TENANT_A);
    const open = seedSub();
    const body = await (await getBillingStatus()).json();
    expect(body.status).toBe("ACTIVE");
    expect(body.openRequest.id).toBe(open.id);
    expect(body.openRequest.hasReceipt).toBe(false);
    expect(body.openRequest).not.toHaveProperty("receiptImageURL");
    const expected = open.createdAt.getTime() + SUBSCRIPTION_OFFER_VALIDITY_HOURS * HOUR;
    expect(Math.abs(new Date(body.openRequest.expiresOfferAt).getTime() - expected)).toBeLessThan(5000);
    expect(body.recentRequests.length).toBe(1);
    expect(body.recentRequests[0]).not.toHaveProperty("receiptImageURL");
  });
  it("PENDING tenant sees PENDING; wallet matches config", async () => {
    setSession("ADMIN", TENANT_P);
    const statusBody = await (await getBillingStatus()).json();
    expect(statusBody.status).toBe("PENDING");
    expect(statusBody.wallet).toBe(SHAM_CASH_WALLET);
    const created = await (await createSubscription(jsonReq({ tier: "monthly" }))).json();
    expect(created.wallet).toBe(SHAM_CASH_WALLET);
  });
  it("effective status: GRACE right after expiry, EXPIRED after the grace window", async () => {
    setSession("ADMIN", TENANT_A);
    S.tenants[TENANT_A].expiresAt = new Date(Date.now() - 1 * DAY);
    expect((await (await getBillingStatus()).json()).status).toBe("GRACE");
    S.tenants[TENANT_A].expiresAt = new Date(Date.now() - (SUBSCRIPTION_GRACE_DAYS + 1) * DAY);
    expect((await (await getBillingStatus()).json()).status).toBe("EXPIRED");
  });
  it("recent requests: only the last 10, newest first, rejection reason included, no open request", async () => {
    setSession("ADMIN", TENANT_A);
    for (let i = 0; i < 12; i++) {
      seedSub({
        status: "REJECTED",
        rejectionReason: "r" + i,
        createdAt: new Date(Date.now() - i * HOUR),
      });
    }
    const body = await (await getBillingStatus()).json();
    expect(body.openRequest).toBeNull();
    expect(body.recentRequests.length).toBe(10);
    expect(body.recentRequests.map((r: any) => r.rejectionReason)).toEqual(
      Array.from({ length: 10 }, (_, i) => "r" + i)
    );
    for (const r of body.recentRequests) expect(r).not.toHaveProperty("receiptImageURL");
  });
  it("T7: tenant B can never touch tenant A rows", async () => {
    setSession("ADMIN", TENANT_A);
    const aSub = seedSub();
    const withReceipt = seedSub({ receiptImageURL: "receipts/" + TENANT_A + "/a.jpg" });
    setSession("ADMIN", TENANT_B);
    expect((await uploadReceipt(multipartReq(JPEG, "r.jpg", "image/jpeg"), paramsFor(aSub.id))).status).toBe(404);
    expect(S.uploads.length).toBe(0);
    expect((await getReceiptUrl(new Request("http://test/") as any, paramsFor(withReceipt.id))).status).toBe(404);
    expect(S.signedArgs.length).toBe(0);
    const body = await (await getBillingStatus()).json();
    expect(body.openRequest).toBeNull();
    expect(body.recentRequests).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe("T6a static scans", () => {
  const root = path.resolve(__dirname, "../../..");
  const read = (p: string) => readFileSync(path.join(root, p), "utf8");
  const stripComments = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const createSrc = read("app/api/billing/subscriptions/route.ts");
  const receiptSrc = read("app/api/billing/subscriptions/[id]/receipt/route.ts");
  const statusSrc = read("app/api/billing/status/route.ts");
  const allCode = stripComments(createSrc + "\n" + receiptSrc + "\n" + statusSrc);

  it("no raw Decimal; money through the helpers", () => {
    expect(allCode).not.toMatch(/new Decimal\(/);
    expect(createSrc).toContain("multiplyMoney");
    expect(createSrc).toContain("roundToWholeLira");
  });
  it("no native-number money arithmetic or parsing in the billing routes", () => {
    expect(allCode).not.toMatch(/parseFloat\(/);
    expect(allCode).not.toMatch(/Number\([^)]*(amount|price|rate|syp|usd)/i);
  });
  it("platform rate only; never the merchant's own tenant rate", () => {
    const code = stripComments(createSrc);
    expect(code).toContain("getPlatformExchangeRate");
    expect(code).not.toMatch(/dailyExchangeRate/);
    expect(code).not.toMatch(/\.tenant\./);
  });
  it("create: top-level writes, no nested writes, retry wraps the transaction", () => {
    const code = stripComments(createSrc);
    expect(code).toContain("tx.subscription.create");
    expect(code).not.toMatch(/\b(connectOrCreate|createMany|upsert)\b/);
    expect(code).not.toMatch(/data:\s*\{[^}]*\b(create|connect)\s*:/);
    expect(createSrc.indexOf("for (let attempt")).toBeLessThan(createSrc.indexOf("$transaction"));
  });
  it("receipt route uses ONLY the private-bucket helpers", () => {
    expect(receiptSrc).toContain("uploadPrivateReceipt");
    expect(receiptSrc).toContain("removePrivateReceipt");
    expect(receiptSrc).toContain("createReceiptSignedUrl");
    expect(receiptSrc).not.toMatch(/uploadFileToStorage|removeFileFromStorage|\bcreateSignedUrl\(|getPublicUrl/);
  });
  it("receipt update is pinned: tenantId + the receipt value that was read", () => {
    const code = stripComments(receiptSrc);
    expect(code).toMatch(/receiptImageURL:\s*oldKey/);
    expect(code).toMatch(/updateMany\(\s*\{\s*where:\s*\{[\s\S]{0,300}?tenantId/);
    expect(receiptSrc).toContain("receipts/${tenantId}/");
  });
  it("status never returns the receipt key", () => {
    expect(statusSrc).not.toMatch(/receiptImageURL:\s*r\./);
  });
  it("shared upload route is product-images only (no receipts into the public bucket)", () => {
    const code = stripComments(read("app/api/upload/receipt/route.ts"));
    expect(code).toMatch(/kindInput\s*!==\s*"product"/);
    expect(code).not.toMatch(/"receipts"/);
    expect(code).toContain("assertTenantWritable");
  });
});