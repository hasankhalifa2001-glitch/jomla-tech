/**
 * T6b Phase 2 — GET /api/admin/subscriptions
 *
 * Super-Admin queue: tabs PENDING_APPROVAL (default) / ACTIVE / REJECTED /
 * EXPIRED, cursor pagination (createdAt desc, id desc), search by
 * referenceCode (case-insensitive) or tenant name (capped). Read-only.
 * Error shape { error, message }.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
    requirePlatformAdmin,
    platformAdminForbiddenResponse,
    PlatformAdminDeniedError,
    type PlatformAdminContext,
} from "@/lib/auth/platform-admin";
import {
    listSubscriptions,
    InvalidSubscriptionCursorError,
    SUBSCRIPTION_PAGE_SIZE,
} from "@/lib/data/platform-admin";

export const dynamic = "force-dynamic";

const querySchema = z.object({
    status: z.enum(["PENDING_APPROVAL", "ACTIVE", "REJECTED", "EXPIRED"]).default("PENDING_APPROVAL"),
    q: z.string().max(100).optional(),
    cursor: z.string().min(1).optional(),
    limit: z.coerce.number().int().positive().max(100).default(SUBSCRIPTION_PAGE_SIZE),
});

export async function GET(req: NextRequest) {
    let ctx: PlatformAdminContext;
    try {
        ctx = await requirePlatformAdmin();
    } catch (error) {
        if (error instanceof PlatformAdminDeniedError) return platformAdminForbiddenResponse(error);
        throw error;
    }
    const sp = req.nextUrl.searchParams;
    const parsed = querySchema.safeParse({
        status: sp.get("status") || undefined,
        q: sp.get("q") || undefined,
        cursor: sp.get("cursor") || undefined,
        limit: sp.get("limit") || undefined,
    });
    if (!parsed.success) {
        return NextResponse.json({ error: "INVALID_QUERY", message: "معطيات البحث غير صالحة." }, { status: 400 });
    }
    try {
        const page = await listSubscriptions(ctx, {
            status: parsed.data.status,
            q: parsed.data.q,
            cursor: parsed.data.cursor,
            limit: parsed.data.limit,
        });
        return NextResponse.json(page);
    } catch (error) {
        if (error instanceof InvalidSubscriptionCursorError) {
            return NextResponse.json({ error: "INVALID_CURSOR", message: error.message }, { status: 400 });
        }
        console.error("[admin/subscriptions] list failed:", error);
        return NextResponse.json({ error: "SERVER_ERROR", message: "حدث خطأ أثناء جلب الطلبات." }, { status: 500 });
    }
}
