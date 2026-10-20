/**
 * T6b Phase 2 — /admin/subscriptions/[id] (detail shell).
 *
 * Access denied → notFound() (404). Any OTHER failure (a database outage, a
 * bug) is rethrown so it surfaces as a real error instead of masquerading
 * as "page not found".
 */
import { notFound } from "next/navigation";
import { requirePlatformAdminForPage } from "@/lib/auth/platform-admin";
import { getSubscriptionDetail, SubscriptionNotFoundError } from "@/lib/data/platform-admin";
import { SubscriptionDetailClient } from "@/components/admin/subscription-detail-client";

export const dynamic = "force-dynamic";

export default async function AdminSubscriptionDetailPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const ctx = await requirePlatformAdminForPage();

    let detail;
    try {
        detail = await getSubscriptionDetail(ctx, id);
    } catch (error) {
        if (error instanceof SubscriptionNotFoundError) notFound();
        throw error;
    }
    return <SubscriptionDetailClient initial={detail} id={id} />;
}