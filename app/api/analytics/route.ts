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
 * [ACCOUNT STATE] This route trusts auth() to reject a deactivated
 * (isActive: false) user per T2c ("blocks on the very next request"). If
 * auth() does not re-check isActive against the database on every call, that
 * must be fixed centrally there — not patched route by route.
 *
 * [tenant scoping] Every read below goes through getTenantDb(tenantId), the
 * T1 tenant-scope Prisma Client Extension. No raw SQL: this route and
 * lib/data/analytics.ts contain no $queryRaw / tenantScopedRawQuery call —
 * the one sanctioned raw-query site in this codebase remains T4c's batch lock.
 *
 * [query] `?range=1` (today, hourly chart), `?range=7` (default) or
 * `?range=30` — the chart window. The trend,
 * the KPI "today" figures and the product rankings are all derived from that
 * SAME window (lib/data/analytics.ts's WINDOWS contract), so the Top-5 lists
 * re-rank with the range instead of silently disagreeing with the chart.
 * Absent -> 7; any other present value -> 400 (never a silent fallback).
 *
 * [caching] The response is financial data, so it is `private` (never stored
 * by a shared cache/CDN) and kept for at most 30 seconds in the browser to
 * absorb repeated dashboard loads. Consequence: a sale made in the last 30
 * seconds may not appear until then. Set max-age to 0 (or drop the header) if
 * instant freshness matters more than load.
 */

export const dynamic = "force-dynamic";

const CACHE_CONTROL = "private, max-age=30";

const querySchema = z.object({
    range: z
        .enum(["1", "7", "30"])
        .default("7")
        .transform((v): AnalyticsRange => (v === "1" ? 1 : v === "7" ? 7 : 30)),
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

    const parsed = querySchema.safeParse({
        range: new URL(req.url).searchParams.get("range") ?? undefined,
    });

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
            range: parsed.data.range,
            now: new Date(),
        });

        return NextResponse.json(
            { success: true, ...dashboard },
            { headers: { "Cache-Control": CACHE_CONTROL } }
        );
    } catch (error) {
        console.error("Error building analytics dashboard:", error);
        return NextResponse.json(
            { error: "SERVER_ERROR", message: "تعذر تحميل مؤشرات لوحة التحكم." },
            { status: 500 }
        );
    }
}