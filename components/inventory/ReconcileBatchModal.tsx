/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";

import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { RefreshCw, Scale, AlertCircle, ArrowRight } from "lucide-react";
import { toast } from "sonner";
import type { BatchItem } from "./ProductTable";

interface ReconcileBatchModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  batch: BatchItem | null;
  productName: string;
  onSuccess: () => void;
}

export function ReconcileBatchModal({
  open,
  onOpenChange,
  batch,
  productName,
  onSuccess,
}: ReconcileBatchModalProps) {
  const [mode, setMode] = useState<"delta" | "target">("delta");
  const [deltaInput, setDeltaInput] = useState<string>("");
  const [targetInput, setTargetInput] = useState<string>("");
  const [reason, setReason] = useState<string>("");
  const [submitting, setSubmitting] = useState<boolean>(false);

  const [liveQuantity, setLiveQuantity] = useState<number>(batch?.quantity ?? 0);
  const [fetchingLive, setFetchingLive] = useState<boolean>(false);

  // Adjusting state FROM PROPS during render (React's own recommended
  // pattern — see https://react.dev/learn/you-might-not-need-an-effect,
  // "Adjusting some state when a prop changes") instead of inside a
  // useEffect. Keyed on batch.id, not the batch object reference, so this
  // only re-runs when the modal is opened for a genuinely different batch
  // (or reopened), never on every parent re-render.
  const [initializedFor, setInitializedFor] = useState<string | null>(null);
  const currentInitKey = open && batch ? batch.id : null;

  if (currentInitKey !== initializedFor) {
    setInitializedFor(currentInitKey);

    if (batch) {
      setLiveQuantity(batch.quantity);
      setDeltaInput("");
      setTargetInput(String(batch.quantity));
      setReason("");
      setMode("delta");
    }
  }

  // [FIX] The previous version kept a separate `fetchLiveBatch` (defined
  // via useCallback) that had become dead code once this effect below was
  // rewritten to build its own fetch inline — nothing called it anymore.
  // Removed entirely rather than left unused.
  //
  // [FIX] Dependency array narrowed from `[open, batch]` to
  // `[open, batch?.id]`. Depending on the whole `batch` object means this
  // effect re-fires on every parent re-render that passes a new object
  // reference for the same batch (common when the parent doesn't memoize
  // it), triggering a redundant network request and a flash of
  // `fetchingLive` each time. Keying on `batch?.id` matches the render-time
  // reset above and only re-fires when the modal opens for an actually
  // different batch. `batch` itself is still used inside the effect body
  // (for `batch.id` in the fetch URL) via closure — safe because the
  // early-return guard narrows it to non-null for the rest of that run.
  //
  // The cancellation guard (`ignore` flag + AbortController) is unchanged:
  // it prevents a stale, slow response from a previous batch overwriting
  // the correct quantity already on screen after a quick close/reopen.
  useEffect(() => {
    if (!(open && batch)) return;

    let ignore = false;
    const controller = new AbortController();

    (async () => {
      setFetchingLive(true);
      try {
        const res = await fetch(`/api/inventory/batches/${batch.id}`, {
          signal: controller.signal,
        });
        if (res.ok) {
          const data = await res.json();
          if (!ignore && data.batch) {
            setLiveQuantity(data.batch.quantity);
          }
        }
      } catch (err) {
        if (!ignore && (err as Error)?.name !== "AbortError") {
          // Intentionally silent fallback — see original behavior.
        }
      } finally {
        if (!ignore) setFetchingLive(false);
      }
    })();

    return () => {
      ignore = true;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, batch?.id]);

  if (!batch) return null;

  let computedDelta = 0;
  if (mode === "delta") {
    computedDelta = parseFloat(deltaInput) || 0;
  } else {
    const targetVal = parseFloat(targetInput);
    if (!isNaN(targetVal)) {
      computedDelta = targetVal - liveQuantity;
    }
  }

  const projectedQuantity = liveQuantity + computedDelta;
  const isDeltaValid = computedDelta !== 0 && !isNaN(computedDelta);
  const isReasonValid = reason.trim().length >= 3;
  const canSubmit = isDeltaValid && isReasonValid && !submitting;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;

    setSubmitting(true);
    try {
      const res = await fetch(`/api/inventory/batches/${batch.id}/reconcile`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          quantityDelta: String(computedDelta),
          reason: reason.trim(),
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || "فشل إجراء التسوية المخزنية.");
      }

      toast.success(data.message || "تم تسجيل التسوية وتحديث الكمية بنجاح.");
      onOpenChange(false);
      onSuccess();
    } catch (err: any) {
      toast.error(err.message || "حدث خطأ أثناء إجراء التسوية.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" dir="rtl">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <div className="rounded-lg bg-purple-100 p-2 dark:bg-purple-950/40">
              <Scale className="h-5 w-5 text-purple-600 dark:text-purple-400" />
            </div>
            <div>
              <DialogTitle className="text-base font-bold text-zinc-900 dark:text-zinc-100">
                تسوية المخزون (Stock Reconciliation)
              </DialogTitle>
              <DialogDescription className="text-xs text-zinc-500">
                {productName} — دفعة #{batch.batchNumber} ({batch.unitName})
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4 py-2">
          <div className="rounded-lg border border-purple-200 bg-purple-50/60 p-3 text-xs dark:border-purple-900 dark:bg-purple-950/20">
            <div className="flex items-center justify-between">
              <span className="text-zinc-600 dark:text-zinc-400">الكمية الحالية المسجلة:</span>
              <div className="flex items-center gap-1.5 font-bold">
                {fetchingLive ? (
                  <RefreshCw className="h-3 w-3 animate-spin text-purple-600" />
                ) : (
                  <span
                    className={
                      liveQuantity < 0
                        ? "text-purple-700 dark:text-purple-400"
                        : "text-zinc-900 dark:text-zinc-100"
                    }
                  >
                    {liveQuantity} {batch.unitName}
                  </span>
                )}
                {liveQuantity < 0 && (
                  <span className="rounded bg-purple-200 px-1.5 py-0.5 text-[10px] text-purple-800 dark:bg-purple-900 dark:text-purple-200">
                    رصيد سالب
                  </span>
                )}
              </div>
            </div>
          </div>

          <div className="flex rounded-lg bg-zinc-100 p-1 text-xs dark:bg-zinc-800">
            <button
              type="button"
              onClick={() => setMode("delta")}
              className={`flex-1 rounded-md py-1.5 font-medium transition-all ${mode === "delta"
                ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-900 dark:text-zinc-100"
                : "text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
                }`}
            >
              تعديل بالفرق (Delta ±)
            </button>
            <button
              type="button"
              onClick={() => {
                setMode("target");
                setTargetInput(String(liveQuantity));
              }}
              className={`flex-1 rounded-md py-1.5 font-medium transition-all ${mode === "target"
                ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-900 dark:text-zinc-100"
                : "text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
                }`}
            >
              تحديد الكمية الفعلية (Target)
            </button>
          </div>

          {mode === "delta" ? (
            <div className="space-y-1.5">
              <Label htmlFor="deltaInput" className="text-xs font-semibold">
                فرق الكمية (+ للإضافة، - للخصم)
              </Label>
              <Input
                id="deltaInput"
                type="number"
                step="any"
                placeholder="مثال: +10 أو -3"
                value={deltaInput}
                onChange={(e) => setDeltaInput(e.target.value)}
                className="font-mono text-sm"
                autoFocus
                required
              />
              <p className="text-[11px] text-zinc-500">
                أدخل قيمة موجبة لإضافة بضاعة أو قيمة سالبة لشطب تلف أو تسوية عجز.
              </p>
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label htmlFor="targetInput" className="text-xs font-semibold">
                الكمية الفعلية الموجودة على الرف
              </Label>
              <Input
                id="targetInput"
                type="number"
                step="any"
                placeholder="مثال: 50"
                value={targetInput}
                onChange={(e) => setTargetInput(e.target.value)}
                className="font-mono text-sm"
                autoFocus
                required
              />
              <p className="text-[11px] text-zinc-500">
                سيتم حساب الفرق تلقائياً وإرساله كتسوية مخزنية (+{computedDelta}).
              </p>
            </div>
          )}

          {isDeltaValid && (
            <div className="flex items-center justify-between rounded-lg border border-zinc-200 bg-zinc-50 p-2.5 text-xs dark:border-zinc-800 dark:bg-zinc-900">
              <span className="text-zinc-500">الكمية بعد التسوية:</span>
              <div className="flex items-center gap-2 font-mono font-bold">
                <span className="text-zinc-500">{liveQuantity}</span>
                <ArrowRight className="h-3 w-3 text-zinc-400 rotate-180" />
                <span
                  className={
                    projectedQuantity < 0
                      ? "text-red-600"
                      : "text-emerald-600 dark:text-emerald-400"
                  }
                >
                  {projectedQuantity} {batch.unitName}
                </span>
                <span className="text-[10px] text-zinc-400">
                  ({computedDelta > 0 ? `+${computedDelta}` : computedDelta})
                </span>
              </div>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="reconcileReason" className="text-xs font-semibold">
              سبب التسوية <span className="text-red-500">*</span>
            </Label>
            <Textarea
              id="reconcileReason"
              placeholder="مثال: جرد دوري، بضاعة تالفة، تصحيح خطأ إدخال سابق..."
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="h-20 text-xs resize-none"
              required
            />
            {reason.trim().length > 0 && reason.trim().length < 3 && (
              <p className="flex items-center gap-1 text-[11px] text-red-500">
                <AlertCircle className="h-3 w-3" />
                يجب أن يحتوي السبب على 3 أحرف على الأقل.
              </p>
            )}
          </div>

          <DialogFooter className="gap-2 sm:gap-0 pt-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              إلغاء
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={!canSubmit}
              className="bg-purple-600 hover:bg-purple-700 text-white gap-1.5"
            >
              {submitting && <RefreshCw className="h-3.5 w-3.5 animate-spin" />}
              تأكيد وحفظ التسوية
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}