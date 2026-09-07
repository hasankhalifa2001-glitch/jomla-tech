/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable no-restricted-imports */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { POST as registerHandler } from "@/app/api/auth/register/route";
import { getFreshTenantStatus, getFreshExchangeRate } from "@/lib/auth/tenant";
import { applySessionFromToken } from "@/lib/auth/session-callback";
import { isValidUUIDv4 } from "@/lib/offline/id";
import { prisma } from "@/lib/db";
import type { Session } from "next-auth";
import type { JWT } from "@auth/core/jwt";
import { Prisma } from "@prisma/client";
import bcrypt from "bcryptjs";

// ============================================================================
// Mock @upstash/ratelimit / redis — overridden per-test via mockResolvedValueOnce
// on the shared `limit` spy so both the register-route limiter (3/10min) and
// the login limiter (5/5min) can be independently controlled.
// ============================================================================
const rateLimitMock = vi.fn().mockResolvedValue({ success: true });
vi.mock("@upstash/ratelimit", () => {
  return {
    Ratelimit: class {
      static slidingWindow() {
        return vi.fn();
      }
      async limit(...args: unknown[]) {
        return rateLimitMock(...args);
      }
    },
  };
});

vi.mock("@upstash/redis", () => {
  return {
    Redis: class {
      constructor() { }
    },
  };
});

// ============================================================================
// Mock @/lib/db — shared mock Prisma client used by both /register and
// /lib/auth.ts (via the Category-2/allowlisted raw `prisma` export).
// ============================================================================
vi.mock("@/lib/db", () => {
  const mockTenant = {
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  };
  const mockUser = {
    findUnique: vi.fn(),
    create: vi.fn(),
  };
  const mockCustomer = {
    create: vi.fn(),
  };

  const mockTx = {
    tenant: mockTenant,
    user: mockUser,
    customer: mockCustomer,
  };

  const rawPrisma = {
    tenant: mockTenant,
    user: mockUser,
    customer: mockCustomer,
    $transaction: vi.fn(async (callback: (tx: typeof mockTx) => Promise<unknown>) => {
      return callback(mockTx);
    }),
  };

  return {
    prisma: rawPrisma,
    getTenantDb: vi.fn(() => rawPrisma),
  };
});

// ============================================================================
// Mock bcryptjs — real bcrypt.compare is deliberately slow (~100ms+), which
// is the whole point of the timing-attack fix in auth.ts, but that makes it
// unsuitable to actually time in a unit test (CI jitter would make any such
// assertion flaky). Instead we mock `compare` and assert on WHICH hash it
// was called with — DUMMY_PASSWORD_HASH vs the real user hash — to verify
// the structural property that a "user not found"/"user inactive" path
// always calls bcrypt.compare exactly once, same as a real user does.
// ============================================================================
vi.mock("bcryptjs", () => ({
  default: {
    compare: vi.fn(),
    hash: vi.fn(async () => "hashed-password"),
  },
}));

// ============================================================================
// Capture the config objects passed into NextAuth(...) and Credentials(...)
// at module-load time, since auth.ts does not export `authorize` or the
// `jwt`/`session` callbacks as standalone functions — they only exist as
// properties of the config objects passed to these two factory calls.
// Mocking the factories to be identity-ish functions that stash their
// argument lets us reach into `capturedAuthConfig.callbacks.jwt` and
// `capturedProviderConfig.authorize` directly, without modifying auth.ts.
// ============================================================================
let capturedAuthConfig: any;
let capturedProviderConfig: any;

process.env.AUTH_SECRET = "test-auth-secret-for-vitest-suite-32chars";

vi.mock("next-auth", () => {
  class CredentialsSignin extends Error {
    code = "credentials";
  }
  return {
    CredentialsSignin,
    default: vi.fn((config: any) => {
      capturedAuthConfig = config;
      return {
        handlers: { GET: vi.fn(), POST: vi.fn() },
        auth: vi.fn(),
        signIn: vi.fn(),
        signOut: vi.fn(),
      };
    }),
  };
});

vi.mock("next-auth/providers/credentials", () => ({
  default: vi.fn((config: any) => {
    capturedProviderConfig = config;
    return { id: "credentials", type: "credentials", ...config };
  }),
}));

// ============================================================================
// [FIX] `vi.mocked(prisma)` fails to type-check against Prisma's generated
// client: Prisma's `findUnique`/`create`/etc. signatures use deep generic
// overloads (`TenantFindUniqueArgs<DefaultArgs>`, `SelectSubset<T, ...>`,
// etc.), and Vitest's `Mocked<T>` transform does not reliably convert those
// overloads into a type carrying `mockResolvedValueOnce`/`mockImplementationOnce`
// — so TS reports the *original* Prisma method type instead of a mock type,
// even though the object IS the mock created above at runtime. Rather than
// fight Prisma's generated types, we declare the exact shape of the mock we
// actually built in the `vi.mock("@/lib/db", ...)` factory above and cast
// `prisma` to it once, here. This is safe: it is not widening `any`, it is
// narrowing to precisely the mock surface this test file uses.
// ============================================================================
type MockedPrismaShape = {
  tenant: {
    findUnique: Mock;
    create: Mock;
    update: Mock;
  };
  user: {
    findUnique: Mock;
    create: Mock;
  };
  customer: {
    create: Mock;
  };
  $transaction: Mock;
};

const mockPrisma = prisma as unknown as MockedPrismaShape;

describe("T2a — Auth Foundation & Tenant Onboarding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rateLimitMock.mockResolvedValue({ success: true });
  });

  describe("1. Four-Step Atomic Onboarding Transaction in /register", () => {
    it("executes the 4 ordered top-level writes with exact payload constraints and offlineId", async () => {
      mockPrisma.tenant.findUnique.mockResolvedValueOnce(null);
      mockPrisma.user.findUnique.mockResolvedValueOnce(null);

      const writeOrder: string[] = [];

      mockPrisma.tenant.create.mockImplementationOnce(async (args: any) => {
        writeOrder.push("1.tenant.create");
        return {
          id: "tenant-123",
          name: args.data.name,
          slug: args.data.slug,
          subscriptionStatus: args.data.subscriptionStatus,
          phone: args.data.phone,
        };
      });

      mockPrisma.user.create.mockImplementationOnce(async (args: any) => {
        writeOrder.push("2.user.create");
        return {
          id: "user-admin-1",
          tenantId: args.data.tenantId,
          name: args.data.name,
          email: args.data.email,
          role: args.data.role,
          isActive: args.data.isActive,
          isPlatformAdmin: args.data.isPlatformAdmin,
        };
      });

      mockPrisma.customer.create.mockImplementationOnce(async (args: any) => {
        writeOrder.push("3.customer.create");
        return {
          id: "customer-sys-1",
          tenantId: args.data.tenantId,
          name: args.data.name,
          isSystemGenerated: args.data.isSystemGenerated,
          offlineId: args.data.offlineId,
        };
      });

      mockPrisma.tenant.update.mockImplementationOnce(async (args: any) => {
        writeOrder.push("4.tenant.update");
        return {
          id: args.where.id,
          systemCustomerId: args.data.systemCustomerId,
        };
      });

      const req = new Request("http://localhost/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tenantName: "شركة الفجر للتجارة",
          tenantSlug: "al-fajr-trade",
          phone: "+963944112233",
          adminName: "سامر المصري",
          adminEmail: "admin@alfajr.com",
          password: "SecurePassword123",
        }),
      });

      const response = await registerHandler(req);
      const json = await response.json();

      expect(response.status).toBe(200);
      expect(json.success).toBe(true);
      expect(json.tenantId).toBe("tenant-123");
      expect(json.userId).toBe("user-admin-1");

      expect(writeOrder).toEqual([
        "1.tenant.create",
        "2.user.create",
        "3.customer.create",
        "4.tenant.update",
      ]);

      expect(mockPrisma.tenant.create).toHaveBeenCalledWith({
        data: {
          name: "شركة الفجر للتجارة",
          slug: "al-fajr-trade",
          phone: "+963944112233",
          subscriptionStatus: "PENDING",
        },
      });

      expect(mockPrisma.user.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          tenantId: "tenant-123",
          name: "سامر المصري",
          email: "admin@alfajr.com",
          role: "ADMIN",
          isActive: true,
          isPlatformAdmin: false,
        }),
      });

      const customerCreateCall = mockPrisma.customer.create.mock.calls[0][0];
      expect(customerCreateCall.data.tenantId).toBe("tenant-123");
      expect(customerCreateCall.data.name).toBe("زبون نقدي");
      expect(customerCreateCall.data.isSystemGenerated).toBe(true);
      expect(customerCreateCall.data.offlineId).toBeDefined();
      expect(isValidUUIDv4(customerCreateCall.data.offlineId!)).toBe(true);

      expect(mockPrisma.tenant.update).toHaveBeenCalledWith({
        where: { id: "tenant-123" },
        data: { systemCustomerId: "customer-sys-1" },
      });
    });
  });

  describe("2. Forced-Crash & Rollback Error Handling", () => {
    it("handles database transaction failure and returns 500 without corrupting state", async () => {
      mockPrisma.tenant.findUnique.mockResolvedValueOnce(null);
      mockPrisma.user.findUnique.mockResolvedValueOnce(null);

      mockPrisma.tenant.create.mockResolvedValueOnce({ id: "tenant-123" });
      mockPrisma.user.create.mockRejectedValueOnce(new Error("DB_CRASH_STEP_2"));

      const req = new Request("http://localhost/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tenantName: "شركة الانهيار",
          tenantSlug: "crash-test",
          adminName: "مدير الاختبار",
          adminEmail: "admin@crash.com",
          password: "password123",
        }),
      });

      const response = await registerHandler(req);
      const json = await response.json();

      expect(response.status).toBe(500);
      expect(json.error).toBe("SERVER_ERROR");

      // NOTE: this only proves the route returns a clean 500 — it does NOT
      // prove "no orphaned state" against a real database, since
      // `$transaction` is mocked here as a plain callback invocation with no
      // real rollback semantics. The actual atomicity guarantee is only
      // provable against a live Postgres instance — see T7's "Onboarding
      // Atomicity Test" (forced-crash test against the real /register flow).
      // Do not treat this unit test as satisfying that acceptance criterion.
    });

    it("handles Prisma P2002 duplicate constraint collision gracefully", async () => {
      mockPrisma.tenant.findUnique.mockResolvedValueOnce(null);
      mockPrisma.user.findUnique.mockResolvedValueOnce(null);

      const p2002Error = new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "6.0.0",
        meta: { target: ["slug"] },
      });
      mockPrisma.$transaction.mockRejectedValueOnce(p2002Error);

      const req = new Request("http://localhost/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tenantName: "شركة مكررة",
          tenantSlug: "duplicate-slug",
          adminName: "مدير",
          adminEmail: "admin@duplicate.com",
          password: "password123",
        }),
      });

      const response = await registerHandler(req);
      const json = await response.json();

      expect(response.status).toBe(409);
      expect(json.error).toBe("DUPLICATE");
    });
  });

  describe("3. Validation & Reserved Slugs Protection", () => {
    it("rejects reserved slugs with 400 validation error", async () => {
      const reserved = ["login", "register", "admin", "api", "dashboard", "pos", "store", "www", "app"];

      for (const slug of reserved) {
        const req = new Request("http://localhost/api/auth/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            tenantName: "متجر محجوز",
            tenantSlug: slug,
            adminName: "مدير",
            adminEmail: "admin@reserved.com",
            password: "password123",
          }),
        });

        const response = await registerHandler(req);
        const json = await response.json();

        expect(response.status).toBe(400);
        expect(json.error).toBe("VALIDATION_ERROR");
      }
    });

    it("rejects already-taken email with 400 EMAIL_TAKEN", async () => {
      mockPrisma.tenant.findUnique.mockResolvedValueOnce(null);
      mockPrisma.user.findUnique.mockResolvedValueOnce({ id: "existing-user-id" });

      const req = new Request("http://localhost/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tenantName: "متجر جديد",
          tenantSlug: "brand-new-store",
          adminName: "مدير",
          adminEmail: "already-taken@domain.com",
          password: "password123",
        }),
      });

      const response = await registerHandler(req);
      const json = await response.json();

      expect(response.status).toBe(400);
      expect(json.error).toBe("EMAIL_TAKEN");
    });
  });

  describe("4. NextAuth JWT & Session Mapping (Role, tenantId, isPlatformAdmin)", () => {
    it("applies role, tenantId, and isPlatformAdmin from JWT token to session object", () => {
      const token: JWT = {
        id: "user_sam_101",
        role: "ADMIN",
        tenantId: "tenant_999",
        tenantSlug: "al-baraka",
        tenantName: "شركة البركة",
        isPlatformAdmin: false,
        subscriptionStatus: "PENDING",
        dailyExchangeRate: null,
      };

      const emptySession: Session = {
        user: {
          id: "",
          email: "admin@al-baraka.com",
          role: "CASHIER",
          tenantId: "",
          tenantSlug: "",
          tenantName: "",
          isPlatformAdmin: false,
          subscriptionStatus: "EXPIRED",
          dailyExchangeRate: null,
        },
        expires: new Date(Date.now() + 3600 * 1000).toISOString(),
      };

      const session = applySessionFromToken(emptySession, token);

      expect(session.user.id).toBe("user_sam_101");
      expect(session.user.role).toBe("ADMIN");
      expect(session.user.tenantId).toBe("tenant_999");
      expect(session.user.tenantSlug).toBe("al-baraka");
      expect(session.user.tenantName).toBe("شركة البركة");
      expect(session.user.isPlatformAdmin).toBe(false);
      expect(session.user.subscriptionStatus).toBe("PENDING");
    });

    it("defaults fail-closed when token properties are missing or corrupted", () => {
      const emptyToken: JWT = {};
      const emptySession: Session = {
        user: {
          id: "",
          email: "test@domain.com",
          role: "CASHIER",
          tenantId: "",
          tenantSlug: "",
          tenantName: "",
          isPlatformAdmin: false,
          subscriptionStatus: "EXPIRED",
          dailyExchangeRate: null,
        },
        expires: new Date().toISOString(),
      };

      const session = applySessionFromToken(emptySession, emptyToken);

      expect(session.user.role).toBe("CASHIER");
      expect(session.user.isPlatformAdmin).toBe(false);
      expect(session.user.subscriptionStatus).toBe("EXPIRED");
    });
  });

  describe("5. Authoritative Fresh Lookups (getFreshTenantStatus & getFreshExchangeRate)", () => {
    it("retrieves fresh subscriptionStatus directly from database", async () => {
      mockPrisma.tenant.findUnique.mockResolvedValueOnce({
        subscriptionStatus: "ACTIVE",
      });

      const status = await getFreshTenantStatus("tenant-abc");
      expect(status).toBe("ACTIVE");
      expect(mockPrisma.tenant.findUnique).toHaveBeenCalledWith({
        where: { id: "tenant-abc" },
        select: { subscriptionStatus: true },
      });
    });

    it("retrieves fresh dailyExchangeRate directly from DB as a Decimal-serialized string", async () => {
      mockPrisma.tenant.findUnique.mockResolvedValueOnce({
        dailyExchangeRate: { toString: () => "15300.5000" },
      });

      const rate = await getFreshExchangeRate("tenant-abc");
      expect(rate).toBe("15300.5000");
      expect(typeof rate).toBe("string");
      expect(mockPrisma.tenant.findUnique).toHaveBeenCalledWith({
        where: { id: "tenant-abc" },
        select: { dailyExchangeRate: true },
      });
    });

    it("returns null when tenant or dailyExchangeRate is not set in DB", async () => {
      mockPrisma.tenant.findUnique.mockResolvedValueOnce({
        dailyExchangeRate: null,
      });

      const rate = await getFreshExchangeRate("tenant-xyz");
      expect(rate).toBeNull();
    });
  });

  describe("6. authorize() — Credentials Provider Login Flow", () => {
    beforeEach(async () => {
      // Force module re-evaluation so NextAuth(...)/Credentials(...) run
      // again with fresh captured configs under this describe block's mocks.
      vi.resetModules();
      await import("@/auth");
    });

    it("returns null immediately when email or password is missing", async () => {
      const result = await capturedProviderConfig.authorize({ email: "", password: "" }, new Request("http://localhost"));
      expect(result).toBeNull();
    });

    it("throws RateLimitedError with code 'RateLimited' when the login rate limit is exceeded", async () => {
      rateLimitMock.mockResolvedValueOnce({ success: false });

      await expect(
        capturedProviderConfig.authorize(
          { email: "admin@alfajr.com", password: "whatever" },
          new Request("http://localhost", { headers: { "x-forwarded-for": "1.2.3.4" } })
        )
      ).rejects.toMatchObject({ code: "RateLimited" });
    });

    it("compares against DUMMY_PASSWORD_HASH (timing-attack mitigation) and returns null when the user does not exist", async () => {
      mockPrisma.user.findUnique.mockResolvedValueOnce(null);
      const bcryptCompare = vi.mocked(bcrypt.compare);
      bcryptCompare.mockResolvedValueOnce(false as never);

      const result = await capturedProviderConfig.authorize(
        { email: "ghost@nowhere.com", password: "anything" },
        new Request("http://localhost")
      );

      expect(result).toBeNull();
      // The whole point of the fix: a nonexistent user still pays bcrypt's
      // cost, compared against the fixed dummy hash — never skipped.
      expect(bcryptCompare).toHaveBeenCalledWith("anything", expect.stringContaining("$2a$10$"));
    });

    it("compares against DUMMY_PASSWORD_HASH and returns null when the user is inactive (isActive: false)", async () => {
      mockPrisma.user.findUnique.mockResolvedValueOnce({
        id: "user-1",
        passwordHash: "real-hash",
        isActive: false,
        tenant: { slug: "al-fajr", name: "الفجر", dailyExchangeRate: null, subscriptionStatus: "ACTIVE" },
      });
      const bcryptCompare = vi.mocked(bcrypt.compare);
      bcryptCompare.mockResolvedValueOnce(false as never);

      const result = await capturedProviderConfig.authorize(
        { email: "inactive@alfajr.com", password: "anything" },
        new Request("http://localhost")
      );

      expect(result).toBeNull();
      expect(bcryptCompare).toHaveBeenCalled();
    });

    it("returns null on a wrong password for an existing, active user", async () => {
      mockPrisma.user.findUnique.mockResolvedValueOnce({
        id: "user-1",
        passwordHash: "real-hash",
        isActive: true,
        tenant: { slug: "al-fajr", name: "الفجر", dailyExchangeRate: null, subscriptionStatus: "ACTIVE" },
      });
      const bcryptCompare = vi.mocked(bcrypt.compare);
      bcryptCompare.mockResolvedValueOnce(false as never);

      const result = await capturedProviderConfig.authorize(
        { email: "admin@alfajr.com", password: "wrong-password" },
        new Request("http://localhost")
      );

      expect(result).toBeNull();
    });

    it("returns the full user/tenant shape on a correct password for an active user", async () => {
      mockPrisma.user.findUnique.mockResolvedValueOnce({
        id: "user-1",
        name: "سامر",
        email: "admin@alfajr.com",
        passwordHash: "real-hash",
        role: "ADMIN",
        tenantId: "tenant-123",
        isActive: true,
        isPlatformAdmin: false,
        tenant: {
          slug: "al-fajr",
          name: "شركة الفجر",
          dailyExchangeRate: { toString: () => "15000" }, // simulate Prisma.Decimal
          subscriptionStatus: "ACTIVE",
        },
      });
      const bcryptCompare = vi.mocked(bcrypt.compare);
      bcryptCompare.mockResolvedValueOnce(true as never);

      const result = await capturedProviderConfig.authorize(
        { email: "admin@alfajr.com", password: "correct-password" },
        new Request("http://localhost")
      );

      expect(result).toMatchObject({
        id: "user-1",
        role: "ADMIN",
        tenantId: "tenant-123",
        tenantSlug: "al-fajr",
        tenantName: "شركة الفجر",
        subscriptionStatus: "ACTIVE",
        isPlatformAdmin: false,
      });
    });
  });

  describe("7. jwt() Callback — Sign-in Population & Anti-Tampering on update()", () => {
    beforeEach(async () => {
      vi.resetModules();
      await import("@/auth");
    });

    it("populates the token from the `user` object on first sign-in", async () => {
      const token: Partial<JWT> = {};
      const user = {
        id: "user-1",
        role: "ADMIN" as const,
        tenantId: "tenant-123",
        tenantSlug: "al-fajr",
        tenantName: "شركة الفجر",
        dailyExchangeRate: 15000,
        subscriptionStatus: "PENDING" as const,
        isPlatformAdmin: false,
      };

      const result = await capturedAuthConfig.callbacks.jwt({ token, user, trigger: "signIn" });

      expect(result.tenantId).toBe("tenant-123");
      expect(result.role).toBe("ADMIN");
      expect(result.subscriptionStatus).toBe("PENDING");
    });

    // [CRITICAL] This is the test for the exact vulnerability the code
    // comment calls out: a client calling update({ subscriptionStatus:
    // "ACTIVE" }) must NEVER be able to write that value into its own
    // token. The re-read must come from `prisma.tenant.findUnique`, keyed
    // only off the token's own tenantId — never off anything the client
    // supplied on the update() call.
    it("on trigger='update', ignores client-supplied session values and re-reads subscriptionStatus/dailyExchangeRate from the database", async () => {
      mockPrisma.tenant.findUnique.mockResolvedValueOnce({
        subscriptionStatus: "ACTIVE",
        dailyExchangeRate: { toString: () => "16000" },
      });

      const token: JWT = {
        id: "user-1",
        tenantId: "tenant-123",
        subscriptionStatus: "PENDING", // stale value already on the token
        dailyExchangeRate: 15000,
      };

      // Simulates a malicious/buggy client calling
      // update({ subscriptionStatus: "ACTIVE" }) directly — this payload
      // must be completely ignored for these two fields.
      const tamperedClientSession = { subscriptionStatus: "ACTIVE", dailyExchangeRate: 999999 };

      const result = await capturedAuthConfig.callbacks.jwt({
        token,
        trigger: "update",
        session: tamperedClientSession,
      });

      expect(mockPrisma.tenant.findUnique).toHaveBeenCalledWith({
        where: { id: "tenant-123" },
        select: { subscriptionStatus: true, dailyExchangeRate: true },
      });
      // The DB says ACTIVE here too, so this alone wouldn't distinguish
      // "read from DB" from "trusted the client" — the real assertion is
      // the call above (proves the DB was consulted using token.tenantId,
      // never the client payload) plus the case below (DB disagrees with
      // the client, and the DB must win).
      expect(result.subscriptionStatus).toBe("ACTIVE");
      expect(result.dailyExchangeRate).toBe(16000);
    });

    it("on trigger='update', the database value wins even when it CONTRADICTS the client-supplied session payload", async () => {
      // DB says the tenant is still PENDING — e.g. a client tries to
      // self-approve before any Super-Admin action has actually happened.
      mockPrisma.tenant.findUnique.mockResolvedValueOnce({
        subscriptionStatus: "PENDING",
        dailyExchangeRate: null,
      });

      const token: JWT = { id: "user-1", tenantId: "tenant-123", subscriptionStatus: "PENDING" };
      const tamperedClientSession = { subscriptionStatus: "ACTIVE" };

      const result = await capturedAuthConfig.callbacks.jwt({
        token,
        trigger: "update",
        session: tamperedClientSession,
      });

      // Must NOT be "ACTIVE" — that would mean the client payload won.
      expect(result.subscriptionStatus).toBe("PENDING");
    });

    it("does not touch the database when trigger is not 'update' and no `user` is present (plain token refresh)", async () => {
      const token: JWT = { id: "user-1", tenantId: "tenant-123", subscriptionStatus: "ACTIVE" };

      const result = await capturedAuthConfig.callbacks.jwt({ token });

      expect(mockPrisma.tenant.findUnique).not.toHaveBeenCalled();
      expect(result.subscriptionStatus).toBe("ACTIVE");
    });
  });
});