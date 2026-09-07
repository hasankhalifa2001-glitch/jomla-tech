import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getTenantDb } from "@/lib/db";
import {
    assertTenantWritable,
    SubscriptionLockedError,
    subscriptionLockedResponse,
} from "@/lib/auth/tenant";
import {
    assertAdmin,
    ForbiddenRoleError,
    forbiddenRoleResponse,
} from "@/lib/auth/role-matrix";
import { z } from "zod";

const updateRateSchema = z.object({
    rate: z
        .number()
        .positive("يجب أن يكون سعر الصرف رقماً موجباً")
        // Sanity ceiling against a data-entry slip (e.g. cashier types 15
        // instead of 15000) — not a hard business limit, just a guard
        // against an obviously wrong value being saved silently.
        .max(1_000_000, "القيمة أكبر من المتوقع، يرجى التأكد من الرقم المدخل"),
});

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
            select: { dailyExchangeRate: true },
        });

        return NextResponse.json({
            success: true,
            dailyExchangeRate: tenant?.dailyExchangeRate != null ? Number(tenant.dailyExchangeRate) : null,
        });
    } catch (error) {
        console.error("Error fetching exchange rate:", error);
        return NextResponse.json(
            { error: "SERVER_ERROR", message: "حدث خطأ غير متوقع أثناء جلب سعر الصرف." },
            { status: 500 }
        );
    }
}

export async function POST(req: Request) {
    try {
        const session = await auth();

        if (!session || !session.user || !session.user.tenantId) {
            return NextResponse.json(
                { error: "UNAUTHORIZED", message: "يرجى تسجيل الدخول أولاً." },
                { status: 401 }
            );
        }

        // Admin-only per Role Capability Matrix: the daily exchange rate affects every invoice
        // tenant-wide, so it must never be editable by a CASHIER session.
        assertAdmin(session.user.role, "settings:manage");

        // Security boundary: check fresh subscriptionStatus directly from DB within request.
        await assertTenantWritable(session.user.tenantId);

        const body = await req.json();
        const validation = updateRateSchema.safeParse(body);

        if (!validation.success) {
            return NextResponse.json(
                {
                    error: "VALIDATION_ERROR",
                    message: validation.error.issues[0]?.message || "بيانات سعر الصرف غير صالحة.",
                },
                { status: 400 }
            );
        }

        const { rate } = validation.data;

        // Scoped by tenantId from the session, never trusting any tenant
        // identifier from the request body — the same rule that applies to
        // every write endpoint in this codebase.
        const db = getTenantDb(session.user.tenantId);
        const updatedTenant = await db.tenant.update({
            where: { id: session.user.tenantId },
            data: { dailyExchangeRate: rate },
        });

        return NextResponse.json({
            success: true,
            dailyExchangeRate: Number(updatedTenant.dailyExchangeRate),
            message: "تم تحديث سعر الصرف اليومي بنجاح.",
        });
    } catch (error) {
        if (error instanceof ForbiddenRoleError) {
            return forbiddenRoleResponse(error);
        }
        if (error instanceof SubscriptionLockedError) {
            return subscriptionLockedResponse(error);
        }
        console.error("Error updating exchange rate:", error);
        return NextResponse.json(
            { error: "SERVER_ERROR", message: "حدث خطأ غير متوقع أثناء تحديث سعر الصرف." },
            { status: 500 }
        );
    }
}
