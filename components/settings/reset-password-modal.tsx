"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { KeyRound, Sparkles, Copy, Check, Loader2, AlertCircle } from "lucide-react";
import { toast } from "sonner";
import type { StaffUser } from "@/app/(dashboard)/settings/staff/page";

interface ResetPasswordModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  staff: StaffUser | null;
}

export function ResetPasswordModal({ open, onOpenChange, staff }: ResetPasswordModalProps) {
  const [password, setPassword] = useState("");
  const [isCopied, setIsCopied] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const generateRandomPassword = () => {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%";
    let generated = "Jomla-";
    for (let i = 0; i < 8; i++) {
      generated += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    setPassword(generated);
    setIsCopied(false);
  };

  const copyToClipboard = () => {
    if (!password) return;
    navigator.clipboard.writeText(password);
    setIsCopied(true);
    toast.success("تم نسخ كلمة المرور إلى الحافظة.");
    setTimeout(() => setIsCopied(false), 2000);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!staff) return;
    if (!password || password.length < 6) {
      toast.error("يجب أن تكون كلمة المرور 6 أحرف على الأقل.");
      return;
    }

    setIsSubmitting(true);
    try {
      const res = await fetch(`/api/staff/${staff.id}/reset-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        toast.success(`تمت إعادة تعيين كلمة مرور "${staff.name}" بنجاح.`);
        onOpenChange(false);
        setPassword("");
      } else {
        toast.error(data.message || "فشل إعادة تعيين كلمة المرور.");
      }
    } catch {
      toast.error("حدث خطأ في الاتصال أثناء إعادة تعيين كلمة المرور.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" dir="rtl">
        <DialogHeader className="text-right">
          <DialogTitle className="text-lg font-black flex items-center gap-2">
            <KeyRound className="h-5 w-5 text-amber-500" />
            <span>إعادة تعيين كلمة المرور</span>
          </DialogTitle>
          <DialogDescription className="text-xs text-zinc-500">
            تعيين كلمة مرور جديدة للموظف: <strong className="text-zinc-800 dark:text-zinc-200">{staff?.name}</strong> ({staff?.email})
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4 pt-2">
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-xs font-bold">كلمة المرور الجديدة</Label>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={generateRandomPassword}
                className="h-7 px-2 text-[11px] text-purple-600 dark:text-purple-400 gap-1 hover:bg-purple-50 dark:hover:bg-purple-950/50"
              >
                <Sparkles className="h-3.5 w-3.5" />
                <span>توليد عشوائي</span>
              </Button>
            </div>

            <div className="relative">
              <Input
                type="text"
                placeholder="أدخل كلمة المرور أو قم بتوليدها..."
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  setIsCopied(false);
                }}
                required
                minLength={6}
                className="h-9 text-xs font-mono pl-10 text-left"
                dir="ltr"
              />
              {password && (
                <button
                  type="button"
                  onClick={copyToClipboard}
                  className="absolute left-2 top-2 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200"
                  title="نسخ كلمة المرور"
                >
                  {isCopied ? <Check className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />}
                </button>
              )}
            </div>
          </div>

          <div className="rounded-xl border border-amber-200 bg-amber-50/60 p-3 text-xs text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-300 flex items-start gap-2">
            <AlertCircle className="h-4 w-4 shrink-0 text-amber-600 mt-0.5" />
            <span>يرجى تزويد الموظف بكلمة المرور الجديدة فور تعيينها.</span>
          </div>

          <DialogFooter className="gap-2 sm:gap-0 pt-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} className="text-xs h-9">إلغاء</Button>
            <Button type="submit" disabled={isSubmitting || !password || password.length < 6} className="bg-amber-600 hover:bg-amber-700 text-white text-xs font-bold h-9 gap-2">
              {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <span>حفظ كلمة المرور</span>}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
