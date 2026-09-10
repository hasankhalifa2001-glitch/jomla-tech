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
import { Edit, RefreshCw, Info } from "lucide-react";
import { toast } from "sonner";
import type { BatchItem } from "./ProductTable";

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
  const [batchNumber, setBatchNumber] = useState<string>("");
  const [expiryDate, setExpiryDate] = useState<string>("");
  const [submitting, setSubmitting] = useState<boolean>(false);

  useEffect(() => {
    if (open && batch) {
      setBatchNumber(batch.batchNumber || "");
      if (batch.expiryDate) {
        const d = new Date(batch.expiryDate);
        setExpiryDate(d.toISOString().split("T")[0]);
      } else {
        setExpiryDate("");
      }
    }
  }, [open, batch]);

  if (!batch) return null;

  const isFormValid = batchNumber.trim().length > 0 && !submitting;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isFormValid) return;

    setSubmitting(true);
    try {
      const res = await fetch(`/api/inventory/batches/${batch.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          batchNumber: batchNumber.trim(),
          expiryDate: expiryDate ? expiryDate : null,
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
          <div className="space-y-1.5">
            <Label htmlFor="batchNumber" className="text-xs font-semibold">
              رقم الدفعة <span className="text-red-500">*</span>
            </Label>
            <Input
              id="batchNumber"
              value={batchNumber}
              onChange={(e) => setBatchNumber(e.target.value)}
              placeholder="مثال: BATCH-2026-001"
              className="text-xs font-mono"
              required
            />
          </div>

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
            <p className="text-[11px] text-zinc-400">اتركه فارغاً إذا لم يكن للمنتج تاريخ صلاحية محدد.</p>
          </div>

          <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50/60 p-3 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/20 dark:text-amber-300">
            <Info className="h-4 w-4 shrink-0 mt-0.5 text-amber-600" />
            <span>
              ملاحظة: الكمية ({batch.quantity} {batch.unitName}) غير قابلة للتعديل المباشر هنا لضمان تتبع FIFO. لتصحيح الكميات استخدم زر &quot;تسوية المخزون&quot;.
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
              {submitting && <RefreshCw className="h-3.5 w-3.5 animate-spin" />}
              حفظ التعديلات
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
