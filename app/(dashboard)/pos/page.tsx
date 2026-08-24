"use client";

import { useOfflineDbReady } from "@/lib/offline/hooks";

export default function PosPage() {
  const offlineReady = useOfflineDbReady();

  return (
    <section>
      <h1 className="text-2xl font-semibold text-zinc-900">Point of Sale</h1>
      <p className="mt-2 text-sm text-zinc-600">
        Offline-first cashier interface for invoice creation and sync.
      </p>
      <p className="mt-4 text-xs text-zinc-500">
        Offline engine: {offlineReady ? "ready" : "initializing..."}
      </p>
    </section>
  );
}
