import { SessionProvider } from "@/components/providers/session-provider";
import { ExchangeRateInitializer } from "@/components/dashboard/exchange-rate-initializer";
import { SyncWorkerInitializer } from "@/components/dashboard/sync-worker-initializer";
import { SubscriptionBanner } from "@/components/dashboard/subscription-banner";
import { DashboardSidebar } from "@/components/dashboard/sidebar";
import { DashboardTopBar } from "@/components/dashboard/top-bar";
import { Toaster } from "@/components/ui/sonner";
import { OfflineCacheInitializer } from "@/components/dashboard/product-cache-initializer";
import s from "@/components/dashboard/shell.module.css";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // [FIX] Fetched server-side and passed into SessionProvider instead of
  // letting every client child (ExchangeRateInitializer,
  // SyncWorkerInitializer, SubscriptionBanner — all via useSession())
  // start from an `undefined` session and fetch it themselves after
  // mount. Without this, the sync worker's "within 5 seconds of
  // reconnection" requirement (T4c) and the lockout banner's correctness
  // (T2) both had to wait on an extra client-side session round trip
  // before they had any real data to act on.

  return (
    <SessionProvider >
      <ExchangeRateInitializer />
      <SyncWorkerInitializer />
      <OfflineCacheInitializer />
      <div className={s.app}>
        {/* RTL collapsible sidebar (bottom bar + drawer on mobile) */}
        <DashboardSidebar />

        {/* Main content area */}
        <div className={s.content}>
          {/* Expired / Pending subscription banner */}
          <SubscriptionBanner />

          {/* Top bar controls */}
          <DashboardTopBar />

          {/* Page body */}
          <main className={s.main}>
            <div className={s.page}>{children}</div>
          </main>
        </div>
      </div>
      <Toaster position="top-center" richColors />
    </SessionProvider>
  );
}