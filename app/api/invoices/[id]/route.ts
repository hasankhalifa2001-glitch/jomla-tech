import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getTenantDb } from "@/lib/db/tenant-scope";
import { findInvoiceDetail, canSessionUserAccessInvoice } from "@/lib/data/invoices";

/**
 * T4c2 — GET /api/invoices/[id]
 *
 * Read-only detail view, listing every InvoiceItem on the invoice
 * (product, unit, quantity, price). The single place in the system this
 * level of per-line detail is shown outside T4f's printed/shared receipt.
 *
 * [CORRECTED — stale cross-reference] This used to describe T4d's void
 * endpoint as "POST /api/invoices/void". No such route exists (or ever
 * did) — T4d's implementation is POST /api/ledger/voids, see
 * app/api/ledger/voids/route.ts. T4c2's UI void button calls that real
 * route.
 *
 * [SECURITY — deliberately re-checked here, not just at the list level]
 * A CASHIER's list request (GET /api/invoices) is already scoped
 * server-side to their own userId, but that scoping says nothing about
 * a CASHIER opening an invoice id directly (typed/guessed/shared link) —
 * this route re-derives and re-checks ownership independently, exactly
 * the same defensive posture lib/data/products.ts's
 * assertProductBelongsToTenant() takes for tenant scoping (never rely
 * solely on an upstream filter having already excluded the row).
 *
 * [Next 16 — params is a Promise] `params` MUST be awaited. The generated
 * route-type validator (.next/types/validator.ts's RouteHandlerConfig)
 * types a handler's second argument as `{ params: Promise<ParamMap[Route]> }`,
 * so the old synchronous `{ params: { id: string } }` shape fails
 * `next build`'s type-check. Same convention as
 * app/api/orders/[id]/status/route.ts.
 */

export async function GET(
    _req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;
    const session = await auth();
    if (!session?.user?.tenantId || !session.user.id) {
        return NextResponse.json(
            { error: "UNAUTHORIZED", message: "يرجى تسجيل الدخول أولاً." },
            { status: 401 }
        );
    }

    const tenantId = session.user.tenantId;
    const db = getTenantDb(tenantId);

    try {
        const invoice = await findInvoiceDetail(db, tenantId, id);

        if (!invoice) {
            return NextResponse.json(
                { error: "NOT_FOUND", message: "الفاتورة غير موجودة." },
                { status: 404 }
            );
        }

        // [FIX — real bug] A void row's own `userId` is always the
        // voiding ADMIN (T4d), never the original seller — so checking
        // only `invoice.userId` here made a void unreachable for the
        // very cashier whose own sale it reverses, breaking T4c2's
        // "navigable from either side" cross-link guarantee.
        // Uses shared canSessionUserAccessInvoice helper.
        if (!canSessionUserAccessInvoice(session.user, invoice)) {
            return NextResponse.json(
                { error: "FORBIDDEN", message: "لا يمكنك عرض فاتورة موظف آخر." },
                { status: 403 }
            );
        }

        return NextResponse.json({ success: true, invoice });
    } catch (error) {
        console.error("Error fetching invoice detail:", error);
        return NextResponse.json(
            { error: "SERVER_ERROR", message: "حدث خطأ أثناء جلب تفاصيل الفاتورة." },
            { status: 500 }
        );
    }
}