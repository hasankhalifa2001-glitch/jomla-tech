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
 * body that contains no figure at all. The client additionally NEVER issues
 * the request for a non-ADMIN session (see the effect below) — but a forged
 * request that skips this component entirely still fails on the server.
 * (middleware.ts independently bounces a CASHIER's browser away from
 * /dashboard before this file ever mounts.)
 *
 * [WHAT THE RANGE TOGGLE CONTROLS] 1/7/30 → `?range=` (1 = today, charted BY
 * HOUR). The server derives the trend AND the Top-5 rankings from that SAME
 * window (lib/data/analytics.ts). The four KPI cards are NOT affected: three
 * are "today" and the debt card is a running balance. That is why the toggle
 * now lives in the "تحليل الفترة" section header, directly above the things it
 * changes, instead of next to the page title where it looked global.
 *
 * [LOADING IS DERIVED, NOT STORED] Every request is identified by a
 * `requestKey` (role + range + refresh tick). `isLoading` is "no completed
 * result for the CURRENT key yet". Each effect run owns an AbortController, so
 * a slow response for an OLD key can never land after a newer one.
 *
 * [FAILURE NEVER WIPES GOOD DATA] The last successful payload stays on screen
 * (dimmed while a reload is in flight); a failure only adds an error banner
 * with a retry button and a toast.
 *
 * [OFFLINE] /api/analytics is network-only by design (T4a2). When the device
 * is offline the screen keeps whatever it last showed and says so in Arabic.
 *
 * [NUMBERS] All figures are formatted through ONE locale constant
 * (NUMBER_LOCALE) and lib/utils/money.ts's formatMoney(), so digits are
 * consistent across KPIs, chart axes, tooltips and lists. Decimal strings are
 * converted to `Number` ONLY for chart geometry / bar widths — display-only,
 * never fed back into a calculation; margins and averages use decimal.js.
 *
 * [MOTION] Entrance/ count-up animation is presentational only — see the
 * "motion" block below. It never touches the authoritative Decimal strings;
 * it only drives what's painted on screen while a value tweens toward it,
 * and the component always lands on the exact formatMoney() output.
 *
 * NO dark-mode classes (light-only shell styling, matching the sales log).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import Decimal from "decimal.js";
import {
    AlertTriangle,
    CheckCircle2,
    ChevronLeft,
    Clock,
    DollarSign,
    Loader2,
    PackageX,
    Receipt,
    RefreshCw,
    ShieldCheck,
    ShoppingBag,
    TrendingUp,
    Users,
    Wallet,
} from "lucide-react";
import { toast } from "sonner";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ChartContainer, ChartTooltip, type ChartConfig } from "@/components/ui/chart";
import { useSessionWithOfflineFallback } from "@/lib/offline/hooks";
import { formatMoney, sumMoney } from "@/lib/utils/money";

// ---------------------------------------------------------------------------
// Response shape — mirrors lib/data/analytics.ts's AnalyticsDashboard. Kept
// local rather than imported so no server module is pulled into this bundle.
// ---------------------------------------------------------------------------

type Range = 1 | 7 | 30;
type Granularity = "hour" | "day";

interface Kpis {
    salesSYP: string;
    // [v4.9] Null when no rated invoice exists today — caption omitted then.
    salesUSD: string | null;
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
    /** In the product's BASE unit. */
    quantity: string;
    /** "" when the server could not resolve it. */
    baseUnitName: string;
    profitSYP: string;
}

interface AlertList<T> {
    count: number;
    items: T[];
}

interface NeedsReconciliationAlert {
    batchId: string;
    productName: string;
    batchNumber: string;
    quantity: string;
    unitName: string;
}

interface ExpiringSoonAlert {
    batchId: string;
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
    trendGranularity: Granularity;
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

interface ChartPoint {
    date: string;
    /** Display-only numbers for recharts geometry. */
    sales: number;
    profit: number;
    /** The exact server strings, used for every printed figure. */
    salesSYP: string;
    profitSYP: string;
}

const chartConfig = {
    sales: { label: "المبيعات", color: "#059669" },
    profit: { label: "الربح", color: "#2563eb" },
} satisfies ChartConfig;

const GENERIC_ERROR = "تعذر تحميل مؤشرات لوحة التحكم.";
const NETWORK_ERROR = "تعذر الاتصال بالخادم. تحقق من اتصال الإنترنت — المعروض هو آخر بيانات محمّلة.";

// ---------------------------------------------------------------------------
// Formatting. ONE locale constant: keep it in sync with formatMoney() in
// lib/utils/money.ts — switching the whole app to Latin digits later is then a
// one-line change here plus the one in money.ts ("ar-SY-u-nu-latn").
// ---------------------------------------------------------------------------
const NUMBER_LOCALE = "ar-SY";
const intFormatter = new Intl.NumberFormat(NUMBER_LOCALE);
const pad2Formatter = new Intl.NumberFormat(NUMBER_LOCALE, { minimumIntegerDigits: 2, useGrouping: false });
const qtyFormatter = new Intl.NumberFormat(NUMBER_LOCALE, { maximumFractionDigits: 4 });
const compactFormatter = new Intl.NumberFormat(NUMBER_LOCALE, { notation: "compact", maximumFractionDigits: 1 });
const percentFormatter = new Intl.NumberFormat(NUMBER_LOCALE, { style: "percent", maximumFractionDigits: 1 });

const fmtInt = (n: number) => intFormatter.format(n);

/** A QUANTITY (not money) — display-only; trailing zeros dropped. */
function qty(value: string): string {
    const n = Number(value);
    return Number.isFinite(n) ? qtyFormatter.format(n) : value;
}

/** "2026-10-05" → "٠٥/١٠"; hourly "2026-10-05T14" → "١٤:٠٠". Derived from the
 *  string, never parsed as a Date, so no browser timezone can shift a bucket. */
function axisLabel(date: string): string {
    if (date.length > 10) return `${pad2Formatter.format(Number(date.slice(11, 13)))}:00`;
    return `${pad2Formatter.format(Number(date.slice(8, 10)))}/${pad2Formatter.format(Number(date.slice(5, 7)))}`;
}

/** Full label for the chart tooltip (the raw ISO string used to leak here). */
function tooltipLabel(date: string): string {
    if (date.length > 10) return `الساعة ${axisLabel(date)}`;
    const d = new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))));
    return d.toLocaleDateString(NUMBER_LOCALE, {
        timeZone: "UTC",
        weekday: "long",
        day: "numeric",
        month: "long",
    });
}

/** "اليوم" for a one-day window, otherwise "آخر ٧ أيام" / "آخر ٣٠ يوماً". */
function windowLabel(days: number): string {
    if (days === 1) return "اليوم";
    return `آخر ${fmtInt(days)} ${days <= 10 ? "أيام" : "يوماً"}`;
}

/** Net profit as a share of sales, via decimal.js. Null when there are no sales. */
function marginRatio(profit: string, sales: string): number | null {
    try {
        const s = new Decimal(sales);
        if (s.lte(0)) return null;
        return new Decimal(profit).div(s).toNumber();
    } catch {
        return null;
    }
}

/** Average invoice value, via decimal.js. Null when there are no invoices. */
function averageInvoice(sales: string, count: number): string | null {
    if (count <= 0) return null;
    try {
        return new Decimal(sales).div(count).toFixed(0);
    } catch {
        return null;
    }
}

function isAbortError(e: unknown): boolean {
    return e instanceof DOMException && e.name === "AbortError";
}

async function fetchDashboard(range: Range, signal: AbortSignal): Promise<DashboardPayload> {
    if (typeof navigator !== "undefined" && !navigator.onLine) {
        throw new Error(NETWORK_ERROR);
    }

    let res: Response;
    try {
        res = await fetch(`/api/analytics?range=${range}`, { cache: "no-store", signal });
    } catch (e) {
        if (isAbortError(e)) throw e;
        throw new Error(NETWORK_ERROR);
    }

    let json: unknown = null;
    try {
        json = await res.json();
    } catch {
        // non-JSON body (e.g. a gateway error page) — handled below.
    }

    if (!res.ok) {
        const message = (json as { message?: string } | null)?.message;
        throw new Error(message || GENERIC_ERROR);
    }
    if (!json) throw new Error(GENERIC_ERROR);
    return json as DashboardPayload;
}

// ---------------------------------------------------------------------------
// Motion — a single ease-out count-up used only by the four KPI hero
// numbers. Pure presentation: it tweens a plain `number` for painting, while
// every OTHER figure in the tree (chart, lists, captions) still goes through
// formatMoney() on the exact Decimal string, unchanged. On finish the hook's
// own display value lands exactly on `Number(target)`, and the caller still
// runs ITS OWN formatMoney/Intl call on the real string for the settled
// frame, so no rounding drift from the tween can reach the screen.
// ---------------------------------------------------------------------------

const REDUCED_MOTION =
    typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

function useCountUp(target: number, duration = 650): number {
    const [display, setDisplay] = useState(target);
    const prevRef = useRef(target);
    const firstRun = useRef(true);

    useEffect(() => {
        if (firstRun.current) {
            // No tween on first paint — avoids a 0 → value flash on load.
            firstRun.current = false;
            prevRef.current = target;
            setDisplay(target);
            return;
        }
        const start = prevRef.current;
        if (start === target || REDUCED_MOTION) {
            prevRef.current = target;
            setDisplay(target);
            return;
        }
        let raf = 0;
        const startTime = performance.now();
        const tick = (now: number) => {
            const t = Math.min(1, (now - startTime) / duration);
            const eased = 1 - Math.pow(1 - t, 3);
            setDisplay(start + (target - start) * eased);
            if (t < 1) {
                raf = requestAnimationFrame(tick);
            } else {
                prevRef.current = target;
                setDisplay(target);
            }
        };
        raf = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(raf);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [target, duration]);

    return display;
}

/** The animated hero figure for a SYP KPI. Mid-tween frames use a plain
 *  grouped-integer format (cheap, display-only); the settled frame always
 *  re-renders through <Money>, so the authoritative string is what the user
 *  reads at rest. */
function AnimatedMoneySYP({ value, className }: { value: string; className?: string }) {
    const target = Number(value);
    const safeTarget = Number.isFinite(target) ? target : 0;
    const display = useCountUp(safeTarget);
    const settled = display === safeTarget;

    if (settled) {
        return <Money value={value} currency="SYP" className={className} />;
    }
    return (
        <span className={cn("tabular-nums", className)}>
            {intFormatter.format(Math.round(display))} <span className="text-[0.62em] font-semibold text-slate-500">ل.س</span>
        </span>
    );
}

function AnimatedInt({ value, className }: { value: number; className?: string }) {
    const display = useCountUp(value);
    return (
        <span className={cn("tabular-nums", className)}>{intFormatter.format(Math.round(display))}</span>
    );
}

/** One-time global keyframes for the card entrance. Scoped by class name
 *  only (no styled-jsx dependency), injected once from the page root. */
function MotionStyles() {
    return (
        <style>{`
            @keyframes dashCardIn {
                from { opacity: 0; transform: translateY(8px); }
                to { opacity: 1; transform: translateY(0); }
            }
            .dash-card-in {
                animation: dashCardIn .45s cubic-bezier(.16,.84,.44,1) both;
            }
            @media (prefers-reduced-motion: reduce) {
                .dash-card-in { animation: none; }
            }
        `}</style>
    );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

interface SettledResult {
    key: string;
    data: DashboardPayload | null;
    /** When the data on screen was fetched (ms epoch), for "آخر تحديث". */
    at: number | null;
}

export function DashboardAnalyticsClient() {
    const { data: session, status } = useSessionWithOfflineFallback();
    const role = session?.role ?? null;

    const [range, setRange] = useState<Range>(7);
    const [refreshTick, setRefreshTick] = useState(0);
    const [result, setResult] = useState<SettledResult | null>(null);
    const [error, setError] = useState<string | null>(null);

    const requestKey = `${role ?? "anon"}:${range}:${refreshTick}`;

    useEffect(() => {
        // The endpoint is ADMIN-only. A CASHIER/anonymous session never even
        // issues the request (the server would 403 it regardless).
        if (role !== "ADMIN") return;

        const controller = new AbortController();

        void (async () => {
            try {
                const payload = await fetchDashboard(range, controller.signal);
                if (controller.signal.aborted) return;
                setResult({ key: requestKey, data: payload, at: Date.now() });
                setError(null);
            } catch (e) {
                if (controller.signal.aborted || isAbortError(e)) return;
                // Keep the last good payload; only mark THIS key as settled so
                // the spinner stops.
                setResult((prev) => ({ key: requestKey, data: prev?.data ?? null, at: prev?.at ?? null }));
                setError(e instanceof Error ? e.message : GENERIC_ERROR);
                toast.error("تعذر تحديث مؤشرات لوحة التحكم.");
            }
        })();

        return () => controller.abort();
    }, [role, range, requestKey]);

    const data = result?.data ?? null;
    const isLoading = !result || result.key !== requestKey;

    const onRangeChange = useCallback((value: string) => {
        if (value === "1") setRange(1);
        else if (value === "7") setRange(7);
        else if (value === "30") setRange(30);
    }, []);

    const refresh = useCallback(() => {
        setError(null);
        setRefreshTick((t) => t + 1);
    }, []);

    if (status === "loading") return <DashboardSkeleton />;
    if (role !== "ADMIN") return <ForbiddenPanel />;

    const windowDays = data?.range ?? range;
    const todayLabel = new Date().toLocaleDateString(NUMBER_LOCALE, {
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
    });
    const updatedLabel = result?.at
        ? new Date(result.at).toLocaleTimeString(NUMBER_LOCALE, { hour: "numeric", minute: "2-digit" })
        : null;

    return (
        <section className="space-y-6">
            <MotionStyles />
            {/* ------------------------------------------------------ header
                Mobile: title row and the refresh button stay on ONE line
                (button goes icon-only, no wrap-to-its-own-row), the date
                shrinks to a single small line, and the exchange-rate hint
                sentence is desktop-only — it's nice-to-know, not essential,
                and was the single biggest line-count contributor on a phone.
                Everything that previously forced 5 stacked lines above the
                first KPI card now fits in 2. */}
            <header className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                        <p className="truncate text-[11px] font-medium text-slate-500 sm:text-xs">{todayLabel}</p>
                        <h2 className="truncate text-lg font-bold text-slate-900 sm:text-2xl">ملخص أداء المتجر</h2>
                    </div>

                    <div className="flex shrink-0 items-center gap-2">
                        {updatedLabel && !isLoading && (
                            <span className="hidden text-xs text-slate-400 lg:inline">آخر تحديث {updatedLabel}</span>
                        )}
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={refresh}
                            disabled={isLoading}
                            aria-label="تحديث"
                            className="h-8 gap-1.5 bg-white px-2.5 transition-transform active:scale-95 sm:h-9 sm:px-3"
                        >
                            {isLoading ? (
                                <Loader2 className="size-4 animate-spin" aria-hidden />
                            ) : (
                                <RefreshCw className="size-4" aria-hidden />
                            )}
                            <span className="hidden sm:inline">تحديث</span>
                        </Button>
                    </div>
                </div>

                {data?.exchangeRate && (
                    <div className="flex flex-wrap items-center gap-2">
                        <span className="inline-flex items-center gap-1.5 rounded-full border border-purple-200 bg-purple-50 px-2.5 py-0.5 text-[11px] font-semibold text-purple-700 sm:px-3 sm:py-1 sm:text-xs">
                            <DollarSign className="size-3.5" aria-hidden />
                            <bdi dir="ltr">$1</bdi>
                            <span aria-hidden>=</span>
                            <span className="tabular-nums">{formatMoney(data.exchangeRate, "SYP")} ل.س</span>
                        </span>
                        <span className="hidden text-[11px] text-slate-400 sm:inline">
                            مبالغ الدولار تقريبية، بسعر كل فاتورة وقت إصدارها.
                        </span>
                    </div>
                )}
            </header>

            {error && (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                    <span className="flex items-center gap-2">
                        <AlertTriangle className="size-4 shrink-0" aria-hidden />
                        {error}
                    </span>
                    <Button variant="outline" size="sm" onClick={refresh} disabled={isLoading}>
                        إعادة المحاولة
                    </Button>
                </div>
            )}

            {isLoading && !data && <DashboardSkeleton />}

            {data && (
                <div
                    className={cn("space-y-6 transition-opacity", isLoading && "opacity-60")}
                    aria-busy={isLoading}
                >
                    <KpiCards kpis={data.kpis} />

                    {/* ------------------------------------- period analysis */}
                    <div className="space-y-4">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                            <div>
                                <h3 className="text-base font-bold text-slate-900">تحليل الفترة</h3>
                                <p className="text-xs text-slate-500">
                                    المخطط والقوائم أدناه تتبع الفترة المختارة — {windowLabel(windowDays)}.
                                </p>
                            </div>
                            <ToggleGroup
                                type="single"
                                variant="outline"
                                size="sm"
                                value={String(range)}
                                onValueChange={onRangeChange}
                                aria-label="الفترة الزمنية للتحليل"
                                className="bg-white"
                            >
                                <ToggleGroupItem value="1">اليوم</ToggleGroupItem>
                                <ToggleGroupItem value="7">{fmtInt(7)} أيام</ToggleGroupItem>
                                <ToggleGroupItem value="30">{fmtInt(30)} يوماً</ToggleGroupItem>
                            </ToggleGroup>
                        </div>

                        <TrendCard trend={data.trend} granularity={data.trendGranularity} />

                        <div className="grid gap-4 lg:grid-cols-2">
                            <TopSellingCard rows={data.topProducts} days={windowDays} />
                            <TopProfitableCard rows={data.topProducts.byProfit} days={windowDays} />
                        </div>
                    </div>

                    <AlertsCard alerts={data.alerts} />
                </div>
            )}
        </section>
    );
}

/**
 * Rendered when the session is not an ADMIN — the endpoint rejects this
 * caller regardless (assertRolePermission runs before any read), and this
 * component never sends the request for such a session.
 */
function ForbiddenPanel() {
    return (
        <section className="space-y-4">
            <h2 className="text-xl font-bold text-slate-900">ملخص أداء المتجر</h2>
            <Panel>
                <div className="flex items-center gap-3 p-5 text-sm text-slate-700">
                    <ShieldCheck className="size-5 shrink-0 text-emerald-600" aria-hidden />
                    <span>مؤشرات التحليلات متاحة لمدير المتجر فقط.</span>
                </div>
            </Panel>
        </section>
    );
}

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

/** shadcn Card with its built-in vertical padding/gap neutralised, so every
 *  panel below controls its own spacing regardless of the Card version. */
function Panel({
    children,
    className,
    style,
}: {
    children: React.ReactNode;
    className?: string;
    style?: React.CSSProperties;
}) {
    return (
        <Card style={style} className={cn("gap-0 overflow-hidden border-slate-200 bg-white py-0 shadow-sm", className)}>
            {children}
        </Card>
    );
}

function PanelHeader({
    title,
    subtitle,
    action,
}: {
    title: string;
    subtitle?: React.ReactNode;
    action?: React.ReactNode;
}) {
    return (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-4 py-3.5 sm:px-5">
            <div>
                <h4 className="text-sm font-bold text-slate-900">{title}</h4>
                {subtitle && <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p>}
            </div>
            {action}
        </div>
    );
}

/** One money figure. The unit is its OWN element (not part of one string) so the
 *  RTL bidi algorithm can never shuffle it; USD is an isolated LTR run. */
function Money({
    value,
    currency,
    className,
}: {
    value: string;
    currency: "SYP" | "USD";
    className?: string;
}) {
    if (currency === "USD") {
        return (
            <bdi dir="ltr" className={cn("tabular-nums", className)}>
                $ {formatMoney(value, "USD")}
            </bdi>
        );
    }
    return (
        <span className={cn("tabular-nums", className)}>
            {formatMoney(value, "SYP")} <span className="text-[0.62em] font-semibold text-slate-500">ل.س</span>
        </span>
    );
}

type Tone = "emerald" | "sky" | "red" | "slate";

const TONE_CHIP: Record<Tone, string> = {
    emerald: "bg-emerald-50 text-emerald-600",
    sky: "bg-sky-50 text-sky-600",
    red: "bg-red-50 text-red-600",
    slate: "bg-slate-100 text-slate-600",
};

/** Accent-card wash — ONLY applied when `accent` is true, so color still
 *  encodes meaning (profit = positive, debt = attention) instead of being
 *  sprayed across every KPI the way the four cards used to look identical. */
const TONE_CARD: Partial<Record<Tone, string>> = {
    emerald: "border-emerald-200 bg-emerald-50/60",
    red: "border-red-200 bg-red-50/60",
};

const TONE_CAPTION: Partial<Record<Tone, string>> = {
    emerald: "text-emerald-700/80",
    red: "text-red-700/80",
};

function KpiCard({
    title,
    tag,
    icon,
    tone,
    accent = false,
    hero,
    className,
    style,
    caption,
    children,
}: {
    title: string;
    tag: string;
    icon: React.ReactNode;
    tone: Tone;
    /** Tints the whole card (not just the icon chip) — reserve for the one
     *  or two KPIs whose color genuinely carries meaning. */
    accent?: boolean;
    hero?: boolean;
    className?: string;
    style?: React.CSSProperties;
    caption?: React.ReactNode;
    children: React.ReactNode;
}) {
    return (
        <Panel style={style} className={cn("dash-card-in", accent && TONE_CARD[tone], className)}>
            <div className="flex h-full flex-col gap-2 p-3.5 sm:gap-3 sm:p-5">
                {/* Icon and the "اليوم" tag share the top row; the title gets
                    its OWN full-width row below so it never has to compete
                    for space and fight `truncate` down to "الفوا...". */}
                <div className="flex items-center justify-between gap-2">
                    <span
                        className={cn(
                            "flex size-7 shrink-0 items-center justify-center rounded-lg sm:size-9 sm:rounded-xl",
                            accent ? "bg-white shadow-sm" : TONE_CHIP[tone],
                            accent && (tone === "red" ? "text-red-600" : "text-emerald-600")
                        )}
                        aria-hidden
                    >
                        {icon}
                    </span>
                    <span className="shrink-0 rounded-full bg-white/70 px-2 py-0.5 text-[10px] font-semibold text-slate-500 sm:text-[11px]">
                        {tag}
                    </span>
                </div>

                <p
                    className={cn(
                        "line-clamp-2 text-[13px] font-semibold leading-tight sm:text-sm",
                        accent ? "text-slate-700" : "text-slate-600"
                    )}
                >
                    {title}
                </p>

                <div
                    className={cn(
                        "font-extrabold leading-tight tracking-tight text-slate-900",
                        hero ? "text-2xl sm:text-3xl" : "text-lg sm:text-2xl"
                    )}
                >
                    {children}
                </div>

                {caption && (
                    <div className={cn("text-xs leading-relaxed", accent ? TONE_CAPTION[tone] : "text-slate-500")}>
                        {caption}
                    </div>
                )}
            </div>
        </Panel>
    );
}

function KpiCards({ kpis }: { kpis: Kpis }) {
    const margin = marginRatio(kpis.netProfitSYP, kpis.salesSYP);
    const average = averageInvoice(kpis.salesSYP, kpis.invoiceCount);

    // Mobile: sales and debts are full-width, profit + invoices share a row.
    // sm: 2 columns. xl: all four in one row.
    return (
        <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
            <KpiCard
                title="المبيعات"
                tag="اليوم"
                tone="sky"
                hero
                className="col-span-2 sm:col-span-1"
                style={{ animationDelay: "0ms" }}
                icon={<ShoppingBag className="size-5" />}
                // SYP is authoritative; USD is the secondary figure, summed from
                // each invoice's own frozen-rate USD value (omitted when null).
                caption={
                    kpis.salesUSD !== null ? (
                        <span className="inline-flex items-center gap-1">
                            <span aria-hidden>≈</span>
                            <Money value={kpis.salesUSD} currency="USD" className="font-semibold text-slate-700" />
                        </span>
                    ) : undefined
                }
            >
                <AnimatedMoneySYP value={kpis.salesSYP} />
            </KpiCard>

            <KpiCard
                title="صافي الربح"
                tag="اليوم"
                tone="emerald"
                accent
                style={{ animationDelay: "40ms" }}
                icon={<TrendingUp className="size-5" />}
                caption={
                    margin === null ? (
                        "لا مبيعات لحساب الهامش"
                    ) : (
                        <>
                            هامش الربح{" "}
                            <span className="font-semibold text-emerald-800">{percentFormatter.format(margin)}</span>
                        </>
                    )
                }
            >
                <AnimatedMoneySYP value={kpis.netProfitSYP} className="text-emerald-900" />
            </KpiCard>

            <KpiCard
                title="الفواتير"
                tag="اليوم"
                tone="slate"
                style={{ animationDelay: "80ms" }}
                icon={<Receipt className="size-5" />}
                caption={
                    average === null ? (
                        "لا فواتير صادرة بعد"
                    ) : (
                        <>
                            متوسط الفاتورة{" "}
                            <Money value={average} currency="SYP" className="font-semibold text-slate-700" />
                        </>
                    )
                }
            >
                <AnimatedInt value={kpis.invoiceCount} />
            </KpiCard>

            <KpiCard
                title="ديون الزبائن"
                tag="الإجمالي"
                tone="red"
                accent
                className="col-span-2 sm:col-span-1"
                style={{ animationDelay: "120ms" }}
                icon={<Wallet className="size-5" />}
                caption="صافي المستحقات حسب دفتر الديون"
            >
                <AnimatedMoneySYP value={kpis.outstandingDebtSYP} className="text-red-900" />
            </KpiCard>
        </div>
    );
}

// ---------------------------------------------------------------------------
// Trend chart
// ---------------------------------------------------------------------------

function TrendTooltip({
    active,
    payload,
}: {
    active?: boolean;
    payload?: Array<{ payload: ChartPoint }>;
}) {
    if (!active || !payload?.length) return null;
    const point = payload[0].payload;

    return (
        <div dir="rtl" className="min-w-44 rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-xs shadow-lg">
            <p className="mb-2 font-bold text-slate-900">{tooltipLabel(point.date)}</p>
            <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-4">
                    <span className="flex items-center gap-1.5 text-slate-600">
                        <span className="size-2 rounded-full" style={{ background: chartConfig.sales.color }} aria-hidden />
                        المبيعات
                    </span>
                    <Money value={point.salesSYP} currency="SYP" className="font-semibold text-slate-900" />
                </div>
                <div className="flex items-center justify-between gap-4">
                    <span className="flex items-center gap-1.5 text-slate-600">
                        <span className="size-2 rounded-full" style={{ background: chartConfig.profit.color }} aria-hidden />
                        الربح
                    </span>
                    <Money value={point.profitSYP} currency="SYP" className="font-semibold text-slate-900" />
                </div>
            </div>
        </div>
    );
}

function TrendCard({ trend, granularity }: { trend: TrendPoint[]; granularity: Granularity }) {
    const chartData = useMemo<ChartPoint[]>(
        () =>
            trend.map((p) => ({
                date: p.date,
                // Display-only conversion for recharts; never fed back into math.
                sales: Number(p.salesSYP),
                profit: Number(p.profitSYP),
                salesSYP: p.salesSYP,
                profitSYP: p.profitSYP,
            })),
        [trend]
    );

    const hasActivity = chartData.some((p) => p.sales !== 0 || p.profit !== 0);

    // Period totals only make sense for a multi-day window (for "today" they
    // would just repeat the KPI cards above).
    const totals =
        granularity === "day" && trend.length > 0
            ? {
                sales: sumMoney(trend.map((p) => p.salesSYP)),
                profit: sumMoney(trend.map((p) => p.profitSYP)),
            }
            : null;

    const axisProps = {
        tickLine: false,
        axisLine: false,
        tick: { fontSize: 11, fill: "#64748b" },
    } as const;

    return (
        <Panel className="dash-card-in" style={{ animationDelay: "80ms" }}>
            <PanelHeader
                title={granularity === "hour" ? "المبيعات والأرباح بالساعة" : "اتجاه المبيعات والأرباح"}
                action={
                    <span className="flex items-center gap-4 text-xs text-slate-500">
                        <span className="flex items-center gap-1.5">
                            <span className="size-2.5 rounded-full bg-emerald-600" aria-hidden />
                            المبيعات
                        </span>
                        <span className="flex items-center gap-1.5">
                            <span className="size-2.5 rounded-full bg-blue-600" aria-hidden />
                            الربح
                        </span>
                    </span>
                }
            />

            <div className="p-4 sm:p-5">
                {totals && hasActivity && (
                    <dl className="mb-4 flex flex-wrap gap-x-8 gap-y-2">
                        <div>
                            <dt className="text-xs text-slate-500">إجمالي مبيعات الفترة</dt>
                            <dd className="text-lg font-extrabold text-slate-900">
                                <Money value={totals.sales} currency="SYP" />
                            </dd>
                        </div>
                        <div>
                            <dt className="text-xs text-slate-500">إجمالي ربح الفترة</dt>
                            <dd className="text-lg font-extrabold text-slate-900">
                                <Money value={totals.profit} currency="SYP" />
                            </dd>
                        </div>
                    </dl>
                )}

                {!hasActivity ? (
                    <div className="flex h-56 flex-col items-center justify-center gap-2 text-center">
                        <span className="flex size-12 items-center justify-center rounded-full bg-slate-100 text-slate-400">
                            <TrendingUp className="size-6" aria-hidden />
                        </span>
                        <p className="text-sm font-semibold text-slate-700">لا توجد مبيعات خلال هذه الفترة</p>
                        <p className="text-xs text-slate-500">ستظهر هنا بمجرد تسجيل أول فاتورة.</p>
                    </div>
                ) : (
                    // The chart itself stays LTR (time runs left to right, the
                    // value axis on the left) so it is identical regardless of
                    // page direction; the tooltip re-asserts RTL for its text.
                    // Recharts animates Area/Bar paths in on mount by default
                    // (isAnimationActive), which is the "draws itself" motion —
                    // left as-is rather than reimplemented.
                    <div dir="ltr">
                        <ChartContainer config={chartConfig} className="aspect-auto h-64 w-full">
                            {granularity === "hour" ? (
                                <BarChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barGap={3}>
                                    <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="#e2e8f0" />
                                    <XAxis dataKey="date" tickFormatter={axisLabel} interval="preserveStartEnd" minTickGap={20} {...axisProps} />
                                    <YAxis width={64} tickFormatter={(v: number) => compactFormatter.format(v)} {...axisProps} />
                                    <ChartTooltip cursor={{ fill: "#f1f5f9" }} content={<TrendTooltip />} />
                                    <Bar dataKey="sales" fill="var(--color-sales)" radius={[4, 4, 0, 0]} maxBarSize={26} animationDuration={500} />
                                    <Bar dataKey="profit" fill="var(--color-profit)" radius={[4, 4, 0, 0]} maxBarSize={26} animationDuration={500} />
                                </BarChart>
                            ) : (
                                <AreaChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                                    <defs>
                                        <linearGradient id="fillSales" x1="0" y1="0" x2="0" y2="1">
                                            <stop offset="5%" stopColor="var(--color-sales)" stopOpacity={0.28} />
                                            <stop offset="95%" stopColor="var(--color-sales)" stopOpacity={0.02} />
                                        </linearGradient>
                                        <linearGradient id="fillProfit" x1="0" y1="0" x2="0" y2="1">
                                            <stop offset="5%" stopColor="var(--color-profit)" stopOpacity={0.2} />
                                            <stop offset="95%" stopColor="var(--color-profit)" stopOpacity={0.02} />
                                        </linearGradient>
                                    </defs>
                                    <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="#e2e8f0" />
                                    <XAxis dataKey="date" tickFormatter={axisLabel} interval="preserveStartEnd" minTickGap={24} {...axisProps} />
                                    <YAxis width={64} tickFormatter={(v: number) => compactFormatter.format(v)} {...axisProps} />
                                    <ChartTooltip cursor={{ stroke: "#cbd5e1", strokeDasharray: "3 3" }} content={<TrendTooltip />} />
                                    <Area
                                        dataKey="sales"
                                        type="monotone"
                                        stroke="var(--color-sales)"
                                        strokeWidth={2.5}
                                        fill="url(#fillSales)"
                                        dot={false}
                                        activeDot={{ r: 4 }}
                                        animationDuration={700}
                                    />
                                    <Area
                                        dataKey="profit"
                                        type="monotone"
                                        stroke="var(--color-profit)"
                                        strokeWidth={2}
                                        fill="url(#fillProfit)"
                                        dot={false}
                                        activeDot={{ r: 4 }}
                                        animationDuration={700}
                                    />
                                </AreaChart>
                            )}
                        </ChartContainer>
                    </div>
                )}
            </div>
        </Panel>
    );
}

// ---------------------------------------------------------------------------
// Rankings
// ---------------------------------------------------------------------------

function quantityLabel(row: ProductAggregate): string {
    return `${qty(row.quantity)} ${row.baseUnitName || "وحدة"}`;
}

type RankMetric = "value" | "quantity" | "profit";

const BAR_TONE: Record<RankMetric, string> = {
    value: "bg-emerald-50",
    quantity: "bg-sky-50",
    profit: "bg-emerald-50",
};

/** The numeric used ONLY to size the background bar (display-only). */
function barValue(row: ProductAggregate, metric: RankMetric): number {
    const raw = metric === "quantity" ? row.quantity : metric === "profit" ? row.profitSYP : row.salesSYP;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Shared Top-N renderer. `metric` decides which figure is the headline, and
 *  each row carries a bar sized relative to the leader so the gap between #1
 *  and #5 is visible at a glance. */
function RankList({ rows, metric, days }: { rows: ProductAggregate[]; metric: RankMetric; days: number }) {
    if (rows.length === 0) {
        return (
            <div className="flex flex-col items-center gap-2 py-10 text-center">
                <span className="flex size-11 items-center justify-center rounded-full bg-slate-100 text-slate-400">
                    <ShoppingBag className="size-5" aria-hidden />
                </span>
                <p className="text-sm text-slate-500">لا توجد مبيعات مسجلة — {windowLabel(days)}.</p>
            </div>
        );
    }

    const max = Math.max(...rows.map((r) => barValue(r, metric)), 0);

    return (
        <ol className="space-y-2">
            {rows.map((row, index) => {
                const pct = max > 0 ? Math.max(6, (barValue(row, metric) / max) * 100) : 0;

                const headline =
                    metric === "quantity" ? (
                        <span className="tabular-nums">{quantityLabel(row)}</span>
                    ) : (
                        <Money value={metric === "profit" ? row.profitSYP : row.salesSYP} currency="SYP" />
                    );

                const sub =
                    metric === "quantity" ? (
                        <Money value={row.salesSYP} currency="SYP" />
                    ) : metric === "profit" ? (
                        <>
                            مبيعات <Money value={row.salesSYP} currency="SYP" />
                        </>
                    ) : (
                        <span className="tabular-nums">{quantityLabel(row)}</span>
                    );

                return (
                    <li
                        key={row.productId}
                        className="dash-card-in relative overflow-hidden rounded-lg border border-slate-100 bg-white transition-colors hover:border-slate-200"
                        style={{ animationDelay: `${120 + index * 40}ms` }}
                    >
                        {/* start-0 = the right edge in RTL, so the bar grows toward the left. */}
                        <div
                            className={cn("absolute inset-y-0 start-0 transition-[width] duration-500 ease-out", BAR_TONE[metric])}
                            style={{ width: `${pct}%` }}
                            aria-hidden
                        />
                        <div className="relative flex items-center justify-between gap-3 px-3 py-2.5">
                            <div className="flex min-w-0 items-center gap-3">
                                <span
                                    className={cn(
                                        "flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-bold",
                                        index === 0 ? "bg-amber-100 text-amber-700" : "bg-slate-100 text-slate-600"
                                    )}
                                >
                                    {fmtInt(index + 1)}
                                </span>
                                <div className="min-w-0">
                                    <p className="truncate text-sm font-semibold text-slate-900">{row.productName}</p>
                                    <p className="truncate text-xs text-slate-500">{sub}</p>
                                </div>
                            </div>
                            <span className="shrink-0 text-sm font-extrabold text-slate-900">{headline}</span>
                        </div>
                    </li>
                );
            })}
        </ol>
    );
}

function TopSellingCard({ rows, days }: { rows: DashboardPayload["topProducts"]; days: number }) {
    const [metric, setMetric] = useState<"value" | "quantity">("value");
    const list = metric === "value" ? rows.bySalesValue : rows.byQuantity;

    return (
        <Panel className="dash-card-in" style={{ animationDelay: "160ms" }}>
            <PanelHeader
                title="الأكثر مبيعاً"
                subtitle={windowLabel(days)}
                action={
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
                }
            />
            <div className="p-4 sm:p-5">
                <RankList rows={list} metric={metric} days={days} />
            </div>
        </Panel>
    );
}

function TopProfitableCard({ rows, days }: { rows: ProductAggregate[]; days: number }) {
    return (
        <Panel className="dash-card-in" style={{ animationDelay: "200ms" }}>
            <PanelHeader title="الأكثر ربحاً" subtitle={`حسب صافي الربح — ${windowLabel(days)}`} />
            <div className="p-4 sm:p-5">
                <RankList rows={rows} metric="profit" days={days} />
            </div>
        </Panel>
    );
}

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

type AlertTone = "red" | "amber" | "slate";

const ALERT_STYLES: Record<AlertTone, { chip: string; badge: string; ring: string }> = {
    red: { chip: "bg-red-50 text-red-600", badge: "bg-red-100 text-red-700", ring: "ring-red-100" },
    amber: { chip: "bg-amber-50 text-amber-600", badge: "bg-amber-100 text-amber-800", ring: "ring-amber-100" },
    slate: { chip: "bg-slate-100 text-slate-600", badge: "bg-slate-200 text-slate-700", ring: "ring-slate-100" },
};

function AlertColumn({
    title,
    icon,
    tone,
    count,
    shown,
    emptyText,
    href,
    children,
}: {
    title: string;
    icon: React.ReactNode;
    tone: AlertTone;
    count: number;
    shown: number;
    emptyText: string;
    href: string;
    children: React.ReactNode;
}) {
    const styles = ALERT_STYLES[tone];
    // Only columns with something open get a tinted frame — an empty column
    // stays neutral so the open ones are what draw the eye first.
    const frame = count > 0 ? cn("ring-1", styles.ring, "bg-white") : "bg-slate-50/60";

    return (
        <div className={cn("flex flex-col gap-3 rounded-xl border border-slate-200 p-4", frame)}>
            <div className="flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-2.5">
                    <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-lg", styles.chip)} aria-hidden>
                        {icon}
                    </span>
                    <span className="truncate text-sm font-bold text-slate-800">{title}</span>
                </span>
                <span
                    className={cn(
                        "shrink-0 rounded-full px-2.5 py-0.5 text-xs font-bold tabular-nums",
                        count > 0 ? styles.badge : "bg-emerald-100 text-emerald-700"
                    )}
                >
                    {fmtInt(count)}
                </span>
            </div>

            {count === 0 ? (
                <p className="flex items-start gap-2 rounded-lg bg-emerald-50 px-3 py-2.5 text-xs leading-relaxed text-emerald-700">
                    <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden />
                    {emptyText}
                </p>
            ) : (
                <>
                    <ul className="space-y-2">{children}</ul>
                    {count > shown && (
                        <p className="text-center text-xs text-slate-400">و {fmtInt(count - shown)} غيرها…</p>
                    )}
                    <Link
                        href={href}
                        className="mt-auto inline-flex items-center gap-1 text-xs font-semibold text-emerald-700 hover:underline"
                    >
                        عرض الكل
                        <ChevronLeft className="size-3.5" aria-hidden />
                    </Link>
                </>
            )}
        </div>
    );
}

function expiryLabel(daysToExpiry: number): string {
    if (daysToExpiry < 0) return "منتهٍ";
    if (daysToExpiry === 0) return "ينتهي اليوم";
    return `${fmtInt(daysToExpiry)} يوم`;
}

function AlertsCard({ alerts }: { alerts: DashboardPayload["alerts"] }) {
    const total =
        alerts.needsReconciliation.count + alerts.expiringSoon.count + alerts.largeBalances.count;

    return (
        <Panel className="dash-card-in" style={{ animationDelay: "240ms" }}>
            <PanelHeader
                title="تنبيهات تحتاج انتباهك"
                subtitle={total === 0 ? "كل شيء على ما يرام." : `${fmtInt(total)} تنبيه مفتوح`}
            />
            <div className="grid gap-4 p-4 sm:p-5 lg:grid-cols-3">
                <AlertColumn
                    title="مخزون يحتاج تسوية"
                    icon={<PackageX className="size-4" />}
                    tone="red"
                    count={alerts.needsReconciliation.count}
                    shown={alerts.needsReconciliation.items.length}
                    emptyText="لا توجد دفعات برصيد سالب — المخزون متسق."
                    href="/inventory?filter=needs_reconciliation"
                >
                    {alerts.needsReconciliation.items.map((row) => (
                        <li
                            key={row.batchId}
                            className="flex items-center justify-between gap-2 rounded-lg bg-white px-3 py-2 ring-1 ring-slate-100"
                        >
                            <div className="min-w-0">
                                <p className="truncate text-xs font-semibold text-slate-800">{row.productName}</p>
                                <p className="truncate text-[11px] text-slate-500">
                                    <bdi dir="ltr" className="font-mono">
                                        {row.batchNumber}
                                    </bdi>
                                </p>
                            </div>
                            <span className="shrink-0 text-xs font-bold tabular-nums text-red-600">
                                <bdi dir="ltr">{qty(row.quantity)}</bdi> {row.unitName}
                            </span>
                        </li>
                    ))}
                </AlertColumn>

                <AlertColumn
                    title="دفعات قرب الانتهاء"
                    icon={<Clock className="size-4" />}
                    tone="amber"
                    count={alerts.expiringSoon.count}
                    shown={alerts.expiringSoon.items.length}
                    emptyText={`لا توجد دفعات على وشك الانتهاء خلال ${fmtInt(60)} يوماً.`}
                    href="/inventory?filter=expiring"
                >
                    {alerts.expiringSoon.items.map((row) => (
                        <li
                            key={row.batchId}
                            className="flex items-center justify-between gap-2 rounded-lg bg-white px-3 py-2 ring-1 ring-slate-100"
                        >
                            <div className="min-w-0">
                                <p className="truncate text-xs font-semibold text-slate-800">{row.productName}</p>
                                <p className="truncate text-[11px] text-slate-500">
                                    <bdi dir="ltr" className="font-mono">
                                        {row.batchNumber}
                                    </bdi>{" "}
                                    · {qty(row.quantity)} {row.unitName}
                                </p>
                            </div>
                            <span
                                className={cn(
                                    "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold",
                                    row.daysToExpiry <= 7 ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-800"
                                )}
                            >
                                {expiryLabel(row.daysToExpiry)}
                            </span>
                        </li>
                    ))}
                </AlertColumn>

                <AlertColumn
                    title="أعلى أرصدة الديون"
                    icon={<Users className="size-4" />}
                    tone="slate"
                    count={alerts.largeBalances.count}
                    shown={alerts.largeBalances.items.length}
                    emptyText="لا توجد أرصدة مستحقة على أي زبون."
                    href="/ledger"
                >
                    {alerts.largeBalances.items.map((row) => (
                        <li
                            key={row.customerId}
                            className="flex items-center justify-between gap-2 rounded-lg bg-white px-3 py-2 ring-1 ring-slate-100"
                        >
                            <span className="min-w-0 truncate text-xs font-semibold text-slate-800">
                                {row.customerName}
                            </span>
                            <Money value={row.balanceSYP} currency="SYP" className="shrink-0 text-xs font-bold text-red-600" />
                        </li>
                    ))}
                </AlertColumn>
            </div>
        </Panel>
    );
}

// ---------------------------------------------------------------------------

function DashboardSkeleton() {
    return (
        <section className="space-y-6" aria-busy="true" aria-label="جاري تحميل لوحة التحكم">
            <div className="space-y-2">
                <Skeleton className="h-3 w-40" />
                <Skeleton className="h-7 w-56" />
            </div>
            <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
                <Skeleton className="col-span-2 h-32 rounded-xl sm:col-span-1" />
                <Skeleton className="h-32 rounded-xl" />
                <Skeleton className="h-32 rounded-xl" />
                <Skeleton className="col-span-2 h-32 rounded-xl sm:col-span-1" />
            </div>
            <Skeleton className="h-80 rounded-xl" />
            <div className="grid gap-4 lg:grid-cols-2">
                <Skeleton className="h-64 rounded-xl" />
                <Skeleton className="h-64 rounded-xl" />
            </div>
        </section>
    );
}