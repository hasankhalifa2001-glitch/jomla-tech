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
 * follows.
 *
 * [v4.6 — SYP only] This view shows SYP amounts only. The "≈ $" secondary
 * figures (per line, totals, paid, debt) were removed on purpose: they were
 * approximations that crowded every row. The frozen exchange rate line is
 * kept so the invoice's rate remains auditable. The data is still on the
 * row/detail — only its display is gone here.
 *
 * [v4.6 — layout] Header (fixed) / body (scrolls) / footer (print + share).
 * The dialog width needs `sm:max-w-3xl`: DialogContent ships `sm:max-w-lg`,
 * and a plain `max-w-3xl` loses to it from the `sm` breakpoint up, which
 * squeezed everything into ~450px. Lines render as a real table from `sm`
 * (item / qty / unit price / total [/ profit for ADMIN]) and as cards below
 * it; the facts and totals are aligned label/value rows. Light mode only.
 *
 * [v6.2 — PRICE-EDITED LINES, FIX] A line whose listUnitPriceSYP is non-null
 * was sold at a price an ADMIN changed for that one sale. It gets its own
 * full-width row under the line showing: the catalog price (struck through),
 * the final price, the per-unit discount (derived on read as
 * listUnitPriceSYP − unitPriceSYP — nothing about how it was typed is stored)
 * and the line's total discount (per-unit discount × quantity). A final price
 * ABOVE the catalog price is labelled "زيادة" instead of "خصم". On a void
 * line the quantity is negative and the prices are copied unchanged, so the
 * line's total discount comes out negative — it mirrors the original exactly.
 * All arithmetic goes through money.ts. The previous revision of this block
 * had corrupted Arabic text and a grid layout that broke from `sm` up.
 * `listUnitPriceSYP` is read with `== null` / `?? null` on purpose: an older
 * payload that lacks the key (undefined) must mean "no price edit", never a
 * crash inside subtractMoney().
 *
 * [v6.2 — below-cost warning, FIX] The amber "sold below cost" cue now needs a
 * POSITIVE quantity as well as a negative profit. A void line has a negative
 * quantity and (as the mirror of its original) a negative profit, so the old
 * profit-only test flagged EVERY void as "sold below cost". The warning text is
 * also shown once (the phone label OR the inline note, never both).
 */

import { useEffect, useState, type ReactNode } from "react";
import { AlertCircle, Ban, Link2, Loader2, Package, Receipt, Tag } from "lucide-react";

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
import { compareMoney, formatMoney, multiplyMoney, subtractMoney } from "@/lib/utils/money";
import { ReceiptActions } from "@/components/receipts/receipt-actions";
import type { InvoiceDetail, InvoiceDetailItem } from "./types";
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

/** Gentle staggered entrance for the body blocks. */
const RISE = "motion-safe:animate-in fade-in slide-in-from-bottom-2 duration-300 fill-mode-backwards";
const rise = (i: number) => ({ animationDelay: `${i * 60}ms` });

/** A figure that must always read left-to-right (digits, currency). */
function Money({ children, className }: { children: ReactNode; className?: string }) {
    return (
        <span dir="ltr" className={cn("inline-block whitespace-nowrap font-mono tabular-nums", className)}>
            {children}
        </span>
    );
}

/** One label / value cell of the facts grid. */
function Fact({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div className="min-w-0 space-y-1">
            <dt className="text-[11px] font-semibold text-zinc-500">{label}</dt>
            <dd className="wrap-break-word text-sm font-bold text-zinc-900">{children}</dd>
        </div>
    );
}

/**
 * [v6.2] The price-edit breakdown of one line. Rendered only when the line's
 * listUnitPriceSYP is non-null.
 *
 *   perUnitDiff  = listUnitPriceSYP − unitPriceSYP        (> 0 discount, < 0 increase)
 *   lineDiff     = |perUnitDiff| × quantity               (quantity is negative on a void line)
 */
function PriceEditBreakdown({ item }: { item: InvoiceDetailItem }) {
    const listPrice = item.listUnitPriceSYP ?? null;
    if (listPrice === null) return null;

    const perUnitDiff = subtractMoney(listPrice, item.unitPriceSYP);
    const isIncrease = compareMoney(perUnitDiff, 0) < 0;
    const perUnitAbs = isIncrease ? subtractMoney("0", perUnitDiff) : perUnitDiff;
    const lineDiff = multiplyMoney(perUnitAbs, item.quantity);

    const tone = isIncrease
        ? { box: "border-sky-200 bg-sky-50/70", text: "text-sky-800", strong: "text-sky-900" }
        : { box: "border-amber-200 bg-amber-50/70", text: "text-amber-800", strong: "text-amber-900" };

    return (
        <div
            className={cn(
                "col-span-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-lg border px-3 py-2 text-[11px] sm:order-6 sm:col-span-full",
                tone.box
            )}
        >
            <span className={cn("inline-flex items-center gap-1 font-extrabold", tone.text)}>
                <Tag className="h-3 w-3" />
                تعديل سعر
            </span>

            <span className={tone.text}>
                سعر الكتالوج:{" "}
                <Money className="font-bold text-zinc-500 line-through decoration-zinc-400">
                    {formatMoney(listPrice, "SYP")} ل.س
                </Money>
            </span>

            <span className={tone.text}>
                السعر النهائي:{" "}
                <Money className={cn("font-extrabold", tone.strong)}>
                    {formatMoney(item.unitPriceSYP, "SYP")} ل.س
                </Money>
            </span>

            <span className={tone.text}>
                {isIncrease ? "زيادة" : "خصم"} الوحدة:{" "}
                <Money className={cn("font-extrabold", tone.strong)}>
                    {formatMoney(perUnitAbs, "SYP")} ل.س
                </Money>
            </span>

            <span className={tone.text}>
                إجمالي {isIncrease ? "الزيادة" : "الخصم"}:{" "}
                <Money className={cn("font-extrabold", tone.strong)}>
                    {formatMoney(lineDiff, "SYP")} ل.س
                </Money>
            </span>
        </div>
    );
}

function LineItemsTable({ detail }: { detail: InvoiceDetail }) {
    if (detail.items.length === 0) {
        return (
            <p className="rounded-xl border border-dashed border-zinc-300 py-8 text-center text-xs text-zinc-500">
                لا توجد عناصر مسجّلة على هذه الفاتورة.
            </p>
        );
    }

    // [v4.4, T4c2] Profit is ADMIN-only: for a CASHIER the server omits the
    // key entirely, so the column simply does not exist for them.
    const showProfit = detail.items.some((item) => item.profitSYP !== undefined);
    const cols = showProfit
        ? "sm:grid-cols-[minmax(0,1fr)_4rem_8.5rem_8.5rem_7.5rem]"
        : "sm:grid-cols-[minmax(0,1fr)_4rem_8.5rem_8.5rem]";

    return (
        <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white">
            {/* Column headers (sm and up) */}
            <div
                className={cn(
                    "hidden items-center gap-3 border-b border-zinc-200 bg-zinc-50 px-4 py-2.5 text-[11px] font-bold text-zinc-500 sm:grid",
                    cols
                )}
            >
                <span>الصنف</span>
                <span className="text-center">الكمية</span>
                <span className="text-end">سعر الوحدة</span>
                <span className="text-end">الإجمالي</span>
                {showProfit && <span className="text-end">الربح</span>}
            </div>

            <ul className="divide-y divide-zinc-100">
                {detail.items.map((item, i) => {
                    const lineSYP = multiplyMoney(item.unitPriceSYP, item.quantity);
                    // [v6.2] Below cost = a SALE line (quantity > 0) with negative
                    // profit. Never true on a void line (negative quantity).
                    const belowCost =
                        item.profitSYP !== undefined &&
                        compareMoney(item.quantity, "0") > 0 &&
                        compareMoney(item.profitSYP, "0") < 0;

                    return (
                        <li
                            key={item.id}
                            style={rise(i)}
                            className={cn(
                                "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 px-4 py-3",
                                cols,
                                RISE
                            )}
                        >
                            {/* Item + unit */}
                            <div className="min-w-0">
                                <p className="wrap-break-word text-sm font-extrabold leading-snug text-zinc-900">
                                    {item.productName}
                                </p>
                                <span className="mt-1 inline-block rounded-md bg-zinc-100 px-1.5 py-0.5 text-[11px] font-bold text-zinc-600">
                                    {item.unitName}
                                </span>
                            </div>

                            {/* Phones: total top-end. sm+: its own column (order below). */}
                            <div className="text-end sm:order-4">
                                <Money className="text-sm font-extrabold text-zinc-900">
                                    {formatMoney(lineSYP, "SYP")} ل.س
                                </Money>
                            </div>

                            {/* Phones: "qty × unit price" strip. sm+: two columns. */}
                            <div className="col-span-2 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg bg-zinc-50 px-3 py-1.5 text-[11px] text-zinc-600 sm:order-2 sm:contents">
                                <span className="sm:text-center">
                                    <span className="sm:hidden">الكمية </span>
                                    <Money className="font-bold text-zinc-900 sm:text-sm">{item.quantity}</Money>
                                </span>
                                <span className="text-zinc-300 sm:hidden" aria-hidden>×</span>
                                <span className="sm:order-3 sm:text-end">
                                    <span className="sm:hidden">سعر الوحدة </span>
                                    <Money className="font-bold text-zinc-900 sm:text-sm sm:font-semibold sm:text-zinc-700">
                                        {formatMoney(item.unitPriceSYP, "SYP")} ل.س
                                    </Money>
                                </span>
                            </div>

                            {/* [v4.4, T4c2] ADMIN-only per-line profit. [v6.2, Rule 4] Below-cost warning: negative profit = sold below batch cost. ADMIN-only, never blocks the sale. */}
                            {item.profitSYP !== undefined && (
                                <p className={cn(
                                    "col-span-2 text-[11px] font-bold sm:order-5 sm:col-span-1 sm:text-end",
                                    belowCost ? "text-amber-700" : "text-emerald-700"
                                )}>
                                    <span className="sm:hidden">{belowCost ? "بيع بأقل من التكلفة: " : "الربح: "}</span>
                                    <Money className="sm:text-xs">{formatMoney(item.profitSYP, "SYP")} ل.س</Money>
                                    {belowCost && (
                                        <span className="ms-1 hidden text-[10px] opacity-70 sm:inline">أقل من التكلفة</span>
                                    )}
                                </p>
                            )}

                            {/* [v6.2] Catalog price / final price / derived discount.
                                Full-width row under the line (order-6 so it sits
                                after the profit cell on sm+). Renders nothing for
                                a line sold at the catalog price. */}
                            <PriceEditBreakdown item={item} />
                        </li>
                    );
                })}
            </ul>
        </div>
    );
}

/** One aligned label / amount row of the totals panel. */
function TotalLine({
    label,
    tone = "default",
    children,
}: {
    label: string;
    tone?: "default" | "paid" | "debt" | "profit";
    children: ReactNode;
}) {
    return (
        <div className="flex items-center justify-between gap-4 py-2.5">
            <span
                className={cn(
                    "text-xs font-bold",
                    tone === "paid" && "text-emerald-800",
                    tone === "debt" && "text-red-800",
                    tone === "profit" && "text-emerald-800",
                    tone === "default" && "text-zinc-600"
                )}
            >
                {label}
            </span>
            <Money
                className={cn(
                    "text-sm font-extrabold",
                    tone === "paid" && "text-emerald-700",
                    tone === "debt" && "text-red-600",
                    tone === "profit" && "text-emerald-700",
                    tone === "default" && "text-zinc-900"
                )}
            >
                {children}
            </Money>
        </div>
    );
}

function LoadingSkeleton() {
    return (
        <div className="space-y-3 py-1" aria-busy="true">
            <div className="flex items-center justify-center gap-2 pb-1 text-xs text-zinc-500">
                <Loader2 className="h-4 w-4 animate-spin text-emerald-600" />
                <span>جارٍ تحميل تفاصيل الفاتورة...</span>
            </div>
            <div className="h-24 animate-pulse rounded-xl bg-zinc-100" />
            {[0, 1].map((i) => (
                <div key={i} className="h-16 animate-pulse rounded-xl bg-zinc-100" style={{ animationDelay: `${i * 120}ms` }} />
            ))}
            <div className="h-32 animate-pulse rounded-xl bg-zinc-100" style={{ animationDelay: "240ms" }} />
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
    const ready = !loading && !error && detail !== null;

    // [v6.2] True when at least one line was sold at an ADMIN-edited price.
    const hasEditedLines = detail?.items.some((item) => (item.listUnitPriceSYP ?? null) !== null) ?? false;

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            {/* `sm:max-w-3xl`, not `max-w-*`: DialogContent's own `sm:max-w-lg`
                would otherwise win from the sm breakpoint up. */}
            <DialogContent
                className="flex max-h-[92dvh] w-[calc(100%-1.5rem)] flex-col gap-0 overflow-hidden rounded-2xl border-zinc-200 p-0 sm:max-w-3xl"
                dir="rtl"
            >
                <DialogHeader className="gap-0 border-b border-zinc-100 bg-linear-to-b from-emerald-50/70 to-white px-4 pb-3 pt-4 pe-14 text-start sm:px-6">
                    <div className="flex items-center gap-3">
                        <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-emerald-600 text-white shadow-sm shadow-emerald-600/25">
                            <Receipt className="h-5 w-5" />
                        </div>
                        <div className="min-w-0 flex-1">
                            <DialogTitle className="flex flex-wrap items-center gap-x-2 gap-y-1 text-base font-extrabold text-zinc-900">
                                تفاصيل الفاتورة
                                {invoiceId && (
                                    <span
                                        dir="ltr"
                                        className="rounded-md bg-zinc-100 px-2 py-0.5 font-mono text-xs font-bold text-zinc-700"
                                    >
                                        {invoiceReference(invoiceId)}
                                    </span>
                                )}
                                {detail && (
                                    <Badge
                                        variant="outline"
                                        className={cn(
                                            "px-2 py-0.5 text-[10px] font-bold",
                                            INVOICE_STATUS_CLASSES[detail.status]
                                        )}
                                    >
                                        {INVOICE_STATUS_LABELS[detail.status]}
                                    </Badge>
                                )}
                            </DialogTitle>
                            <DialogDescription className="mt-0.5 text-xs text-zinc-500">
                                كل الأصناف المباعة على هذه الفاتورة — شو بايع شو بالتفاصيل.
                            </DialogDescription>
                        </div>
                    </div>
                </DialogHeader>

                {/* Scrollable body */}
                <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 sm:px-6">
                    {loading && <LoadingSkeleton />}

                    {!loading && error && (
                        <div className="flex items-start gap-2.5 rounded-xl border border-red-200 bg-red-50 p-3.5 text-xs font-semibold text-red-700 motion-safe:animate-in fade-in duration-200">
                            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                            <span>{error}</span>
                        </div>
                    )}

                    {ready && detail && (
                        <div className="space-y-5">
                            {/* Facts: one card, two aligned columns */}
                            <dl
                                style={rise(0)}
                                className={cn(
                                    "grid grid-cols-2 gap-x-6 gap-y-4 rounded-xl border border-zinc-200 bg-zinc-50/60 p-4",
                                    RISE
                                )}
                            >
                                <Fact label="التاريخ والوقت">
                                    <span dir="ltr" className="inline-block tabular-nums">
                                        {formatRowTimestamp(detail.createdAt)}
                                    </span>
                                </Fact>
                                <Fact label="الموظف">{detail.user.name}</Fact>
                                <Fact label="الزبون">{detail.customer.name}</Fact>
                                <Fact label="هاتف الزبون">
                                    {detail.customer.phone ? (
                                        <span dir="ltr" className="inline-block tabular-nums">
                                            {detail.customer.phone}
                                        </span>
                                    ) : (
                                        <span className="text-zinc-400">—</span>
                                    )}
                                </Fact>
                            </dl>

                            {/* Void cross-links + reason */}
                            {(detail.voidsInvoiceId || detail.voidedByInvoiceId || detail.voidReason) && (
                                <div
                                    style={rise(1)}
                                    className={cn("space-y-2.5 rounded-xl border border-red-200 bg-red-50/60 p-3.5 text-xs", RISE)}
                                >
                                    {detail.voidReason && (
                                        <p className="flex items-start gap-2 font-bold leading-relaxed text-red-700">
                                            <Ban className="mt-0.5 h-4 w-4 shrink-0" />
                                            <span>سبب الإلغاء: {detail.voidReason}</span>
                                        </p>
                                    )}
                                    {(detail.voidsInvoiceId || detail.voidedByInvoiceId) && (
                                        <div className="flex flex-wrap gap-2">
                                            {detail.voidsInvoiceId && (
                                                <Button
                                                    type="button"
                                                    variant="outline"
                                                    size="sm"
                                                    onClick={() => onNavigate(detail.voidsInvoiceId as string)}
                                                    className="h-8 gap-1.5 rounded-lg border-red-200 bg-white text-[11px] font-bold text-red-700 transition-all hover:bg-red-50 active:scale-95"
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
                                                    className="h-8 gap-1.5 rounded-lg border-red-200 bg-white text-[11px] font-bold text-red-700 transition-all hover:bg-red-50 active:scale-95"
                                                >
                                                    <Link2 className="h-3 w-3" />
                                                    عرض فاتورة الإلغاء {invoiceReference(detail.voidedByInvoiceId)}
                                                </Button>
                                            )}
                                        </div>
                                    )}
                                </div>
                            )}

                            {/* Lines */}
                            <section style={rise(2)} className={cn("space-y-2.5", RISE)}>
                                <div className="flex items-center justify-between gap-2">
                                    <h3 className="flex items-center gap-2 text-sm font-extrabold text-zinc-900">
                                        <span className="grid size-7 place-items-center rounded-lg bg-emerald-50 text-emerald-600">
                                            <Package className="h-4 w-4" />
                                        </span>
                                        الأصناف
                                        {/* [v6.2] at-a-glance marker that this invoice has edited prices */}
                                        {hasEditedLines && (
                                            <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-bold text-amber-800">
                                                <Tag className="h-3 w-3" />
                                                تعديل سعر
                                            </span>
                                        )}
                                    </h3>
                                    <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-bold tabular-nums text-zinc-600">
                                        {detail.items.length.toLocaleString("ar-SY")}
                                    </span>
                                </div>
                                <LineItemsTable detail={detail} />
                            </section>

                            {/* Totals — SYP only. One aligned panel; the grand total
                                is the large figure, everything else is a thin row. */}
                            <section
                                style={rise(3)}
                                className={cn("rounded-xl border border-zinc-200 bg-white px-4 py-1", RISE)}
                            >
                                <div className="flex items-center justify-between gap-4 border-b border-zinc-100 py-3.5">
                                    <span className="text-sm font-extrabold text-zinc-900">إجمالي الفاتورة</span>
                                    <Money className="text-xl font-extrabold text-zinc-900">
                                        {formatMoney(detail.totalSYP, "SYP")} ل.س
                                    </Money>
                                </div>

                                <div className="divide-y divide-zinc-100">
                                    <TotalLine label="المبلغ المدفوع" tone="paid">
                                        {formatMoney(detail.paidAmountSYP, "SYP")} ل.س
                                    </TotalLine>
                                    <TotalLine label="المتبقي على الحساب (دين)" tone="debt">
                                        {formatMoney(detail.debtAmountSYP, "SYP")} ل.س
                                    </TotalLine>
                                    {/* [v4.4, T4c2] ADMIN-only total invoice profit in SYP */}
                                    {detail.totalProfitSYP !== undefined && (
                                        <TotalLine label="إجمالي ربح الفاتورة" tone="profit">
                                            {formatMoney(detail.totalProfitSYP, "SYP")} ل.س
                                        </TotalLine>
                                    )}
                                </div>

                                {/* [v4.9] Omit the rate line entirely when null. */}
                                {detail.exchangeRateUsed !== null && (
                                    <div className="flex items-center justify-between gap-4 border-t border-zinc-100 py-3 text-[11px]">
                                        <span className="text-zinc-500">سعر الصرف المعتمد على الفاتورة</span>
                                        <Money className="font-semibold text-zinc-600">
                                            {formatMoney(detail.exchangeRateUsed, "SYP")} ل.س / $
                                        </Money>
                                    </div>
                                )}
                            </section>
                        </div>
                    )}
                </div>

                {/*
                    [T4f] Print / share for a SERVER-sourced invoice.

                    Rule 1 says thermal printing reads whichever
                    representation is authoritative right now — and for a
                    row in the sales log that is the server Invoice with
                    its InvoiceItems, which is exactly what `detail` is.
                    So the print path here carries server numbers, not a
                    local row's view of them.

                    Share is NOT gated by the local sync state on this
                    surface: this invoice arrived over
                    GET /api/invoices/[id], so it is on the server by
                    construction (see share-gate.ts). When
                    detail.receiptPdfUrl is already set, the share action
                    simply opens that cached file — no raster is rendered
                    and no POST is issued (share-flow.ts's STEP 3).

                    Pinned in the footer so print/share stay in reach
                    however long the invoice is.
                */}
                {ready && detail && (
                    <div className="border-t border-zinc-100 bg-white px-4 py-3 sm:px-6">
                        <ReceiptActions
                            source={{ source: "server", detail }}
                            serverInvoiceId={detail.id}
                        />
                    </div>
                )}
            </DialogContent>
        </Dialog>
    );
}