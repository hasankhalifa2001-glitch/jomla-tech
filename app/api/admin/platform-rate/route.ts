/**
 * T6b Phase 1 — /api/admin/platform-rate (GET + PUT)
 *
 * Super-Admin only (fresh-DB check, never JWT). Reads/writes the
 * platform-internal tenant's dailyExchangeRate via the typed platform
 * gateway. Billing error shape { error, message }.
 *
 * PUT body: { rate: Decimal string (<=4 dp, > 0, <= PLATFORM_RATE_MAX),
 *             confirm?: boolean }.
 * A >25% move vs the current value requires { confirm: true }, otherwise
 * 409 CONFIRM_REQUIRED.
 */
import { NextResponse } from "next/server";
import {
    requirePlatformAdmin,
    platformAdminForbiddenResponse,
    PlatformAdminDeniedError,
    type PlatformAdminContext,
} from "@/lib/auth/platform-admin";
import {
    getPlatformRate,
    setPlatformRate,
    InvalidPlatformRateError,
    PlatformRateConfirmRequiredError,
    PlatformTenantNotFoundError,
} from "@/lib/data/platform-admin";

export const dynamic = "force-dynamic";

export async function GET() {
    let ctx: PlatformAdminContext;
    try {
        ctx = await requirePlatformAdmin();
    } catch (error) {
        if (error instanceof PlatformAdminDeniedError) {
            return platformAdminForbiddenResponse(error);
        }
        throw error;
    }
    try {
        const view = await getPlatformRate(ctx);
        return NextResponse.json({
            rate: view.rate,
            updatedAt: view.updatedAt,
            rateAvailable: view.rate != null,
        });
    } catch (error) {
        if (error instanceof PlatformTenantNotFoundError) {
            return NextResponse.json(
                { error: "NOT_FOUND", message: "مستأجر المنصة الداخلي غير موجود." },
                { status: 404 }
            );
        }
        console.error("[admin/platform-rate] GET failed:", error);
        return NextResponse.json(
            { error: "SERVER_ERROR", message: "حدث خطأ أثناء جلب سعر الصرف." },
            { status: 500 }
        );
    }
}

export async function PUT(req: Request) {
    let ctx: PlatformAdminContext;
    try {
        ctx = await requirePlatformAdmin();
    } catch (error) {
        if (error instanceof PlatformAdminDeniedError) {
            return platformAdminForbiddenResponse(error);
        }
        throw error;
    }
    let body: unknown;
    try {
        body = await req.json();
    } catch {
        return NextResponse.json(
            { error: "INVALID_BODY", message: "نص الطلب غير صالح." },
            { status: 400 }
        );
    }
    const rate = (body as { rate?: unknown } | null)?.rate;
    const confirm = (body as { confirm?: unknown } | null)?.confirm;
    try {
        const view = await setPlatformRate(ctx, { rate, confirm });
        return NextResponse.json({
            rate: view.rate,
            updatedAt: view.updatedAt,
            rateAvailable: view.rate != null,
            message: "تم تحديث سعر صرف المنصة بنجاح.",
        });
    } catch (error) {
        if (error instanceof InvalidPlatformRateError) {
            return NextResponse.json(
                { error: "INVALID_RATE", message: error.message },
                { status: 400 }
            );
        }
        if (error instanceof PlatformRateConfirmRequiredError) {
            return NextResponse.json(
                {
                    error: "CONFIRM_REQUIRED",
                    message: error.message,
                    currentRate: error.currentRate,
                    newRate: error.newRate,
                },
                { status: 409 }
            );
        }
        if (error instanceof PlatformTenantNotFoundError) {
            return NextResponse.json(
                { error: "NOT_FOUND", message: "مستأجر المنصة الداخلي غير موجود." },
                { status: 404 }
            );
        }
        console.error("[admin/platform-rate] PUT failed:", error);
        return NextResponse.json(
            { error: "SERVER_ERROR", message: "حدث خطأ أثناء تحديث سعر الصرف." },
            { status: 500 }
        );
    }
}