"use client";

/**
 * components/sales-log/invoice-log-table.tsx
 *
 * T4c2 — one invoice per row (desktop) / per card (mobile). Presentation
 * only: no fetching, no role decisions of its own — the caller decides
 * whether `isAdmin` and therefore whether the void control exists at all.
 *
 * [SYP primary / USD secondary] totalSYP is the large primary figure and
 * totalUSD is the secondary "≈" one. BOTH come straight off the row, which
 * means the USD figure is the invoice's own FROZEN totalUSD — computed at
 * sale time from that invoice's exchangeRateUsed — never a conversion at
 * today's live rate. That distinction is the whole point of storing
 * exchangeRateUsed per invoice, so this log must never re-derive it.
 *
 * [VOID CROSS-LINKS] A void row carries voidsInvoiceId (the original it
 * reverses); an original carries voidedByInvoiceId (the void that reversed
 * it). Both are rendered as navigable links that open the OTHER invoice by
 * id — deliberately by id rather than "scroll to the sibling row", because
 * a void created today almost always reverses an original from an earlier
 * date, i.e. outside the currently filtered window, so the sibling row is
 * usually not on screen at all.
 *
 * [v4.4 — visual pass, light mode only] Zebra striping and a clearer hover
 * tint on desktop rows, larger/clearer mobile cards with a stronger visual
 * hierarchy (total first, meta second), a softer empty state, a calmer
 * loading state (no more solitary spinner-and-text — three staged
 * skeleton rows instead, which reads as "content incoming" rather than
 * "something is stuck"), and every row/card fades and slides in gently on
 * first paint. No dark-mode classes: intentionally not on the roadmap yet.
 */

import { Clock, Loader2, Ban, Link2, User, Receipt } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatMoney } from "@/lib/utils/money";
import type { InvoiceLogRow } from "./types";
import {
    INVOICE_STATUS_CLASSES,
    INVOICE_STATUS_LABELS,
    PAYMENT_STATUS_CLASSES,
    PAYMENT_STATUS_LABELS,
    formatRowTime,
    invoiceReference,
} from "./sales-log-utils";

interface InvoiceLogTableProps {
    rows: InvoiceLogRow[];
    loading: boolean;
    isAdmin: boolean;
    onOpenDetail: (invoiceId: string) => void;
    onVoid: (row: InvoiceLogRow) => void;
}

/**
 * Whether the void action may be offered for a given row.
 *
 * Three independent conditions, all required:
 *   1. ADMIN session — the button is ABSENT (not disabled) for a CASHIER.
 *      POST /api/ledger/voids enforces this server-side regardless; this is
 *      the UI half of T2b's Role Capability Matrix row.
 *   2. status === COMPLETED — never on a VOIDED row, and never on a void row
 *      (a void row is itself always VOIDED by construction).
 *   3. No existing void on either side of the self-relation. The ORIGINAL
 *      invoice is append-only and its status stays COMPLETED forever even
 *      after it has been reversed (see app/api/ledger/voids/route.ts), so
 *      `voidedByInvoiceId` is the only field that reveals "already voided".
 *      Without this check the UI would offer a button that the API is
 *      guaranteed to reject with 400 "ملغاة بالفعل".
 */
function canVoidInvoice(row: InvoiceLogRow, isAdmin: boolean): boolean {
    return isAdmin && row.status === "COMPLETED" && !row.voidsInvoiceId && !row.voidedByInvoiceId;
}

function TotalsCell({ row }: { row: InvoiceLogRow }) {
    return (
        <div className="flex flex-col text-left md:text-right">
            <span
                className={cn(
                    "font-mono text-sm font-extrabold text-zinc-900",
                    row.status === "VOIDED" && "text-zinc-500 line-through decoration-red-400"
                )}
            >
                {formatMoney(row.totalSYP, "SYP")} ل.س
            </span>
            {/* [v4.9] Omit secondary USD entirely when no rate was frozen. */}
            {row.totalUSD !== null && (
                <span className="text-[11px] font-semibold text-purple-600">
                    ≈ ${formatMoney(row.totalUSD, "USD")}
                </span>
            )}
        </div>
    );
}

function BadgesCell({ row }: { row: InvoiceLogRow }) {
    return (
        <div className="flex flex-wrap items-center gap-1.5">
            <Badge
                variant="outline"
                className={cn("px-2 py-0.5 text-[10px] font-bold", PAYMENT_STATUS_CLASSES[row.paymentStatus])}
            >
                {PAYMENT_STATUS_LABELS[row.paymentStatus]}
            </Badge>
            <Badge
                variant="outline"
                className={cn("px-2 py-0.5 text-[10px] font-bold", INVOICE_STATUS_CLASSES[row.status])}
            >
                {INVOICE_STATUS_LABELS[row.status]}
            </Badge>
        </div>
    );
}

function CrossLinks({ row, onOpenDetail }: { row: InvoiceLogRow; onOpenDetail: (id: string) => void }) {
    if (!row.voidsInvoiceId && !row.voidedByInvoiceId) return null;

    const chipClass =
        "inline-flex items-center gap-1 rounded-md border border-red-200 bg-red-50/60 px-1.5 py-0.5 text-[10px] font-bold text-red-700 transition-colors hover:bg-red-100";

    return (
        <div className="flex flex-wrap items-center gap-1.5">
            {row.voidsInvoiceId && (
                <button
                    type="button"
                    onClick={(e) => {
                        e.stopPropagation();
                        onOpenDetail(row.voidsInvoiceId as string);
                    }}
                    className={chipClass}
                >
                    <Link2 className="h-3 w-3" />
                    <span>تُلغي الأصل {invoiceReference(row.voidsInvoiceId)}</span>
                </button>
            )}
            {row.voidedByInvoiceId && (
                <button
                    type="button"
                    onClick={(e) => {
                        e.stopPropagation();
                        onOpenDetail(row.voidedByInvoiceId as string);
                    }}
                    className={chipClass}
                >
                    <Link2 className="h-3 w-3" />
                    <span>أُلغيت بـ {invoiceReference(row.voidedByInvoiceId)}</span>
                </button>
            )}
        </div>
    );
}

function VoidButton({
    row,
    isAdmin,
    onVoid,
}: {
    row: InvoiceLogRow;
    isAdmin: boolean;
    onVoid: (row: InvoiceLogRow) => void;
}) {
    // Absent, NOT disabled, for a CASHIER session or for any voided /
    // void-row invoice — see canVoidInvoice() above.
    if (!canVoidInvoice(row, isAdmin)) return null;

    return (
        <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={(e) => {
                e.stopPropagation();
                onVoid(row);
            }}
            className="h-7 gap-1 border-red-200 px-2 text-[11px] font-bold text-red-600 transition-colors hover:border-red-300 hover:bg-red-50"
        >
            <Ban className="h-3 w-3" />
            <span>إلغاء الفاتورة</span>
        </Button>
    );
}

/** Three staged, gently pulsing placeholder rows — reads as "loading content" rather than a bare spinner. */
function LoadingRows() {
    return (
        <div className="space-y-2 rounded-xl border border-zinc-200 bg-white p-3">
            <div className="mb-1 flex items-center gap-2 text-[11px] font-semibold text-zinc-400">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-emerald-500" />
                <span>جارٍ تحميل سجل الفواتير...</span>
            </div>
            {[0, 1, 2].map((i) => (
                <div
                    key={i}
                    className="h-14 animate-pulse rounded-lg bg-zinc-100"
                    style={{ animationDelay: `${i * 120}ms` }}
                />
            ))}
        </div>
    );
}

function EmptyState() {
    return (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-zinc-300 bg-white py-16 text-center animate-in fade-in duration-300">
            <div className="grid h-12 w-12 place-items-center rounded-full bg-zinc-100">
                <Receipt className="h-6 w-6 text-zinc-400" />
            </div>
            <div>
                <p className="text-sm font-bold text-zinc-700">لا توجد فواتير ضمن الفترة المحددة</p>
                <p className="mt-1 text-xs text-zinc-500">جرّب توسيع نطاق التاريخ أو إزالة الفلاتر.</p>
            </div>
        </div>
    );
}

export function InvoiceLogTable({
    rows,
    loading,
    isAdmin,
    onOpenDetail,
    onVoid,
}: InvoiceLogTableProps) {
    if (loading) return <LoadingRows />;
    if (rows.length === 0) return <EmptyState />;

    // Whole-row activation, keyboard included. Inner controls (cross-link
    // chips, the void button) stop propagation so they never also open the
    // detail view.
    const rowHandlers = (row: InvoiceLogRow) => ({
        role: "button" as const,
        tabIndex: 0,
        "aria-label": `تفاصيل الفاتورة ${invoiceReference(row.id)}`,
        onClick: () => onOpenDetail(row.id),
        onKeyDown: (e: React.KeyboardEvent) => {
            // Only handle keydown originating on the row itself — never one
            // bubbling up from a nested interactive control (VoidButton,
            // CrossLinks chip), which must get the browser's own native
            // Enter/Space-activates-button behavior instead.
            if (e.target !== e.currentTarget) return;
            if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onOpenDetail(row.id);
            }
        },
    });

    return (
        <>
            {/* Desktop / tablet table */}
            <div className="hidden overflow-x-auto rounded-xl border border-zinc-200 bg-white shadow-sm md:block">
                <table className="w-full text-right text-xs">
                    <thead className="border-b border-zinc-200 bg-zinc-50/75 font-bold text-zinc-500">
                        <tr>
                            <th className="px-4 py-3">الوقت</th>
                            <th className="px-4 py-3">مرجع الفاتورة</th>
                            <th className="px-4 py-3">الموظف</th>
                            <th className="px-4 py-3">الزبون</th>
                            <th className="px-4 py-3">الإجمالي</th>
                            <th className="px-4 py-3">الدفع / الحالة</th>
                            <th className="px-4 py-3">إجراءات</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-100 font-medium">
                        {rows.map((row, i) => (
                            <tr
                                key={row.id}
                                {...rowHandlers(row)}
                                className={cn(
                                    "cursor-pointer transition-colors duration-150 hover:bg-emerald-50/60 animate-in fade-in slide-in-from-bottom-1",
                                    i % 2 === 1 && "bg-zinc-50/50",
                                    row.status === "VOIDED" && "bg-red-50/40 hover:bg-red-50/70"
                                )}
                                style={{ animationDelay: `${Math.min(i, 12) * 25}ms`, animationDuration: "250ms" }}
                            >
                                <td className="whitespace-nowrap px-4 py-3 text-zinc-600">
                                    <span className="inline-flex items-center gap-1.5 font-mono">
                                        <Clock className="h-3.5 w-3.5 text-zinc-400" />
                                        {formatRowTime(row.createdAt)}
                                    </span>
                                </td>

                                <td className="px-4 py-3">
                                    <div className="flex flex-col gap-1">
                                        <span className="font-mono text-xs font-bold text-zinc-900">
                                            {invoiceReference(row.id)}
                                        </span>
                                        <CrossLinks row={row} onOpenDetail={onOpenDetail} />
                                    </div>
                                </td>

                                <td className="whitespace-nowrap px-4 py-3 text-zinc-700">
                                    <span className="inline-flex items-center gap-1.5">
                                        <User className="h-3.5 w-3.5 text-zinc-400" />
                                        {row.user.name}
                                    </span>
                                </td>

                                <td className="px-4 py-3">
                                    <div className="flex flex-col gap-1">
                                        <span className="font-semibold text-zinc-800">{row.customer.name}</span>
                                        {row.customer.isSystemGenerated && (
                                            <Badge
                                                variant="secondary"
                                                className="w-fit bg-zinc-100 px-1.5 py-0 text-[10px] font-bold text-zinc-600"
                                            >
                                                زبون نقدي عام
                                            </Badge>
                                        )}
                                    </div>
                                </td>

                                <td className="px-4 py-3">
                                    <TotalsCell row={row} />
                                </td>

                                <td className="px-4 py-3">
                                    <BadgesCell row={row} />
                                </td>

                                <td className="px-4 py-3">
                                    <VoidButton row={row} isAdmin={isAdmin} onVoid={onVoid} />
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            {/* Mobile cards — same data, same actions, no horizontal scroll. */}
            <div className="space-y-3 md:hidden">
                {rows.map((row, i) => (
                    <div
                        key={row.id}
                        {...rowHandlers(row)}
                        className={cn(
                            "cursor-pointer rounded-xl border border-zinc-200 bg-white p-4 shadow-sm transition-all duration-150 active:scale-[0.99] animate-in fade-in slide-in-from-bottom-1",
                            row.status === "VOIDED" && "border-red-200 bg-red-50/40"
                        )}
                        style={{ animationDelay: `${Math.min(i, 12) * 30}ms`, animationDuration: "250ms" }}
                    >
                        <div className="flex items-start justify-between gap-2">
                            <div className="flex flex-col gap-1">
                                <span className="font-mono text-xs font-bold text-zinc-900">
                                    {invoiceReference(row.id)}
                                </span>
                                <span className="inline-flex flex-wrap items-center gap-1.5 text-[11px] text-zinc-500">
                                    <Clock className="h-3 w-3" />
                                    {formatRowTime(row.createdAt)}
                                    <span className="text-zinc-300">|</span>
                                    <User className="h-3 w-3" />
                                    {row.user.name}
                                </span>
                            </div>
                            <TotalsCell row={row} />
                        </div>

                        <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[11px] text-zinc-600">
                            <span className="font-semibold text-zinc-800">{row.customer.name}</span>
                            {row.customer.isSystemGenerated && (
                                <Badge
                                    variant="secondary"
                                    className="bg-zinc-100 px-1.5 py-0 text-[10px] font-bold text-zinc-600"
                                >
                                    زبون نقدي عام
                                </Badge>
                            )}
                        </div>

                        <div className="mt-2.5">
                            <BadgesCell row={row} />
                        </div>

                        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-zinc-100 pt-2.5">
                            <CrossLinks row={row} onOpenDetail={onOpenDetail} />
                            <VoidButton row={row} isAdmin={isAdmin} onVoid={onVoid} />
                        </div>
                    </div>
                ))}
            </div>
        </>
    );
}