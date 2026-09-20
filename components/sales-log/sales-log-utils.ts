/**
 * components/sales-log/sales-log-utils.ts
 *
 * T4c2 — small, pure presentation helpers and label/colour maps for the
 * sales-log screen. Kept out of types.ts so that file stays a pure DTO
 * contract with no runtime code.
 */

import type {
    InvoiceStatusValue,
    PaymentStatusBadgeValue,
} from "./types";

// ---------------------------------------------------------------------------
// Badge vocabulary.
//
// Both maps are keyed by the values the SERVER already decided (see
// lib/data/invoices.ts's derivePaymentStatus + InvoiceStatus in
// prisma/schema.prisma) — the UI never re-derives a badge from the
// underlying amounts, so the two can never drift apart.
// ---------------------------------------------------------------------------

export const PAYMENT_STATUS_LABELS: Record<PaymentStatusBadgeValue, string> = {
    CASH_FULL: "نقدي بالكامل",
    CREDIT_FULL: "على الحساب بالكامل",
    PARTIAL: "دفع جزئي",
};

export const PAYMENT_STATUS_CLASSES: Record<PaymentStatusBadgeValue, string> = {
    CASH_FULL: "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900",
    CREDIT_FULL: "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900",
    PARTIAL: "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-900",
};

export const INVOICE_STATUS_LABELS: Record<InvoiceStatusValue, string> = {
    COMPLETED: "مكتملة",
    PENDING_REVIEW: "بانتظار المراجعة",
    VOIDED: "ملغاة",
};

export const INVOICE_STATUS_CLASSES: Record<InvoiceStatusValue, string> = {
    COMPLETED: "bg-zinc-100 text-zinc-700 border-zinc-200 dark:bg-zinc-800 dark:text-zinc-300 dark:border-zinc-700",
    PENDING_REVIEW: "bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-950/40 dark:text-orange-300 dark:border-orange-900",
    VOIDED: "bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-900",
};

// ---------------------------------------------------------------------------
// "Invoice number".
//
// [FLAGGED — deliberate, documented decision] Invoice has NO invoiceNumber
// column in prisma/schema.prisma, and T4c2's acceptance criteria require
// NO schema change of any kind. So the human-readable figure the spec calls
// the "invoice number" is DERIVED from the row's own cuid `id`: its last 6
// characters, uppercased. This is:
//   - stable (the id never changes, and the original invoice is append-only),
//   - collision-resistant enough for on-screen reference at merchant scale,
//   - zero extra queries or storage.
// It is NOT a legal/sequential invoice number. If a real, gapless,
// merchant-facing numbering sequence is ever required, that is a schema
// change (a new column + a per-tenant sequence) and belongs in its own
// task, not here.
// ---------------------------------------------------------------------------
export function invoiceReference(invoiceId: string): string {
    return `#${invoiceId.slice(-6).toUpperCase()}`;
}

// ---------------------------------------------------------------------------
// Date-range helpers.
//
// [IMPORTANT] Both bounds are computed in the BROWSER's local timezone and
// sent to the API as explicit UTC instants. This is exactly what
// app/api/invoices/route.ts's header asks for: its own fallback "today"
// (used only when `from`/`to` are omitted entirely) is computed in UTC day
// boundaries, which would misalign the "today" window for Syria (UTC+3)
// around midnight. Always sending explicit bounds sidesteps that entirely.
// ---------------------------------------------------------------------------

export function startOfLocalDay(date: Date): Date {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}

export function endOfLocalDay(date: Date): Date {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
}

export function todayLocalRange(): { from: Date; to: Date } {
    const now = new Date();
    return { from: startOfLocalDay(now), to: endOfLocalDay(now) };
}

export function daysAgoLocalRange(days: number): { from: Date; to: Date } {
    const now = new Date();
    const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days, 0, 0, 0, 0);
    return { from, to: endOfLocalDay(now) };
}

export function startOfMonthLocalRange(): { from: Date; to: Date } {
    const now = new Date();
    return {
        from: new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0),
        to: endOfLocalDay(now),
    };
}

/** Short, Arabic-locale date for the range picker's trigger label. */
export function formatDayLabel(date: Date): string {
    return date.toLocaleDateString("ar-SY", { year: "numeric", month: "short", day: "numeric" });
}

/** Row time — the "what did I sell today, and when" figure. */
export function formatRowTime(iso: string): string {
    return new Date(iso).toLocaleTimeString("ar-SY", { hour: "2-digit", minute: "2-digit" });
}

/** Full timestamp for the detail view's header. */
export function formatRowTimestamp(iso: string): string {
    return new Date(iso).toLocaleString("ar-SY", {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    });
}
