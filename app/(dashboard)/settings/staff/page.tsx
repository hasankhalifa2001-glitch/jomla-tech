"use client";

import { useState, useEffect, useCallback } from "react";
import { useSessionWithOfflineFallback } from "@/lib/offline/hooks";
import { Button } from "@/components/ui/button";
import { CreateStaffModal } from "@/components/settings/create-staff-modal";
import { ResetPasswordModal } from "@/components/settings/reset-password-modal";
import { StaffTable } from "@/components/settings/staff-table";
import { Users, UserPlus, ShieldCheck, RefreshCw, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

export interface StaffUser {
  id: string;
  name: string;
  email: string;
  role: "ADMIN" | "CASHIER";
  isActive: boolean;
  createdAt: string;
}

export default function StaffSettingsPage() {
  const { data: session } = useSessionWithOfflineFallback();
  const currentUserId = session?.userId;

  const [staff, setStaff] = useState<StaffUser[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isResetOpen, setIsResetOpen] = useState(false);
  const [targetStaff, setTargetStaff] = useState<StaffUser | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const fetchStaff = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await fetch("/api/staff");
      const data = await res.json();
      if (res.ok && data.success) {
        setStaff(data.users || []);
      } else {
        toast.error(data.message || "فشل جلب قائمة الموظفين.");
      }
    } catch {
      toast.error("حدث خطأ في الاتصال أثناء جلب قائمة الموظفين.");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    let isMounted = true;
    async function loadStaff() {
      try {
        const res = await fetch("/api/staff");
        const data = await res.json();
        if (isMounted) {
          if (res.ok && data.success) {
            setStaff(data.users || []);
          } else {
            toast.error(data.message || "فشل جلب قائمة الموظفين.");
          }
        }
      } catch {
        if (isMounted) {
          toast.error("حدث خطأ في الاتصال أثناء جلب قائمة الموظفين.");
        }
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    }

    loadStaff();
    return () => {
      isMounted = false;
    };
  }, []);

  const handleToggleStatus = async (user: StaffUser) => {
    if (user.id === currentUserId && user.isActive) {
      toast.error("لا يمكنك إلغاء تفعيل حسابك الحالي.");
      return;
    }

    setTogglingId(user.id);
    try {
      const res = await fetch(`/api/staff/${user.id}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !user.isActive }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        toast.success(data.message);
        setStaff((prev) =>
          prev.map((item) => (item.id === user.id ? { ...item, isActive: !user.isActive } : item))
        );
      } else {
        toast.error(data.message || "فشل تعديل حالة الموظف.");
      }
    } catch {
      toast.error("حدث خطأ في الاتصال أثناء تعديل الحالة.");
    } finally {
      setTogglingId(null);
    }
  };

  return (
    <div className="flex-1 space-y-6 p-4 sm:p-6 md:p-8 max-w-7xl mx-auto" dir="rtl">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-zinc-200 pb-5 dark:border-zinc-800">
        <div>
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-purple-100 text-purple-700 dark:bg-purple-950 dark:text-purple-300">
              <Users className="h-5 w-5" />
            </div>
            <h1 className="text-xl sm:text-2xl font-black text-zinc-900 dark:text-zinc-50">
              طاقم العمل وإدارة الموظفين
            </h1>
          </div>
          <p className="mt-1.5 text-xs sm:text-sm text-zinc-500 dark:text-zinc-400">
            إدارة حسابات الكاشير والمدراء، والتحكم بحالات التفعيل وإعادة تعيين كلمات المرور.
          </p>
        </div>

        <Button onClick={() => setIsCreateOpen(true)} className="gap-2 bg-emerald-600 hover:bg-emerald-700 text-white font-bold h-10 px-4 shrink-0 shadow-sm">
          <UserPlus className="h-4 w-4" />
          <span>إضافة موظف جديد</span>
        </Button>
      </div>

      <div className="rounded-2xl border border-zinc-200/80 bg-white shadow-sm overflow-hidden dark:border-zinc-800 dark:bg-zinc-950">
        <div className="p-4 sm:p-5 border-b border-zinc-200/80 dark:border-zinc-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-emerald-600" />
            <h2 className="text-sm font-bold text-zinc-900 dark:text-zinc-100">قائمة الحسابات ({staff.length})</h2>
          </div>
          <Button variant="ghost" size="sm" onClick={fetchStaff} disabled={isLoading} className="h-8 gap-1.5 text-xs text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100">
            <RefreshCw className={cn("h-3.5 w-3.5", isLoading && "animate-spin")} />
            <span>تحديث</span>
          </Button>
        </div>

        {isLoading ? (
          <div className="flex flex-col items-center justify-center py-16 text-zinc-400">
            <Loader2 className="h-8 w-8 animate-spin text-emerald-600 mb-2" />
            <p className="text-xs font-medium">جاري تحميل بيانات طاقم العمل...</p>
          </div>
        ) : staff.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center text-zinc-500 p-4">
            <Users className="h-12 w-12 text-zinc-300 dark:text-zinc-700 mb-3" />
            <p className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">لا يوجد موظفون مسجلون حالياً</p>
          </div>
        ) : (
          <StaffTable
            staff={staff}
            currentUserId={currentUserId}
            togglingId={togglingId}
            onResetPassword={(user) => {
              setTargetStaff(user);
              setIsResetOpen(true);
            }}
            onToggleStatus={handleToggleStatus}
          />
        )}
      </div>

      <CreateStaffModal open={isCreateOpen} onOpenChange={setIsCreateOpen} onSuccess={fetchStaff} />
      <ResetPasswordModal open={isResetOpen} onOpenChange={setIsResetOpen} staff={targetStaff} />
    </div>
  );
}

