"use client";

/**
 * components/dashboard/analytics-client.tsx
 *
 * T4h — the /dashboard screen: KPI cards, the sales/profit trend, the two
 * independently sortable Top-5 product lists, and the actionable alerts.
 *
 * [SERVER IS THE SECURITY BOUNDARY] This component never decides what a role
 * may see. It simply fetches GET /api/analytics; the route calls
 * assertRolePermission("dashboard:analytics") BEFORE reading any row, so a
 * CASHIER calling the endpoint directly is rejected server-side with a 403
 * body that contains no figure at all. The `isAdmin` read below only decides
 * what is worth RENDERING while the session is still resolving — a forged
 * request that skips this component entirely still fails on the server.
 * (middleware.ts independently bounces a CASHIER's browser away from
 * /dashboard before this file ever mounts.)
 *
 * [TOGGLES] Both toggles are local state that re-issues the same endpoint:
 *   - range 7/30 → `?range=` (the trend re-fetches; product rankings always
 *     come back over the data layer's fixed 30-day window, so flipping this
 *     never silently re-orders the Top-5 lists);
 *   - Top-selling "by value" vs "by quantity" → purely a VIEW choice over the
 *     two pre-ranked arrays the server already returned, so it is instant.
 *
 * [LOADING IS DERIVED, NOT STORED] — same pattern as sales-log-client.tsx:
 * every request is identified by a `requestKey` built from the inputs that
 * shape it (role + range). `isLoading` is simply "no completed result for the
 * CURRENT key yet", so a toggle flips the spinner in the same render it
 * changes the query, with no flicker of a stale non-loading state, and the
 * previous screen stays visible while the next one loads.
 *
 * [FAILURE NEVER WIPES GOOD DATA] — the catch handler keeps whatever the last
 * successful load produced and only surfaces a toast + error banner, instead
 * of blanking a populated dashboard because one refresh hiccuped.
 *
 * NO dark-mode classes in this file (light-only shell styling, matching the
 * sales-log screen's own note). Decimal strings are converted to `Number` ONLY
 * at the recharts boundary — display-only, never fed back into a calculation.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
    AlertTriangle,
    Clock,
    Coins,
    Loader2,
    PackageX,
    Receipt,
    RefreshCw,
    ShieldCheck,
    ShoppingBag,
    Users,
    Wallet,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
    ChartContainer,
    ChartTooltip,
    ChartTooltipContent,
    type ChartConfig,
} from "@/components/ui/chart";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import { useSessionWithOfflineFallback } from "@/lib/offline/hooks";
import { formatMoney } from "@/lib/utils/money";

// ---------------------------------------------------------------------------
// Response shape — mirrors lib/data/analytics.ts's AnalyticsDashboard. Kept
// local rather than imported so no server module is pulled into this bundle
// (the same reason components/sales-log/types.ts re-declares its own DTOs).
// ---------------------------------------------------------------------------

type Range = 7 | 30;

interface Kpis {
    salesSYP: string;
    salesUSD?: string;
    netProfitSYP: string;
    invoiceCount: number;
    outstandingDebtSYP: string;
}

interface TrendPoint {
    date: string;
    salesSYP: string;
    profitSYP: string;
}

interface ProductAggregate {
    productId: string;
    productName: string;
    salesSYP: string;
    quantity: string;
    profitSYP: string;
}

interface AlertList<T> {
    count: number;
    items: T[];
}

interface NeedsReconciliationAlert {
    productId: string;
    productName: string;
    batchNumber: string;
    quantity: string;
    unitName: string;
}

interface ExpiringSoonAlert {
    productName: string;
    batchNumber: string;
    expiryDate: string;
    daysToExpiry: number;
    quantity: string;
    unitName: string;
}

interface LargeBalanceAlert {
    customerId: string;
    customerName: string;
    balanceSYP: string;
}

interface DashboardPayload {
    range: Range;
    exchangeRate: string | null;
    kpis: Kpis;
    trend: TrendPoint[];
    topProducts: {
        bySalesValue: ProductAggregate[];
        byQuantity: ProductAggregate[];
        byProfit: ProductAggregate[];
    };
    alerts: {
        needsReconciliation: AlertList<NeedsReconciliationAlert>;
        expiringSoon: AlertList<ExpiringSoonAlert>;
        largeBalances: AlertList<LargeBalanceAlert>;
    };
}

const chartConfig = {
    sales: { label: "المبيعات", color: "#059669" },
    profit: { label: "الربح", color: "#2563eb" },
} satisfies ChartConfig;

/** "2026-10-05" → "05/10" — derived from the string, never parsed as a Date,
 *  so no browser timezone can shift a UTC bucket onto a neighbouring day. */
function axisLabel(date: string): string {
    return `${date.slice(8, 10)}/${date.slice(5, 7)}`;
}

function money(value: string, currency: "SYP" | "USD"): string {
    return `${formatMoney(value, currency)} ${currency === "SYP" ? "ل.س" : "$"}`;
}

export function DashboardAnalyticsClient() {
    const { data: session, status } = useSessionWithOfflineFallback();
    const role = session?.role ?? null;

    const [range, setRange] = useState<Range>(7);
    const [result, setResult] = useState<{ key: string; data: DashboardPayload | null } | null>(null);
    const [error, setError] = useState<string | null>(null);

    const requestKey = `${role ?? "anon"}:${range}`;

    const load = useCallback(async () => {
        try {
            const res = await fetch(`/api/analytics?range=${range}`, { cache: "no-store" });
            const json = (await res.json()) as { message?: string };
            if (!res.ok) {
                throw new Error(json?.message || "تعذر تحميل مؤشرات لوحة التحكم.");
            }
            setResult({ key: requestKey, data: json as unknown as DashboardPayload });
            setError(null);
        } catch (e) {
            // Fold the failure into whatever the previous load produced — never
            // blank a populated dashboard (see the file header).
            setResult((prev) =>
                prev && prev.key === requestKey ? prev : { key: requestKey, data: null }
            );
            setError(e instanceof Error ? e.message : "حدث خطأ غير متوقع.");
            toast.error("تعذر تحديث مؤشرات لوحة التحكم.");
        }
    }, [range, requestKey]);

    useEffect(() => {
        // Role must be known first: an anonymous/pending session has no
        // business calling an ADMIN-only endpoint.
        if (!role) return;
        let cancelled = false;
        void (async () => {
            if (cancelled) return;
            await load();
        })();
        return () => {
            cancelled = true;
        };
    }, [role, load]);

    const data = result?.key === requestKey ? result.data : null;
    const isLoading = !result || result.key !== requestKey;

    const onRangeChange = useCallback((value: string) => {
        if (value === "7") setRange(7);
        else if (value === "30") setRange(30);
    }, []);

    const trendData = useMemo(
        () =>
            (data?.trend ?? []).map((p) => ({
                date: p.date,
                // Display-only conversion for recharts; never fed back into math.
                sales: Number(p.salesSYP),
                profit: Number(p.profitSYP),
            })),
        [data]
    );

    const refresh = useCallback(() => {
        setError(null);
        void load();
    }, [load]);

    const locked = status === "loading";
    // A session that never resolved an identity, or a non-ADMIN one, has no
    // business fetching this endpoint at all (the route rejects it anyway).
    const unauthorized = !locked && role !== "ADMIN";

    if (locked) return <DashboardSkeleton />;
    if (unauthorized && !data) return <ForbiddenPanel />;


    return (
        <section className="space-y-5">
            <header className="flex flex-wrap items-center justify-between gap-3">
                <div>
                    <h1 className="text-2xl font-semibold text-zinc-900">
                        لوحة تحليلات البيانات
                    </h1>
                    {data?.exchangeRate && (
                        <p className="mt-1 text-xs text-zinc-500">
                            تقديرات بالدولار حسب سعر صرف اليوم —{" "}
                            {formatMoney(data.exchangeRate, "SYP")} ل.س لكل $1
                        </p>
                    )}
                </div>

                <div className="flex items-center gap-2">
                    <ToggleGroup
                        type="single"
                        variant="outline"
                        value={String(range)}
                        onValueChange={onRangeChange}
                        aria-label="نافذة المخطط الزمنية"
                    >
                        <ToggleGroupItem value="7">آخر ٧ أيام</ToggleGroupItem>
                        <ToggleGroupItem value="30">آخر ٣٠ يوم</ToggleGroupItem>
                    </ToggleGroup>
                    <Button
                        variant="outline"
                        size="icon"
                        onClick={refresh}
                        disabled={isLoading}
                        aria-label="تحديث"
                    >
                        {isLoading ? (
                            <Loader2 className="size-4 animate-spin" aria-hidden />
                        ) : (
                            <RefreshCw className="size-4" aria-hidden />
                        )}
                    </Button>
                </div>
            </header>

            {error && (
                <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                    <AlertTriangle className="size-4 shrink-0" aria-hidden />
                    <span>{error}</span>
                </div>
            )}

            {isLoading && !data && <DashboardSkeleton />}

            {data && (
                <>
                    <KpiCards kpis={data.kpis} />
                    <TrendCard data={trendData} />
                    <div className="grid gap-5 lg:grid-cols-2">
                        <TopSellingCard rows={data.topProducts} />
                        <TopProfitableCard rows={data.topProducts.byProfit} />
                    </div>
                    <AlertsCard alerts={data.alerts} />
                </>
            )}
        </section>
    );
}

/**
 * Rendered when the session is not an ADMIN — the endpoint rejects this
 * caller regardless (assertRolePermission runs before any read), so this is
 * purely to avoid showing a spinner while the server says no.
 */
function ForbiddenPanel() {
    return (
        <section className="space-y-4">
            <h1 className="text-2xl font-semibold text-zinc-900">لوحة تحليلات البيانات</h1>
            <Card>
                <CardContent className="flex items-center gap-3 text-sm text-zinc-700">
                    <ShieldCheck className="size-5 shrink-0 text-emerald-600" aria-hidden />
                    <span>مؤشرات التحليلات متاحة لمدير المتجر فقط.</span>
                </CardContent>
            </Card>
        </section>
    );
}

function KpiCard({
    title,
    value,
    caption,
    icon,
    tone,
}: {
    title: string;
    value: string;
    caption?: string;
    icon: React.ReactNode;
    tone: "emerald" | "blue" | "red" | "zinc";
}) {
    const ring =
        tone === "emerald"
            ? "border-emerald-200 bg-emerald-50/70 text-emerald-700"
            : tone === "blue"
                ? "border-blue-200 bg-blue-50/70 text-blue-700"
                : tone === "red"
                    ? "border-red-200 bg-red-50/70 text-red-700"
                    : "border-zinc-200 bg-zinc-50 text-zinc-700";

    return (
        <Card>
            <CardContent className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <p className="text-xs font-medium text-zinc-500">{title}</p>
                    <p className="mt-1 truncate text-xl font-semibold tabular-nums text-zinc-900">
                        {value}
                    </p>
                    {caption && <p className="mt-0.5 text-xs text-zinc-500">{caption}</p>}
                </div>
                <span
                    className={`flex size-9 shrink-0 items-center justify-center rounded-lg border ${ring}`}
                    aria-hidden
                >
                    {icon}
                </span>
            </CardContent>
        </Card>
    );
}

function KpiCards({ kpis }: { kpis: Kpis }) {
    return (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <KpiCard
                title="مبيعات اليوم"
                // SYP is authoritative; USD is the secondary, informational
                // approximation — the API only sends it when a valid rate exists.
                value={money(kpis.salesSYP, "SYP")}
                caption={
                    kpis.salesUSD !== undefined
                        ? `≈ ${money(kpis.salesUSD, "USD")}`
                        : "لا يوجد سعر صرف صالح للتقريب"
                }
                icon={<ShoppingBag className="size-5" />}
                tone="emerald"
            />
            <KpiCard
                title="صافي ربح اليوم"
                value={money(kpis.netProfitSYP, "SYP")}
                caption="المبيعات ناقص التكلفة المجمّدة للأصناف"
                icon={<Coins className="size-5" />}
                tone="blue"
            />
            <KpiCard
                title="إجمالي ديون الزبائن"
                value={money(kpis.outstandingDebtSYP, "SYP")}
                caption="صافي المستحقات حسب دفتر الديون"
                icon={<Wallet className="size-5" />}
                tone="red"
            />
            <KpiCard
                title="فواتير اليوم"
                value={String(kpis.invoiceCount)}
                caption="عدد فواتير المبيعات الصادرة اليوم"
                icon={<Receipt className="size-5" />}
                tone="zinc"
            />
        </div>
    );
}

/** Compact, locale-neutral axis formatter — SYP figures reach the hundreds of
 *  thousands, and a fully grouped 8-digit label would crowd the axis. */
function axisMoney(value: number): string {
    const abs = Math.abs(value);
    if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
    if (abs >= 1_000) return `${Math.round(value / 1_000)}k`;
    return String(value);
}

function TrendCard({ data }: { data: Array<{ date: string; sales: number; profit: number }> }) {
    return (
        <Card>
            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
                <CardTitle>اتجاه المبيعات والأرباح</CardTitle>
                <span className="flex items-center gap-4 text-xs text-zinc-500">
                    <span className="flex items-center gap-1.5">
                        <span className="size-2.5 rounded-full bg-emerald-600" aria-hidden />
                        المبيعات
                    </span>
                    <span className="flex items-center gap-1.5">
                        <span className="size-2.5 rounded-full bg-blue-600" aria-hidden />
                        الربح
                    </span>
                </span>
            </CardHeader>
            <CardContent>
                {data.length === 0 ? (
                    <p className="py-12 text-center text-sm text-zinc-500">
                        لا توجد بيانات مبيعات خلال هذه النافذة الزمنية.
                    </p>
                ) : (
                    <ChartContainer config={chartConfig} className="h-65 w-full">
                        <LineChart data={data} margin={{ top: 8, right: 8, left: 4, bottom: 0 }}>
                            <CartesianGrid vertical={false} strokeDasharray="3 3" />
                            <XAxis
                                dataKey="date"
                                tickFormatter={axisLabel}
                                tickLine={false}
                                axisLine={false}
                                interval="preserveStartEnd"
                            />
                            <YAxis
                                tickLine={false}
                                axisLine={false}
                                width={56}
                                tickFormatter={axisMoney}
                            />
                            <ChartTooltip content={<ChartTooltipContent />} />
                            <Line
                                dataKey="sales"
                                type="monotone"
                                stroke="var(--color-sales)"
                                strokeWidth={2}
                                dot={false}
                                name="المبيعات"
                            />
                            <Line
                                dataKey="profit"
                                type="monotone"
                                stroke="var(--color-profit)"
                                strokeWidth={2}
                                dot={false}
                                name="الربح"
                            />
                        </LineChart>
                    </ChartContainer>
                )}
            </CardContent>
        </Card>
    );
}

/** Shared Top-N renderer. `metric` decides which figure is the headline so the
 *  by-value and by-quantity views of the SAME card read differently. */
function RankList({
    rows,
    metric,
}: {
    rows: ProductAggregate[];
    metric: "value" | "quantity" | "profit";
}) {
    if (rows.length === 0) {
        return (
            <p className="py-8 text-center text-sm text-zinc-500">
                لا توجد مبيعات مسجلة خلال آخر ٣٠ يوماً.
            </p>
        );
    }

    return (
        <ol className="space-y-2">
            {rows.map((row, index) => {
                const headline =
                    metric === "quantity"
                        ? `${formatMoney(row.quantity, "SYP")} وحدة`
                        : metric === "profit"
                            ? money(row.profitSYP, "SYP")
                            : money(row.salesSYP, "SYP");

                const sub =
                    metric === "quantity"
                        ? money(row.salesSYP, "SYP")
                        : metric === "profit"
                            ? `مبيعات ${money(row.salesSYP, "SYP")}`
                            : `${formatMoney(row.quantity, "SYP")} وحدة`;

                return (
                    <li
                        key={row.productId}
                        className="flex items-center justify-between gap-3 rounded-lg border border-zinc-200 bg-white px-3 py-2"
                    >
                        <div className="flex min-w-0 items-center gap-3">
                            <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-xs font-semibold text-zinc-600">
                                {index + 1}
                            </span>
                            <div className="min-w-0">
                                <p className="truncate text-sm font-medium text-zinc-900">
                                    {row.productName}
                                </p>
                                <p className="truncate text-xs text-zinc-500">{sub}</p>
                            </div>
                        </div>
                        <span className="shrink-0 text-sm font-semibold tabular-nums text-zinc-900">
                            {headline}
                        </span>
                    </li>
                );
            })}
        </ol>
    );
}

function TopSellingCard({ rows }: { rows: DashboardPayload["topProducts"] }) {
    const [metric, setMetric] = useState<"value" | "quantity">("value");
    const list = metric === "value" ? rows.bySalesValue : rows.byQuantity;

    return (
        <Card>
            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
                <CardTitle>الأكثر مبيعاً</CardTitle>
                <ToggleGroup
                    type="single"
                    variant="outline"
                    size="sm"
                    value={metric}
                    onValueChange={(v) => {
                        if (v === "value" || v === "quantity") setMetric(v);
                    }}
                    aria-label="ترتيب قائمة الأكثر مبيعاً"
                >
                    <ToggleGroupItem value="value">حسب القيمة</ToggleGroupItem>
                    <ToggleGroupItem value="quantity">حسب الكمية</ToggleGroupItem>
                </ToggleGroup>
            </CardHeader>
            <CardContent>
                <RankList rows={list} metric={metric} />
            </CardContent>
        </Card>
    );
}

function TopProfitableCard({ rows }: { rows: ProductAggregate[] }) {
    return (
        <Card>
            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
                <CardTitle>الأكثر ربحاً</CardTitle>
                <span className="text-xs text-zinc-500">حسب صافي الربح</span>
            </CardHeader>
            <CardContent>
                <RankList rows={rows} metric="profit" />
            </CardContent>
        </Card>
    );
}

function AlertSection({
    title,
    icon,
    count,
    emptyText,
    href,
    children,
}: {
    title: string;
    icon: React.ReactNode;
    count: number;
    emptyText: string;
    href: string;
    children: React.ReactNode;
}) {
    return (
        <div className="flex flex-col gap-3 rounded-xl border border-zinc-200 bg-zinc-50/60 p-4">
            <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-2 text-sm font-semibold text-zinc-800">
                    <span className="text-amber-600" aria-hidden>
                        {icon}
                    </span>
                    {title}
                </span>
                <span className="rounded-full bg-white px-2 py-0.5 text-xs font-semibold text-zinc-600 ring-1 ring-zinc-200">
                    {count}
                </span>
            </div>

            {count === 0 ? (
                <p className="text-xs text-zinc-500">{emptyText}</p>
            ) : (
                <ul className="space-y-2">{children}</ul>
            )}

            <Link
                href={href}
                className="mt-auto text-xs font-medium text-emerald-700 hover:underline"
            >
                عرض التفاصيل الكاملة
            </Link>
        </div>
    );
}

function AlertsCard({ alerts }: { alerts: DashboardPayload["alerts"] }) {
    return (
        <Card>
            <CardHeader>
                <CardTitle>تنبيهات قابلة للإجراء</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 lg:grid-cols-3">
                <AlertSection
                    title="مخزون يحتاج تسوية"
                    icon={<PackageX className="size-4" />}
                    count={alerts.needsReconciliation.count}
                    emptyText="لا توجد دفعات برصيد سالب — المخزون متسق."
                    href="/inventory?filter=needs_reconciliation"
                >
                    {alerts.needsReconciliation.items.map((row) => (
                        <li
                            key={row.productId + row.batchNumber}
                            className="flex items-center justify-between gap-2 rounded-lg bg-white px-2.5 py-2"
                        >
                            <div className="min-w-0">
                                <p className="truncate text-xs font-medium text-zinc-800">
                                    {row.productName}
                                </p>
                                <p className="truncate text-[11px] text-zinc-500">
                                    {row.batchNumber} — {row.unitName}
                                </p>
                            </div>
                            <span className="shrink-0 text-xs font-semibold tabular-nums text-red-600">
                                {formatMoney(row.quantity, "SYP")}
                            </span>
                        </li>
                    ))}
                </AlertSection>

                <AlertSection
                    title="دفعات قرب تاريخ الصلاحية"
                    icon={<Clock className="size-4" />}
                    count={alerts.expiringSoon.count}
                    emptyText="لا توجد دفعات على وشك الانتهاء خلال ٦٠ يوماً."
                    href="/inventory?filter=expiring"
                >
                    {alerts.expiringSoon.items.map((row) => (
                        <li
                            key={row.productName + row.batchNumber}
                            className="flex items-center justify-between gap-2 rounded-lg bg-white px-2.5 py-2"
                        >
                            <div className="min-w-0">
                                <p className="truncate text-xs font-medium text-zinc-800">
                                    {row.productName}
                                </p>
                                <p className="truncate text-[11px] text-zinc-500">
                                    {row.batchNumber} — {row.unitName}
                                </p>
                            </div>
                            <span className="shrink-0 text-xs font-semibold text-amber-700">
                                {row.daysToExpiry < 0 ? "منتهٍ" : `${row.daysToExpiry} يوم`}
                            </span>
                        </li>
                    ))}
                </AlertSection>
                <AlertSection
                    title="أعلى أرصدة الديون"
                    icon={<Users className="size-4" />}
                    count={alerts.largeBalances.count}
                    emptyText="لا توجد أرصدة مستحقة على أي زبون."
                    href="/ledger"
                >
                    {alerts.largeBalances.items.map((row) => (
                        <li
                            key={row.customerId}
                            className="flex items-center justify-between gap-2 rounded-lg bg-white px-2.5 py-2"
                        >
                            <span className="min-w-0 truncate text-xs font-medium text-zinc-800">
                                {row.customerName}
                            </span>
                            <span className="shrink-0 text-xs font-semibold tabular-nums text-red-600">
                                {money(row.balanceSYP, "SYP")}
                            </span>
                        </li>
                    ))}
                </AlertSection>
            </CardContent>
        </Card>
    );
}

function DashboardSkeleton() {
    return (
        <section className="space-y-5" aria-busy="true">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
                {[0, 1, 2, 3].map((i) => (
                    <Skeleton key={i} className="h-24 rounded-xl" />
                ))}
            </div>
            <Skeleton className="h-80 rounded-xl" />
            <div className="grid gap-5 lg:grid-cols-2">
                <Skeleton className="h-64 rounded-xl" />
                <Skeleton className="h-64 rounded-xl" />
            </div>
        </section>
    );
}





