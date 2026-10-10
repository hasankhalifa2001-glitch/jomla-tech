import { Prisma } from "@prisma/client";
import { tenantScopedRawQuery } from "@/lib/db/tenant-scope";

/**
 * Global Deterministic Batch Locking for FIFO Allocations (T3b / T4c / T5)
 *
 * Locks EVERY ProductBatch row of every product on a whole invoice, in a
 * SINGLE `SELECT ... FOR UPDATE ORDER BY id ASC` query, via the one
 * sanctioned raw-query path (`tenantScopedRawQuery`).
 *
 * This must be called ONCE per invoice-processing transaction, BEFORE any
 * per-line-item call to `commitFifoAllocation()`, with every distinct
 * `productId` the invoice sells. All row locks on `ProductBatch` are then
 * acquired in one globally consistent ascending `id` order across ALL the
 * invoice's products, which is what prevents cross-invoice deadlocks.
 *
 * [v4.8 FIX — two real gaps in the previous version]
 *  (1) It first read the candidate batches WITHOUT a lock
 *      (`findMany ... quantity > 0`) and then locked only those ids. A batch
 *      that was empty at that unlocked read (e.g. one a concurrent void had
 *      just refilled, or one another invoice had just emptied) was never
 *      locked, yet commitFifoAllocation() — which re-reads after the lock —
 *      could still see and draw from it, i.e. a draw with no lock held.
 *  (2) It never locked the batch the sale's SHORTFALL (overdraw) lands on,
 *      because that batch is by definition at quantity <= 0 and was filtered
 *      out. Two devices overselling the same product could both go negative
 *      on it without ever serialising.
 * The query below has NO quantity filter and no preceding unlocked read: it
 * locks every batch of the products in one statement, so whatever
 * commitFifoAllocation() or the overdraw fallback touches afterwards is
 * already locked.
 *
 * Cost note: this locks a product's empty/old batches too. For merchants
 * with very long batch histories per product, narrow it (e.g. restrict to
 * recent batches) only together with the overdraw-batch selection in
 * app/api/sync/route.ts.
 *
 * Returns a Map<batchId, quantity> of post-lock quantities. The quantity is
 * returned as a decimal STRING (`quantity::text`) — never coerced through a
 * native JS number (the previous version returned Number(row.quantity)).
 * Consuming the Map is optional by design: the primary purpose of this
 * function is its SIDE EFFECT (the row locks).
 */
export async function lockBatchesForFifoAllocations(
  tx: Prisma.TransactionClient,
  tenantId: string,
  productIds: string[]
): Promise<Map<string, string>> {
  if (!tenantId || !tenantId.trim()) {
    throw new Error(
      "Tenant isolation error: tenantId is required to lock batches for FIFO allocation."
    );
  }

  const uniqueProductIds = [...new Set(productIds.filter(Boolean))];
  if (uniqueProductIds.length === 0) {
    return new Map();
  }

  const lockedRows = await tenantScopedRawQuery<Array<{ id: string; quantity: string }>>(
    tx,
    tenantId,
    (tenantCondition) => Prisma.sql`
      SELECT id, quantity::text AS quantity
      FROM "ProductBatch"
      WHERE "productId" IN (${Prisma.join(uniqueProductIds)})
        AND ${tenantCondition}
      ORDER BY id ASC
      FOR UPDATE
    `
  );

  return new Map(lockedRows.map((row) => [row.id, row.quantity]));
}