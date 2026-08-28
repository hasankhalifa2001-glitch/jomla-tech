import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { z } from "zod";

const createBatchSchema = z.object({
  productId: z.string().min(1, "معرف المنتج مطلوب"),
  unitId: z.string().min(1, "معرف الوحدة مطلوب"),
  batchNumber: z.string().min(1, "رقم الدفعة مطلوب"),
  quantity: z.number().min(0, "الكمية يجب أن تكون صفر أو أكثر"),
  expiryDate: z.string().optional().nullable(),
});

export async function POST(req: Request) {
  try {
    const session = await auth();
    if (!session || !session.user || !session.user.tenantId) {
      return NextResponse.json({ error: "UNAUTHORIZED", message: "يرجى تسجيل الدخول أولاً." }, { status: 401 });
    }

    // Both ADMIN and CASHIER may record a received batch — restocking is a
    // routine operational task, unlike catalog/pricing decisions (see
    // products/route.ts, which is ADMIN-only). Any authenticated tenant
    // member reaches this far; no further role narrowing needed here.

    if (session.user.subscriptionStatus === "EXPIRED" || session.user.subscriptionStatus === "PENDING") {
      return NextResponse.json(
        { error: "SUBSCRIPTION_LOCKED", message: "اشتراكك منتهي أو معلق. لا يمكنك إضافة دفعات جديدة." },
        { status: 403 }
      );
    }

    const tenantId = session.user.tenantId;
    const body = await req.json();
    const validation = createBatchSchema.safeParse(body);

    if (!validation.success) {
      return NextResponse.json(
        {
          error: "VALIDATION_ERROR",
          message: validation.error.issues[0]?.message || "بيانات الدفعة غير صالحة.",
        },
        { status: 400 }
      );
    }

    const { productId, unitId, batchNumber, quantity, expiryDate } = validation.data;

    // Verify product & unit belong to tenant
    const productUnit = await prisma.productUnit.findFirst({
      where: {
        id: unitId,
        productId,
        tenantId,
      },
    });

    if (!productUnit) {
      return NextResponse.json({ error: "NOT_FOUND", message: "المنتج أو الوحدة المحددة غير موجودة." }, { status: 404 });
    }

    const batch = await prisma.productBatch.create({
      data: {
        tenantId,
        productId,
        unitId,
        batchNumber,
        quantity,
        expiryDate: expiryDate ? new Date(expiryDate) : null,
      },
      include: {
        unit: true,
      },
    });

    return NextResponse.json({
      success: true,
      batch,
      message: "تمت إضافة الدفعة الجديدة بنجاح.",
    });
  } catch (error) {
    console.error("Error creating batch:", error);
    return NextResponse.json({ error: "SERVER_ERROR", message: "حدث خطأ أثناء إضافة الدفعة." }, { status: 500 });
  }
}