/**
 * components/orders/types.ts
 *
 * T5b — wire DTOs for the admin orders queue. Mirrors the server payloads
 * (app/api/orders/**) without importing backend code into the client bundle.
 *
 * [T5c Phase 5] OrderDetailView gains dailyExchangeRate (ADMIN-only,
 * informational preview hint for USD-priced lines; the server recomputes
 * everything at approval). CASHIER payload omits it entirely.
 */

import type { OrderStatusValue } from "./orders-utils";

export interface OrderQueueRow {
    id: string;
    orderRef: string;
    retailerName: string;
    retailerPhone: string;
    retailerShopName: string | null;
    createdAt: string;
    status: OrderStatusValue;
    lineCount: number;
    totalSYP: string;
    totalUSD: string;
    resultingInvoiceId: string | null;
}

export interface OrderQueuePage {
    success: boolean;
    items: OrderQueueRow[];
    nextCursor: string | null;
    pendingCount: number;
}

export interface OrderDetailLineView {
    id: string;
    productId: string;
    productName: string;
    unitId: string;
    unitName: string;
    quantity: string;
    approvedQuantity: string | null;
    priceWholesaleSnapshot: string;
    pricingCurrencySnapshot: "SYP" | "USD";
    /** null = unknown (unit factor missing or conversion failed). Never render it as 0. */
    availableInUnit: string | null;
    /** Informational only: the product's TOTAL requested (all its lines) exceeds stock. */
    exceedsAvailability: boolean;
}

export interface OrderDetailView {
    id: string;
    orderRef: string;
    retailerName: string;
    retailerPhone: string;
    retailerShopName: string | null;
    status: OrderStatusValue;
    createdAt: string;
    reviewedAt: string | null;
    reviewedByUserName: string | null;
    rejectionReason: string | null;
    resultingInvoiceId: string | null;
    lines: OrderDetailLineView[];
    signal: { hasPriorApproval: boolean; verificationCount: number };
    otherPendingCount: number;
    matchedCustomer: { id: string; name: string; phone: string; shopName: string | null } | null;
    candidates: { id: string; name: string; phone: string; shopName: string | null }[];
    /** ADMIN-only preview hint for USD-priced lines; null when no rate. Never trusted — server recomputes. */
    dailyExchangeRate?: string | null;
}

/** T5c approve payload — mirrors approveOrderBodySchema (lib/data/orders-approval.ts). */
export type ApprovePaymentMode = "FULL_CASH" | "FULL_CREDIT" | "PARTIAL";

export interface ApproveOrderPayload {
    lines: { itemId: string; approvedQuantity: string }[];
    customer:
        | { mode: "EXISTING"; customerId: string }
        | { mode: "NEW"; name: string; phone: string; shopName?: string };
    payment: {
        mode: ApprovePaymentMode;
        paidAmountSYP?: string;
        paymentMethod?: string;
    };
}

export interface ApproveOrderSuccess {
    success: true;
    invoiceId: string;
    totalSYP: string;
    paidAmountSYP: string;
    debtAmountSYP: string;
    customerId: string;
}

export interface InsufficientStockDetail {
    itemId: string;
    productName: string;
    unitName: string;
    available: string;
}
