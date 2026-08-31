import { SessionProvider } from "@/components/providers/session-provider";
import { ExchangeRateInitializer } from "@/components/dashboard/exchange-rate-initializer";
import { SubscriptionBanner } from "@/components/dashboard/subscription-banner";
import { DashboardSidebar } from "@/components/dashboard/sidebar";
import { DashboardTopBar } from "@/components/dashboard/top-bar";
import { Toaster } from "@/components/ui/sonner";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <SessionProvider>
      <ExchangeRateInitializer />
      <div className="flex h-screen w-full overflow-hidden bg-zinc-100 dark:bg-zinc-900">
        {/* RTL Collapsible Navigation Sidebar */}
        <DashboardSidebar />

        {/* Main Content Area */}
        <div className="flex flex-1 flex-col overflow-hidden">
          {/* Expired / Pending Subscription Banner */}
          <SubscriptionBanner />

          {/* Top Bar Controls */}
          <DashboardTopBar />

          {/* Page Body View */}
          <main className="flex-1 overflow-y-auto p-6 pb-20 md:pb-6 bg-zinc-50 dark:bg-zinc-950">
            <div className="mx-auto max-w-7xl">{children}</div>
          </main>
        </div>
      </div>
      <Toaster position="top-center" richColors />
    </SessionProvider>
  );
}
