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
 */

import { useCallback, useEffect, useState } from "react";
import { Loader2, Save } from "lucide-react";
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
import { formatDbDate } from "@/lib/inventory/date-utils";
import type { EditTarget, ReceivingDefaults } from "./types";

interface ReceiptEditModalProps {
  target: EditTarget | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}

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

  return (
    <Dialog open={open} onOpenChange={(next) => !submitting && onOpenChange(next)}>
      <DialogContent dir="rtl" className="max-h-[calc(100dvh-2rem)] gap-4 overflow-y-auto p-4 sm:max-w-md sm:p-6 [&>*]:min-w-0">
        <DialogHeader className="pe-8 text-start">
          <DialogTitle className="text-base font-bold text-zinc-900">تعديل بيانات الاستلام</DialogTitle>
          <DialogDescription className="text-xs leading-relaxed text-zinc-500">
            تاريخ الشراء واسم المورّد فقط — كميات وتكاليف الاستلام غير قابلة للتعديل.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="receipt-purchase-date" className="text-xs font-bold text-zinc-700">
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
              className="h-11 text-start text-sm sm:h-10"
            />
            <p className="text-[11px] leading-relaxed text-zinc-400">
              {defaultsError ? (
                "تعذّر جلب الحدود المسموحة من الخادم — أعد فتح النافذة للمحاولة."
              ) : defaults ? (
                <>
                  النطاق المسموح: من{" "}
                  <span dir="ltr" className="inline-block tabular-nums [unicode-bidi:isolate]">
                    {defaults.minDate}
                  </span>{" "}
                  حتى{" "}
                  <span dir="ltr" className="inline-block tabular-nums [unicode-bidi:isolate]">
                    {defaults.businessDate}
                  </span>
                </>
              ) : (
                "جارٍ جلب النطاق المسموح من الخادم..."
              )}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="receipt-supplier" className="text-xs font-bold text-zinc-700">
              المورّد <span className="font-normal text-zinc-400">(اختياري)</span>
            </Label>
            <Input
              id="receipt-supplier"
              type="text"
              value={supplierName}
              maxLength={120}
              disabled={submitting}
              placeholder="مثال: شركة الفجر للتجارة"
              onChange={(e) => setSupplierName(e.target.value)}
              className="h-11 text-sm sm:h-10"
            />
          </div>
        </div>

        <DialogFooter className="gap-2 pt-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={submitting}
            onClick={() => onOpenChange(false)}
            className="h-10 w-full text-xs font-bold sm:h-9 sm:w-auto"
          >
            إلغاء
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={submitting || !defaults || !purchaseDate}
            onClick={handleSubmit}
            className="h-10 w-full gap-1.5 bg-emerald-600 text-xs font-bold hover:bg-emerald-700 sm:h-9 sm:w-auto"
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