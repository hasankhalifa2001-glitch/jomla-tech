import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getFreshTenantStatus } from "@/lib/auth/tenant";

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

        const subscriptionStatus = await getFreshTenantStatus(session.user.tenantId);

        if (!subscriptionStatus) {
            return NextResponse.json(
                { error: "NOT_FOUND", message: "لم يتم العثور على بيانات المتجر." },
                { status: 404 }
            );
        }

        return NextResponse.json({
            success: true,
            subscriptionStatus,
        });
    } catch (error) {
        console.error("Error fetching tenant status:", error);
        return NextResponse.json(
            { error: "SERVER_ERROR", message: "حدث خطأ غير متوقع أثناء جلب حالة الاشتراك." },
            { status: 500 }
        );
    }
}