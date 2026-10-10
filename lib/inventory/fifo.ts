import Decimal from "decimal.js";
import { getTenantDb } from "@/lib/db/tenant-scope";
import type { TxOrClient } from "@/lib/db/tenant-scope";
import { requireBaseUnit } from "@/lib/inventory/base-unit";
/**
 * lib/inventory/fifo.ts (T3b)
 *
 * ============================================================================
 * CORRECTION NOTE (v4.0 alignment fix):
 * The previous version of this file imported `convertUnitQuantity` from
 * `lib/inventory/conversions.ts` and used it, inside `allocateBatches`, to
 * convert between "the requested sale unit" and "each batch's own unit"
 * via each side's unit ratio. That assumed a ProductBatch could be
 * tracked in a unit other than the product's base unit — exactly the
 * pre-v4.0 design MASTER-SPEC v4.0 replaced (T1's Rejected Approach #10:
 * "Allowing ProductBatch.unitId to reference any ProductUnit belonging to
 * the product"). Under the current schema, ProductBatch.unitId is ALWAYS
 * Product.baseUnitId, and that unit's ratio is ALWAYS 1 — so
 * there was nothing left to legitimately convert, and the old code
 * directly violated T3b's own Acceptance Criteria:
 *   "fifo.ts itself contains no reference to unit conversion ratio in any
 *    form — verified by static analysis of every call site in the file."
 *
 * FIX: this file no longer imports or references unit conversion ratio / any
 * unit-conversion function anywhere. `previewFifoAllocation` and
 * `commitFifoAllocation` operate purely on ProductBatch.quantity figures,
 * which are base-unit numbers by construction (T3b, MASTER-SPEC v4.0).
 *
 * `params.requestedQty` is now ALWAYS assumed to already be expressed in
 * the product's base unit — converting a sale/order quantity from a
 * non-base sale unit (e.g. "packs") into the base unit is the CALLER's
 * responsibility (T4b's POS / T4c's sync engine / T5's B2B approval),
 * performed via `toBaseUnit()` (lib/inventory/units.ts) BEFORE this
 * function is ever invoked — never inside this file.
 *
 * `params.unitId` is retained in the public signature for backward
 * compatibility with existing call sites, but its role changed: it is now
 * asserted to equal the product's actual base unit id (resolved via
 * `requireBaseUnit()`), never used to fetch or apply a unit ratio.
 * A mismatch throws immediately — that is a caller/integration bug (a
 * forgotten toBaseUnit() conversion upstream), never a case to silently
 * paper over.
 *
 * [FIX — requestedQty is now a decimal STRING, never `number`]
 * `toBaseUnit()` (lib/inventory/units.ts) returns a Decimal instance;
 * every caller (this project's fifo-preview route included) correctly
 * serializes that via `.toString()` before handing it off, per T1's
 * decimal.js-everywhere rule for anything quantity-shaped. The previous
 * revision of this file typed `requestedQty` as a native `number` in
 * every interface below — a real mismatch against every caller that
 * follows the project's own convention, and one that would force a
 * caller to round-trip through `Number(...)` just to satisfy the type,
 * silently reopening the exact precision hole this whole base-unit
 * architecture exists to close for large or fractional quantities.
 * Fixed: `requestedQty` is now typed as `DecimalValue` (string | number |
 * Decimal instance) everywhere in this file, the `<= 0` guard now
 * compares via `new Decimal(requestedQty).lte(0)` instead of a native
 * JS operator, and every requestedQty value that reaches an output field
 * (`AllocationPlan.requestedQty`) is stored as a Decimal-normalized
 * string, consistent with every other quantity-shaped field this file
 * already produces (`totalAllocatedQty`, `remainingQty`, `allocatedQty`).
 *
 * [v4.8 — NOTES FOR CALLERS, no signature change]
 * (a) commitFifoAllocation() only READS batches (despite its name) — it
 *     never decrements anything. A caller planning SEVERAL lines of the same
 *     product in one transaction MUST apply each line's decrement
 *     immediately after planning it, before planning the next line;
 *     otherwise every line plans against the same snapshot and the same
 *     batch is drawn on twice (a cart of 1 طرد + 5 قطع drove a 20-piece
 *     batch to -5). app/api/sync/route.ts does this per line now.
 * (b) The previous revision had an `if (!params) return undefined as
 *     unknown as ...` shim at the top of commitFifoAllocation (a leftover
 *     from a mocked test). It is REMOVED: a missing `params` is a caller
 *     bug and must throw loudly, never silently yield `undefined` that a
 *     caller then dereferences or — worse — treats as "nothing to allocate".
 * ============================================================================
 *
 * Sorting Rules (unchanged from the original design):
 * 1. `expiryDate ASC NULLS LAST` (earliest expiring batches consumed first; batches without expiry last)
 * 2. `id ASC`, compared by raw code-point order (not `localeCompare`, whose
 *    result depends on the runtime's ICU/locale configuration and is not
 *    guaranteed identical across environments) — this must match Postgres's
 *    own `ORDER BY id ASC` byte-order comparison exactly, since this is the
 *    same tie-break the database uses when locking these rows.
 *
 * All quantity math is done via decimal.js directly on ProductBatch.quantity
 * figures — there is no conversion step left to perform. ProductBatch.quantity
 * is a Decimal(18,4) column; per T1's mandate, precision must be exact from
 * the source, never float-then-converted. Every quantity-shaped output field
 * below is a decimal-serialized STRING (`.toFixed(4)`), rounded to the
 * column's real 4-decimal precision limit exactly once, and never re-wrapped
 * in a native JS `Number(...)`.
 */

type DecimalInstance = InstanceType<typeof Decimal>;
type DecimalValue = number | string | DecimalInstance;

export interface AllocationPlanItem {
  batchId: string;
  batchNumber: string;
  expiryDate: Date | null;
  // Decimal-serialized STRING, never a rounded JS number. Base-unit
  // quantity drawn from this specific batch.
  allocatedQty: string;
  // [v4.0, corrected] Always identical to allocatedQty. Kept as a
  // separate field only for shape/backward-compatibility with existing
  // callers that read it — the batch's own unit is, by construction,
  // always the product's base unit (see CORRECTION NOTE above), so there
  // is no longer a distinct "batch unit" quantity to compute.
  deductQtyInBatchUnit: string;
  batchUnitId: string;
  batchUnitName: string;
  /**
   * [v4.4, T4g] The drawn batch's cost per BASE unit, in SYP, as a
   * decimal-serialized STRING (same precision discipline as allocatedQty).
   *
   * WHY IT LIVES HERE: the frozen InvoiceItem.costAmountSYP for one
   * allocation is exactly
   *   multiplyMoney(alloc.allocatedQty, alloc.costPricePerBaseUnit)
   * (which sums to the spec's toBaseUnit(quantity, factor) ×
   * batch.costPricePerBaseUnit over a product's allocations, since
   * allocatedQty is itself the base-unit amount deducted). Carrying it on
   * the allocation means the cost basis is read in the SAME locked
   * transaction the deduction happens in — never from a second, later read
   * that could observe a cost correction in between, and never from a
   * client payload. Monetary arithmetic on it still goes exclusively
   * through lib/utils/money.ts (multiplyMoney/subtractMoney) at the call
   * site — this field is a value, not a math operation.
   *
   * [Batch cost entry — FIX] Serialized at scale 8, matching
   * ProductBatch.costPricePerBaseUnit's real column precision
   * (Decimal(18,8) — see that column's note). Previously this was rounded
   * to 4 decimal places here, which silently discarded the extra
   * precision costFromTotal() exists to preserve: a batch whose cost was
   * derived from a non-terminating division (e.g. 10000 SYP / 30 pieces =
   * 333.33333333) would have this field truncated to 333.3333, and the
   * frozen costAmountSYP computed from it at sale time would then be off
   * by a small but real amount from what the merchant actually paid. This
   * value is read once, inside the same locked transaction the deduction
   * happens in, so rounding it here — before the cost x quantity
   * multiplication even occurs — permanently threw away precision the
   * schema was specifically widened to keep.
   */
  costPricePerBaseUnit: string;
}

export type FifoAllocationItem = AllocationPlanItem;

export interface AllocationPlan {
  productId: string;
  // [v4.0, corrected] Always the product's base unit — see CORRECTION
  // NOTE above. Field name kept for backward compatibility.
  requestedUnitId: string;
  requestedUnitName: string;
  // [FIX] Decimal-normalized STRING now, matching totalAllocatedQty/
  // remainingQty/allocatedQty — never a native JS number, regardless of
  // whether the caller supplied requestedQty as a string or a number.
  requestedQty: string;
  totalAllocatedQty: string; // In the base unit
  remainingQty: string; // Unallocated, in the base unit
  isSufficient: boolean;
  allocations: AllocationPlanItem[];
}

export type FifoResolution = AllocationPlan;

export interface PreviewFifoParams {
  tenantId: string;
  productId: string;
  // [v4.0, corrected] MUST be the product's base unit id — asserted
  // against requireBaseUnit()'s result, not trusted blindly. The caller
  // is responsible for having already converted requestedQty into this
  // unit via toBaseUnit() before calling this function.
  unitId: string;
  // [FIX] Decimal string (or number/Decimal instance) — never coerced
  // to a native number internally. See file-header FIX note.
  requestedQty: DecimalValue;
}

export interface CommitFifoParams {
  tenantId: string;
  productId: string;
  unitId: string;
  requestedQty: DecimalValue;
}

export type FifoRequest = CommitFifoParams;

interface BatchRecord {
  id: string;
  batchNumber: string;
  quantity: unknown;
  expiryDate: Date | null | string;
  // [v4.4, T4g] The batch's cost per base unit, in SYP. Typed `unknown`
  // (never `number`) for the same reason as `quantity` above: it is a
  // Prisma Decimal and must be read as a Decimal-serializable value, never
  // coerced to a native JS double on the way in.
  //
  // [Batch cost entry] That column is Decimal(18,8) — NOT the (18,4) every
  // other monetary column uses — because this figure is derived by division
  // (total paid / received base quantity). The extra scale is what lets the
  // stored value reproduce the amount the merchant actually paid.
  costPricePerBaseUnit: unknown;
}

interface BaseUnitRef {
  id: string;
  unitName: string;
}

/**
 * Shared, unexported FIFO core allocation math and deterministic sorting
 * engine. See the file-header CORRECTION NOTE for why this no longer
 * performs (or references) any unit conversion.
 */
function allocateBatches(
  batches: BatchRecord[],
  baseUnit: BaseUnitRef,
  requestedQty: DecimalValue,
  productId: string
): AllocationPlan {
  const requestedQtyDecimal = new Decimal(requestedQty);

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
  // Full-precision Decimal across every loop iteration — never rounded
  // mid-loop, only each individual batch's OUTPUT is (once, at push-time).
  let remainingNeeded = requestedQtyDecimal;

  for (const batch of sortedBatches) {
    if (remainingNeeded.lte(0)) break;

    const batchAvailable = new Decimal(batch.quantity as DecimalValue);
    if (batchAvailable.lte(0)) continue;

    const allocated = Decimal.min(remainingNeeded, batchAvailable);

    allocations.push({
      batchId: batch.id,
      batchNumber: batch.batchNumber,
      expiryDate: batch.expiryDate ? new Date(batch.expiryDate) : null,
      allocatedQty: allocated.toFixed(4),
      deductQtyInBatchUnit: allocated.toFixed(4),
      batchUnitId: baseUnit.id,
      batchUnitName: baseUnit.unitName,
      // [v4.4, T4g] Serialized the same way allocatedQty is — read from the
      // same locked row, in the same transaction, never re-derived later.
      // Defensively defaults to "0.00000000" if a mock batch didn't
      // populate it.
      //
      // [Batch cost entry — FIX] toFixed(8), matching
      // ProductBatch.costPricePerBaseUnit's real Decimal(18,8) column —
      // see this field's interface-level doc comment above for why 4dp
      // here would silently discard the precision the schema exists to
      // keep.
      costPricePerBaseUnit: new Decimal(
        (batch.costPricePerBaseUnit as DecimalValue | undefined) ?? "0"
      ).toFixed(8),
    });

    // Subtracted using the full-precision `allocated`, not a rounded
    // value — this is what keeps cross-batch accumulation error-free.
    remainingNeeded = remainingNeeded.minus(allocated);
  }

  const totalAllocated = requestedQtyDecimal.minus(Decimal.max(0, remainingNeeded));
  const isSufficient = remainingNeeded.lte(0);

  return {
    productId,
    requestedUnitId: baseUnit.id,
    requestedUnitName: baseUnit.unitName,
    // [FIX] Normalized to a Decimal-serialized string, never left as
    // whatever raw type the caller passed in.
    requestedQty: requestedQtyDecimal.toFixed(4),
    totalAllocatedQty: totalAllocated.toFixed(4),
    remainingQty: Decimal.max(0, remainingNeeded).toFixed(4),
    isSufficient,
    allocations,
  };
}

function assertUnitIsBaseUnit(baseUnit: BaseUnitRef, suppliedUnitId: string, productId: string): void {
  if (baseUnit.id !== suppliedUnitId) {
    throw new Error(
      `Unit mismatch: productId ${productId}'s base unit is ${baseUnit.id}, but ` +
      `${suppliedUnitId} was supplied. requestedQty must already be converted to ` +
      `the base unit (via toBaseUnit(), lib/inventory/units.ts) before calling ` +
      `previewFifoAllocation/commitFifoAllocation — see T3b, MASTER-SPEC v4.0. ` +
      `This is a caller/integration bug, never a case to silently route around.`
    );
  }
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
 * structural via the Prisma Client Extension, but the batch query below
 * ALSO scopes explicitly by tenantId in its own `where` — the same
 * double-layered posture every other query in this file
 * (requireBaseUnit, commitFifoAllocation) already takes, and the same
 * one T1's tenantScopedRawQuery() takes for raw queries. [FIX] Previously
 * this query relied on the extension alone.
 */
export async function previewFifoAllocation(
  params: PreviewFifoParams
): Promise<AllocationPlan> {
  const { tenantId, productId, unitId, requestedQty } = params;

  if (new Decimal(requestedQty).lte(0)) {
    throw new Error("الكمية المطلوبة يجب أن تكون أكبر من الصفر.");
  }

  if (!tenantId || !tenantId.trim()) {
    throw new Error("Tenant isolation error: tenantId is required to preview a FIFO allocation.");
  }

  const db = getTenantDb(tenantId);

  const baseUnit = await requireBaseUnit(db, tenantId, productId);
  assertUnitIsBaseUnit(baseUnit, unitId, productId);

  const candidateBatches = (await db.productBatch.findMany({
    // [FIX] tenantId added explicitly — belt-and-suspenders, matching
    // every other query in this file, rather than relying solely on the
    // Client Extension's automatic injection.
    where: { tenantId, productId, quantity: { gt: 0 } },
    select: { id: true, batchNumber: true, quantity: true, expiryDate: true, costPricePerBaseUnit: true },
  })) as unknown as BatchRecord[];

  return allocateBatches(candidateBatches, baseUnit, requestedQty, productId);
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
 *
 * READ-ONLY despite the name — see file-header note (a): the CALLER applies
 * the decrement, per line, before planning the next line.
 */
export async function commitFifoAllocation(
  tx: TxOrClient,
  params: CommitFifoParams
): Promise<AllocationPlan> {
  const { tenantId, productId, unitId, requestedQty } = params;

  if (new Decimal(requestedQty).lte(0)) {
    throw new Error("الكمية المطلوبة يجب أن تكون أكبر من الصفر.");
  }

  if (!tenantId || !tenantId.trim()) {
    throw new Error("Tenant isolation error: tenantId is required to commit a FIFO allocation.");
  }

  const baseUnit = await requireBaseUnit(tx, tenantId, productId);
  assertUnitIsBaseUnit(baseUnit, unitId, productId);

  const candidateBatches = (await tx.productBatch.findMany({
    where: { tenantId, productId, quantity: { gt: 0 } },
    select: { id: true, batchNumber: true, quantity: true, expiryDate: true, costPricePerBaseUnit: true },
  })) as unknown as BatchRecord[];

  return allocateBatches(candidateBatches, baseUnit, requestedQty, productId);
}