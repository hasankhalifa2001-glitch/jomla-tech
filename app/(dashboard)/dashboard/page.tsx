import { DashboardAnalyticsClient } from "@/components/dashboard/analytics-client";

/**
 * T4h — /dashboard
 *
 * Thin server wrapper, matching app/(dashboard)/inventory/page.tsx and
 * app/(dashboard)/dashboard/sales-log/page.tsx: the screen itself is a client
 * component (it owns the 7/30-day toggle, the two Top-5 sort toggles, loading
 * and empty states), while this file only pins the route.
 *
 * [ROLE] Not gated here. /dashboard (analytics & KPIs) is ADMIN-only per the
 * existing "dashboard:analytics" row in T1/T2b's Role Capability Matrix, and a
 * CASHIER's browser is already bounced to /pos by middleware.ts before this
 * file ever renders. The real boundary for the DATA is independent of both:
 * GET /api/analytics calls assertRolePermission("dashboard:analytics") before
 * it reads a single row, so a CASHIER calling the endpoint directly gets a
 * 403 with no financial figure in it.
 */
export default function DashboardPage() {
    return <DashboardAnalyticsClient />;
}
