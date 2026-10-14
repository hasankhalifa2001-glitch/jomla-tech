/**
 * components/orders/orders-utils.ts
 *
 * T5b — presentation helpers for the admin orders queue. Display-only.
 * Timestamps render in Asia/Damascus (fixed UTC+3, no DST) via the same
 * pinned-Intl pattern as receipts-utils.ts — never the device zone.
 * Order refs derive from orderReference() (last 6 of id, upper-cased).
 */

import { BUSINESS_TIME_ZONE } from "@/lib/inventory/date-utils";
import { orderReference } from "@/lib/utils/order-reference";

export type OrderStatusValue = "PENDING_REVIEW" | "APPROVED" | "REJECTED";

export const ORDER_STATUS_LABELS: Record<OrderStatusValue, string> = {
    PENDING_REVIEW: "قيد المراجعة",
    APPROVED: "مقبول",
    REJECTED: "مرفوض",
};

const damascusFormatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: BUSINESS_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    // h23, not hour12:false — the latter renders midnight as "24:xx" in
    // several engines.
    hourCycle: "h23",
});

/** 'YYYY-MM-DD HH:mm' in Asia/Damascus for an ISO instant. */
export function formatOrderTime(iso: string): string {
    const instant = new Date(iso);
    if (Number.isNaN(instant.getTime())) return "—";
    const parts = damascusFormatter.formatToParts(instant);
    const pick = (type: Intl.DateTimeFormatPartTypes) =>
        parts.find((part) => part.type === type)?.value ?? "";
    return `${pick("year")}-${pick("month")}-${pick("day")} ${pick("hour")}:${pick("minute")}`;
}

export function orderRefLabel(orderId: string): string {
    return `#${orderReference(orderId)}`;
}
