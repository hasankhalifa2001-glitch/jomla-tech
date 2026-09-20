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

// ----------------------------------------------------------------------------
// Listing (the sales-log screen's main table)
// ----------------------------------------------------------------------------

export interface InvoiceLogFilters {
    from: Date;
    to: Date;
    status?: InvoiceStatus;
    /** Already resolved by the ROUTE per T2b's Role Capability Matrix —
     * a CASHIER's own id if the caller is a CASHIER, an arbitrary staff
     * id only if the caller is an ADMIN who passed one, or undefined for
     * "every staff member" (ADMIN, no filter). This file trusts whatever
     * value it is given — it enforces no role logic itself. */
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
    /** Set only when THIS row is itself a void — points at the original
     * invoice it reverses. */
    voidsInvoiceId: string | null;
    /** Set only when some OTHER invoice voids THIS one — the reverse
     * side of the same self-relation (Invoice.voidedBy in schema.prisma). */
    voidedByInvoiceId: string | null;
    user: { id: string; name: string };
    customer: { id: string; name: string; isSystemGenerated: boolean };
}

export interface InvoiceLogPage {
    items: InvoiceLogRow[];
    nextCursor: string | null;
}

/**
 * Tenant-wide, chronological invoice listing. Cursor pagination via `id`,
 * with orderBy (createdAt desc, id desc) so pagination stays stable even
 * when two invoices share the exact same createdAt millisecond (possible
 * under concurrent T4c sync commits) — Prisma's cursor pagination only
 * needs `id` to identify a unique row to skip past; it does not require
 * the cursor field to be part of orderBy itself.
 */
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

    const rows = await db.invoice.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: filters.limit + 1,
        ...(filters.cursor && { cursor: { id: filters.cursor }, skip: 1 }),
        select: {
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
        },
    });

    const hasMore = rows.length > filters.limit;
    const page = hasMore ? rows.slice(0, -1) : rows;

    const items: InvoiceLogRow[] = page.map((row) => ({
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
    }));

    return {
        items,
        nextCursor: hasMore ? page[page.length - 1].id : null,
    };
}

// ----------------------------------------------------------------------------
// Single-invoice detail (line items)
// ----------------------------------------------------------------------------

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
    /** Needed by the calling route for the CASHIER-own-invoices-only
     * check — this file does not enforce that check itself. */
    userId: string;
    user: { id: string; name: string };
    customer: { id: string; name: string; phone: string | null };
    items: InvoiceDetailItem[];
}

/**
 * Single-invoice detail including every line item. `unit` is
 * select-narrowed to `{ unitName }` only, `product` to `{ name }` only —
 * this screen never reads conversionFactor, pricingCurrency, or any
 * other ProductUnit field it has no legitimate use for.
 */
export async function findInvoiceDetail(
    db: TxOrClient,
    tenantId: string,
    invoiceId: string
): Promise<InvoiceDetail | null> {
    const invoice = await db.invoice.findUnique({
        where: { id: invoiceId, tenantId },
        select: {
            id: true,
            createdAt: true,
            status: true,
            totalSYP: true,
            totalUSD: true,
            exchangeRateUsed: true,
            paidAmountSYP: true,
            paidAmountUSD: true,
            debtAmountSYP: true,
            debtAmountUSD: true,
            voidReason: true,
            voidsInvoiceId: true,
            voidedBy: { select: { id: true } },
            userId: true,
            user: { select: { id: true, name: true } },
            customer: { select: { id: true, name: true, phone: true } },
            items: {
                select: {
                    id: true,
                    productId: true,
                    product: { select: { name: true } },
                    unitId: true,
                    unit: { select: { unitName: true } },
                    batchId: true,
                    quantity: true,
                    unitPriceSYP: true,
                    unitPriceUSD: true,
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