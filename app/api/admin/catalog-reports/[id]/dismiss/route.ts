/**
 * T6b Phase 3 — POST /api/admin/catalog-reports/[id]/dismiss
 *
 * Super-Admin only. Conditional updateMany WHERE status = 'PENDING'; count 0
 * -> read the row to distinguish 404 from 409. The ProductCatalogEntry is
 * never touched. Error shape { code, message } using STORE_ERROR constants.
 */
import { NextResponse } from "next/server";
import {
    requirePlatformAdmin,
    PlatformAdminDeniedError,
    type PlatformAdminContext,
} from "@/lib/auth/platform-admin";
import {
    dismissCatalogReport,
    CatalogReportAlreadyProcessedError,
    CatalogReportNotFoundError,
} from "@/lib/data/platform-admin";
import { STORE_ERROR } from "@/lib/config/storefront";

export const dynamic = "force-dynamic";

export async function POST(
    _req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;
    let ctx: PlatformAdminContext;
    try {
        ctx = await requirePlatformAdmin();
    } catch (error) {
        if (error instanceof PlatformAdminDeniedError) {
            return NextResponse.json(
                { code: STORE_ERROR.FORBIDDEN, message: error.message },
                { status: 403 }
            );
        }
        throw error;
    }

    try {
        await dismissCatalogReport(ctx, id, { now: new Date() });
        return NextResponse.json({ success: true });
    } catch (error) {
        if (error instanceof CatalogReportNotFoundError) {
            return NextResponse.json(
                { code: STORE_ERROR.NOT_FOUND, message: error.message },
                { status: 404 }
            );
        }
        if (error instanceof CatalogReportAlreadyProcessedError) {
            return NextResponse.json(
                { code: STORE_ERROR.ALREADY_REVIEWED, message: error.message },
                { status: 409 }
            );
        }
        console.error("[admin/catalog-reports/dismiss] failed:", error);
        return NextResponse.json(
            { code: STORE_ERROR.INTERNAL_ERROR, message: "حدث خطأ أثناء رفض البلاغ." },
            { status: 500 }
        );
    }
}
