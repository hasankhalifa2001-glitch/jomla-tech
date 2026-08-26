import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { z } from "zod";

const updateRateSchema = z.object({
    rate: z.number().positive("يجب أن يكون سعر الصرف رقماً موجباً"),
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

        if (session.user.subscriptionStatus === "EXPIRED") {
            return NextResponse.json(
                {
                    error: "SUBSCRIPTION_EXPIRED",
                    message: "عذراً، اشتراك هذا المتجر منتهي. يرجى تجديد الاشتراك للقيام بالتعديلات.",
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
