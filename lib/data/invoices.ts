/**
 * lib/data/invoices.ts
 *
 * T4c2 — Sales/Invoice History Log data-access layer. Mirrors
 * lib/data/products.ts's own convention: pure tenant-scoped reads here,
 * role/permission decisions stay in the route handlers that call this
 * file (see app/api/invoices/route.ts and app/api/invoices/[id]/route.ts).
 *
 * No schema change. Reads exclusively through the caller-supplied
 * tenant-scoped `db` (never a raw client) against the existing
 * (tenantId, createdAt) composite index on Invoice — no new index
 * required.
 *
 * NEVER reads .conversionFactor off any ProductUnit relation — this
 * screen only ever needs a unit's display name, so `unit` is
 * select-narrowed to { unitName } wherever an InvoiceItem's unit is
 * joined. See lib/inventory/units.ts's header for why that field has
 * exactly one sanctioned call site, which this file is not.
 *
 * Monetary comparisons (deriving the payment-status badge) go through
 * lib/utils/money.ts's compareMoney() — never raw decimal.js or native
 * number comparison — per that file's own scope note that every
 * SYP/USD comparison in the codebase must go through it.
 */

import type { InvoiceStatus, Prisma } from "@prisma/client";
import type { TxOrClient } from "@/lib/db/tenant-scope";
import { compareMoney } from "@/lib/utils/money";

export type PaymentStatusBadge = "CASH_FULL" | "CREDIT_FULL" | "PARTIAL";

function derivePaymentStatus(totalSYP: string, paidAmountSYP: string): PaymentStatusBadge {
    if (compareMoney(paidAmountSYP, totalSYP) === 0) return "CASH_FULL";
    if (compareMoney(paidAmountSYP, "0") === 0) return "CREDIT_FULL";
    return "PARTIAL";
}

export interface InvoiceLogFilters {
    from: Date;
    to: Date;
    status?: InvoiceStatus;
    paymentStatus?: PaymentStatusBadge;
    userId?: string;
    /** [v4.2] Case-insensitive partial match against Customer.name. */
    customerName?: string;
    cursor?: string;
    limit: number;
}

export interface InvoiceLogRow {
    id: string;
    createdAt: Date;
    status: InvoiceStatus;
    totalSYP: string;
    totalUSD: string;
    paidAmountSYP: string;
    exchangeRateUsed: string;
    paymentStatus: PaymentStatusBadge;
    voidsInvoiceId: string | null;
    voidedByInvoiceId: string | null;
    user: { id: string; name: string };
    customer: { id: string; name: string; isSystemGenerated: boolean };
}

export interface InvoiceLogPage {
    items: InvoiceLogRow[];
    nextCursor: string | null;
}

const INVOICE_LOG_SELECT = {
    id: true,
    createdAt: true,
    status: true,
    totalSYP: true,
    totalUSD: true,
    paidAmountSYP: true,
    exchangeRateUsed: true,
    voidsInvoiceId: true,
    voidedBy: { select: { id: true } },
    user: { select: { id: true, name: true } },
    customer: { select: { id: true, name: true, isSystemGenerated: true } },
} satisfies Prisma.InvoiceSelect;

type RawInvoiceLogRow = Prisma.InvoiceGetPayload<{ select: typeof INVOICE_LOG_SELECT }>;

function toLogRow(row: RawInvoiceLogRow): InvoiceLogRow {
    return {
        id: row.id,
        createdAt: row.createdAt,
        status: row.status,
        totalSYP: row.totalSYP.toString(),
        totalUSD: row.totalUSD.toString(),
        paidAmountSYP: row.paidAmountSYP.toString(),
        exchangeRateUsed: row.exchangeRateUsed.toString(),
        paymentStatus: derivePaymentStatus(row.totalSYP.toString(), row.paidAmountSYP.toString()),
        voidsInvoiceId: row.voidsInvoiceId,
        voidedByInvoiceId: row.voidedBy?.id ?? null,
        user: row.user,
        customer: row.customer,
    };
}

// A paymentStatus filter has no DB column to match against — it's derived
// by comparing two Decimal columns (paidAmountSYP vs totalSYP) in
// application code, and Prisma cannot express a field-to-field comparison
// in `where` without raw SQL. T1 restricts every raw query in this
// codebase to one sanctioned call site (T4c's batch lock), so this filter
// can never live in the `where` clause. Instead: pull batches larger than
// one page from the DB (ordered exactly like the unfiltered path), filter
// each batch in code, and keep pulling further batches until a full page
// is assembled or the table is exhausted. A single naive
// fetch-page-then-filter would silently return short or empty pages
// whenever few rows in a given DB page happen to match.
const BATCH_SIZE_MULTIPLIER = 3;
// Safety cap — bounds worst case (e.g. filtering for a payment status
// that matches almost none of a large date range) to a fixed number of
// DB round-trips per request instead of scanning unboundedly.
const MAX_SCAN_ROUNDS = 10;

export async function listInvoicesForTenant(
    db: TxOrClient,
    tenantId: string,
    filters: InvoiceLogFilters
): Promise<InvoiceLogPage> {
    const where: Prisma.InvoiceWhereInput = {
        tenantId,
        createdAt: { gte: filters.from, lte: filters.to },
        ...(filters.status && { status: filters.status }),
        ...(filters.userId && { userId: filters.userId }),
        // [v4.2] Relational filter — standard typed Prisma where, not raw SQL.
        ...(filters.customerName && {
            customer: { name: { contains: filters.customerName, mode: "insensitive" } },
        }),
    };

    if (!filters.paymentStatus) {
        const rows = await db.invoice.findMany({
            where,
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            take: filters.limit + 1,
            ...(filters.cursor && { cursor: { id: filters.cursor }, skip: 1 }),
            select: INVOICE_LOG_SELECT,
        });

        const hasMore = rows.length > filters.limit;
        const page = hasMore ? rows.slice(0, -1) : rows;
        return {
            items: page.map(toLogRow),
            nextCursor: hasMore ? page[page.length - 1].id : null,
        };
    }

    // --- paymentStatus filtering path ---
    const collected: RawInvoiceLogRow[] = [];
    let cursor = filters.cursor;
    let exhausted = false;
    let hitScanCap = false;

    for (let round = 0; round < MAX_SCAN_ROUNDS; round++) {
        const batchSize = filters.limit * BATCH_SIZE_MULTIPLIER;
        const batch = await db.invoice.findMany({
            where,
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            take: batchSize,
            ...(cursor && { cursor: { id: cursor }, skip: 1 }),
            select: INVOICE_LOG_SELECT,
        });

        if (batch.length === 0) {
            exhausted = true;
            break;
        }

        // [FIX — real bug] Previously moved `cursor` to the batch's last
        // row BEFORE scanning it, while the scan loop below could `break`
        // partway through the batch once enough matches were collected.
        // Any row after that early break — but still within this same,
        // already-fetched batch — was silently skipped from `collected`
        // AND never revisited, because `cursor` had already jumped past
        // it. A matching invoice sitting later in a large batch than
        // wherever the limit happened to be reached could vanish from
        // every page with no error, no warning, nothing — the exact
        // opposite of this function's own "never silently drop or
        // duplicate rows" guarantee.
        //
        // Fixed: scan the ENTIRE fetched batch every round, with no early
        // break, and only advance `cursor` to the batch's last row AFTER
        // that full scan completes. `cursor` now only ever points past
        // rows that have actually been examined.
        for (const row of batch) {
            if (derivePaymentStatus(row.totalSYP.toString(), row.paidAmountSYP.toString()) === filters.paymentStatus) {
                collected.push(row);
            }
        }
        cursor = batch[batch.length - 1].id;

        if (batch.length < batchSize) exhausted = true;
        if (collected.length >= filters.limit + 1 || exhausted) break;

        if (round === MAX_SCAN_ROUNDS - 1) hitScanCap = true;
    }

    const hasMore = collected.length > filters.limit || (hitScanCap && !exhausted);
    const page = collected.length > filters.limit ? collected.slice(0, -1) : collected;

    // [KNOWN LIMITATION] If the scan cap is hit before a full page is
    // assembled (a very sparse paymentStatus match over a wide date
    // range), we return whatever was collected and still expose
    // `cursor` (the DB scan position) as nextCursor rather than claiming
    // "no more results" — the client may see a short page and must keep
    // paging. This is a deliberate trade-off (never silently drop or
    // duplicate rows) rather than an unbounded per-request scan; not
    // expected to be hit at real merchant invoice volumes.
    return {
        items: page.map(toLogRow),
        nextCursor: hasMore ? cursor ?? null : null,
    };
}

// ---------------------------------------------------------------------
// findInvoiceDetail
//
// [CHANGED — T4c2 cross-link completeness] Now also resolves
// `originalInvoiceUserId`: the userId of the ORIGINAL invoice a void row
// reverses (null on a non-void row). The earlier revision declared the field
// on InvoiceDetail but never selected or populated it, which both failed the
// type-check and left a real hole: a void row's own userId is always the
// voiding ADMIN (T4d), so a CASHIER clicking the "أُلغيت بـ ..." cross-link on
// their OWN sale would be rejected by GET /api/invoices/[id]'s ownership
// check — making T4c2's "navigable from either side" guarantee false for
// exactly the user most likely to need it.
//
// [FIX — business name] `businessName` (Tenant.name) is now resolved in the
// same query, for receipt-model.ts's headerBlocks() — see that file's own
// [FIX — business name] note.
// ---------------------------------------------------------------------
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
    createdAt: Date;
    status: InvoiceStatus;
    totalSYP: string;
    totalUSD: string;
    exchangeRateUsed: string;
    paidAmountSYP: string;
    paidAmountUSD: string;
    debtAmountSYP: string;
    debtAmountUSD: string;
    /**
     * [T4f] The cached, server-generated receipt PDF for this invoice, if one
     * has ever been generated. Null until the FIRST share (see
     * lib/data/receipts.ts's cacheReceiptPdfOnce()) — so this field answers
     * "can I share an already-cached file without rendering anything?" and
     * never "may I share at all" (that is the sync-state gate, Rule 1).
     */
    receiptPdfUrl: string | null;
    voidReason: string | null;
    voidsInvoiceId: string | null;
    voidedByInvoiceId: string | null;
    userId: string;
    /**
     * Populated only when this row IS a void (voidsInvoiceId is
     * non-null): the userId of the ORIGINAL invoice being reversed —
     * the cashier/admin who made the sale, not the admin who executed
     * the void. A void row's own `userId` is always the voiding ADMIN
     * (T4d), never the original seller — without this, the void is
     * unreachable for the cashier whose own sale it reverses, breaking
     * T4c2's "navigable from either side" cross-link guarantee.
     */
    originalInvoiceUserId: string | null;
    user: { id: string; name: string };
    customer: { id: string; name: string; phone: string | null };
    items: InvoiceDetailItem[];
    /**
     * [FIX — business name] Tenant.name, resolved in this same query.
     * Feeds receipt-model.ts's headerBlocks() for a server-sourced receipt
     * (a synced invoice's thermal print, or the shared PDF raster).
     */
    businessName: string | null;
}

export async function findInvoiceDetail(
    db: TxOrClient,
    tenantId: string,
    invoiceId: string
): Promise<InvoiceDetail | null> {
    const invoice = await db.invoice.findUnique({
        where: { id: invoiceId, tenantId },
        select: {
            id: true, createdAt: true, status: true, totalSYP: true, totalUSD: true,
            exchangeRateUsed: true, paidAmountSYP: true, paidAmountUSD: true,
            debtAmountSYP: true, debtAmountUSD: true, voidReason: true, voidsInvoiceId: true,
            // [T4f] The cached receipt PDF URL, so the detail view can share an
            // already-generated file without rendering one again.
            receiptPdfUrl: true,
            // Only its userId is ever needed — see originalInvoiceUserId on
            // InvoiceDetail for why this relation is resolved at all.
            voidsInvoice: { select: { userId: true } },
            voidedBy: { select: { id: true } },
            // [NEW] Only the userId of the invoice THIS row voids, if
            // any — a single scalar field, resolved in the same query,
            // no extra round-trip.
            userId: true,
            user: { select: { id: true, name: true } },
            customer: { select: { id: true, name: true, phone: true } },
            // [FIX — business name]
            tenant: { select: { name: true } },
            items: {
                select: {
                    id: true, productId: true, product: { select: { name: true } },
                    unitId: true, unit: { select: { unitName: true } },
                    batchId: true, quantity: true, unitPriceSYP: true, unitPriceUSD: true,
                },
            },
        },
    });

    if (!invoice) return null;

    return {
        id: invoice.id,
        createdAt: invoice.createdAt,
        status: invoice.status,
        totalSYP: invoice.totalSYP.toString(),
        totalUSD: invoice.totalUSD.toString(),
        exchangeRateUsed: invoice.exchangeRateUsed.toString(),
        paidAmountSYP: invoice.paidAmountSYP.toString(),
        paidAmountUSD: invoice.paidAmountUSD.toString(),
        debtAmountSYP: invoice.debtAmountSYP.toString(),
        debtAmountUSD: invoice.debtAmountUSD.toString(),
        // [T4f]
        receiptPdfUrl: invoice.receiptPdfUrl,
        voidReason: invoice.voidReason,
        voidsInvoiceId: invoice.voidsInvoiceId,
        voidedByInvoiceId: invoice.voidedBy?.id ?? null,
        // [NEW]
        originalInvoiceUserId: invoice.voidsInvoice?.userId ?? null,
        userId: invoice.userId,
        user: invoice.user,
        customer: invoice.customer,
        // [FIX — business name]
        businessName: invoice.tenant.name,
        items: invoice.items.map((item) => ({
            id: item.id,
            productId: item.productId,
            productName: item.product.name,
            unitId: item.unitId,
            unitName: item.unit.unitName,
            batchId: item.batchId,
            quantity: item.quantity.toString(),
            unitPriceSYP: item.unitPriceSYP.toString(),
            unitPriceUSD: item.unitPriceUSD.toString(),
        })),
    };
}

/**
 * [T4f / T4c2] Shared ownership check for viewing / printing / sharing an invoice.
 *
 * Rules:
 * - ADMIN: unrestricted access across the tenant.
 * - CASHIER: allowed if they created the invoice (invoice.userId === sessionUser.id),
 *   OR if this invoice is a VOID that reverses their own original sale
 *   (invoice.originalInvoiceUserId === sessionUser.id).
 * - Any other case is forbidden (403).
 */
export function canSessionUserAccessInvoice(
    sessionUser: { id: string; role: string },
    invoice: { userId: string; originalInvoiceUserId: string | null }
): boolean {
    if (sessionUser.role !== "CASHIER") return true;
    return (
        invoice.userId === sessionUser.id ||
        invoice.originalInvoiceUserId === sessionUser.id
    );
}

export interface InvoiceAccessRow {
    id: string;
    userId: string;
    originalInvoiceUserId: string | null;
    status: InvoiceStatus;
    receiptPdfUrl: string | null;
}

/**
 * Lightweight access check query used by receipt generation / status check routes
 * that do not require loading all InvoiceItems.
 */
export async function findInvoiceAccessRow(
    db: TxOrClient,
    tenantId: string,
    invoiceId: string
): Promise<InvoiceAccessRow | null> {
    const invoice = await db.invoice.findUnique({
        where: { id: invoiceId, tenantId },
        select: {
            id: true,
            userId: true,
            status: true,
            receiptPdfUrl: true,
            voidsInvoice: { select: { userId: true } },
        },
    });

    if (!invoice) return null;

    return {
        id: invoice.id,
        userId: invoice.userId,
        status: invoice.status,
        receiptPdfUrl: invoice.receiptPdfUrl,
        originalInvoiceUserId: invoice.voidsInvoice?.userId ?? null,
    };
}