"use client";

/**
 * components/ledger/adjustments-history-drawer.tsx
 *
 * T4e v6.1 — per-customer balance-adjustment history.
 * Consumes GET /api/ledger/adjustments?customerId= (ADMIN + CASHIER read-only).
 * Shows each adjustment with its kind label, reason, who entered it and when
 * (Asia/Damascus). Visible to both roles — a CASHIER can view, never add.
 *
 * Built on the project's existing Dialog (the same pattern as
 * merge-customers-modal.tsx) so it adds no dependency. The component keeps its
 * "Drawer" name so customer-card.tsx's import is unchanged.
 *
 * Money is only ever formatted here (formatMoney), never summed: the sign of a
 * row decides its label/colour, using string checks on the Decimal string.
 * No USD anywhere in this feature.
 */

import { useEffect, useState } from "react";
import { Clock, FileText, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { formatMoney } from "@/lib/utils/money";
import { SYRIA_UTC_OFFSET_HOURS } from "@/lib/utils/syria-time";

interface AdjustmentHistoryRow {
  id: string;
  kind: string;
  amountSYP: string;
  reason: string;
  createdAt: string;
  createdByUser?: { name: string | null };
}

interface AdjustmentsHistoryDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  customerId: string;
  customerName: string;
}

/** One fetch result, tagged with the customer it belongs to. */
interface LoadedState {
  customerId: string;
  rows: AdjustmentHistoryRow[];
  error: string | null;
}

// Same wording the statement uses (spec 5.7).
const KIND_LABELS: Record<string, string> = {
  OPENING_BALANCE: "رصيد سابق",
  CORRECTION: "تصحيح رصيد",
};

const HOUR_MS = 60 * 60 * 1000;
const FETCH_ERROR = "فشل جلب تعديلات الرصيد.";

/**
 * Sign + amount for display. A positive amount INCREASES what the customer
 * owes ("+"), a negative one decreases it ("−"). The sign is decided by the
 * Decimal string itself, never by the row's kind: a CORRECTION can go either
 * way and must never look like an increase when it is a decrease.
 */
function describeAmount(amountSYP: string): { decrease: boolean; text: string } {
  const trimmed = amountSYP.trim();
  const decrease = trimmed.startsWith("-");
  const absolute = decrease ? trimmed.slice(1) : trimmed;
  return {
    decrease,
    text: `${decrease ? "−" : "+"}${formatMoney(absolute, "SYP")}`,
  };
}

/**
 * Damascus wall-clock time. Syria is a fixed UTC+3 (lib/utils/syria-time.ts is
 * the project's one definition of that, deliberately not Intl-zone based), so
 * shift the instant by that offset and format it as UTC. This never depends on
 * the device's own time zone.
 */
function formatDamascusTime(iso: string): string {
  const instant = new Date(iso).getTime();
  if (Number.isNaN(instant)) return "—";
  return new Date(instant + SYRIA_UTC_OFFSET_HOURS * HOUR_MS).toLocaleString("ar-SY", {
    timeZone: "UTC",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

async function requestAdjustments(customerId: string): Promise<AdjustmentHistoryRow[]> {
  const res = await fetch(`/api/ledger/adjustments?customerId=${encodeURIComponent(customerId)}`);
  // The body may not be JSON on a gateway/network error page.
  const body = await res.json().catch(() => null);
  if (!res.ok || !body) {
    throw new Error(body?.message || FETCH_ERROR);
  }
  return body.adjustments ?? [];
}

export function AdjustmentsHistoryDrawer({
  open,
  onOpenChange,
  customerId,
  customerName,
}: AdjustmentsHistoryDrawerProps) {
  const [loaded, setLoaded] = useState<LoadedState | null>(null);
  // Bumped by "إعادة المحاولة" to re-run the fetch effect.
  const [attempt, setAttempt] = useState(0);

  // Fetch whenever the dialog is open and there is no result for THIS customer
  // yet. State is only set from the async callbacks (never synchronously in
  // the effect); `cancelled` drops a response that arrives after close/unmount.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    requestAdjustments(customerId)
      .then((rows) => {
        if (!cancelled) setLoaded({ customerId, rows, error: null });
      })
      .catch((err) => {
        if (!cancelled) {
          setLoaded({
            customerId,
            rows: [],
            error: err instanceof Error ? err.message : FETCH_ERROR,
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, customerId, attempt]);

  // Closing discards the result, so the next open always shows fresh data
  // (a debt may have been added or merged in the meantime).
  const handleOpenChange = (next: boolean) => {
    if (!next) setLoaded(null);
    onOpenChange(next);
  };

  const handleRetry = () => {
    setLoaded(null);
    setAttempt((n) => n + 1);
  };

  const current = loaded && loaded.customerId === customerId ? loaded : null;
  const isLoading = open && current === null;
  const rows = current?.rows ?? [];

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        dir="rtl"
        className="flex max-h-[calc(100dvh-2rem)] w-[calc(100%-1.5rem)] flex-col gap-0 overflow-hidden rounded-2xl border-zinc-200 p-0 text-start sm:max-w-lg *:min-w-0"
      >
        <DialogHeader className="gap-0 border-b border-zinc-100 px-4 pb-3 pt-4 pe-14 text-start">
          <DialogTitle className="truncate text-base font-extrabold text-zinc-900">
            تعديلات رصيد {customerName}
          </DialogTitle>
          <DialogDescription className="mt-0.5 text-xs leading-relaxed text-zinc-500">
            الأرصدة السابقة والتصحيحات لهذا الزبون، بتوقيت دمشق. السجل كامل ولا يُعدَّل ولا يُحذف.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain px-4 py-3">
          {isLoading ? (
            <div
              role="status"
              className="flex flex-col items-center gap-2 py-8 text-sm text-zinc-500"
            >
              <Clock className="size-5 animate-pulse" aria-hidden />
              <span>جارٍ التحميل…</span>
            </div>
          ) : current?.error ? (
            <div
              role="alert"
              className="flex flex-wrap items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700"
            >
              <span className="min-w-0 flex-1 font-semibold">{current.error}</span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={handleRetry}
                className="h-8 gap-1.5 rounded-lg border-red-200 bg-white text-xs font-bold text-red-700 hover:bg-red-50"
              >
                <RefreshCw className="size-3.5" aria-hidden />
                إعادة المحاولة
              </Button>
            </div>
          ) : rows.length === 0 ? (
            <div className="rounded-xl border-2 border-dashed border-zinc-200 bg-zinc-50 px-4 py-8 text-center">
              <FileText className="mx-auto mb-2 size-6 text-zinc-300" aria-hidden />
              <p className="text-sm text-zinc-600">لا توجد تعديلات رصيد لهذا الزبون.</p>
            </div>
          ) : (
            <ul className="space-y-2">
              {rows.map((row) => {
                const { decrease, text } = describeAmount(row.amountSYP);
                return (
                  <li
                    key={row.id}
                    className="space-y-1 rounded-xl border border-zinc-200 bg-white p-3"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-xs font-bold text-zinc-800">
                        {KIND_LABELS[row.kind] ?? row.kind}
                      </span>
                      <span
                        dir="ltr"
                        className={cn(
                          "text-sm font-extrabold tabular-nums [unicode-bidi:isolate]",
                          // A decrease lowers the debt (good); an increase raises it.
                          decrease ? "text-emerald-700" : "text-rose-700"
                        )}
                      >
                        {text}
                      </span>
                    </div>
                    <p className="wrap-break-word text-xs leading-relaxed text-zinc-600">
                      {row.reason || "—"}
                    </p>
                    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 text-[11px] text-zinc-400">
                      <span>بواسطة {row.createdByUser?.name || "—"}</span>
                      <span>{formatDamascusTime(row.createdAt)}</span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <DialogFooter className="border-t border-zinc-100 bg-white px-4 py-3">
          <Button
            type="button"
            variant="outline"
            onClick={() => handleOpenChange(false)}
            className="h-10 w-full rounded-xl text-xs font-bold"
          >
            إغلاق
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}