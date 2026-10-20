/**
 * T6b Phase 2 — /admin layout (route group A).
 *
 * Own shell: calls requirePlatformAdminForPage() itself (middleware is UX
 * only) and does NOT use the merchant shell (no DashboardSidebar, no
 * SubscriptionBanner, no merchant subscription redirects).
 */
import Link from "next/link";
import { signOut } from "@/auth";
import { requirePlatformAdminForPage } from "@/lib/auth/platform-admin";
import { SessionProvider } from "@/components/providers/session-provider";

const NAV = [
    { href: "/admin/subscriptions", label: "الاشتراكات" },
    { href: "/admin/catalog-reports", label: "تقارير الكتالوج" },
    { href: "/admin/settings", label: "إعدادات المنصة" },
];

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
    await requirePlatformAdminForPage();
    return (
        <SessionProvider>
            <div dir="rtl" className="min-h-screen bg-zinc-50 text-zinc-900">
                <header className="border-b border-zinc-200 bg-white">
                    <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-4 py-3">
                        <span className="text-lg font-extrabold">إدارة المنصة</span>
                        <nav className="flex flex-wrap items-center gap-2" aria-label="التنقل الإداري">
                            {NAV.map((item) => (
                                <Link
                                    key={item.href}
                                    href={item.href}
                                    className="rounded-xl px-3 py-2 text-sm font-bold text-zinc-700 hover:bg-zinc-100"
                                >
                                    {item.label}
                                </Link>
                            ))}
                        </nav>
                        <form
                            className="ms-auto"
                            action={async () => {
                                "use server";
                                await signOut({ redirectTo: "/login" });
                            }}
                        >
                            <button
                                type="submit"
                                className="rounded-xl border border-zinc-200 px-3 py-2 text-sm font-bold text-zinc-700 hover:bg-zinc-100"
                            >
                                تسجيل الخروج
                            </button>
                        </form>
                    </div>
                </header>
                <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
            </div>
        </SessionProvider>
    );
}
