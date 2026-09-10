import { Prisma } from "@prisma/client";
import { tenantScopedRawQuery } from "@/lib/db/tenant-scope";

/**
 * Global Deterministic Batch Locking for FIFO Allocations (T3b / T4c / T5)
 *
 * Locks every ProductBatch row that could be touched by FIFO allocation across
 * a whole invoice's line items — spanning every distinct product on that invoice —
 * in a SINGLE `SELECT ... FOR UPDATE ORDER BY id ASC` query, via the one
 * sanctioned raw-query path (`tenantScopedRawQuery`).
 *
 * This must be called ONCE per invoice-processing transaction, BEFORE any
 * per-line-item call to `commitFifoAllocation()`, with every distinct `productId`
 * the invoice sells. This ensures all row locks on `ProductBatch` are acquired in
 * a single, consistent global ascending `id` order, preventing cross-invoice deadlocks.
 *
 * Returns a Map<batchId, quantity> of post-lock quantities.
 *
 * [NOTE — intended usage] The primary reason to call this function is its
 * SIDE EFFECT: acquiring the `FOR UPDATE` row locks in one globally
 * consistent order before any per-line-item allocation happens. In the
 * current call pattern, `commitFifoAllocation()` (lib/inventory/fifo.ts)
 * does its own `tx.productBatch.findMany(...)` read per product — since
 * that read happens on the SAME `tx` after this function has already
 * locked the rows, it transparently observes the post-lock quantities
 * without needing this function's returned Map passed into it. The Map is
 * therefore not consumed by `commitFifoAllocation` today; it is returned
 * for callers that want the post-lock quantities up front (e.g. to
 * pre-validate stock sufficiency across an entire invoice before running
 * any per-item allocation, or for logging/diagnostics) without an extra
 * round trip. Do not assume it is silently unused by mistake — its
 * consumption is optional by design, not an oversight.
 */
export async function lockBatchesForFifoAllocations(
  tx: Prisma.TransactionClient,
  tenantId: string,
  productIds: string[]
): Promise<Map<string, number>> {
  if (!tenantId || !tenantId.trim()) {
    throw new Error(
      "Tenant isolation error: tenantId is required to lock batches for FIFO allocation."
    );
  }

  const uniqueProductIds = [...new Set(productIds.filter(Boolean))];
  if (uniqueProductIds.length === 0) {
    return new Map();
  }

  // Pre-lock read: candidate batches across every product this invoice sells
  const candidateBatches = await tx.productBatch.findMany({
    where: {
      tenantId,
      productId: { in: uniqueProductIds },
      quantity: { gt: 0 },
    },
    select: { id: true },
  });

  if (candidateBatches.length === 0) {
    return new Map();
  }

  const candidateIds = candidateBatches.map((b) => b.id).sort();

  const lockedRows = await tenantScopedRawQuery<Array<{ id: string; quantity: unknown }>>(
    tx,
    tenantId,
    (tenantCondition) => Prisma.sql`
      SELECT id, quantity
      FROM "ProductBatch"
      WHERE id IN (${Prisma.join(candidateIds)})
        AND ${tenantCondition}
      ORDER BY id ASC
      FOR UPDATE
    `
  );

  return new Map(lockedRows.map((row) => [row.id, Number(row.quantity)]));
}