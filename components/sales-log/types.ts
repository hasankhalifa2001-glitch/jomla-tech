/**
 * components/sales-log/types.ts
 *
 * T4c2 — the wire DTOs for /dashboard/sales-log, mirroring
 * lib/data/invoices.ts's InvoiceLogRow / InvoiceDetail shapes exactly as
 * they arrive over JSON:
 *   - DateTime columns arrive as ISO strings (NextResponse.json serializes
 *     Date -> string), never as Date instances.
 *   - Every Decimal(18,4) money column arrives as a STRING and stays a
 *     string on this side too — never coerced to a JS number, per
 *     lib/utils/money.ts's rule that monetary values only ever pass
 *     through that module (formatMoney / compareMoney) for display and
 *     comparison.
 *
 * Nothing here re-derives anything the server already decided: the
 * payment-status badge and the status badge are both computed
 * server-side (see lib/data/invoices.ts's derivePaymentStatus and the
 * route's role scoping) and are rendered as-received.
 */

export type InvoiceStatusValue = "COMPLETED" | "PENDING_REVIEW" | "VOIDED";
export type PaymentStatusBadgeValue = "CASH_FULL" | "CREDIT_FULL" | "PARTIAL";

export interface InvoiceLogRow {
    id: string;
    createdAt: string;
    status: InvoiceStatusValue;
    totalSYP: string;
    // [v4.9] Nullable — null for SYP-only sales with no frozen rate.
    totalUSD: string | null;
    paidAmountSYP: string;
    exchangeRateUsed: string | null;
    paymentStatus: PaymentStatusBadgeValue;
    /** Set only when THIS row is itself a void — points at the original it reverses. */
    voidsInvoiceId: string | null;
    /** Set only when some OTHER invoice voids THIS one — the reverse side of the same self-relation. */
    voidedByInvoiceId: string | null;
    // [v6.2] true when at least one line carries a price override. A VOIDED
    // row copies the flag from its original, so a table that badges this must
    // skip rows whose status is VOIDED.
    hasPriceOverride: boolean;
    user: { id: string; name: string };
    customer: { id: string; name: string; isSystemGenerated: boolean };
}

export interface InvoiceLogPage {
    items: InvoiceLogRow[];
    nextCursor: string | null;
}

/** One batch's exact share of a collapsed sale line (base unit). */
export interface InvoiceDetailBatchShare {
    batchId: string;
    baseQuantity: string;
}

export interface InvoiceDetailItem {
    id: string;
    productId: string;
    productName: string;
    unitId: string;
    unitName: string;
    /** @deprecated First batch only — use `batches`. */
    batchId: string;
    /** [v4.8] Per-batch breakdown of the collapsed line (exact, base unit). */
    batches?: InvoiceDetailBatchShare[];
    /** Collapsed, exact quantity in the SOLD unit. Negative on a void line. */
    quantity: string;
    /** [v4.8] Σ baseQuantity of the collapsed rows, in the base unit. */
    baseQuantity?: string;
    unitPriceSYP: string;
    // [v4.9] Nullable per-line USD.
    unitPriceUSD: string | null;
    // [v6.2] Catalog price snapshot at sale time — null when sold at the
    // catalog price (no override). The per-unit discount is derived on read
    // as listUnitPriceSYP − unitPriceSYP.
    listUnitPriceSYP: string | null;
    /** unitPriceSYP × quantity, computed server-side via money.ts. */
    lineTotalSYP?: string;
    /** [v4.4, T4c2] ADMIN-only profit in SYP. Omitted for a CASHIER. */
    profitSYP?: string;
}

export interface InvoiceDetail {
    id: string;
    createdAt: string;
    status: InvoiceStatusValue;
    totalSYP: string;
    // [v4.9] Nullable USD + frozen rate — omitted from UI when null.
    totalUSD: string | null;
    exchangeRateUsed: string | null;
    paidAmountSYP: string;
    paidAmountUSD: string | null;
    debtAmountSYP: string;
    debtAmountUSD: string | null;
    receiptPdfUrl: string | null;
    voidReason: string | null;
    voidsInvoiceId: string | null;
    voidedByInvoiceId: string | null;
    userId: string;
    /**
     * Populated only when this invoice IS a void: the userId of the ORIGINAL
     * invoice it reverses. Lets a CASHIER open a void row via the cross-link
     * on their own sale (a void row's own userId is the voiding ADMIN), and
     * lets the detail view say who made the original sale.
     */
    originalInvoiceUserId: string | null;
    businessName: string | null;
    user: { id: string; name: string };
    customer: { id: string; name: string; phone: string | null };
    items: InvoiceDetailItem[];
    /** [v4.4, T4c2] ADMIN-only total invoice profit in SYP. Omitted for a CASHIER. */
    totalProfitSYP?: string;
}

/** Minimal shape consumed from the already-existing ADMIN-only GET /api/staff. */
export interface StaffOption {
    id: string;
    name: string;
    role: "ADMIN" | "CASHIER";
    isActive: boolean;
}