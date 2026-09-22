"use client";

import { useState } from "react";
import { usePendingOfflineInvoices } from "@/lib/offline/pending-offline-invoices";
import {
  submitOfflineVoid,
  canVoidOfflineInvoice,
  shouldShowOfflineVoidPanel,
  type PendingOfflineInvoiceRow,
} from "@/lib/offline/pos-service";
import { formatMoney } from "@/lib/utils/money";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";

/**
 * components/pos/offline-void-panel.tsx
 *
 * T4d v4.1 §6.3 — the ONLY entry point for voiding a local, not-yet-synced
 * invoice. Per the spec, mounted inside pos-layout.tsx directly under the
 * top status bar, so it's visible on both mobile and desktop layouts.
 *
 * [ASSUMPTION — please confirm/adjust] Import paths for
 * Button/Badge/Dialog/Textarea assume a standard shadcn/ui setup under
 * components/ui/**, per T1's Dependencies list (shadcn/ui). If this
 * project's actual component paths or prop names differ, only these
 * import lines and the JSX prop names below need adjusting — nothing
 * else in this file (the data flow, the guards, the role gate) depends
 * on their exact shape.
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

  // Genuinely absent from the DOM — not a collapsed section, not an empty
  // state message. See this file's own header note.
  // shouldShowOfflineVoidPanel expects an array of objects with a `status` field.
  // Map the pending rows to the minimal shape the guard requires.
  if (!shouldShowOfflineVoidPanel(rows.map((r) => ({ status: r.invoice.status })))) {
    return null;
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
    <div dir="rtl" className="w-full rounded-lg border border-amber-300 bg-amber-50 p-3 mb-3">
      <h3 className="mb-2 text-sm font-bold text-amber-800">فواتير لم تتم مزامنتها</h3>

      <div className="space-y-2">
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
              className="flex items-center justify-between rounded-md border border-amber-200 bg-white px-3 py-2"
            >
              <div className="flex flex-col">
                <span className="text-sm font-medium">{row.customerName}</span>
                <span className="text-xs text-slate-500">
                  {row.invoice.createdAt.toLocaleTimeString("ar-SY")}
                </span>
              </div>

              <div className="flex items-center gap-2">
                <span className="font-bold text-emerald-600">
                  {formatMoney(row.invoice.totalSYP, "SYP")}
                </span>

                {row.invoice.status === "FAILED" ? (
                  <Badge variant="destructive">{row.invoice.failureReason || "فشل"}</Badge>
                ) : (
                  <Badge variant="outline">بانتظار المزامنة</Badge>
                )}

                {row.isLocalVoid && <Badge variant="secondary">فاتورة إلغاء محلية</Badge>}
                {!row.isLocalVoid && row.hasLocalVoid && (
                  <Badge variant="secondary">ملغاة محلياً</Badge>
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

      <p className="mt-2 text-xs text-amber-700">
        بينها {originals.length} فاتورة بيع قابلة للإلغاء، و{localVoids.length} فاتورة إلغاء
        بانتظار التزامن.
      </p>

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