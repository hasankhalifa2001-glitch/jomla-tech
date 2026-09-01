import { Prisma } from "@prisma/client";
import { tenantScopedRawQuery } from "@/lib/db/tenant-scope";

export interface FifoRequest {
  tenantId: string;
  productId: string;
  unitId: string;
  requestedQty: number;
  mode?: "PREVIEW" | "COMMIT";
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
 * [FIX — critical race condition] The previous version of this function,
 * in COMMIT mode, acquired `SELECT id ... FOR UPDATE` locks on the
 * candidate batches but only ever selected `id` in that query — it kept
 * using the `quantity` values read earlier via the pre-lock `findMany`
 * call for every allocation decision below. That defeats the entire
 * purpose of taking the lock: a transaction that had to WAIT for this
 * lock (because a concurrent transaction was mid-commit against the same
 * batch) resumes holding data from BEFORE that other transaction
 * committed — it has no way to see what actually changed. Two concurrent
 * syncs could both "see" the same last unit of stock as available and
 * both allocate it, directly violating T4c's acceptance criterion ("Two
 * devices' sync requests both drawing from a batch's last units never
 * both succeed").
 *
 * Fixed by having the locking query also SELECT `quantity`, and
 * overwriting every locked batch's in-memory `quantity` with that
 * POST-lock value before any allocation math runs. The pre-lock
 * `findMany` read is now used only to decide which rows are worth
 * locking in the first place (a cheap first pass) — never as the source
 * of truth for how much is actually available.
 *
 * Known accepted limitation (not the race this fix targets): a batch
 * that had `quantity <= 0` at the time of the initial `findMany` — and
 * was therefore excluded from `candidateBatches` by the `quantity: { gt:
 * 0 } }` filter — is not picked up even if it was concurrently restocked
 * (e.g. by a void) between that read and the lock. FIFO here resolves
 * against a consistent snapshot of "candidates as of read time," not a
 * fully re-scanned view after locking.
 */
export async function resolveFifoAllocation(
  tx: PrismaTx,
  params: FifoRequest
): Promise<FifoResolution> {
  const { tenantId, productId, unitId, requestedQty, mode = "PREVIEW" } = params;

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
  // are only a starting point used to decide which rows to lock — see
  // step 3, where they are overwritten with POST-lock values before any
  // allocation math runs.
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

  // 3. COMMIT mode: acquire FOR UPDATE locks on candidate batches in
  // deterministic `ORDER BY id ASC` order (prevents cross-transaction
  // deadlocks) AND re-read `quantity` for those exact rows in the same
  // locked query — then use ONLY these post-lock values from here on.
  if (mode === "COMMIT" && candidateBatches.length > 0) {
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

    const freshQuantityById = new Map<string, number>(
      lockedRows.map((row) => [row.id, Number(row.quantity)])
    );

    for (const batch of candidateBatches) {
      const fresh = freshQuantityById.get(batch.id);
      // A candidate missing from the locked result set (e.g. deleted
      // between step 2 and the lock) is treated as unavailable rather
      // than trusting its stale pre-lock quantity.
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