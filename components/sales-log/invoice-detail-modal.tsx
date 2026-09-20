"use client";

/**
 * components/sales-log/invoice-detail-modal.tsx
 *
 * T4c2 — the per-line detail view: every InvoiceItem on one invoice
 * (product, unit sold, quantity, unit price), i.e. the literal answer to
 * "شو بايع شو بالتفاصيل". Outside T4f's printed/shared receipt, this is the
 * only place in the system this level of detail is shown.
 *
 * Fetches through GET /api/invoices/[id], which re-checks ownership
 * server-side (a CASHIER asking for another employee's invoice gets 403 even
 * though the id is right there in the URL) — so this modal is safe to open
 * by id from either a list row or a void cross-link.
 *
 * [CROSS-LINK NAVIGATION] The two cross-link buttons call `onNavigate(id)`
 * instead of pushing a route: the modal simply refetches with the new id and
 * stays open, so the user can hop original ↔ void ↔ back without losing the
 * list, its filters, or pagination state underneath.
 *
 * [LOADING IS DERIVED, NOT STORED] `loading`, `error` and `detail` are not
 * separate useStates. The last completed fetch is stored as ONE object tagged
 * with the invoice id it answered. "Loading" simply means "the id being asked
 * for has no result yet". That keeps every setState inside the fetch's
 * .then/.catch callbacks (React's set-state-in-effect rule forbids calling
 * them synchronously in the effect body) and makes `loading` true in the very
 * same render in which `invoiceId` changes. The stored result is cleared when
 * the modal closes, so re-opening an invoice always refetches with a loading
 * state instead of flashing stale data (e.g. a status that changed after a
 * void).
 *
 * Line totals are computed with multiplyMoney() (lib/utils/money.ts), never
 * native `*` — the same rule every other money math site in this codebase
 * follows. SYP stays the primary figure; the USD line is the secondary "≈"
 * one, from the item's own frozen unitPriceUSD.
 */

import { useEffect, useState } from "react";
import { AlertCircle, Ban, Clock, Link2, Loader2, Phone, Undo2, User } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { formatMoney, multiplyMoney } from "@/lib/utils/money";
import type { InvoiceDetail } from "./types";
import { INVOICE_STATUS_CLASSES, INVOICE_STATUS_LABELS, formatRowTimestamp, invoiceReference } from "./sales-log-utils";

interface InvoiceDetailModalProps {
    /** null = closed. */
    invoiceId: string | null;
    onOpenChange: (open: boolean) => void;
    onNavigate: (invoiceId: string) => void;
}

/** The last completed fetch, tagged with the invoice id it answered. */
type FetchResult = {
    id: string;
    detail: InvoiceDetail | null;
    error: string | null;
};

function LineItemsTable({ detail }: { detail: InvoiceDetail }) {
    if (detail.items.length === 0) {
        return (
            <p className="rounded-lg border border-dashed border-zinc-300 py-6 text-center text-xs text-zinc-500 dark:border-zinc-700">
                لا توجد عناصر مسجّلة على هذه الفاتورة.
            </p>
        );
    }

    return (
        <div className="overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800">
            <div className="grid grid-cols-12 gap-2 bg-zinc-50/75 px-3 py-2 text-[10px] font-bold text-zinc-500 dark:bg-zinc-900/50 dark:text-zinc-400">
                <span className="col-span-5">الصنف / الوحدة المباعة</span>
                <span className="col-span-2 text-center">الكمية</span>
                <span className="col-span-5 text-left">سعر الوحدة / الإجمالي</span>
            </div>

            <div className="divide-y divide-zinc-100 dark:divide-zinc-800/60">
                {detail.items.map((item) => {
                    const lineSYP = multiplyMoney(item.unitPriceSYP, item.quantity);
                    const lineUSD = multiplyMoney(item.unitPriceUSD, item.quantity);

                    return (
                        <div key={item.id} className="grid grid-cols-12 items-start gap-2 px-3 py-2 text-xs">
                            <div className="col-span-5 min-w-0">
                                <p className="truncate font-semibold text-zinc-800 dark:text-zinc-200">
                                    {item.productName}
                                </p>
                                <p className="text-[11px] text-zinc-500">الوحدة المباعة: {item.unitName}</p>
                            </div>

                            <span className="col-span-2 text-center font-mono text-zinc-700 dark:text-zinc-300">
                                {item.quantity}
                            </span>

                            <div className="col-span-5 text-left">
                                <p className="font-mono text-[11px] text-zinc-500">
                                    {formatMoney(item.unitPriceSYP, "SYP")} ل.س
                                    <span className="mx-1 text-zinc-300 dark:text-zinc-700">|</span>
                                    <span className="text-purple-600 dark:text-purple-400">
                                        ≈ ${formatMoney(item.unitPriceUSD, "USD")}
                                    </span>
                                </p>
                                <p className="font-mono font-bold text-zinc-900 dark:text-zinc-100">
                                    {formatMoney(lineSYP, "SYP")} ل.س
                                    <span className="mr-1 text-[10px] font-semibold text-purple-600 dark:text-purple-400">
                                        (≈ ${formatMoney(lineUSD, "USD")})
                                    </span>
                                </p>
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

export function InvoiceDetailModal({ invoiceId, onOpenChange, onNavigate }: InvoiceDetailModalProps) {
    const [result, setResult] = useState<FetchResult | null>(null);

    // Derived, not stored: only a result that answers the CURRENT invoiceId
    // counts. A different (or missing) id means we are still loading it.
    const current = invoiceId !== null && result?.id === invoiceId ? result : null;
    const loading = invoiceId !== null && current === null;
    const detail = current?.detail ?? null;
    const error = current?.error ?? null;

    useEffect(() => {
        if (!invoiceId) return;

        const controller = new AbortController();
        let cancelled = false;

        fetch(`/api/invoices/${invoiceId}`, { signal: controller.signal })
            .then(async (res) => {
                const data = await res.json().catch(() => ({}));
                if (cancelled) return;
                if (!res.ok || !data.success) {
                    setResult({
                        id: invoiceId,
                        detail: null,
                        error: data.message || "تعذّر جلب تفاصيل الفاتورة.",
                    });
                    return;
                }
                setResult({ id: invoiceId, detail: data.invoice as InvoiceDetail, error: null });
            })
            .catch((err: unknown) => {
                if (cancelled || (err as { name?: string })?.name === "AbortError") return;
                setResult({
                    id: invoiceId,
                    detail: null,
                    error: "حدث خطأ في الاتصال أثناء جلب تفاصيل الفاتورة.",
                });
            });

        return () => {
            cancelled = true;
            controller.abort();
        };
    }, [invoiceId]);

    // Closing clears the stored result (in an event handler, not an effect),
    // so re-opening the same invoice always shows a loading state and
    // refetches instead of flashing the previous, possibly stale, data.
    const handleOpenChange = (next: boolean) => {
        if (!next) setResult(null);
        onOpenChange(next);
    };

    const open = Boolean(invoiceId);

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto" dir="rtl">
                <DialogHeader>
                    <div className="flex items-center gap-2">
                        <div className="rounded-lg bg-emerald-100 p-2 dark:bg-emerald-950/40">
                            <Undo2 className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
                        </div>
                        <div>
                            <DialogTitle className="text-base font-bold">
                                تفاصيل الفاتورة {invoiceId ? invoiceReference(invoiceId) : ""}
                            </DialogTitle>
                            <DialogDescription className="text-xs text-zinc-500">
                                كل الأصناف المباعة على هذه الفاتورة — شو بايع شو بالتفاصيل.
                            </DialogDescription>
                        </div>
                    </div>
                </DialogHeader>

                {loading && (
                    <div className="flex items-center justify-center gap-2 py-12 text-xs text-zinc-500">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        <span>جارٍ تحميل تفاصيل الفاتورة...</span>
                    </div>
                )}

                {!loading && error && (
                    <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50/60 p-3 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/20 dark:text-red-300">
                        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                        <span>{error}</span>
                    </div>
                )}

                {!loading && !error && detail && (
                    <div className="space-y-4 py-2">
                        {/* Header facts */}
                        <div className="grid grid-cols-2 gap-3 rounded-lg border border-zinc-200 bg-zinc-50/60 p-3 text-xs dark:border-zinc-800 dark:bg-zinc-900/40 md:grid-cols-4">
                            <div>
                                <span className="block text-[10px] text-zinc-400">التاريخ والوقت</span>
                                <span className="inline-flex items-center gap-1 font-semibold text-zinc-800 dark:text-zinc-200">
                                    <Clock className="h-3 w-3 text-zinc-400" />
                                    {formatRowTimestamp(detail.createdAt)}
                                </span>
                            </div>

                            <div>
                                <span className="block text-[10px] text-zinc-400">الموظف</span>
                                <span className="inline-flex items-center gap-1 font-semibold text-zinc-800 dark:text-zinc-200">
                                    <User className="h-3 w-3 text-zinc-400" />
                                    {detail.user.name}
                                </span>
                            </div>

                            <div>
                                <span className="block text-[10px] text-zinc-400">الزبون</span>
                                <span className="font-semibold text-zinc-800 dark:text-zinc-200">
                                    {detail.customer.name}
                                </span>
                                {detail.customer.phone && (
                                    <span className="inline-flex items-center gap-1 text-[10px] text-zinc-500">
                                        <Phone className="h-2.5 w-2.5" />
                                        {detail.customer.phone}
                                    </span>
                                )}
                            </div>

                            <div>
                                <span className="block text-[10px] text-zinc-400">الحالة</span>
                                <Badge
                                    variant="outline"
                                    className={cn(
                                        "px-2 py-0.5 text-[10px] font-bold",
                                        INVOICE_STATUS_CLASSES[detail.status]
                                    )}
                                >
                                    {INVOICE_STATUS_LABELS[detail.status]}
                                </Badge>
                            </div>
                        </div>

                        {/* Void cross-links + reason */}
                        {(detail.voidsInvoiceId || detail.voidedByInvoiceId || detail.voidReason) && (
                            <div className="space-y-2 rounded-lg border border-red-200 bg-red-50/50 p-3 text-xs dark:border-red-900 dark:bg-red-950/20">
                                {detail.voidsInvoiceId && (
                                    <Button
                                        type="button"
                                        variant="outline"
                                        size="sm"
                                        onClick={() => onNavigate(detail.voidsInvoiceId as string)}
                                        className="h-7 gap-1.5 text-[11px] font-bold"
                                    >
                                        <Link2 className="h-3 w-3" />
                                        عرض الفاتورة الأصلية {invoiceReference(detail.voidsInvoiceId)}
                                    </Button>
                                )}
                                {detail.voidedByInvoiceId && (
                                    <Button
                                        type="button"
                                        variant="outline"
                                        size="sm"
                                        onClick={() => onNavigate(detail.voidedByInvoiceId as string)}
                                        className="h-7 gap-1.5 text-[11px] font-bold"
                                    >
                                        <Link2 className="h-3 w-3" />
                                        عرض فاتورة الإلغاء {invoiceReference(detail.voidedByInvoiceId)}
                                    </Button>
                                )}
                                {detail.voidReason && (
                                    <p className="flex items-start gap-1.5 font-semibold text-red-700 dark:text-red-300">
                                        <Ban className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                                        <span>سبب الإلغاء: {detail.voidReason}</span>
                                    </p>
                                )}
                            </div>
                        )}

                        <LineItemsTable detail={detail} />

                        {/* Totals — SYP primary, USD secondary, both frozen
                            on the invoice itself (its own exchangeRateUsed). */}
                        <div className="space-y-1.5 rounded-lg border border-zinc-200 p-3 text-xs dark:border-zinc-800">
                            <div className="flex items-center justify-between">
                                <span className="text-zinc-500">إجمالي الفاتورة</span>
                                <div className="text-left">
                                    <span className="font-mono text-sm font-extrabold text-emerald-700 dark:text-emerald-400">
                                        {formatMoney(detail.totalSYP, "SYP")} ل.س
                                    </span>
                                    <span className="mr-1 font-mono text-[11px] font-semibold text-purple-600 dark:text-purple-400">
                                        (≈ ${formatMoney(detail.totalUSD, "USD")})
                                    </span>
                                </div>
                            </div>

                            <div className="flex items-center justify-between">
                                <span className="text-zinc-500">المبلغ المدفوع</span>
                                <div className="text-left">
                                    <span className="font-mono font-bold text-emerald-600 dark:text-emerald-400">
                                        {formatMoney(detail.paidAmountSYP, "SYP")} ل.س
                                    </span>
                                    <span className="mr-1 font-mono text-[10px] text-purple-600 dark:text-purple-400">
                                        (≈ ${formatMoney(detail.paidAmountUSD, "USD")})
                                    </span>
                                </div>
                            </div>

                            <div className="flex items-center justify-between">
                                <span className="text-zinc-500">المتبقي على الحساب (دين)</span>
                                <div className="text-left">
                                    <span className="font-mono font-bold text-red-600 dark:text-red-400">
                                        {formatMoney(detail.debtAmountSYP, "SYP")} ل.س
                                    </span>
                                    <span className="mr-1 font-mono text-[10px] text-purple-600 dark:text-purple-400">
                                        (≈ ${formatMoney(detail.debtAmountUSD, "USD")})
                                    </span>
                                </div>
                            </div>

                            <div className="flex items-center justify-between border-t border-zinc-200 pt-1.5 dark:border-zinc-800">
                                <span className="text-zinc-500">سعر الصرف المعتمد على الفاتورة</span>
                                <span className="font-mono text-zinc-600 dark:text-zinc-400">
                                    {formatMoney(detail.exchangeRateUsed, "SYP")} ل.س / $
                                </span>
                            </div>
                        </div>
                    </div>
                )}
            </DialogContent>
        </Dialog>
    );
}