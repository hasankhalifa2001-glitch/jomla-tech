"use client";

import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AlertTriangle } from "lucide-react";
import { toast } from "sonner";

interface CatalogReportModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  catalogEntryId: string;
  currentName?: string;
  currentCategory?: string;
}

export function CatalogReportModal({ open, onOpenChange, catalogEntryId, currentName, currentCategory }: CatalogReportModalProps) {
  const [reason, setReason] = useState("");
  const [suggestedName, setSuggestedName] = useState("");
  const [suggestedCategory, setSuggestedCategory] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reason.trim()) {
      toast.error("يرجى كتابة سبب البلاغ أو الملاحظة.");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/catalog/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          catalogEntryId,
          reason: reason.trim(),
          suggestedName: suggestedName.trim() || null,
          suggestedCategory: suggestedCategory.trim() || null,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        toast.error(data.message || "حدث خطأ أثناء إرسال البلاغ.");
        return;
      }

      toast.success(data.message || "تم تقديم طلب التصحيح بنجاح.");
      setReason("");
      setSuggestedName("");
      setSuggestedCategory("");
      onOpenChange(false);
    } catch {
      toast.error("فشل الاتصال بالخادم.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md p-6 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl">
        <DialogHeader>
          <DialogTitle className="text-base font-bold flex items-center gap-2 text-amber-600 dark:text-amber-500">
            <AlertTriangle className="w-5 h-5" />
            <span>الإبلاغ عن بيانات خاطئة في الكتالوج المشترك</span>
          </DialogTitle>
          <DialogDescription className="text-xs text-zinc-500">
            إذا كانت البيانات الحالية للمنتج المشترك ({currentName || "سجل GS1"}) غير دقيقة، يمكنك إرسال اقتراح تصحيح لإدارة المنصة.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-3 my-2 text-xs">
          <div>
            <Label className="text-xs font-semibold">سبب البلاغ / أين الخطأ؟</Label>
            <Input
              placeholder="مثال: اسم المنتج يحتوي خطأ إملائي أو الوزن غير دقيق..."
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="h-8 text-xs mt-1"
            />
          </div>

          <div>
            <Label className="text-xs">الاسم المقترح (اختياري)</Label>
            <Input
              placeholder={currentName || "الاسم الصحيح للمنتج"}
              value={suggestedName}
              onChange={(e) => setSuggestedName(e.target.value)}
              className="h-8 text-xs mt-1"
            />
          </div>

          <div>
            <Label className="text-xs">التصنيف المقترح (اختياري)</Label>
            <Input
              placeholder={currentCategory || "التصنيف الصحيح"}
              value={suggestedCategory}
              onChange={(e) => setSuggestedCategory(e.target.value)}
              className="h-8 text-xs mt-1"
            />
          </div>

          <DialogFooter className="pt-2 gap-2 sm:gap-0">
            <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={loading}>
              إلغاء
            </Button>
            <Button type="submit" size="sm" disabled={loading} className="bg-amber-600 hover:bg-amber-700 text-white">
              {loading ? "جاري الإرسال..." : "إرسال البلاغ"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}