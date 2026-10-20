/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
const S = vi.hoisted(() => ({ session: null as any, tenant: null as any }));
const DB = vi.hoisted(() => ({
  tenant: { findUnique: vi.fn(async () => S.tenant) },
  productCatalogEntry: { update: vi.fn(async () => { throw new Error("must not be called"); }) },
}));
vi.mock("@/auth", () => ({ auth: vi.fn(async () => S.session) }));
vi.mock("@/lib/db/tenant-scope", () => ({
  getTenantDb: vi.fn(() => DB),
  tenantScopedRawQuery: vi.fn(async () => []),
}));
vi.mock("@/lib/db", () => ({ getTenantDb: vi.fn(() => DB) }));
vi.mock("@/lib/auth/tenant", async (imp) => {
  const a: any = await imp();
  return { ...a, assertTenantWritable: vi.fn(async () => "ACTIVE") };
});
import { assertTenantWritable } from "@/lib/auth/tenant";
import { getPlatformExchangeRate } from "@/lib/data/platform-rate";

beforeEach(() => { S.session = null; S.tenant = null; vi.clearAllMocks(); });
describe("mid-session unblock", () => {
  it("approved tenant existing session succeeds with no re-login (fresh DB read)", async () => {
    S.tenant = { subscriptionStatus: "ACTIVE" };
    const { getFreshTenantStatus } = await import("@/lib/auth/tenant");
    void assertTenantWritable;
    expect(await getFreshTenantStatus("t-a")).toBe("ACTIVE");
    expect(DB.tenant.findUnique).toHaveBeenCalled();
  });
});
describe("checkout reads platform rate fresh", () => {
  it("returns set rate; null when unset (checkout blocked)", async () => {
    DB.tenant.findUnique.mockResolvedValueOnce({ dailyExchangeRate: "16000" });
    expect(await getPlatformExchangeRate("t-a")).toBe("16000");
    DB.tenant.findUnique.mockResolvedValueOnce({ dailyExchangeRate: null });
    expect(await getPlatformExchangeRate("t-a")).toBeNull();
  });
});
describe("T6b static scans", () => {
  const root = path.resolve(__dirname, "../../..");
  const read = (p: string) => readFileSync(path.join(root, p), "utf8");
  const SKIP = new Set(["node_modules", ".next", ".git", "coverage", "dist", "out"]);
  function files(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue;
      const f = path.join(dir, e.name);
      if (e.isDirectory()) files(f, out);
      else if (/\.tsx?$/.test(e.name)) out.push(f);
    }
    return out;
  }
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  it("only platform-admin.ts imports lib/db/platform (tests excluded)", () => {
    const re = /from\s+["']@\/lib\/db\/platform["']|require\(\s*["']@\/lib\/db\/platform["']\s*\)/;
    const hits = files(root).map((f) => path.relative(root, f).split(path.sep).join("/"))
      .filter((r) => !r.includes("/__tests__/")).filter((r) => re.test(read(r)));
    expect(hits).toEqual(["lib/data/platform-admin.ts"]);
  });
  it("admin routes import no raw prisma and always guard", () => {
    const routes = files(path.join(root, "app/api/admin")).map((f) => path.relative(root, f).split(path.sep).join("/"));
    expect(routes.length).toBeGreaterThan(0);
    for (const r of routes) {
      const c = strip(read(r));
      expect(c, r).not.toMatch(/from\s+["']@\/lib\/db["']/);
      expect(c, r).not.toMatch(/rawPrisma/);
      expect(c, r).toContain("requirePlatformAdmin");
    }
  });
  it("no nested writes in platform layer; no raw Decimal", () => {
    const c = strip(read("lib/data/platform-admin.ts"));
    expect(c).not.toMatch(/\b(create|connect|connectOrCreate|disconnect|set)\s*:\s*\{/);
    expect(c).not.toMatch(/new Decimal\(/);
    expect(c).not.toMatch(/\.toNumber\(\)/);
  });
  it("merchant UI never links to /admin (middleware guard + eslint config excepted)", () => {
    const hits = files(root).map((f) => path.relative(root, f).split(path.sep).join("/"))
      .filter((r) => !r.startsWith("app/admin/") && !r.startsWith("app/api/admin/") && !r.startsWith("components/admin/") && !r.includes("/__tests__/"))
      .filter((r) => r !== "middleware.ts" && r !== "eslint.config.mjs")
      .filter((r) => /["'`]\/admin/.test(read(r)));
    expect(hits).toEqual([]);
  });
});
