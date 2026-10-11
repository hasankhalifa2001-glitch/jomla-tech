/* DashboardTopBar.tsx */
"use client";

import { usePathname } from "next/navigation";
import { ExchangeRateTopbar } from "@/components/dashboard/exchange-rate-topbar";
import { ConnectionStatus } from "@/components/dashboard/connection-status";
import { SublinkLauncher } from "@/components/dashboard/sublink-launcher";
import { LogoMark } from "@/components/brand/logo";

const pathMap: Record<string, string> = {
    "/dashboard": "لوحة التحليلات",
    "/pos": "نقطة البيع (POS)",
    "/inventory": "إدارة المخزون والمنتجات",
    "/ledger": "دفتر الديون والتحصيل",
    "/orders": "سجل الطلبات والفواتير",
    "/settings/staff": "إدارة طاقم العمل",
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

/**
 * ONE row on every screen. Neutral (white / slate) chrome; colour is reserved
 * for state: emerald = online / brand accent, amber = a rate still has to be
 * set, red = offline. A thin emerald line under the bar carries the brand.
 */
export function DashboardTopBar() {
    const pathname = usePathname();
    const title = resolveTitle(pathname);

    return (
        <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/90 pt-[env(safe-area-inset-top)] backdrop-blur supports-[backdrop-filter]:bg-white/80">
            <div className="flex h-14 items-center justify-between gap-3 px-3 sm:h-16 sm:px-5">
                {/* Brand mark shows on mobile only — the sidebar carries it on larger screens. */}
                <div className="flex min-w-0 items-center gap-2.5">
                    <span className="shrink-0 md:hidden">
                        <LogoMark size={30} decorative />
                    </span>
                    <h1 className="truncate text-base font-extrabold text-slate-900 sm:text-lg">{title}</h1>
                </div>

                <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
                    <ExchangeRateTopbar />
                    <SublinkLauncher />
                    <ConnectionStatus />
                </div>
            </div>

            {/* Brand accent: strongest at the start edge, fading out. */}
            <div
                className="pointer-events-none absolute inset-x-0 bottom-[-1px] h-[2px] bg-gradient-to-l from-emerald-600 via-emerald-500/30 to-transparent"
                aria-hidden
            />
        </header>
    );
}