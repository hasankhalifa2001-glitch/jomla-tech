/**
 * T6b Phase 3 — POST /api/admin/catalog-reports/[id]/resolve
 *
 * Super-Admin only. Conditional updateMany WHERE status = 'PENDING'; count 0
 * -> read the row to distinguish 404 from 409. Body { apply? }; when true,
 * applies only the non-null suggested fields to the ProductCatalogEntry via a
 * top-level update. Error shape { code, message } using STORE_ERROR constants.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import {
    requirePlatformAdmin,
    PlatformAdminDeniedError,
    type PlatformAdminContext,
} from "@/lib/auth/platform-admin";
import {
    resolveCatalogReport,
    CatalogReportAlreadyProcessedError,
    CatalogReportNotFoundError,
} from "@/lib/data/platform-admin";
import { STORE_ERROR } from "@/lib/config/storefront";

export const dynamic = "force-dynamic";

const bodySchema = z
    .object({
        apply: z.boolean().optional(),
    })
    .strict();

export async function POST(
    req: Request,
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

    const raw = await req.json().catch(() => null);
    const body = bodySchema.safeParse(raw);
    if (!body.success) {
        return NextResponse.json(
            { code: STORE_ERROR.VALIDATION_ERROR, message: "بيانات المعالجة غير صالحة." },
            { status: 400 }
        );
    }

    try {
        await resolveCatalogReport(ctx, id, {
            apply: body.data.apply ?? false,
            now: new Date(),
        });
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
        console.error("[admin/catalog-reports/resolve] failed:", error);
        return NextResponse.json(
            { code: STORE_ERROR.INTERNAL_ERROR, message: "حدث خطأ أثناء معالجة البلاغ." },
            { status: 500 }
        );
    }
}
