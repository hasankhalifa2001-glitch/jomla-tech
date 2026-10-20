/**
 * T6b — /admin/settings (platform rate).
 *
 * Thin server wrapper: layout already gated via requirePlatformAdminForPage;
 * this re-asserts for direct page renders (defense in depth → notFound()).
 */
import { requirePlatformAdminForPage } from "@/lib/auth/platform-admin";
import { getPlatformRate } from "@/lib/data/platform-admin";
import { SettingsClient } from "@/components/admin/settings-client";

export const dynamic = "force-dynamic";

export default async function AdminSettingsPage() {
    const ctx = await requirePlatformAdminForPage();
    const view = await getPlatformRate(ctx);
    return (
        <section>
            <h1 className="text-2xl font-extrabold">إعدادات المنصة</h1>
            <p className="mt-2 text-sm text-zinc-600">سعر صرف المنصة المستخدم في تسعير الاشتراكات. يُقرأ طازجاً عند كل عملية دفع.</p>
            <div className="mt-4">
                <SettingsClient initial={view} />
            </div>
        </section>
    );
}
