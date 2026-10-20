import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getTenantDb } from "@/lib/db/tenant-scope";
import { getEffectiveTenantStatus } from "@/lib/subscription/effective-status";
import {
  SUBSCRIPTION_GRACE_DAYS,
  SUBSCRIPTION_RENEWAL_WARNING_DAYS,
} from "@/lib/config/subscription";

// ============================================================================
// Read-only tenant status endpoint.
//
// Used by components/dashboard/subscription-banner.tsx to render the renewal
// warning / grace / locked banners off the EFFECTIVE status (not the raw
// stored value), and to detect a subscriptionStatus change that hasn't
// propagated to the session yet — a Super-Admin approval elsewhere (T6)
// updates the Tenant row directly, but never pushes to an already-issued
// JWT session on its own. This route lets the client poll (while PENDING)
// or manually re-check, then sync the session via next-auth's update() if
// the live value differs.
//
// GET only, no write. Available to any authenticated user of the tenant
// (ADMIN or CASHIER) — the banner itself is shown to both roles, so this is
// deliberately NOT role-gated and NOT subject to the SUBSCRIPTION_LOCKED
// check that write endpoints apply. On the T6c lockout-exemption list.
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

        const db = getTenantDb(session.user.tenantId);
        const tenant = await db.tenant.findUnique({
            where: { id: session.user.tenantId },
            select: { subscriptionStatus: true, expiresAt: true },
        });

        if (!tenant) {
            return NextResponse.json(
                { error: "NOT_FOUND", message: "لم يتم العثور على بيانات المتجر." },
                { status: 404 }
            );
        }

        const effective = getEffectiveTenantStatus(
            { subscriptionStatus: tenant.subscriptionStatus, expiresAt: tenant.expiresAt },
            new Date()
        );

        return NextResponse.json({
            success: true,
            // Raw stored value (kept for the session-sync path).
            subscriptionStatus: tenant.subscriptionStatus,
            // [T6c] Effective status the banner renders from.
            status: effective.status,
            writable: effective.writable,
            daysLeft: effective.daysLeft,
            graceDaysLeft: effective.graceDaysLeft,
            expiresAt: tenant.expiresAt ? tenant.expiresAt.toISOString() : null,
            lockAt: effective.lockAt ? effective.lockAt.toISOString() : null,
            graceDays: SUBSCRIPTION_GRACE_DAYS,
            renewalWarningDays: SUBSCRIPTION_RENEWAL_WARNING_DAYS,
        });
    } catch (error) {
        console.error("Error fetching tenant status:", error);
        return NextResponse.json(
            { error: "SERVER_ERROR", message: "حدث خطأ غير متوقع أثناء جلب حالة الاشتراك." },
            { status: 500 }
        );
    }
}