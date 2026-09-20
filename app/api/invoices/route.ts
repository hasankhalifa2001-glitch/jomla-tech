import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { InvoiceStatus } from "@prisma/client";
import { auth } from "@/auth";
import { getTenantDb } from "@/lib/db/tenant-scope";
import {
    assertRolePermission,
    ForbiddenRoleError,
    forbiddenRoleResponse,
} from "@/lib/auth/role-matrix";
import { listInvoicesForTenant, type PaymentStatusBadge } from "@/lib/data/invoices";

/**
 * T4c2 — GET /api/invoices
 *
 * Distinct from the already-existing POST /api/invoices/void (T4d) — this
 * is a new, read-only, tenant-wide listing route. Read-only: does NOT call
 * assertTenantWritable(), since a PENDING/EXPIRED tenant is locked out of
 * WRITES (T2b's API-mutation layer), not reads — a merchant mid-renewal
 * should still be able to see what they already sold.
 *
 * [ROLE SCOPING — done BEFORE the Prisma query is built, never after]
 * Per T2b's Role Capability Matrix extension for T4c2:
 *   - CASHIER: "view own invoices" (full read-only) / "view other staff's
 *     invoices" (not permitted).
 *   - ADMIN: full read-only across all staff, with a staff filter.
 * A CASHIER session's own userId always wins here, regardless of what the
 * client sent in `?userId=` — the query param is discarded outright for a
 * CASHIER, never merely validated-then-trusted.
 *
 * [paymentStatus filter — NEW] Has no DB column: CASH_FULL/CREDIT_FULL/
 * PARTIAL is derived by comparing paidAmountSYP against totalSYP, and
 * Prisma cannot express a field-to-field comparison in `where` without
 * raw SQL — which T1 restricts to one sanctioned call site elsewhere in
 * the codebase (T4c's batch lock). listInvoicesForTenant() handles this
 * by scanning DB pages in application code until a full result page is
 * assembled or the table is exhausted (see lib/data/invoices.ts for the
 * full rationale and the scan-cap safety valve). This route only
 * validates and forwards the value — no filtering logic lives here.
 *
 * [KNOWN SIMPLIFICATION — flagged, not yet resolved] "Today" (the default
 * date range when `from`/`to` are omitted) is computed in UTC day
 * boundaries, since Tenant carries no timezone field in schema.prisma.
 * For Syria (UTC+3) this can misalign the "today" boundary by a few hours
 * around midnight. Not addressed here — the frontend is expected to always
 * send explicit `from`/`to` (computed in the browser's local timezone) for
 * anything other than a quick default load; this fallback exists only so
 * the endpoint has sane behavior when called with no date params at all.
 */

export const dynamic = "force-dynamic";

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 25;

const querySchema = z.object({
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    status: z.enum(["COMPLETED", "PENDING_REVIEW", "VOIDED", "ALL"]).default("ALL"),
    // [NEW]
    paymentStatus: z.enum(["CASH_FULL", "CREDIT_FULL", "PARTIAL"]).optional(),
    userId: z.string().min(1).optional(),
    cursor: z.string().min(1).optional(),
    limit: z.coerce.number().int().positive().max(MAX_LIMIT).default(DEFAULT_LIMIT),
});

function defaultTodayRangeUTC(): { from: Date; to: Date } {
    const now = new Date();
    const from = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0)
    );
    const to = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999)
    );
    return { from, to };
}

export async function GET(req: NextRequest) {
    const session = await auth();
    if (!session?.user?.tenantId || !session.user.id) {
        return NextResponse.json(
            { error: "UNAUTHORIZED", message: "يرجى تسجيل الدخول أولاً." },
            { status: 401 }
        );
    }

    const { searchParams } = new URL(req.url);
    const parsed = querySchema.safeParse(Object.fromEntries(searchParams));
    if (!parsed.success) {
        return NextResponse.json(
            {
                error: "VALIDATION_ERROR",
                message: "معطيات الفلترة غير صالحة.",
                details: parsed.error.flatten(),
            },
            { status: 400 }
        );
    }

    const tenantId = session.user.tenantId;
    const db = getTenantDb(tenantId);

    let { userId } = parsed.data;
    const { from, to, status, paymentStatus, cursor, limit } = parsed.data;

    if (session.user.role === "CASHIER") {
        // Discarded, never merely validated — see file-header note.
        userId = session.user.id;
    } else if (userId) {
        try {
            assertRolePermission(session.user.role, "sales_log:view_all_staff");
        } catch (error) {
            if (error instanceof ForbiddenRoleError) return forbiddenRoleResponse(error);
            throw error;
        }
    }

    const { from: defaultFrom, to: defaultTo } = defaultTodayRangeUTC();

    try {
        const result = await listInvoicesForTenant(db, tenantId, {
            from: from ?? defaultFrom,
            to: to ?? defaultTo,
            status: status === "ALL" ? undefined : (status as InvoiceStatus),
            paymentStatus: paymentStatus as PaymentStatusBadge | undefined,
            userId,
            cursor,
            limit,
        });

        return NextResponse.json({ success: true, ...result });
    } catch (error) {
        console.error("Error listing invoices:", error);
        return NextResponse.json(
            { error: "SERVER_ERROR", message: "حدث خطأ أثناء جلب سجل الفواتير." },
            { status: 500 }
        );
    }
}