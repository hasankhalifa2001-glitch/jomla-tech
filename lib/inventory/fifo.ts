import { Prisma } from "@prisma/client";
import Decimal from "decimal.js";
import { getTenantDb } from "@/lib/db/tenant-scope";
import { convertUnitQuantity } from "@/lib/inventory/conversions";

export interface AllocationPlanItem {
  batchId: string;
  batchNumber: string;
  expiryDate: Date | null;
  allocatedQty: number; // Quantity in terms of the requested unit (e.g. Packs)
  deductQtyInBatchUnit: number; // Quantity in terms of batch's own unit (e.g. Pieces or Cartons)
  batchUnitId: string;
  batchUnitName: string;
}

export type FifoAllocationItem = AllocationPlanItem;

export interface AllocationPlan {
  productId: string;
  requestedUnitId: string;
  requestedUnitName: string;
  requestedQty: number;
  totalAllocatedQty: number; // In requested unit
  remainingQty: number; // Unallocated in requested unit
  isSufficient: boolean;
  allocations: AllocationPlanItem[];
}

export type FifoResolution = AllocationPlan;

export interface PreviewFifoParams {
  tenantId: string;
  productId: string;
  unitId: string;
  requestedQty: number;
}

export interface CommitFifoParams {
  tenantId: string;
  productId: string;
  unitId: string;
  requestedQty: number;
}

export type FifoRequest = CommitFifoParams;

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

interface UnitRecord {
  id: string;
  unitName: string;
  conversionFactor: unknown;
}

/**
 * Shared, unexported FIFO core allocation math and deterministic sorting engine.
 *
 * Sorting Rules:
 * 1. `expiryDate ASC NULLS LAST` (earliest expiring batches consumed first; batches without expiry last)
 * 2. `id ASC`, compared by raw code-point order (not `localeCompare`, whose
 *    result depends on the runtime's ICU/locale configuration and is not
 *    guaranteed identical across environments) — this must match Postgres's
 *    own `ORDER BY id ASC` byte-order comparison exactly, since this is the
 *    same tie-break the database uses when locking these rows.
 *
 * All quantity math is done via decimal.js — through convertUnitQuantity()
 * in lib/inventory/conversions.ts, the single shared module for unit
 * conversion — rather than reimplementing the same multiplication/division
 * with native Number here. ProductBatch.quantity is a Decimal(18,4) column;
 * per T1's mandate, precision must be exact from the source, never
 * float-then-converted. Output fields are rounded to 4 decimal places only
 * at the very end, when producing the display/allocation-plan value.
 */
function allocateBatches(
  batches: BatchRecord[],
  requestedUnit: UnitRecord,
  requestedQty: number,
  productId: string
): AllocationPlan {
  const requestedFactor = new Decimal(requestedUnit.conversionFactor as Decimal.Value || 1);
  // Base-unit equivalent of the requested quantity (base unit == factor 1).
  const requestedQtyInBase = convertUnitQuantity(requestedQty, requestedFactor, 1);

  // Deterministic sorting: expiryDate ASC NULLS LAST, id ASC tie-break.
  const sortedBatches = [...batches].sort((a: BatchRecord, b: BatchRecord) => {
    if (a.expiryDate && b.expiryDate) {
      const diff = new Date(a.expiryDate).getTime() - new Date(b.expiryDate).getTime();
      if (diff !== 0) return diff;
    } else if (a.expiryDate && !b.expiryDate) {
      return -1;
    } else if (!a.expiryDate && b.expiryDate) {
      return 1;
    }
    // id ASC tie-breaker via raw code-point comparison — matches
    // Postgres's ORDER BY id ASC byte ordering deterministically across
    // every runtime, unlike localeCompare().
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const allocations: AllocationPlanItem[] = [];
  let remainingNeededInBase = requestedQtyInBase;

  for (const batch of sortedBatches) {
    if (remainingNeededInBase.lte(0)) break;

    const batchUnitFactor = new Decimal((batch.unit?.conversionFactor as Decimal.Value) || 1);
    const batchAvailableInBatchUnit = new Decimal(batch.quantity as Decimal.Value);
    const batchAvailableInBase = convertUnitQuantity(batchAvailableInBatchUnit, batchUnitFactor, 1);

    if (batchAvailableInBase.lte(0)) continue;

    const allocatedBase = Decimal.min(remainingNeededInBase, batchAvailableInBase);
    const allocatedInReqUnit = convertUnitQuantity(allocatedBase, 1, requestedFactor);
    const deductInBatchUnit = convertUnitQuantity(allocatedBase, 1, batchUnitFactor);

    allocations.push({
      batchId: batch.id,
      batchNumber: batch.batchNumber,
      expiryDate: batch.expiryDate ? new Date(batch.expiryDate) : null,
      allocatedQty: Number(allocatedInReqUnit.toFixed(4)),
      deductQtyInBatchUnit: Number(deductInBatchUnit.toFixed(4)),
      batchUnitId: batch.unitId,
      batchUnitName: batch.unit?.unitName || "",
    });

    remainingNeededInBase = remainingNeededInBase.minus(allocatedBase);
  }

  const totalAllocatedBase = requestedQtyInBase.minus(Decimal.max(0, remainingNeededInBase));
  const totalAllocatedQty = Number(convertUnitQuantity(totalAllocatedBase, 1, requestedFactor).toFixed(4));
  const remainingQty = Number(
    convertUnitQuantity(Decimal.max(0, remainingNeededInBase), 1, requestedFactor).toFixed(4)
  );
  const isSufficient = remainingNeededInBase.lte(0);

  return {
    productId,
    requestedUnitId: requestedUnit.id,
    requestedUnitName: requestedUnit.unitName,
    requestedQty,
    totalAllocatedQty,
    remainingQty,
    isSufficient,
    allocations,
  };
}

/**
 * Preview FIFO Allocation (T3b)
 *
 * Takes no `tx` parameter at all. Performs a plain, unlocked read (no
 * SELECT ... FOR UPDATE, no $transaction) returning the allocation plan
 * for display / UI preview purposes only. It is structurally incapable of
 * writing or locking.
 *
 * Goes through `getTenantDb(tenantId)`, the sanctioned tenant-scoped
 * client (lib/db/tenant-scope.ts) — tenantId injection is automatic and
 * structural, never a manually-repeated `where` clause.
 */
export async function previewFifoAllocation(
  params: PreviewFifoParams
): Promise<AllocationPlan> {
  const { tenantId, productId, unitId, requestedQty } = params;

  if (requestedQty <= 0) {
    throw new Error("الكمية المطلوبة يجب أن تكون أكبر من الصفر.");
  }

  if (!tenantId || !tenantId.trim()) {
    throw new Error("Tenant isolation error: tenantId is required to preview a FIFO allocation.");
  }

  const db = getTenantDb(tenantId);

  const requestedUnit = await db.productUnit.findFirst({
    where: { id: unitId, productId },
    select: { id: true, unitName: true, conversionFactor: true },
  });

  if (!requestedUnit) {
    throw new Error("وحدة القياس المطلوبة غير موجودة لهذا المنتج.");
  }

  const candidateBatches = (await db.productBatch.findMany({
    where: { productId, quantity: { gt: 0 } },
    include: { unit: true },
  })) as unknown as BatchRecord[];

  return allocateBatches(candidateBatches, requestedUnit, requestedQty, productId);
}

/**
 * Commit FIFO Allocation (T3b)
 *
 * `tx: Prisma.TransactionClient` is a strictly required first parameter.
 * Used exclusively by write paths (T4c sync commit, T5 B2B approval commit).
 *
 * Assumes the lock (`SELECT ... FOR UPDATE ORDER BY id ASC`, via
 * `lockBatchesForFifoAllocations` in lib/inventory/batch-locking.ts) has
 * already been acquired by the caller before this function is invoked.
 * This function contains NO internal call to `$queryRaw` /
 * `tenantScopedRawQuery` — it reads the locked state directly through
 * `tx`, which transparently observes post-lock quantities since it shares
 * the same open transaction the caller locked rows in.
 */
export async function commitFifoAllocation(
  tx: Prisma.TransactionClient,
  params: CommitFifoParams
): Promise<AllocationPlan> {
  const { tenantId, productId, unitId, requestedQty } = params;

  if (requestedQty <= 0) {
    throw new Error("الكمية المطلوبة يجب أن تكون أكبر من الصفر.");
  }

  if (!tenantId || !tenantId.trim()) {
    throw new Error("Tenant isolation error: tenantId is required to commit a FIFO allocation.");
  }

  const requestedUnit = await tx.productUnit.findFirst({
    where: { id: unitId, productId, tenantId },
    select: { id: true, unitName: true, conversionFactor: true },
  });

  if (!requestedUnit) {
    throw new Error("وحدة القياس المطلوبة غير موجودة لهذا المنتج.");
  }

  const candidateBatches = (await tx.productBatch.findMany({
    where: { tenantId, productId, quantity: { gt: 0 } },
    include: { unit: true },
  })) as unknown as BatchRecord[];

  return allocateBatches(candidateBatches, requestedUnit, requestedQty, productId);
}