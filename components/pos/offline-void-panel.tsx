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
import { formatMoney } from "@/lib/utils/money";
import { ReceiptActions } from "@/components/receipts/receipt-actions";
import { buildLocalReceiptSource } from "@/lib/receipts/local-receipt-source";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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

/**
 * components/pos/offline-void-panel.tsx
 *
 * T4d v4.1 §6.3 — the ONLY entry point for voiding a local, not-yet-synced
 * invoice. Per the spec, mounted inside pos-layout.tsx directly under the
 * top status bar, so it's visible on both mobile and desktop layouts.
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
 * New structure, same data/logic underneath (usePendingOfflineInvoices,
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
 *      for a CASHIER) — it simply now sits in its own wrapping row instead
 *      of being squeezed into one unbreakable horizontal line.
 *
 * [ADDED — retry for a FAILED invoice] A FAILED row now also gets an
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
 * Button/Badge/Dialog/Drawer/Textarea assume a standard shadcn/ui setup
 * under components/ui/**, per T1's Dependencies list (shadcn/ui), and
 * mirror the same Drawer already used for the mobile cart sheet in
 * pos-layout.tsx. If this project's actual component paths or prop names
 * differ, only these import lines and the JSX prop names below need
 * adjusting — nothing else in this file (the data flow, the guards, the
 * role gate) depends on their exact shape.
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
      <div className="flex items-center justify-between gap-2 rounded-2xl border border-amber-300 bg-amber-50 px-3 py-2 dark:border-amber-900 dark:bg-amber-950/40">
        <div className="flex items-center gap-1.5 min-w-0 flex-wrap">
          {pendingCount > 0 && (
            <Badge
              variant="outline"
              className="gap-1 px-2 py-0.5 text-[11px] border-amber-300 bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300 dark:border-amber-800 font-semibold whitespace-nowrap"
            >
              <CloudOff className="h-3 w-3 text-amber-600" />
              <span>{pendingCount} بانتظار المزامنة</span>
            </Badge>
          )}
          {failedCount > 0 && (
            <Badge
              variant="destructive"
              className="gap-1 px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap"
            >
              <AlertTriangle className="h-3 w-3" />
              <span>{failedCount} فشلت المزامنة</span>
            </Badge>
          )}
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleManualSync}
            disabled={isSyncing}
            className="h-8 text-xs gap-1.5 text-amber-800 border-amber-300 hover:bg-amber-100 dark:text-amber-300 dark:border-amber-800"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isSyncing ? "animate-spin" : ""}`} />
            <span className="hidden sm:inline">مزامنة الآن</span>
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => setIsDetailsOpen(true)}
            className="h-8 text-xs gap-1 bg-amber-600 hover:bg-amber-700 text-white"
          >
            <span>عرض التفاصيل</span>
            <ChevronLeft className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/*
        [ADDED] The full invoice list lives ONLY inside this drawer now —
        it never renders inline in the main POS layout, so it can never
        push the search/cart/checkout UI around no matter how many pending
        invoices exist.
      */}
      <Drawer open={isDetailsOpen} onOpenChange={setIsDetailsOpen}>
        <DrawerContent className="max-h-[85vh] p-0" dir="rtl">
          <DrawerHeader className="text-right px-4 pt-4 pb-2">
            <DrawerTitle className="text-amber-800 dark:text-amber-300">
              فواتير لم تتم مزامنتها
            </DrawerTitle>
            <DrawerDescription>
              بينها {originals.length} فاتورة بيع قابلة للإلغاء، و{localVoids.length} فاتورة
              إلغاء بانتظار التزامن.
            </DrawerDescription>
          </DrawerHeader>

          <div className="flex-1 overflow-y-auto px-4 pb-4 space-y-2">
            {rows.map((row) => {
              const canVoid = canVoidOfflineInvoice(
                {
                  status: row.invoice.status,
                  voidsOfflineInvoiceId: row.invoice.voidsOfflineInvoiceId,
                },
                isAdmin,
                row.hasLocalVoid
              );

              return (
                <div
                  key={row.invoice.offlineId}
                  className="rounded-xl border border-amber-200 bg-white p-3 space-y-2 dark:border-amber-900 dark:bg-zinc-900"
                >
                  {/* Row 1: customer name + time */}
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-bold text-zinc-800 dark:text-zinc-200 truncate">
                      {row.customerName}
                    </span>
                    <span className="text-xs text-zinc-400 whitespace-nowrap shrink-0">
                      {row.invoice.createdAt.toLocaleTimeString("ar-SY")}
                    </span>
                  </div>

                  {/* Row 2: amount + status badges — wraps if narrow */}
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <span className="font-bold text-emerald-600 font-mono">
                      {formatMoney(row.invoice.totalSYP, "SYP")} ل.س
                    </span>
                    <div className="flex items-center gap-1.5 flex-wrap">
                      {row.invoice.status === "FAILED" ? (
                        <Badge variant="destructive" className="text-[10px]">
                          {row.invoice.failureReason || "فشل"}
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-[10px]">
                          بانتظار المزامنة
                        </Badge>
                      )}
                      {row.isLocalVoid && (
                        <Badge variant="secondary" className="text-[10px]">
                          فاتورة إلغاء محلية
                        </Badge>
                      )}
                      {!row.isLocalVoid && row.hasLocalVoid && (
                        <Badge variant="secondary" className="text-[10px]">
                          ملغاة محلياً
                        </Badge>
                      )}
                    </div>
                  </div>

                  {/*
                    Row 3: actions — flex-wrap so on a narrow screen
                    "طباعة"/"مشاركة" (inside ReceiptActions) and "إلغاء
                    الفاتورة" fall onto their own line instead of
                    overflowing the card. The void button's visibility
                    logic is UNCHANGED from the original single-row layout
                    — still exactly canVoidOfflineInvoice() + isAdmin,
                    ABSENT (not disabled) for a CASHIER.
                  */}
                  <div className="flex items-center gap-2 flex-wrap pt-1 border-t border-amber-100 dark:border-amber-900/60">
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
                    {row.invoice.status === "FAILED" && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={retryingIds.has(row.invoice.offlineId)}
                        onClick={() => void handleRetryInvoice(row.invoice.offlineId)}
                        className="gap-1.5 text-amber-800 border-amber-300 hover:bg-amber-50 dark:text-amber-300 dark:border-amber-800"
                      >
                        <RotateCw
                          className={`h-3.5 w-3.5 ${retryingIds.has(row.invoice.offlineId) ? "animate-spin" : ""
                            }`}
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
        <DialogContent dir="rtl">
          <DialogHeader>
            <DialogTitle>إلغاء الفاتورة</DialogTitle>
          </DialogHeader>

          <Textarea
            placeholder="سبب الإلغاء (مطلوب)"
            value={voidReason}
            onChange={(e) => setVoidReason(e.target.value)}
          />

          {error && <p className="text-sm text-red-600">{error}</p>}

          <DialogFooter>
            <Button
              variant="destructive"
              disabled={!voidReason.trim() || isSubmitting}
              onClick={handleConfirmVoid}
            >
              {isSubmitting ? "جارٍ الإلغاء..." : "تأكيد الإلغاء"}
            </Button>
            <Button variant="outline" onClick={() => setVoidTarget(null)}>
              رجوع
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}