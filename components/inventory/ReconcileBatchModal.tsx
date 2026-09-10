/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";

import { useState, useEffect, useCallback } from "react";
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

  // [FIX] Previously this synchronous reset (liveQuantity, deltaInput,
  // targetInput, reason, mode) lived inside a `useEffect` keyed on
  // [open, batch, fetchLiveBatch] — calling setState synchronously inside
  // an effect body to sync internal state FROM props is exactly the
  // anti-pattern React's own docs warn against (see
  // https://react.dev/learn/you-might-not-need-an-effect,
  // "Adjusting some state when a prop changes"), and is what the dev
  // overlay error was flagging. It also forced an extra, avoidable render
  // pass every time this modal opened (mount with stale/default state ->
  // effect runs -> second render with the real batch's data).
  //
  // Fix follows the same pattern already applied to EditProductModal.tsx:
  // adjust state DURING RENDER by comparing against a stored "last
  // initialized for" key, instead of inside an effect. React explicitly
  // supports this — it re-renders with the corrected state before
  // committing to the DOM, so the user never sees a stale intermediate
  // frame.
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

  const fetchLiveBatch = useCallback(async (batchId: string) => {
    setFetchingLive(true);
    try {
      const res = await fetch(`/api/inventory/batches/${batchId}`);
      if (res.ok) {
        const data = await res.json();
        if (data.batch) {
          setLiveQuantity(data.batch.quantity);
        }
      }
    } catch {
      // Fall back to batch.quantity prop
    } finally {
      setFetchingLive(false);
    }
  }, []);

  // [FIX] This useEffect is now the correct, narrow use of an effect —
  // fetching data over the network is one of the two documented
  // legitimate reasons to use an effect ("Fetching data" per React's own
  // guidance), unlike the synchronous prop-to-state sync that was removed
  // above. It only fires the network request; it no longer touches any of
  // the synchronous form-reset state, which is now handled entirely in
  // the render body above.
  // [FIX] Replaces the previous fetchLiveBatch + bare useEffect pair.
  //
  // The lint warning was pointing at a real bug, not just noise: calling
  // `fetchLiveBatch(batch.id)` directly inside the effect with no
  // cancellation guard means a STALE response can overwrite fresher state.
  // Scenario: user opens the modal for batch A (fetch A starts), quickly
  // closes and reopens it for batch B (effect re-runs, fetch B starts). If
  // fetch A's response arrives AFTER fetch B's (ordinary network jitter),
  // `setLiveQuantity` from the stale batch-A response silently overwrites
  // the correct batch-B quantity already on screen.
  //
  // The fix follows React's own documented pattern for effects that fetch
  // data (https://react.dev/learn/you-might-not-need-an-effect#fetching-data):
  // a cleanup function that flags the previous effect run's result as
  // stale, checked before every setState call. An AbortController is added
  // on top so the underlying HTTP request is actually cancelled too, not
  // just its result ignored — avoiding wasted network/server work whenever
  // the modal is closed/reopened quickly.
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
          // Only apply the result if this effect run is still the current
          // one — i.e. `batch`/`open` haven't changed since this fetch
          // started.
          if (!ignore && data.batch) {
            setLiveQuantity(data.batch.quantity);
          }
        }
      } catch (err) {
        // AbortError is expected whenever cleanup fires mid-request (modal
        // closed/reopened quickly) — not a real failure, so it's silently
        // swallowed here. Any other error falls back to the batch.quantity
        // prop, same as before.
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
  }, [open, batch]);

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