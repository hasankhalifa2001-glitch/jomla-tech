/**
 * T5b — POST /api/orders/[id]/reject
 *
 * ADMIN only (orders:reject; CASHIER → 403 zero writes). assertTenantWritable
 * runs before any write (locked tenant → 403 TENANT_NOT_WRITABLE). Strict zod
 * { reason } trimmed 3–500 → 400 VALIDATION_ERROR. One $transaction: conditional
 * updateMany WHERE PENDING_REVIEW writes ONLY status/rejectionReason/
 * reviewedByUserId/reviewedAt; count !== 1 → 404 (absent/other tenant) or
 * 409 ALREADY_REVIEWED. No Invoice/stock/payment/signal write. No retailer
 * notification of any kind (D13). Success: { success: true }.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { getTenantDb } from "@/lib/db/tenant-scope";
import { assertRolePermission, ForbiddenRoleError } from "@/lib/auth/role-matrix";
import { assertTenantWritable, SubscriptionLockedError } from "@/lib/auth/tenant";
import { STORE_ERROR } from "@/lib/config/storefront";
import {
    rejectOrder,
    OrderNotFoundError,
    OrderAlreadyReviewedError,
    InvalidRejectReasonError,
} from "@/lib/data/orders";

export const dynamic = "force-dynamic";

const REASON_MESSAGE = "سبب الرفض مطلوب (3–500 حرف).";

// .strict(): any extra field (e.g. a forged "status") is rejected with 400.
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
    const session = await auth();
    if (!session?.user?.tenantId || !session.user.id) {
        return NextResponse.json(
            { code: STORE_ERROR.UNAUTHORIZED, message: "يرجى تسجيل الدخول أولاً." },
            { status: 401 }
        );
    }
    try {
        assertRolePermission(session.user.role, "orders:reject");
    } catch (error) {
        if (error instanceof ForbiddenRoleError) {
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
        await assertTenantWritable(session.user.tenantId);
    } catch (error) {
        if (error instanceof SubscriptionLockedError) {
            return NextResponse.json(
                { code: STORE_ERROR.TENANT_NOT_WRITABLE, message: error.message },
                { status: 403 }
            );
        }
        throw error;
    }

    const tenantId = session.user.tenantId;
    const db = getTenantDb(tenantId);
    try {
        await rejectOrder(db, tenantId, id, {
            reason: body.data.reason,
            reviewedByUserId: session.user.id,
        });
        return NextResponse.json({ success: true });
    } catch (error) {
        if (error instanceof OrderAlreadyReviewedError) {
            return NextResponse.json(
                { code: STORE_ERROR.ALREADY_REVIEWED, message: error.message },
                { status: 409 }
            );
        }
        if (error instanceof OrderNotFoundError) {
            return NextResponse.json(
                { code: STORE_ERROR.NOT_FOUND, message: error.message },
                { status: 404 }
            );
        }
        if (error instanceof InvalidRejectReasonError) {
            return NextResponse.json(
                { code: STORE_ERROR.VALIDATION_ERROR, message: error.message },
                { status: 400 }
            );
        }
        console.error("Error rejecting B2B order:", error);
        return NextResponse.json(
            { code: STORE_ERROR.INTERNAL_ERROR, message: "حدث خطأ أثناء رفض الطلب." },
            { status: 500 }
        );
    }
}