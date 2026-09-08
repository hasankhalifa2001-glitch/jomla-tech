/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";

// [FIX] vi.mock(...) calls below are hoisted to the top of the file by
// Vitest — ABOVE any regular `const` declaration, regardless of where
// they're written in source order. Declaring mockTenant/mockRawPrisma as
// plain `const` and referencing them inside vi.mock's factory function
// throws "Cannot access before initialization", because by the time the
// factory actually runs (hoisted position), the plain consts haven't been
// initialized yet. vi.hoisted() explicitly hoists THIS initialization to
// the same top-of-file position Vitest already hoists vi.mock to, so the
// mocks exist by the time the factories run.
const { mockTenant, mockRawPrisma } = vi.hoisted(() => {
  const mockTenant = {
    findUnique: vi.fn(),
    update: vi.fn(),
  };
  const mockRawPrisma: any = {
    tenant: mockTenant,
  };
  mockRawPrisma.$transaction = vi.fn(async (cb: (tx: any) => Promise<any>) => cb(mockRawPrisma));
  return { mockTenant, mockRawPrisma };
});

vi.mock("@/lib/db", () => ({
  prisma: mockRawPrisma,
  getTenantDb: vi.fn(() => mockRawPrisma),
}));

vi.mock("@/lib/db/tenant-scope", () => ({
  getTenantDb: vi.fn(() => mockRawPrisma),
  tenantScopedRawQuery: vi.fn(async () => []),
}));

import {
  ROLE_CAPABILITY_MATRIX,
  canRolePerform,
  assertRolePermission,
  assertAdmin,
  ForbiddenRoleError,
} from "@/lib/auth/role-matrix";
import {
  assertTenantWritable,
  getFreshTenantStatus,
  SubscriptionLockedError,
} from "@/lib/auth/tenant";

describe("T2b — Role Capability Matrix & Tenant Assertions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("1. Role Capability Matrix Authoritative Compliance", () => {
    it("enforces correct ADMIN vs CASHIER access across all matrix capabilities", () => {
      expect(ROLE_CAPABILITY_MATRIX["dashboard:analytics"].ADMIN).toBe(true);
      expect(ROLE_CAPABILITY_MATRIX["dashboard:analytics"].CASHIER).toBe(false);

      expect(ROLE_CAPABILITY_MATRIX["pos:create_sale"].ADMIN).toBe(true);
      expect(ROLE_CAPABILITY_MATRIX["pos:create_sale"].CASHIER).toBe(true);
      expect(ROLE_CAPABILITY_MATRIX["pos:walkin_customer"].ADMIN).toBe(true);
      expect(ROLE_CAPABILITY_MATRIX["pos:walkin_customer"].CASHIER).toBe(true);

      expect(ROLE_CAPABILITY_MATRIX["inventory:view"].ADMIN).toBe(true);
      expect(ROLE_CAPABILITY_MATRIX["inventory:view"].CASHIER).toBe(true);
      expect(ROLE_CAPABILITY_MATRIX["inventory:mutate"].ADMIN).toBe(true);
      expect(ROLE_CAPABILITY_MATRIX["inventory:mutate"].CASHIER).toBe(false);

      expect(ROLE_CAPABILITY_MATRIX["ledger:view_balances"].ADMIN).toBe(true);
      expect(ROLE_CAPABILITY_MATRIX["ledger:view_balances"].CASHIER).toBe(true);
      expect(ROLE_CAPABILITY_MATRIX["ledger:log_repayment"].ADMIN).toBe(true);
      expect(ROLE_CAPABILITY_MATRIX["ledger:log_repayment"].CASHIER).toBe(false);
      expect(ROLE_CAPABILITY_MATRIX["ledger:void_invoice"].ADMIN).toBe(true);
      expect(ROLE_CAPABILITY_MATRIX["ledger:void_invoice"].CASHIER).toBe(false);
      expect(ROLE_CAPABILITY_MATRIX["ledger:merge_customers"].ADMIN).toBe(true);
      expect(ROLE_CAPABILITY_MATRIX["ledger:merge_customers"].CASHIER).toBe(false);
      expect(ROLE_CAPABILITY_MATRIX["ledger:view_failed_sync"].ADMIN).toBe(true);
      expect(ROLE_CAPABILITY_MATRIX["ledger:view_failed_sync"].CASHIER).toBe(false);

      expect(ROLE_CAPABILITY_MATRIX["orders:view"].ADMIN).toBe(true);
      expect(ROLE_CAPABILITY_MATRIX["orders:view"].CASHIER).toBe(true);
      expect(ROLE_CAPABILITY_MATRIX["orders:manage"].ADMIN).toBe(true);
      expect(ROLE_CAPABILITY_MATRIX["orders:manage"].CASHIER).toBe(false);

      expect(ROLE_CAPABILITY_MATRIX["settings:manage"].ADMIN).toBe(true);
      expect(ROLE_CAPABILITY_MATRIX["settings:manage"].CASHIER).toBe(false);
    });

    it("canRolePerform helper evaluates roles accurately", () => {
      expect(canRolePerform("ADMIN", "dashboard:analytics")).toBe(true);
      expect(canRolePerform("CASHIER", "dashboard:analytics")).toBe(false);
      expect(canRolePerform(undefined, "pos:create_sale")).toBe(false);
      expect(canRolePerform(null, "pos:create_sale")).toBe(false);
      expect(canRolePerform("CASHIER", "pos:create_sale")).toBe(true);
    });

    it("assertRolePermission throws ForbiddenRoleError for unauthorized cashier actions", () => {
      expect(() => assertRolePermission("ADMIN", "inventory:mutate")).not.toThrow();
      expect(() => assertRolePermission("CASHIER", "inventory:mutate")).toThrow(
        ForbiddenRoleError
      );
      expect(() => assertAdmin("CASHIER")).toThrow(ForbiddenRoleError);
    });

    it("assertAdmin does not throw for an ADMIN role", () => {
      expect(() => assertAdmin("ADMIN")).not.toThrow();
    });

    describe("assertAdmin's action parameter (post-fix)", () => {
      it("attaches the caller-supplied action to the thrown error, not the default", () => {
        try {
          assertAdmin("CASHIER", "ledger:void_invoice");
          throw new Error("assertAdmin should have thrown");
        } catch (err) {
          expect(err).toBeInstanceOf(ForbiddenRoleError);
          expect((err as ForbiddenRoleError).action).toBe("ledger:void_invoice");
          expect((err as ForbiddenRoleError).role).toBe("CASHIER");
        }
      });

      it("falls back to the 'settings:manage' default action when none is passed", () => {
        try {
          assertAdmin("CASHIER");
          throw new Error("assertAdmin should have thrown");
        } catch (err) {
          expect(err).toBeInstanceOf(ForbiddenRoleError);
          expect((err as ForbiddenRoleError).action).toBe("settings:manage");
        }
      });

      it("defaults the role on the thrown error to 'CASHIER' when role is null/undefined", () => {
        try {
          assertAdmin(null, "orders:manage");
          throw new Error("assertAdmin should have thrown");
        } catch (err) {
          expect(err).toBeInstanceOf(ForbiddenRoleError);
          expect((err as ForbiddenRoleError).role).toBe("CASHIER");
          expect((err as ForbiddenRoleError).action).toBe("orders:manage");
        }
      });
    });
  });

  describe("2. Tenant Subscription Assertions (assertTenantWritable / getFreshTenantStatus)", () => {
    it("getFreshTenantStatus reads directly from the database, keyed by tenantId", async () => {
      mockTenant.findUnique.mockResolvedValueOnce({ subscriptionStatus: "ACTIVE" });

      const status = await getFreshTenantStatus("tenant-abc");

      expect(status).toBe("ACTIVE");
      expect(mockTenant.findUnique).toHaveBeenCalledWith({
        where: { id: "tenant-abc" },
        select: { subscriptionStatus: true },
      });
    });

    it("getFreshTenantStatus returns null when the tenant row is not found", async () => {
      mockTenant.findUnique.mockResolvedValueOnce(null);

      const status = await getFreshTenantStatus("tenant-missing");

      expect(status).toBeNull();
    });

    it("assertTenantWritable resolves and returns the status when the tenant is ACTIVE", async () => {
      mockTenant.findUnique.mockResolvedValueOnce({ subscriptionStatus: "ACTIVE" });

      await expect(assertTenantWritable("tenant-abc")).resolves.toBe("ACTIVE");
    });

    it("assertTenantWritable throws SubscriptionLockedError when the tenant is PENDING", async () => {
      mockTenant.findUnique.mockResolvedValueOnce({ subscriptionStatus: "PENDING" });

      await expect(assertTenantWritable("tenant-abc")).rejects.toBeInstanceOf(
        SubscriptionLockedError
      );
    });

    it("assertTenantWritable throws SubscriptionLockedError when the tenant is EXPIRED", async () => {
      mockTenant.findUnique.mockResolvedValueOnce({ subscriptionStatus: "EXPIRED" });

      await expect(assertTenantWritable("tenant-abc")).rejects.toBeInstanceOf(
        SubscriptionLockedError
      );
    });

    it("assertTenantWritable throws SubscriptionLockedError when the tenant is not found (null status)", async () => {
      mockTenant.findUnique.mockResolvedValueOnce(null);

      await expect(assertTenantWritable("tenant-missing")).rejects.toBeInstanceOf(
        SubscriptionLockedError
      );
    });

    it("performs a fresh DB read on every call — no caching across calls for the same tenantId", async () => {
      mockTenant.findUnique.mockResolvedValueOnce({ subscriptionStatus: "PENDING" });
      await expect(assertTenantWritable("tenant-xyz")).rejects.toBeInstanceOf(
        SubscriptionLockedError
      );

      // Simulates a Super-Admin approving the subscription between the two
      // calls (T6) — the tenant is now ACTIVE in the database.
      mockTenant.findUnique.mockResolvedValueOnce({ subscriptionStatus: "ACTIVE" });
      await expect(assertTenantWritable("tenant-xyz")).resolves.toBe("ACTIVE");

      expect(mockTenant.findUnique).toHaveBeenCalledTimes(2);
    });

    it("SubscriptionLockedError carries a distinct message for PENDING vs EXPIRED", () => {
      const pendingError = new SubscriptionLockedError("PENDING");
      const expiredError = new SubscriptionLockedError("EXPIRED");

      expect(pendingError.message).not.toBe(expiredError.message);
      expect(pendingError.status).toBe("PENDING");
      expect(expiredError.status).toBe("EXPIRED");
      expect(pendingError.name).toBe("SubscriptionLockedError");
    });

    it("SubscriptionLockedError with a null status still produces the EXPIRED-style message", () => {
      const nullStatusError = new SubscriptionLockedError(null);

      expect(nullStatusError.status).toBeNull();
      expect(nullStatusError.message).toContain("غير مفعّل");
    });
  });
});