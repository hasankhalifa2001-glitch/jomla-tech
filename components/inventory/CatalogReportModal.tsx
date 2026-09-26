"use client";

import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import m from "./modals.module.css";

interface CatalogReportModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  catalogEntryId: string;
  currentName?: string;
  currentCategory?: string;
}

// The stale-draft bug (a report typed for one catalog entry, then
// cancelled, could leak into a report submitted for a DIFFERENT entry) is
// solved at the call site instead of with a `useEffect` here — see
// AddProductModal's `key={catalogInfo.id}` on this component's usage.
// React's own guidance for exactly this situation ("resetting all state
// when a prop changes", linked from the you-might-not-need-an-effect
// docs) is to force a remount via `key`, not to synchronously call
// setState inside an effect body. A `key` change gives every field here
// (reason, suggestedName, suggestedCategory, loading) a fresh
// `useState("")` on the very first render for the new entry — no extra
// render pass, no warning.
export function CatalogReportModal({ open, onOpenChange, catalogEntryId, currentName, currentCategory }: CatalogReportModalProps) {
  const [reason, setReason] = useState("");
  const [suggestedName, setSuggestedName] = useState("");
  const [suggestedCategory, setSuggestedCategory] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    // Matches the backend's actual constraint (reportSchema: `reason:
    // z.string().min(3, ...)`) instead of only checking for a non-empty
    // string — a 1-2 character reason previously passed this check and
    // then failed at the server with an extra round trip.
    if (reason.trim().length < 3) {
      toast.error("يرجى كتابة سبب البلاغ (3 أحرف على الأقل).");
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
        <div className={m.m}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base font-bold text-amber-600 dark:text-amber-500">
              <AlertTriangle className={`w-5 h-5 ${m.titleIconAmber}`} aria-hidden />
              <span>الإبلاغ عن بيانات خاطئة في الكتالوج المشترك</span>
            </DialogTitle>
            <DialogDescription className="text-xs text-zinc-500">
              إذا كانت البيانات الحالية للمنتج المشترك ({currentName || "سجل GS1"}) غير دقيقة، يمكنك إرسال اقتراح تصحيح لإدارة المنصة.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleSubmit} className={m.form}>
            <div className={m.field}>
              <label className={m.label}>سبب البلاغ / أين الخطأ؟</label>
              <input
                type="text"
                placeholder="مثال: اسم المنتج يحتوي خطأ إملائي أو الوزن غير دقيق..."
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                className={m.input}
              />
            </div>

            <div className={m.field}>
              <label className={m.label}>الاسم المقترح (اختياري)</label>
              <input
                type="text"
                placeholder={currentName || "الاسم الصحيح للمنتج"}
                value={suggestedName}
                onChange={(e) => setSuggestedName(e.target.value)}
                className={m.input}
              />
            </div>

            <div className={m.field}>
              <label className={m.label}>التصنيف المقترح (اختياري)</label>
              <input
                type="text"
                placeholder={currentCategory || "التصنيف الصحيح"}
                value={suggestedCategory}
                onChange={(e) => setSuggestedCategory(e.target.value)}
                className={m.input}
              />
            </div>

            <DialogFooter>
              <div className={m.footerRow}>
                <button
                  type="button"
                  onClick={() => onOpenChange(false)}
                  disabled={loading}
                  className={`${m.btn} ${m.btnOutline}`}
                >
                  إلغاء
                </button>
                <button type="submit" disabled={loading} className={`${m.btn} ${m.btnSolidAmber}`}>
                  {loading ? "جاري الإرسال..." : "إرسال البلاغ"}
                </button>
              </div>
            </DialogFooter>
          </form>
        </div>
      </DialogContent>
    </Dialog>
  );
}