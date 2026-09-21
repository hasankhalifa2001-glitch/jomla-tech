"use client";

/**
 * components/pos/offline-void-panel.tsx
 *
 * T4d v4.1 §6.3 — the OFFLINE void entry point, and the ONLY UI surface that
 * ever voids a locally-queued, not-yet-synced invoice.
 *
 * WHY THIS IS NOT PART OF T4c2:
 * T4c2's Sales/Invoice Log reads exclusively from the server via
 * GET /api/invoices, so by construction it only ever shows invoices with
 * isSynced: true. It has no way to represent — and should not be made to
 * represent — an invoice that exists only in this device's local
 * offlineInvoices table. Voiding such an invoice cannot go through T4d's
 * online ledger void endpoint (the server has no record of it yet), so it must
 * be queued locally, exactly like the original sale was, and resolved later by
 * T4c's sync engine.
 *
 * This component therefore lives in components/pos/, where all
 * not-yet-synced data already lives, and calls exactly one thing:
 * submitOfflineVoid() (lib/offline/pos-service.ts). It NEVER calls the online
 * void endpoint (T4d's ADMIN-only ledger voids route), and performs no network
 * I/O of its own — both facts are asserted by static source scans in
 * lib/offline/__tests__/t4d-offline-void.test.ts. That same suite asserts the
 * mirror-image guarantee: nothing under components/sales-log/** ever imports
 * submitOfflineVoid.
 *
 * CONDITIONAL VISIBILITY (the core requirement): the panel is rendered ONLY
 * when at least one local invoice has status !== "SYNCED" — driven by the
 * live Dexie query in usePendingOfflineInvoices(). When every local invoice is
 * SYNCED this component returns null, so the panel is genuinely absent from
 * the DOM: not collapsed, not an empty state, simply not there.
 *
 * The void button is ABSENT (not disabled) for a CASHIER session, mirroring
 * T4c2's VoidButton pattern exactly — and submitOfflineVoid() re-checks the
 * role itself regardless, because a UI is never the security boundary.
 */

import { useState, type FormEvent } from "react";
import { AlertCircle, AlertTriangle, Ban, CloudOff, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  canVoidOfflineInvoice,
  shouldShowOfflineVoidPanel,
  submitOfflineVoid,
  usePendingOfflineInvoices,
  type OfflineVoidActorRole,
  type PendingOfflineInvoiceRow,
} from "@/lib/offline";
import { formatMoney } from "@/lib/utils/money";

interface OfflineVoidPanelProps {
  tenantId?: string;
  /** Resolved once by the caller (pos-layout, which owns the session). */
  isAdmin: boolean;
  /**
   * The ONE triggerSync instance owned by pos-layout's useSyncWorker() call.
   * Passed down rather than mounting a second useSyncWorker() here, which
   * would duplicate that hook's own debounced 0→positive scheduling effect.
   */
  triggerSync?: () => void;
}

function statusBadge(row: PendingOfflineInvoiceRow) {
  if (row.isLocalVoid) {
    return (
      <Badge
        variant="outline"
        className="gap-1 border-red-300 bg-red-50 px-2 py-0.5 text-[10px] font-bold text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
      >
        <Ban className="h-3 w-3" />
        <span>فاتورة إلغاء محلية</span>
      </Badge>
    );
  }

  if (row.hasLocalVoid) {
    return (
      <Badge
        variant="outline"
        className="gap-1 border-zinc-300 bg-zinc-100 px-2 py-0.5 text-[10px] font-bold text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
      >
        <Ban className="h-3 w-3" />
        <span>ملغاة محلياً</span>
      </Badge>
    );
  }

  if (row.invoice.status === "FAILED") {
    return (
      <Badge variant="destructive" className="gap-1 px-2 py-0.5 text-[10px] font-bold">
        <AlertTriangle className="h-3 w-3" />
        <span>فشلت المزامنة</span>
      </Badge>
    );
  }

  return (
    <Badge
      variant="outline"
      className="gap-1 border-amber-300 bg-amber-50 px-2 py-0.5 text-[10px] font-bold text-amber-800 dark:border-amber-800 dark:bg-amber-950/60 dark:text-amber-300"
    >
      <CloudOff className="h-3 w-3" />
      <span>بانتظار المزامنة</span>
    </Badge>
  );
}

function formatLocalTime(createdAt: Date | string): string {
  return new Date(createdAt).toLocaleTimeString("ar-SY", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function OfflineVoidPanel({ tenantId, isAdmin, triggerSync }: OfflineVoidPanelProps) {
  // Live, tenant-scoped Dexie query — see usePendingOfflineInvoices.
  const { rows, originals, localVoids, isReady } = usePendingOfflineInvoices(tenantId);

  const [voidTarget, setVoidTarget] = useState<PendingOfflineInvoiceRow | null>(null);
  // Last non-null target, kept purely so <Dialog> stays mounted for one beat
  // after voidTarget is cleared and Radix can animate itself closed — the same
  // fix VoidInvoiceModal carries (a naive early return on a null target would
  // unmount <Dialog> before its exit transition ever runs).
  const [displayRow, setDisplayRow] = useState<PendingOfflineInvoiceRow | null>(null);
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const isOpen = Boolean(voidTarget);

  // Same render-phase reset pattern VoidInvoiceModal/DeleteBatchModal use:
  // adjust state exactly once per OPEN transition, without an Effect (React's
  // "You Might Not Need an Effect").
  const [prevOpen, setPrevOpen] = useState(false);
  if (isOpen !== prevOpen) {
    setPrevOpen(isOpen);
    if (isOpen) setReason("");
  }
  if (voidTarget && voidTarget !== displayRow) setDisplayRow(voidTarget);

  async function handleConfirmVoid(e: FormEvent) {
    e.preventDefault();
    const target = voidTarget;
    if (!target || !tenantId) return;

    setSubmitting(true);
    try {
      // Passed through rather than assumed: submitOfflineVoid() re-checks it
      // itself and rejects a non-ADMIN actor even on a raw, direct call.
      const actorRole: OfflineVoidActorRole = isAdmin ? "ADMIN" : "CASHIER";

      await submitOfflineVoid(tenantId, {
        offlineInvoiceId: target.invoice.offlineId,
        voidReason: reason,
        actorRole,
      });

      toast.success(
        "تم تسجيل إلغاء الفاتورة محلياً — سيُزامن تلقائياً عند الاتصال بالإنترنت.",
      );
      setVoidTarget(null);

      // [v4.1] Explicit online check rather than delegating to the sync
      // worker's own internal offline handling: a freshly queued void should
      // flush immediately when we know we are online. When offline we
      // deliberately do nothing at all — useSyncWorker's own reconnect
      // listener already covers that case, and firing a doomed fetch here
      // would only add a guaranteed failure to the next sync summary.
      if (typeof navigator !== "undefined" && navigator.onLine) {
        triggerSync?.();
      }
    } catch (err) {
      // submitOfflineVoid()'s guards carry the precise Arabic reason (already
      // synced / not ADMIN / duplicate local void / blank reason / not found),
      // so surface it verbatim rather than a generic message.
      toast.error(
        err instanceof Error ? err.message : "تعذّر تسجيل إلغاء الفاتورة محلياً."
      );
    } finally {
      setSubmitting(false);
    }
  }

  // (1) The live query has not resolved yet, or (2) nothing is outstanding.
  // Either way the panel is genuinely ABSENT from the DOM — not collapsed, not
  // an empty state, simply not rendered.
  if (!isReady || !shouldShowOfflineVoidPanel(rows.map((r) => r.invoice))) {
    return null;
  }

  const canSubmit = reason.trim().length >= 3 && !submitting;

  return (
    <>
      <section
        aria-label="فواتير لم تتم مزامنتها"
        className="shrink-0 rounded-2xl border border-amber-300 bg-amber-50/70 p-3 shadow-xs dark:border-amber-900 dark:bg-amber-950/30"
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <CloudOff className="h-4 w-4 shrink-0 text-amber-600" />
            <h2 className="truncate text-xs font-bold text-amber-900 dark:text-amber-200">
              فواتير لم تتم مزامنتها
            </h2>
            <Badge className="bg-amber-600 px-1.5 py-0 text-[10px] font-bold text-white">
              {rows.length}
            </Badge>
          </div>
          <p className="hidden text-[10px] text-amber-700 sm:block dark:text-amber-400">
            محفوظة على هذا الجهاز فقط — يمكن للمدير إلغاؤها من هنا قبل مزامنتها.
          </p>
        </div>

        <ul className="mt-2 space-y-1.5">
          {rows.map((row) => {
            // Absent, NOT disabled, for a CASHIER session or for an
            // already-locally-voided row — see canVoidOfflineInvoice().
            const voidable = canVoidOfflineInvoice(row.invoice, isAdmin, row.hasLocalVoid);

            return (
              <li
                key={row.invoice.offlineId}
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-200 bg-white/80 px-2.5 py-1.5 dark:border-amber-900/60 dark:bg-zinc-900/70"
              >
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="truncate text-[11px] font-bold text-zinc-800 dark:text-zinc-100">
                    {row.customerName}
                  </span>
                  <span className="font-mono text-[11px] font-extrabold text-zinc-900 dark:text-zinc-100">
                    {formatMoney(row.invoice.totalSYP, "SYP")} ل.س
                  </span>
                  <span className="text-[10px] text-zinc-500">
                    {formatLocalTime(row.invoice.createdAt)}
                  </span>
                  {statusBadge(row)}
                </div>

                {row.invoice.status === "FAILED" && row.invoice.failureReason && (
                  <p className="w-full text-[10px] text-red-600 dark:text-red-400">
                    {row.invoice.failureReason}
                  </p>
                )}

                {voidable && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setVoidTarget(row)}
                    className="h-7 gap-1 border-red-200 px-2 text-[11px] font-bold text-red-600 hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950/40"
                  >
                    <Ban className="h-3 w-3" />
                    <span>إلغاء الفاتورة</span>
                  </Button>
                )}
              </li>
            );
          })}
        </ul>

        {/* The two lists the live query splits out are surfaced separately so
            a locally-queued VOID is never mistaken for an outstanding sale. */}
        {localVoids.length > 0 && (
          <p className="mt-2 text-[10px] text-zinc-500">
            بينها {localVoids.length} فاتورة إلغاء محلية بانتظار الترحيل، و
            {originals.length} فاتورة بيع قابلة للإلغاء.
          </p>
        )}
      </section>

      <Dialog
        open={isOpen}
        onOpenChange={(open) => {
          if (!open) setVoidTarget(null);
        }}
      >
        <DialogContent className="sm:max-w-lg" dir="rtl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base font-bold text-red-700 dark:text-red-300">
              <Ban className="h-4 w-4" />
              <span>إلغاء فاتورة محلية (لم تتم مزامنتها)</span>
            </DialogTitle>
            <DialogDescription className="text-xs text-zinc-500">
              هذا الإجراء يلغي فاتورة موجودة على هذا الجهاز فقط ولم تصل إلى السيرفر
              بعد — سيُرحَّل الإلغاء مع المزامنة القادمة.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleConfirmVoid} className="space-y-4 py-2">
            <div className="space-y-2 rounded-lg border border-amber-300 bg-amber-50/70 p-3 text-xs dark:border-amber-900 dark:bg-amber-950/20">
              <div className="flex items-start gap-2 font-medium text-amber-900 dark:text-amber-200">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                <span>
                  سيتم إنشاء فاتورة إلغاء محلية بنفس الأصناف بكميات سالبة، مع إرجاع الدين
                  إلى رصيد الزبون. لا يمكن التراجع عن هذا الإجراء.
                </span>
              </div>

              {displayRow && (
                <div className="grid grid-cols-2 gap-2 border-t border-amber-300/60 pt-2 text-[11px] text-zinc-600 dark:border-amber-900/60 dark:text-zinc-400">
                  <div>
                    الزبون:{" "}
                    <span className="font-bold text-zinc-800 dark:text-zinc-200">
                      {displayRow.customerName}
                    </span>
                  </div>
                  <div>
                    قيمة الفاتورة:{" "}
                    <span className="font-bold text-zinc-800 dark:text-zinc-200">
                      {formatMoney(displayRow.invoice.totalSYP, "SYP")} ل.س
                    </span>
                  </div>
                  <div className="col-span-2">
                    رقم الفاتورة المحلي:{" "}
                    <span className="font-mono text-[10px]">
                      {displayRow.invoice.offlineId}
                    </span>
                  </div>
                </div>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="offlineVoidReason" className="text-xs font-semibold">
                سبب الإلغاء <span className="text-red-500">*</span>
              </Label>
              <Textarea
                id="offlineVoidReason"
                placeholder="مثال: إدخال خاطئ للفاتورة، إرجاع كامل من الزبون، تكرار بالخطأ..."
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                className="h-20 resize-none text-xs"
                required
              />
              {reason.trim().length > 0 && reason.trim().length < 3 && (
                <p className="flex items-center gap-1 text-[11px] text-red-500">
                  <AlertCircle className="h-3 w-3" />
                  يجب أن يحتوي السبب على 3 أحرف على الأقل.
                </p>
              )}
            </div>

            <DialogFooter className="gap-2 pt-2 sm:gap-0">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setVoidTarget(null)}
                disabled={submitting}
              >
                إلغاء
              </Button>
              <Button
                type="submit"
                size="sm"
                variant="destructive"
                disabled={!canSubmit}
                className="gap-1.5"
              >
                {submitting && <RefreshCw className="h-3.5 w-3.5 animate-spin" />}
                تأكيد إلغاء الفاتورة محلياً
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
