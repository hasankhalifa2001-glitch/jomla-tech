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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { UserPlus, Loader2 } from "lucide-react";
import { toast } from "sonner";

interface CreateStaffModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

export function CreateStaffModal({ open, onOpenChange, onSuccess }: CreateStaffModalProps) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"CASHIER" | "ADMIN">("CASHIER");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !email.trim() || !password) {
      toast.error("يرجى تعبئة جميع الحقول المطلوبة.");
      return;
    }
    if (password.length < 6) {
      toast.error("يجب أن تكون كلمة المرور 6 أحرف على الأقل.");
      return;
    }

    setIsSubmitting(true);
    try {
      const res = await fetch("/api/staff", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), email: email.trim(), password, role }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        toast.success(`تمت إضافة الموظف "${name}" بنجاح.`);
        onOpenChange(false);
        setName("");
        setEmail("");
        setPassword("");
        setRole("CASHIER");
        onSuccess();
      } else {
        toast.error(data.message || "فشل إضافة الموظف.");
      }
    } catch {
      toast.error("حدث خطأ في الاتصال أثناء إضافة الموظف.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" dir="rtl">
        <DialogHeader className="text-right">
          <DialogTitle className="text-lg font-black flex items-center gap-2">
            <UserPlus className="h-5 w-5 text-emerald-600" />
            <span>إضافة موظف جديد</span>
          </DialogTitle>
          <DialogDescription className="text-xs text-zinc-500">
            إنشاء حساب موظف جديد مرتبط بهذا المتجر مباشرة.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4 pt-2">
          <div className="space-y-1.5">
            <Label className="text-xs font-bold">الاسم الكامل <span className="text-red-500">*</span></Label>
            <Input placeholder="مثال: أحمد المحمد" value={name} onChange={(e) => setName(e.target.value)} required className="h-9 text-xs" />
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs font-bold">البريد الإلكتروني <span className="text-red-500">*</span></Label>
            <Input type="email" placeholder="name@store.com" value={email} onChange={(e) => setEmail(e.target.value)} required className="h-9 text-xs font-mono text-left" dir="ltr" />
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs font-bold">كلمة المرور <span className="text-red-500">*</span></Label>
            <Input type="password" placeholder="•••••••• (6 أحرف على الأقل)" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={6} className="h-9 text-xs font-mono text-left" dir="ltr" />
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs font-bold">الدور الوظيفي</Label>
            <Select value={role} onValueChange={(val: "CASHIER" | "ADMIN") => setRole(val)}>
              <SelectTrigger className="h-9 text-xs font-medium"><SelectValue /></SelectTrigger>
              <SelectContent dir="rtl">
                <SelectItem value="CASHIER" className="text-xs"><span className="font-bold">كاشير (نقطة البيع فقط)</span></SelectItem>
                <SelectItem value="ADMIN" className="text-xs"><span className="font-bold">مدير متجر (كامل الصلاحيات)</span></SelectItem>
              </SelectContent>
            </Select>
          </div>

          <DialogFooter className="gap-2 sm:gap-0 pt-3">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} className="text-xs h-9">إلغاء</Button>
            <Button type="submit" disabled={isSubmitting} className="bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold h-9 gap-2">
              {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <span>إنشاء الحساب</span>}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
