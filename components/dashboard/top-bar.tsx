/* DashboardTopBar.tsx */
"use client";

import { usePathname } from "next/navigation";
import { ExchangeRateTopbar } from "@/components/dashboard/exchange-rate-topbar";
import { ConnectionStatus } from "@/components/dashboard/connection-status";
import { SublinkLauncher } from "@/components/dashboard/sublink-launcher";
import { LogoMark } from "@/components/brand/logo";
import s from "./shell.module.css";

const pathMap: Record<string, string> = {
    "/dashboard": "لوحة التحكم والتحليلات",
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

export function DashboardTopBar() {
    const pathname = usePathname();
    const title = resolveTitle(pathname);

    return (
        <header className={s.topbar}>
            {/* Current page title (the brand mark shows on mobile only, where the sidebar is hidden) */}
            <div className={s.tbTitle}>
                <span className={s.tbBrand}>
                    <LogoMark size={30} decorative />
                </span>
                <h1 className={s.title}>{title}</h1>
            </div>

            {/* Controls: exchange rate, storefront link, connection / sync status */}
            <div className={s.controls}>
                <ExchangeRateTopbar />
                <SublinkLauncher />
                <ConnectionStatus />
            </div>
        </header>
    );
}