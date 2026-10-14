/**
 * components/orders/types.ts
 *
 * T5b — wire DTOs for the admin orders queue. Mirrors the server payloads
 * (app/api/orders/**) without importing backend code into the client bundle.
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
}