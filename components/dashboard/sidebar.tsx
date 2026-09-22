"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "next-auth/react";
import { useSessionWithOfflineFallback, clearCachedSession } from "@/lib/offline";
import { useActiveSessionStore } from "@/lib/store/useActiveSessionStore"; // [ADD]
import { Sheet, SheetContent, SheetTitle, SheetTrigger, SheetClose } from "@/components/ui/sheet";
import { LogoMark } from "@/components/brand/logo";
import {
    LayoutDashboard,
    ShoppingCart,
    Package,
    BookOpen,
    Receipt,
    ScrollText,
    Settings,
    Users,
    ChevronRight,
    LogOut,
    Menu,
    ExternalLink,
} from "lucide-react";
import s from "./shell.module.css";

function isRouteActive(pathname: string, href: string): boolean {
    if (href === "/dashboard") return pathname === "/dashboard";
    return pathname === href || pathname.startsWith(`${href}/`);
}

const navItems = [
    { href: "/dashboard", label: "الرئيسية", icon: LayoutDashboard, adminOnly: true },
    { href: "/pos", label: "نقطة البيع", icon: ShoppingCart },
    { href: "/inventory", label: "المخزون", icon: Package },
    // [ADDED — T4c2] The sales/invoice history log. Deliberately NOT
    // adminOnly: T2b's Role Capability Matrix grants BOTH roles full
    // read-only access here, with a CASHIER's view scoped server-side to
    // their own invoices (GET /api/invoices forces userId = session.user.id)
    // and the "filter by staff member" control being ADMIN-only inside the
    // screen itself.
    { href: "/dashboard/sales-log", label: "سجل المبيعات", icon: ScrollText },
    { href: "/ledger", label: "دفتر الديون", icon: BookOpen },
    { href: "/orders", label: "الطلبات", icon: Receipt },
    { href: "/settings/staff", label: "طاقم العمل", icon: Users, adminOnly: true },
    { href: "/settings/billing", label: "الإعدادات والفوترة", icon: Settings, adminOnly: true },
];

// "auto": follow the screen (expanded on wide screens, collapsed icon rail on
// medium ones). "expanded"/"collapsed": the user's explicit choice.
type RailPref = "auto" | "expanded" | "collapsed";
const WIDE_QUERY = "(min-width: 1180px)";

export function DashboardSidebar() {
    const [pref, setPref] = useState<RailPref>("auto");
    const [mobileOpen, setMobileOpen] = useState(false);
    const pathname = usePathname();
    const { data: session, status: sessionStatus } = useSessionWithOfflineFallback();
    const setCurrentUserId = useActiveSessionStore((st) => st.setCurrentUserId); // [ADD]

    // The rail's width/labels are driven by CSS; here we only need to know
    // whether it is currently expanded so the toggle flips the right way.
    const toggleRail = () => {
        const wide = window.matchMedia(WIDE_QUERY).matches;
        setPref((p) => {
            const expandedNow = p === "auto" ? wide : p === "expanded";
            return expandedNow ? "collapsed" : "expanded";
        });
    };

    const handleSignOut = async () => {
        // [FIX — skip unnecessary offline-verification fetch on manual
        // logout] Clear this tab's known identity FIRST, synchronously,
        // before anything else. The moment liveStatus flips to
        // "unauthenticated", useSessionWithOfflineFallback's
        // liveIsUnreachable check reads currentUserId === null and skips
        // its /api/auth/session verification fetch entirely — that fetch
        // exists to distinguish a real logout from a failed network call,
        // and a user-initiated logout while online is never ambiguous.
        setCurrentUserId(null); // [ADD]

        if (session?.userId) {
            try {
                await clearCachedSession(session.userId);
            } catch (e) {
                console.error("Failed to clear cached session during logout:", e);
            }
        }
        await signOut({ callbackUrl: "/login" });
    };

    const userRole = session?.role || "CASHIER";
    // FIX (role flash): while the session is still resolving, we don't yet
    // know if this user is ADMIN or CASHIER. `userRole` defaults to
    // CASHIER during that window (fail-closed, unchanged), but instead of
    // silently dropping the adminOnly item from the list (which pops in a
    // moment later once the real role loads), we render a skeleton
    // placeholder in its slot below — same list length throughout, no
    // layout jump, no abrupt appearance.
    const isRoleKnown = sessionStatus !== "loading";

    const userName = session?.name || "المستخدم";
    const tenantName = session?.tenantName || "جملة تك";
    const tenantSlug = session?.tenantSlug || "";
    const initial = userName.trim().charAt(0) || "م";

    const filteredNavItems = navItems.filter((item) => {
        if (item.adminOnly && userRole === "CASHIER") {
            return false;
        }
        return true;
    });

    // FIX: while role is unknown, an adminOnly item is neither confirmed
    // shown nor confirmed hidden — this flag drives the skeleton row
    // rendered alongside filteredNavItems below (desktop rail and mobile
    // drawer).
    const showAdminSkeleton = !isRoleKnown && navItems.some((i) => i.adminOnly);

    const primaryMobileItems = filteredNavItems.slice(0, 4);

    const roleBadge = (
        <span className={`${s.badge} ${userRole === "ADMIN" ? s.badgeAdmin : s.badgeCashier}`}>
            {userRole === "ADMIN" ? "أدمن" : "كاشير"}
        </span>
    );

    return (
        <>
            {/* Desktop / laptop / tablet: collapsible rail */}
            <aside className={s.rail} data-pref={pref}>
                <div className={s.railHead}>
                    <LogoMark size={40} decorative />
                    <div className={s.tenant}>
                        <span className={s.tenantName}>{tenantName}</span>
                        <span className={s.tenantCaption}>لوحة تاجر الجملة</span>
                    </div>
                </div>

                <button
                    type="button"
                    className={s.collapseBtn}
                    onClick={toggleRail}
                    aria-label="طي أو توسيع القائمة الجانبية"
                    title="طي أو توسيع القائمة"
                >
                    <ChevronRight size={16} aria-hidden />
                </button>

                <nav className={s.nav} aria-label="التنقل الرئيسي">
                    {filteredNavItems.map((item) => {
                        const Icon = item.icon;
                        const isActive = isRouteActive(pathname, item.href);
                        return (
                            <Link
                                key={item.href}
                                href={item.href}
                                data-label={item.label}
                                aria-label={item.label}
                                aria-current={isActive ? "page" : undefined}
                                className={`${s.navLink} ${isActive ? s.navActive : ""}`}
                            >
                                <Icon size={20} className={s.navIcon} aria-hidden />
                                <span className={s.navLabel}>{item.label}</span>
                            </Link>
                        );
                    })}

                    {/* FIX (role flash): reserves the settings item's slot
                        while we don't yet know if this user is ADMIN.
                        Disappears the instant sessionStatus resolves —
                        either the real item renders above (ADMIN) or
                        nothing does (CASHIER). */}
                    {showAdminSkeleton && (
                        <div className={s.navSkel} aria-hidden>
                            <span className={`${s.skelBar} ${s.skelIcon}`} />
                            <span className={s.skelBar} />
                        </div>
                    )}
                </nav>

                <div className={s.railFoot}>
                    <div className={s.user}>
                        <span className={s.avatar} aria-hidden>{initial}</span>
                        <div className={s.userText}>
                            <span className={s.userName}>{userName}</span>
                            {roleBadge}
                        </div>
                    </div>
                    <button
                        type="button"
                        onClick={handleSignOut}
                        className={s.iconBtn}
                        aria-label={`تسجيل الخروج (${userName})`}
                        title="تسجيل الخروج"
                    >
                        <LogOut size={18} aria-hidden />
                    </button>
                </div>
            </aside>

            {/* Mobile: bottom navigation bar + drawer */}
            <nav className={s.bottomBar} aria-label="التنقل السريع">
                {primaryMobileItems.map((item) => {
                    const Icon = item.icon;
                    const isActive = isRouteActive(pathname, item.href);
                    return (
                        <Link
                            key={item.href}
                            href={item.href}
                            aria-current={isActive ? "page" : undefined}
                            className={`${s.bbItem} ${isActive ? s.bbActive : ""}`}
                        >
                            <Icon size={22} strokeWidth={isActive ? 2.5 : 2} aria-hidden />
                            <span>{item.label}</span>
                        </Link>
                    );
                })}

                {/* Mobile Menu (Sheet Trigger) */}
                <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
                    <SheetTrigger asChild>
                        <button type="button" className={s.bbItem}>
                            <Menu size={22} aria-hidden />
                            <span>المزيد</span>
                        </button>
                    </SheetTrigger>
                    <SheetContent side="right" className={`w-80 p-0 flex flex-col justify-between ${s.sheet}`}>
                        <div className={s.sheetBody}>
                            <div className={s.sheetHead}>
                                <LogoMark size={40} decorative />
                                <div>
                                    <SheetTitle className={s.sheetTitle}>{tenantName}</SheetTitle>
                                    <span className={s.tenantCaption}>لوحة التحكم والخدمات</span>
                                </div>
                            </div>

                            <div className={s.sheetList}>
                                {filteredNavItems.map((item) => {
                                    const Icon = item.icon;
                                    const isActive = isRouteActive(pathname, item.href);
                                    return (
                                        <SheetClose key={item.href} asChild>
                                            <Link
                                                href={item.href}
                                                aria-current={isActive ? "page" : undefined}
                                                className={`${s.sheetLink} ${isActive ? s.sheetActive : ""}`}
                                            >
                                                <Icon size={20} aria-hidden />
                                                <span>{item.label}</span>
                                            </Link>
                                        </SheetClose>
                                    );
                                })}

                                {showAdminSkeleton && (
                                    <div className={s.navSkel} aria-hidden style={{ justifyContent: "flex-start" }}>
                                        <span className={`${s.skelBar} ${s.skelIcon}`} />
                                        <span className={s.skelBar} style={{ width: 112, display: "block" }} />
                                    </div>
                                )}

                                {tenantSlug && (
                                    <SheetClose asChild>
                                        <Link
                                            href={`/store/${tenantSlug}`}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className={`${s.sheetLink} ${s.sheetStore}`}
                                        >
                                            <ExternalLink size={20} aria-hidden />
                                            <span>معاينة المتجر الإلكتروني</span>
                                        </Link>
                                    </SheetClose>
                                )}
                            </div>
                        </div>

                        <div className={s.sheetFoot}>
                            <div className={s.user}>
                                <span className={s.avatar} aria-hidden>{initial}</span>
                                <div style={{ minWidth: 0 }}>
                                    <span className={s.userName}>{userName}</span>
                                    {roleBadge}
                                </div>
                            </div>

                            <button type="button" onClick={handleSignOut} className={s.signOut}>
                                <LogOut size={18} aria-hidden />
                                <span>تسجيل الخروج</span>
                            </button>
                        </div>
                    </SheetContent>
                </Sheet>
            </nav>
        </>
    );
}