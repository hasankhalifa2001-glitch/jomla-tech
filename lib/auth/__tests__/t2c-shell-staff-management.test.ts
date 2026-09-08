/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import bcrypt from "bcryptjs";

const { mockTenant, mockUser, mockRawPrisma, mockSessionState } = vi.hoisted(() => {
  const mockTenant = {
    findUnique: vi.fn(),
    update: vi.fn(),
  };
  const mockUser = {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    count: vi.fn(),
  };
  const mockRawPrisma: any = {
    tenant: mockTenant,
    user: mockUser,
  };
  mockRawPrisma.$transaction = vi.fn(async (cb: (tx: any) => Promise<any>) => cb(mockRawPrisma));

  const mockSessionState = {
    session: {
      user: {
        id: "admin-1",
        email: "admin@store.com",
        role: "ADMIN",
        tenantId: "tenant-1",
        subscriptionStatus: "ACTIVE",
      },
    } as any,
  };

  return {
    mockTenant,
    mockUser,
    mockRawPrisma,
    mockSessionState,
  };
});

vi.mock("@/lib/db", () => ({
  prisma: mockRawPrisma,
  getTenantDb: vi.fn(() => mockRawPrisma),
}));

vi.mock("@/lib/db/tenant-scope", () => ({
  getTenantDb: vi.fn(() => mockRawPrisma),
  tenantScopedRawQuery: vi.fn(async () => []),
}));

vi.mock("@/auth", () => ({
  auth: vi.fn(async () => mockSessionState.session),
}));

import { GET as getStaffHandler, POST as createStaffHandler } from "@/app/api/staff/route";
import { PATCH as updateStatusHandler } from "@/app/api/staff/[id]/status/route";
import { POST as resetPasswordHandler } from "@/app/api/staff/[id]/reset-password/route";
import { POST as exchangeRateHandler, GET as getExchangeRateHandler } from "@/app/api/tenant/exchange-rate/route";

describe("T2c — Dashboard Shell, Top-Bar Controls & Staff Management", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionState.session = {
      user: {
        id: "admin-1",
        email: "admin@store.com",
        role: "ADMIN",
        tenantId: "tenant-1",
        subscriptionStatus: "ACTIVE",
      },
    };
    mockTenant.findUnique.mockResolvedValue({ subscriptionStatus: "ACTIVE" });
    mockUser.findUnique.mockImplementation(async ({ where }: any) => {
      if (where.id === "admin-1") return { id: "admin-1", role: "ADMIN", isActive: true };
      return null;
    });
  });

  describe("1. Top-Bar Exchange Rate Control & Security", () => {
    it("allows ADMIN to update dailyExchangeRate and persists to tenant", async () => {
      mockTenant.update.mockResolvedValueOnce({
        id: "tenant-1",
        dailyExchangeRate: 15500,
      });

      const req = new Request("http://localhost/api/tenant/exchange-rate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rate: 15500 }),
      });

      const res = await exchangeRateHandler(req);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.dailyExchangeRate).toBe(15500);
      expect(mockTenant.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "tenant-1" },
          data: { dailyExchangeRate: 15500 },
        })
      );
    });

    it("blocks CASHIER session from updating dailyExchangeRate with 403 Forbidden", async () => {
      mockSessionState.session.user.role = "CASHIER";

      const req = new Request("http://localhost/api/tenant/exchange-rate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rate: 16000 }),
      });

      const res = await exchangeRateHandler(req);
      expect(res.status).toBe(403);
      expect(mockTenant.update).not.toHaveBeenCalled();
    });

    it("allows any authenticated user to read dailyExchangeRate via GET", async () => {
      mockTenant.findUnique.mockResolvedValueOnce({ dailyExchangeRate: 15000 });

      const res = await getExchangeRateHandler();
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.dailyExchangeRate).toBe(15000);
    });

    it("rejects non-positive and out-of-range exchange rate values", async () => {
      const invalidRates = [-100, 0, 1_500_000];

      for (const rate of invalidRates) {
        const req = new Request("http://localhost/api/tenant/exchange-rate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rate }),
        });

        const res = await exchangeRateHandler(req);
        expect(res.status).toBe(400);
      }
      expect(mockTenant.update).not.toHaveBeenCalled();
    });
  });

  describe("2. Staff Management (ADMIN-only CRUD & Isolation)", () => {
    it("allows ADMIN to list staff members scoped to tenant", async () => {
      const mockStaffList = [
        { id: "admin-1", name: "المدير", email: "admin@store.com", role: "ADMIN", isActive: true },
        { id: "cashier-1", name: "الكاشير", email: "cashier@store.com", role: "CASHIER", isActive: true },
      ];
      mockUser.findMany.mockResolvedValueOnce(mockStaffList);

      const res = await getStaffHandler();
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.users).toEqual(mockStaffList);
    });

    it("blocks CASHIER session from listing staff with 403 Forbidden", async () => {
      mockSessionState.session.user.role = "CASHIER";

      const res = await getStaffHandler();
      expect(res.status).toBe(403);
      expect(mockUser.findMany).not.toHaveBeenCalled();
    });

    it("allows ADMIN to create a new CASHIER user with hashed password", async () => {
      mockUser.findUnique.mockImplementation(async ({ where }: any) => {
        if (where.id === "admin-1") return { id: "admin-1", role: "ADMIN", isActive: true };
        if (where.email === "samer@store.com") return null;
        return null;
      });

      mockUser.create.mockImplementationOnce(async ({ data }: any) => ({
        id: "new-user-1",
        name: data.name,
        email: data.email,
        role: data.role,
        isActive: data.isActive,
        createdAt: new Date().toISOString(),
      }));

      const req = new Request("http://localhost/api/staff", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "سامر المحمود",
          email: "samer@store.com",
          password: "password123",
          role: "CASHIER",
        }),
      });

      const res = await createStaffHandler(req);
      const data = await res.json();

      expect(res.status).toBe(201);
      expect(data.success).toBe(true);
      expect(data.user.name).toBe("سامر المحمود");
      expect(data.user.role).toBe("CASHIER");

      expect(mockUser.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            email: "samer@store.com",
            role: "CASHIER",
            isActive: true,
            passwordHash: expect.any(String),
          }),
        })
      );
      const createCall = mockUser.create.mock.calls[0][0];
      const isValidHash = await bcrypt.compare("password123", createCall.data.passwordHash);
      expect(isValidHash).toBe(true);
    });

    // [FIX] This test previously built the request and mocked findUnique,
    // but never actually called createStaffHandler and had zero expect()
    // calls — meaning it passed unconditionally regardless of what the
    // endpoint did (even a 500 or a silently-created duplicate user would
    // show green). Added the missing handler call and the assertions the
    // test's own name promises: a 400 EMAIL_EXISTS response, and no
    // user.create call.
    it("rejects creating user with duplicate email", async () => {
      mockUser.findUnique.mockImplementation(async ({ where }: any) => {
        if (where.id === "admin-1") return { id: "admin-1", role: "ADMIN", isActive: true };
        if (where.email === "existing@store.com") return { id: "existing-user" };
        return null;
      });

      const req = new Request("http://localhost/api/staff", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "مكرر",
          email: "existing@store.com",
          password: "password123",
          role: "CASHIER",
        }),
      });

      const res = await createStaffHandler(req);
      const data = await res.json();

      expect(res.status).toBe(400);
      expect(data.error).toBe("EMAIL_EXISTS");
      expect(mockUser.create).not.toHaveBeenCalled();
    });
  });

  // [FIX] Was nested inside describe("2. Staff Management..."), making its
  // "3." numbering misleading (it read as a top-level section but was
  // actually a subsection of #2). Moved to the same nesting level as
  // sections 1 and 2 — no content changed, only where the describe block
  // closes relative to its siblings.
  describe("3. Staff Status Toggle & Invariants", () => {
    it("allows ADMIN to deactivate a cashier account", async () => {
      mockUser.findUnique.mockImplementation(async ({ where }: any) => {
        if (where.id === "admin-1") return { id: "admin-1", role: "ADMIN", isActive: true };
        if (where.id === "cashier-1") return { id: "cashier-1", role: "CASHIER", isActive: true };
        return null;
      });

      mockUser.update.mockResolvedValueOnce({
        id: "cashier-1",
        name: "كاشير 1",
        email: "cashier@store.com",
        role: "CASHIER",
        isActive: false,
      });

      const req = new Request("http://localhost/api/staff/cashier-1/status", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: false }),
      });

      const res = await updateStatusHandler(req, { params: Promise.resolve({ id: "cashier-1" }) });
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.success).toBe(true);
      expect(mockUser.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "cashier-1" },
          data: { isActive: false },
        })
      );
    });

    it("prevents an ADMIN from deactivating their own account", async () => {
      const req = new Request("http://localhost/api/staff/admin-1/status", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: false }),
      });

      const res = await updateStatusHandler(req, { params: Promise.resolve({ id: "admin-1" }) });
      const data = await res.json();

      expect(res.status).toBe(400);
      expect(data.error).toBe("SELF_DEACTIVATION_FORBIDDEN");
      expect(mockUser.update).not.toHaveBeenCalled();
    });

    it("prevents deactivating the last remaining active ADMIN in a tenant", async () => {
      mockUser.findUnique.mockImplementation(async ({ where }: any) => {
        if (where.id === "admin-1") return { id: "admin-1", role: "ADMIN", isActive: true };
        if (where.id === "admin-2") return { id: "admin-2", role: "ADMIN", isActive: true };
        return null;
      });
      mockUser.count.mockResolvedValueOnce(1);

      const req = new Request("http://localhost/api/staff/admin-2/status", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: false }),
      });

      const res = await updateStatusHandler(req, { params: Promise.resolve({ id: "admin-2" }) });
      const data = await res.json();

      expect(res.status).toBe(400);
      expect(data.error).toBe("LAST_ADMIN_DEACTIVATION_FORBIDDEN");
      expect(mockUser.update).not.toHaveBeenCalled();
    });
  });

  describe("4. Password Reset Functionality", () => {
    it("allows ADMIN to reset a staff user's password with a fresh hash", async () => {
      mockUser.findUnique.mockImplementation(async ({ where }: any) => {
        if (where.id === "admin-1") return { id: "admin-1", role: "ADMIN", isActive: true };
        if (where.id === "cashier-1") return { id: "cashier-1", role: "CASHIER", isActive: true };
        return null;
      });

      const req = new Request("http://localhost/api/staff/cashier-1/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: "newSecurePassword456" }),
      });

      const res = await resetPasswordHandler(req, { params: Promise.resolve({ id: "cashier-1" }) });
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.success).toBe(true);
      expect(mockUser.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "cashier-1" },
          data: { passwordHash: expect.any(String) },
        })
      );
      const updateCall = mockUser.update.mock.calls[0][0];
      const isMatch = await bcrypt.compare("newSecurePassword456", updateCall.data.passwordHash);
      expect(isMatch).toBe(true);
    });

    it("blocks CASHIER from triggering password resets", async () => {
      mockSessionState.session.user.role = "CASHIER";

      const req = new Request("http://localhost/api/staff/cashier-1/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: "newPassword123" }),
      });

      const res = await resetPasswordHandler(req, { params: Promise.resolve({ id: "cashier-1" }) });
      expect(res.status).toBe(403);
      expect(mockUser.update).not.toHaveBeenCalled();
    });
  });

  describe("5. Immediate Lockout on Next Request (assertUserActive)", () => {
    it("blocks a deactivated user from executing mutations immediately on their next request", async () => {
      mockUser.findUnique.mockImplementation(async ({ where }: any) => {
        if (where.id === "admin-1") {
          return { id: "admin-1", role: "ADMIN", isActive: false };
        }
        return null;
      });

      const req = new Request("http://localhost/api/tenant/exchange-rate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rate: 16000 }),
      });

      const res = await exchangeRateHandler(req);
      const data = await res.json();

      expect(res.status).toBe(403);
      expect(data.error).toBe("ACCOUNT_DEACTIVATED");
      expect(mockTenant.update).not.toHaveBeenCalled();
    });
  });
});