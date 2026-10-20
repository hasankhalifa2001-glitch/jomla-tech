/**
 * T6b Phase 3 — POST /api/admin/subscriptions/[id]/approve
 *
 * Super-Admin only (fresh-DB check via requirePlatformAdmin, never the JWT).
 * reviewedByUserId comes from the DB-verified PlatformAdminContext, never
 * from the body or the JWT. One $transaction: claim -> read tenant ->
 * subscription.update -> tenant.update -> expire the tenant's other ACTIVE
 * rows. Error shape { code, message } using STORE_ERROR constants; unexpected
 * failures -> 500 INTERNAL_ERROR, never FORBIDDEN.
 */
import { NextResponse } from "next/server";
import {
    requirePlatformAdmin,
    PlatformAdminDeniedError,
    type PlatformAdminContext,
} from "@/lib/auth/platform-admin";
import {
    approveSubscription,
    SubscriptionAlreadyReviewedError,
    SubscriptionNotFoundError,
    SubscriptionReceiptRequiredError,
} from "@/lib/data/platform-admin";
import { STORE_ERROR } from "@/lib/config/storefront";

export const dynamic = "force-dynamic";

export async function POST(
    _req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;
    let ctx: PlatformAdminContext;
    try {
        ctx = await requirePlatformAdmin();
    } catch (error) {
        if (error instanceof PlatformAdminDeniedError) {
            return NextResponse.json(
                { code: STORE_ERROR.FORBIDDEN, message: error.message },
                { status: 403 }
            );
        }
        throw error;
    }
    try {
        const result = await approveSubscription(ctx, id, {
            reviewedByUserId: ctx.userId,
            now: new Date(),
        });
        return NextResponse.json({
            success: true,
            subscriptionId: result.id,
            newExpiresAt: result.newExpiresAt,
        });
    } catch (error) {
        if (error instanceof SubscriptionNotFoundError) {
            return NextResponse.json(
                { code: STORE_ERROR.NOT_FOUND, message: error.message },
                { status: 404 }
            );
        }
        if (error instanceof SubscriptionReceiptRequiredError) {
            return NextResponse.json(
                { code: STORE_ERROR.RECEIPT_REQUIRED, message: error.message },
                { status: 409 }
            );
        }
        if (error instanceof SubscriptionAlreadyReviewedError) {
            return NextResponse.json(
                { code: STORE_ERROR.ALREADY_REVIEWED, message: error.message },
                { status: 409 }
            );
        }
        console.error("[admin/subscriptions/approve] failed:", error);
        return NextResponse.json(
            { code: STORE_ERROR.INTERNAL_ERROR, message: "حدث خطأ أثناء اعتماد الطلب." },
            { status: 500 }
        );
    }
}
