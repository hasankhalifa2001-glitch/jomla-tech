"use client";

import { usePathname } from "next/navigation";
import { ExchangeRateTopbar } from "@/components/dashboard/exchange-rate-topbar";
import { ConnectionStatus } from "@/components/dashboard/connection-status";
import { SublinkLauncher } from "@/components/dashboard/sublink-launcher";

const pathMap: Record<string, string> = {
    "/dashboard": "لوحة التحكم والتحليلات",
    "/pos": "نقطة البيع (POS)",
    "/inventory": "إدارة المخزون والمنتجات",
    "/ledger": "دفتر الديون والتحصيل",
    "/orders": "سجل الطلبات والفواتير",
    "/settings/billing": "إعدادات المتجر والفوترة",
};

export function DashboardTopBar() {
    const pathname = usePathname();
    const title = pathMap[pathname] || "واجهة الإدارة";

    return (
        <header className="sticky top-0 z-30 flex min-h-16 flex-wrap items-center justify-between gap-4 border-b border-zinc-200 bg-white/95 px-6 py-2.5 backdrop-blur-md dark:border-zinc-800 dark:bg-zinc-950/95">
            {/* Current Page Title / Breadcrumb */}
            <div className="flex items-center gap-3">
                <h1 className="text-base font-bold text-zinc-900 dark:text-zinc-100">{title}</h1>
            </div>

            {/* Top Bar Right Controls (Arabic RTL: Right side controls are placed logically) */}
            <div className="flex flex-wrap items-center gap-3">
                {/* Exchange Rate Quick-Edit Input */}
                <ExchangeRateTopbar />

                {/* Storefront Sub-link Launcher */}
                <SublinkLauncher />

                {/* Network Connection Status Badge */}
                <ConnectionStatus />
            </div>
        </header>
    );
}
