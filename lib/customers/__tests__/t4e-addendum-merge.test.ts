/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from "fs";
import path from "path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolveActiveCustomerId, MAX_RESOLVE_DEPTH } from "@/lib/customers/resolve-active";

const rootDir = path.resolve(__dirname, "../../../");

const {
  mockSessionState,
  mockGetTenantDb,
  mockAssertTenantWritable,
  mockPrisma,
  fakeCustomer,
  fakeInvoice,
  fakeInvoiceItem,
  fakeProductBatch,
  fakeProductUnit,
  fakeTenant,
  fakeCustomerPayment,
  fakeCustomerMergeLog,
  fakeCustomerMergeLogItem,
  fakeB2BOrderRequest,
  fakeB2BOrderRequestItem,
} = vi.hoisted(() => {
  const fakeCustomer: any = {
    findFirst: vi.fn(),
    update: vi.fn(),
  };

  const fakeInvoice: any = {
    findMany: vi.fn(),
    updateMany: vi.fn(),
    // [T5] the approval path now creates the real Invoice
    create: vi.fn(),
  };

  // [T5] Everything the approval path needs beyond the status flip.
  const fakeInvoiceItem: any = { create: vi.fn() };
  const fakeProductBatch: any = { update: vi.fn() };
  const fakeProductUnit: any = { findUniqueOrThrow: vi.fn() };
  const fakeTenant: any = { findUnique: vi.fn() };
  const fakeB2BOrderRequestItem: any = { findMany: vi.fn() };

  const fakeCustomerPayment: any = {
    findMany: vi.fn(),
    updateMany: vi.fn(),
    // [T5] written only when an approval captures a payment
    create: vi.fn(),
  };

  const fakeCustomerMergeLog: any = {
    findFirst: vi.fn(),
    create: vi.fn(),
  };

  const fakeCustomerMergeLogItem: any = {
    createMany: vi.fn(),
  };

  const fakeB2BOrderRequest: any = {
    findFirst: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  };

  const mockSessionState: { current: any } = {
    current: {
      user: {
        id: "admin-user-1",
        email: "admin@test.com",
        role: "ADMIN",
        tenantId: "tenant-1",
      },
    },
  };

  const txMock: any = {
    customer: fakeCustomer,
    invoice: fakeInvoice,
    invoiceItem: fakeInvoiceItem,
    productBatch: fakeProductBatch,
    productUnit: fakeProductUnit,
    tenant: fakeTenant,
    customerPayment: fakeCustomerPayment,
    customerMergeLog: fakeCustomerMergeLog,
    customerMergeLogItem: fakeCustomerMergeLogItem,
    b2BOrderRequest: fakeB2BOrderRequest,
    b2BOrderRequestItem: fakeB2BOrderRequestItem,
  };

  // [T5] The approval route is a category-5 RAW-client call site — it must call
  // lockBatchesForFifoAllocations(), which is typed to accept exactly
  // Prisma.TransactionClient, so it reaches the store through `prisma` from
  // "@/lib/db" instead of getTenantDb(). Both entry points resolve to this same
  // fake transaction client.
  const mockPrisma = {
    ...txMock,
    $transaction: vi.fn(async (cb: any) => cb(txMock)),
  };

  const mockGetTenantDb = vi.fn(() => ({
    ...txMock,
    $transaction: vi.fn(async (cb: any) => cb(txMock)),
  }));

  const mockAssertTenantWritable = vi.fn().mockResolvedValue(undefined);

  return {
    mockSessionState,
    mockGetTenantDb,
    mockAssertTenantWritable,
    mockPrisma,
    fakeCustomer,
    fakeInvoice,
    fakeInvoiceItem,
    fakeProductBatch,
    fakeProductUnit,
    fakeTenant,
    fakeCustomerPayment,
    fakeCustomerMergeLog,
    fakeCustomerMergeLogItem,
    fakeB2BOrderRequest,
    fakeB2BOrderRequestItem,
  };
});

vi.mock("@/auth", () => ({
  auth: vi.fn(async () => mockSessionState.current),
}));

vi.mock("@/lib/auth/tenant", async () => {
  const actual = await vi.importActual<any>("@/lib/auth/tenant");
  return {
    ...actual,
    assertTenantWritable: mockAssertTenantWritable,
  };
});

vi.mock("@/lib/db/tenant-scope", async () => {
  const actual = await vi.importActual<any>("@/lib/db/tenant-scope");
  return {
    ...actual,
    getTenantDb: mockGetTenantDb,
  };
});

// [T5] The approval route reaches the store through the RAW client (category-5
// call site), so `prisma` must resolve to the same fake transaction client.
vi.mock("@/lib/db", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { ...actual, prisma: mockPrisma };
});

// [T5] Inventory helpers that would otherwise need real ProductBatch rows
// through the fake tx. lib/inventory/units.ts stays REAL.
vi.mock("@/lib/inventory/fifo", () => ({
  commitFifoAllocation: vi.fn(async (_tx: any, args: any) => ({
    allocations: [{ batchId: "batch-1", allocatedQty: args.requestedQty }],
    isSufficient: true,
    remainingQty: "0",
  })),
}));

vi.mock("@/lib/inventory/batch-locking", () => ({
  lockBatchesForFifoAllocations: vi.fn(async () => new Map()),
}));

vi.mock("@/lib/inventory/base-unit", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    requireBaseUnit: vi.fn(async () => ({ id: "unit-base", conversionFactor: "1" })),
  };
});

// Import route handlers
import { POST as mergePost } from "@/app/api/ledger/merge/route";
import { PATCH as orderStatusPatch } from "@/app/api/orders/[id]/status/route";

describe("T4e Addendum (v4.2) — Customer Merge & Auto-Redirect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionState.current = {
      user: {
        id: "admin-user-1",
        email: "admin@test.com",
        role: "ADMIN",
        tenantId: "tenant-1",
      },
    };
  });

  describe("1. Shared Helper: resolveActiveCustomerId", () => {
    it("returns unchanged customerId if no merge log exists", async () => {
      const mockTx = {
        customerMergeLog: {
          findFirst: vi.fn().mockResolvedValue(null),
        },
      } as any;

      const resolved = await resolveActiveCustomerId(mockTx, "tenant-1", "cust-clean");
      expect(resolved).toBe("cust-clean");
      expect(mockTx.customerMergeLog.findFirst).toHaveBeenCalledWith({
        where: { tenantId: "tenant-1", mergedCustomerId: "cust-clean" },
        select: { survivingCustomerId: true },
      });
    });

    it("resolves single merge (B -> A)", async () => {
      const mockTx = {
        customerMergeLog: {
          findFirst: vi.fn().mockImplementation(({ where }: any) => {
            if (where.mergedCustomerId === "cust-b") {
              return Promise.resolve({ survivingCustomerId: "cust-a" });
            }
            return Promise.resolve(null);
          }),
        },
      } as any;

      const resolved = await resolveActiveCustomerId(mockTx, "tenant-1", "cust-b");
      expect(resolved).toBe("cust-a");
    });

    it("chases multi-hop recursive merges (C -> B -> A)", async () => {
      const mockTx = {
        customerMergeLog: {
          findFirst: vi.fn().mockImplementation(({ where }: any) => {
            if (where.mergedCustomerId === "cust-c") {
              return Promise.resolve({ survivingCustomerId: "cust-b" });
            }
            if (where.mergedCustomerId === "cust-b") {
              return Promise.resolve({ survivingCustomerId: "cust-a" });
            }
            return Promise.resolve(null);
          }),
        },
      } as any;

      const resolved = await resolveActiveCustomerId(mockTx, "tenant-1", "cust-c");
      expect(resolved).toBe("cust-a");
      expect(mockTx.customerMergeLog.findFirst).toHaveBeenCalledTimes(3);
    });

    it("gracefully terminates on circular merges at MAX_RESOLVE_DEPTH without looping indefinitely", async () => {
      // Loop: cust-1 -> cust-2 -> cust-1
      const mockTx = {
        customerMergeLog: {
          findFirst: vi.fn().mockImplementation(({ where }: any) => {
            if (where.mergedCustomerId === "cust-1") {
              return Promise.resolve({ survivingCustomerId: "cust-2" });
            }
            if (where.mergedCustomerId === "cust-2") {
              return Promise.resolve({ survivingCustomerId: "cust-1" });
            }
            return Promise.resolve(null);
          }),
        },
      } as any;

      const resolved = await resolveActiveCustomerId(mockTx, "tenant-1", "cust-1");
      // Cycle detection detects cust-1 was already visited and stops safely
      expect(resolved).toBe("cust-2");
      expect(mockTx.customerMergeLog.findFirst).toHaveBeenCalledTimes(2);
    });

    it("strictly isolates merges by tenantId", async () => {
      const mockTx = {
        customerMergeLog: {
          findFirst: vi.fn().mockImplementation(({ where }: any) => {
            if (where.tenantId === "tenant-1") {
              return Promise.resolve(null);
            }
            if (where.tenantId === "tenant-other") {
              return Promise.resolve({ survivingCustomerId: "cust-survivor-other" });
            }
            return Promise.resolve(null);
          }),
        },
      } as any;

      const resolved = await resolveActiveCustomerId(mockTx, "tenant-1", "cust-b");
      expect(resolved).toBe("cust-b");
    });
  });

  describe("2. Customer Merge Route (POST /api/ledger/merge)", () => {
    it("rejects CASHIER with 403 ForbiddenRoleError", async () => {
      mockSessionState.current.user.role = "CASHIER";

      const req = new Request("http://localhost/api/ledger/merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          survivingCustomerId: "cust-a",
          mergedCustomerId: "cust-b",
        }),
      });

      const res = await mergePost(req);
      expect(res.status).toBe(403);
    });

    it("rejects merging customer into themselves", async () => {
      const req = new Request("http://localhost/api/ledger/merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          survivingCustomerId: "cust-same",
          mergedCustomerId: "cust-same",
        }),
      });

      const res = await mergePost(req);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe("SAME_CUSTOMER");
    });

    it("rejects merging system-generated cash customer", async () => {
      fakeCustomer.findFirst.mockImplementation(({ where }: any) => {
        if (where.id === "cust-cash") {
          return Promise.resolve({ id: "cust-cash", isSystemGenerated: true, isActive: true });
        }
        return Promise.resolve({ id: "cust-regular", isSystemGenerated: false, isActive: true });
      });

      const req = new Request("http://localhost/api/ledger/merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          survivingCustomerId: "cust-regular",
          mergedCustomerId: "cust-cash",
        }),
      });

      const res = await mergePost(req);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.message).toContain("النقدي العام");
    });

    it("executes merge transaction with exact ID scoping and CustomerMergeLogItem audit rows", async () => {
      fakeCustomer.findFirst.mockImplementation(({ where }: any) => {
        if (where.id === "cust-survivor") {
          return Promise.resolve({ id: "cust-survivor", isSystemGenerated: false, isActive: true });
        }
        if (where.id === "cust-duplicate") {
          return Promise.resolve({ id: "cust-duplicate", isSystemGenerated: false, isActive: true });
        }
        return Promise.resolve(null);
      });

      const invoiceIds = ["inv-1", "inv-2"];
      const paymentIds = ["pay-1"];

      fakeInvoice.findMany.mockResolvedValueOnce(invoiceIds.map((id) => ({ id })));
      fakeCustomerPayment.findMany.mockResolvedValueOnce(paymentIds.map((id) => ({ id })));
      fakeCustomerMergeLog.create.mockResolvedValueOnce({ id: "merge-log-1" });

      const req = new Request("http://localhost/api/ledger/merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          survivingCustomerId: "cust-survivor",
          mergedCustomerId: "cust-duplicate",
        }),
      });

      const res = await mergePost(req);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.mergeLogId).toBe("merge-log-1");

      // Verify exact ID scoping for updates
      expect(fakeInvoice.updateMany).toHaveBeenCalledWith({
        where: { tenantId: "tenant-1", id: { in: invoiceIds } },
        data: { customerId: "cust-survivor" },
      });

      expect(fakeCustomerPayment.updateMany).toHaveBeenCalledWith({
        where: { tenantId: "tenant-1", id: { in: paymentIds } },
        data: { customerId: "cust-survivor" },
      });

      // Verify duplicate customer deactivated
      expect(fakeCustomer.update).toHaveBeenCalledWith({
        where: { id: "cust-duplicate", tenantId: "tenant-1" },
        data: { isActive: false },
      });

      // Verify summary CustomerMergeLog created
      expect(fakeCustomerMergeLog.create).toHaveBeenCalledWith({
        data: {
          tenantId: "tenant-1",
          survivingCustomerId: "cust-survivor",
          mergedCustomerId: "cust-duplicate",
          performedByUserId: "admin-user-1",
        },
      });

      // Verify 5th write: B2BOrderRequest.matchedCustomerId refreshed for PENDING_REVIEW orders
      expect(fakeB2BOrderRequest.updateMany).toHaveBeenCalledWith({
        where: {
          tenantId: "tenant-1",
          matchedCustomerId: "cust-duplicate",
          status: "PENDING_REVIEW",
        },
        data: {
          matchedCustomerId: "cust-survivor",
        },
      });

      // Verify CustomerMergeLogItem audit rows matching exact IDs
      expect(fakeCustomerMergeLogItem.createMany).toHaveBeenCalledWith({
        data: [
          {
            tenantId: "tenant-1",
            mergeLogId: "merge-log-1",
            recordType: "INVOICE",
            recordId: "inv-1",
          },
          {
            tenantId: "tenant-1",
            mergeLogId: "merge-log-1",
            recordType: "INVOICE",
            recordId: "inv-2",
          },
          {
            tenantId: "tenant-1",
            mergeLogId: "merge-log-1",
            recordType: "PAYMENT",
            recordId: "pay-1",
          },
        ],
      });
    });
  });

  describe("3. T5 B2B Order Approval Integration", () => {
    it("resolves matchedCustomerId to surviving customer upon approval after status guard", async () => {
      // Mock order in PENDING_REVIEW with matchedCustomerId = cust-duplicate
      fakeB2BOrderRequest.findFirst.mockResolvedValueOnce({
        id: "order-1",
        status: "PENDING_REVIEW",
        matchedCustomerId: "cust-duplicate",
      });

      // Merge log shows cust-duplicate was merged into cust-survivor
      fakeCustomerMergeLog.findFirst.mockResolvedValueOnce({
        survivingCustomerId: "cust-survivor",
      });

      // [T5] The approval path is now the FULL flow (claim → FIFO → invoice →
      // stock → link), so every dependency it touches must be arranged.
      fakeB2BOrderRequest.updateMany.mockResolvedValueOnce({ count: 1 });
      fakeB2BOrderRequestItem.findMany.mockResolvedValueOnce([
        {
          productId: "prod-1",
          unitId: "unit-carton",
          quantity: "3",
          priceWholesaleSnapshot: "50000.0000",
          pricingCurrencySnapshot: "SYP",
        },
      ]);
      fakeTenant.findUnique.mockResolvedValueOnce({ dailyExchangeRate: "15000.0000" });
      fakeCustomer.findFirst.mockResolvedValueOnce({ isSystemGenerated: false });
      fakeProductUnit.findUniqueOrThrow.mockResolvedValueOnce({ conversionFactor: "24" });
      fakeInvoice.create.mockResolvedValueOnce({ id: "inv-1" });
      fakeInvoiceItem.create.mockResolvedValue({});
      fakeProductBatch.update.mockResolvedValue({});
      fakeB2BOrderRequest.update.mockResolvedValueOnce({
        id: "order-1",
        status: "APPROVED",
        matchedCustomerId: "cust-survivor",
        resultingInvoiceId: "inv-1",
      });

      const req = new Request("http://localhost/api/orders/order-1/status", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "APPROVED" }),
      });

      const params = Promise.resolve({ id: "order-1" });
      const res = await orderStatusPatch(req, { params });
      expect(res.status).toBe(200);

      // The status CLAIM (race-safe conditional update) froze the resolved
      // active customer ID onto the row.
      expect(fakeB2BOrderRequest.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "order-1", tenantId: "tenant-1", status: "PENDING_REVIEW" },
          data: expect.objectContaining({
            status: "APPROVED",
            matchedCustomerId: "cust-survivor",
          }),
        })
      );

      // ...and the invoice is linked back to the request.
      expect(fakeB2BOrderRequest.update).toHaveBeenCalledWith({
        where: { id: "order-1", tenantId: "tenant-1" },
        data: { resultingInvoiceId: "inv-1" },
      });
    });

    it("rejects approval if order is not in PENDING_REVIEW before customer resolution", async () => {
      fakeB2BOrderRequest.findFirst.mockResolvedValueOnce(null);

      const req = new Request("http://localhost/api/orders/order-1/status", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "APPROVED" }),
      });

      const params = Promise.resolve({ id: "order-1" });
      const res = await orderStatusPatch(req, { params });
      expect(res.status).toBe(400);

      // Customer resolution must not have run, and no invoice may be created
      // for an order that never existed in a reviewable state.
      expect(fakeCustomerMergeLog.findFirst).not.toHaveBeenCalled();
      expect(fakeInvoice.create).not.toHaveBeenCalled();
    });
  });

  describe("4. Static Source Scans (Single Sanctioned Path Enforcements)", () => {
    const readSource = (relPath: string) =>
      fs.readFileSync(path.join(rootDir, relPath), "utf-8");

    it("app/api/sync/route.ts invokes resolveActiveCustomerId", () => {
      const source = readSource("app/api/sync/route.ts");
      expect(source).toContain("resolveActiveCustomerId");
      expect(source).toContain('from "@/lib/customers/resolve-active"');
    });

    it("app/api/ledger/voids/route.ts invokes resolveActiveCustomerId", () => {
      const source = readSource("app/api/ledger/voids/route.ts");
      expect(source).toContain("resolveActiveCustomerId");
      expect(source).toContain('from "@/lib/customers/resolve-active"');
    });

    it("app/api/orders/[id]/status/route.ts invokes resolveActiveCustomerId", () => {
      const source = readSource("app/api/orders/[id]/status/route.ts");
      expect(source).toContain("resolveActiveCustomerId");
      expect(source).toContain('from "@/lib/customers/resolve-active"');
    });

    it("lib/db/tenant-scope.ts includes CustomerMergeLogItem in TENANT_SCOPED_MODELS", () => {
      const source = readSource("lib/db/tenant-scope.ts");
      expect(source).toContain('"CustomerMergeLogItem"');
    });
  });

  describe("5. Concurrency & Stale Offline Write Simulation", () => {
    it("redirects an offline payload still referencing a merged-away customer to survivor", async () => {
      // Simulate state: Customer B was merged into Customer A
      const mockDb: Record<string, string> = {
        "cust-b": "cust-a",
      };

      const mockTx = {
        customerMergeLog: {
          findFirst: vi.fn().mockImplementation(({ where }: any) => {
            const survivor = mockDb[where.mergedCustomerId];
            return Promise.resolve(survivor ? { survivingCustomerId: survivor } : null);
          }),
        },
      } as any;

      // An offline sync arrives carrying stale customerId: "cust-b"
      const staleIncomingCustomerId = "cust-b";
      const resolvedTarget = await resolveActiveCustomerId(mockTx, "tenant-1", staleIncomingCustomerId);

      expect(resolvedTarget).toBe("cust-a");
    });

    it("concurrent merge and write resolve deterministically to surviving customer", async () => {
      // State transitions from unmerged to merged while write resolves
      let mergeCommitted = false;

      const mockTx = {
        customerMergeLog: {
          findFirst: vi.fn().mockImplementation(({ where }: any) => {
            if (mergeCommitted && where.mergedCustomerId === "cust-b") {
              return Promise.resolve({ survivingCustomerId: "cust-a" });
            }
            return Promise.resolve(null);
          }),
        },
      } as any;

      // Merge commits
      mergeCommitted = true;

      // Concurrent write arrives
      const targetCustomer = await resolveActiveCustomerId(mockTx, "tenant-1", "cust-b");
      expect(targetCustomer).toBe("cust-a");
    });
  });

  describe("6. Pre-Merge Confirmation Screen (UX Invariants)", () => {
    const readSource = (relPath: string) =>
      fs.readFileSync(path.join(rootDir, relPath), "utf-8");

    it("MergeCustomersModal requires side-by-side comparison of name, phone, shopName, balance, and invoiceCount", () => {
      const source = readSource("components/ledger/merge-customers-modal.tsx");
      expect(source).toContain("survivor.name");
      expect(source).toContain("duplicate.name");
      expect(source).toContain("survivor.phone");
      expect(source).toContain("duplicate.phone");
      expect(source).toContain("survivor.shopName");
      expect(source).toContain("duplicate.shopName");
      expect(source).toContain("survivor.cachedBalanceDebtSYP");
      expect(source).toContain("duplicate.cachedBalanceDebtSYP");
      expect(source).toContain("survivor.invoiceCount");
      expect(source).toContain("duplicate.invoiceCount");
    });

    it("MergeCustomersModal requires explicit affirmative confirmation checkbox before submission", () => {
      const source = readSource("components/ledger/merge-customers-modal.tsx");
      expect(source).toContain("merge-confirm-checkbox");
      expect(source).toContain("isConfirmed");
      expect(source).toContain("disabled={!canSubmit}");
    });

    it("MergeCustomersModal triggers broadcastCustomerMerged upon successful merge", () => {
      const source = readSource("components/ledger/merge-customers-modal.tsx");
      expect(source).toContain("broadcastCustomerMerged");
    });
  });
});
