import { Prisma } from "@prisma/client";
import { tenantScopedRawQuery } from "@/lib/db/tenant-scope";

export interface FifoRequest {
  tenantId: string;
  productId: string;
  unitId: string;
  requestedQty: number;
  mode?: "PREVIEW" | "COMMIT";
  /**
   * [ADDED] Post-lock batch quantities, keyed by ProductBatch.id, when the
   * CALLER has already locked every batch this invoice could touch — across
   * ALL of its line items/products — in a single `ORDER BY id ASC` query
   * (see `lockBatchesForFifoAllocations` below). When provided in COMMIT
   * mode, this function uses these values directly instead of issuing its
   * own internal lock query.
   *
   * WHY THIS MATTERS: a sale invoice can contain line items for more than
   * one product. If each product's candidate batches were locked via their
   * own separate `SELECT ... FOR UPDATE ORDER BY id ASC` call (one raw
   * query per product, issued sequentially as this function was called once
   * per line item), each individual query is internally ordered, but the
   * INVOICE AS A WHOLE does not acquire its full set of row locks via one
   * consistent global order — it acquires them via several independent SQL
   * statements. Two concurrent invoices selling the same two products in
   * opposite line-item order could still deadlock against each other in
   * that scheme, since Postgres has no way to know the two separate
   * statements from one transaction are related. Passing a single,
   * pre-locked map computed up front for the whole invoice closes that gap.
   */
  preLockedQuantities?: Map<string, number>;
}

export interface FifoAllocationItem {
  batchId: string;
  batchNumber: string;
  expiryDate: Date | null;
  allocatedQty: number; // Quantity in terms of the requested unit (e.g., Packs)
  deductQtyInBatchUnit: number; // Quantity in terms of batch's own unit (e.g., Pieces or Packs)
  batchUnitId: string;
  batchUnitName: string;
}

export interface FifoResolution {
  productId: string;
  requestedUnitId: string;
  requestedUnitName: string;
  requestedQty: number;
  totalAllocatedQty: number; // In requested unit
  remainingQty: number; // Unallocated in requested unit
  isSufficient: boolean;
  allocations: FifoAllocationItem[];
}

/**
 * [FIX] Uses Prisma's own `Prisma.TransactionClient` type directly instead
 * of a hand-rolled `Omit<PrismaClient, ...>` alias. The previous alias was
 * NOT structurally identical to `Prisma.TransactionClient`, which forced
 * every call into `tenantScopedRawQuery()` (and every model call in this
 * file) through an `as any` / `as unknown as PrismaClient` cast — quietly
 * defeating the type-level tenantId enforcement `tenantScopedRawQuery`
 * exists to guarantee. `Prisma.TransactionClient` is a strict subset of
 * `PrismaClient`'s shape, so a real `PrismaClient` instance (used for
 * read-only PREVIEW calls outside any transaction) is still assignable
 * here with zero casts — this type covers both call shapes correctly.
 */
type PrismaTx = Prisma.TransactionClient;

interface BatchRecord {
  id: string;
  batchNumber: string;
  quantity: unknown;
  expiryDate: Date | null | string;
  createdAt: Date | string;
  unitId: string;
  unit?: {
    conversionFactor: unknown;
    unitName: string;
  } | null;
}

/**
 * [ADDED] Locks every ProductBatch row that COULD be touched by FIFO
 * allocation across a whole invoice's line items — spanning every distinct
 * product on that invoice, not just one — in a SINGLE `SELECT ... FOR
 * UPDATE ORDER BY id ASC` query, via the one sanctioned raw-query path.
 *
 * This must be called ONCE per invoice-processing transaction, BEFORE any
 * per-line-item call to `resolveFifoAllocation(mode: "COMMIT")`, with every
 * distinct `productId` the invoice sells. Its result is then passed into
 * each `resolveFifoAllocation` call via `preLockedQuantities`, so every row
 * lock the transaction takes on `ProductBatch` — regardless of which line
 * item "owns" that batch — is acquired by this one query, in one
 * consistent ascending order. That is what actually prevents cross-invoice
 * deadlocks when two invoices sell overlapping products in different
 * order; locking product-by-product (even if each product's own lock query
 * is internally sorted) does not provide that guarantee on its own.
 *
 * Returns a Map<batchId, quantity> of POST-lock quantities. A batch that
 * had `quantity <= 0` at the pre-lock read (and was therefore never a
 * candidate) is simply absent from the map — callers must treat a missing
 * id as 0, exactly as `resolveFifoAllocation` already does internally.
 */
export async function lockBatchesForFifoAllocations(
  tx: PrismaTx,
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

  // Pre-lock read: candidate batches across EVERY product this invoice
  // sells, gathered in one pass — mirrors resolveFifoAllocation's own
  // step 2, just widened from one product to the invoice's full set.
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

/**
 * Shared Pure FIFO Allocation Resolver
 *
 * Rules:
 * - Order by expiryDate ASC NULLS LAST, then createdAt ASC (oldest received
 *   batch first) as the tie-break.
 * - Converts quantities dynamically between packaging units.
 * - Returns split batch allocations.
 * - Supports PREVIEW mode (read-only) and COMMIT mode (deterministic lock
 *   ordering: ORDER BY id ASC on multi-batch FOR UPDATE locks to prevent
 *   deadlocks).
 *
 * [FIX — critical race condition, earlier revision] In COMMIT mode, this
 * function locks candidate batches and then uses the POST-lock quantity
 * for every allocation decision — never the pre-lock `findMany` values,
 * which could be stale by the time the lock is actually granted.
 *
 * [ADDED — cross-item lock ordering] COMMIT mode now accepts an optional
 * `preLockedQuantities` map (see `lockBatchesForFifoAllocations` above).
 * When the caller supplies it (because it already locked every batch for
 * the WHOLE invoice, across every product, in one query), this function
 * uses that map directly and skips its own internal lock query entirely —
 * critical, because issuing a second, separate lock query per line item
 * would defeat the single-global-order guarantee the caller just
 * established. When `preLockedQuantities` is omitted, this function falls
 * back to its previous behavior: locking only THIS product's candidates in
 * their own `ORDER BY id ASC` query. That fallback remains safe for a
 * single-product COMMIT call in isolation, but MUST NOT be relied on for
 * more than one product within the same transaction — doing so reintroduces
 * exactly the cross-invoice deadlock risk this parameter exists to close.
 *
 * Known accepted limitation (unchanged): a batch that had `quantity <= 0`
 * at the time of the initial `findMany` — and was therefore excluded from
 * `candidateBatches` by the `quantity: { gt: 0 } }` filter — is not picked
 * up even if it was concurrently restocked (e.g. by a void) between that
 * read and the lock. FIFO here resolves against a consistent snapshot of
 * "candidates as of read time," not a fully re-scanned view after locking.
 */
export async function resolveFifoAllocation(
  tx: PrismaTx,
  params: FifoRequest
): Promise<FifoResolution> {
  const {
    tenantId,
    productId,
    unitId,
    requestedQty,
    mode = "PREVIEW",
    preLockedQuantities,
  } = params;

  if (requestedQty <= 0) {
    throw new Error("الكمية المطلوبة يجب أن تكون أكبر من الصفر.");
  }

  if (!tenantId || !tenantId.trim()) {
    throw new Error("Tenant isolation error: tenantId is required to resolve a FIFO allocation.");
  }

  // [ADDED] Defensive runtime guard: `Prisma.TransactionClient` and the
  // top-level `PrismaClient` are structurally similar enough that nothing
  // stops a caller from accidentally passing the raw top-level client
  // into COMMIT mode. If that happens, `tx.$queryRaw` below would run as
  // its own implicit, auto-committing statement — it would acquire the
  // `FOR UPDATE` lock and release it again immediately, before this
  // function ever gets a chance to act on it. That provides *zero* real
  // protection while looking identical to the safe path. The top-level
  // client exposes `$transaction`; a `Prisma.TransactionClient` received
  // inside an open `prisma.$transaction(async (tx) => ...)` callback does
  // not. This check catches the misuse at the call site instead of
  // silently no-op'ing the lock.
  if (mode === "COMMIT" && typeof (tx as { $transaction?: unknown }).$transaction === "function") {
    throw new Error(
      "resolveFifoAllocation(mode: 'COMMIT') must be called with the " +
      "Prisma.TransactionClient passed into an open prisma.$transaction(...) " +
      "callback — calling it with the top-level client means the FOR UPDATE " +
      "lock is acquired and released immediately, before this function can " +
      "use it, providing no real protection against concurrent allocation."
    );
  }

  // 1. Fetch requested unit.
  const requestedUnit = await tx.productUnit.findFirst({
    where: {
      id: unitId,
      productId,
      tenantId,
    },
  });

  if (!requestedUnit) {
    throw new Error("وحدة القياس المطلوبة غير موجودة لهذا المنتج.");
  }

  const requestedFactor = Number(requestedUnit.conversionFactor) || 1;
  const requestedQtyInBase = requestedQty * requestedFactor;

  // 2. Fetch candidate batches for this product with quantity > 0.
  // [NOTE] In COMMIT mode this is a PRE-LOCK read. Its `quantity` values
  // are only a starting point used to decide which rows are relevant —
  // see step 3, where they are overwritten with POST-lock values before
  // any allocation math runs.
  const candidateBatches = (await tx.productBatch.findMany({
    where: {
      tenantId,
      productId,
      quantity: { gt: 0 },
    },
    include: {
      unit: true,
    },
  })) as unknown as BatchRecord[];

  // 3. COMMIT mode: resolve authoritative post-lock quantities.
  if (mode === "COMMIT" && candidateBatches.length > 0) {
    let freshQuantityById: Map<string, number>;

    if (preLockedQuantities) {
      // See the ADDED note on `preLockedQuantities` above and on
      // `lockBatchesForFifoAllocations` — the caller already locked every
      // batch this invoice could touch, across every line item, in one
      // ORDER BY id ASC query. Use those values directly; do NOT issue a
      // second lock query here.
      freshQuantityById = preLockedQuantities;
    } else {
      // Fallback: no invoice-wide pre-lock was supplied. Safe ONLY for a
      // single-product COMMIT call in isolation within its transaction —
      // see the function-level doc comment for why this must not be used
      // for more than one product in the same transaction.
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

      freshQuantityById = new Map(lockedRows.map((row) => [row.id, Number(row.quantity)]));
    }

    for (const batch of candidateBatches) {
      const fresh = freshQuantityById.get(batch.id);
      // A candidate missing from the locked result set (e.g. deleted
      // between step 2 and the lock, or simply never included in a
      // caller-supplied preLockedQuantities map because it had
      // quantity <= 0 at that map's own pre-lock read) is treated as
      // unavailable rather than trusting its stale pre-lock quantity.
      batch.quantity = fresh !== undefined ? fresh : 0;
    }
  }

  // 4. Sort batches: expiryDate ASC NULLS LAST, then createdAt ASC.
  const sortedBatches = [...candidateBatches].sort((a: BatchRecord, b: BatchRecord) => {
    if (a.expiryDate && b.expiryDate) {
      const diff = new Date(a.expiryDate).getTime() - new Date(b.expiryDate).getTime();
      if (diff !== 0) return diff;
    } else if (a.expiryDate && !b.expiryDate) {
      return -1;
    } else if (!a.expiryDate && b.expiryDate) {
      return 1;
    }
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  });

  const allocations: FifoAllocationItem[] = [];
  let remainingNeededInBase = requestedQtyInBase;

  for (const batch of sortedBatches) {
    if (remainingNeededInBase <= 0) break;

    const batchUnitFactor = Number(batch.unit?.conversionFactor) || 1;
    const batchAvailableInBatchUnit = Number(batch.quantity);
    const batchAvailableInBase = batchAvailableInBatchUnit * batchUnitFactor;

    if (batchAvailableInBase <= 0) continue;

    const allocatedBase = Math.min(remainingNeededInBase, batchAvailableInBase);
    const allocatedInReqUnit = allocatedBase / requestedFactor;
    const deductInBatchUnit = allocatedBase / batchUnitFactor;

    allocations.push({
      batchId: batch.id,
      batchNumber: batch.batchNumber,
      expiryDate: batch.expiryDate ? new Date(batch.expiryDate) : null,
      allocatedQty: Number(allocatedInReqUnit.toFixed(4)),
      deductQtyInBatchUnit: Number(deductInBatchUnit.toFixed(4)),
      batchUnitId: batch.unitId,
      batchUnitName: batch.unit?.unitName || "",
    });

    remainingNeededInBase -= allocatedBase;
  }

  const totalAllocatedBase = requestedQtyInBase - Math.max(0, remainingNeededInBase);
  const totalAllocatedQty = Number((totalAllocatedBase / requestedFactor).toFixed(4));
  const remainingQty = Number((Math.max(0, remainingNeededInBase) / requestedFactor).toFixed(4));
  const isSufficient = remainingNeededInBase <= 0;

  return {
    productId,
    requestedUnitId: unitId,
    requestedUnitName: requestedUnit.unitName,
    requestedQty,
    totalAllocatedQty,
    remainingQty,
    isSufficient,
    allocations,
  };
}