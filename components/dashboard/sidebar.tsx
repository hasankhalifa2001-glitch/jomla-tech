"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession, signOut } from "next-auth/react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
    LayoutDashboard,
    ShoppingCart,
    Package,
    BookOpen,
    Receipt,
    Settings,
    ChevronRight,
    ChevronLeft,
    LogOut,
    Store,
    UserCheck,
} from "lucide-react";

const navItems = [
    { href: "/dashboard", label: "الرئيسية", icon: LayoutDashboard },
    { href: "/pos", label: "نقطة البيع", icon: ShoppingCart },
    { href: "/inventory", label: "المخزون", icon: Package },
    { href: "/ledger", label: "دفتر الديون", icon: BookOpen },
    { href: "/orders", label: "الطلبات", icon: Receipt },
    { href: "/settings/billing", label: "الإعدادات والفوترة", icon: Settings, adminOnly: true },
];

export function DashboardSidebar() {
    const [collapsed, setCollapsed] = useState(false);
    const pathname = usePathname();
    const { data: session } = useSession();

    const userRole = session?.user?.role || "CASHIER";
    const userName = session?.user?.name || "المستخدم";
    const tenantName = session?.user?.tenantName || "جملة تك";

    const filteredNavItems = navItems.filter((item) => {
        if (item.adminOnly && userRole === "CASHIER") {
            return false;
        }
        return true;
    });

    return (
        <TooltipProvider delayDuration={100}>
            <aside
                className={cn(
                    "relative flex flex-col border-l border-zinc-200 bg-white transition-all duration-300 dark:border-zinc-800 dark:bg-zinc-950 shrink-0 select-none",
                    collapsed ? "w-20" : "w-64"
                )}
            >
                {/* Top Header / Merchant Name */}
                <div className="flex h-16 items-center justify-between border-b border-zinc-200 px-4 dark:border-zinc-800">
                    <div className={cn("flex items-center gap-3 overflow-hidden", collapsed && "justify-center w-full")}>
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-600 text-white font-bold shadow-md shadow-emerald-500/20">
                            <Store className="h-5 w-5" />
                        </div>
                        {!collapsed && (
                            <div className="flex flex-col truncate">
                                <span className="truncate text-sm font-bold text-zinc-900 dark:text-zinc-100">
                                    {tenantName}
                                </span>
                                <span className="text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
                                    لوحة تاجر الجملة
                                </span>
                            </div>
                        )}
                    </div>

                    {!collapsed && (
                        <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => setCollapsed(true)}
                            className="h-8 w-8 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                            title="طي القائمة"
                        >
                            <ChevronRight className="h-4 w-4" />
                        </Button>
                    )}
                </div>

                {/* Navigation Items */}
                <nav className="flex-1 space-y-1.5 p-3 overflow-y-auto">
                    {filteredNavItems.map((item) => {
                        const Icon = item.icon;
                        const isActive =
                            pathname === item.href ||
                            (item.href !== "/dashboard" && pathname.startsWith(item.href));

                        const navLink = (
                            <Link
                                key={item.href}
                                href={item.href}
                                className={cn(
                                    "flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors",
                                    isActive
                                        ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300 font-semibold"
                                        : "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-900 dark:hover:text-zinc-200",
                                    collapsed && "justify-center px-0"
                                )}
                            >
                                <Icon
                                    className={cn(
                                        "h-5 w-5 shrink-0 transition-transform",
                                        isActive ? "text-emerald-600 dark:text-emerald-400 scale-110" : "text-zinc-500"
                                    )}
                                />
                                {!collapsed && <span>{item.label}</span>}
                            </Link>
                        );

                        if (collapsed) {
                            return (
                                <Tooltip key={item.href}>
                                    <TooltipTrigger asChild>{navLink}</TooltipTrigger>
                                    <TooltipContent side="left" className="font-sans text-xs">
                                        {item.label}
                                    </TooltipContent>
                                </Tooltip>
                            );
                        }

                        return navLink;
                    })}
                </nav>

                {/* Expand Sidebar Floating Toggle (when collapsed) */}
                {collapsed && (
                    <div className="flex justify-center p-2 border-t border-zinc-200 dark:border-zinc-800">
                        <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => setCollapsed(false)}
                            className="h-8 w-8 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                            title="توسيع القائمة"
                        >
                            <ChevronLeft className="h-4 w-4" />
                        </Button>
                    </div>
                )}

                {/* Footer User Info & Sign Out */}
                <div className="border-t border-zinc-200 p-3 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-900/30">
                    <div className={cn("flex items-center gap-3", collapsed ? "justify-center" : "justify-between")}>
                        {!collapsed ? (
                            <>
                                <div className="flex items-center gap-2 overflow-hidden">
                                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 font-semibold text-xs">
                                        <UserCheck className="h-4 w-4" />
                                    </div>
                                    <div className="flex flex-col truncate">
                                        <span className="truncate text-xs font-semibold text-zinc-900 dark:text-zinc-100">
                                            {userName}
                                        </span>
                                        <div className="flex items-center gap-1">
                                            <Badge
                                                variant="secondary"
                                                className={cn(
                                                    "text-[10px] px-1.5 py-0 font-bold",
                                                    userRole === "ADMIN"
                                                        ? "bg-purple-100 text-purple-700 dark:bg-purple-950 dark:text-purple-300"
                                                        : "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300"
                                                )}
                                            >
                                                {userRole === "ADMIN" ? "أدمن" : "كاشير"}
                                            </Badge>
                                        </div>
                                    </div>
                                </div>

                                <Tooltip>
                                    <TooltipTrigger asChild>
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            onClick={() => signOut({ callbackUrl: "/login" })}
                                            className="h-8 w-8 text-red-600 hover:bg-red-50 dark:hover:bg-red-950/50 shrink-0"
                                        >
                                            <LogOut className="h-4 w-4" />
                                        </Button>
                                    </TooltipTrigger>
                                    <TooltipContent side="top" className="text-xs">
                                        تسجيل الخروج
                                    </TooltipContent>
                                </Tooltip>
                            </>
                        ) : (
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        onClick={() => signOut({ callbackUrl: "/login" })}
                                        className="h-9 w-9 text-red-600 hover:bg-red-50 dark:hover:bg-red-950/50"
                                    >
                                        <LogOut className="h-4 w-4" />
                                    </Button>
                                </TooltipTrigger>
                                <TooltipContent side="left" className="text-xs">
                                    تسجيل الخروج ({userName})
                                </TooltipContent>
                            </Tooltip>
                        )}
                    </div>
                </div>
            </aside>
        </TooltipProvider>
    );
}
