/**
 * T6b Phase 3 — GET /api/admin/catalog-reports
 *
 * Super-Admin only (fresh-DB check via requirePlatformAdmin, never the JWT).
 * Lists ProductCatalogEntryReport (default PENDING) with the current entry
 * beside the suggested name/category/image. Cursor pagination
 * (createdAt desc, id desc); bad cursor -> 400 INVALID_CURSOR. Error shape
 * { code, message } using STORE_ERROR constants.
 */
import { NextResponse } from "next/server";
import {
    requirePlatformAdmin,
    PlatformAdminDeniedError,
    type PlatformAdminContext,
} from "@/lib/auth/platform-admin";
import {
    listCatalogReports,
    InvalidSubscriptionCursorError,
} from "@/lib/data/platform-admin";
import { STORE_ERROR } from "@/lib/config/storefront";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
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
    const sp = new URL(req.url).searchParams;
    const status = sp.get("status") || undefined;
    const cursor = sp.get("cursor") || undefined;
    const limit = sp.get("limit") || undefined;
    try {
        const page = await listCatalogReports(ctx, {
            status,
            cursor,
            limit: limit == null ? undefined : Number(limit),
        });
        return NextResponse.json(page);
    } catch (error) {
        if (error instanceof InvalidSubscriptionCursorError) {
            return NextResponse.json(
                { code: STORE_ERROR.VALIDATION_ERROR, message: error.message },
                { status: 400 }
            );
        }
        console.error("[admin/catalog-reports] list failed:", error);
        return NextResponse.json(
            { code: STORE_ERROR.INTERNAL_ERROR, message: "حدث خطأ أثناء جلب بلاغات الكتالوج." },
            { status: 500 }
        );
    }
}
