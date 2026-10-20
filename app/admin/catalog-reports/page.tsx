/**
 * T6b — /admin/catalog-reports (Super-Admin only).
 *
 * Thin server wrapper: layout already gated via requirePlatformAdminForPage;
 * this re-asserts for direct page renders (defense in depth → notFound()).
 */
import { requirePlatformAdminForPage } from "@/lib/auth/platform-admin";
import { CatalogReportsClient } from "@/components/admin/catalog-reports-client";

export const dynamic = "force-dynamic";

export default async function AdminCatalogReportsPage() {
    await requirePlatformAdminForPage();
    return (
        <section>
            <h1 className="text-2xl font-extrabold">تقارير الكتالوج</h1>
            <p className="mt-2 text-sm text-zinc-600">راجع الاقتراحات بجانب القيمة الحالية، ثم اعتمدها أو ارفضها.</p>
            <div className="mt-4">
                <CatalogReportsClient />
            </div>
        </section>
    );
}
