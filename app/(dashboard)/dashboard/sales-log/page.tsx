import { SalesLogClient } from "@/components/sales-log/sales-log-client";

/**
 * T4c2 — /dashboard/sales-log
 *
 * Thin server wrapper, matching app/(dashboard)/inventory/page.tsx's
 * convention: the screen itself is a client component (it needs the
 * session's role to decide which CONTROLS exist, cursor pagination, and the
 * filter state), while this file only pins the route.
 *
 * Not gated here by role: both ADMIN and CASHIER may open this screen (T2b's
 * Role Capability Matrix row for T4c2 — "view own invoices" is permitted for
 * both), and the CASHIER's narrower scope is enforced server-side in
 * GET /api/invoices, never by hiding the route.
 */
export default function SalesLogPage() {
    return <SalesLogClient />;
}
