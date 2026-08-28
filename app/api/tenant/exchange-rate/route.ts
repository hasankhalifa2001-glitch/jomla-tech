import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
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

export async function POST(req: Request) {
    try {
        const session = await auth();

        if (!session || !session.user || !session.user.tenantId) {
            return NextResponse.json(
                { error: "UNAUTHORIZED", message: "يرجى تسجيل الدخول أولاً." },
                { status: 401 }
            );
        }

        // Admin-only: the daily exchange rate affects every invoice a
        // cashier rings up tenant-wide, so it must never be editable by a
        // CASHIER session — this was previously unchecked entirely.
        if (session.user.role !== "ADMIN") {
            return NextResponse.json(
                {
                    error: "FORBIDDEN",
                    message: "هذا الإجراء متاح لمدير المتجر فقط.",
                },
                { status: 403 }
            );
        }

        // Defense in depth: middleware.ts already blocks writes for
        // EXPIRED/PENDING tenants at the edge, but this check must still
        // match it exactly here in case this route is ever reached by a
        // path that bypasses the middleware (a server-to-server call, a
        // future matcher change, etc.). PENDING must be treated identically
        // to EXPIRED everywhere in the codebase — never just one of the two.
        if (
            session.user.subscriptionStatus === "EXPIRED" ||
            session.user.subscriptionStatus === "PENDING"
        ) {
            return NextResponse.json(
                {
                    error: "SUBSCRIPTION_LOCKED",
                    message: "عذراً، اشتراك هذا المتجر غير مفعّل حالياً. يرجى التجديد للقيام بالتعديلات.",
                },
                { status: 403 }
            );
        }

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
        const updatedTenant = await prisma.tenant.update({
            where: { id: session.user.tenantId },
            data: { dailyExchangeRate: rate },
        });

        return NextResponse.json({
            success: true,
            dailyExchangeRate: Number(updatedTenant.dailyExchangeRate),
            message: "تم تحديث سعر الصرف اليومي بنجاح.",
        });
    } catch (error) {
        console.error("Error updating exchange rate:", error);
        return NextResponse.json(
            { error: "SERVER_ERROR", message: "حدث خطأ غير متوقع أثناء تحديث سعر الصرف." },
            { status: 500 }
        );
    }
}