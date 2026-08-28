import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await auth();
    if (!session || !session.user || !session.user.tenantId) {
      return NextResponse.json({ error: "UNAUTHORIZED", message: "يرجى تسجيل الدخول أولاً." }, { status: 401 });
    }

    // ADMIN-only: what's visible on the public storefront is a
    // merchandising/marketing decision, not a routine cashier task.
    if (session.user.role !== "ADMIN") {
      return NextResponse.json(
        { error: "FORBIDDEN", message: "تعديل عرض المنتج في المتجر متاح لمدير المتجر فقط." },
        { status: 403 }
      );
    }

    if (session.user.subscriptionStatus === "EXPIRED" || session.user.subscriptionStatus === "PENDING") {
      return NextResponse.json(
        { error: "SUBSCRIPTION_LOCKED", message: "اشتراكك منتهي أو معلق. لا يمكنك تعديل المنتجات." },
        { status: 403 }
      );
    }

    const { id } = await params;
    const tenantId = session.user.tenantId;

    const existingProduct = await prisma.product.findFirst({
      where: {
        id,
        tenantId,
      },
    });

    if (!existingProduct) {
      return NextResponse.json({ error: "NOT_FOUND", message: "المنتج غير موجود." }, { status: 404 });
    }

    const updated = await prisma.product.update({
      where: { id },
      data: {
        isPublic: !existingProduct.isPublic,
      },
    });

    return NextResponse.json({
      success: true,
      isPublic: updated.isPublic,
      message: updated.isPublic ? "تم نشر المنتج في متجر العملاء." : "تم إخفاء المنتج من متجر العملاء.",
    });
  } catch (error) {
    console.error("Error toggling product storefront status:", error);
    return NextResponse.json({ error: "SERVER_ERROR", message: "حدث خطأ أثناء تعديل حالة المنتج." }, { status: 500 });
  }
}