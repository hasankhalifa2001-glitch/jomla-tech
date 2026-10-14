/**
 * T5b — GET /api/orders
 *
 * Admin/cashier queue: tabs PENDING_REVIEW (default) / APPROVED / REJECTED,
 * cursor pagination (createdAt desc, id desc), search by name/shop/phone/
 * order reference. Read-only: no assertTenantWritable. Both ADMIN and
 * CASHIER via orders:view. Error shape { code, message } with Arabic
 * message via STORE_ERROR. Payload has no cost / matchedCustomerId.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { getTenantDb } from "@/lib/db/tenant-scope";
import { assertRolePermission, ForbiddenRoleError } from "@/lib/auth/role-matrix";
import { STORE_ERROR } from "@/lib/config/storefront";
import {
    listOrders,
    InvalidOrderCursorError,
    ORDERS_PAGE_SIZE,
    type OrdersListStatus,
} from "@/lib/data/orders";

export const dynamic = "force-dynamic";

const querySchema = z.object({
    status: z.enum(["PENDING_REVIEW", "APPROVED", "REJECTED"]).default("PENDING_REVIEW"),
    q: z.string().max(100).optional(),
    cursor: z.string().min(1).optional(),
    limit: z.coerce.number().int().positive().max(100).default(ORDERS_PAGE_SIZE),
});

export async function GET(req: NextRequest) {
    const session = await auth();
    if (!session?.user?.tenantId || !session.user.id) {
        return NextResponse.json(
            { code: STORE_ERROR.UNAUTHORIZED, message: "يرجى تسجيل الدخول أولاً." },
            { status: 401 }
        );
    }
    try {
        assertRolePermission(session.user.role, "orders:view");
    } catch (error) {
        if (error instanceof ForbiddenRoleError) {
            return NextResponse.json(
                { code: STORE_ERROR.FORBIDDEN, message: error.message },
                { status: 403 }
            );
        }
        throw error;
    }

    const sp = req.nextUrl.searchParams;
    // Empty params (e.g. "?cursor=") are treated as absent, not as invalid.
    const parsed = querySchema.safeParse({
        status: sp.get("status") || undefined,
        q: sp.get("q") || undefined,
        cursor: sp.get("cursor") || undefined,
        limit: sp.get("limit") || undefined,
    });
    if (!parsed.success) {
        return NextResponse.json(
            { code: STORE_ERROR.VALIDATION_ERROR, message: "معطيات البحث غير صالحة." },
            { status: 400 }
        );
    }

    const tenantId = session.user.tenantId;
    const db = getTenantDb(tenantId);
    try {
        const page = await listOrders(db, tenantId, {
            status: parsed.data.status as OrdersListStatus,
            q: parsed.data.q,
            cursor: parsed.data.cursor,
            limit: parsed.data.limit,
        });
        return NextResponse.json({
            success: true,
            items: page.items.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
            nextCursor: page.nextCursor,
            pendingCount: page.pendingCount,
        });
    } catch (error) {
        if (error instanceof InvalidOrderCursorError) {
            return NextResponse.json(
                { code: STORE_ERROR.VALIDATION_ERROR, message: error.message },
                { status: 400 }
            );
        }
        console.error("Error listing B2B orders:", error);
        return NextResponse.json(
            { code: STORE_ERROR.INTERNAL_ERROR, message: "حدث خطأ أثناء جلب الطلبات." },
            { status: 500 }
        );
    }
}