"use client";

/**
 * components/receipts/receipts-log-client.tsx
 *
 * v4.7 Phase 7 — the goods-receiving history screen (/inventory/receipts).
 * One receipt per row (desktop) / per card (mobile), cursor-paginated, with
 * a date-range + supplier filter bar, a detail modal and an ADMIN-only
 * header edit dialog.
 *
 * [SERVER IS THE SECURITY BOUNDARY] The page component already bounced a
 * CASHIER to /inventory, but nothing here trusts that: every fetch is to
 * GET/PATCH /api/receipts*, which assert `receipts:view`/`receipts:edit`
 * server-side (403 before any query) regardless of what this component
 * renders.
 *
 * [FILTERS — business dates, not instants] The date-range picker is the
 * sales-log one, but its bounds are converted to 'YYYY-MM-DD' with
 * syria-time's localDayKey() (the platform's ONE day definition, fixed
 * UTC+3) because the API filters a @db.Date purchaseDate column.
 * "كل الفترات" omits from/to entirely. The supplier box is debounced (300ms)
 * and sent as `supplierName` (server-side contains-match).
 *
 * [PAGINATION — append, don't re-walk] 25 rows per request; "load more"
 * appends the next keyset page after the server's opaque nextCursor.
 * Changing ANY filter restarts from the first page (the requestKey changes).
 *
 * [LOADING IS DERIVED, NOT STORED] Every first-load is identified by a
 * requestKey; `loading` is "no result for the CURRENT key yet". While a
 * request is in flight the previous rows stay on screen (dimmed); a failed
 * reload folds into the PREVIOUS successful result.
 *
 * [UI/UX PASS — RTL + MOBILE]
 *  - Dates/times are LTR islands (<Ltr>): inside an RTL paragraph the bidi
 *    algorithm otherwise flips "2026-10-09 10:06" into "10:06 2026-10-09".
 *  - The mobile filter bar is a column (picker row, then search) with
 *    min-w-0 everywhere so nothing can push the page wider than 375px.
 *  - Mobile cards put the SUPPLIER first (what the merchant recognises),
 *    then date + total; the entry time only repeats the date when it differs.
 *  - Arabic plurals are handled (استلام / استلامان / استلامات / استلاماً).
 *  - Chevrons point in the RTL "forward" direction (left).
 *
 * [v4.8 — polish pass, presentation only] Matches the sales-log screen: a
 * gradient header tile, the filters inside one card (40px controls), a
 * results pill, supplier initials, skeletons that mirror the real layout,
 * friendlier empty/error states and a light staggered entrance. One small
 * behaviour fix: a keydown that bubbles up from the row's edit button no
 * longer also opens the detail modal (the row only reacts to keys pressed on
 * the row itself, and now also to Space). Fetching, derived loading, abort,
 * append-pagination and the failure-folding logic are unchanged.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  ChevronDown,
  ChevronLeft,
  ClipboardList,
  Clock,
  ListFilter,
  Loader2,
  Package,
  Pencil,
  RefreshCw,
  Search,
  Trash2,
  User,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { formatMoney } from "@/lib/utils/money";
import { localDayKey } from "@/lib/utils/syria-time";
import { DateRangePicker, type DateRangeValue } from "@/components/sales-log/date-range-picker";
import { daysAgoLocalRange } from "@/components/sales-log/sales-log-utils";
import type { EditTarget, ReceiptListPage, ReceiptListRow } from "./types";
import { formatCreatedAt, formatPurchaseDate } from "./receipts-utils";
import { ReceiptDetailModal } from "./receipt-detail-modal";
import { ReceiptEditModal } from "./receipt-edit-modal";

const PAGE_SIZE = 25;
const SUPPLIER_DEBOUNCE_MS = 300;

/** Entrance for list rows: a short stagger per page, skipped for reduced motion. */
const ROW_ENTER = "motion-safe:animate-in fade-in slide-in-from-bottom-1 duration-300 fill-mode-backwards";
const rowStyle = (i: number) => ({ animationDelay: `${Math.min(i % PAGE_SIZE, 10) * 30}ms` });

interface LogResult {
  /** Identifies which request produced this result — see header. */
  key: string;
  items: ReceiptListRow[];
  nextCursor: string | null;
}

/* ───────────────────────── small presentational helpers ───────────────────────── */

/** LTR island for dates/times/numbers so RTL bidi never reorders them. */
function Ltr({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span dir="ltr" className={cn("inline-block tabular-nums [unicode-bidi:isolate]", className)}>
      {children}
    </span>
  );
}

/** Arabic count + noun with correct plural form (1 / 2 / 3–10 / 11+). */
function arCount(n: number, forms: { one: string; two: string; few: string; many: string }) {
  if (n === 1) return forms.one;
  if (n === 2) return forms.two;
  const num = n.toLocaleString("ar-SY");
  return n >= 3 && n <= 10 ? `${num} ${forms.few}` : `${num} ${forms.many}`;
}

const lineCountLabel = (n: number) =>
  arCount(n, { one: "صنف واحد", two: "صنفان", few: "أصناف", many: "صنفاً" });

const receiptCountLabel = (n: number) =>
  arCount(n, { one: "استلام واحد", two: "استلامان", few: "استلامات", many: "استلاماً" });

/** Entry time; drops the date part when it is the same day as the purchase date. */
function entryLabel(row: ReceiptListRow): string {
  const created = formatCreatedAt(row.createdAt);
  const purchase = formatPurchaseDate(row.purchaseDate);
  return created.startsWith(purchase) ? created.slice(purchase.length).trim() || created : created;
}

/** Row keyboard activation: Enter / Space, only when the key was pressed on the row itself. */
function activateOnKey(e: KeyboardEvent<HTMLElement>, fn: () => void) {
  if (e.target !== e.currentTarget) return;
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    fn();
  }
}

function DeletedBadge({ row, long }: { row: ReceiptListRow; long?: boolean }) {
  if (row.deletedCount <= 0) return null;
  const all = row.lineCount === 0;
  return (
    <Badge
      variant="outline"
      className="gap-1 border-zinc-300 bg-zinc-100 px-1.5 py-0 text-[10px] font-bold text-zinc-500"
    >
      <Trash2 className="size-3" aria-hidden />
      {all
        ? long ? "جميع الأسطر محذوفة" : "جميعها محذوفة"
        : `${row.deletedCount.toLocaleString("ar-SY")} محذوف`}
    </Badge>
  );
}

function SupplierText({ name, className }: { name: string | null; className?: string }) {
  return name ? (
    <span className={cn("truncate font-bold text-zinc-900", className)}>{name}</span>
  ) : (
    <span className={cn("truncate text-zinc-400", className)}>بدون مورّد</span>
  );
}

function SupplierAvatar({ name }: { name: string | null }) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-9 shrink-0 place-items-center rounded-xl text-sm font-extrabold ring-1 ring-inset transition-colors",
        name
          ? "bg-emerald-50 text-emerald-700 ring-emerald-100 group-hover:bg-emerald-100"
          : "bg-zinc-100 text-zinc-400 ring-zinc-200"
      )}
    >
      {name ? name.trim().charAt(0).toUpperCase() || "؟" : <Package className="size-4" />}
    </span>
  );
}

/** Query string (minus cursor) shared by the first page and every load-more. */
function filterParams(
  range: DateRangeValue,
  allPeriods: boolean,
  supplier: string
): URLSearchParams {
  const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (!allPeriods) {
    params.set("from", localDayKey(range.from));
    params.set("to", localDayKey(range.to));
  }
  if (supplier) params.set("supplierName", supplier);
  return params;
}

/** First-load placeholder that mirrors the real layout (rows / cards). */
function LogSkeleton() {
  return (
    <div aria-hidden>
      <div className="hidden divide-y divide-zinc-100 overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-sm md:block">
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className="flex items-center gap-4 px-4 py-4">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="size-9 rounded-xl" />
            <Skeleton className="h-4 flex-1" />
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-4 w-28" />
          </div>
        ))}
      </div>
      <div className="space-y-2.5 md:hidden">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="space-y-3 rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm">
            <div className="flex items-center gap-3">
              <Skeleton className="size-9 rounded-xl" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-1/2" />
                <Skeleton className="h-3 w-1/3" />
              </div>
              <Skeleton className="h-5 w-20" />
            </div>
            <Skeleton className="h-8 w-full rounded-lg" />
          </div>
        ))}
      </div>
    </div>
  );
}

/* ─────────────────────────────────── component ─────────────────────────────────── */

export function ReceiptsLogClient() {
  const [reloadToken, setReloadToken] = useState(0);
  const [result, setResult] = useState<LogResult | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [appending, setAppending] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null);

  // Filters. `range` always holds a real value (default: last 30 days).
  const [range, setRange] = useState<DateRangeValue>(() => daysAgoLocalRange(29));
  const [allPeriods, setAllPeriods] = useState(false);
  const [supplierInput, setSupplierInput] = useState("");
  const [supplier, setSupplier] = useState("");

  useEffect(() => {
    const handle = setTimeout(() => setSupplier(supplierInput.trim()), SUPPLIER_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [supplierInput]);

  const firstKey = useMemo(() => {
    const window = allPeriods
      ? "all"
      : `${localDayKey(range.from)}..${localDayKey(range.to)}`;
    return `first:${reloadToken}:${window}:${supplier}`;
  }, [reloadToken, range, allPeriods, supplier]);

  const loading = result?.key !== firstKey;
  const abortRef = useRef<AbortController | null>(null);

  const fetchFirstPage = useCallback(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const key = firstKey;
    const params = filterParams(range, allPeriods, supplier);

    fetch(`/api/receipts?${params.toString()}`, { signal: controller.signal })
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data?.message || "تعذّر جلب سجل الاستلام.");
        return data as ReceiptListPage;
      })
      .then((page) => {
        setLoadError(null);
        setResult({ key, items: page.items, nextCursor: page.nextCursor });
        setAppending(false);
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        const message =
          error instanceof Error ? error.message : "تعذّر جلب سجل الاستلام.";
        setLoadError(message);
        setResult((prev) =>
          prev ? { key, items: prev.items, nextCursor: prev.nextCursor } : null
        );
        toast.error(message);
      });
  }, [firstKey, range, allPeriods, supplier]);

  useEffect(() => {
    fetchFirstPage();
    return () => abortRef.current?.abort();
  }, [fetchFirstPage]);

  const handleLoadMore = useCallback(() => {
    const cursor = result?.nextCursor;
    if (!cursor || appending || loading) return;
    const expectedKey = result.key;
    setAppending(true);

    const params = filterParams(range, allPeriods, supplier);
    params.set("cursor", cursor);
    fetch(`/api/receipts?${params.toString()}`)
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data?.message || "تعذّر تحميل المزيد.");
        return data as ReceiptListPage;
      })
      .then((page) => {
        setResult((prev) =>
          prev && prev.key === expectedKey
            ? {
              key: prev.key,
              items: [...prev.items, ...page.items],
              nextCursor: page.nextCursor,
            }
            : prev
        );
      })
      .catch((error: unknown) => {
        toast.error(error instanceof Error ? error.message : "تعذّر تحميل المزيد.");
      })
      .finally(() => setAppending(false));
  }, [result, appending, loading, range, allPeriods, supplier]);

  const handleSaved = useCallback(() => {
    setEditTarget(null);
    setDetailId(null);
    setReloadToken((token) => token + 1);
  }, []);

  const rows = result?.items ?? [];
  const hasMore = Boolean(result?.nextCursor) && !loading;
  const firstLoad = loading && rows.length === 0;
  const refreshing = loading && rows.length > 0;
  const showEmpty = !loading && !loadError && rows.length === 0;
  const filtered = allPeriods || Boolean(supplier);

  return (
    <section className="w-full min-w-0 max-w-full space-y-4" aria-busy={loading}>
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <div className="shrink-0 rounded-2xl bg-linear-to-br from-emerald-500 to-emerald-700 p-2.5 shadow-sm shadow-emerald-600/25">
            <ClipboardList className="size-6 text-white" aria-hidden />
          </div>
          <div className="min-w-0">
            <h1 className="text-xl font-extrabold text-zinc-900">سجل الاستلام</h1>
            <p className="mt-0.5 text-xs leading-relaxed text-zinc-500">
              كل عملية استلام بضاعة — التاريخ، المورّد، الأصناف المستلمة، وما تبقّى منها اليوم.
            </p>
          </div>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setReloadToken((token) => token + 1)}
          disabled={loading}
          aria-label="تحديث"
          className="h-10 shrink-0 gap-1.5 rounded-xl text-xs font-bold transition-all active:scale-[0.97]"
        >
          {loading ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
          ) : (
            <RefreshCw className="size-3.5" aria-hidden />
          )}
          <span className="hidden sm:inline">تحديث</span>
        </Button>
      </div>

      {/* Filters — one card: column on mobile, one row from sm: up */}
      <div className="grid min-w-0 gap-2.5 rounded-2xl border border-zinc-200 bg-white p-3 shadow-sm sm:flex sm:flex-wrap sm:items-center">
        <div className="flex min-w-0 items-center gap-2">
          <div
            className={cn(
              "min-w-0 flex-1 transition-opacity sm:flex-none",
              // Local overrides of the SHARED picker's trigger (the picker file
              // itself is untouched): full width on mobile, long label truncates.
              "[&>button]:w-full [&>button]:min-w-0 sm:[&>button]:w-auto sm:[&>button]:min-w-52 [&>button>span]:min-w-0 [&>button>span]:truncate",
              allPeriods && "opacity-50"
            )}
          >
            <DateRangePicker value={range} onChange={setRange} disabled={allPeriods || loading} />
          </div>
          <Button
            type="button"
            variant={allPeriods ? "default" : "outline"}
            size="sm"
            onClick={() => setAllPeriods((on) => !on)}
            disabled={loading}
            className={cn(
              "h-10 shrink-0 gap-1.5 rounded-lg text-xs font-semibold transition-all active:scale-[0.97]",
              allPeriods && "bg-emerald-600 shadow-sm shadow-emerald-600/25 hover:bg-emerald-700"
            )}
            aria-pressed={allPeriods}
          >
            <ListFilter className="size-3.5" aria-hidden />
            كل الفترات
          </Button>
        </div>

        <div className="group relative min-w-0 sm:w-72">
          <Search
            className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-zinc-400 transition-colors group-focus-within:text-emerald-600"
            aria-hidden
          />
          <Input
            type="text"
            autoComplete="off"
            placeholder="ابحث باسم المورّد..."
            aria-label="بحث باسم المورّد"
            value={supplierInput}
            onChange={(e) => setSupplierInput(e.target.value)}
            className="h-10 rounded-lg bg-white ps-9 pe-9 text-sm transition-shadow focus-visible:border-emerald-500 focus-visible:ring-emerald-500/20"
          />
          {supplierInput && (
            <button
              type="button"
              onClick={() => setSupplierInput("")}
              aria-label="مسح البحث"
              className="absolute end-1.5 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-lg text-zinc-400 transition-all hover:bg-zinc-100 hover:text-zinc-700 active:scale-90 motion-safe:animate-in fade-in zoom-in-75 duration-150"
            >
              <X className="size-3.5" aria-hidden />
            </button>
          )}
        </div>
      </div>

      {/* Results summary */}
      <div className="flex items-center justify-between gap-2 text-[11px] text-zinc-500">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-zinc-100 px-2.5 py-1 font-bold text-zinc-700">
          {loading ? (
            <Loader2 className="size-3.5 animate-spin text-emerald-600" aria-hidden />
          ) : (
            <ClipboardList className="size-3.5" aria-hidden />
          )}
          {loading ? "جارٍ الجلب..." : `عرض ${receiptCountLabel(rows.length)}`}
        </span>
        <span className="hidden sm:inline">من الأحدث إلى الأقدم</span>
      </div>

      {/* First-load skeleton */}
      {firstLoad && <LogSkeleton />}

      {/* First-ever failure */}
      {!loading && loadError && rows.length === 0 && (
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-red-200 bg-red-50/60 px-6 py-12 text-center motion-safe:animate-in fade-in zoom-in-95 duration-300">
          <p className="text-sm font-bold text-red-700">{loadError}</p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="rounded-xl"
            onClick={() => setReloadToken((token) => token + 1)}
          >
            إعادة المحاولة
          </Button>
        </div>
      )}

      {/* Empty state */}
      {showEmpty && (
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-zinc-300 bg-white px-6 py-14 text-center motion-safe:animate-in fade-in zoom-in-95 duration-300">
          <div className="flex size-14 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-600 motion-safe:animate-in zoom-in-50 duration-500 delay-100 fill-mode-backwards">
            <ClipboardList className="size-7" aria-hidden />
          </div>
          <h2 className="text-sm font-extrabold text-zinc-800">
            {filtered ? "ما في نتائج مطابقة" : "ما في عمليات استلام بعد"}
          </h2>
          <p className="max-w-xs text-xs leading-relaxed text-zinc-500">
            {filtered
              ? "جرّب توسيع الفترة أو مسح بحث المورّد."
              : "أول عملية استلام بضاعة (من شاشة المخزون أو استيراد CSV) رح تظهر هون مع تفاصيلها."}
          </p>
        </div>
      )}

      {/* Desktop table (own scroll container — never the page) */}
      {rows.length > 0 && (
        <div
          className={cn(
            "hidden overflow-x-auto rounded-2xl border border-zinc-200 bg-white shadow-sm transition-opacity md:block",
            refreshing && "opacity-60"
          )}
        >
          <table className="w-full min-w-[720px] table-fixed border-collapse text-sm">
            <thead>
              <tr className="border-b border-zinc-200 bg-zinc-50 text-xs font-bold text-zinc-500">
                <th scope="col" className="w-[16%] px-4 py-3 text-start">التاريخ</th>
                <th scope="col" className="w-[24%] px-4 py-3 text-start">المورّد</th>
                <th scope="col" className="w-[20%] px-4 py-3 text-start">المستلم</th>
                <th scope="col" className="w-[16%] px-4 py-3 text-start">الأصناف</th>
                <th scope="col" className="w-[16%] px-4 py-3 text-start">الإجمالي</th>
                <th scope="col" className="w-[84px] px-2 py-3">
                  <span className="sr-only">إجراءات</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr
                  key={row.id}
                  tabIndex={0}
                  onClick={() => setDetailId(row.id)}
                  onKeyDown={(e) => activateOnKey(e, () => setDetailId(row.id))}
                  style={rowStyle(i)}
                  className={cn(
                    "group cursor-pointer border-b border-zinc-100 transition-colors last:border-0 hover:bg-emerald-50/50 focus-visible:bg-emerald-50/50 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-emerald-500",
                    ROW_ENTER
                  )}
                >
                  <td className="px-4 py-3 align-middle">
                    {/* inline-block inside a plain div: a `block` dir=ltr element
                        would left-align its text and drift off the column's
                        right edge (and away from its header) in RTL. */}
                    <div>
                      <Ltr className="font-bold text-zinc-800">
                        {formatPurchaseDate(row.purchaseDate)}
                      </Ltr>
                    </div>
                    <span className="mt-0.5 flex items-center gap-1 text-[11px] text-zinc-400">
                      <Clock className="size-3" aria-hidden />
                      <Ltr>{entryLabel(row)}</Ltr>
                    </span>
                  </td>
                  <td className="max-w-0 px-4 py-3 align-middle">
                    <span className="flex min-w-0 items-center gap-2.5">
                      <SupplierAvatar name={row.supplierName} />
                      <SupplierText name={row.supplierName} className="min-w-0 flex-1" />
                    </span>
                  </td>
                  <td className="px-4 py-3 align-middle text-zinc-600">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <User className="size-3.5 shrink-0 text-zinc-400" aria-hidden />
                      <span className="truncate">{row.receivedByName || "—"}</span>
                    </span>
                  </td>
                  <td className="px-4 py-3 align-middle">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-bold text-zinc-700">
                        {lineCountLabel(row.lineCount)}
                      </span>
                      <DeletedBadge row={row} />
                    </span>
                  </td>
                  <td className="px-4 py-3 align-middle">
                    <span className="whitespace-nowrap text-sm font-extrabold tabular-nums text-emerald-700">
                      {formatMoney(row.totalCostSYP, "SYP")} ل.س
                    </span>
                  </td>
                  <td className="px-2 py-3 align-middle">
                    <span className="flex items-center justify-end gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label="تعديل بيانات الاستلام"
                        className="size-8 rounded-lg text-zinc-400 transition-all hover:bg-emerald-50 hover:text-emerald-700 active:scale-90"
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditTarget({
                            id: row.id,
                            purchaseDate: row.purchaseDate,
                            supplierName: row.supplierName,
                          });
                        }}
                      >
                        <Pencil className="size-3.5" aria-hidden />
                      </Button>
                      <ChevronLeft
                        className="size-4 text-zinc-300 transition-all group-hover:-translate-x-0.5 group-hover:text-emerald-500"
                        aria-hidden
                      />
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Mobile cards (375px-safe) */}
      {rows.length > 0 && (
        <ul className={cn("space-y-2.5 transition-opacity md:hidden", refreshing && "opacity-60")}>
          {rows.map((row, i) => (
            <li key={row.id} style={rowStyle(i)} className={cn("min-w-0", ROW_ENTER)}>
              <button
                type="button"
                onClick={() => setDetailId(row.id)}
                className="group block w-full min-w-0 rounded-2xl border border-zinc-200 bg-white p-4 text-start shadow-sm transition-all active:scale-[0.99] active:bg-emerald-50/60 hover:border-emerald-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-500"
              >
                {/* Row 1: supplier + total */}
                <div className="flex items-center gap-3">
                  <SupplierAvatar name={row.supplierName} />
                  <div className="min-w-0 flex-1">
                    <SupplierText name={row.supplierName} className="block text-sm" />
                    <Ltr className="text-xs font-bold text-zinc-500">
                      {formatPurchaseDate(row.purchaseDate)}
                    </Ltr>
                  </div>
                  <span className="shrink-0 whitespace-nowrap text-sm font-extrabold tabular-nums text-emerald-700">
                    {formatMoney(row.totalCostSYP, "SYP")} ل.س
                  </span>
                </div>

                {/* Row 2: lines + deleted */}
                <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl bg-zinc-50 px-3 py-2 text-xs text-zinc-600">
                  <span className="flex items-center gap-1.5 font-semibold">
                    <Package className="size-3.5 text-zinc-400" aria-hidden />
                    {lineCountLabel(row.lineCount)}
                  </span>
                  <DeletedBadge row={row} long />
                </div>

                {/* Row 3: receiver • entry time • chevron */}
                <div className="mt-2.5 flex items-center gap-3 text-[11px] text-zinc-400">
                  <span className="flex min-w-0 flex-1 items-center gap-1">
                    <User className="size-3.5 shrink-0" aria-hidden />
                    <span className="truncate">{row.receivedByName || "—"}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-1">
                    <Clock className="size-3" aria-hidden />
                    <Ltr>{entryLabel(row)}</Ltr>
                  </span>
                  <ChevronLeft
                    className="size-4 shrink-0 text-zinc-300 transition-transform group-active:-translate-x-0.5"
                    aria-hidden
                  />
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* Load more */}
      {hasMore && (
        <div className="flex justify-center pt-1">
          <Button
            type="button"
            variant="outline"
            onClick={handleLoadMore}
            disabled={appending}
            className="h-11 w-full gap-1.5 rounded-xl text-sm font-bold transition-all active:scale-[0.98] sm:w-auto sm:min-w-44"
          >
            {appending ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <ChevronDown className="size-4" aria-hidden />
            )}
            عرض المزيد
          </Button>
        </div>
      )}

      {/* Modals */}
      <ReceiptDetailModal
        receiptId={detailId}
        onOpenChange={(next) => {
          if (!next) setDetailId(null);
        }}
        onEdit={(target) => {
          setDetailId(null);
          setEditTarget(target);
        }}
      />
      <ReceiptEditModal
        target={editTarget}
        onOpenChange={(next) => {
          if (!next) setEditTarget(null);
        }}
        onSaved={handleSaved}
      />
    </section>
  );
}