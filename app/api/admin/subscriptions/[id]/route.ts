/**
 * T6b Phase 2 — GET /api/admin/subscriptions/[id]
 *
 * Super-Admin detail: the request + tenant status/expiry + last 10 tenant
 * requests + D6 preview + exchangeRateUsed beside the current platform rate.
 * Read-only. Unknown id → 404 NOT_FOUND, never another tenant's data
 * (the row's own tenantId scopes every later read).
 */
import { NextResponse } from "next/server";
import {
    requirePlatformAdmin,
    platformAdminForbiddenResponse,
    PlatformAdminDeniedError,
    type PlatformAdminContext,
} from "@/lib/auth/platform-admin";
import { getSubscriptionDetail, SubscriptionNotFoundError } from "@/lib/data/platform-admin";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    let ctx: PlatformAdminContext;
    try {
        ctx = await requirePlatformAdmin();
    } catch (error) {
        if (error instanceof PlatformAdminDeniedError) return platformAdminForbiddenResponse(error);
        throw error;
    }
    try {
        const detail = await getSubscriptionDetail(ctx, id);
        return NextResponse.json({ subscription: detail });
    } catch (error) {
        if (error instanceof SubscriptionNotFoundError) {
            return NextResponse.json({ error: "NOT_FOUND", message: error.message }, { status: 404 });
        }
        console.error("[admin/subscriptions] detail failed:", error);
        return NextResponse.json({ error: "SERVER_ERROR", message: "حدث خطأ أثناء جلب تفاصيل الطلب." }, { status: 500 });
    }
}
