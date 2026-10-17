/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * T6b Phase 1 — requirePlatformAdmin + typed gateway + platform rate.
 *
 * REAL: lib/auth/platform-admin.ts, lib/data/platform-admin.ts
 * (validation / confirm math), app/api/admin/platform-rate GET/PUT handlers,
 * app/api/tenant/exchange-rate POST (amendment C block).
 * MOCKED: Prisma boundary (getPlatformDb / getTenantDb), session/auth.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const S = vi.hoisted(() => ({
    session: null as any,
    platformRow: null as any,
    usersByTenant: {} as Record<string, Record<string, any>>,
    tenantById: {} as Record<string, any>,
    setCalls: [] as any[],
}));

const { platformTenantDelegate, merchantTenantDelegate, tenantUserDelegate } = vi.hoisted(() => {
    const platformTenantDelegate = {
        findUnique: vi.fn(async (args: any) => {
            if (args?.where?.slug === "platform-internal") return S.platformRow;
            return null;
        }),
        update: vi.fn(async (args: any) => {
            if (args?.where?.slug !== "platform-internal") throw new Error("not found");
            S.setCalls.push(args);
            S.platformRow = {
                ...(S.platformRow ?? {}),
                dailyExchangeRate: args.data.dailyExchangeRate,
                updatedAt: new Date("2026-10-17T12:00:00.000Z"),
            };
            return S.platformRow;
        }),
    };
    const merchantTenantDelegate = {
        findUnique: vi.fn(async (args: any) => S.tenantById[args?.where?.id] ?? null),
        update: vi.fn(async (args: any) => ({
            id: args.where.id,
            dailyExchangeRate: args.data.dailyExchangeRate,
        })),
    };
    const tenantUserDelegate = {
        // requirePlatformAdmin() uses findFirst; lib/auth/user.ts uses findUnique.
        findFirst: vi.fn(async (args: any) => {
            const tenantId = S.session?.user?.tenantId;
            return S.usersByTenant[tenantId]?.[args?.where?.id] ?? null;
        }),
        findUnique: vi.fn(async (args: any) => {
            const tenantId = S.session?.user?.tenantId;
            const row = S.usersByTenant[tenantId]?.[args?.where?.id];
            return row ? { isActive: row.isActive } : null;
        }),
    };
    return { platformTenantDelegate, merchantTenantDelegate, tenantUserDelegate };
});

vi.mock("@/auth", () => ({ auth: vi.fn(async () => S.session) }));

vi.mock("next/navigation", () => ({
    notFound: vi.fn(() => {
        throw new Error("NOT_FOUND");
    }),
}));

vi.mock("@/lib/db/platform", () => ({
    getPlatformDb: vi.fn(() => ({ tenant: platformTenantDelegate })),
}));

vi.mock("@/lib/db/tenant-scope", () => ({
    getTenantDb: vi.fn(() => ({ tenant: merchantTenantDelegate, user: tenantUserDelegate })),
    tenantScopedRawQuery: vi.fn(async () => []),
}));

vi.mock("@/lib/db", () => ({
    getTenantDb: vi.fn(() => ({ tenant: merchantTenantDelegate, user: tenantUserDelegate })),
}));

vi.mock("@/lib/auth/tenant", async (importOriginal) => {
    const actual = await importOriginal<any>();
    return { ...actual, assertTenantWritable: vi.fn(async () => "ACTIVE") };
});

import {
    validatePlatformRateInput,
    platformRateNeedsConfirm,
    setPlatformRate,
    InvalidPlatformRateError,
    PlatformRateConfirmRequiredError,
} from "@/lib/data/platform-admin";
import { requirePlatformAdminForPage } from "@/lib/auth/platform-admin";
import { GET as adminGet, PUT as adminPut } from "@/app/api/admin/platform-rate/route";
import { POST as merchantPost } from "@/app/api/tenant/exchange-rate/route";
import {
    SUBSCRIPTION_TIERS,
    SUBSCRIPTION_OFFER_VALIDITY_HOURS,
    SUBSCRIPTION_GRACE_DAYS,
    getTierConfig,
} from "@/lib/config/subscription";

function ctx(): any {
    return { userId: "sa-1", tenantId: "platform-tenant-id" };
}

function seedUsers() {
    S.usersByTenant = {
        "platform-tenant-id": {
            "sa-1": { id: "sa-1", tenantId: "platform-tenant-id", isActive: true, isPlatformAdmin: true },
            "demoted-1": { id: "demoted-1", tenantId: "platform-tenant-id", isActive: true, isPlatformAdmin: false },
            "inactive-1": { id: "inactive-1", tenantId: "platform-tenant-id", isActive: false, isPlatformAdmin: true },
        },
        "merchant-tenant": {
            "merchant-admin": { id: "merchant-admin", tenantId: "merchant-tenant", isActive: true, isPlatformAdmin: false },
            "cashier-1": { id: "cashier-1", tenantId: "merchant-tenant", isActive: true, isPlatformAdmin: false },
        },
    };
    S.tenantById = {
        "platform-tenant-id": { id: "platform-tenant-id", slug: "platform-internal" },
        "merchant-tenant": { id: "merchant-tenant", slug: "al-baraka" },
    };
}

function session(userId: string, tenantId: string, role: "ADMIN" | "CASHIER" = "ADMIN", claimsPlatformAdmin = true) {
    S.session = { user: { id: userId, tenantId, role, isPlatformAdmin: claimsPlatformAdmin } };
}

function putReq(body: unknown) {
    return new Request("http://localhost/api/admin/platform-rate", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
}

beforeEach(() => {
    S.session = null;
    S.setCalls = [];
    S.platformRow = {
        slug: "platform-internal",
        dailyExchangeRate: "15000",
        updatedAt: new Date("2026-10-16T10:00:00.000Z"),
    };
    seedUsers();
    vi.clearAllMocks();
});

describe("T6b Phase 1: platform auth", () => {
    it("no session → 403", async () => {
        S.session = null;
        expect((await adminGet()).status).toBe(403);
        expect((await adminPut(putReq({ rate: "15100" }))).status).toBe(403);
    });

    it("a merchant ADMIN (not platform admin) gets 403", async () => {
        session("merchant-admin", "merchant-tenant", "ADMIN", false);
        const res = await adminGet();
        expect(res.status).toBe(403);
        expect(((await res.json()) as any).error).toBe("FORBIDDEN");
    });

    it("a CASHIER gets 403", async () => {
        session("cashier-1", "merchant-tenant", "CASHIER", false);
        expect((await adminGet()).status).toBe(403);
        expect((await adminPut(putReq({ rate: "15100" }))).status).toBe(403);
        expect(S.setCalls).toHaveLength(0);
    });

    it("a stale JWT claiming isPlatformAdmin is rejected when the DB says otherwise", async () => {
        session("demoted-1", "platform-tenant-id", "ADMIN", true);
        expect((await adminGet()).status).toBe(403);
    });

    it("a deactivated platform admin is rejected on the next request, nothing written", async () => {
        session("inactive-1", "platform-tenant-id", "ADMIN", true);
        expect((await adminPut(putReq({ rate: "15100" }))).status).toBe(403);
        expect(S.setCalls).toHaveLength(0);
    });

    it("an active platform admin reads the rate with its last-changed time", async () => {
        session("sa-1", "platform-tenant-id");
        const res = await adminGet();
        expect(res.status).toBe(200);
        const body: any = await res.json();
        expect(body.rate).toBe("15000");
        expect(body.updatedAt).toBe("2026-10-16T10:00:00.000Z");
        expect(body.rateAvailable).toBe(true);
    });

    it("platform tenant row missing → 404 (not a crash)", async () => {
        session("sa-1", "platform-tenant-id");
        S.platformRow = null;
        const res = await adminGet();
        expect(res.status).toBe(404);
    });

    it("rate not set yet → rateAvailable false", async () => {
        session("sa-1", "platform-tenant-id");
        S.platformRow = { slug: "platform-internal", dailyExchangeRate: null, updatedAt: new Date() };
        const body: any = await (await adminGet()).json();
        expect(body.rate).toBeNull();
        expect(body.rateAvailable).toBe(false);
    });

    it("malformed JSON body → 400 INVALID_BODY", async () => {
        session("sa-1", "platform-tenant-id");
        const res = await adminPut(
            new Request("http://localhost/api/admin/platform-rate", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: "{not json",
            })
        );
        expect(res.status).toBe(400);
        expect(((await res.json()) as any).error).toBe("INVALID_BODY");
    });
});

describe("T6b Phase 1: page guard", () => {
    it("denied access renders notFound()", async () => {
        session("demoted-1", "platform-tenant-id");
        await expect(requirePlatformAdminForPage()).rejects.toThrow("NOT_FOUND");
    });

    it("a real failure (DB down) is NOT disguised as 404", async () => {
        session("sa-1", "platform-tenant-id");
        tenantUserDelegate.findFirst.mockRejectedValueOnce(new Error("db down"));
        await expect(requirePlatformAdminForPage()).rejects.toThrow("db down");
    });

    it("an active platform admin passes", async () => {
        session("sa-1", "platform-tenant-id");
        const c = await requirePlatformAdminForPage();
        expect(c.userId).toBe("sa-1");
    });
});

describe("T6b Phase 1: rate validation + confirm (amendment E)", () => {
    it.each(["0", "-5", "abc", "", "12.12345", "1000000.0001", 15000, null])(
        "rejects invalid rate %p with 400 and writes nothing",
        async (rate) => {
            session("sa-1", "platform-tenant-id");
            const res = await adminPut(putReq({ rate }));
            expect(res.status).toBe(400);
            expect(((await res.json()) as any).error).toBe("INVALID_RATE");
            expect(S.setCalls).toHaveLength(0);
        }
    );

    it("accepts a 4dp Decimal string within bounds and canonicalizes it", () => {
        expect(validatePlatformRateInput("15000.5000")).toBe("15000.5");
    });

    it("a >25% move without confirm is 409 CONFIRM_REQUIRED and writes nothing", async () => {
        session("sa-1", "platform-tenant-id");
        const res = await adminPut(putReq({ rate: "20000" }));
        expect(res.status).toBe(409);
        const body: any = await res.json();
        expect(body.error).toBe("CONFIRM_REQUIRED");
        expect(body.currentRate).toBe("15000");
        expect(body.newRate).toBe("20000");
        expect(S.setCalls).toHaveLength(0);
    });

    it("confirm must be exactly true (truthy strings do not count)", async () => {
        session("sa-1", "platform-tenant-id");
        const res = await adminPut(putReq({ rate: "20000", confirm: "true" }));
        expect(res.status).toBe(409);
        expect(S.setCalls).toHaveLength(0);
    });

    it("the same move with confirm: true writes", async () => {
        session("sa-1", "platform-tenant-id");
        const res = await adminPut(putReq({ rate: "20000", confirm: true }));
        expect(res.status).toBe(200);
        expect(((await res.json()) as any).rate).toBe("20000");
        expect(S.setCalls).toHaveLength(1);
        expect(S.setCalls[0].where).toEqual({ slug: "platform-internal" });
    });

    it("a small move needs no confirm", async () => {
        session("sa-1", "platform-tenant-id");
        expect((await adminPut(putReq({ rate: "15100" }))).status).toBe(200);
    });

    it("first-ever rate (none set) needs no confirm", async () => {
        session("sa-1", "platform-tenant-id");
        S.platformRow = { slug: "platform-internal", dailyExchangeRate: null, updatedAt: new Date() };
        expect((await adminPut(putReq({ rate: "15000" }))).status).toBe(200);
    });

    it("pure confirm math: exactly 25% passes, just above needs confirm", () => {
        expect(platformRateNeedsConfirm("100", "125")).toBe(false);
        expect(platformRateNeedsConfirm("100", "75")).toBe(false);
        expect(platformRateNeedsConfirm("100", "125.0001")).toBe(true);
        expect(platformRateNeedsConfirm("100", "74.9999")).toBe(true);
        expect(platformRateNeedsConfirm(null, "999")).toBe(false);
        expect(platformRateNeedsConfirm("0", "999")).toBe(false);
    });

    it("typed errors surface from the data layer", async () => {
        await expect(setPlatformRate(ctx(), { rate: "0" })).rejects.toBeInstanceOf(InvalidPlatformRateError);
        await expect(setPlatformRate(ctx(), { rate: "20000" })).rejects.toBeInstanceOf(
            PlatformRateConfirmRequiredError
        );
    });
});

describe("T6b Phase 1: amendment C (single edit path)", () => {
    it("the merchant top-bar endpoint 403s for the platform-internal tenant", async () => {
        S.session = { user: { id: "sa-1", tenantId: "platform-tenant-id", role: "ADMIN" } };
        const res = await merchantPost(
            new Request("http://localhost/api/tenant/exchange-rate", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ rate: 16000 }),
            })
        );
        expect(res.status).toBe(403);
        expect(((await res.json()) as any).error).toBe("FORBIDDEN");
        expect(merchantTenantDelegate.update).not.toHaveBeenCalled();
    });

    it("a normal merchant can still edit its own rate (the block is not global)", async () => {
        S.session = { user: { id: "merchant-admin", tenantId: "merchant-tenant", role: "ADMIN" } };
        const res = await merchantPost(
            new Request("http://localhost/api/tenant/exchange-rate", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ rate: 16000 }),
            })
        );
        expect(res.status).toBe(200);
        expect(merchantTenantDelegate.update).toHaveBeenCalledTimes(1);
    });
});

describe("T6b Phase 1: config sanity (guards the owner's decisions)", () => {
    // If you INTENTIONALLY change a price, update this test in the same change.
    it("D1 list prices", () => {
        expect(SUBSCRIPTION_TIERS.monthly.priceUSD).toBe("10");
        expect(SUBSCRIPTION_TIERS.yearly.priceUSD).toBe("100");
        expect(SUBSCRIPTION_TIERS.monthly.durationDays).toBe(30);
        expect(SUBSCRIPTION_TIERS.yearly.durationDays).toBe(365);
    });

    it("validity window and grace period are positive whole numbers", () => {
        expect(Number.isInteger(SUBSCRIPTION_OFFER_VALIDITY_HOURS)).toBe(true);
        expect(SUBSCRIPTION_OFFER_VALIDITY_HOURS).toBeGreaterThan(0);
        expect(Number.isInteger(SUBSCRIPTION_GRACE_DAYS)).toBe(true);
        expect(SUBSCRIPTION_GRACE_DAYS).toBeGreaterThan(0);
    });

    it("getTierConfig never resolves prototype names", () => {
        expect(getTierConfig("monthly")).toBeDefined();
        for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
            expect(getTierConfig(name)).toBeUndefined();
        }
    });
});

describe("T6b Phase 1: static scans", () => {
    const root = path.resolve(__dirname, "../../..");
    const read = (p: string) => readFileSync(path.join(root, p), "utf8");

    const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "coverage", "dist", "out"]);
    function listSourceFiles(dir: string, out: string[] = []): string[] {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (SKIP_DIRS.has(entry.name)) continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) listSourceFiles(full, out);
            else if (/\.(ts|tsx|mjs|js)$/.test(entry.name)) out.push(full);
        }
        return out;
    }

    it("only lib/data/platform-admin.ts imports lib/db/platform (tests that mock it are excluded)", () => {
        const aliasOrRelative =
            /from\s+["'](?:@\/lib\/db\/platform|(?:\.\.?\/)+(?:lib\/)?db\/platform)["']|require\(\s*["'](?:@\/lib\/db\/platform|(?:\.\.?\/)+(?:lib\/)?db\/platform)["']\s*\)|import\(\s*["']@\/lib\/db\/platform["']\s*\)/;
        const siblingImport = /from\s+["']\.\/platform["']/; // only meaningful inside lib/db/

        const hits = listSourceFiles(root)
            .map((f) => path.relative(root, f).split(path.sep).join("/"))
            .filter((rel) => !rel.includes("/__tests__/"))
            .filter((rel) => {
                const src = read(rel);
                if (aliasOrRelative.test(src)) return true;
                return rel.startsWith("lib/db/") && siblingImport.test(src);
            });

        expect(hits).toEqual(["lib/data/platform-admin.ts"]);
    });

    it("platform-admin data layer uses money helpers: no raw Decimal, no native-number math", () => {
        const src = read("lib/data/platform-admin.ts");
        expect(src).not.toMatch(/new Decimal\(/);
        expect(src).not.toMatch(/\.toNumber\(\)/);
        expect(src).toContain("compareMoney");
        expect(src).toContain("subtractMoney");
        expect(src).toContain("multiplyMoney");
    });

    it("the admin route and data layer never read the JWT's isPlatformAdmin", () => {
        const guard = read("lib/auth/platform-admin.ts");
        const code = guard
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .replace(/(^|[^:])\/\/.*$/gm, "$1");
        expect(code).not.toMatch(/session\.user\.isPlatformAdmin/);
        expect(code).toContain("row.isPlatformAdmin");
    });
});