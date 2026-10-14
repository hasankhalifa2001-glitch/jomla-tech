"use client";

/**
 * components/orders/order-detail-drawer.tsx
 * T5b — detail drawer (presentational). The parent owns fetching, so there is
 * exactly one request per open and no stale-response race here.
 * No approve control (T5c).
 *
 * Responsive (built directly on vaul, so it does not depend on how
 * components/ui/drawer.tsx is styled):
 *  - laptop (lg+, >=1024px): a side panel that slides in from the left, opposite
 *    the nav sidebar, so the orders list stays visible behind it. Lines as a
 *    table, close button in the header.
 *  - tablet / mobile: bottom sheet with a grab handle, lines as stacked cards
 *    (no sideways scroll). Actions are pinned in a footer on every size.
 */

import { useSyncExternalStore, type ComponentType, type ReactNode } from "react";
import {
    AlertTriangle,
    FileText,
    Loader2,
    MessageCircle,
    Package,
    Phone,
    ShieldAlert,
    ShieldCheck,
    UserCheck,
    X,
    XCircle,
} from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Drawer as DrawerPrimitive } from "vaul";
import { cn } from "@/lib/utils";
import { toWhatsAppNumber } from "@/lib/utils/phone";
import { formatMoney } from "@/lib/utils/money";
import { formatOrderTime } from "./orders-utils";
import type { OrderDetailLineView, OrderDetailView } from "./types";
import {
    PRIOR_APPROVAL_BADGE_LABEL,
    NO_PRIOR_APPROVAL_LABEL,
    RETAILER_SIGNAL_WARNING,
} from "@/lib/config/retailer-signal-labels";
import { StatusBadge } from "./status-badge";

// Sections of the open drawer rise in one after another (direct children only).
const REVEAL =
    "[&>*]:motion-safe:animate-in [&>*]:fade-in [&>*]:slide-in-from-bottom-3 [&>*]:duration-300 [&>*]:fill-mode-backwards " +
    "[&>*:nth-child(2)]:[animation-delay:60ms] [&>*:nth-child(3)]:[animation-delay:120ms] " +
    "[&>*:nth-child(4)]:[animation-delay:180ms] [&>*:nth-child(n+5)]:[animation-delay:240ms]";

const DESKTOP_QUERY = "(min-width: 1024px)";

/** True on laptop-size screens. Server snapshot is false (mobile-first). */
function useIsDesktop(): boolean {
    return useSyncExternalStore(
        (notify) => {
            const mq = window.matchMedia(DESKTOP_QUERY);
            mq.addEventListener("change", notify);
            return () => mq.removeEventListener("change", notify);
        },
        () => window.matchMedia(DESKTOP_QUERY).matches,
        () => false,
    );
}

function PriceCell({ line }: { line: OrderDetailLineView }) {
    return line.pricingCurrencySnapshot === "USD" ? (
        <span dir="ltr" className="inline-block tabular-nums">{`$${formatMoney(line.priceWholesaleSnapshot, "USD")}`}</span>
    ) : (
        <span dir="ltr" className="inline-block tabular-nums">{`${formatMoney(line.priceWholesaleSnapshot, "SYP")} ل.س`}</span>
    );
}

function Available({ line }: { line: OrderDetailLineView }) {
    return line.availableInUnit === null ? (
        <span className="text-zinc-400">غير معروف</span>
    ) : (
        <span dir="ltr" className="inline-block tabular-nums">{line.availableInUnit}</span>
    );
}

function ExceedsWarning() {
    return (
        <div className="mt-1 flex items-start gap-1 text-xs font-semibold text-amber-700">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            إجمالي المطلوب من هذا المنتج أكبر من المتاح
        </div>
    );
}

function Section({
    title,
    icon: Icon,
    children,
    className,
}: {
    title?: string;
    icon?: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
    children: ReactNode;
    className?: string;
}) {
    return (
        <section className={cn("space-y-3 rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm", className)}>
            {title && (
                <h3 className="flex items-center gap-2 text-sm font-extrabold text-zinc-900">
                    {Icon && (
                        <span className="flex size-7 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600">
                            <Icon className="size-4" aria-hidden />
                        </span>
                    )}
                    {title}
                </h3>
            )}
            {children}
        </section>
    );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div className="min-w-0 space-y-0.5">
            <dt className="text-xs text-zinc-500">{label}</dt>
            <dd className="break-words text-sm font-semibold text-zinc-900">{children}</dd>
        </div>
    );
}

function MiniStat({ label, children, tone }: { label: string; children: ReactNode; tone?: "good" }) {
    return (
        <div className="min-w-0 rounded-lg bg-zinc-50 px-2.5 py-1.5">
            <dt className="text-[11px] text-zinc-500">{label}</dt>
            <dd className={cn("text-sm font-bold tabular-nums", tone === "good" ? "text-emerald-700" : "text-zinc-900")}>
                {children}
            </dd>
        </div>
    );
}

function StateBox({ children }: { children: ReactNode }) {
    return <div className="flex flex-col items-center gap-3 py-12 text-center text-sm text-zinc-600">{children}</div>;
}

export function OrderDetailDrawer({
    open,
    detail,
    loading,
    error,
    isAdmin,
    onClose,
    onRetry,
    onReject,
}: {
    open: boolean;
    detail: OrderDetailView | null;
    loading: boolean;
    error: string | null;
    isAdmin: boolean;
    onClose: () => void;
    onRetry: () => void;
    onReject: (order: OrderDetailView) => void;
}) {
    const isDesktop = useIsDesktop();
    const wa = detail ? toWhatsAppNumber(detail.retailerPhone) : null;
    const approved = detail?.status === "APPROVED";
    const showCustomer = !!detail && isAdmin && (!!detail.matchedCustomer || detail.candidates.length > 0);
    const showReject = !!detail && isAdmin && detail.status === "PENDING_REVIEW";
    const showInvoice = !!detail && detail.status === "APPROVED" && !!detail.resultingInvoiceId;

    return (
        <DrawerPrimitive.Root
            open={open}
            onOpenChange={(next) => { if (!next) onClose(); }}
            direction={isDesktop ? "left" : "bottom"}
        >
            <DrawerPrimitive.Portal>
                <DrawerPrimitive.Overlay className="fixed inset-0 z-50 bg-black/40" />
                <DrawerPrimitive.Content
                    dir="rtl"
                    aria-describedby={undefined}
                    className={cn(
                        "fixed z-50 flex flex-col bg-zinc-50 outline-none",
                        isDesktop
                            ? "inset-y-0 left-0 h-full w-[min(44rem,94vw)] border-e border-zinc-200 shadow-2xl"
                            : "inset-x-0 bottom-0 max-h-[92dvh] rounded-t-2xl border-t border-zinc-200",
                    )}
                >
                    {!isDesktop && (
                        <div className="mx-auto mt-3 h-1.5 w-12 shrink-0 rounded-full bg-zinc-300" aria-hidden />
                    )}
                    <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col overflow-hidden lg:max-w-none">
                        <header className="flex items-start gap-2 border-b border-zinc-200 px-4 pb-3 pt-3 md:px-6">
                            <DrawerPrimitive.Title className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1.5 text-base font-extrabold text-zinc-900 sm:text-lg">
                                {detail ? (
                                    <>
                                        <span>طلب</span>
                                        <span
                                            dir="ltr"
                                            className="rounded-md bg-zinc-100 px-2 py-0.5 text-sm font-bold tabular-nums text-zinc-700"
                                        >
                                            {detail.orderRef}
                                        </span>
                                        <span className="text-zinc-300" aria-hidden>—</span>
                                        <span className="min-w-0 break-words">{detail.retailerName}</span>
                                        <StatusBadge status={detail.status} className="ms-auto" />
                                    </>
                                ) : (
                                    "تفاصيل الطلب"
                                )}
                            </DrawerPrimitive.Title>
                            {isDesktop && (
                                <DrawerPrimitive.Close asChild>
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        className="size-8 shrink-0 rounded-lg text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"
                                        aria-label="إغلاق"
                                    >
                                        <X className="size-4" aria-hidden />
                                    </Button>
                                </DrawerPrimitive.Close>
                            )}
                        </header>

                        {/* Scrollable body */}
                        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-5 pt-4 md:px-6">
                            {loading ? (
                                <StateBox>
                                    <Loader2 className="size-6 animate-spin text-emerald-600" aria-hidden />
                                    جارٍ التحميل…
                                </StateBox>
                            ) : error ? (
                                <StateBox>
                                    <span className="flex size-12 items-center justify-center rounded-2xl bg-red-50 text-red-600">
                                        <XCircle className="size-6" aria-hidden />
                                    </span>
                                    <p className="font-semibold text-red-700">{error}</p>
                                    <Button variant="outline" className="rounded-xl" onClick={onRetry}>
                                        إعادة المحاولة
                                    </Button>
                                </StateBox>
                            ) : !detail ? (
                                <StateBox>
                                    <Button variant="outline" className="rounded-xl" onClick={onRetry}>
                                        عرض التفاصيل
                                    </Button>
                                </StateBox>
                            ) : (
                                <div className={cn("space-y-3", REVEAL)}>
                                    {/* Retailer + contact */}
                                    <Section>
                                        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
                                            <Field label="التاجر">{detail.retailerName}</Field>
                                            <Field label="الهاتف">
                                                <span dir="ltr" className="inline-block tabular-nums">{detail.retailerPhone}</span>
                                            </Field>
                                            <Field label="المتجر">{detail.retailerShopName ?? "—"}</Field>
                                            <Field label="التاريخ">
                                                <span dir="ltr" className="inline-block tabular-nums">{formatOrderTime(detail.createdAt)}</span>
                                            </Field>
                                            {detail.reviewedAt && (
                                                <Field label="تاريخ المراجعة">
                                                    <span dir="ltr" className="inline-block tabular-nums">{formatOrderTime(detail.reviewedAt)}</span>
                                                </Field>
                                            )}
                                            {detail.reviewedByUserName && (
                                                <Field label="المراجع">{detail.reviewedByUserName}</Field>
                                            )}
                                        </dl>
                                        <div className="flex gap-2 border-t border-zinc-100 pt-3">
                                            <Button asChild variant="outline" size="sm" className="flex-1 rounded-lg font-bold sm:flex-none">
                                                <a href={`tel:${detail.retailerPhone}`}>
                                                    <Phone className="size-4" aria-hidden /> اتصال
                                                </a>
                                            </Button>
                                            {wa && (
                                                <Button
                                                    asChild
                                                    variant="outline"
                                                    size="sm"
                                                    className="flex-1 rounded-lg border-emerald-200 font-bold text-emerald-700 hover:bg-emerald-50 hover:text-emerald-800 sm:flex-none"
                                                >
                                                    <a href={`https://wa.me/${wa}`} target="_blank" rel="noopener noreferrer">
                                                        <MessageCircle className="size-4" aria-hidden /> واتساب
                                                    </a>
                                                </Button>
                                            )}
                                        </div>
                                    </Section>

                                    {/* Lines */}
                                    <Section title="الأصناف" icon={Package}>
                                        {/* Laptop: table */}
                                        <div className="hidden overflow-x-auto rounded-xl border border-zinc-200 lg:block">
                                            <table className="w-full text-sm">
                                                <thead>
                                                    <tr className="bg-zinc-50 text-xs font-bold text-zinc-500">
                                                        <th className="px-3 py-2.5 text-start font-bold">المنتج</th>
                                                        <th className="px-3 py-2.5 text-start font-bold">الوحدة</th>
                                                        <th className="px-3 py-2.5 text-start font-bold">المطلوبة</th>
                                                        {approved && <th className="px-3 py-2.5 text-start font-bold">المعتمدة</th>}
                                                        <th className="px-3 py-2.5 text-start font-bold">السعر</th>
                                                        <th className="px-3 py-2.5 text-start font-bold">المتاح</th>
                                                    </tr>
                                                </thead>
                                                <tbody className="divide-y divide-zinc-100">
                                                    {detail.lines.map((line) => (
                                                        <tr key={line.id} className={cn(line.exceedsAvailability && "bg-amber-50/40")}>
                                                            <td className="px-3 py-3 font-bold text-zinc-900">{line.productName}</td>
                                                            <td className="px-3 py-3 text-zinc-600">{line.unitName}</td>
                                                            <td className="px-3 py-3 font-semibold tabular-nums">
                                                                <span dir="ltr" className="inline-block">{line.quantity}</span>
                                                            </td>
                                                            {approved && (
                                                                <td className="px-3 py-3 font-semibold tabular-nums text-emerald-700">
                                                                    <span dir="ltr" className="inline-block">{line.approvedQuantity ?? "—"}</span>
                                                                </td>
                                                            )}
                                                            <td className="px-3 py-3"><PriceCell line={line} /></td>
                                                            <td className="px-3 py-3">
                                                                <Available line={line} />
                                                                {line.exceedsAvailability && <ExceedsWarning />}
                                                            </td>
                                                        </tr>
                                                    ))}
                                                </tbody>
                                            </table>
                                        </div>

                                        {/* Mobile: one card per line */}
                                        <ul className="space-y-2 lg:hidden">
                                            {detail.lines.map((line) => (
                                                <li
                                                    key={line.id}
                                                    className={cn(
                                                        "space-y-2.5 rounded-xl border p-3",
                                                        line.exceedsAvailability
                                                            ? "border-amber-200 bg-amber-50/40"
                                                            : "border-zinc-200",
                                                    )}
                                                >
                                                    <div className="flex items-start justify-between gap-3">
                                                        <div className="min-w-0">
                                                            <div className="break-words font-bold text-zinc-900">{line.productName}</div>
                                                            <div className="text-xs text-zinc-500">{line.unitName}</div>
                                                        </div>
                                                        <div className="shrink-0 text-sm font-extrabold text-emerald-700">
                                                            <PriceCell line={line} />
                                                        </div>
                                                    </div>
                                                    <dl className={cn("grid gap-2", approved ? "grid-cols-3" : "grid-cols-2")}>
                                                        <MiniStat label="المطلوبة">
                                                            <span dir="ltr" className="inline-block">{line.quantity}</span>
                                                        </MiniStat>
                                                        {approved && (
                                                            <MiniStat label="المعتمدة" tone="good">
                                                                <span dir="ltr" className="inline-block">{line.approvedQuantity ?? "—"}</span>
                                                            </MiniStat>
                                                        )}
                                                        <MiniStat label="المتاح">
                                                            <Available line={line} />
                                                        </MiniStat>
                                                    </dl>
                                                    {line.exceedsAvailability && <ExceedsWarning />}
                                                </li>
                                            ))}
                                        </ul>
                                    </Section>

                                    {/* Signal + suggested customer: side by side on laptop */}
                                    <div className={cn("grid gap-3", showCustomer && "md:grid-cols-2 lg:grid-cols-1")}>
                                        <Section>
                                            <div
                                                className={cn(
                                                    "flex items-start gap-3 rounded-xl p-3 ring-1 ring-inset",
                                                    detail.signal.hasPriorApproval
                                                        ? "bg-emerald-50 ring-emerald-200"
                                                        : "bg-amber-50 ring-amber-200",
                                                )}
                                            >
                                                {detail.signal.hasPriorApproval ? (
                                                    <ShieldCheck className="mt-0.5 size-5 shrink-0 text-emerald-600 motion-safe:animate-in zoom-in-50 duration-500 delay-300 fill-mode-backwards" aria-hidden />
                                                ) : (
                                                    <ShieldAlert className="mt-0.5 size-5 shrink-0 text-amber-600" aria-hidden />
                                                )}
                                                <div className="min-w-0 space-y-1">
                                                    <div
                                                        className={cn(
                                                            "text-sm font-extrabold",
                                                            detail.signal.hasPriorApproval ? "text-emerald-800" : "text-amber-800",
                                                        )}
                                                    >
                                                        {detail.signal.hasPriorApproval
                                                            ? `${PRIOR_APPROVAL_BADGE_LABEL} (${detail.signal.verificationCount.toLocaleString("ar-SY")})`
                                                            : NO_PRIOR_APPROVAL_LABEL}
                                                    </div>
                                                    <div className="text-xs leading-relaxed text-zinc-600">{RETAILER_SIGNAL_WARNING}</div>
                                                </div>
                                            </div>
                                            {detail.otherPendingCount > 0 && (
                                                <p className="text-xs text-zinc-500">
                                                    طلبات أخرى قيد المراجعة:{" "}
                                                    <span className="font-bold text-zinc-700">
                                                        {detail.otherPendingCount.toLocaleString("ar-SY")}
                                                    </span>
                                                </p>
                                            )}
                                        </Section>

                                        {showCustomer && (
                                            <Section title="الزبون المقترح" icon={UserCheck}>
                                                {detail.matchedCustomer && (
                                                    <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
                                                        <Field label="الاسم">{detail.matchedCustomer.name}</Field>
                                                        <Field label="الهاتف">
                                                            <span dir="ltr" className="inline-block tabular-nums">{detail.matchedCustomer.phone}</span>
                                                        </Field>
                                                    </dl>
                                                )}
                                                {detail.candidates.length > 0 && (
                                                    <ul className="divide-y divide-zinc-100 rounded-xl border border-zinc-200 text-sm">
                                                        {detail.candidates.map((c) => (
                                                            <li key={c.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                                                                <span className="min-w-0 break-words font-semibold text-zinc-800">{c.name}</span>
                                                                <span dir="ltr" className="shrink-0 tabular-nums text-zinc-500">{c.phone}</span>
                                                            </li>
                                                        ))}
                                                    </ul>
                                                )}
                                            </Section>
                                        )}
                                    </div>

                                    {detail.status === "REJECTED" && detail.rejectionReason && (
                                        <div className="flex items-start gap-3 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
                                            <XCircle className="mt-0.5 size-5 shrink-0 text-red-600" aria-hidden />
                                            <p className="min-w-0 break-words leading-relaxed">
                                                <span className="font-extrabold">سبب الرفض: </span>
                                                {detail.rejectionReason}
                                            </p>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>

                        {/* Pinned actions: always reachable on a phone, no hunting at the bottom of a long list */}
                        {detail && !loading && !error && (showReject || showInvoice) && (
                            <div className="flex justify-stretch border-t border-zinc-200 bg-white px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 md:justify-start md:px-6">
                                {showReject && (
                                    <Button
                                        className="h-11 w-full rounded-xl bg-red-600 font-bold text-white transition-all hover:bg-red-700 active:scale-[0.98] md:w-auto md:min-w-44"
                                        onClick={() => onReject(detail)}
                                    >
                                        رفض الطلب
                                    </Button>
                                )}
                                {showInvoice && (
                                    <Button
                                        asChild
                                        className="h-11 w-full rounded-xl bg-emerald-600 font-bold text-white transition-all hover:bg-emerald-700 active:scale-[0.98] md:w-auto md:min-w-44"
                                    >
                                        <Link href="/dashboard/sales-log">
                                            <FileText className="size-4" aria-hidden /> عرض الفاتورة في سجل المبيعات
                                        </Link>
                                    </Button>
                                )}
                            </div>
                        )}
                    </div>
                </DrawerPrimitive.Content>
            </DrawerPrimitive.Portal>
        </DrawerPrimitive.Root>
    );
}