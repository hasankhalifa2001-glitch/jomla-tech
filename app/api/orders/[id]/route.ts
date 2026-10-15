/**
 * T5b — GET /api/orders/[id]
 *
 * Detail for one tenant order: retailer info, lines (frozen price, requested
 * qty, live availability warning), platform signal, other-pending count.
 * ADMIN-only (D18): suggested + candidate customers; CASHIER payload omits
 * them (and the gateway is not even asked to load them). Reviewer is a name
 * only. No cost / batch / baseUnitId / passwordHash. Unknown or other-tenant
 * id → 404, never another tenant's data.
 */
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getTenantDb } from "@/lib/db/tenant-scope";
import { assertRolePermission, ForbiddenRoleError } from "@/lib/auth/role-matrix";
import { STORE_ERROR } from "@/lib/config/storefront";
import { getOrderDetail, OrderNotFoundError } from "@/lib/data/orders";
import { normalizeRate } from "@/lib/data/orders-approval";

export const dynamic = "force-dynamic";

export async function GET(
    _req: Request,
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

    const tenantId = session.user.tenantId;
    const isAdmin = session.user.role === "ADMIN";
    const db = getTenantDb(tenantId);
    try {
        const detail = await getOrderDetail(db, tenantId, id, {
            includeCustomers: isAdmin,
        });
        const { matchedCustomer, candidates, ...base } = detail;
        // [T5c — additive] ADMIN-only, informational: the tenant's current
        // daily exchange rate so the approval screen can preview a SYP total
        // for USD-priced lines. Read through the SAME tenant-scoped `db`. It is
        // purely a UI preview hint — the server recomputes everything at
        // approval and never trusts this — so a failure here degrades to null
        // rather than failing the whole (already-succeeded) detail read.
        // CASHIER payload is unchanged (field omitted entirely).
        let dailyExchangeRate: string | null = null;
        if (isAdmin) {
            try {
                const tenantRow = await db.tenant.findUnique({
                    where: { id: tenantId },
                    select: { dailyExchangeRate: true },
                });
                dailyExchangeRate = normalizeRate(
                    tenantRow?.dailyExchangeRate != null ? tenantRow.dailyExchangeRate.toString() : null
                );
            } catch {
                dailyExchangeRate = null;
            }
        }
        return NextResponse.json({
            success: true,
            order: {
                ...base,
                createdAt: base.createdAt.toISOString(),
                reviewedAt: base.reviewedAt ? base.reviewedAt.toISOString() : null,
                // D18: customer suggestions are ADMIN-only (double guard).
                matchedCustomer: isAdmin ? matchedCustomer : null,
                candidates: isAdmin ? candidates : [],
                ...(isAdmin ? { dailyExchangeRate } : {}),
            },
        });
    } catch (error) {
        if (error instanceof OrderNotFoundError) {
            return NextResponse.json(
                { code: STORE_ERROR.NOT_FOUND, message: error.message },
                { status: 404 }
            );
        }
        console.error("Error fetching B2B order detail:", error);
        return NextResponse.json(
            { code: STORE_ERROR.INTERNAL_ERROR, message: "حدث خطأ أثناء جلب تفاصيل الطلب." },
            { status: 500 }
        );
    }
}