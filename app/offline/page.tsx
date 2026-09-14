"use client";

import Link from "next/link";
import { WifiOff, ShoppingCart, LayoutDashboard, Package, BookOpen, FileText, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function OfflineFallbackPage() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-zinc-50 px-4 py-12 text-center dark:bg-zinc-950 sm:px-6 lg:px-8" dir="rtl">
      <div className="w-full max-w-md space-y-6 rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900 sm:p-8">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-amber-100 text-amber-600 dark:bg-amber-950 dark:text-amber-400">
          <WifiOff className="h-8 w-8" />
        </div>

        <div className="space-y-2">
          <h1 className="text-xl font-bold tracking-tight text-zinc-900 dark:text-zinc-50 sm:text-2xl">
            أنت غير متصل بالإنترنت
          </h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            الصفحة المطلوبة غير محفوظة محلياً ولم يتم تصفحها مسبقاً. ومع ذلك، لا تزال بيئة العمل الأساسية ونقطة البيع متاحة دون اتصال.
          </p>
        </div>

        <div className="space-y-3 pt-2">
          <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
            الصفحات المتاحة دون اتصال
          </p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Button variant="outline" asChild className="h-10 justify-start gap-2 text-xs font-semibold">
              <Link href="/pos">
                <ShoppingCart className="h-4 w-4 text-emerald-600" />
                <span>نقطة البيع (POS)</span>
              </Link>
            </Button>
            <Button variant="outline" asChild className="h-10 justify-start gap-2 text-xs font-semibold">
              <Link href="/dashboard">
                <LayoutDashboard className="h-4 w-4 text-emerald-600" />
                <span>لوحة التحكم</span>
              </Link>
            </Button>
            <Button variant="outline" asChild className="h-10 justify-start gap-2 text-xs font-semibold">
              <Link href="/inventory">
                <Package className="h-4 w-4 text-emerald-600" />
                <span>المخزون</span>
              </Link>
            </Button>
            <Button variant="outline" asChild className="h-10 justify-start gap-2 text-xs font-semibold">
              <Link href="/ledger">
                <BookOpen className="h-4 w-4 text-emerald-600" />
                <span>دفتر الديون</span>
              </Link>
            </Button>
            <Button variant="outline" asChild className="h-10 justify-start gap-2 text-xs font-semibold sm:col-span-2">
              <Link href="/orders">
                <FileText className="h-4 w-4 text-emerald-600" />
                <span>الطلبات والفواتير</span>
              </Link>
            </Button>
          </div>
        </div>

        <div className="border-t border-zinc-100 pt-4 dark:border-zinc-800">
          <Button
            onClick={() => window.location.reload()}
            className="w-full gap-2 bg-emerald-600 text-xs font-bold text-white hover:bg-emerald-700 dark:bg-emerald-600 dark:hover:bg-emerald-500"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            <span>إعادة محاولة الاتصال</span>
          </Button>
        </div>
      </div>
    </div>
  );
}