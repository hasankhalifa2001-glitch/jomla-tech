/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";

const { getHandler, setHandler } = vi.hoisted(() => {
  let handler: any = null;
  return {
    getHandler: () => handler,
    setHandler: (h: any) => {
      handler = h;
    },
  };
});

vi.mock("next-auth", () => ({
  default: vi.fn(() => ({
    auth: vi.fn((handler: any) => {
      setHandler(handler);
      return handler;
    }),
  })),
}));

import middleware from "@/middleware";

function createMockRequest(
  url: string,
  options?: {
    session?: any;
    headers?: Record<string, string>;
  }
): any {
  const req = new NextRequest(url, {
    headers: options?.headers,
  });
  (req as any).auth = options?.session ?? null;
  return req;
}

describe("T2b — Middleware Redirects, Sub-Link Protection & RBAC Matrix", () => {
  const handler = (req: any) => {
    const fn = getHandler() || (middleware as any);
    return fn(req);
  };

  describe("1. Unauthenticated Route Protection", () => {
    it("redirects unauthenticated user accessing /dashboard to /login with callbackUrl", async () => {
      const req = createMockRequest("http://localhost:3000/dashboard");
      const res = await handler(req);

      expect(res.status).toBe(307);
      const location = res.headers.get("location");
      expect(location).toContain("/login");
      expect(location).toContain("callbackUrl=%2Fdashboard");
    });

    it("redirects unauthenticated user accessing /inventory to /login with callbackUrl", async () => {
      const req = createMockRequest("http://localhost:3000/inventory");
      const res = await handler(req);

      expect(res.status).toBe(307);
      const location = res.headers.get("location");
      expect(location).toContain("/login");
      expect(location).toContain("callbackUrl=%2Finventory");
    });

    it("redirects unauthenticated user accessing /admin to /login with callbackUrl", async () => {
      const req = createMockRequest("http://localhost:3000/admin");
      const res = await handler(req);

      expect(res.status).toBe(307);
      const location = res.headers.get("location");
      expect(location).toContain("/login");
      expect(location).toContain("callbackUrl=%2Fadmin");
    });
  });

  describe("2. Cashier Role Restrictions & Landing Page", () => {
    const activeCashier = {
      user: {
        id: "cashier-1",
        role: "CASHIER",
        tenantId: "tenant-1",
        subscriptionStatus: "ACTIVE",
        isPlatformAdmin: false,
      },
    };

    // NOTE: Actual app routes have no "/dashboard" prefix on these screens —
    // app/(dashboard)/... is a Next.js route GROUP (parentheses), which is
    // stripped from the URL. Real paths are /pos, /ledger, /orders,
    // /settings/billing, etc. See middleware.ts header comment for the
    // canonical statement of this decision.
    it("redirects CASHIER from /dashboard (analytics) to /pos", async () => {
      const req = createMockRequest("http://localhost:3000/dashboard", { session: activeCashier });
      const res = await handler(req);

      expect(res.status).toBe(307);
      expect(res.headers.get("location")).toBe("http://localhost:3000/pos");
    });

    it("redirects CASHIER from /settings to /pos with unauthorized error", async () => {
      const req = createMockRequest("http://localhost:3000/settings", { session: activeCashier });
      const res = await handler(req);

      expect(res.status).toBe(307);
      expect(res.headers.get("location")).toBe("http://localhost:3000/pos?error=unauthorized");
    });

    it("allows active CASHIER to access /pos without redirect", async () => {
      const req = createMockRequest("http://localhost:3000/pos", { session: activeCashier });
      const res = await handler(req);

      expect(res.status).toBe(200);
      expect(res.headers.get("location")).toBeNull();
    });

    it("allows active CASHIER to access /inventory without redirect", async () => {
      const req = createMockRequest("http://localhost:3000/inventory", { session: activeCashier });
      const res = await handler(req);

      expect(res.status).toBe(200);
      expect(res.headers.get("location")).toBeNull();
    });
  });

  describe("3. Subscription Lockout at Page-Navigation Layer (PENDING & EXPIRED)", () => {
    it("redirects ADMIN with PENDING subscription to /settings/billing?reason=pending", async () => {
      const req = createMockRequest("http://localhost:3000/dashboard", {
        session: {
          user: {
            id: "admin-1",
            role: "ADMIN",
            tenantId: "tenant-1",
            subscriptionStatus: "PENDING",
            isPlatformAdmin: false,
          },
        },
      });
      const res = await handler(req);

      expect(res.status).toBe(307);
      expect(res.headers.get("location")).toBe("http://localhost:3000/settings/billing?reason=pending");
    });

    it("redirects ADMIN with EXPIRED subscription to /settings/billing?reason=expired", async () => {
      const req = createMockRequest("http://localhost:3000/inventory", {
        session: {
          user: {
            id: "admin-1",
            role: "ADMIN",
            tenantId: "tenant-1",
            subscriptionStatus: "EXPIRED",
            isPlatformAdmin: false,
          },
        },
      });
      const res = await handler(req);

      expect(res.status).toBe(307);
      expect(res.headers.get("location")).toBe("http://localhost:3000/settings/billing?reason=expired");
    });

    it("redirects CASHIER with PENDING subscription to /account-locked", async () => {
      const req = createMockRequest("http://localhost:3000/pos", {
        session: {
          user: {
            id: "cashier-1",
            role: "CASHIER",
            tenantId: "tenant-1",
            subscriptionStatus: "PENDING",
            isPlatformAdmin: false,
          },
        },
      });
      const res = await handler(req);

      expect(res.status).toBe(307);
      expect(res.headers.get("location")).toBe("http://localhost:3000/account-locked");
    });

    it("redirects CASHIER with EXPIRED subscription to /account-locked", async () => {
      const req = createMockRequest("http://localhost:3000/inventory", {
        session: {
          user: {
            id: "cashier-1",
            role: "CASHIER",
            tenantId: "tenant-1",
            subscriptionStatus: "EXPIRED",
            isPlatformAdmin: false,
          },
        },
      });
      const res = await handler(req);

      expect(res.status).toBe(307);
      expect(res.headers.get("location")).toBe("http://localhost:3000/account-locked");
    });
  });

  describe("4. Cross-Bounce Safeguards", () => {
    it("bounces locked ADMIN accessing /account-locked to /settings/billing", async () => {
      const req = createMockRequest("http://localhost:3000/account-locked", {
        session: {
          user: {
            id: "admin-1",
            role: "ADMIN",
            tenantId: "tenant-1",
            subscriptionStatus: "EXPIRED",
            isPlatformAdmin: false,
          },
        },
      });
      const res = await handler(req);

      expect(res.status).toBe(307);
      expect(res.headers.get("location")).toBe("http://localhost:3000/settings/billing?reason=expired");
    });

    it("bounces locked CASHIER accessing /settings/billing to /account-locked", async () => {
      const req = createMockRequest("http://localhost:3000/settings/billing", {
        session: {
          user: {
            id: "cashier-1",
            role: "CASHIER",
            tenantId: "tenant-1",
            subscriptionStatus: "EXPIRED",
            isPlatformAdmin: false,
          },
        },
      });
      const res = await handler(req);

      expect(res.status).toBe(307);
      expect(res.headers.get("location")).toBe("http://localhost:3000/account-locked");
    });

    it("bounces active CASHIER accessing /settings/billing to /pos with unauthorized error", async () => {
      const req = createMockRequest("http://localhost:3000/settings/billing", {
        session: {
          user: {
            id: "cashier-1",
            role: "CASHIER",
            tenantId: "tenant-1",
            subscriptionStatus: "ACTIVE",
            isPlatformAdmin: false,
          },
        },
      });
      const res = await handler(req);

      expect(res.status).toBe(307);
      expect(res.headers.get("location")).toBe("http://localhost:3000/pos?error=unauthorized");
    });
  });

  describe("5. Platform Super-Admin Route Protection (/admin)", () => {
    it("redirects non-platform-admin authenticated user accessing /admin to /dashboard", async () => {
      const req = createMockRequest("http://localhost:3000/admin", {
        session: {
          user: {
            id: "admin-1",
            role: "ADMIN",
            tenantId: "tenant-1",
            subscriptionStatus: "ACTIVE",
            isPlatformAdmin: false,
          },
        },
      });
      const res = await handler(req);

      expect(res.status).toBe(307);
      expect(res.headers.get("location")).toBe("http://localhost:3000/dashboard");
    });

    it("allows isPlatformAdmin user accessing /admin through", async () => {
      const req = createMockRequest("http://localhost:3000/admin", {
        session: {
          user: {
            id: "superadmin-1",
            role: "ADMIN",
            tenantId: "tenant-1",
            subscriptionStatus: "ACTIVE",
            isPlatformAdmin: true,
          },
        },
      });
      const res = await handler(req);

      expect(res.status).toBe(200);
      expect(res.headers.get("location")).toBeNull();
    });
  });

  describe("6. Storefront Sub-Link & Subdomain Rewrites", () => {
    it("rewrites /store/:tenantSlug to /:tenantSlug with x-tenant-slug header", async () => {
      const req = createMockRequest("http://localhost:3000/store/al-baraka");
      const res = await handler(req);

      expect(res.headers.get("x-tenant-slug")).toBe("al-baraka");
      expect(res.headers.get("x-middleware-rewrite")).toContain("/al-baraka");
    });

    it("rewrites /store/:tenantSlug/cart to /:tenantSlug/cart with x-tenant-slug header", async () => {
      const req = createMockRequest("http://localhost:3000/store/al-baraka/cart");
      const res = await handler(req);

      expect(res.headers.get("x-tenant-slug")).toBe("al-baraka");
      expect(res.headers.get("x-middleware-rewrite")).toContain("/al-baraka/cart");
    });

    it("rewrites subdomain request tenant.localhost to /:tenantSlug with x-tenant-slug header", async () => {
      const req = createMockRequest("http://al-baraka.localhost:3000/cart", {
        headers: { host: "al-baraka.localhost:3000" },
      });
      const res = await handler(req);

      expect(res.headers.get("x-tenant-slug")).toBe("al-baraka");
      expect(res.headers.get("x-middleware-rewrite")).toContain("/al-baraka/cart");
    });

    it("does not rewrite reserved path on subdomain to storefront", async () => {
      const req = createMockRequest("http://al-baraka.localhost:3000/login", {
        headers: { host: "al-baraka.localhost:3000" },
      });
      const res = await handler(req);

      expect(res.headers.get("x-middleware-rewrite")).toBeNull();
    });
  });
});