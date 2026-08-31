"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession, signOut } from "next-auth/react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger, SheetClose } from "@/components/ui/sheet";
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
    Menu,
    ExternalLink,
} from "lucide-react";

function isRouteActive(pathname: string, href: string): boolean {
    if (href === "/dashboard") return pathname === "/dashboard";
    return pathname === href || pathname.startsWith(`${href}/`);
}

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
    const [mobileOpen, setMobileOpen] = useState(false);
    const pathname = usePathname();
    const { data: session, status: sessionStatus } = useSession();

    const userRole = session?.user?.role || "CASHIER";
    // FIX (role flash): while the session is still resolving, we don't yet
    // know if this user is ADMIN or CASHIER. `userRole` defaults to
    // CASHIER during that window (fail-closed, unchanged), but instead of
    // silently dropping the adminOnly item from the list (which pops in a
    // moment later once the real role loads), we render a skeleton
    // placeholder in its slot below — same list length throughout, no
    // layout jump, no abrupt appearance.
    const isRoleKnown = sessionStatus !== "loading";

    const userName = session?.user?.name || "المستخدم";
    const tenantName = session?.user?.tenantName || "جملة تك";
    const tenantSlug = session?.user?.tenantSlug || "";

    const filteredNavItems = navItems.filter((item) => {
        if (item.adminOnly && userRole === "CASHIER") {
            return false;
        }
        return true;
    });

    // FIX: while role is unknown, an adminOnly item is neither confirmed
    // shown nor confirmed hidden — this flag drives the skeleton row
    // rendered alongside filteredNavItems below, in each of the three nav
    // surfaces (desktop, mobile bottom bar, mobile sheet).
    const showAdminSkeleton = !isRoleKnown && navItems.some((i) => i.adminOnly);

    const primaryMobileItems = filteredNavItems.slice(0, 4);

    return (
        <TooltipProvider delayDuration={100}>
            <aside
                className={cn(
                    "hidden md:flex relative flex-col border-l border-zinc-200 bg-white transition-all duration-300 dark:border-zinc-800 dark:bg-zinc-950 shrink-0 select-none",
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
                        const isActive = isRouteActive(pathname, item.href);

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

                    {/* FIX (role flash): reserves the settings item's slot
                        while we don't yet know if this user is ADMIN.
                        Disappears the instant sessionStatus resolves —
                        either the real item renders above (ADMIN) or
                        nothing does (CASHIER), with no size change since
                        this placeholder is gone by then either way. */}
                    {showAdminSkeleton && (
                        <div className={cn("flex items-center gap-3 rounded-xl px-3 py-2.5", collapsed && "justify-center px-0")}>
                            <Skeleton className="h-5 w-5 shrink-0 rounded" />
                            {!collapsed && <Skeleton className="h-4 w-24 rounded" />}
                        </div>
                    )}
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

            {/* Mobile Bottom Navigation Bar & Hamburger Sheet */}
            <nav className="md:hidden fixed bottom-0 inset-x-0 z-40 bg-white dark:bg-zinc-950 border-t border-zinc-200 dark:border-zinc-800 flex items-center justify-around h-16 px-1 shadow-lg">
                {primaryMobileItems.map((item) => {
                    const Icon = item.icon;
                    const isActive = isRouteActive(pathname, item.href);
                    return (
                        <Link
                            key={item.href}
                            href={item.href}
                            className={cn(
                                "flex flex-col items-center justify-center gap-1 w-full h-full py-1 text-[10px] font-semibold transition-colors",
                                isActive
                                    ? "text-emerald-600 dark:text-emerald-400 font-bold"
                                    : "text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
                            )}
                        >
                            <Icon className={cn("h-5 w-5", isActive && "stroke-[2.5px]")} />
                            <span>{item.label}</span>
                        </Link>
                    );
                })}

                {/* Mobile Menu (Sheet Trigger) */}
                <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
                    <SheetTrigger asChild>
                        <button
                            type="button"
                            className="flex flex-col items-center justify-center gap-1 w-full h-full py-1 text-[10px] font-semibold text-zinc-500 hover:text-zinc-900 dark:text-zinc-100"
                        >
                            <Menu className="h-5 w-5" />
                            <span>المزيد</span>
                        </button>
                    </SheetTrigger>
                    <SheetContent side="right" className="w-80 p-0 flex flex-col justify-between">
                        <div>
                            <SheetHeader className="border-b border-zinc-200 p-4 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900">
                                <div className="flex items-center gap-3">
                                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-600 text-white font-bold shadow-md shadow-emerald-500/20">
                                        <Store className="h-5 w-5" />
                                    </div>
                                    <div className="flex flex-col text-right">
                                        <SheetTitle className="text-sm font-bold text-zinc-900 dark:text-zinc-100">
                                            {tenantName}
                                        </SheetTitle>
                                        <span className="text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
                                            لوحة التحكم والخدمات
                                        </span>
                                    </div>
                                </div>
                            </SheetHeader>

                            <div className="p-3 space-y-1">
                                {filteredNavItems.map((item) => {
                                    const Icon = item.icon;
                                    const isActive = isRouteActive(pathname, item.href);
                                    return (
                                        <SheetClose key={item.href} asChild>
                                            <Link
                                                href={item.href}
                                                className={cn(
                                                    "flex items-center gap-3 rounded-xl px-3.5 py-3 text-xs font-semibold transition-all",
                                                    isActive
                                                        ? "bg-emerald-600 text-white shadow-md shadow-emerald-600/20"
                                                        : "text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-900"
                                                )}
                                            >
                                                <Icon className="h-4 w-4 shrink-0" />
                                                <span>{item.label}</span>
                                            </Link>
                                        </SheetClose>
                                    );
                                })}

                                {showAdminSkeleton && (
                                    <div className="flex items-center gap-3 rounded-xl px-3.5 py-3">
                                        <Skeleton className="h-4 w-4 shrink-0 rounded" />
                                        <Skeleton className="h-3.5 w-28 rounded" />
                                    </div>
                                )}

                                {tenantSlug && (
                                    <SheetClose asChild>
                                        <Link
                                            href={`/store/${tenantSlug}`}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="flex items-center gap-3 rounded-xl px-3.5 py-3 text-xs font-semibold text-emerald-700 hover:bg-emerald-50 dark:text-emerald-400 dark:hover:bg-emerald-950/40 mt-2 border border-emerald-200 dark:border-emerald-900/50"
                                        >
                                            <ExternalLink className="h-4 w-4 shrink-0" />
                                            <span>معاينة المتجر الإلكتروني</span>
                                        </Link>
                                    </SheetClose>
                                )}
                            </div>
                        </div>
                        <div className="border-t border-zinc-200 p-4 dark:border-zinc-800 bg-zinc-50/50 dark:bg-zinc-900/40 space-y-3">
                            <div className="flex items-center gap-3">
                                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 font-semibold text-xs">
                                    <UserCheck className="h-4 w-4" />
                                </div>
                                <div className="flex flex-col min-w-0 flex-1">
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

                            <Button
                                variant="destructive"
                                size="sm"
                                onClick={() => signOut({ callbackUrl: "/login" })}
                                className="w-full gap-2 font-bold text-xs h-9"
                            >
                                <LogOut className="h-4 w-4" />
                                <span>تسجيل الخروج</span>
                            </Button>
                        </div>
                    </SheetContent>
                </Sheet>
            </nav>
        </TooltipProvider>
    );
}