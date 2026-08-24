"use client";

import { useOfflineDbReady } from "@/lib/offline/hooks";

export default function PosPage() {
  const offlineReady = useOfflineDbReady();

  return (
    <section>
      <h1 className="text-2xl font-semibold text-zinc-900">نقطة البيع (POS)</h1>
      <p className="mt-2 text-sm text-zinc-600">
        واجهة الكاشير التي تعمل بدون إنترنت لإنشاء الفواتير والمزامنة.
      </p>
      <p className="mt-4 text-xs text-zinc-500">
        محرك العمل بدون إنترنت: {offlineReady ? "جاهز" : "جاري التهيئة..."}
      </p>
    </section>
  );
}
