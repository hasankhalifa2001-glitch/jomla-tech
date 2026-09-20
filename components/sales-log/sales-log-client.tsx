"use client";

/**
 * components/sales-log/sales-log-client.tsx
 *
 * T4c2 — the Sales / Invoice History Log screen. The tenant-wide,
 * chronological record of every invoice ever created: "what did I actually
 * sell today, to whom, and for how much", including cash sales billed to the
 * system-generated "زبون نقدي" customer, which carry no debt and therefore
 * never appear on T4e's debt-balance-oriented Ledger screen at all.
 *
 * [RELATIONSHIP TO T4e] This is a deliberate, distinct surface, not a
 * duplicate of the Ledger: the Ledger answers "who owes me" (SUM(debtAmountSYP)
 * per customer), this answers "what happened" (every Invoice row,
 * COMPLETED/PENDING_REVIEW/VOIDED alike, undifferentiated by customer).
 *
 * [SERVER IS THE SECURITY BOUNDARY] This component never filters its own
 * data by role. It sends no `userId` at all for a CASHIER session, and
 * GET /api/invoices independently forces userId = session.user.id
 * server-side; GET /api/invoices/[id] independently re-checks ownership for
 * a CASHIER opening an id directly. `isAdmin` here only decides which
 * CONTROLS exist (staff filter, void button) — a forged request that ignores
 * it still fails on the server.
 *
 * [PAGINATION] Cursor-based, 25 rows per request (the API caps `limit` at
 * 100). "Load more" raises the requested page depth and the loader re-walks
 * from the top to that depth rather than appending a cursor page.
 *
 *   Why re-walk instead of append: creating a void INSERTS a new row at the
 *   top of the (createdAt desc, id desc) window. Every cursor after that
 *   point then shifts by one, so appending "the next page after cursor X"
 *   would silently skip exactly one older invoice per newly inserted row —
 *   quietly breaking the "every invoice appears exactly once" guarantee
 *   right after a void, which is the single most likely moment for the user
 *   to notice. Re-walking a bounded depth (the user's own scroll depth) is
 *   idempotent and correct, and the depth stays small in practice.
 *
 * The initial response is never the whole tenant history — see the
 * acceptance criterion in the API's MAX_LIMIT / DEFAULT_LIMIT.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ListFilter, Loader2, RefreshCw, ScrollText, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { useSessionWithOfflineFallback } from "@/lib/offline/hooks";
import { cn } from "@/lib/utils";
import { DateRangePicker, type DateRangeValue } from "./date-range-picker";
import { InvoiceDetailModal } from "./invoice-detail-modal";
import { InvoiceLogTable } from "./invoice-log-table";
import { VoidInvoiceModal } from "./void-invoice-modal";
import {
    INVOICE_STATUS_LABELS,
    PAYMENT_STATUS_LABELS,
    todayLocalRange,
} from "./sales-log-utils";
import type {
    InvoiceLogPage,
    InvoiceLogRow,
    InvoiceStatusValue,
    PaymentStatusBadgeValue,
    StaffOption,
} from "./types";

/** Server default is 25 and hard-caps at 100 — see app/api/invoices/route.ts. */
const PAGE_SIZE = 25;

type StatusFilter = InvoiceStatusValue | "ALL";
type PaymentFilter = PaymentStatusBadgeValue | "ALL";

export function SalesLogClient() {
    const { data: session, status: sessionStatus } = useSessionWithOfflineFallback();

    // Read primitives, never the session OBJECT, into effect dependencies:
    // useSessionWithOfflineFallback() builds a fresh result object on every
    // render, so depending on `session` would re-run the loader forever.
    const role = session?.role ?? null;
    const isAdmin = role === "ADMIN";
    const isSessionResolved = sessionStatus !== "loading";

    // REQUIRED filter, defaults to today — computed in the BROWSER's local
    // timezone and always sent explicitly (see sales-log-utils.ts).
    const [range, setRange] = useState<DateRangeValue>(() => todayLocalRange());
    const [statusFilter, setStatusFilter] = useState<StatusFilter>("ALL");
    const [paymentFilter, setPaymentFilter] = useState<PaymentFilter>("ALL");
    const [staffFilter, setStaffFilter] = useState<string>("ALL");
    const [staffOptions, setStaffOptions] = useState<StaffOption[]>([]);

    const [rows, setRows] = useState<InvoiceLogRow[]>([]);
    const [nextCursor, setNextCursor] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [reloadToken, setReloadToken] = useState(0);

    const [detailInvoiceId, setDetailInvoiceId] = useState<string | null>(null);
    const [voidTarget, setVoidTarget] = useState<InvoiceLogRow | null>(null);

    // How many 25-row pages the user has currently paged through. Reset to 1
    // by every filter change; left untouched by a post-void re-fetch so the
    // user keeps their position (see the file header's re-walk rationale).
    const pagesLoadedRef = useRef(1);

    const buildQuery = useCallback(
        (cursor: string | null) => {
            const params = new URLSearchParams();
            params.set("from", range.from.toISOString());
            params.set("to", range.to.toISOString());
            params.set("limit", String(PAGE_SIZE));
            if (statusFilter !== "ALL") params.set("status", statusFilter);
            if (paymentFilter !== "ALL") params.set("paymentStatus", paymentFilter);
            // Never sent for a CASHIER: the server forces their own id anyway,
            // and not sending it makes the intended scope explicit at the one
            // place a future refactor might be tempted to "simplify" it away.
            if (isAdmin && staffFilter !== "ALL") params.set("userId", staffFilter);
            if (cursor) params.set("cursor", cursor);
            return params;
        },
        [isAdmin, paymentFilter, range, staffFilter, statusFilter]
    );

    /**
     * Fetches `count` consecutive cursor pages, always starting from the
     * newest invoice, and returns them flattened. Never fetches more than
     * `count * PAGE_SIZE` rows, and stops early if the server reports the
     * window is exhausted.
     */
    const loadPages = useCallback(
        async (count: number) => {
            const collected: InvoiceLogRow[] = [];
            let cursor: string | null = null;
            let lastCursor: string | null = null;

            for (let page = 0; page < count; page++) {
                const res = await fetch(`/api/invoices?${buildQuery(cursor).toString()}`);
                const data = await res.json().catch(() => ({}));
                if (!res.ok || !data.success) {
                    throw new Error(data.message || "تعذّر جلب سجل الفواتير.");
                }

                const payload = data as unknown as InvoiceLogPage;
                collected.push(...payload.items);
                lastCursor = payload.nextCursor ?? null;

                if (!lastCursor || payload.items.length === 0) break;
                cursor = lastCursor;
            }

            return { items: collected, nextCursor: lastCursor };
        },
        [buildQuery]
    );

    // The single loader. Runs on: session resolution, any filter change
    // (buildQuery identity), and an explicit reload (post-void, refresh).
    useEffect(() => {
        if (!isSessionResolved || !role) return;

        let cancelled = false;
        setLoading(true);

        loadPages(pagesLoadedRef.current)
            .then((result) => {
                if (cancelled) return;
                setRows(result.items);
                setNextCursor(result.nextCursor);
            })
            .catch((error: unknown) => {
                if (cancelled) return;
                setRows([]);
                setNextCursor(null);
                toast.error(error instanceof Error ? error.message : "تعذّر جلب سجل الفواتير.");
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });

        return () => {
            cancelled = true;
        };
    }, [isSessionResolved, loadPages, reloadToken, role]);

    // ADMIN-only staff filter options, from the already-existing ADMIN-gated
    // GET /api/staff. A CASHIER never requests this endpoint at all.
    useEffect(() => {
        if (!isAdmin) {
            setStaffOptions([]);
            return;
        }

        let cancelled = false;
        fetch("/api/staff")
            .then(async (res) => {
                const data = await res.json().catch(() => ({}));
                if (cancelled || !res.ok || !data.success) return;
                setStaffOptions((data.users as StaffOption[]) || []);
            })
            .catch(() => {
                // Silent by design: the staff filter simply stays at "كل
                // الموظفين". Failing loudly here would show an error banner
                // for a secondary control while the log itself loaded fine.
            });

        return () => {
            cancelled = true;
        };
    }, [isAdmin]);

    // Every filter change resets the paging depth, then changes one filter
    // state — one batched render, one reload.
    const resetPaging = () => {
        pagesLoadedRef.current = 1;
    };

    const handleLoadMore = () => {
        pagesLoadedRef.current += 1;
        setReloadToken((token) => token + 1);
    };

    const handleRefresh = () => setReloadToken((token) => token + 1);

    // Post-void: re-fetch in place, keeping the user's current page depth so
    // both the new VOIDED row and the now-cross-linked original appear.
    const handleVoidSuccess = () => setReloadToken((token) => token + 1);

    const hasMore = Boolean(nextCursor) && !loading;

    return (
        <section className="space-y-4">
            {/* Header */}
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex items-start gap-3">
                    <div className="rounded-xl bg-emerald-100 p-2.5 dark:bg-emerald-950/40">
                        <ScrollText className="h-6 w-6 text-emerald-600 dark:text-emerald-400" />
                    </div>
                    <div>
                        <h1 className="text-xl font-bold text-zinc-900 dark:text-zinc-100">سجل المبيعات</h1>
                        <p className="mt-0.5 text-xs text-zinc-500">
                            كل فاتورة أُنشئت في المتجر — نقدية أو على الحساب، بما فيها الفواتير الملغاة.
                        </p>
                    </div>
                </div>

                <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleRefresh}
                    disabled={loading}
                    className="h-9 gap-1.5 text-xs font-semibold"
                >
                    {loading ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                        <RefreshCw className="h-3.5 w-3.5" />
                    )}
                    <span>تحديث</span>
                </Button>
            </div>

            {/* CASHIER scope notice — the restriction itself is enforced
                server-side; this only tells the user why the list is smaller
                than the store's full history. */}
            {role === "CASHIER" && (
                <div className="flex items-start gap-2 rounded-lg border border-blue-200 bg-blue-50/60 p-2.5 text-[11px] font-medium text-blue-800 dark:border-blue-900 dark:bg-blue-950/20 dark:text-blue-300">
                    <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>تظهر هنا فواتيرك أنت فقط. يمكن لمدير المتجر عرض فواتير جميع الموظفين.</span>
                </div>
            )}

            {/* Filters */}
            <div className="flex flex-wrap items-end gap-3 rounded-xl border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
                <div className="flex flex-col gap-1.5">
                    <Label className="text-[11px] font-bold text-zinc-500">الفترة الزمنية</Label>
                    <DateRangePicker
                        value={range}
                        disabled={loading}
                        onChange={(next) => {
                            resetPaging();
                            setRange(next);
                        }}
                    />
                </div>

                <div className="flex flex-col gap-1.5">
                    <Label className="text-[11px] font-bold text-zinc-500">حالة الفاتورة</Label>
                    <Select
                        value={statusFilter}
                        onValueChange={(value: StatusFilter) => {
                            resetPaging();
                            setStatusFilter(value);
                        }}
                    >
                        <SelectTrigger className="h-9 w-42.5 text-xs font-medium">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent dir="rtl">
                            <SelectItem value="ALL" className="text-xs">
                                كل الحالات
                            </SelectItem>
                            {(Object.keys(INVOICE_STATUS_LABELS) as InvoiceStatusValue[]).map((value) => (
                                <SelectItem key={value} value={value} className="text-xs">
                                    {INVOICE_STATUS_LABELS[value]}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>

                <div className="flex flex-col gap-1.5">
                    <Label className="text-[11px] font-bold text-zinc-500">حالة الدفع</Label>
                    <Select
                        value={paymentFilter}
                        onValueChange={(value: PaymentFilter) => {
                            resetPaging();
                            setPaymentFilter(value);
                        }}
                    >
                        <SelectTrigger className="h-9 w-42.5 text-xs font-medium">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent dir="rtl">
                            <SelectItem value="ALL" className="text-xs">
                                كل حالات الدفع
                            </SelectItem>
                            {(Object.keys(PAYMENT_STATUS_LABELS) as PaymentStatusBadgeValue[]).map((value) => (
                                <SelectItem key={value} value={value} className="text-xs">
                                    {PAYMENT_STATUS_LABELS[value]}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>

                {/* ADMIN-only per T2b's Role Capability Matrix. Absent — not
                    disabled — for a CASHIER, who is server-side scoped to
                    their own invoices regardless. The options come from the
                    already-existing ADMIN-gated GET /api/staff. */}
                {isAdmin && (
                    <div className="flex flex-col gap-1.5">
                        <Label className="text-[11px] font-bold text-zinc-500">الموظف</Label>
                        <Select
                            value={staffFilter}
                            onValueChange={(value: string) => {
                                resetPaging();
                                setStaffFilter(value);
                            }}
                        >
                            <SelectTrigger className="h-9 w-45 text-xs font-medium">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent dir="rtl">
                                <SelectItem value="ALL" className="text-xs">
                                    كل الموظفين
                                </SelectItem>
                                {staffOptions.map((staff) => (
                                    <SelectItem key={staff.id} value={staff.id} className="text-xs">
                                        {staff.name}
                                        {staff.role === "ADMIN" ? " (مدير)" : ""}
                                        {!staff.isActive ? " — معطّل" : ""}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                )}
            </div>

            {/* Results summary + pagination state */}
            <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-zinc-500">
                <span
                    className={cn(
                        "inline-flex items-center gap-1.5 font-semibold",
                        !loading && rows.length === 0 && "text-zinc-400"
                    )}
                >
                    <ListFilter className="h-3.5 w-3.5" />
                    {loading
                        ? "جارٍ الجلب..."
                        : `عرض ${rows.length.toLocaleString("ar-SY")} فاتورة`}
                </span>
                <span>مرتّبة من الأحدث إلى الأقدم — 25 فاتورة في كل صفحة.</span>
            </div>

            <InvoiceLogTable
                rows={rows}
                loading={loading}
                isAdmin={isAdmin}
                onOpenDetail={setDetailInvoiceId}
                onVoid={setVoidTarget}
            />

            {hasMore && (
                <div className="flex justify-center">
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={handleLoadMore}
                        className="h-9 gap-1.5 text-xs font-bold"
                    >
                        <Loader2 className="h-3.5 w-3.5" />
                        <span>تحميل المزيد</span>
                    </Button>
                </div>
            )}

            {/* Per-line detail view — "شو بايع شو بالتفاصيل". Cross-links
                (original ↔ void) navigate by re-pointing this same modal. */}
            <InvoiceDetailModal
                invoiceId={detailInvoiceId}
                onOpenChange={(open) => {
                    if (!open) setDetailInvoiceId(null);
                }}
                onNavigate={setDetailInvoiceId}
            />

            {/* ADMIN-only void flow — T4d's POST /api/ledger/voids. */}
            <VoidInvoiceModal
                open={Boolean(voidTarget)}
                onOpenChange={(open) => {
                    if (!open) setVoidTarget(null);
                }}
                invoice={voidTarget}
                onSuccess={handleVoidSuccess}
            />
        </section>
    );
}




