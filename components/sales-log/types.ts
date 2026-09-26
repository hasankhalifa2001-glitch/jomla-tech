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
    totalUSD: string;
    paidAmountSYP: string;
    exchangeRateUsed: string;
    paymentStatus: PaymentStatusBadgeValue;
    /** Set only when THIS row is itself a void — points at the original it reverses. */
    voidsInvoiceId: string | null;
    /** Set only when some OTHER invoice voids THIS one — the reverse side of the same self-relation. */
    voidedByInvoiceId: string | null;
    user: { id: string; name: string };
    customer: { id: string; name: string; isSystemGenerated: boolean };
}

export interface InvoiceLogPage {
    items: InvoiceLogRow[];
    nextCursor: string | null;
}

export interface InvoiceDetailItem {
    id: string;
    productId: string;
    productName: string;
    unitId: string;
    unitName: string;
    batchId: string;
    quantity: string;
    unitPriceSYP: string;
    unitPriceUSD: string;
}

export interface InvoiceDetail {
    id: string;
    createdAt: string;
    status: InvoiceStatusValue;
    totalSYP: string;
    totalUSD: string;
    exchangeRateUsed: string;
    paidAmountSYP: string;
    paidAmountUSD: string;
    debtAmountSYP: string;
    debtAmountUSD: string;
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
}

/** Minimal shape consumed from the already-existing ADMIN-only GET /api/staff. */
export interface StaffOption {
    id: string;
    name: string;
    role: "ADMIN" | "CASHIER";
    isActive: boolean;
}
