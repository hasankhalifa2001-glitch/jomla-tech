/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { lockBatchesForFifoAllocations } from "../batch-locking";
import { Prisma } from "@prisma/client";
import { tenantScopedRawQuery } from "@/lib/db/tenant-scope";

vi.mock("@/lib/db/tenant-scope", () => ({
  tenantScopedRawQuery: vi.fn(),
}));

describe("T3b Batch Locking & Deadlock Prevention (lib/inventory/batch-locking.ts)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("locks candidate batches with deterministic ORDER BY id ASC", async () => {
    const mockTx = {
      productBatch: {
        findMany: vi.fn().mockResolvedValue([
          { id: "batch-c" },
          { id: "batch-a" },
          { id: "batch-b" },
        ]),
      },
    } as unknown as Prisma.TransactionClient;

    vi.mocked(tenantScopedRawQuery).mockResolvedValue([
      { id: "batch-a", quantity: 10 },
      { id: "batch-b", quantity: 20 },
      { id: "batch-c", quantity: 30 },
    ]);

    const result = await lockBatchesForFifoAllocations(mockTx, "tenant-1", ["prod-1", "prod-2"]);

    expect(mockTx.productBatch.findMany).toHaveBeenCalledWith({
      where: {
        tenantId: "tenant-1",
        productId: { in: ["prod-1", "prod-2"] },
        quantity: { gt: 0 },
      },
      select: { id: true },
    });

    expect(tenantScopedRawQuery).toHaveBeenCalledTimes(1);
    expect(result.get("batch-a")).toBe(10);
    expect(result.get("batch-b")).toBe(20);
    expect(result.get("batch-c")).toBe(30);
  });

  // [FIX — the previous version of this test was invalid, not just
  // "not a real deadlock test"]
  //
  // The previous implementation mocked `tenantScopedRawQuery` to read a
  // test-only field the test itself attached to the fake `tx` object
  // (`(tx as any)._candidateBatchIds`), sort THAT array inside the mock,
  // and log the result — while completely ignoring the third argument
  // the mock actually received (the real `sqlCallback` the production
  // code builds and passes in). That meant the test could never fail even
  // if `lockBatchesForFifoAllocations` stopped sorting candidate IDs
  // entirely: it was asserting that the mock's own inline `.sort()` call
  // produced sorted output, not that the production code did. A test
  // that can't fail when the behavior it claims to check is broken is
  // worse than no test.
  //
  // This version instead captures the real `sqlCallback` argument the
  // production code passes to `tenantScopedRawQuery`, invokes it (exactly
  // as `tenantScopedRawQuery` itself would), and inspects the resulting
  // `Prisma.Sql` fragment's `.values` — which is where `Prisma.join(candidateIds)`
  // actually places each ID as its own bound value, in the order the
  // production code supplied them. This proves the IMPLEMENTATION sorted
  // the IDs before building the query, not merely that a test double did.
  //
  // This is still a single-call, ordering-contract test — NOT proof that
  // two real concurrent Postgres transactions never deadlock. See T7's
  // launch-blocking deadlock suite (a real integration test against an
  // actual Postgres instance, two genuine concurrent `$transaction` calls
  // racing overlapping `FOR UPDATE` locks) for the claim this function's
  // JSDoc and T3b's acceptance criteria actually require.
  it("passes candidate batch IDs to the lock query pre-sorted ascending, verified from the real SQL fragment (not a mock-internal field)", async () => {
    const mockTx = {
      productBatch: {
        findMany: vi.fn().mockResolvedValue([
          { id: "batch-9" },
          { id: "batch-2" },
          { id: "batch-15" },
        ]),
      },
    } as unknown as Prisma.TransactionClient;

    vi.mocked(tenantScopedRawQuery).mockResolvedValue([]);

    await lockBatchesForFifoAllocations(mockTx, "tenant-1", ["prod-1"]);

    expect(tenantScopedRawQuery).toHaveBeenCalledTimes(1);

    // Grab the real sqlCallback the implementation built and passed as
    // the third argument to tenantScopedRawQuery.
    const [, , sqlCallback] = vi.mocked(tenantScopedRawQuery).mock.calls[0] as [
      Prisma.TransactionClient,
      string,
      (tenantCondition: Prisma.Sql) => Prisma.Sql
    ];

    // Invoke it exactly as tenantScopedRawQuery itself would, with a
    // stand-in tenant condition fragment.
    const builtSql = sqlCallback(Prisma.sql`1=1`);

    // "batch-9", "batch-2", "batch-15" sorted ascending (string sort) is
    // ["batch-15", "batch-2", "batch-9"]. Prisma.join(candidateIds) binds
    // each ID as its own positional value in the order supplied — so
    // inspecting builtSql.values proves the implementation itself sorted
    // them before ever building the SQL, not a test-side assumption.
    expect(builtSql.values.slice(0, 3)).toEqual(["batch-15", "batch-2", "batch-9"]);
  });

  it("returns empty map when no candidate productIds provided or no candidate batches found", async () => {
    const mockTx = {
      productBatch: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    } as unknown as Prisma.TransactionClient;

    const resEmpty = await lockBatchesForFifoAllocations(mockTx, "tenant-1", []);
    expect(resEmpty.size).toBe(0);
    expect(tenantScopedRawQuery).not.toHaveBeenCalled();

    const resNoBatches = await lockBatchesForFifoAllocations(mockTx, "tenant-1", ["prod-none"]);
    expect(resNoBatches.size).toBe(0);
    expect(tenantScopedRawQuery).not.toHaveBeenCalled();
  });

  it("throws tenant isolation error if tenantId is omitted or blank", async () => {
    const mockTx = {} as Prisma.TransactionClient;

    await expect(lockBatchesForFifoAllocations(mockTx, "", ["prod-1"])).rejects.toThrow(
      "Tenant isolation error"
    );
  });
});