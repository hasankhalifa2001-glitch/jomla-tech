/* eslint-disable @typescript-eslint/no-explicit-any */
/** T6b Phase 2 — queue/detail/receipt. REAL gateway+handlers; MOCKED db/auth/storage. */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const S = vi.hoisted(() => ({
  session: null as any,
  subs: [] as any[],
  tenants: [] as any[],
  users: {} as Record<string, Record<string, any>>,
  signedKeys: [] as string[],
}));

const { subDelegate, tenantDelegate, tenantUserDelegate } = vi.hoisted(() => {
  const matchSub = (r: any, w: any): boolean => {
    if (!w) return true;
    if (w.status && r.status !== w.status) return false;
    if (w.tenantId !== undefined) {
      if (typeof w.tenantId === "string" && r.tenantId !== w.tenantId) return false;
    }
    if (Array.isArray(w.AND)) {
      for (const clause of w.AND) {
        const or = clause.OR;
        if (Array.isArray(or)) {
          const ok = or.some((b: any) => {
            if (b.createdAt?.lt) return r.createdAt.getTime() < b.createdAt.lt.getTime();
            if (b.createdAt?.equals) {
              return (
                r.createdAt.getTime() === b.createdAt.equals.getTime() &&
                b.id?.lt !== undefined &&
                r.id < b.id.lt
              );
            }
            return false;
          });
          if (!ok) return false;
        }
      }
    }
    return true;
  };
  const subDelegate = {
    findMany: vi.fn((a: any) => {
      let rows = S.subs.filter((r: any) => matchSub(r, a?.where));
      const ors = a?.where?.OR;
      if (Array.isArray(ors)) {
        rows = rows.filter((r: any) =>
          ors.some((b: any) => {
            if (b.referenceCode?.contains) {
              const n = String(b.referenceCode.contains).toUpperCase();
              return String(r.referenceCode).toUpperCase().includes(n);
            }
            if (b.tenantId?.in) return (b.tenantId.in as string[]).includes(r.tenantId);
            return false;
          }),
        );
      }
      rows = [...rows].sort((x, y) => {
        const dt = y.createdAt.getTime() - x.createdAt.getTime();
        if (dt !== 0) return dt;
        return x.id < y.id ? 1 : x.id > y.id ? -1 : 0;
      });
      return Promise.resolve(rows.slice(0, a?.take ?? 25));
    }),
    findUnique: vi.fn((a: any) => Promise.resolve(S.subs.find((r: any) => r.id === a?.where?.id) ?? null)),
    count: vi.fn((a: any) => Promise.resolve(S.subs.filter((r: any) => matchSub(r, a?.where)).length)),
  };
  const tenantDelegate = {
    findUnique: vi.fn((a: any) => {
      if (a?.where?.slug) return Promise.resolve(S.tenants.find((t: any) => t.slug === a.where.slug) ?? null);
      return Promise.resolve(S.tenants.find((t: any) => t.id === a?.where?.id) ?? null);
    }),
    findMany: vi.fn((a: any) => {
      let rows = [...S.tenants];
      if (a?.where?.name?.contains) rows = rows.filter((t: any) => t.name.includes(String(a.where.name.contains)));
      if (a?.where?.id?.in) rows = rows.filter((t: any) => (a.where.id.in as string[]).includes(t.id));
      if (a?.orderBy?.id === "asc") rows.sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
      return Promise.resolve(rows.slice(0, a?.take ?? 100));
    }),
  };
  const tenantUserDelegate = {
    findFirst: vi.fn((a: any) => Promise.resolve(S.users[S.session?.user?.tenantId]?.[a?.where?.id] ?? null)),
  };
  return { subDelegate, tenantDelegate, tenantUserDelegate };
});

vi.mock("@/auth", () => ({ auth: vi.fn(async () => S.session) }));
vi.mock("next/navigation", () => ({ notFound: vi.fn(() => { throw new Error("NOT_FOUND"); }) }));
vi.mock("@/lib/db/platform", () => ({
  getPlatformDb: vi.fn(() => ({ subscription: subDelegate, tenant: tenantDelegate })),
}));
vi.mock("@/lib/db/tenant-scope", () => ({
  getTenantDb: vi.fn(() => ({ user: tenantUserDelegate, tenant: tenantDelegate })),
  tenantScopedRawQuery: vi.fn(async () => []),
}));
vi.mock("@/lib/storage", () => ({
  RECEIPT_SIGNED_URL_MAX_SECONDS: 300,
  createReceiptSignedUrl: vi.fn(async (key: string) => {
    S.signedKeys.push(key);
    return `https://signed/${key}`;
  }),
}));

import { GET as listHandler } from "@/app/api/admin/subscriptions/route";
import { GET as detailHandler } from "@/app/api/admin/subscriptions/[id]/route";
import { GET as receiptHandler } from "@/app/api/admin/subscriptions/[id]/receipt/route";
import {
  previewNewExpiry,
} from "@/lib/data/platform-admin";
import { SUBSCRIPTION_OFFER_VALIDITY_HOURS } from "@/lib/config/subscription";

const PLAT = "tenant-platform";
const AID = "admin-platform";
const HOUR = 3600e3;

function seed() {
  S.signedKeys = [];
  S.tenants = [
    { id: PLAT, name: "m", slug: "platform-internal", phone: null, dailyExchangeRate: "15000", subscriptionStatus: "ACTIVE", expiresAt: null },
    { id: "t-a", name: "AAA", slug: "al-fajr", phone: "+963944556677", subscriptionStatus: "PENDING", expiresAt: null },
    { id: "t-b", name: "BBB", slug: "al-nour", phone: null, subscriptionStatus: "ACTIVE", expiresAt: new Date("2099-12-01T00:00:00Z") },
  ];
  S.subs = [
    { id: "s-new", tenantId: "t-a", tier: "monthly", durationDays: 30, amountSYP: "150000", amountUSD: "10", referenceCode: "JT-ABCDEFGH", exchangeRateUsed: "15000", status: "PENDING_APPROVAL", receiptImageURL: "receipts/t-a/r1.jpg", rejectionReason: null, reviewedAt: null, createdAt: new Date(Date.now() - 2 * HOUR), updatedAt: new Date() },
    { id: "s-old", tenantId: "t-b", tier: "yearly", durationDays: 365, amountSYP: "1500000", amountUSD: "100", referenceCode: "JT-XXXXYYYY", exchangeRateUsed: "15000", status: "PENDING_APPROVAL", receiptImageURL: null, rejectionReason: null, reviewedAt: null, createdAt: new Date(Date.now() - (SUBSCRIPTION_OFFER_VALIDITY_HOURS + 5) * HOUR), updatedAt: new Date() },
    { id: "s-act", tenantId: "t-b", tier: "monthly", durationDays: 30, amountSYP: "150000", amountUSD: "10", referenceCode: "JT-ACTIVE01", exchangeRateUsed: "15000", status: "ACTIVE", receiptImageURL: "receipts/t-b/ok.jpg", rejectionReason: null, reviewedAt: new Date(), createdAt: new Date("2026-09-01T10:00:00Z"), updatedAt: new Date() },
    { id: "s-rej", tenantId: "t-a", tier: "monthly", durationDays: 30, amountSYP: "150000", amountUSD: "10", referenceCode: "JT-REJECT01", exchangeRateUsed: "15000", status: "REJECTED", receiptImageURL: null, rejectionReason: "انتهت صلاحية العرض", reviewedAt: new Date(), createdAt: new Date("2026-08-01T10:00:00Z"), updatedAt: new Date() },
    // Tamper case: the stored key points at ANOTHER tenant's folder.
    { id: "s-evil", tenantId: "t-a", tier: "monthly", durationDays: 30, amountSYP: "150000", amountUSD: "10", referenceCode: "JT-EVIL0001", exchangeRateUsed: "15000", status: "PENDING_APPROVAL", receiptImageURL: "receipts/t-b/stolen.jpg", rejectionReason: null, reviewedAt: null, createdAt: new Date(Date.now() - 3 * HOUR), updatedAt: new Date() },
  ];
  S.users = { [PLAT]: { [AID]: { id: AID, tenantId: PLAT, isActive: true, isPlatformAdmin: true } } };
  S.session = { user: { id: AID, role: "ADMIN", tenantId: PLAT } };
}

beforeEach(() => { seed(); vi.clearAllMocks(); });

function listReq(q = ""): NextRequest {
  return new NextRequest(q ? `http://localhost/api/admin/subscriptions?${q}` : "http://localhost/api/admin/subscriptions");
}
const paramsFor = (id: string) => ({ params: Promise.resolve({ id }) });
const getReq = () => new NextRequest("http://localhost/api/admin/subscriptions/x");

describe("T6b Phase 2: auth", () => {
  it("non-platform ADMIN gets 403 on list, detail and receipt", async () => {
    S.users = { "t-a": { x: { id: "x", tenantId: "t-a", isActive: true, isPlatformAdmin: false } } };
    S.session = { user: { id: "x", role: "ADMIN", tenantId: "t-a" } };
    expect((await listHandler(listReq())).status).toBe(403);
    expect((await detailHandler(getReq(), paramsFor("s-new"))).status).toBe(403);
    expect((await receiptHandler(getReq(), paramsFor("s-new"))).status).toBe(403);
    expect(S.signedKeys).toHaveLength(0);
  });
  it("stale JWT true plus DB false gives 403", async () => {
    S.users[PLAT][AID].isPlatformAdmin = false;
    S.session = { user: { id: AID, role: "ADMIN", tenantId: PLAT, isPlatformAdmin: true } };
    expect((await listHandler(listReq())).status).toBe(403);
  });
  it("deactivated platform admin gets 403", async () => {
    S.users[PLAT][AID].isActive = false;
    expect((await listHandler(listReq())).status).toBe(403);
  });
  it("no session gets 403", async () => {
    S.session = null;
    expect((await listHandler(listReq())).status).toBe(403);
  });
});

describe("T6b Phase 2: queue", () => {
  it("default tab is PENDING, newest first, amounts as strings", async () => {
    const j: any = await (await listHandler(listReq())).json();
    expect(j.items.map((r: any) => r.id)).toEqual(["s-new", "s-evil", "s-old"]);
    expect(j.pendingCount).toBe(3);
    expect(typeof j.items[0].amountSYP).toBe("string");
    expect(j.items[0].hasReceipt).toBe(true);
    expect(j.items[0].tenant.slug).toBe("al-fajr");
  });
  it("every list query carries an explicit status filter", async () => {
    await listHandler(listReq());
    for (const call of subDelegate.findMany.mock.calls) {
      expect((call[0] as any).where.status).toBeDefined();
    }
  });
  it("tabs: ACTIVE and REJECTED return only their own status", async () => {
    const act: any = await (await listHandler(listReq("status=ACTIVE"))).json();
    expect(act.items.map((r: any) => r.id)).toEqual(["s-act"]);
    const rej: any = await (await listHandler(listReq("status=REJECTED"))).json();
    expect(rej.items.map((r: any) => r.id)).toEqual(["s-rej"]);
  });
  it("an unknown status is rejected with 400, never an unfiltered list", async () => {
    const res = await listHandler(listReq("status=EVERYTHING"));
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toBe("INVALID_QUERY");
    // Nothing was queried at all.
    expect(subDelegate.findMany).not.toHaveBeenCalled();
  });
  it("isStale follows the configured validity window", async () => {
    const j: any = await (await listHandler(listReq())).json();
    const byId = Object.fromEntries(j.items.map((r: any) => [r.id, r]));
    expect(byId["s-new"].isStale).toBe(false);
    expect(byId["s-old"].isStale).toBe(true);
  });
  it("bad cursor gives 400 INVALID_CURSOR", async () => {
    const res = await listHandler(listReq("cursor=!!bad!!"));
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toBe("INVALID_CURSOR");
  });
  it("cursor: the page after it excludes everything at or before the cursor", async () => {
    const first: any = await (await listHandler(listReq("limit=1"))).json();
    expect(first.items.map((r: any) => r.id)).toEqual(["s-new"]);
    expect(first.nextCursor).toBeTruthy();
    const second: any = await (await listHandler(listReq(`limit=1&cursor=${first.nextCursor}`))).json();
    expect(second.items.map((r: any) => r.id)).toEqual(["s-evil"]);
    const third: any = await (await listHandler(listReq(`limit=1&cursor=${second.nextCursor}`))).json();
    expect(third.items.map((r: any) => r.id)).toEqual(["s-old"]);
    expect(third.nextCursor).toBeNull();
  });
  it("cursor with equal createdAt breaks the tie by id (no row lost or repeated)", async () => {
    const same = new Date("2026-10-18T10:00:00Z");
    S.subs.push(
      { ...S.subs[0], id: "tie-a", referenceCode: "JT-TIE00001", createdAt: same },
      { ...S.subs[0], id: "tie-b", referenceCode: "JT-TIE00002", createdAt: same },
    );
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 10; i++) {
      const j: any = await (await listHandler(listReq(`limit=1${cursor ? `&cursor=${cursor}` : ""}`))).json();
      seen.push(...j.items.map((r: any) => r.id));
      cursor = j.nextCursor;
      if (!cursor) break;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toContain("tie-a");
    expect(seen).toContain("tie-b");
    expect(seen).toHaveLength(5);
  });
  it("referenceCode search is case-insensitive", async () => {
    const j: any = await (await listHandler(listReq("q=jt-abcdefgh"))).json();
    expect(j.items.map((r: any) => r.id)).toEqual(["s-new"]);
  });
  it("tenant-name search matches that tenant's requests", async () => {
    const j: any = await (await listHandler(listReq("q=BBB"))).json();
    expect(j.items.map((r: any) => r.id)).toEqual(["s-old"]);
  });
  it("tenant-name cap gives searchTruncated and uses a stable order", async () => {
    for (let i = 0; i < 105; i++) S.tenants.push({ id: `tx-${i}`, name: "ZZZ", slug: `s-${i}`, phone: null });
    const j: any = await (await listHandler(listReq("q=ZZZ"))).json();
    expect(j.searchTruncated).toBe(true);
    const call = tenantDelegate.findMany.mock.calls.find((c: any) => c[0]?.where?.name?.contains === "ZZZ");
    expect((call![0] as any).orderBy).toEqual({ id: "asc" });
    expect((call![0] as any).take).toBe(101);
  });
});

describe("T6b Phase 2: detail", () => {
  it("returns amounts, frozen rate, current platform rate and the D6 preview", async () => {
    const res = await detailHandler(getReq(), paramsFor("s-new"));
    expect(res.status).toBe(200);
    const j: any = await res.json();
    const d = j.subscription ?? j;
    expect(d.amountSYP).toBe("150000");
    expect(d.exchangeRateUsed).toBe("15000");
    expect(d.isStale).toBe(false);
    const platformRate = j.platformRate ?? d.platformRate;
    expect(platformRate.current).toBe("15000");
    expect(d.previewNewExpiry ?? j.previewNewExpiry).toBeTruthy();
    expect(JSON.stringify(j)).not.toContain("receipts/");
  });
  it("flags a stale offer but still returns it (approval stays allowed)", async () => {
    const j: any = await (await detailHandler(getReq(), paramsFor("s-old"))).json();
    expect((j.subscription ?? j).isStale).toBe(true);
  });
  it("unknown id gives 404 NOT_FOUND", async () => {
    const res = await detailHandler(getReq(), paramsFor("nope"));
    expect(res.status).toBe(404);
    expect(((await res.json()) as any).error).toBe("NOT_FOUND");
  });
});

describe("T6b Phase 2: D6 preview math", () => {
  const now = new Date("2026-10-18T00:00:00Z");
  const day = 86400e3;
  it("first approval (no expiry) = now + duration", () => {
    expect(previewNewExpiry({ now, tenantExpiresAt: null, durationDays: 30 }).getTime()).toBe(now.getTime() + 30 * day);
  });
  it("early renewal stacks on the remaining time", () => {
    const exp = new Date(now.getTime() + 10 * day);
    expect(previewNewExpiry({ now, tenantExpiresAt: exp, durationDays: 30 }).getTime()).toBe(exp.getTime() + 30 * day);
  });
  it("renewal after expiry starts from now", () => {
    const exp = new Date(now.getTime() - 10 * day);
    expect(previewNewExpiry({ now, tenantExpiresAt: exp, durationDays: 30 }).getTime()).toBe(now.getTime() + 30 * day);
  });
});

describe("T6b Phase 2: receipt", () => {
  it("signs a key under the OWNING tenant's prefix", async () => {
    const res = await receiptHandler(getReq(), paramsFor("s-new"));
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).url).toBe("https://signed/receipts/t-a/r1.jpg");
    expect(S.signedKeys).toEqual(["receipts/t-a/r1.jpg"]);
  });
  it("the signed URL TTL never exceeds the 5-minute cap", async () => {
    const { createReceiptSignedUrl } = await import("@/lib/storage");
    await receiptHandler(getReq(), paramsFor("s-new"));
    const args = (createReceiptSignedUrl as any).mock.calls[0];
    // Either no explicit TTL (the helper clamps) or an explicit one within the cap.
    if (args.length > 1) expect(args[1]).toBeLessThanOrEqual(300);
  });
  it("a key pointing at another tenant's folder is refused (404), nothing signed", async () => {
    const res = await receiptHandler(getReq(), paramsFor("s-evil"));
    expect(res.status).toBe(404);
    expect(S.signedKeys).toHaveLength(0);
  });
  it("no receipt gives 404", async () => {
    expect((await receiptHandler(getReq(), paramsFor("s-old"))).status).toBe(404);
  });
  it("unknown id gives 404", async () => {
    expect((await receiptHandler(getReq(), paramsFor("nope"))).status).toBe(404);
  });
});

describe("T6b Phase 2: static scans", () => {
  const root = path.resolve(__dirname, "../../..");
  const read = (p: string) => readFileSync(path.join(root, p), "utf8");
  const stripComments = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  const SKIP = new Set(["node_modules", ".next", ".git", "coverage", "dist", "out"]);
  function listFiles(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) listFiles(full, out);
      else if (/\.(ts|tsx)$/.test(e.name)) out.push(full);
    }
    return out;
  }

  it("only lib/data/platform-admin.ts imports lib/db/platform (tests excluded)", () => {
    const re = /from\s+["']@\/lib\/db\/platform["']|require\(\s*["']@\/lib\/db\/platform["']\s*\)/;
    const hits = listFiles(root)
      .map((f) => path.relative(root, f).split(path.sep).join("/"))
      .filter((rel) => !rel.includes("/__tests__/"))
      .filter((rel) => re.test(read(rel)));
    expect(hits).toEqual(["lib/data/platform-admin.ts"]);
  });
  it("admin routes never import prisma directly and always call requirePlatformAdmin", () => {
    const routes = listFiles(path.join(root, "app/api/admin"))
      .map((f) => path.relative(root, f).split(path.sep).join("/"));
    expect(routes.length).toBeGreaterThan(0);
    for (const rel of routes) {
      const code = stripComments(read(rel));
      expect(code, rel).not.toMatch(/from\s+["']@\/lib\/db["']/);
      expect(code, rel).not.toMatch(/rawPrisma/);
      expect(code, rel).toContain("requirePlatformAdmin");
    }
  });
  it("the queue code never reads the JWT's isPlatformAdmin and has no raw Decimal", () => {
    const code = stripComments(read("lib/data/platform-admin.ts"));
    expect(code).not.toMatch(/session\.user\.isPlatformAdmin/);
    expect(code).not.toMatch(/new Decimal\(/);
    expect(code).not.toMatch(/\.toNumber\(\)/);
  });
  it("no nested writes in the platform data layer", () => {
    const code = stripComments(read("lib/data/platform-admin.ts"));
    expect(code).not.toMatch(/\b(create|connect|connectOrCreate|disconnect|set)\s*:\s*\{/);
  });
});