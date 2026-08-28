import { PrismaClient, Prisma } from "@prisma/client";

export interface FifoRequest {
  tenantId: string;
  productId: string;
  unitId: string;
  requestedQty: number;
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

type PrismaTx = PrismaClient | Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends">;

/**
 * Shared Pure FIFO Allocation Resolver
 *
 * Rules:
 * - Order by expiryDate ASC NULLS LAST, then createdAt ASC (oldest received
 *   batch first) as the tie-break.
 * - Converts quantities dynamically between packaging units
 * - Returns split batch allocations
 */
export async function resolveFifoAllocation(
  tx: PrismaTx,
  params: FifoRequest
): Promise<FifoResolution> {
  const { tenantId, productId, unitId, requestedQty } = params;

  if (requestedQty <= 0) {
    throw new Error("الكمية المطلوبة يجب أن تكون أكبر من الصفر.");
  }

  // 1. Fetch requested unit
  const requestedUnit = await (tx as any).productUnit.findFirst({
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

  // TEMPORARY DECISION (pending first-merchant feedback): batches whose
  // expiryDate has already passed are NOT excluded here — they're still
  // offered by FIFO like any other batch with quantity > 0. Revisit once
  // real usage shows whether merchants actually leave expired stock sitting
  // in inventory long enough for this to matter in practice.
  // 2. Fetch available batches for this product with quantity > 0
  const batches = await (tx as any).productBatch.findMany({
    where: {
      tenantId,
      productId,
      quantity: { gt: 0 },
    },
    include: {
      unit: true,
    },
  });

  // 3. Sort batches: expiryDate ASC NULLS LAST, then createdAt ASC.
  // FIX: the tie-break used to compare `id` as a string, which happened to
  // work only because cuid embeds a timestamp — an implementation detail
  // of cuid, not a documented ordering guarantee. Sorting on the schema's
  // explicit `createdAt` column makes "oldest received batch first" the
  // actual intent of the code, not an accident of the ID format.
  const sortedBatches = [...batches].sort((a: any, b: any) => {
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