"use client";

import { useOfflineDbReady } from "@/lib/offline/hooks";
import { useExchangeRateStore } from "@/lib/store/useExchangeRateStore";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DollarSign, Calculator, RefreshCw, Layers } from "lucide-react";

export default function PosPage() {
  const offlineReady = useOfflineDbReady();
  const dailyExchangeRate = useExchangeRateStore((state) => state.dailyExchangeRate);

  const sampleUSD = 25.5;
  const convertedSYP = dailyExchangeRate ? sampleUSD * dailyExchangeRate : 0;

  return (
    <div className="space-y-6">
      {/* Header & Status */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-zinc-200 pb-4 dark:border-zinc-800">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 dark:text-zinc-100">نقطة البيع (POS)</h1>
          <p className="text-xs text-zinc-500">
            واجهة الكاشير التفاعلية لإنشاء الفواتير وحساب الأسعار بالدولار والليرة السورية.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <Badge variant="outline" className="gap-1.5 px-3 py-1 text-xs">
            <Layers className="h-3.5 w-3.5 text-emerald-600" />
            <span>محرك Offline: {offlineReady ? "جاهز ✓" : "جاري التهيئة..."}</span>
          </Badge>
        </div>
      </div>

      {/* Live Exchange Rate Sync Demonstration Card */}
      <Card className="border-emerald-200 bg-emerald-50/40 dark:border-emerald-950 dark:bg-emerald-950/20 shadow-sm">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-600 text-white">
                <DollarSign className="h-4 w-4" />
              </div>
              <CardTitle className="text-base font-bold text-emerald-900 dark:text-emerald-300">
                ربط سعر الصرف المباشر (Zustand Live Sync)
              </CardTitle>
            </div>
            <Badge className="bg-emerald-600 text-white text-xs">مزامنة فورية</Badge>
          </div>
          <CardDescription className="text-xs text-emerald-700 dark:text-emerald-400">
            يتأثر هذا الحساب تلقائياً وبشكل فوري عند تعديل سعر الصرف من الشريط العلوي (Top Bar).
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-2">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-center">
            <div className="rounded-xl bg-white p-3 shadow-xs border border-emerald-100 dark:bg-zinc-900 dark:border-zinc-800">
              <span className="text-[11px] font-semibold text-zinc-500">سعر الصرف المعتمد حالياً</span>
              <p className="text-lg font-extrabold text-emerald-600 dark:text-emerald-400 mt-1">
                {dailyExchangeRate ? `${dailyExchangeRate.toLocaleString("ar-SY")} ل.س / $` : "غير محدد"}
              </p>
            </div>

            <div className="rounded-xl bg-white p-3 shadow-xs border border-emerald-100 dark:bg-zinc-900 dark:border-zinc-800">
              <span className="text-[11px] font-semibold text-zinc-500">سعر الصنف الافتراضي بالدولار</span>
              <p className="text-lg font-extrabold text-zinc-800 dark:text-zinc-200 mt-1">
                ${sampleUSD.toFixed(2)}
              </p>
            </div>

            <div className="rounded-xl bg-white p-3 shadow-xs border border-emerald-100 dark:bg-zinc-900 dark:border-zinc-800">
              <span className="text-[11px] font-semibold text-zinc-500">المعادل المحسوب بالليرة السورية</span>
              <p className="text-lg font-extrabold text-purple-600 dark:text-purple-400 mt-1">
                {dailyExchangeRate ? `${convertedSYP.toLocaleString("ar-SY")} ل.س` : "---"}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
