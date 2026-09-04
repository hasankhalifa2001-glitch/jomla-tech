/* DashboardTopBar.tsx */
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

function resolveTitle(pathname: string): string {
    if (pathMap[pathname]) return pathMap[pathname];

    let bestMatch: string | null = null;
    for (const key of Object.keys(pathMap)) {
        if (pathname.startsWith(`${key}/`)) {
            if (!bestMatch || key.length > bestMatch.length) {
                bestMatch = key;
            }
        }
    }

    return bestMatch ? pathMap[bestMatch] : "واجهة الإدارة";
}

export function DashboardTopBar() {
    const pathname = usePathname();
    const title = resolveTitle(pathname);

    return (
        <header className="sticky top-0 z-30 flex flex-col gap-3 border-b border-zinc-200 bg-white/95 px-4 py-3 backdrop-blur-md dark:border-zinc-800 dark:bg-zinc-950/95 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:gap-4 sm:px-6 sm:py-2.5">
            {/* Current Page Title / Breadcrumb */}
            <div className="flex items-center gap-3">
                <h1 className="text-base font-bold text-zinc-900 dark:text-zinc-100">{title}</h1>
            </div>

            {/* Top Bar Right Controls (Arabic RTL: Right side controls are placed logically) */}
            <div className="flex flex-wrap items-center gap-2 sm:gap-3">
                <ExchangeRateTopbar />
                <SublinkLauncher />
                <ConnectionStatus />
            </div>
        </header>
    );
}