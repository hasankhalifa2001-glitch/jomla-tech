import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getTenantDb } from "@/lib/db";

// ============================================================================
// Read-only tenant status endpoint.
//
// Used by components/dashboard/subscription-banner.tsx to detect a
// subscriptionStatus change that hasn't propagated to the session yet — a
// Super-Admin approval elsewhere (T6) updates the Tenant row directly, but
// never pushes to an already-issued JWT session on its own. This route lets
// the client poll (while PENDING) or manually re-check, then sync the
// session via next-auth's update() if the live value differs.
//
// GET only, no write. Available to any authenticated user of the tenant
// (ADMIN or CASHIER) — the banner itself is shown to both roles, so this is
// deliberately NOT role-gated and NOT subject to the SUBSCRIPTION_LOCKED
// check that write endpoints apply, mirroring middleware.ts's
// READ_ONLY_POST_PREFIXES exemption in spirit (this is a GET, so it was
// never subject to that check to begin with).
// ============================================================================

export async function GET() {
    try {
        const session = await auth();

        if (!session || !session.user || !session.user.tenantId) {
            return NextResponse.json(
                { error: "UNAUTHORIZED", message: "يرجى تسجيل الدخول أولاً." },
                { status: 401 }
            );
        }

        // Note: Tenant is NOT in TENANT_SCOPED_MODELS (lib/db/tenant-scope.ts)
        // — it's the isolation unit itself, not a model scoped to one. The
        // extension applies no automatic filtering here; scoping is done
        // explicitly via `where: { id: session.user.tenantId }`, same pattern
        // as app/api/tenant/exchange-rate/route.ts's GET handler.
        const db = getTenantDb(session.user.tenantId);
        const tenant = await db.tenant.findUnique({
            where: { id: session.user.tenantId },
            select: { subscriptionStatus: true },
        });

        if (!tenant) {
            return NextResponse.json(
                { error: "NOT_FOUND", message: "لم يتم العثور على بيانات المتجر." },
                { status: 404 }
            );
        }

        return NextResponse.json({
            success: true,
            subscriptionStatus: tenant.subscriptionStatus,
        });
    } catch (error) {
        console.error("Error fetching tenant status:", error);
        return NextResponse.json(
            { error: "SERVER_ERROR", message: "حدث خطأ غير متوقع أثناء جلب حالة الاشتراك." },
            { status: 500 }
        );
    }
}