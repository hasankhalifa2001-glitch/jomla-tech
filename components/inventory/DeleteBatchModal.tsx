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
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Trash2, AlertTriangle, RefreshCw, AlertCircle } from "lucide-react";
import { toast } from "sonner";
import type { BatchItem } from "./ProductTable";

interface DeleteBatchModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  batch: BatchItem | null;
  productName: string;
  onSuccess: () => void;
}

export function DeleteBatchModal({
  open,
  onOpenChange,
  batch,
  productName,
  onSuccess,
}: DeleteBatchModalProps) {
  const [reason, setReason] = useState<string>("");
  const [submitting, setSubmitting] = useState<boolean>(false);

  useEffect(() => {
    if (open) {
      setReason("");
    }
  }, [open]);

  if (!batch) return null;

  const isReasonValid = reason.trim().length >= 3;
  const canSubmit = isReasonValid && !submitting;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;

    setSubmitting(true);
    try {
      const res = await fetch(`/api/inventory/batches/${batch.id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reason: reason.trim(),
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || "فشل حذف الدفعة.");
      }

      toast.success(data.message || "تم حذف الدفعة وتوثيق العملية في سجل التدقيق.");
      onOpenChange(false);
      onSuccess();
    } catch (err: any) {
      toast.error(err.message || "حدث خطأ أثناء حذف الدفعة.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" dir="rtl">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <div className="rounded-lg bg-red-100 p-2 dark:bg-red-950/40">
              <Trash2 className="h-5 w-5 text-red-600 dark:text-red-400" />
            </div>
            <div>
              <DialogTitle className="text-base font-bold text-red-600 dark:text-red-400">
                حذف دفعة تم إدخالها بالخطأ
              </DialogTitle>
              <DialogDescription className="text-xs text-zinc-500">
                {productName} — دفعة #{batch.batchNumber}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4 py-2">
          <div className="rounded-lg border border-red-200 bg-red-50/60 p-3 text-xs space-y-2 dark:border-red-900 dark:bg-red-950/20">
            <div className="flex items-start gap-2 text-red-800 dark:text-red-300 font-medium">
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5 text-red-600" />
              <span>
                تنبيه: سيتم حذف الدفعة نهائياً من قاعدة البيانات وتوثيق لقطة كاملة لبياناتها في سجل التدقيق (BatchDeletionLog).
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2 pt-1 text-[11px] border-t border-red-200/60 dark:border-red-900/60 text-zinc-600 dark:text-zinc-400">
              <div>
                رقم الدفعة: <span className="font-bold text-zinc-800 dark:text-zinc-200">{batch.batchNumber}</span>
              </div>
              <div>
                الكمية المحذوفة: <span className="font-bold text-zinc-800 dark:text-zinc-200">{batch.quantity} {batch.unitName}</span>
              </div>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="deleteReason" className="text-xs font-semibold">
              سبب حذف الدفعة <span className="text-red-500">*</span>
            </Label>
            <Textarea
              id="deleteReason"
              placeholder="مثال: تم إدخال رقم الدفعة بشكل خاطئ، تكرار بالخطأ عند الاستلام..."
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
              variant="destructive"
              className="gap-1.5"
            >
              {submitting && <RefreshCw className="h-3.5 w-3.5 animate-spin" />}
              تأكيد الحذف النهائي
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
