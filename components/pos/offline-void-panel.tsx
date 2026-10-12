"use client";

import { useState } from "react";
import { usePendingOfflineInvoices } from "@/lib/offline/pending-offline-invoices";
import {
  submitOfflineVoid,
  canVoidOfflineInvoice,
  shouldShowOfflineVoidPanel,
  type PendingOfflineInvoiceRow,
} from "@/lib/offline/pos-service";
// [ADDED — manual retry for a FAILED invoice] Direct file import, matching
// the existing pattern in this file for pos-service.ts above (not routed
// through the "@/lib/offline" barrel). See retryFailedInvoice's own header
// comment in sync-worker.ts for why this exists alongside the
// /api/sync/route.ts classification fix rather than instead of it.
import { retryFailedInvoice } from "@/lib/offline/sync-worker";
import { ReceiptActions } from "@/components/receipts/receipt-actions";
import { buildLocalReceiptSource } from "@/lib/receipts/local-receipt-source";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerDescription,
} from "@/components/ui/drawer";
import { Textarea } from "@/components/ui/textarea";
import { CloudOff, AlertTriangle, RefreshCw, ChevronLeft, RotateCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { fmtInt, NUMBER_LOCALE } from "@/lib/utils/digits";
import { Money } from "./money";

/**
 * components/pos/offline-void-panel.tsx
 *
 * T4d v4.1 §6.3 — the ONLY entry point for voiding a local, not-yet-synced
 * invoice. Per the spec, mounted inside pos-layout.tsx directly under the
 * command bar, so it's visible on both mobile and desktop layouts.
 *
 * [REDESIGN — mobile overflow fix] The previous version rendered every
 * pending/failed invoice as a single horizontal row (name + amount +
 * status badge + void button + receipt actions all in one flex line)
 * directly inline on the POS screen. That row does not fit in a 375px
 * viewport, and — worse — the ENTIRE list rendered inline meant N pending
 * invoices pushed N rows of height into the main POS layout, shoving the
 * actual point-of-sale UI (search, cart, checkout) down and off-screen.
 * That defeats the point of an offline-first POS: a cashier who's done 20
 * offline sales in a day should not have their selling screen buried under
 * 20 stacked invoice rows.
 *
 * Structure, same data/logic underneath (usePendingOfflineInvoices,
 * submitOfflineVoid, canVoidOfflineInvoice, shouldShowOfflineVoidPanel,
 * ReceiptActions, buildLocalReceiptSource — none of that changed):
 *
 *   1. A compact, constant-height summary bar always inline in the POS
 *      screen: a pending count, a separate FAILED count (only when > 0,
 *      styled distinctly since it needs attention), a manual "مزامنة الآن"
 *      button, and a "عرض التفاصيل" button that opens...
 *   2. ...a Drawer (bottom sheet) containing the full scrollable list.
 *      However many invoices exist (3 or 300), the summary bar's height
 *      never changes and the main POS layout is never pushed around.
 *   3. Inside the drawer, each invoice is its OWN vertical card instead of
 *      a single horizontal row: name/time on one line, amount + status
 *      badges on the next, and a `flex-wrap` action row (طباعة / مشاركة /
 *      إلغاء الفاتورة) last — so the row wraps onto multiple lines on a
 *      narrow screen instead of overflowing it. The "إلغاء الفاتورة" button
 *      is UNCHANGED in behavior/visibility (still exactly
 *      canVoidOfflineInvoice() + the isAdmin gate — absent, not disabled,
 *      for a CASHIER).
 *
 * [ADDED — retry for a FAILED invoice] A FAILED row also gets an
 * "إعادة المحاولة" button in its action row. This is a manual safety net,
 * not a replacement for the real fix: /api/sync/route.ts's
 * isRetryableTxError() was previously blind to raw database CONNECTION
 * failures (e.g. "Server has closed the connection") and burned them into
 * permanent FAILED after one attempt instead of the correct RETRY_LATER —
 * that server-side classification fix is what prevents this from
 * happening to NEW invoices going forward. This button exists for any
 * invoice already stuck FAILED (from before that fix, or any future edge
 * case) — it flips the local row back to PENDING via
 * retryFailedInvoice() (sync-worker.ts) and immediately calls the shared
 * triggerSync(), scoped to exactly that one invoice.
 *
 * [ASSUMPTION — please confirm/adjust] Import paths for
 * Button/Dialog/Drawer/Textarea assume a standard shadcn/ui setup under
 * components/ui/**, per T1's Dependencies list (shadcn/ui), and mirror the
 * same Drawer already used for the mobile cart sheet in pos-layout.tsx.
 *
 * Strict separation (T4d v4.1 §6.4): this file NEVER imports anything
 * from components/sales-log/**, and never references POST
 * /api/ledger/voids or the "ledger:void_invoice" permission key — it
 * calls submitOfflineVoid() exclusively. This is the fact a static
 * source-reference scan (lib/offline/__tests__/t4d-offline-void.test.ts)
 * verifies mechanically, not just by review.
 *
 * Visibility: absent from the DOM entirely (not collapsed, not an empty
 * state) whenever shouldShowOfflineVoidPanel(rows) is false — driven
 * live by usePendingOfflineInvoices, with no manual refresh needed.
 *
 * Role: the void button is ABSENT (not disabled) for a CASHIER session —
 * mirrors components/sales-log/invoice-log-table.tsx's VoidButton pattern
 * exactly (T4c2). `isAdmin` is passed in from the caller's own session
 * context — this component has no session access of its own, matching
 * every other role-gated component in this codebase.
 *
 * [STYLE] Light-only slate/amber (matching the dashboard); amounts go
 * through <Money> so digits are Latin.
 */

export interface OfflineVoidPanelProps {
  tenantId?: string;
  isAdmin: boolean;
  /**
   * The SAME triggerSync instance owned by pos-layout.tsx's own top-level
   * useSyncWorker(tenantId) call — passed down rather than this panel
   * mounting a second, independent useSyncWorker() of its own. Two
   * separate hook instances would each carry their own isSyncingRef /
   * debounce timer / reactive pendingCount effect, reintroducing on the
   * CLIENT the same class of "two independent actors racing the same
   * check-then-act window" problem this whole T4d v4.1 revision closed
   * server-side (the alreadyVoided/@unique guard) and inside
   * submitOfflineVoid() itself (the Dexie-transaction fix) — two
   * uncoordinated schedulers could each decide, at nearly the same
   * moment, to POST the same pending batch to /api/sync.
   */
  triggerSync: () => Promise<void>;
}

/** A small status pill. */
function Pill({
  tone,
  children,
  className,
}: {
  tone: "amber" | "red" | "slate";
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-bold",
        tone === "amber" && "bg-amber-100 text-amber-800 ring-1 ring-amber-200",
        tone === "red" && "bg-red-100 text-red-700 ring-1 ring-red-200",
        tone === "slate" && "bg-slate-100 text-slate-600 ring-1 ring-slate-200",
        className
      )}
    >
      {children}
    </span>
  );
}

export function OfflineVoidPanel({ tenantId, isAdmin, triggerSync }: OfflineVoidPanelProps) {
  const { rows, originals, localVoids } = usePendingOfflineInvoices(tenantId);
  const [voidTarget, setVoidTarget] = useState<PendingOfflineInvoiceRow | null>(null);
  const [voidReason, setVoidReason] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // [ADDED] Drawer open/close state for the "عرض التفاصيل" full list —
  // the compact summary bar itself never needs to know invoice detail.
  const [isDetailsOpen, setIsDetailsOpen] = useState(false);
  // [ADDED] Local spinner state for the summary bar's manual sync button,
  // mirroring the pattern already used for "مزامنة الأصناف" in
  // pos-layout.tsx (handleSyncProducts / isSyncingProducts).
  const [isSyncing, setIsSyncing] = useState(false);
  // [ADDED] Tracks which specific FAILED invoice(s) are currently being
  // retried, keyed by offlineId — a Set (not a single boolean) so retrying
  // one invoice never disables the retry button on a different one.
  const [retryingIds, setRetryingIds] = useState<Set<string>>(new Set());

  // Genuinely absent from the DOM — not a collapsed section, not an empty
  // state message. See this file's own header note.
  // shouldShowOfflineVoidPanel expects an array of objects with a `status` field.
  // Map the pending rows to the minimal shape the guard requires.
  if (!shouldShowOfflineVoidPanel(rows.map((r) => ({ status: r.invoice.status })))) {
    return null;
  }

  // [ADDED] Split the count so the summary bar can call out FAILED rows
  // distinctly — those need the cashier/admin's attention (a void
  // decision, or an eventual manual retry), while a plain PENDING row is
  // just "still waiting for a connection" and doesn't need to alarm anyone.
  const failedCount = rows.filter((r) => r.invoice.status === "FAILED").length;
  const pendingCount = rows.length - failedCount;

  async function handleManualSync() {
    setIsSyncing(true);
    try {
      await triggerSync();
    } finally {
      setIsSyncing(false);
    }
  }

  // [ADDED] Retries exactly ONE failed invoice: flips it back to PENDING
  // locally (retryFailedInvoice is a no-op if tenantId/offlineId don't
  // match or the row isn't actually FAILED, so this is always safe to
  // call), then requests the same shared sync pass every other trigger in
  // this app uses. No manual refetch needed afterward —
  // usePendingOfflineInvoices is a live query and reflects the PENDING ->
  // (SYNCED | RETRY_LATER | FAILED again) transition automatically.
  async function handleRetryInvoice(offlineId: string) {
    if (!tenantId) return;
    setRetryingIds((prev) => new Set(prev).add(offlineId));
    try {
      await retryFailedInvoice(tenantId, offlineId);
      await triggerSync();
    } finally {
      setRetryingIds((prev) => {
        const next = new Set(prev);
        next.delete(offlineId);
        return next;
      });
    }
  }

  async function handleConfirmVoid() {
    if (!voidTarget || !tenantId) return;
    setIsSubmitting(true);
    setError(null);
    try {
      await submitOfflineVoid(tenantId, {
        offlineInvoiceId: voidTarget.invoice.offlineId,
        voidReason,
        actorRole: isAdmin ? "ADMIN" : "CASHIER",
      });
      // No manual refetch anywhere — usePendingOfflineInvoices is a live
      // query and updates automatically the instant the write commits
      // (see that hook's own header note).
      setVoidTarget(null);
      setVoidReason("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "حدث خطأ أثناء إلغاء الفاتورة.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div dir="rtl" className="w-full shrink-0">
      {/*
        [ADDED] Compact summary bar — constant height regardless of how many
        pending/failed invoices exist. This is the ONLY part of this
        component that renders inline in the main POS layout at all times.
      */}
      <div
        className={cn(
          "flex items-center justify-between gap-2 rounded-xl border px-3 py-2",
          failedCount > 0 ? "border-red-200 bg-red-50" : "border-amber-200 bg-amber-50"
        )}
      >
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {pendingCount > 0 && (
            <Pill tone="amber">
              <CloudOff className="size-3 text-amber-600" aria-hidden />
              {fmtInt(pendingCount)} بانتظار المزامنة
            </Pill>
          )}
          {failedCount > 0 && (
            <Pill tone="red">
              <AlertTriangle className="size-3" aria-hidden />
              {fmtInt(failedCount)} فشلت المزامنة
            </Pill>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleManualSync}
            disabled={isSyncing}
            aria-label="مزامنة الآن"
            className="h-9 gap-1.5 border-amber-300 bg-white text-xs font-bold text-amber-800 hover:bg-amber-100"
          >
            <RefreshCw className={cn("size-3.5", isSyncing && "animate-spin")} aria-hidden />
            <span className="hidden sm:inline">مزامنة الآن</span>
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => setIsDetailsOpen(true)}
            className="h-9 gap-1 bg-amber-600 text-xs font-bold text-white shadow-sm hover:bg-amber-700"
          >
            عرض التفاصيل
            <ChevronLeft className="size-3.5" aria-hidden />
          </Button>
        </div>
      </div>

      {/*
        [ADDED] The full invoice list lives ONLY inside this drawer — it never
        renders inline in the main POS layout, so it can never push the
        search/cart/checkout UI around no matter how many pending invoices
        exist.
      */}
      <Drawer open={isDetailsOpen} onOpenChange={setIsDetailsOpen}>
        <DrawerContent className="max-h-[85dvh] p-0" dir="rtl">
          <DrawerHeader className="px-4 pb-2 pt-4 text-start">
            <DrawerTitle className="text-base font-extrabold text-slate-900">فواتير لم تتم مزامنتها</DrawerTitle>
            <DrawerDescription className="text-xs text-slate-500">
              بينها {fmtInt(originals.length)} فاتورة بيع قابلة للإلغاء، و{fmtInt(localVoids.length)} فاتورة
              إلغاء بانتظار التزامن.
            </DrawerDescription>
          </DrawerHeader>

          <div className="flex-1 space-y-2.5 overflow-y-auto bg-slate-50/60 px-4 pb-4 pt-3">
            {rows.map((row) => {
              const canVoid = canVoidOfflineInvoice(
                {
                  status: row.invoice.status,
                  voidsOfflineInvoiceId: row.invoice.voidsOfflineInvoiceId,
                },
                isAdmin,
                row.hasLocalVoid
              );
              const isFailed = row.invoice.status === "FAILED";

              return (
                <div
                  key={row.invoice.offlineId}
                  className={cn(
                    "space-y-2.5 rounded-xl border bg-white p-3 shadow-sm",
                    isFailed ? "border-red-200" : "border-slate-200"
                  )}
                >
                  {/* Row 1: customer name + time */}
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-extrabold text-slate-900">{row.customerName}</span>
                    <span className="shrink-0 whitespace-nowrap text-xs tabular-nums text-slate-500">
                      {row.invoice.createdAt.toLocaleTimeString(NUMBER_LOCALE, {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  </div>

                  {/* Row 2: amount + status badges — wraps if narrow */}
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Money value={row.invoice.totalSYP} className="text-base font-extrabold text-emerald-700" />
                    <div className="flex flex-wrap items-center gap-1.5">
                      {isFailed ? (
                        <Pill tone="red">{row.invoice.failureReason || "فشل"}</Pill>
                      ) : (
                        <Pill tone="amber">بانتظار المزامنة</Pill>
                      )}
                      {row.isLocalVoid && <Pill tone="slate">فاتورة إلغاء محلية</Pill>}
                      {!row.isLocalVoid && row.hasLocalVoid && <Pill tone="slate">ملغاة محلياً</Pill>}
                    </div>
                  </div>

                  {/*
                    Row 3: actions — flex-wrap so on a narrow screen
                    "طباعة"/"مشاركة" (inside ReceiptActions) and "إلغاء
                    الفاتورة" fall onto their own line instead of
                    overflowing the card. The void button's visibility
                    logic is UNCHANGED — still exactly canVoidOfflineInvoice()
                    + isAdmin, ABSENT (not disabled) for a CASHIER.
                  */}
                  <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-2.5">
                    <ReceiptActions
                      source={() =>
                        buildLocalReceiptSource({
                          tenantId,
                          invoice: row.invoice,
                          customerName: row.customerName,
                        })
                      }
                      offlineId={row.invoice.offlineId}
                      serverInvoiceId={row.invoice.serverId ?? null}
                      size="sm"
                    />

                    {/*
                      [ADDED] "إعادة المحاولة" — visible ONLY for a FAILED
                      row, for both roles (retrying a stuck sync is not a
                      privileged action the way voiding is). Disabled while
                      this specific invoice's retry is in flight, tracked
                      independently per-offlineId via retryingIds.
                    */}
                    {isFailed && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={retryingIds.has(row.invoice.offlineId)}
                        onClick={() => void handleRetryInvoice(row.invoice.offlineId)}
                        className="gap-1.5 border-amber-300 bg-white text-amber-800 hover:bg-amber-50"
                      >
                        <RotateCw
                          className={cn("size-3.5", retryingIds.has(row.invoice.offlineId) && "animate-spin")}
                          aria-hidden
                        />
                        إعادة المحاولة
                      </Button>
                    )}

                    {/* [role gate] ABSENT — not disabled — for a CASHIER session. */}
                    {canVoid && (
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={() => {
                          setVoidTarget(row);
                          setVoidReason("");
                          setError(null);
                        }}
                      >
                        إلغاء الفاتورة
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </DrawerContent>
      </Drawer>

      <Dialog open={!!voidTarget} onOpenChange={(open) => !open && setVoidTarget(null)}>
        <DialogContent dir="rtl" className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2.5 text-base font-extrabold text-slate-900">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-red-100 text-red-700">
                <AlertTriangle className="size-4.5" aria-hidden />
              </span>
              إلغاء الفاتورة
            </DialogTitle>
          </DialogHeader>

          <Textarea
            placeholder="سبب الإلغاء (مطلوب)"
            value={voidReason}
            onChange={(e) => setVoidReason(e.target.value)}
            className="min-h-24 border-slate-200 text-sm focus-visible:border-red-400 focus-visible:ring-red-400/20"
          />

          {error && (
            <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">
              {error}
            </p>
          )}

          <DialogFooter className="gap-2 sm:gap-2">
            <Button
              variant="destructive"
              disabled={!voidReason.trim() || isSubmitting}
              onClick={handleConfirmVoid}
              className="h-10 font-bold"
            >
              {isSubmitting ? "جارٍ الإلغاء..." : "تأكيد الإلغاء"}
            </Button>
            <Button variant="outline" onClick={() => setVoidTarget(null)} className="h-10 border-slate-200">
              رجوع
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}