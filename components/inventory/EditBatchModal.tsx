/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";

import { useState } from "react";
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
import { Edit, RefreshCw, Info, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import type { BatchItem } from "./ProductTable";
// [v4.4, Spec Addendum Section 10] The ONE sanctioned module for parsing
// an existing batchNumber back into its date prefix + merchant suffix —
// see lib/inventory/batch-number.ts's header. This component must never
// re-implement that regex locally; it needs the ORIGINAL creation date,
// which only this shared parser (mirroring the PATCH route's own
// server-side use of it) can recover reliably.
import { parseBatchNumber } from "@/lib/inventory/batch-number";
import Decimal from "decimal.js";

interface EditBatchModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  batch: BatchItem | null;
  productName: string;
  onSuccess: () => void;
}

export function EditBatchModal({
  open,
  onOpenChange,
  batch,
  productName,
  onSuccess,
}: EditBatchModalProps) {
  // [v4.4, Section 10.3] Replaces the old free-text `batchNumber` state.
  // Only the merchant-supplied suffix is ever edited here — the date
  // prefix is a permanent, creation-time-only fact (see route.ts's PATCH
  // handler) and is never sent back to the server from this form.
  const [batchNumberSuffix, setBatchNumberSuffix] = useState<string>("");
  // [v4.4, Section 10.3] The batch's ORIGINAL creation-date prefix,
  // recovered once when the modal opens, via parseBatchNumber() — shown
  // read-only, never editable, never re-derived from today's date.
  const [originalDatePrefix, setOriginalDatePrefix] = useState<string | null>(null);
  // True only if this batch's stored batchNumber doesn't match the
  // expected "{date}-{suffix}" format (e.g. legacy data from before this
  // format existed). The suffix field is disabled in that case, mirroring
  // the server's own BATCH_NUMBER_FORMAT_UNRECOGNIZED (409) guard —
  // there is nothing safe to edit here without corrupting the record.
  const [unrecognizedFormat, setUnrecognizedFormat] = useState<boolean>(false);
  const [expiryDate, setExpiryDate] = useState<string>("");
  // [v4.4, T4g] Cost-price correction state. `costPricePerBaseUnit` holds what
  // the ADMIN is typing; `originalCostPrice` holds the batch's stored value,
  // captured once when the modal opens, so "did this actually change?" is
  // answered against the real prior value — which is also exactly the
  // oldCostPrice the server records in CostPriceChangeLog.
  const [costPricePerBaseUnit, setCostPricePerBaseUnit] = useState<string>("");
  const [originalCostPrice, setOriginalCostPrice] = useState<string>("");
  // Required whenever the cost actually changes: every correction is
  // append-only and logged, and the log row's reason is never optional.
  const [costPriceChangeReason, setCostPriceChangeReason] = useState<string>("");
  const [submitting, setSubmitting] = useState<boolean>(false);

  // [FIX] Track previous props by batch.id, not by the batch object
  // reference. Comparing `batch !== prevBatch` re-triggers this reset on
  // ANY new object reference for the same batch — including one the
  // parent creates on a routine re-render (e.g. a poll, or unrelated
  // state changing) while this modal is open. That would silently wipe
  // out whatever the user is actively typing into batchNumberSuffix/
  // expiryDate mid-edit — a real data-loss bug, not just a wasted render.
  // Keying on batch?.id instead means this only resets when the modal is
  // opened for a genuinely different batch (or freshly reopened),
  // matching the same fix already applied to ReconcileBatchModal.tsx for
  // the same reason.
  const [prevOpen, setPrevOpen] = useState(open);
  const [prevBatchId, setPrevBatchId] = useState<string | null>(batch?.id ?? null);
  const currentBatchId = batch?.id ?? null;

  if (open !== prevOpen || currentBatchId !== prevBatchId) {
    setPrevOpen(open);
    setPrevBatchId(currentBatchId);
    if (open && batch) {
      // [v4.4, Section 10.3] Recover the ORIGINAL date prefix + suffix
      // from the batch's current, already-stored batchNumber — never
      // today's date. A batch created under the v4.4 format rules always
      // parses successfully; a legacy/unrecognized value (which should
      // not exist pre-launch, but is handled defensively rather than
      // assumed away) disables editing the suffix entirely.
      const parsed = parseBatchNumber(batch.batchNumber);
      if (parsed) {
        setOriginalDatePrefix(parsed.datePrefix);
        setBatchNumberSuffix(parsed.suffix);
        setUnrecognizedFormat(false);
      } else {
        setOriginalDatePrefix(null);
        setBatchNumberSuffix("");
        setUnrecognizedFormat(true);
      }

      if (batch.expiryDate) {
        const d = new Date(batch.expiryDate);
        setExpiryDate(d.toISOString().split("T")[0]);
      } else {
        setExpiryDate("");
      }

      // [v4.4, T4g] Prefill from the batch's stored cost. A CASHIER never
      // reaches this modal at all (ADMIN-only), and the API strips this field
      // from a CASHIER's payload regardless — so an empty value here means
      // "missing from the row", never "no cost exists".
      setCostPricePerBaseUnit(batch.costPricePerBaseUnit?.toString() ?? "");
      setOriginalCostPrice(batch.costPricePerBaseUnit?.toString() ?? "");
      setCostPriceChangeReason("");
    }
  }

  if (!batch) return null;

  // Has the ADMIN actually typed a different cost? Compared as trimmed
  // strings: this only decides whether the correction path (and therefore the
  // required reason) applies at all — the authoritative value comparison and
  // the oldCostPrice recorded in the audit log both happen server-side,
  // against the stored row.
  const costHasChanged =
    costPricePerBaseUnit.trim().length > 0 &&
    costPricePerBaseUnit.trim() !== originalCostPrice.trim();

  const isCostFormatValid =
    !costHasChanged || /^\d{1,14}(\.\d{1,8})?$/.test(costPricePerBaseUnit.trim());

  const isCostPositive =
    !costHasChanged ||
    (() => {
      try { return new Decimal(costPricePerBaseUnit.trim()).gt(0); } catch { return false; }
    })();

  const isFormValid =
    !unrecognizedFormat &&
    batchNumberSuffix.trim().length > 0 &&
    isCostFormatValid &&
    isCostPositive &&
    (!costHasChanged || costPriceChangeReason.trim().length >= 3) &&
    !submitting;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isFormValid) return;

    setSubmitting(true);
    try {
      const res = await fetch(`/api/inventory/batches/${batch.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // [v4.4, Section 10.3] Only the suffix is ever sent — the
          // server rebuilds the full batchNumber from the batch's
          // EXISTING date prefix + this suffix. Sending a `batchNumber`
          // field directly is explicitly rejected server-side (see the
          // route's raw-body guard), so this component must never send
          // one.
          batchNumberSuffix: batchNumberSuffix.trim(),
          expiryDate: expiryDate ? expiryDate : null,
          // [v4.4, T4g] Sent ONLY when the value actually changed — an
          // unchanged field must never write a spurious CostPriceChangeLog
          // row, and the server rejects a cost figure without a reason.
          ...(costHasChanged
            ? {
              costPricePerBaseUnit: costPricePerBaseUnit.trim(),
              costPriceChangeReason: costPriceChangeReason.trim(),
            }
            : {}),
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || "فشل تعديل بيانات الدفعة.");
      }

      toast.success(data.message || "تم تحديث بيانات الدفعة بنجاح.");
      onOpenChange(false);
      onSuccess();
    } catch (err: any) {
      toast.error(err.message || "حدث خطأ أثناء تعديل الدفعة.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" dir="rtl">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <div className="rounded-lg bg-blue-100 p-2 dark:bg-blue-950/40">
              <Edit className="h-5 w-5 text-blue-600 dark:text-blue-400" />
            </div>
            <div>
              <DialogTitle className="text-base font-bold text-zinc-900 dark:text-zinc-100">
                تعديل بيانات الدفعة
              </DialogTitle>
              <DialogDescription className="text-xs text-zinc-500">
                {productName} — دفعة #{batch.batchNumber}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4 py-2">
          {unrecognizedFormat ? (
            <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50/60 p-3 text-xs text-red-800 dark:border-red-900 dark:bg-red-950/20 dark:text-red-300">
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5 text-red-600" />
              <span>
                تعذّر التعرف على تنسيق رقم هذه الدفعة الحالي، لذا لا يمكن
                تعديل رقمها من هنا. يمكنك تعديل تاريخ الانتهاء فقط أدناه.
              </span>
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label htmlFor="batchNumberSuffix" className="text-xs font-semibold">
                رقم الدفعة <span className="text-red-500">*</span>
              </Label>
              <div className="flex items-center gap-2">
                {/* [v4.4, Section 10.3] Read-only display of the batch's
                    ORIGINAL creation-date prefix — never editable, never
                    re-derived from today's date. Only the suffix next to
                    it can be changed. */}
                <span
                  className="h-9 shrink-0 rounded-md border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-800 px-3 text-xs font-mono text-zinc-500 flex items-center"
                  dir="ltr"
                  title="تاريخ إنشاء الدفعة الأصلي — ثابت ولا يمكن تعديله."
                >
                  {originalDatePrefix}-
                </span>
                <Input
                  id="batchNumberSuffix"
                  value={batchNumberSuffix}
                  onChange={(e) => setBatchNumberSuffix(e.target.value)}
                  placeholder="مثال: 1 أو INV4471"
                  className="text-xs font-mono flex-1"
                  required
                />
              </div>
              <p className="text-[11px] text-zinc-400">
                تاريخ الدفعة الأصلي ثابت ولا يتغيّر — يمكنك تعديل الجزء
                الذي أدخلته فقط.
              </p>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="expiryDate" className="text-xs font-semibold">
              تاريخ انتهاء الصلاحية
            </Label>
            <Input
              id="expiryDate"
              type="date"
              value={expiryDate}
              onChange={(e) => setExpiryDate(e.target.value)}
              className="text-xs"
            />
            <p className="text-[11px] text-zinc-400">
              اتركه فارغاً إذا لم يكن للمنتج تاريخ صلاحية محدد.
            </p>
          </div>

          {/* [v4.4, T4g — Role Capability Matrix's "edit an existing batch's
              cost price (correction)" row, ADMIN-only]
              The batch's cost price, always SYP and always per the product's
              BASE unit. Changing it here never touches an already-sold
              invoice line: each sale froze its own costAmountSYP at commit
              time. Only a NEW sale uses the corrected figure. */}
          <div className="space-y-1.5">
            <Label htmlFor="batch-cost" className="text-xs">
              سعر التكلفة للوحدة الأساسية (ل.س)
            </Label>
            <Input
              id="batch-cost"
              type="text"
              inputMode="decimal"
              dir="ltr"
              value={costPricePerBaseUnit}
              onChange={(e) => setCostPricePerBaseUnit(e.target.value)}
              className="text-xs"
              required
            />
            <p className="text-[11px] text-zinc-400">
              يُطبَّق على المبيعات الجديدة فقط — الفواتير المسجّلة سابقاً تحتفظ
              بتكلفتها المجمّدة كما هي.
            </p>
          </div>

          {costHasChanged && (
            <div className="space-y-1.5">
              <Label htmlFor="batch-cost-reason" className="text-xs">
                سبب تصحيح سعر التكلفة (مطلوب)
              </Label>
              <Textarea
                id="batch-cost-reason"
                value={costPriceChangeReason}
                onChange={(e) => setCostPriceChangeReason(e.target.value)}
                placeholder="مثال: خطأ في إدخال سعر الشراء من فاتورة المورد"
                className="text-xs"
                rows={2}
                required
              />
              <p className="text-[11px] text-amber-700 dark:text-amber-400">
                سيُسجَّل التصحيح في سجل تدقيق دائم مع القيمة القديمة والجديدة واسمك.
              </p>
            </div>
          )}

          <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50/60 p-3 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/20 dark:text-amber-300">
            <Info className="h-4 w-4 shrink-0 mt-0.5 text-amber-600" />
            <span>
              ملاحظة: الكمية ({batch.quantity} {batch.unitName}) غير قابلة
              للتعديل المباشر هنا لضمان تتبع FIFO. لتصحيح الكميات استخدم زر
              &quot;تسوية المخزون&quot;.
            </span>
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
              disabled={!isFormValid}
              className="bg-blue-600 hover:bg-blue-700 text-white gap-1.5"
            >
              {submitting && (
                <RefreshCw className="h-3.5 w-3.5 animate-spin" />
              )}
              حفظ التعديلات
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}