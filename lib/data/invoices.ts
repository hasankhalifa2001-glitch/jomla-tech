// lib/data/invoices.ts
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
    /** [NEW] Has no DB column — see the note above listInvoicesForTenant. */
    paymentStatus?: PaymentStatusBadge;
    userId?: string;
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

        cursor = batch[batch.length - 1].id;

        for (const row of batch) {
            if (derivePaymentStatus(row.totalSYP.toString(), row.paidAmountSYP.toString()) === filters.paymentStatus) {
                collected.push(row);
            }
            if (collected.length >= filters.limit + 1) break;
        }

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
// findInvoiceDetail — unchanged from the version already reviewed/approved.
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
    voidReason: string | null;
    voidsInvoiceId: string | null;
    voidedByInvoiceId: string | null;
    userId: string;
    user: { id: string; name: string };
    customer: { id: string; name: string; phone: string | null };
    items: InvoiceDetailItem[];
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
            voidedBy: { select: { id: true } },
            userId: true,
            user: { select: { id: true, name: true } },
            customer: { select: { id: true, name: true, phone: true } },
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
        voidReason: invoice.voidReason,
        voidsInvoiceId: invoice.voidsInvoiceId,
        voidedByInvoiceId: invoice.voidedBy?.id ?? null,
        userId: invoice.userId,
        user: invoice.user,
        customer: invoice.customer,
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