"use client";

/**
 * components/orders/orders-client.tsx (part 1 — queue)
 *
 * T5b — admin orders queue: three tabs (pending badge), search, list
 * (desktop table / mobile cards), load-more via opaque cursor.
 * ADMIN sees the reject control for PENDING_REVIEW; CASHIER is read-only.
 * No approve control exists anywhere in T5b (T5c adds it).
 * Times render in Asia/Damascus via orders-utils. dir=rtl on wrappers.
 *
 * This component owns ALL fetching, including the detail request: the drawer
 * is purely presentational, so opening a row issues exactly one request.
 *
 * Styling: Tailwind + shadcn only (orders.module.css is no longer used here).
 */

import { useCallback, useEffect, useRef, useState, type ComponentType, type KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertCircle, ChevronLeft, Clock, Inbox, Loader2, Package, Phone, Search, SearchX, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSessionWithOfflineFallback } from "@/lib/offline/hooks";
import { cn } from "@/lib/utils";
import { compareMoney, formatMoney } from "@/lib/utils/money";
import { ORDER_STATUS_LABELS, formatOrderTime, orderRefLabel, type OrderStatusValue } from "./orders-utils";
import type { ApproveOrderPayload, ApproveOrderSuccess, InsufficientStockDetail, OrderDetailView, OrderQueuePage, OrderQueueRow } from "./types";
import { OrderDetailDrawer } from "./order-detail-drawer";
import { RejectOrderDialog } from "./reject-order-dialog";
// [T5c] Approval dialog + form hook. Fetching stays here (the parent owns
// all requests); the dialog is presentational + local form state.
import { ApproveOrderDialog } from "./approve-order-dialog";
import { useApproveForm } from "./approve-form";

const PAGE_SIZE = 25;
const SEARCH_DEBOUNCE_MS = 350;
const SEARCH_MAX_LENGTH = 100; // must match the server's q max length
const TABS: OrderStatusValue[] = ["PENDING_REVIEW", "APPROVED", "REJECTED"];

// Entrance animation for list rows: one short stagger per page, skipped when
// the OS asks for reduced motion. Rows already mounted never replay it.
const ROW_ENTER = "motion-safe:animate-in fade-in slide-in-from-bottom-2 duration-300 fill-mode-backwards";
function rowStyle(i: number) {
    return { animationDelay: `${Math.min(i % PAGE_SIZE, 10) * 35}ms` };
}

/** An error whose message is already user-facing Arabic text. */
class UiError extends Error { }

/** Shows e.message only for our own Arabic errors; anything else is generic. */
function toMessage(e: unknown, fallback: string): string {
    return e instanceof UiError ? e.message : fallback;
}

/** Parses a JSON body without throwing (a 500 HTML page must not leak). */
async function readJson<T>(res: Response): Promise<Partial<T> & { message?: string }> {
    return (await res.json().catch(() => ({}))) as Partial<T> & { message?: string };
}

function isPositive(value: string): boolean {
    try {
        return compareMoney(value, 0) > 0;
    } catch {
        return false;
    }
}

/** Enter / Space activates a row that is not a native button. */
function activateOnKey(e: KeyboardEvent<HTMLElement>, fn: () => void) {
    if (e.target !== e.currentTarget) return; // ignore keys from inner controls
    if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        fn();
    }
}

function Totals({ row }: { row: OrderQueueRow }) {
    const parts: string[] = [];
    if (isPositive(row.totalSYP)) {
        parts.push(`${formatMoney(row.totalSYP, "SYP")} ل.س`);
    }
    if (isPositive(row.totalUSD)) {
        parts.push(`$${formatMoney(row.totalUSD, "USD")}`);
    }
    if (parts.length === 0) return <span className="text-zinc-400">—</span>;
    return (
        <span dir="ltr" className="inline-block font-extrabold tabular-nums text-emerald-700">
            {parts.join(" + ")}
        </span>
    );
}

function RefChip({ id }: { id: string }) {
    return (
        <span
            dir="ltr"
            className="inline-block rounded-md bg-zinc-100 px-2 py-0.5 text-xs font-bold tabular-nums text-zinc-700"
        >
            {orderRefLabel(id)}
        </span>
    );
}

function Avatar({ name, className }: { name: string; className?: string }) {
    return (
        <span
            aria-hidden
            className={cn(
                "grid size-10 shrink-0 place-items-center rounded-xl bg-emerald-50 text-sm font-extrabold text-emerald-700 ring-1 ring-inset ring-emerald-100 transition-colors",
                className,
            )}
        >
            {name.trim().charAt(0).toUpperCase() || "؟"}
        </span>
    );
}

function ListSkeleton() {
    return (
        <div aria-busy="true">
            <span className="sr-only">جارٍ التحميل…</span>
            {/* Desktop: rows */}
            <div className="hidden divide-y divide-zinc-100 overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm md:block">
                {Array.from({ length: 5 }).map((_, i) => (
                    <div key={i} className="flex items-center gap-4 px-4 py-4">
                        <div className="h-5 w-16 animate-pulse rounded-md bg-zinc-100" />
                        <div className="size-10 animate-pulse rounded-xl bg-zinc-100" />
                        <div className="h-4 flex-1 animate-pulse rounded bg-zinc-100" />
                        <div className="h-4 w-28 animate-pulse rounded bg-zinc-100" />
                        <div className="h-4 w-20 animate-pulse rounded bg-zinc-100" />
                    </div>
                ))}
            </div>
            {/* Mobile: cards */}
            <div className="space-y-3 md:hidden">
                {Array.from({ length: 3 }).map((_, i) => (
                    <div key={i} className="space-y-3 rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm">
                        <div className="flex items-center gap-3">
                            <div className="size-10 animate-pulse rounded-xl bg-zinc-100" />
                            <div className="flex-1 space-y-2">
                                <div className="h-4 w-1/2 animate-pulse rounded bg-zinc-100" />
                                <div className="h-3 w-1/3 animate-pulse rounded bg-zinc-100" />
                            </div>
                            <div className="h-5 w-14 animate-pulse rounded-md bg-zinc-100" />
                        </div>
                        <div className="h-3 w-3/4 animate-pulse rounded bg-zinc-100" />
                        <div className="h-9 animate-pulse rounded-xl bg-zinc-100" />
                    </div>
                ))}
            </div>
        </div>
    );
}

function StateCard({
    icon: Icon,
    tone = "neutral",
    title,
    children,
}: {
    icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
    tone?: "neutral" | "error";
    title: string;
    children?: React.ReactNode;
}) {
    return (
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-zinc-200 bg-white px-6 py-14 text-center motion-safe:animate-in fade-in zoom-in-95 duration-300">
            <span
                className={cn(
                    "flex size-12 items-center justify-center rounded-2xl motion-safe:animate-in zoom-in-50 duration-500 delay-100 fill-mode-backwards",
                    tone === "error" ? "bg-red-50 text-red-600" : "bg-emerald-50 text-emerald-600",
                )}
            >
                <Icon className="size-6" aria-hidden />
            </span>
            <p className={cn("text-sm font-semibold", tone === "error" ? "text-red-700" : "text-zinc-600")}>{title}</p>
            {children}
        </div>
    );
}

export function OrdersClient() {
    const { data: session } = useSessionWithOfflineFallback();
    const router = useRouter();
    const isAdmin = (session?.role ?? null) === "ADMIN";

    const [tab, setTab] = useState<OrderStatusValue>("PENDING_REVIEW");
    const [searchDraft, setSearchDraft] = useState("");
    const [search, setSearch] = useState("");
    const [appending, setAppending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [reloadToken, setReloadToken] = useState(0);

    // Detail drawer state — owned here, rendered by the presentational drawer.
    const [detailId, setDetailId] = useState<string | null>(null);
    const [detail, setDetail] = useState<OrderDetailView | null>(null);
    const [detailLoading, setDetailLoading] = useState(false);
    const [detailError, setDetailError] = useState<string | null>(null);

    const [rejectTarget, setRejectTarget] = useState<OrderDetailView | null>(null);
    const [rejectBusy, setRejectBusy] = useState(false);
    const [rejectError, setRejectError] = useState<string | null>(null);

    // [T5c] Approval dialog state — owned here with all fetching. The dialog
    // keeps local form state only; submit is disabled while in flight (no
    // double submit). INSUFFICIENT_STOCK preserves the form and marks lines.
    const [approveTarget, setApproveTarget] = useState<OrderDetailView | null>(null);
    const [approveBusy, setApproveBusy] = useState(false);
    const [approveError, setApproveError] = useState<string | null>(null);
    const [approveShort, setApproveShort] = useState<InsufficientStockDetail[]>([]);
    const approveForm = useApproveForm(approveTarget, approveTarget !== null);

    // Monotonic id of the latest detail request: a late response for an older
    // request (or for a drawer that was already closed) is ignored.
    const detailReqRef = useRef(0);

    // Debounced search text (same pattern as sales-log-client).
    const [searchCommitted, setSearchCommitted] = useState("");
    useEffect(() => {
        const next = searchDraft.trim();
        if (next === searchCommitted) return;
        const timer = setTimeout(() => {
            setSearch(next);
            setSearchCommitted(next);
        }, SEARCH_DEBOUNCE_MS);
        return () => clearTimeout(timer);
    }, [searchDraft, searchCommitted, search]);

    // Identifies the request the current UI state is asking for.
    const requestKey = JSON.stringify([tab, search, reloadToken]);
    const [result, setResult] = useState<{
        key: string;
        items: OrderQueueRow[];
        nextCursor: string | null;
        pendingCount: number;
    } | null>(null);
    const items = result?.items ?? [];
    const nextCursor = result?.nextCursor ?? null;
    const pendingCount = result?.pendingCount ?? 0;
    const loading = result?.key !== requestKey;

    // The single list loader — sales-log-client pattern: no setState
    // synchronously in the effect body; loading is derived from requestKey;
    // results stored only from the async callbacks.
    useEffect(() => {
        let cancelled = false;
        const params = new URLSearchParams({ status: tab, limit: String(PAGE_SIZE) });
        if (search) params.set("q", search);
        fetch(`/api/orders?${params.toString()}`)
            .then(async (res) => {
                const data = await readJson<OrderQueuePage>(res);
                if (!res.ok) throw new UiError(data.message || "تعذّر جلب الطلبات.");
                if (!Array.isArray(data.items)) throw new UiError("استجابة غير صالحة من الخادم.");
                if (cancelled) return;
                setError(null);
                setResult({
                    key: requestKey,
                    items: data.items,
                    nextCursor: data.nextCursor ?? null,
                    pendingCount: data.pendingCount ?? 0,
                });
            })
            .catch((e: unknown) => {
                if (cancelled) return;
                setResult((prev) => ({
                    key: requestKey,
                    items: prev?.items ?? [],
                    nextCursor: prev?.nextCursor ?? null,
                    pendingCount: prev?.pendingCount ?? 0,
                }));
                setError(toMessage(e, "تعذّر جلب الطلبات."));
            });
        return () => {
            cancelled = true;
        };
    }, [requestKey, tab, search]);

    const loadMore = useCallback(async () => {
        if (!nextCursor || appending || loading) return;
        const key = requestKey; // the list this "load more" belongs to
        setAppending(true);
        try {
            const params = new URLSearchParams({ status: tab, limit: String(PAGE_SIZE), cursor: nextCursor });
            if (search) params.set("q", search);
            const res = await fetch(`/api/orders?${params.toString()}`);
            const data = await readJson<OrderQueuePage>(res);
            if (!res.ok) throw new UiError(data.message || "تعذّر جلب المزيد.");
            if (!Array.isArray(data.items)) throw new UiError("استجابة غير صالحة من الخادم.");
            const newItems = data.items;
            setResult((prev) => {
                // Tab/search changed (or a reload ran) while this was in flight:
                // drop the stale page instead of mixing it into another list.
                if (!prev || prev.key !== key) return prev;
                return {
                    key,
                    items: [...prev.items, ...newItems],
                    nextCursor: data.nextCursor ?? null,
                    pendingCount: data.pendingCount ?? prev.pendingCount,
                };
            });
        } catch (e) {
            toast.error(toMessage(e, "تعذّر جلب المزيد."));
        } finally {
            setAppending(false);
        }
    }, [nextCursor, appending, loading, tab, search, requestKey]);

    async function loadDetail(id: string) {
        const reqId = ++detailReqRef.current;
        setDetail(null);
        setDetailError(null);
        setDetailLoading(true);
        try {
            const res = await fetch(`/api/orders/${id}`);
            const data = await readJson<{ order: OrderDetailView }>(res);
            if (reqId !== detailReqRef.current) return; // superseded or closed
            if (!res.ok || !data.order) {
                throw new UiError(data.message || "تعذّر جلب تفاصيل الطلب.");
            }
            setDetail(data.order);
        } catch (e) {
            if (reqId !== detailReqRef.current) return;
            setDetailError(toMessage(e, "تعذّر جلب التفاصيل."));
        } finally {
            if (reqId === detailReqRef.current) setDetailLoading(false);
        }
    }

    function openDetail(id: string) {
        setDetailId(id);
        void loadDetail(id);
    }

    function closeDetail() {
        detailReqRef.current += 1; // invalidate any response still in flight
        setDetailId(null);
        setDetail(null);
        setDetailError(null);
        setDetailLoading(false);
    }

    const confirmReject = useCallback(async (reason: string) => {
        if (!rejectTarget) return;
        setRejectBusy(true);
        setRejectError(null);
        try {
            const res = await fetch(`/api/orders/${rejectTarget.id}/reject`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ reason }),
            });
            const data = await readJson<Record<string, never>>(res);
            if (res.status === 409) {
                toast.error("تمت مراجعة هذا الطلب مسبقاً.");
                setRejectTarget(null);
                closeDetail();
                setReloadToken((t) => t + 1);
                return;
            }
            if (!res.ok) throw new UiError(data.message || "تعذّر رفض الطلب.");
            toast.success("تم رفض الطلب.");
            setRejectTarget(null);
            closeDetail();
            setReloadToken((t) => t + 1);
        } catch (e) {
            setRejectError(toMessage(e, "تعذّر رفض الطلب."));
        } finally {
            setRejectBusy(false);
        }
    }, [rejectTarget]);

    const confirmApprove = useCallback(async (payload: ApproveOrderPayload) => {
        if (!approveTarget || approveBusy) return;
        setApproveBusy(true);
        setApproveError(null);
        try {
            const res = await fetch(`/api/orders/${approveTarget.id}/approve`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            });
            const data = await readJson<ApproveOrderSuccess & { code?: string; details?: InsufficientStockDetail[] }>(res);
            if (res.status === 409 && data.code === "ALREADY_REVIEWED") {
                toast.error("تمت مراجعة هذا الطلب مسبقاً.");
                setApproveTarget(null);
                setApproveShort([]);
                closeDetail();
                setReloadToken((t) => t + 1);
                return;
            }
            if (res.status === 409 && data.code === "INSUFFICIENT_STOCK") {
                // Keep the form; mark affected lines with the returned
                // available amounts so the admin can lower and retry.
                setApproveShort(Array.isArray(data.details) ? data.details : []);
                setApproveError(data.message || "المخزون لا يكفي لبعض البنود.");
                return;
            }
            if (!res.ok || !data.success) throw new UiError(data.message || "تعذّر قبول الطلب.");
            toast.success("تم قبول الطلب وإنشاء الفاتورة.", {
                action: { label: "عرض سجل المبيعات", onClick: () => router.push("/dashboard/sales-log") },
            });
            setApproveTarget(null);
            setApproveShort([]);
            closeDetail();
            setReloadToken((t) => t + 1);
        } catch (e) {
            setApproveError(toMessage(e, "تعذّر قبول الطلب."));
        } finally {
            setApproveBusy(false);
        }
    }, [approveTarget, approveBusy, router]);

    const emptyTitle =
        search
            ? "لا توجد نتائج مطابقة للبحث."
            : tab === "PENDING_REVIEW"
                ? "لا توجد طلبات قيد المراجعة."
                : tab === "APPROVED"
                    ? "لا توجد طلبات مقبولة."
                    : "لا توجد طلبات مرفوضة.";

    const tabIndex = Math.max(0, TABS.indexOf(tab));
    const showCount = !loading && !error && items.length > 0;

    return (
        <div className="space-y-4" dir="rtl">
            {/* Tabs: segmented control with a sliding indicator */}
            <div
                className="relative grid w-full grid-cols-3 rounded-2xl bg-zinc-100 p-1 sm:w-md"
                role="tablist"
                aria-label="حالة الطلبات"
            >
                <span
                    aria-hidden
                    className="absolute inset-y-1 rounded-xl bg-emerald-600 shadow-sm shadow-emerald-600/30 transition-[inset-inline-start] duration-300 ease-out motion-reduce:transition-none"
                    style={{
                        width: "calc((100% - 0.5rem) / 3)",
                        insetInlineStart: `calc(0.25rem + ${tabIndex} * (100% - 0.5rem) / 3)`,
                    }}
                />
                {TABS.map((t) => {
                    const active = tab === t;
                    return (
                        <button
                            key={t}
                            type="button"
                            role="tab"
                            aria-selected={active}
                            onClick={() => setTab(t)}
                            className={cn(
                                "relative z-10 inline-flex h-10 items-center justify-center gap-2 rounded-xl px-2 text-sm font-bold transition-colors duration-300 active:scale-[0.97]",
                                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40",
                                active ? "text-white" : "text-zinc-600 hover:text-zinc-900",
                            )}
                        >
                            {ORDER_STATUS_LABELS[t]}
                            {t === "PENDING_REVIEW" && pendingCount > 0 && (
                                <span
                                    key={pendingCount}
                                    className={cn(
                                        "inline-flex min-w-5 items-center justify-center rounded-full px-1.5 text-xs font-extrabold leading-5 transition-colors duration-300 motion-safe:animate-in zoom-in-50",
                                        active ? "bg-white/25 text-white" : "bg-amber-100 text-amber-700",
                                    )}
                                >
                                    {pendingCount.toLocaleString("ar-SY")}
                                </span>
                            )}
                        </button>
                    );
                })}
            </div>

            {/* Search */}
            <div className="group relative">
                <Input
                    className="h-11 rounded-xl border-zinc-200 bg-white ps-10 pe-11 text-sm shadow-sm transition-shadow focus-visible:border-emerald-500 focus-visible:ring-emerald-500/20"
                    placeholder="بحث بالاسم أو المتجر أو الهاتف أو رقم الطلب…"
                    value={searchDraft}
                    maxLength={SEARCH_MAX_LENGTH}
                    onChange={(e) => setSearchDraft(e.target.value)}
                />
                <Search
                    className="pointer-events-none absolute end-3.5 top-1/2 size-4 -translate-y-1/2 text-zinc-400 transition-colors group-focus-within:text-emerald-600"
                    aria-hidden
                />
                {searchDraft && (
                    <button
                        type="button"
                        aria-label="مسح البحث"
                        onClick={() => setSearchDraft("")}
                        className="absolute start-2 top-1/2 grid size-7 -translate-y-1/2 place-items-center rounded-lg text-zinc-400 transition-all hover:bg-zinc-100 hover:text-zinc-700 active:scale-90 motion-safe:animate-in fade-in zoom-in-75 duration-150"
                    >
                        <X className="size-4" aria-hidden />
                    </button>
                )}
            </div>

            {showCount && (
                <p className="px-1 text-xs font-semibold text-zinc-500 motion-safe:animate-in fade-in duration-300">
                    {items.length.toLocaleString("ar-SY")}
                    {nextCursor ? "+" : ""} طلب
                    {search ? ` — نتائج «${search}»` : ""}
                </p>
            )}

            {/* List */}
            {loading ? (
                <ListSkeleton />
            ) : error ? (
                <StateCard icon={AlertCircle} tone="error" title={error}>
                    <Button variant="outline" className="rounded-xl" onClick={() => setReloadToken((t) => t + 1)}>
                        إعادة المحاولة
                    </Button>
                </StateCard>
            ) : items.length === 0 ? (
                <StateCard icon={search ? SearchX : Inbox} title={emptyTitle} />
            ) : (
                <>
                    {/* Desktop table */}
                    <div className="hidden overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm md:block">
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="border-b border-zinc-100 bg-zinc-50/80 text-xs font-bold text-zinc-500">
                                        <th className="px-4 py-3 text-start font-bold">الطلب</th>
                                        <th className="px-4 py-3 text-start font-bold">التاجر</th>
                                        <th className="px-4 py-3 text-start font-bold">الهاتف</th>
                                        <th className="px-4 py-3 text-start font-bold">التاريخ</th>
                                        <th className="px-4 py-3 text-center font-bold">الأصناف</th>
                                        <th className="px-4 py-3 text-start font-bold">القيمة</th>
                                        <th className="w-24 px-4 py-3" />
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-zinc-100">
                                    {items.map((row, i) => (
                                        <tr
                                            key={row.id}
                                            tabIndex={0}
                                            onClick={() => openDetail(row.id)}
                                            onKeyDown={(e) => activateOnKey(e, () => openDetail(row.id))}
                                            className={cn(
                                                "group cursor-pointer transition-colors hover:bg-emerald-50/50 focus-visible:bg-emerald-50/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-500/40",
                                                ROW_ENTER,
                                            )}
                                            style={rowStyle(i)}
                                        >
                                            <td className="px-4 py-3.5"><RefChip id={row.id} /></td>
                                            <td className="px-4 py-3.5">
                                                <div className="flex items-center gap-3">
                                                    <Avatar
                                                        name={row.retailerName}
                                                        className="group-hover:bg-emerald-100"
                                                    />
                                                    <div className="min-w-0">
                                                        <div className="font-bold text-zinc-900">{row.retailerName}</div>
                                                        {row.retailerShopName && (
                                                            <div className="text-xs text-zinc-500">{row.retailerShopName}</div>
                                                        )}
                                                    </div>
                                                </div>
                                            </td>
                                            <td className="px-4 py-3.5 text-zinc-700">
                                                <span dir="ltr" className="inline-block tabular-nums">{row.retailerPhone}</span>
                                            </td>
                                            <td className="px-4 py-3.5 text-zinc-600">
                                                <span dir="ltr" className="inline-block tabular-nums">{formatOrderTime(row.createdAt)}</span>
                                            </td>
                                            <td className="px-4 py-3.5 text-center">
                                                <span className="inline-flex min-w-7 justify-center rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-bold tabular-nums text-zinc-700">
                                                    {row.lineCount.toLocaleString("ar-SY")}
                                                </span>
                                            </td>
                                            <td className="px-4 py-3.5"><Totals row={row} /></td>
                                            <td className="px-4 py-3.5 text-end">
                                                <Button
                                                    type="button"
                                                    variant="outline"
                                                    size="sm"
                                                    className="rounded-lg border-emerald-200 font-bold text-emerald-700 transition-all hover:bg-emerald-600 hover:text-white group-hover:border-emerald-600"
                                                    onClick={(e) => { e.stopPropagation(); openDetail(row.id); }}
                                                >
                                                    عرض
                                                    <ChevronLeft className="size-4 transition-transform group-hover:-translate-x-1" aria-hidden />
                                                </Button>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>

                    {/* Mobile cards: the whole card opens the order */}
                    <div className="space-y-3 md:hidden">
                        {items.map((row, i) => (
                            <div
                                key={row.id}
                                role="button"
                                tabIndex={0}
                                onClick={() => openDetail(row.id)}
                                onKeyDown={(e) => activateOnKey(e, () => openDetail(row.id))}
                                className={cn(
                                    "space-y-3 rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm outline-none transition-all active:scale-[0.99] active:bg-zinc-50 focus-visible:ring-2 focus-visible:ring-emerald-500/40",
                                    ROW_ENTER,
                                )}
                                style={rowStyle(i)}
                            >
                                <div className="flex items-center gap-3">
                                    <Avatar name={row.retailerName} />
                                    <div className="min-w-0 flex-1">
                                        <div className="truncate font-extrabold text-zinc-900">{row.retailerName}</div>
                                        {row.retailerShopName && (
                                            <div className="truncate text-xs text-zinc-500">{row.retailerShopName}</div>
                                        )}
                                    </div>
                                    <RefChip id={row.id} />
                                </div>
                                <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-xl bg-zinc-50 px-3 py-2 text-xs text-zinc-600">
                                    <span className="inline-flex items-center gap-1.5">
                                        <Phone className="size-3.5 text-zinc-400" aria-hidden />
                                        <span dir="ltr" className="tabular-nums">{row.retailerPhone}</span>
                                    </span>
                                    <span className="inline-flex items-center gap-1.5">
                                        <Clock className="size-3.5 text-zinc-400" aria-hidden />
                                        <span dir="ltr" className="tabular-nums">{formatOrderTime(row.createdAt)}</span>
                                    </span>
                                    <span className="inline-flex items-center gap-1.5">
                                        <Package className="size-3.5 text-zinc-400" aria-hidden />
                                        {row.lineCount.toLocaleString("ar-SY")} أصناف
                                    </span>
                                </div>
                                <div className="flex items-center justify-between gap-3">
                                    <span className="text-base"><Totals row={row} /></span>
                                    <Button
                                        type="button"
                                        size="sm"
                                        className="h-9 rounded-xl bg-emerald-600 px-4 font-bold text-white shadow-sm shadow-emerald-600/25 hover:bg-emerald-700"
                                        onClick={(e) => { e.stopPropagation(); openDetail(row.id); }}
                                    >
                                        عرض التفاصيل
                                        <ChevronLeft className="size-4" aria-hidden />
                                    </Button>
                                </div>
                            </div>
                        ))}
                    </div>

                    {nextCursor && (
                        <div className="flex justify-center pt-2">
                            <Button
                                variant="outline"
                                className="h-11 rounded-xl px-8 font-bold transition-transform active:scale-[0.98]"
                                disabled={appending}
                                onClick={() => void loadMore()}
                            >
                                {appending ? (
                                    <><Loader2 className="size-4 animate-spin" aria-hidden /> جارٍ التحميل…</>
                                ) : (
                                    "عرض المزيد"
                                )}
                            </Button>
                        </div>
                    )}
                </>
            )}

            <OrderDetailDrawer
                open={detailId !== null}
                detail={detail}
                loading={detailLoading}
                error={detailError}
                isAdmin={isAdmin}
                onClose={closeDetail}
                onRetry={() => { if (detailId) void loadDetail(detailId); }}
                onReject={(order) => { setRejectError(null); setRejectTarget(order); }}
                onApprove={(order) => { setApproveError(null); setApproveShort([]); setApproveTarget(order); }}
            />
            <RejectOrderDialog
                open={rejectTarget !== null}
                orderRef={rejectTarget ? rejectTarget.orderRef : ""}
                busy={rejectBusy}
                serverError={rejectError}
                onOpenChange={(open) => { if (!open) setRejectTarget(null); }}
                onConfirm={(reason) => void confirmReject(reason)}
            />
            <ApproveOrderDialog
                open={approveTarget !== null}
                order={approveTarget}
                form={approveForm}
                busy={approveBusy}
                serverError={approveError}
                insufficient={approveShort}
                onOpenChange={(open) => { if (!open) { setApproveTarget(null); setApproveShort([]); } }}
                onConfirm={(payload) => void confirmApprove(payload)}
            />
        </div>
    );
}