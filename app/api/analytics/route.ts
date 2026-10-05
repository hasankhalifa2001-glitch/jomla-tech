import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { getTenantDb } from "@/lib/db/tenant-scope";
import {
    assertRolePermission,
    ForbiddenRoleError,
    forbiddenRoleResponse,
} from "@/lib/auth/role-matrix";
import { getAnalyticsDashboard, type AnalyticsRange } from "@/lib/data/analytics";

/**
 * T4h — GET /api/analytics
 *
 * Backs /dashboard's KPI cards, the sales/profit trend, the two Top-5 product
 * lists and the actionable alerts.
 *
 * READ-ONLY: does NOT call assertTenantWritable() — a PENDING/EXPIRED tenant
 * is locked out of WRITES (T2b's API-mutation layer), not reads, exactly as
 * app/api/invoices/route.ts states for the same reason.
 *
 * [ROLE — checked BEFORE any data is read, never after]
 * The very first thing this handler does after resolving the session is
 * `assertRolePermission(session.user.role, "dashboard:analytics")` against
 * T1/T2b's Role Capability Matrix (`dashboard:analytics`: ADMIN true,
 * CASHIER false — an existing row, unchanged by this task). A CASHIER hitting
 * this endpoint directly therefore gets a generic 403 and NO figure is ever
 * computed or serialized for them: the rejection happens before the data layer
 * is called, so there is no code path in which a sensitive financial number
 * could leak into a 403 body.
 *
 * The PAGE is a second, independent layer: middleware.ts already redirects a
 * CASHIER's browser from /dashboard to /pos (see its CASHIER default-landing
 * block). Neither layer is a substitute for the other — middleware is a
 * browser convenience, this check is the security boundary.
 *
 * [tenant scoping] Every read below goes through getTenantDb(tenantId), the
 * T1 tenant-scope Prisma Client Extension. No raw SQL: this route and
 * lib/data/analytics.ts contain no $queryRaw / tenantScopedRawQuery call —
 * the one sanctioned raw-query site in this codebase remains T4c's batch lock.
 *
 * [query] `?range=7` (default) or `?range=30` — the chart window. The trend,
 * the KPI "today" figures and the product rankings are all derived from that
 * SAME window (lib/data/analytics.ts's WINDOWS contract), so the Top-5 lists
 * re-rank with the range instead of silently disagreeing with the chart.
 */

export const dynamic = "force-dynamic";

const querySchema = z.object({
    // `?range` is optional (defaults to 7) — the default is applied when the
    // param is ABSENT, before coercion; a present-but-unsupported value is a
    // 400 rather than a silent fallback.
    range: z.coerce.number().refine((v) => v === 7 || v === 30, {
        message: "range must be 7 or 30.",
    }),
});

export async function GET(req: NextRequest) {
    const session = await auth();
    if (!session?.user?.tenantId || !session.user.id) {
        return NextResponse.json(
            { error: "UNAUTHORIZED", message: "يرجى تسجيل الدخول أولاً." },
            { status: 401 }
        );
    }

    // BEFORE any Prisma read, any aggregation, and any response body — see the
    // file header. A CASHIER never reaches getAnalyticsDashboard().
    try {
        assertRolePermission(session.user.role, "dashboard:analytics");
    } catch (error) {
        if (error instanceof ForbiddenRoleError) return forbiddenRoleResponse(error);
        throw error;
    }

    const { searchParams } = new URL(req.url);
    const params = Object.fromEntries(searchParams);
    if (params.range === undefined) params.range = "7";
    const parsed = querySchema.safeParse(params);

    if (!parsed.success) {
        return NextResponse.json(
            {
                error: "VALIDATION_ERROR",
                message: "معطيات لوحة التحليلات غير صالحة.",
            },
            { status: 400 }
        );
    }

    const tenantId = session.user.tenantId;
    const db = getTenantDb(tenantId);

    try {
        const dashboard = await getAnalyticsDashboard(db, tenantId, {
            range: parsed.data.range as AnalyticsRange,
            now: new Date(),
        });

        return NextResponse.json({ success: true, ...dashboard });
    } catch (error) {
        console.error("Error building analytics dashboard:", error);
        return NextResponse.json(
            { error: "SERVER_ERROR", message: "تعذر تحميل مؤشرات لوحة التحكم." },
            { status: 500 }
        );
    }
}
