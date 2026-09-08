"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { KeyRound, UserCheck, UserX, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { StaffUser } from "@/app/(dashboard)/settings/staff/page";

interface StaffTableProps {
  staff: StaffUser[];
  currentUserId?: string;
  togglingId: string | null;
  onResetPassword: (user: StaffUser) => void;
  onToggleStatus: (user: StaffUser) => void;
}

export function StaffTable({
  staff,
  currentUserId,
  togglingId,
  onResetPassword,
  onToggleStatus,
}: StaffTableProps) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-right text-xs">
        <thead className="bg-zinc-50/75 dark:bg-zinc-900/50 text-zinc-500 dark:text-zinc-400 border-b border-zinc-200 dark:border-zinc-800 font-bold">
          <tr>
            <th className="py-3 px-4">الموظف</th>
            <th className="py-3 px-4">الدور</th>
            <th className="py-3 px-4">الحالة</th>
            <th className="py-3 px-4 hidden md:table-cell">تاريخ الإضافة</th>
            <th className="py-3 px-4 text-center">الإجراءات</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-200/60 dark:divide-zinc-800/60 font-medium">
          {staff.map((user) => {
            const isCurrent = user.id === currentUserId;
            const isToggling = togglingId === user.id;

            return (
              <tr key={user.id} className={cn("hover:bg-zinc-50/50 dark:hover:bg-zinc-900/40", !user.isActive && "opacity-75 bg-zinc-50/30")}>
                <td className="py-3 px-4">
                  <div className="flex items-center gap-2.5">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 font-bold text-xs">
                      {user.name.charAt(0) || "U"}
                    </div>
                    <div className="flex flex-col min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="font-bold text-zinc-900 dark:text-zinc-100 truncate">{user.name}</span>
                        {isCurrent && <Badge className="bg-emerald-100 text-emerald-800 text-[10px] px-1 py-0 font-bold">أنت</Badge>}
                      </div>
                      <span className="text-zinc-500 font-mono text-[11px] truncate">{user.email}</span>
                    </div>
                  </div>
                </td>

                <td className="py-3 px-4">
                  <Badge variant="secondary" className={cn("text-xs px-2 py-0.5 font-bold", user.role === "ADMIN" ? "bg-purple-100 text-purple-700" : "bg-blue-100 text-blue-700")}>
                    {user.role === "ADMIN" ? "مدير متجر" : "كاشير"}
                  </Badge>
                </td>

                <td className="py-3 px-4">
                  {user.isActive ? (
                    <Badge className="bg-emerald-50 text-emerald-700 border-emerald-200 text-xs px-2 py-0.5 font-bold gap-1">
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> نشط
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="bg-zinc-100 text-zinc-500 text-xs px-2 py-0.5 font-bold">معطل</Badge>
                  )}
                </td>

                <td className="py-3 px-4 hidden md:table-cell text-zinc-500 text-[11px]">
                  {new Date(user.createdAt).toLocaleDateString("ar-SY", { year: "numeric", month: "short", day: "numeric" })}
                </td>

                <td className="py-3 px-4">
                  <div className="flex items-center justify-center gap-2">
                    <Button variant="outline" size="sm" onClick={() => onResetPassword(user)} className="h-8 gap-1.5 text-xs font-semibold">
                      <KeyRound className="h-3.5 w-3.5 text-amber-500" />
                      <span className="hidden sm:inline">كلمة المرور</span>
                    </Button>

                    <Button
                      variant={user.isActive ? "destructive" : "default"}
                      size="sm"
                      disabled={isToggling || (isCurrent && user.isActive)}
                      onClick={() => onToggleStatus(user)}
                      className={cn("h-8 gap-1.5 text-xs font-semibold", !user.isActive && "bg-emerald-600 hover:bg-emerald-700 text-white")}
                    >
                      {isToggling ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : user.isActive ? (
                        <><UserX className="h-3.5 w-3.5" /><span className="hidden sm:inline">تعطيل</span></>
                      ) : (
                        <><UserCheck className="h-3.5 w-3.5" /><span className="hidden sm:inline">تفعيل</span></>
                      )}
                    </Button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
