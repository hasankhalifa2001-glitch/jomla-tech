/**
 * lib/data/orders.ts
 *
 * T5b — admin/cashier-facing B2B orders gateway (queue + detail + reject).
 * All reads/writes go through the caller-supplied tenant-scoped client.
 * product/productUnit via lib/data/products.ts helpers only; conversion
 * arithmetic ONLY in lib/inventory/units.ts; stock via
 * lib/data/stock-availability.ts. Money via lib/utils/money.ts only.
 * Payloads carry no financial internals, no stock internals, and no
 * credential fields; the reviewer is exposed as a name only.
 */

import type { B2BOrderStatus, Prisma } from "@prisma/client";
import type { TxOrClient } from "@/lib/db/tenant-scope";
import {
    listProductNamesByIds,
    listUnitNamesByIds,
    listUnitConversionFactors,
} from "@/lib/data/products";
import { loadAvailableBaseQuantities } from "@/lib/data/stock-availability";
import { toBaseUnit, fromBaseUnit } from "@/lib/inventory/units";
import { compareMoney, multiplyMoney, sumMoney } from "@/lib/utils/money";
import { normalizePhone, foldArabicDigits } from "@/lib/utils/phone";
import { orderReference } from "@/lib/utils/order-reference";

export const ORDERS_PAGE_SIZE = 25;
export const ORDERS_MAX_SEARCH_LENGTH = 100;
const MAX_CURSOR_ID_LENGTH = 64;
/** Pre-filter cap for candidate-customer matching (never load a whole table). */
const CANDIDATE_PREFILTER_CAP = 50;

export type OrdersListStatus = B2BOrderStatus;

export class InvalidOrderCursorError extends Error {
    constructor() {
        super("رمز المتابعة غير صالح.");
        this.name = "InvalidOrderCursorError";
    }
}

export class OrderNotFoundError extends Error {
    constructor() {
        super("الطلب غير موجود.");
        this.name = "OrderNotFoundError";
    }
}

export class OrderAlreadyReviewedError extends Error {
    constructor() {
        super("تمت مراجعة هذا الطلب مسبقاً.");
        this.name = "OrderAlreadyReviewedError";
    }
}

/** Typed validation error for the reject reason (no string matching needed). */
export class InvalidRejectReasonError extends Error {
    constructor() {
        super("سبب الرفض مطلوب (3–500 حرف).");
        this.name = "InvalidRejectReasonError";
    }
}

/** Opaque cursor carrying BOTH sort keys (createdAt + id). Untrusted input. */
export function encodeOrderCursor(createdAtIso: string, id: string): string {
    return Buffer.from(JSON.stringify({ c: createdAtIso, i: id }), "utf-8").toString("base64url");
}

export function decodeOrderCursor(cursor: string): { createdAtMs: number; id: string } {
    let parsed: unknown;
    try {
        parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf-8"));
    } catch {
        throw new InvalidOrderCursorError();
    }
    if (
        typeof parsed !== "object" ||
        parsed === null ||
        typeof (parsed as { c?: unknown }).c !== "string" ||
        typeof (parsed as { i?: unknown }).i !== "string"
    ) {
        throw new InvalidOrderCursorError();
    }
    const ms = Date.parse((parsed as { c: string }).c);
    if (Number.isNaN(ms)) throw new InvalidOrderCursorError();
    const id = (parsed as { i: string }).i;
    if (!id || id.length > MAX_CURSOR_ID_LENGTH) throw new InvalidOrderCursorError();
    return { createdAtMs: ms, id };
}

function requireTenantId(tenantId: string, fn: string): void {
    if (!tenantId || typeof tenantId !== "string" || !tenantId.trim()) {
        throw new Error(`lib/data/orders.ts: ${fn}() requires a non-empty tenantId.`);
    }
}

function decimalToString(value: unknown): string {
    if (value == null) return "0";
    if (typeof value === "string") return value;
    if (typeof value === "number") return String(value);
    if (typeof value === "object" && "toString" in (value as object)) {
        return String((value as { toString(): string }).toString());
    }
    return String(value);
}

/** Arabic-Indic / Persian digits → ASCII (used for phone and reference search). */
// function toAsciiDigits(input: string): string {
//     return input
//         .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
//         .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
// }

export interface OrderListRow {
    id: string;
    orderRef: string;
    retailerName: string;
    retailerPhone: string;
    retailerShopName: string | null;
    createdAt: Date;
    status: OrdersListStatus;
    lineCount: number;
    totalSYP: string;
    totalUSD: string;
    resultingInvoiceId: string | null;
}

export interface OrdersListPage {
    items: OrderListRow[];
    nextCursor: string | null;
    pendingCount: number;
}

type OrderHeaderRow = {
    id: string;
    retailerName: string;
    retailerPhone: string;
    retailerShopName: string | null;
    status: OrdersListStatus;
    createdAt: Date;
    resultingInvoiceId: string | null;
};

type OrderItemRow = {
    orderRequestId: string;
    quantity: unknown;
    approvedQuantity: unknown | null;
    priceWholesaleSnapshot: unknown;
    pricingCurrencySnapshot: "SYP" | "USD";
};

function itemQty(status: OrdersListStatus, item: OrderItemRow): string {
    if (status === "APPROVED" && item.approvedQuantity != null) {
        return decimalToString(item.approvedQuantity);
    }
    return decimalToString(item.quantity);
}

/**
 * Queue: newest-first, cursor-paginated.
 *
 * SEARCH LIMITATION (documented on purpose): name/shop search uses Prisma
 * `contains` with mode "insensitive" and NO Arabic folding (tashkeel, alef
 * variants, ta-marbuta are NOT normalized) — raw SQL is forbidden and the
 * database cannot fold Arabic. Phone and reference search convert Arabic-Indic
 * digits to ASCII first.
 */
export async function listOrders(
    db: TxOrClient,
    tenantId: string,
    options: { status: OrdersListStatus; q?: string; cursor?: string; limit?: number }
): Promise<OrdersListPage> {
    requireTenantId(tenantId, "listOrders");
    const { status } = options;
    const limit = options.limit ?? ORDERS_PAGE_SIZE;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new Error("lib/data/orders.ts: listOrders() requires 1 <= limit <= 100.");
    }
    let cursorKey: { createdAtMs: number; id: string } | null = null;
    if (options.cursor) cursorKey = decodeOrderCursor(options.cursor);

    const q = (options.q ?? "").trim().slice(0, ORDERS_MAX_SEARCH_LENGTH);
    const where: Prisma.B2BOrderRequestWhereInput = { tenantId, status };

    if (q) {
        const qAscii = foldArabicDigits(q);
        const ors: Prisma.B2BOrderRequestWhereInput[] = [
            { retailerName: { contains: q, mode: "insensitive" } },
            { retailerShopName: { contains: q, mode: "insensitive" } },
        ];
        const normalized = normalizePhone(qAscii);
        if (normalized) {
            ors.push({ retailerPhone: normalized });
        } else {
            const digits = qAscii.replace(/\D/g, "");
            if (digits) ors.push({ retailerPhone: { contains: digits } });
        }
        if (/^[0-9a-zA-Z]{6}$/.test(qAscii)) {
            ors.push({ id: { endsWith: qAscii, mode: "insensitive" } });
        }
        where.OR = ors;
    }
    if (cursorKey) {
        where.AND = [
            {
                OR: [
                    { createdAt: { lt: new Date(cursorKey.createdAtMs) } },
                    { createdAt: new Date(cursorKey.createdAtMs), id: { lt: cursorKey.id } },
                ],
            },
        ];
    }

    const [rows, pendingCount] = await Promise.all([
        db.b2BOrderRequest.findMany({
            where,
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            take: limit + 1,
            select: {
                id: true, retailerName: true, retailerPhone: true,
                retailerShopName: true, status: true, createdAt: true,
                resultingInvoiceId: true,
            },
        }) as Promise<OrderHeaderRow[]>,
        db.b2BOrderRequest.count({ where: { tenantId, status: "PENDING_REVIEW" } }),
    ]);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1] ?? null;
    const nextCursor = hasMore && last
        ? encodeOrderCursor(last.createdAt.toISOString(), last.id) : null;

    const pageIds = page.map((r) => r.id);
    const itemsByOrder = new Map<string, OrderItemRow[]>();
    if (pageIds.length > 0) {
        const items = (await db.b2BOrderRequestItem.findMany({
            where: { tenantId, orderRequestId: { in: pageIds } },
            select: {
                orderRequestId: true, quantity: true, approvedQuantity: true,
                priceWholesaleSnapshot: true, pricingCurrencySnapshot: true,
            },
        })) as OrderItemRow[];
        for (const item of items) {
            const list = itemsByOrder.get(item.orderRequestId);
            if (list) list.push(item);
            else itemsByOrder.set(item.orderRequestId, [item]);
        }
    }

    const result: OrderListRow[] = page.map((row) => {
        const lines = itemsByOrder.get(row.id) ?? [];
        const syp: string[] = [];
        const usd: string[] = [];
        for (const line of lines) {
            const v = multiplyMoney(
                decimalToString(line.priceWholesaleSnapshot),
                itemQty(row.status, line)
            );
            if (line.pricingCurrencySnapshot === "USD") usd.push(v);
            else syp.push(v);
        }
        return {
            id: row.id, orderRef: orderReference(row.id),
            retailerName: row.retailerName, retailerPhone: row.retailerPhone,
            retailerShopName: row.retailerShopName, createdAt: row.createdAt,
            status: row.status, lineCount: lines.length,
            totalSYP: sumMoney(syp), totalUSD: sumMoney(usd),
            resultingInvoiceId: row.status === "APPROVED" ? row.resultingInvoiceId : null,
        };
    });
    return { items: result, nextCursor, pendingCount };
}

export interface OrderDetailLine {
    id: string;
    productId: string;
    productName: string;
    unitId: string;
    unitName: string;
    quantity: string;
    approvedQuantity: string | null;
    priceWholesaleSnapshot: string;
    pricingCurrencySnapshot: "SYP" | "USD";
    /**
     * Live availability in THIS line's unit, or null when it cannot be
     * determined (unit factor missing or conversion failed). null means
     * "unknown" — the UI must NOT show it as 0.
     */
    availableInUnit: string | null;
    /**
     * Informational warning only. True when the TOTAL requested for this
     * product (all its lines, any unit, in base units) exceeds available stock.
     * False when unknown.
     */
    exceedsAvailability: boolean;
}

export interface RetailerSignal {
    hasPriorApproval: boolean;
    verificationCount: number;
}

export interface CandidateCustomer {
    id: string;
    name: string;
    phone: string;
    shopName: string | null;
}

export interface OrderDetail {
    id: string;
    orderRef: string;
    retailerName: string;
    retailerPhone: string;
    retailerShopName: string | null;
    status: OrdersListStatus;
    createdAt: Date;
    reviewedAt: Date | null;
    reviewedByUserName: string | null;
    rejectionReason: string | null;
    resultingInvoiceId: string | null;
    lines: OrderDetailLine[];
    signal: RetailerSignal;
    otherPendingCount: number;
    matchedCustomer: CandidateCustomer | null;
    candidates: CandidateCustomer[];
}

const UNKNOWN_PRODUCT_NAME = "منتج غير معروف";
const UNKNOWN_UNIT_NAME = "وحدة غير معروفة";

/** Platform-wide signal by normalized phone (no tenantId — model has none). */
export async function getRetailerSignal(
    db: TxOrClient,
    normalizedPhone: string
): Promise<RetailerSignal> {
    const row = await db.verifiedRetailer.findUnique({
        where: { phone: normalizedPhone },
        select: { verificationCount: true },
    });
    if (!row) return { hasPriorApproval: false, verificationCount: 0 };
    const count = typeof row.verificationCount === "number" ? row.verificationCount : 0;
    return { hasPriorApproval: true, verificationCount: count };
}

/**
 * ADMIN-only (D18) candidates. T5c reuses this exact function.
 *
 * LIMITATIONS (documented on purpose):
 *  - Customer.phone is stored as typed (never normalized), so the DB can only
 *    pre-filter with a plain `contains` on the LAST 3 DIGITS of the normalized
 *    retailer phone. A stored number that has spaces/dashes inside those last
 *    three digits (e.g. "0944 12 34 56") is NOT found by the pre-filter.
 *  - The pre-filter is capped at CANDIDATE_PREFILTER_CAP rows (deterministic
 *    order by id) so a tenant's whole customer table is never loaded. If the
 *    cap is hit, matches beyond it are not seen.
 * Exact equality is then checked in application code after normalizePhone().
 */
export async function findCandidateCustomersByPhone(
    db: TxOrClient,
    tenantId: string,
    normalizedPhone: string
): Promise<CandidateCustomer[]> {
    requireTenantId(tenantId, "findCandidateCustomersByPhone");
    const tail = normalizedPhone.replace(/\D/g, "").slice(-3);
    if (!tail) return [];
    const pre = await db.customer.findMany({
        where: { tenantId, phone: { contains: tail }, isActive: true, isSystemGenerated: false },
        select: { id: true, name: true, phone: true, shopName: true },
        orderBy: { id: "asc" },
        take: CANDIDATE_PREFILTER_CAP,
    });
    const out: CandidateCustomer[] = [];
    for (const row of pre) {
        const phone = row.phone ?? "";
        if (normalizePhone(phone) === normalizedPhone) {
            out.push({ id: row.id, name: row.name, phone, shopName: row.shopName ?? null });
        }
    }
    return out;
}

type DetailHeader = {
    id: string;
    retailerName: string;
    retailerPhone: string;
    retailerShopName: string | null;
    status: OrdersListStatus;
    createdAt: Date;
    reviewedAt: Date | null;
    rejectionReason: string | null;
    matchedCustomerId: string | null;
    resultingInvoiceId: string | null;
    reviewedByUser: { name: string } | null;
};

type DetailItem = {
    id: string;
    productId: string;
    unitId: string;
    quantity: unknown;
    approvedQuantity: unknown | null;
    priceWholesaleSnapshot: unknown;
    pricingCurrencySnapshot: "SYP" | "USD";
};

/** Detail read. Reviewer is a name only; candidates only when asked. */
export async function getOrderDetail(
    db: TxOrClient,
    tenantId: string,
    orderId: string,
    options: { includeCustomers: boolean }
): Promise<OrderDetail> {
    requireTenantId(tenantId, "getOrderDetail");
    if (!orderId || typeof orderId !== "string") throw new OrderNotFoundError();

    const header = (await db.b2BOrderRequest.findFirst({
        where: { id: orderId, tenantId },
        select: {
            id: true, retailerName: true, retailerPhone: true,
            retailerShopName: true, status: true, createdAt: true,
            reviewedAt: true, rejectionReason: true, matchedCustomerId: true,
            resultingInvoiceId: true,
            reviewedByUser: { select: { name: true } },
        },
    })) as DetailHeader | null;
    if (!header) throw new OrderNotFoundError();

    const items = (await db.b2BOrderRequestItem.findMany({
        where: { tenantId, orderRequestId: header.id },
        select: {
            id: true, productId: true, unitId: true, quantity: true,
            approvedQuantity: true, priceWholesaleSnapshot: true,
            pricingCurrencySnapshot: true,
        },
        orderBy: { id: "asc" },
    })) as DetailItem[];

    const productIds = [...new Set(items.map((i) => i.productId))];
    const unitIds = [...new Set(items.map((i) => i.unitId))];
    const [productNames, unitNames, factors, stockByProduct, signal, otherPendingCount] =
        await Promise.all([
            listProductNamesByIds(db, tenantId, productIds),
            listUnitNamesByIds(db, tenantId, unitIds),
            listUnitConversionFactors(db, tenantId, unitIds),
            loadAvailableBaseQuantities(db, tenantId, productIds),
            getRetailerSignal(db, header.retailerPhone),
            db.b2BOrderRequest.count({
                where: {
                    tenantId, retailerPhone: header.retailerPhone,
                    status: "PENDING_REVIEW", id: { not: header.id },
                },
            }),
        ]);

    // Requested quantity per line in BASE units (null = could not be converted),
    // plus the per-product list of those values so several lines of the same
    // product (different units) are compared against stock together.
    const lineBase = new Map<string, string | null>();
    const baseByProduct = new Map<string, string[]>();
    for (const item of items) {
        const factor = factors.get(item.unitId);
        let base: string | null = null;
        if (factor) {
            try {
                base = toBaseUnit(decimalToString(item.quantity), factor).toString();
            } catch {
                base = null;
            }
        }
        lineBase.set(item.id, base);
        if (base !== null) {
            const list = baseByProduct.get(item.productId);
            if (list) list.push(base);
            else baseByProduct.set(item.productId, [base]);
        }
    }

    const lines: OrderDetailLine[] = items.map((item) => {
        const factor = factors.get(item.unitId);
        const availableBase = stockByProduct.get(item.productId) ?? "0";

        let availableInUnit: string | null = null;
        if (factor) {
            try {
                availableInUnit = fromBaseUnit(availableBase, factor).toString();
            } catch {
                availableInUnit = null;
            }
        }

        let exceeds = false;
        if (lineBase.get(item.id) != null) {
            try {
                const totalRequested = sumMoney(baseByProduct.get(item.productId) ?? []);
                exceeds = compareMoney(totalRequested, availableBase) > 0;
            } catch {
                exceeds = false;
            }
        }

        return {
            id: item.id, productId: item.productId,
            productName: productNames.get(item.productId) ?? UNKNOWN_PRODUCT_NAME,
            unitId: item.unitId,
            unitName: unitNames.get(item.unitId) ?? UNKNOWN_UNIT_NAME,
            quantity: decimalToString(item.quantity),
            approvedQuantity: header.status === "APPROVED" && item.approvedQuantity != null
                ? decimalToString(item.approvedQuantity) : null,
            priceWholesaleSnapshot: decimalToString(item.priceWholesaleSnapshot),
            pricingCurrencySnapshot: item.pricingCurrencySnapshot,
            availableInUnit, exceedsAvailability: exceeds,
        };
    });

    let matchedCustomer: CandidateCustomer | null = null;
    let candidates: CandidateCustomer[] = [];
    if (options.includeCustomers) {
        candidates = await findCandidateCustomersByPhone(db, tenantId, header.retailerPhone);
        if (header.matchedCustomerId) {
            const direct = candidates.find((c) => c.id === header.matchedCustomerId);
            if (direct) {
                matchedCustomer = direct;
            } else {
                const row = await db.customer.findFirst({
                    where: {
                        tenantId, id: header.matchedCustomerId,
                        isActive: true, isSystemGenerated: false,
                    },
                    select: { id: true, name: true, phone: true, shopName: true },
                });
                if (row) {
                    matchedCustomer = {
                        id: row.id, name: row.name, phone: row.phone ?? "",
                        shopName: row.shopName ?? null,
                    };
                }
            }
        }
    }

    return {
        id: header.id, orderRef: orderReference(header.id),
        retailerName: header.retailerName, retailerPhone: header.retailerPhone,
        retailerShopName: header.retailerShopName, status: header.status,
        createdAt: header.createdAt, reviewedAt: header.reviewedAt,
        reviewedByUserName: header.reviewedByUser?.name ?? null,
        rejectionReason: header.status === "REJECTED" ? header.rejectionReason : null,
        resultingInvoiceId: header.status === "APPROVED" ? header.resultingInvoiceId : null,
        lines, signal, otherPendingCount, matchedCustomer, candidates,
    };
}

/** Reject: conditional updateMany first; 404 vs 409 decided inside tx. */
export async function rejectOrder(
    db: TxOrClient & { $transaction: (cb: (tx: TxOrClient) => Promise<void>) => Promise<void> },
    tenantId: string,
    orderId: string,
    input: { reason: string; reviewedByUserId: string }
): Promise<void> {
    requireTenantId(tenantId, "rejectOrder");
    if (!orderId || typeof orderId !== "string") throw new OrderNotFoundError();
    const reason = (input.reason ?? "").trim();
    if (reason.length < 3 || reason.length > 500) {
        throw new InvalidRejectReasonError();
    }
    if (!input.reviewedByUserId) {
        throw new Error("lib/data/orders.ts: rejectOrder() requires reviewedByUserId.");
    }
    await db.$transaction(async (tx) => {
        const updated = await tx.b2BOrderRequest.updateMany({
            where: { id: orderId, tenantId, status: "PENDING_REVIEW" },
            data: {
                status: "REJECTED",
                rejectionReason: reason,
                reviewedByUserId: input.reviewedByUserId,
                reviewedAt: new Date(),
            },
        });
        if (updated.count === 1) return;
        const existing = await tx.b2BOrderRequest.findFirst({
            where: { id: orderId, tenantId },
            select: { id: true },
        });
        if (!existing) throw new OrderNotFoundError();
        throw new OrderAlreadyReviewedError();
    });
}