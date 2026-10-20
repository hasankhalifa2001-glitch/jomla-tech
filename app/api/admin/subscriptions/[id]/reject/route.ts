/**
 * T6b Phase 3 — POST /api/admin/subscriptions/[id]/reject
 *
 * Super-Admin only (fresh-DB check via requirePlatformAdmin, never the JWT).
 * Body { reason } (trimmed, 3–500). One $transaction: conditional claim
 * WHERE PENDING_APPROVAL writes ONLY status / rejectionReason /
 * reviewedByUserId / reviewedAt; the Tenant is untouched. Works with or
 * without a receipt. Error shape { code, message } using STORE_ERROR
 * constants; unexpected failures -> 500 INTERNAL_ERROR, never FORBIDDEN.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import {
    requirePlatformAdmin,
    PlatformAdminDeniedError,
    type PlatformAdminContext,
} from "@/lib/auth/platform-admin";
import {
    rejectSubscription,
    SubscriptionAlreadyReviewedError,
    SubscriptionNotFoundError,
} from "@/lib/data/platform-admin";
import { STORE_ERROR } from "@/lib/config/storefront";

export const dynamic = "force-dynamic";

const REASON_MESSAGE = "سبب الرفض مطلوب (3–500 حرف).";

const bodySchema = z
    .object({
        reason: z.string().trim().min(3, REASON_MESSAGE).max(500, REASON_MESSAGE),
    })
    .strict();

export async function POST(
    req: Request,
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

    const raw = await req.json().catch(() => null);
    const body = bodySchema.safeParse(raw);
    if (!body.success) {
        return NextResponse.json(
            { code: STORE_ERROR.VALIDATION_ERROR, message: REASON_MESSAGE },
            { status: 400 }
        );
    }

    try {
        await rejectSubscription(ctx, id, {
            reason: body.data.reason,
            reviewedByUserId: ctx.userId,
            now: new Date(),
        });
        return NextResponse.json({ success: true });
    } catch (error) {
        if (error instanceof SubscriptionNotFoundError) {
            return NextResponse.json(
                { code: STORE_ERROR.NOT_FOUND, message: error.message },
                { status: 404 }
            );
        }
        if (error instanceof SubscriptionAlreadyReviewedError) {
            return NextResponse.json(
                { code: STORE_ERROR.ALREADY_REVIEWED, message: error.message },
                { status: 409 }
            );
        }
        console.error("[admin/subscriptions/reject] failed:", error);
        return NextResponse.json(
            { code: STORE_ERROR.INTERNAL_ERROR, message: "حدث خطأ أثناء رفض الطلب." },
            { status: 500 }
        );
    }
}
