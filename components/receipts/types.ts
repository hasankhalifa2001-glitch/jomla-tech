/**
 * components/receipts/types.ts
 *
 * v4.7 Phase 7 — serialized DTOs for the goods-receiving history, exactly as
 * GET /api/receipts and GET /api/receipts/[id] return them (Date columns
 * arrive as JSON ISO strings). Structural twins of the server interfaces in
 * lib/data/receipt-history.ts — kept as separate declarations (rather than
 * importing them) so components/receipts/** never pulls the backend data
 * layer, Prisma types, or lib/db into the client bundle. The same posture
 * components/sales-log/types.ts takes toward lib/data/invoices.ts.
 */

export interface ReceiptListRow {
  id: string;
  /** ISO string of a @db.Date (UTC midnight) — render with formatDbDate(). */
  purchaseDate: string;
  /** ISO timestamp — render in Asia/Damascus (receipts-utils.ts). */
  createdAt: string;
  supplierName: string | null;
  receivedByName: string | null;
  /** LIVE line count (surviving ProductBatch rows). */
  lineCount: number;
  /** Deleted line count — excluded from totalCostSYP. */
  deletedCount: number;
  /** Σ live totalCostSYP only, decimal string. */
  totalCostSYP: string;
}

export interface ReceiptListPage {
  items: ReceiptListRow[];
  nextCursor: string | null;
}

export interface ReceiptDetailLine {
  batchId: string;
  productId: string;
  productName: string;
  unitId: string;
  unitName: string;
  batchNumber: string;
  expiryDate: string | null;
  createdAt: string;
  initialQuantity: string;
  /** ProductBatch.quantity today — the "متبقي" figure. */
  remaining: string;
  netSold: string;
  adjustments: string;
  /**
   * Exact-decimal identity check — false flags quantity drift and MUST be
   * rendered as a visible warning (never hidden), per schema.prisma [v4.7].
   */
  reconciles: boolean;
  /** initialQuantity in display units, e.g. [{ unitName: "كرتونة", count: "10" }]. */
  initialQuantityBreakdown: Array<{ unitId: string; unitName: string; count: string }>;
  totalCostSYP: string;
  costPricePerBaseUnit: string;
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
  deletedAt: string;
}

export interface ReceiptDetail {
  id: string;
  purchaseDate: string;
  createdAt: string;
  supplierName: string | null;
  receivedBy: { id: string; name: string };
  lines: ReceiptDetailLine[];
  deletedLines: DeletedReceiptLine[];
  /** Σ live line totals only — deleted lines excluded by design. */
  totalCostSYP: string;
  liveLineCount: number;
  deletedLineCount: number;
}

/** Shape of GET /api/receipts/defaults (Round A). */
export interface ReceivingDefaults {
  businessDate: string;
  minDate: string;
}

/**
 * What the header edit dialog operates on: the id plus the ONLY two fields
 * PATCH /api/receipts/[id] accepts (schema.prisma [v4.7]: descriptive
 * metadata only — financial fields are frozen).
 */
export interface EditTarget {
  id: string;
  /** ISO string of the receipt's current @db.Date purchaseDate. */
  purchaseDate: string;
  supplierName: string | null;
}
