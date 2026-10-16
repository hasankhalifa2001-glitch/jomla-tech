"use client";

/**
 * components/receipts/receipt-edit-modal.tsx
 *
 * v4.7 Phase 7 — the ADMIN header edit dialog: purchase date + supplier,
 * NOTHING else. It is the UI half of PATCH /api/receipts/[id]'s strict
 * allowlist; any financial field is rejected server-side regardless.
 *
 * [DATE RULES — Round A's own boundaries] The bounds come from GET
 * /api/receipts/defaults (server clock): min = minDate (businessDate − 730
 * days), max = businessDate (never in the future). The field PREFILLS with
 * the receipt's current purchaseDate (editing keeps today's value unless
 * changed — never silently re-stamped to today), and the same client-side
 * checks MultiProductReceiptModal performs run here before any request, so
 * an obviously-out-of-range pick never costs a round-trip. The server
 * re-validates with the exact same schemas (purchaseDateSchema) anyway.
 *
 * [CLIENT IS NOT THE BOUNDARY] PATCH asserts `receipts:edit` and
 * assertTenantWritable() server-side; this dialog just talks to it.
 *
 * [UI/UX PASS] Footer buttons are full-width on mobile (primary action
 * first/top is handled by DialogFooter's flex-col-reverse), the date input
 * is an LTR field (browsers render yyyy-mm-dd / dd/mm/yyyy LTR), the bounds
 * hint is an LTR island, and inputs are 44px tall for touch.
 *
 * [v4.8 — polish pass, presentation only] A gradient header with an icon,
 * the allowed range as a small info strip, a character counter on the
 * supplier field, and a bordered footer. All state handling, the render-phase
 * prefill, the date checks and the PATCH call are unchanged.
 */

import { useCallback, useEffect, useState } from "react";
import { CalendarDays, Info, Loader2, Pencil, Save, Store } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { formatDbDate } from "@/lib/inventory/date-utils";
import type { EditTarget, ReceivingDefaults } from "./types";

interface ReceiptEditModalProps {
  target: EditTarget | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}

const SUPPLIER_MAX = 120;

export function ReceiptEditModal({ target, onOpenChange, onSaved }: ReceiptEditModalProps) {
  const open = target !== null;

  const [purchaseDate, setPurchaseDate] = useState("");
  const [supplierName, setSupplierName] = useState("");
  const [defaults, setDefaults] = useState<ReceivingDefaults | null>(null);
  const [defaultsError, setDefaultsError] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Prefill whenever a (different) target is opened — keyed on id+open so a
  // parent re-render with a fresh object reference can't wipe typing.
  const targetId = target?.id ?? null;
  const [prevOpen, setPrevOpen] = useState(open);
  const [prevTargetId, setPrevTargetId] = useState<string | null>(targetId);
  if (open !== prevOpen || targetId !== prevTargetId) {
    setPrevOpen(open);
    setPrevTargetId(targetId);
    if (open && target) {
      setPurchaseDate(formatDbDate(new Date(target.purchaseDate)));
      setSupplierName(target.supplierName ?? "");
      setSubmitting(false);
      setDefaultsError(false);
    }
  }

  const fetchDefaults = useCallback(() => {
    fetch("/api/receipts/defaults")
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data?.message || "تعذّر جلب تواريخ التعديل المسموحة.");
        return data as ReceivingDefaults;
      })
      .then((data) => {
        setDefaults(data);
        setDefaultsError(false);
      })
      .catch(() => {
        setDefaults(null);
        setDefaultsError(true);
        // The server is the source of the bounds; without them the date
        // field stays DISABLED (mirrors the receiving forms' rule: never
        // fall back to the device clock).
      });
  }, []);

  useEffect(() => {
    if (open) fetchDefaults();
  }, [open, fetchDefaults]);

  const handleSubmit = useCallback(() => {
    if (!target || submitting) return;

    if (!purchaseDate) {
      toast.error("اختر تاريخ الشراء أولاً.");
      return;
    }
    if (defaults) {
      if (purchaseDate > defaults.businessDate) {
        toast.error("لا يمكن أن يكون تاريخ الشراء في المستقبل.");
        return;
      }
      if (purchaseDate < defaults.minDate) {
        toast.error("تاريخ الشراء قديم جداً — الحد الأدنى أدناه.");
        return;
      }
    }
    if (supplierName.length > 120) {
      toast.error("اسم المورد طويل جدا (الحد الأقصى 120 حرفا).");
      return;
    }

    setSubmitting(true);
    fetch(`/api/receipts/${target.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      // The strict allowlist: these two keys ONLY — the server 400s any
      // other key (especially financial ones) before touching the DB.
      body: JSON.stringify({ purchaseDate, supplierName }),
    })
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data?.message || "تعذّر تحديث بيانات الاستلام.");
        return data;
      })
      .then(() => {
        toast.success("تم تحديث بيانات الاستلام بنجاح.");
        onSaved();
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : "تعذّر تحديث بيانات الاستلام.";
        toast.error(message);
        setSubmitting(false);
      });
  }, [target, submitting, purchaseDate, defaults, supplierName, onSaved]);

  const nearLimit = supplierName.length >= SUPPLIER_MAX - 20;

  return (
    <Dialog open={open} onOpenChange={(next) => !submitting && onOpenChange(next)}>
      <DialogContent
        dir="rtl"
        className="flex max-h-[calc(100dvh-2rem)] w-[calc(100%-1.5rem)] flex-col gap-0 overflow-hidden rounded-2xl border-zinc-200 p-0 sm:max-w-md [&>*]:min-w-0"
      >
        <DialogHeader className="gap-0 border-b border-zinc-100 bg-linear-to-b from-emerald-50/70 to-white px-4 pb-3 pt-4 pe-14 text-start sm:px-6">
          <div className="flex items-center gap-3">
            <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-emerald-600 text-white shadow-sm shadow-emerald-600/25">
              <Pencil className="size-5" aria-hidden />
            </div>
            <div className="min-w-0 flex-1">
              <DialogTitle className="text-base font-extrabold text-zinc-900">تعديل بيانات الاستلام</DialogTitle>
              <DialogDescription className="mt-0.5 text-xs leading-relaxed text-zinc-500">
                تاريخ الشراء واسم المورّد فقط — كميات وتكاليف الاستلام غير قابلة للتعديل.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain px-4 py-5 sm:px-6">
          <div className="space-y-2">
            <Label htmlFor="receipt-purchase-date" className="flex items-center gap-1.5 text-xs font-bold text-zinc-700">
              <CalendarDays className="size-3.5 text-emerald-600" aria-hidden />
              تاريخ الشراء
            </Label>
            <Input
              id="receipt-purchase-date"
              type="date"
              dir="ltr"
              value={purchaseDate}
              // Bounds from the SERVER (Round A) — disabled until they load
              // rather than guessed from the device clock.
              min={defaults?.minDate}
              max={defaults?.businessDate}
              disabled={!defaults || submitting}
              onChange={(e) => setPurchaseDate(e.target.value)}
              className="h-11 rounded-xl text-start text-sm transition-shadow focus-visible:border-emerald-500 focus-visible:ring-emerald-500/20 sm:h-10"
            />
            <p
              className={cn(
                "flex items-start gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] leading-relaxed",
                defaultsError ? "bg-red-50 font-semibold text-red-700" : "bg-zinc-50 text-zinc-500"
              )}
            >
              <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <span>
                {defaultsError ? (
                  "تعذّر جلب الحدود المسموحة من الخادم — أعد فتح النافذة للمحاولة."
                ) : defaults ? (
                  <>
                    النطاق المسموح: من{" "}
                    <span dir="ltr" className="inline-block font-semibold tabular-nums [unicode-bidi:isolate]">
                      {defaults.minDate}
                    </span>{" "}
                    حتى{" "}
                    <span dir="ltr" className="inline-block font-semibold tabular-nums [unicode-bidi:isolate]">
                      {defaults.businessDate}
                    </span>
                  </>
                ) : (
                  "جارٍ جلب النطاق المسموح من الخادم..."
                )}
              </span>
            </p>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="receipt-supplier" className="flex items-center gap-1.5 text-xs font-bold text-zinc-700">
                <Store className="size-3.5 text-emerald-600" aria-hidden />
                المورّد <span className="font-normal text-zinc-400">(اختياري)</span>
              </Label>
              <span
                dir="ltr"
                className={cn(
                  "text-[11px] font-semibold tabular-nums transition-colors",
                  nearLimit ? "text-amber-600" : "text-zinc-400"
                )}
              >
                {supplierName.length}/{SUPPLIER_MAX}
              </span>
            </div>
            <Input
              id="receipt-supplier"
              type="text"
              value={supplierName}
              maxLength={SUPPLIER_MAX}
              disabled={submitting}
              placeholder="مثال: شركة الفجر للتجارة"
              onChange={(e) => setSupplierName(e.target.value)}
              className="h-11 rounded-xl text-sm transition-shadow focus-visible:border-emerald-500 focus-visible:ring-emerald-500/20 sm:h-10"
            />
          </div>
        </div>

        <DialogFooter className="gap-2 border-t border-zinc-100 bg-white px-4 py-3 sm:px-6">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={submitting}
            onClick={() => onOpenChange(false)}
            className="h-11 w-full rounded-xl text-xs font-bold transition-transform active:scale-[0.98] sm:h-10 sm:w-auto sm:px-6"
          >
            إلغاء
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={submitting || !defaults || !purchaseDate}
            onClick={handleSubmit}
            className="h-11 w-full gap-1.5 rounded-xl bg-emerald-600 text-xs font-bold shadow-sm shadow-emerald-600/25 transition-all hover:bg-emerald-700 active:scale-[0.98] sm:h-10 sm:w-auto sm:px-8"
          >
            {submitting ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
            ) : (
              <Save className="size-3.5" aria-hidden />
            )}
            حفظ
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}