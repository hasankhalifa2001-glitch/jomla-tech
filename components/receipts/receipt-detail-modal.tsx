"use client";

/**
 * components/receipts/receipt-detail-modal.tsx
 *
 * v4.7 Phase 7 — the receipt detail dialog: meta + TOTAL (live lines only),
 * the four per-line figures (مستلم / مباع (صافي) / تسويات / متبقي), and the
 * deleted lines shown greyed for transparency.
 *
 * [RECONCILIATION WARNING — never hidden] A line with `reconciles: false`
 * gets a visible red chip AND an amber banner at the top of the list;
 * schema.prisma's [v4.7] RECONCILIATION IDENTITY treats a failure as a
 * quantity-drift bug the merchant must see. The client does NOT recompute
 * the identity — it renders exactly what the server evaluated.
 *
 * [DELETED LINES] Greyed, "محذوف" badge + reason, struck-through money,
 * labelled "غير محتسبة في الإجمالي". A receipt with NO live lines keeps its
 * explanatory row instead of looking like an empty error.
 *
 * [NO MATH HERE] Quantities render via formatQty (raw decimal strings),
 * money via money.ts's formatMoney — no Decimal, no conversionFactor, no
 * arithmetic of any kind in this file.
 *
 * [UI/UX PASS]
 *  - WIDTH BUG FIXED: components/ui/dialog.tsx bakes in `sm:max-w-md`, and
 *    tailwind-merge does NOT let a bare `max-w-4xl` override a *variant*
 *    class — so on ≥640px the dialog stayed 448px wide while the 7-column
 *    table pushed the grid wider (clipping it). We now pass `sm:max-w-4xl`
 *    and the grid children are `min-w-0`.
 *  - The dialog scrolls (max-h/overflow set locally via className — the
 *    shared dialog.tsx is NOT modified) and the footer action is sticky, so the edit button is never lost below the fold on a phone.
 *  - The total is shown ONCE (top card); the footer only holds the action.
 *  - Status badges moved under the product name → one table column fewer.
 *  - Dates / batch numbers are LTR islands so bidi can't reorder them.
 *  - Mobile cards: 2×2 figures grid, "متبقي" emphasised, cost labelled,
 *    expiry shown only when there is one.
 *
 * [v4.8 — polish pass, presentation only] Same structure as the invoice
 * detail dialog: a fixed header, a body that scrolls, and a real footer for
 * the edit action (no more sticky-with-negative-margins hack). The meta is
 * one aligned card, the table gets a clearer "متبقي" column, and sections
 * rise in with a light stagger. The `sm:max-w-4xl` width fix above is kept.
 * Fetching, derived loading and every rendered figure are unchanged.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  ClipboardList,
  Pencil,
  Package,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { formatMoney } from "@/lib/utils/money";
import type { ReceiptDetail, ReceiptDetailLine, DeletedReceiptLine, EditTarget } from "./types";
import { formatCreatedAt, formatExpiryDate, formatPurchaseDate, formatQty } from "./receipts-utils";

interface ReceiptDetailModalProps {
  receiptId: string | null;
  onOpenChange: (open: boolean) => void;
  onEdit: (target: EditTarget) => void;
}

/** Gentle staggered entrance for the body blocks. */
const RISE = "motion-safe:animate-in fade-in slide-in-from-bottom-2 duration-300 fill-mode-backwards";
const rise = (i: number) => ({ animationDelay: `${i * 60}ms` });

/** LTR island for dates / batch numbers so RTL bidi never reorders them. */
function Ltr({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span dir="ltr" className={cn("inline-block tabular-nums [unicode-bidi:isolate]", className)}>
      {children}
    </span>
  );
}

/** SYP figure — emerald, the primary money colour of this screen. */
function Money({ value, className }: { value: string; className?: string }) {
  return (
    <span
      className={cn(
        "whitespace-nowrap text-sm font-extrabold tabular-nums text-emerald-700",
        className
      )}
    >
      {formatMoney(value, "SYP")} ل.س
    </span>
  );
}

/** The four figures, used by the mobile cards (desktop has real columns). */
function Figures({ line }: { line: ReceiptDetailLine }) {
  const cells: Array<{ label: string; value: string; strong?: boolean }> = [
    { label: "مستلم", value: line.initialQuantity },
    { label: "مباع (صافي)", value: line.netSold },
    { label: "تسويات", value: line.adjustments },
    { label: "متبقي", value: line.remaining, strong: true },
  ];
  return (
    <div className="grid grid-cols-2 gap-2">
      {cells.map((cell) => (
        <div
          key={cell.label}
          className={cn(
            "min-w-0 rounded-xl px-3 py-2",
            cell.strong ? "bg-emerald-50 ring-1 ring-inset ring-emerald-100" : "bg-zinc-50"
          )}
        >
          <span className="block text-[11px] font-semibold text-zinc-500">{cell.label}</span>
          <span
            className={cn(
              "block truncate text-sm font-extrabold tabular-nums",
              cell.strong ? "text-emerald-700" : "text-zinc-800"
            )}
          >
            {formatQty(cell.value, line.unitName)}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Line badges: cost-adjusted flag + the reconciliation warning. */
function LineBadges({ line }: { line: ReceiptDetailLine }) {
  if (!line.costAdjusted && line.reconciles) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {line.costAdjusted && (
        <Badge variant="outline" className="border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-bold text-amber-700">
          التكلفة معدّلة
        </Badge>
      )}
      {!line.reconciles && (
        <Badge variant="outline" className="border-red-200 bg-red-50 px-2 py-0.5 text-[10px] font-bold text-red-700">
          <AlertTriangle className="size-3" aria-hidden />
          عدم تطابق في الكمية
        </Badge>
      )}
    </div>
  );
}

/** "يعادل 2 كرتونة + 4 قطعة" from the server-computed breakdown (display only). */
function Breakdown({ line }: { line: ReceiptDetailLine }) {
  if (line.initialQuantityBreakdown.length === 0) return null;
  const text = line.initialQuantityBreakdown
    .map((entry) => `${entry.count} ${entry.unitName}`)
    .join(" + ");
  return <p className="text-[11px] font-semibold text-zinc-400">يعادل {text}</p>;
}

/** One label / value cell of the meta grid. */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 space-y-1">
      <dt className="text-[11px] font-semibold text-zinc-500">{label}</dt>
      <dd className="truncate text-sm font-bold text-zinc-900">{children}</dd>
    </div>
  );
}

function SectionTitle({ icon, children, aside }: { icon: ReactNode; children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <h3 className="flex items-center gap-2 text-sm font-extrabold text-zinc-900">
        <span className="grid size-7 place-items-center rounded-lg bg-emerald-50 text-emerald-600">{icon}</span>
        {children}
      </h3>
      {aside}
    </div>
  );
}

/** One deleted line — greyed throughout; its cost is struck through. */
function DeletedLineRow({ line }: { line: DeletedReceiptLine }) {
  return (
    <li className="flex flex-wrap items-start gap-x-4 gap-y-2 bg-zinc-50/60 px-3 py-2.5 opacity-75">
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-bold text-zinc-500 line-through decoration-zinc-300">
          {line.productName}
        </p>
        <Ltr className="text-[10px] text-zinc-400">{line.batchNumber}</Ltr>
        {line.reason && (
          <p className="mt-0.5 text-[11px] leading-relaxed text-zinc-400">السبب: {line.reason}</p>
        )}
      </div>
      <div className="text-end">
        <span className="block text-[11px] font-semibold tabular-nums text-zinc-500">
          {formatQty(line.initialQuantityAtDeletion, line.unitName)}
        </span>
        <span className="block text-[11px] font-semibold tabular-nums text-zinc-400 line-through decoration-zinc-300">
          {formatMoney(line.totalCostAtDeletion, "SYP")} ل.س
        </span>
        <Ltr className="text-[10px] text-zinc-400">{formatCreatedAt(line.deletedAt)}</Ltr>
      </div>
      <Badge
        variant="outline"
        className="border-zinc-300 bg-zinc-100 px-2 py-0.5 text-[10px] font-bold text-zinc-500"
      >
        محذوف
      </Badge>
    </li>
  );
}

export function ReceiptDetailModal({ receiptId, onOpenChange, onEdit }: ReceiptDetailModalProps) {
  // [DERIVED LOADING — no setState in the effect] State is written only
  // inside promise callbacks / click handlers; the detail is stored TOGETHER
  // with the receipt id it belongs to, and `loading` is DERIVED.
  const [detailState, setDetailState] = useState<{ forId: string; data: ReceiptDetail } | null>(
    null
  );
  const [errorState, setErrorState] = useState<{ forId: string; message: string } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const open = receiptId !== null;
  const detail =
    detailState && receiptId && detailState.forId === receiptId ? detailState.data : null;
  const loadError =
    errorState && receiptId && errorState.forId === receiptId ? errorState.message : null;
  const loading = open && !detail && !loadError;

  const fetchDetail = useCallback(() => {
    if (!receiptId) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const forId = receiptId;

    fetch(`/api/receipts/${forId}`, { signal: controller.signal })
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data?.message || "تعذّر جلب تفاصيل الاستلام.");
        return data as ReceiptDetail;
      })
      .then((data) => {
        setDetailState({ forId, data });
        setErrorState(null);
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        const message = error instanceof Error ? error.message : "تعذّر جلب تفاصيل الاستلام.";
        setErrorState({ forId, message });
        toast.error(message);
      });
  }, [receiptId]);

  useEffect(() => {
    if (!open) return;
    fetchDetail();
    return () => abortRef.current?.abort();
  }, [open, fetchDetail]);

  const handleRetry = useCallback(() => {
    setErrorState(null);
    fetchDetail();
  }, [fetchDetail]);

  const anyReconcileIssue = (detail?.lines ?? []).some((line) => !line.reconciles);
  const allDeleted = !!detail && detail.liveLineCount === 0 && detail.deletedLineCount > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        dir="rtl"
        // All overrides are LOCAL (components/ui/dialog.tsx is shared and
        // untouched). `sm:max-w-4xl` (NOT bare max-w-4xl) must target the
        // same variant as dialog.tsx's baked-in `sm:max-w-md`, or twMerge
        // keeps the latter. The dialog is a flex column: header and footer
        // are fixed, only the middle section scrolls.
        className="flex max-h-[calc(100dvh-2rem)] w-[calc(100%-1.5rem)] flex-col gap-0 overflow-hidden rounded-2xl border-zinc-200 p-0 sm:max-w-4xl [&>*]:min-w-0"
      >
        <DialogHeader className="gap-0 border-b border-zinc-100 bg-linear-to-b from-emerald-50/70 to-white px-4 pb-3 pt-4 pe-14 text-start sm:px-6">
          <div className="flex items-center gap-3">
            <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-emerald-600 text-white shadow-sm shadow-emerald-600/25">
              <ClipboardList className="size-5" aria-hidden />
            </div>
            <div className="min-w-0 flex-1">
              <DialogTitle className="flex flex-wrap items-center gap-x-2 gap-y-1 text-base font-extrabold text-zinc-900">
                تفاصيل الاستلام
                {detail && (
                  <Ltr className="rounded-md bg-zinc-100 px-2 py-0.5 text-xs font-bold text-zinc-600">
                    {formatPurchaseDate(detail.purchaseDate)}
                  </Ltr>
                )}
              </DialogTitle>
              <DialogDescription className="mt-0.5 text-xs leading-relaxed text-zinc-500">
                الأسطر المستلمة وما تبقّى منها. الأسطر المحذوفة تُعرض للشفافية فقط ولا تدخل في الإجمالي.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {/* Scrollable body */}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 sm:px-6">
          {loading && !detail && (
            <div className="space-y-2.5" aria-hidden>
              <Skeleton className="h-16 w-full rounded-xl" />
              <Skeleton className="h-24 w-full rounded-xl" />
              {Array.from({ length: 3 }, (_, i) => (
                <Skeleton key={i} className="h-16 w-full rounded-xl" />
              ))}
            </div>
          )}

          {!loading && loadError && !detail && (
            <div className="flex flex-col items-center gap-3 rounded-2xl border border-red-200 bg-red-50/60 px-4 py-10 text-center motion-safe:animate-in fade-in duration-200">
              <p className="text-sm font-bold text-red-700">{loadError}</p>
              <Button type="button" size="sm" variant="outline" className="rounded-xl" onClick={handleRetry}>
                <RefreshCw className="size-3.5" aria-hidden />
                إعادة المحاولة
              </Button>
            </div>
          )}

          {detail && (
            <div className="min-w-0 space-y-5">
              {/* Total — shown ONCE, the primary SYP figure */}
              <div
                style={rise(0)}
                className={cn(
                  "flex flex-col items-start gap-1.5 rounded-2xl border border-emerald-200 bg-emerald-50/70 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:gap-3",
                  RISE
                )}
              >
                <div className="min-w-0">
                  <p className="text-sm font-extrabold text-emerald-800">إجمالي الاستلام</p>
                  <p className="text-[11px] leading-relaxed text-emerald-700/70">
                    الأسطر المتبقية فقط — المحذوفة غير محتسبة.
                  </p>
                </div>
                <span className="shrink-0 whitespace-nowrap text-2xl font-extrabold tabular-nums text-emerald-700">
                  {formatMoney(detail.totalCostSYP, "SYP")} ل.س
                </span>
              </div>

              {/* Meta — one aligned card; supplier first: it's what the merchant recognises */}
              <dl
                style={rise(1)}
                className={cn(
                  "grid grid-cols-2 gap-x-6 gap-y-4 rounded-xl border border-zinc-200 bg-zinc-50/60 p-4 lg:grid-cols-4",
                  RISE
                )}
              >
                <Fact label="المورّد">
                  {detail.supplierName || <span className="font-semibold text-zinc-400">بدون مورّد</span>}
                </Fact>
                <Fact label="تاريخ الشراء">
                  <Ltr>{formatPurchaseDate(detail.purchaseDate)}</Ltr>
                </Fact>
                <Fact label="المستلم">{detail.receivedBy.name || "—"}</Fact>
                <Fact label="وقت الإدخال">
                  <Ltr>{formatCreatedAt(detail.createdAt)}</Ltr>
                </Fact>
              </dl>

              {/* Reconciliation warning — surfaced, never hidden */}
              {anyReconcileIssue && (
                <div
                  role="alert"
                  className="flex items-start gap-2.5 rounded-xl border border-amber-300 bg-amber-50 px-3.5 py-3 text-xs font-bold leading-relaxed text-amber-800"
                >
                  <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
                  <span>
                    تنبيه: كمية واحدة أو أكثر لا تطابق قاعدة المطابقة (المتبقي = المستلم − المباع + التسويات).
                    راجع الأسطر المعلّمة أدناه.
                  </span>
                </div>
              )}

              {/* All lines deleted — explanatory row, receipt stays visible */}
              {allDeleted && (
                <div className="rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-6 text-center">
                  <p className="text-sm font-bold text-zinc-600">جميع أسطر هذا الاستلام محذوفة</p>
                  <p className="mt-1 text-xs leading-relaxed text-zinc-400">
                    تظهر الأسطر المحذوفة أدناه للشفافية فقط، وليست محتسبة في إجمالي الاستلام.
                  </p>
                </div>
              )}

              {/* Live lines */}
              {detail.lines.length > 0 && (
                <section style={rise(2)} className={cn("space-y-2.5", RISE)}>
                  <SectionTitle
                    icon={<Package className="size-4" aria-hidden />}
                    aside={
                      <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-bold tabular-nums text-zinc-600">
                        {detail.liveLineCount.toLocaleString("ar-SY")}
                      </span>
                    }
                  >
                    أسطر الاستلام
                  </SectionTitle>

                  {/* Desktop table — its own scroll container */}
                  <div className="hidden overflow-x-auto rounded-xl border border-zinc-200 bg-white md:block">
                    <table className="w-full min-w-[760px] border-collapse text-xs">
                      <thead>
                        <tr className="border-b border-zinc-200 bg-zinc-50 text-[11px] font-bold text-zinc-500">
                          <th scope="col" className="px-3 py-2.5 text-start">الصنف</th>
                          <th scope="col" className="w-24 px-3 py-2.5 text-start">مستلم</th>
                          <th scope="col" className="w-24 px-3 py-2.5 text-start">مباع (صافي)</th>
                          <th scope="col" className="w-24 px-3 py-2.5 text-start">تسويات</th>
                          <th scope="col" className="w-24 bg-emerald-50/70 px-3 py-2.5 text-start text-emerald-700">متبقي</th>
                          <th scope="col" className="w-32 px-3 py-2.5 text-start">التكلفة</th>
                          <th scope="col" className="w-28 px-3 py-2.5 text-start">الانتهاء</th>
                        </tr>
                      </thead>
                      <tbody>
                        {detail.lines.map((line) => (
                          <tr
                            key={line.batchId}
                            className="border-b border-zinc-100 transition-colors last:border-0 hover:bg-zinc-50/60"
                          >
                            <td className="px-3 py-3 align-top">
                              <p className="text-sm font-extrabold text-zinc-900">{line.productName}</p>
                              <Ltr className="text-[10px] text-zinc-400">{line.batchNumber}</Ltr>
                              <Breakdown line={line} />
                              <div className="mt-1 empty:hidden">
                                <LineBadges line={line} />
                              </div>
                            </td>
                            <td className="px-3 py-3 align-top font-bold tabular-nums text-zinc-900">
                              {formatQty(line.initialQuantity, line.unitName)}
                            </td>
                            <td className="px-3 py-3 align-top tabular-nums text-zinc-700">
                              {formatQty(line.netSold, line.unitName)}
                            </td>
                            <td className="px-3 py-3 align-top tabular-nums text-zinc-700">
                              {formatQty(line.adjustments, line.unitName)}
                            </td>
                            <td className="bg-emerald-50/40 px-3 py-3 align-top font-extrabold tabular-nums text-emerald-700">
                              {formatQty(line.remaining, line.unitName)}
                            </td>
                            <td className="px-3 py-3 align-top">
                              <Money value={line.totalCostSYP} />
                            </td>
                            <td className="px-3 py-3 align-top text-zinc-500">
                              {formatExpiryDate(line.expiryDate)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {/* Mobile cards (375px-safe) */}
                  <div className="space-y-2.5 md:hidden">
                    {detail.lines.map((line) => (
                      <div
                        key={line.batchId}
                        className="space-y-3 rounded-xl border border-zinc-200 bg-white p-3"
                      >
                        <div className="min-w-0">
                          <p className="text-sm font-extrabold leading-snug text-zinc-900">
                            {line.productName}
                          </p>
                          <Ltr className="text-[10px] text-zinc-400">{line.batchNumber}</Ltr>
                        </div>
                        <Figures line={line} />
                        <Breakdown line={line} />
                        <LineBadges line={line} />
                        <div className="flex items-center justify-between gap-2 border-t border-zinc-100 pt-2.5">
                          <div className="min-w-0">
                            <span className="block text-[11px] font-semibold text-zinc-500">التكلفة</span>
                            <Money value={line.totalCostSYP} />
                          </div>
                          {line.expiryDate && (
                            <div className="text-end">
                              <span className="block text-[11px] font-semibold text-zinc-500">الانتهاء</span>
                              <span className="text-xs font-bold text-zinc-700">
                                {formatExpiryDate(line.expiryDate)}
                              </span>
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {/* Deleted lines — greyed, never counted in the total */}
              {detail.deletedLines.length > 0 && (
                <section style={rise(3)} className={cn("space-y-2.5", RISE)}>
                  <h3 className="flex flex-wrap items-center gap-1.5 text-xs font-bold text-zinc-500">
                    <Trash2 className="size-3.5 text-zinc-400" aria-hidden />
                    أسطر محذوفة
                    <span className="text-zinc-400">({detail.deletedLineCount.toLocaleString("ar-SY")})</span>
                    <span className="text-[11px] font-semibold text-zinc-400">— غير محتسبة في الإجمالي</span>
                  </h3>

                  <div className="overflow-hidden rounded-xl border border-dashed border-zinc-300">
                    <ul className="divide-y divide-zinc-200/70">
                      {detail.deletedLines.map((line) => (
                        <DeletedLineRow key={`${line.batchId}-${line.deletedAt}`} line={line} />
                      ))}
                    </ul>
                  </div>
                </section>
              )}
            </div>
          )}
        </div>

        {/* Footer — only the action (the total lives at the top) */}
        {detail && (
          <div className="flex justify-end border-t border-zinc-100 bg-white px-4 py-3 sm:px-6">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-11 w-full gap-1.5 rounded-xl text-xs font-bold transition-all active:scale-[0.98] sm:h-10 sm:w-auto sm:px-6"
              onClick={() =>
                onEdit({
                  id: detail.id,
                  purchaseDate: detail.purchaseDate,
                  supplierName: detail.supplierName,
                })
              }
            >
              <Pencil className="size-3.5" aria-hidden />
              تعديل بيانات الاستلام
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}