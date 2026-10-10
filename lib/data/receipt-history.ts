/**
 * lib/data/receipt-history.ts — [v4.7, Phase 6] THE read-only data layer for
 * the goods-receiving history (list + detail with reconciliation). Mirror of
 * lib/data/invoices.ts's role for the sales log: pure tenant-scoped reads
 * here; every role/permission decision stays in the route handlers that call
 * this file (app/api/receipts/route.ts, app/api/receipts/[id]/route.ts).
 *
 * This file deliberately does NOT share a module with lib/data/receipts.ts —
 * that file's own header anticipated the split ("if this file keeps growing,
 * the receiving half is the one to move"): receipts.ts owns WRITES (the
 * receiving gateway + the PDF-URL race guard), this file owns READS.
 *
 * ── Cursor pagination: all THREE sort keys, encoded ──────────────────────
 * Ordering is `purchaseDate desc, createdAt desc, id desc` and the cursor
 * encodes the exact (purchaseDate, createdAt, id) triple of the page's last
 * row, base64url(JSON). Two receipts frequently share a purchaseDate (same
 * day) and can even share createdAt (one CSV commit), so a cursor carrying
 * fewer than all three keys positions the next page ambiguously — rows tied
 * on the shorter key would be skipped or duplicated. With the full triple the
 * keyset predicate is exact:
 *
 *     purchaseDate < c.pd
 *     OR (purchaseDate = c.pd AND createdAt < c.ca)
 *     OR (purchaseDate = c.pd AND createdAt = c.ca AND id < c.id)
 *
 * which is precisely "the row after the cursor" under (pd, ca, id) DESC.
 * Plain typed Prisma (no raw SQL — T1's $queryRaw ban), stable under new
 * receipts being inserted at the TOP of the list: a later page's window is
 * defined by values BELOW the cursor, never by offsets. No skip/offset
 * anywhere — offset pagination is what shifts under concurrent inserts.
 *
 * ── No N+1 ──────────────────────────────────────────────────────────────
 * The list page's per-receipt totals/counts come from ONE groupBy over
 * ProductBatch and ONE over BatchDeletionLog (restricted to the page's ids)
 * — never one query per receipt. The detail's reconciliation inputs are
 * fixed-cost reads regardless of line count: InvoiceItems grouped ONCE by
 * (batchId, unitId), StockAdjustments grouped ONCE by batchId,
 * CostPriceChangeLogs grouped ONCE by batchId, factors via units.ts's
 * getUnitConversionFactors() ONCE, names via lib/data/products.ts's
 * listProductNamesByIds()/listUnitNamesByIds() ONCE each. The groupBy calls
 * go through the same callGroupBy overload-narrowing helper as
 * lib/data/analytics.ts (why that helper exists: the tenant extension types
 * each delegate's groupBy as an incompatible union of generic overloads).
 *
 * ── No quantity/money math in this file ─────────────────────────────────
 *   - netSold: units.ts's netSoldInBaseUnit() (THE conversion site).
 *   - the identity: units.ts's reconciliationIdentityHolds() (EXACT decimal
 *     equality — no epsilon; a failure is a data-drift signal, not a display
 *     bug to be tolerated away).
 *   - the receipt total: money.ts's sumMoney() over LIVE line totals only.
 * Deleted lines (BatchDeletionLog) are shown for transparency but their cost
 * is EXCLUDED from the total — that stock never legitimately entered
 * inventory (schema.prisma's [v4.7] decisions block).
 * This file therefore never names `conversionFactor`, never constructs a
 * Decimal, and never touches a USD/exchange-rate column — all three pinned
 * by static source scans in the v4.7 Phase 6 test suite.
 *
 * PRODUCT_MODEL_RULES note: this file stays inside the ban (unlike
 * lib/data/invoices.ts, which has its own ESLint lift). Product/unit names
 * are fetched ONLY through lib/data/products.ts's gateway helpers; the one
 * relation it joins is `unit` (ProductBatch.unit), which the rule does not
 * cover — a unit display name is not the model-level product/productUnit
 * access the rule confines.
 */

import type { Prisma } from "@prisma/client";
import type { TxOrClient } from "@/lib/db/tenant-scope";
import {
  breakdownForDisplay,
  getUnitConversionFactors,
  netSoldInBaseUnit,
  reconciliationIdentityHolds,
  type DisplayUnit,
} from "@/lib/inventory/units";
import {
  listDisplayUnitsForProducts,
  listProductNamesByIds,
  listUnitNamesByIds,
} from "@/lib/data/products";
import { sumMoney } from "@/lib/utils/money";
import { businessDateToDbDate, formatDbDate, isRealCalendarDate } from "@/lib/inventory/date-utils";

// ============================================================================
// Cursor codec — see header. The cursor is opaque to clients (they echo it
// back verbatim); everything below validates it as untrusted input.
// ============================================================================

export class InvalidReceiptCursorError extends Error {
  readonly code = "INVALID_CURSOR";
  constructor() {
    super("مؤشر تصفح غير صالح — يرجى إعادة تحميل الصفحة.");
    this.name = "InvalidReceiptCursorError";
  }
}

/** The three sort keys of the last row of a page, in their storage shapes. */
export interface ReceiptCursorKeys {
  /** 'YYYY-MM-DD' — formatDbDate() of the @db.Date column (UTC midnight). */
  purchaseDate: string;
  /** ISO-8601 instant of createdAt. */
  createdAt: string;
  id: string;
}

const CURSOR_ID_MAX = 64;

export function encodeReceiptCursor(keys: ReceiptCursorKeys): string {
  return Buffer.from(JSON.stringify(keys), "utf8").toString("base64url");
}

/**
 * Decodes + fully validates a client-supplied cursor. ANY malformed,
 * truncated, or mis-typed payload throws InvalidReceiptCursorError — a bad
 * cursor is a 400 from the route, never a 500 and never a silently-unscoped
 * query (every decoded field is re-checked against its storage shape before
 * it can reach a `where`).
 */
export function decodeReceiptCursor(cursor: string): ReceiptCursorKeys {
  let parsed: unknown;
  try {
    const json = Buffer.from(cursor, "base64url").toString("utf8");
    parsed = JSON.parse(json);
  } catch {
    throw new InvalidReceiptCursorError();
  }
  if (typeof parsed !== "object" || parsed === null) throw new InvalidReceiptCursorError();

  const { purchaseDate, createdAt, id } = parsed as Record<string, unknown>;
  if (typeof purchaseDate !== "string" || !isRealCalendarDate(purchaseDate)) {
    throw new InvalidReceiptCursorError();
  }
  if (typeof createdAt !== "string" || Number.isNaN(new Date(createdAt).getTime())) {
    throw new InvalidReceiptCursorError();
  }
  if (typeof id !== "string" || id.length === 0 || id.length > CURSOR_ID_MAX) {
    throw new InvalidReceiptCursorError();
  }
  return { purchaseDate, createdAt, id };
}

/** The keyset `where` for "strictly after the cursor" under (pd, ca, id) DESC. */
function keysetWhere(keys: ReceiptCursorKeys): Prisma.ProductReceiptWhereInput {
  const purchaseDate = businessDateToDbDate(keys.purchaseDate);
  const createdAt = new Date(keys.createdAt);
  return {
    OR: [
      { purchaseDate: { lt: purchaseDate } },
      { purchaseDate, createdAt: { lt: createdAt } },
      { purchaseDate, createdAt, id: { lt: keys.id } },
    ],
  };
}

const RECEIPT_ORDER_BY = [
  { purchaseDate: "desc" },
  { createdAt: "desc" },
  { id: "desc" },
] as const;

// ============================================================================
// WHY this exact helper is duplicated (not imported) from lib/data/analytics.ts:
// callGroupBy is module-private there, and its whole body is a TYPE-level
// workaround (narrow a union of generic overloads to one call signature) with
// no runtime behaviour to share. Same rationale comment, same three lines.
// ============================================================================

function callGroupBy(groupFn: unknown, args: unknown): Promise<unknown> {
  return (groupFn as (a: unknown) => Promise<unknown>)(args);
}


// ============================================================================
// List
// ============================================================================

export const RECEIPT_LIST_MAX_LIMIT = 100;
export const RECEIPT_LIST_DEFAULT_LIMIT = 25;

export interface ReceiptListFilters {
  cursor?: string;
  limit?: number;
  /**
   * [Round B] Inclusive lower bound on `purchaseDate`, a business date
   * string ('YYYY-MM-DD') — the route validates it with isRealCalendarDate
   * before it gets here; this function only converts it with
   * businessDateToDbDate() (pure 'YYYY-MM-DD' → UTC-midnight @db.Date, no
   * zone arithmetic of its own).
   */
  from?: string;
  /** [Round B] Inclusive upper bound on `purchaseDate`, same shape. */
  to?: string;
  /**
   * [Round B] Case-insensitive partial match against ProductReceipt.
   * supplierName — a typed Prisma relational filter, never raw SQL.
   */
  supplierName?: string;
}

export interface ReceiptListRow {
  id: string;
  /** Raw @db.Date value — clients render it with formatDbDate(). */
  purchaseDate: Date;
  /** Raw timestamp — clients render it in Asia/Damascus. */
  createdAt: Date;
  supplierName: string | null;
  /** ProductReceipt.createdByUser.name — "who received". */
  receivedByName: string | null;
  /** Count of LIVE lines (ProductBatch rows on this receipt). */
  lineCount: number;
  /** Count of deleted lines (BatchDeletionLog rows) — excluded from the total. */
  deletedCount: number;
  /** Σ live totalCostSYP only, as a decimal string. */
  totalCostSYP: string;
}

export interface ReceiptListPage {
  items: ReceiptListRow[];
  nextCursor: string | null;
}

interface RawReceiptRow {
  id: string;
  purchaseDate: Date;
  createdAt: Date;
  supplierName: string | null;
  createdByUser: { name: string } | null;
}

interface RawReceiptTotalGroup {
  receiptId: string;
  _sum: { totalCostSYP: DecimalLike | null };
  _count: number;
}

interface RawReceiptCountGroup {
  receiptId: string;
  _count: number;
}

export async function listReceiptsForTenant(
  db: TxOrClient,
  tenantId: string,
  filters: ReceiptListFilters
): Promise<ReceiptListPage> {
  const limit = filters.limit ?? RECEIPT_LIST_DEFAULT_LIMIT;
  const cursorKeys = filters.cursor ? decodeReceiptCursor(filters.cursor) : null;

  // [Round B] Filters are plain typed-Prisma AND conditions alongside the
  // keyset predicate — the date window narrows the same index-backed scan
  // ((tenantId, purchaseDate)) the keyset walk runs over, and the supplier
  // match is a relational `contains`, not a raw query (T1). The cursor's
  // OR-group needs its own AND wrapper so it composes with the rest instead
  // of being flattened into the same object as the date bounds.
  const dateBounds: { gte?: Date; lte?: Date } = {};
  if (filters.from) dateBounds.gte = businessDateToDbDate(filters.from);
  if (filters.to) dateBounds.lte = businessDateToDbDate(filters.to);

  const raw = (await db.productReceipt.findMany({
    where: {
      tenantId,
      ...(Object.keys(dateBounds).length > 0 ? { purchaseDate: dateBounds } : {}),
      ...(filters.supplierName
        ? {
            supplierName: {
              contains: filters.supplierName,
              mode: "insensitive" as const,
            },
          }
        : {}),
      ...(cursorKeys ? { AND: [keysetWhere(cursorKeys)] } : {}),
    },
    orderBy: [...RECEIPT_ORDER_BY],
    // One extra row = "is there a next page?" without counting the table.
    take: limit + 1,
    select: {
      id: true,
      purchaseDate: true,
      createdAt: true,
      supplierName: true,
      createdByUser: { select: { name: true } },
    },
  })) as RawReceiptRow[];

  const hasMore = raw.length > limit;
  const page = raw.slice(0, limit);
  if (page.length === 0) return { items: [], nextCursor: null };

  // ONE groupBy per table for the WHOLE page — never one query per receipt.
  const pageIds = page.map((row) => row.id);
  const [totalGroups, deletedCountGroups] = (await Promise.all([
    callGroupBy(db.productBatch.groupBy, {
      by: ["receiptId"],
      where: { tenantId, receiptId: { in: pageIds } },
      _sum: { totalCostSYP: true },
      _count: true,
    }),
    callGroupBy(db.batchDeletionLog.groupBy, {
      by: ["receiptId"],
      where: { tenantId, receiptId: { in: pageIds } },
      _count: true,
    }),
  ])) as [RawReceiptTotalGroup[], RawReceiptCountGroup[]];

  const totalByReceipt = new Map<string, string>();
  const liveCountByReceipt = new Map<string, number>();
  for (const group of totalGroups) {
    totalByReceipt.set(group.receiptId, (group._sum.totalCostSYP ?? "0").toString());
    liveCountByReceipt.set(group.receiptId, group._count);
  }
  const deletedCountByReceipt = new Map<string, number>();
  for (const group of deletedCountGroups) {
    deletedCountByReceipt.set(group.receiptId, group._count);
  }

  const items: ReceiptListRow[] = page.map((row) => ({
    id: row.id,
    purchaseDate: row.purchaseDate,
    createdAt: row.createdAt,
    supplierName: row.supplierName,
    receivedByName: row.createdByUser?.name ?? null,
    lineCount: liveCountByReceipt.get(row.id) ?? 0,
    deletedCount: deletedCountByReceipt.get(row.id) ?? 0,
    totalCostSYP: totalByReceipt.get(row.id) ?? "0",
  }));

  const last = page[page.length - 1];
  return {
    items,
    nextCursor: hasMore
      ? encodeReceiptCursor({
          purchaseDate: formatDbDate(last.purchaseDate),
          createdAt: last.createdAt.toISOString(),
          id: last.id,
        })
      : null,
  };
}


// ============================================================================
// Detail — live lines + deleted lines + per-batch reconciliation
// ============================================================================

export interface ReceiptDetailLine {
  batchId: string;
  productId: string;
  productName: string;
  unitId: string;
  unitName: string;
  batchNumber: string;
  expiryDate: Date | null;
  createdAt: Date;
  /** Quantity received, base unit, frozen at creation (write-once). */
  initialQuantity: string;
  /** ProductBatch.quantity today — live, moves with sales/adjustments. */
  remaining: string;
  /** Σ all InvoiceItems converted to base unit (voids are negative → net out). */
  netSold: string;
  /** Σ StockAdjustment.quantityDelta for this batch. */
  adjustments: string;
  /**
   * Exact-decimal identity check — false flags quantity drift. Named
   * `reconciles` (spec) and NEVER hidden: the UI must surface false as a
   * visible warning, per schema.prisma's [v4.7] RECONCILIATION IDENTITY.
   */
  reconciles: boolean;
  /**
   * initialQuantity rendered in display units by units.ts's
   * breakdownForDisplay() (e.g. 240 base pieces → "10 كرتونة"), counts
   * serialized to strings. The decomposition arithmetic happens INSIDE
   * units.ts only — this file just reshapes its return value.
   */
  initialQuantityBreakdown: Array<{ unitId: string; unitName: string; count: string }>;
  /** Frozen total paid for this line — included in the receipt total. */
  totalCostSYP: string;
  costPricePerBaseUnit: string;
  /** True when a CostPriceChangeLog row exists (cost corrected later). */
  costAdjusted: boolean;
}

export interface DeletedReceiptLine {
  batchId: string;
  productId: string;
  productName: string;
  unitId: string;
  unitName: string;
  batchNumber: string;
  quantityAtDeletion: string;
  initialQuantityAtDeletion: string;
  totalCostAtDeletion: string;
  costPriceAtDeletion: string;
  reason: string;
  deletedByName: string | null;
  deletedAt: Date;
}

export interface ReceiptDetail {
  id: string;
  purchaseDate: Date;
  createdAt: Date;
  supplierName: string | null;
  receivedBy: { id: string; name: string };
  lines: ReceiptDetailLine[];
  /** Deleted lines: shown for transparency, NEVER counted in the total. */
  deletedLines: DeletedReceiptLine[];
  /** Σ live totalCostSYP only — deleted lines excluded by design. */
  totalCostSYP: string;
  liveLineCount: number;
  deletedLineCount: number;
}

/**
 * Structural stand-in for Prisma.Decimal (and the plain strings tests feed
 * it): every value here is only ever serialised with .toString() — no
 * arithmetic happens in this file (see header).
 */
type DecimalLike = { toString(): string };

interface RawLiveBatchRow {
  id: string;
  productId: string;
  unitId: string;
  batchNumber: string;
  expiryDate: Date | null;
  createdAt: Date;
  initialQuantity: DecimalLike;
  quantity: DecimalLike;
  totalCostSYP: DecimalLike;
  costPricePerBaseUnit: DecimalLike;
  unit: { unitName: string };
}

interface RawDeletedLogRow {
  batchId: string;
  productId: string;
  unitId: string;
  batchNumber: string;
  quantityAtDeletion: DecimalLike;
  initialQuantityAtDeletion: DecimalLike;
  totalCostAtDeletion: DecimalLike;
  costPriceAtDeletion: DecimalLike;
  reason: string;
  createdAt: Date;
  deletedByUser: { name: string } | null;
}

interface RawSoldGroup {
  batchId: string;
  unitId: string;
  _sum: { quantity: DecimalLike | null };
}

interface RawAdjustmentGroup {
  batchId: string;
  _sum: { quantityDelta: DecimalLike | null };
}

interface RawCostChangeGroup {
  batchId: string;
  _count: number;
}


export async function getReceiptDetail(
  db: TxOrClient,
  tenantId: string,
  receiptId: string
): Promise<ReceiptDetail | null> {
  const receipt = (await db.productReceipt.findFirst({
    where: { id: receiptId, tenantId },
    select: {
      id: true,
      purchaseDate: true,
      createdAt: true,
      supplierName: true,
      createdByUser: { select: { id: true, name: true } },
    },
  })) as {
    id: string;
    purchaseDate: Date;
    createdAt: Date;
    supplierName: string | null;
    createdByUser: { id: string; name: string } | null;
  } | null;

  // null → the route maps it to 404. Existence-in-tenant is exactly what a
  // tenant-scoped read may reveal; a foreign id must not distinguish
  // "exists elsewhere" from "does not exist".
  if (!receipt) return null;

  const [liveBatches, deletedRows] = (await Promise.all([
    db.productBatch.findMany({
      where: { tenantId, receiptId: receipt.id },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        productId: true,
        unitId: true,
        batchNumber: true,
        expiryDate: true,
        createdAt: true,
        initialQuantity: true,
        quantity: true,
        totalCostSYP: true,
        costPricePerBaseUnit: true,
        unit: { select: { unitName: true } },
      },
    }),
    db.batchDeletionLog.findMany({
      where: { tenantId, receiptId: receipt.id },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: {
        batchId: true,
        productId: true,
        unitId: true,
        batchNumber: true,
        quantityAtDeletion: true,
        initialQuantityAtDeletion: true,
        totalCostAtDeletion: true,
        costPriceAtDeletion: true,
        reason: true,
        createdAt: true,
        deletedByUser: { select: { name: true } },
      },
    }),
  ])) as [RawLiveBatchRow[], RawDeletedLogRow[]];

  const batchIds = liveBatches.map((batch) => batch.id);
  const unitIds = [
    ...new Set([
      ...liveBatches.map((batch) => batch.unitId),
      ...deletedRows.map((row) => row.unitId),
    ]),
  ];
  const productIds = [
    ...new Set([
      ...liveBatches.map((batch) => batch.productId),
      ...deletedRows.map((row) => row.productId),
    ]),
  ];

  // Fixed-cost fan-out: five grouped/batched reads — the same count whether
  // the receipt has 1 line or 100. No per-line query.
  const [soldGroups, adjustmentGroups, costChangeGroups, productNameById, unitNameById, displayUnitsByProduct] =
    (await Promise.all([
      callGroupBy(db.invoiceItem.groupBy, {
        by: ["batchId", "unitId"],
        where: { tenantId, batchId: { in: batchIds } },
        _sum: { quantity: true },
      }),
      callGroupBy(db.stockAdjustment.groupBy, {
        by: ["batchId"],
        where: { tenantId, batchId: { in: batchIds } },
        _sum: { quantityDelta: true },
      }),
      callGroupBy(db.costPriceChangeLog.groupBy, {
        by: ["batchId"],
        where: { tenantId, batchId: { in: batchIds } },
        _count: true,
      }),
      listProductNamesByIds(db, tenantId, productIds),
      listUnitNamesByIds(db, tenantId, unitIds),
      // [Round B] ONE findMany for every product on this receipt (through
      // the products gateway) — the unit sets breakdownForDisplay() needs
      // to render each live line's initialQuantity. Never one query per
      // line; the raw rows (and .conversionFactor) never leave products.ts.
      listDisplayUnitsForProducts(db, tenantId, productIds),
    ])) as [
      RawSoldGroup[],
      RawAdjustmentGroup[],
      RawCostChangeGroup[],
      Map<string, string>,
      Map<string, string>,
      Map<string, DisplayUnit[]>,
    ];

  // [Round B — FIX] netSoldInBaseUnit() converts InvoiceItem quantities
  // from the SOLD unit (packs, cartons — often NOT one of the batch's own
  // unit ids), so the factor map must include every unit the sale groups
  // reference. That set is only knowable AFTER the invoiceItem groupBy
  // above, which is why this read runs just after the parallel batch —
  // still ONE fixed-cost query per detail fetch (never per line), and a
  // genuinely missing factor still throws inside units.ts rather than
  // silently assuming 1.
  const factorByUnitId = await getUnitConversionFactors(db, tenantId, [
    ...unitIds,
    ...soldGroups.map((group) => group.unitId),
  ]);

  const soldByBatch = new Map<string, RawSoldGroup[]>();
  for (const group of soldGroups) {
    const list = soldByBatch.get(group.batchId);
    if (list) list.push(group);
    else soldByBatch.set(group.batchId, [group]);
  }
  const adjustmentsByBatch = new Map<string, string>();
  for (const group of adjustmentGroups) {
    adjustmentsByBatch.set(group.batchId, (group._sum.quantityDelta ?? "0").toString());
  }
  const costChangedBatches = new Set(costChangeGroups.map((group) => group.batchId));


  const lines: ReceiptDetailLine[] = liveBatches.map((batch) => {
    // Conversion happens ONLY inside units.ts (netSoldInBaseUnit) — the
    // groups below are pre-aggregated per (batchId, unitId), which is exact
    // because the factor is constant within a unit.
    const groups = soldByBatch.get(batch.id) ?? [];
    const netSold = netSoldInBaseUnit(
      groups.map((group) => ({
        unitId: group.unitId,
        quantity: (group._sum.quantity ?? "0").toString(),
      })),
      factorByUnitId
    ).toString();
    const adjustments = adjustmentsByBatch.get(batch.id) ?? "0";

    // [Round B] units.ts's breakdownForDisplay() decomposes the RECEIVED
    // quantity into the product's display units ("10 كرتونة"); counts are
    // serialized with .toString() only — no arithmetic happens in this file.
    const initialQuantityBreakdown = breakdownForDisplay(
      batch.initialQuantity.toString(),
      displayUnitsByProduct.get(batch.productId) ?? []
    ).map((entry) => ({
      unitId: entry.unitId,
      unitName: entry.unitName,
      count: entry.count.toString(),
    }));

    return {
      batchId: batch.id,
      productId: batch.productId,
      productName: productNameById.get(batch.productId) ?? "—",
      unitId: batch.unitId,
      unitName: batch.unit.unitName ?? unitNameById.get(batch.unitId) ?? "—",
      batchNumber: batch.batchNumber,
      expiryDate: batch.expiryDate,
      createdAt: batch.createdAt,
      initialQuantity: batch.initialQuantity.toString(),
      remaining: batch.quantity.toString(),
      netSold,
      adjustments,
      reconciles: reconciliationIdentityHolds({
        initialQuantity: batch.initialQuantity.toString(),
        netSold,
        adjustments,
        remaining: batch.quantity.toString(),
      }),
      initialQuantityBreakdown,
      totalCostSYP: batch.totalCostSYP.toString(),
      costPricePerBaseUnit: batch.costPricePerBaseUnit.toString(),
      costAdjusted: costChangedBatches.has(batch.id),
    };
  });

  const deletedLines: DeletedReceiptLine[] = deletedRows.map((row) => ({
    batchId: row.batchId,
    productId: row.productId,
    productName: productNameById.get(row.productId) ?? "—",
    unitId: row.unitId,
    unitName: unitNameById.get(row.unitId) ?? "—",
    batchNumber: row.batchNumber,
    quantityAtDeletion: row.quantityAtDeletion.toString(),
    initialQuantityAtDeletion: row.initialQuantityAtDeletion.toString(),
    totalCostAtDeletion: row.totalCostAtDeletion.toString(),
    costPriceAtDeletion: row.costPriceAtDeletion.toString(),
    reason: row.reason,
    deletedByName: row.deletedByUser?.name ?? null,
    deletedAt: row.createdAt,
  }));

  return {
    id: receipt.id,
    purchaseDate: receipt.purchaseDate,
    createdAt: receipt.createdAt,
    supplierName: receipt.supplierName,
    receivedBy: receipt.createdByUser ?? { id: "", name: "—" },
    lines,
    deletedLines,
    // Deleted lines are EXCLUDED: their stock never legitimately entered
    // inventory (schema.prisma [v4.7] decisions). sumMoney = money.ts's
    // sanctioned SYP accumulator — this is a monetary value.
    totalCostSYP: sumMoney(lines.map((line) => line.totalCostSYP)),
    liveLineCount: lines.length,
    deletedLineCount: deletedLines.length,
  };
}

