/* DashboardTopBar.tsx */
"use client";

import { usePathname } from "next/navigation";
import { ExchangeRateTopbar } from "@/components/dashboard/exchange-rate-topbar";
import { ConnectionStatus } from "@/components/dashboard/connection-status";
import { SublinkLauncher } from "@/components/dashboard/sublink-launcher";

// FIX: kept as exact-match entries (still useful for section roots like
// "/settings/billing"), but resolution below now falls back to a
// longest-matching-prefix search instead of requiring a perfect match —
// so a detail page like /orders/123 or /inventory/some-id still shows its
// section's title instead of the generic fallback.
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

    // Longest prefix wins so "/settings/billing" (more specific) is
    // preferred over a hypothetical bare "/settings" entry for the same
    // path, if one is ever added.
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