"use client";

import { useSession, signOut } from "next-auth/react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { AlertOctagon, LogOut, ShieldAlert, Store } from "lucide-react";

export default function AccountLockedPage() {
  const { data: session } = useSession();
  const tenantName = session?.user?.tenantName || "المتجر";
  const subscriptionStatus = session?.user?.subscriptionStatus || "EXPIRED";

  return (
    <main className="flex min-h-screen flex-1 items-center justify-center bg-zinc-50 dark:bg-zinc-950 p-6 font-sans">
      <Card className="w-full max-w-md border-zinc-200 shadow-xl dark:border-zinc-800 dark:bg-zinc-900">
        <CardHeader className="text-center pb-2">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-red-100 text-red-600 shadow-md dark:bg-red-950/60 dark:text-red-400 mb-4">
            <AlertOctagon className="h-8 w-8" />
          </div>
          <CardTitle className="text-xl font-bold text-zinc-900 dark:text-zinc-100">
            {subscriptionStatus === "PENDING"
              ? "حساب المنشأة قيد التفعيل"
              : "اشتراك المنشأة منتهي"}
          </CardTitle>
          <CardDescription className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
            متجر: <span className="font-semibold text-zinc-800 dark:text-zinc-200">{tenantName}</span>
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4 pt-2">
          <div className="rounded-xl border border-amber-200 bg-amber-50/60 p-4 text-xs text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300">
            <div className="flex items-center gap-2 font-bold mb-1.5 text-amber-800 dark:text-amber-200">
              <ShieldAlert className="h-4 w-4 shrink-0 text-amber-600" />
              <span>تنبيه هائم للكاشير</span>
            </div>
            <p className="leading-relaxed">
              {subscriptionStatus === "PENDING"
                ? "تم تسجيل حساب متجركم بنجاح وهو قيد المراجعة والتفعيل حالياً من فريق الدعم الفني. لا يمكن إجراء عمليات البيع حتى اكتمال التفعيل."
                : "عذراً، تم إيقاف صلاحيات الوصول للوحة التحكم مؤقتاً بسبب انتهاء اشتراك المنشأة. يرجى التواصل مع مدير المتجر (Admin) لتجديد الاشتراك وإرفاق إيصال الدفع."}
            </p>
          </div>

          <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-3.5 text-xs text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-400 space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-zinc-500">اسم المستخدم:</span>
              <span className="font-semibold text-zinc-800 dark:text-zinc-200">{session?.user?.name || session?.user?.email}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-zinc-500">الدور:</span>
              <span className="font-bold text-blue-600 dark:text-blue-400">كاشير (CASHIER)</span>
            </div>
          </div>
        </CardContent>

        <CardFooter className="flex flex-col gap-2 border-t border-zinc-100 dark:border-zinc-800 pt-4 bg-zinc-50/50 dark:bg-zinc-900/30">
          <Button
            variant="destructive"
            onClick={() => signOut({ callbackUrl: "/login" })}
            className="w-full gap-2 font-bold text-xs h-10"
          >
            <LogOut className="h-4 w-4" />
            <span>تسجيل الخروج والعودة لصفحة الدخول</span>
          </Button>

          <p className="text-[11px] text-center text-zinc-400 mt-1">
            نظام جملة تك © 2026 - إدارة المنشآت متعددة المستأجرين
          </p>
        </CardFooter>
      </Card>
    </main>
  );
}
