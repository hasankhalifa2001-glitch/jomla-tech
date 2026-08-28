import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { resolveFifoAllocation } from "@/lib/inventory/fifo";
import { z } from "zod";

const fifoPreviewSchema = z.object({
  productId: z.string().min(1, "معرف المنتج مطلوب"),
  unitId: z.string().min(1, "معرف الوحدة مطلوب"),
  requestedQty: z.number().positive("الكمية المطلوبة يجب أن تكون أكبر من الصفر"),
});

export async function POST(req: Request) {
  try {
    const session = await auth();
    if (!session || !session.user || !session.user.tenantId) {
      return NextResponse.json({ error: "UNAUTHORIZED", message: "يرجى تسجيل الدخول أولاً." }, { status: 401 });
    }

    const tenantId = session.user.tenantId;
    const body = await req.json();
    const validation = fifoPreviewSchema.safeParse(body);

    if (!validation.success) {
      return NextResponse.json(
        {
          error: "VALIDATION_ERROR",
          message: validation.error.issues[0]?.message || "بيانات طلب المعاينة غير صالحة.",
        },
        { status: 400 }
      );
    }

    const { productId, unitId, requestedQty } = validation.data;

    const resolution = await resolveFifoAllocation(prisma, {
      tenantId,
      productId,
      unitId,
      requestedQty,
    });

    return NextResponse.json({
      success: true,
      resolution,
    });
  } catch (error: any) {
    console.error("Error running FIFO preview:", error);
    return NextResponse.json(
      { error: "SERVER_ERROR", message: error.message || "حدث خطأ أثناء معاينة سحب المخزون." },
      { status: 500 }
    );
  }
}
