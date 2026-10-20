/**
 * T6b Phase 2 — /admin/subscriptions (server guard + client queue).
 *
 * Thin server wrapper: layout already gated via requirePlatformAdminForPage;
 * this re-asserts for direct page renders (defense in depth → notFound()).
 */
import { requirePlatformAdminForPage } from "@/lib/auth/platform-admin";
import { SubscriptionsClient } from "@/components/admin/subscriptions-client";

export default async function AdminSubscriptionsPage() {
    await requirePlatformAdminForPage();
    return (
        <section>
            <h1 className="text-2xl font-extrabold">طلبات الاشتراك</h1>
            <p className="mt-2 text-sm text-zinc-600">راجع طلبات التجار مع الإيصال والمبلغ المطلوب قبل الاعتماد أو الرفض.</p>
            <div className="mt-4">
                <SubscriptionsClient />
            </div>
        </section>
    );
}
