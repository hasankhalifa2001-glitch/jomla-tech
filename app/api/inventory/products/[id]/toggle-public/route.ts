import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getTenantDb } from "@/lib/db/tenant-scope";
import {
  assertTenantWritable,
  SubscriptionLockedError,
  subscriptionLockedResponse,
} from "@/lib/auth/tenant";
import {
  assertRolePermission,
  ForbiddenRoleError,
  forbiddenRoleResponse,
} from "@/lib/auth/role-matrix";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await auth();
    if (!session || !session.user || !session.user.tenantId) {
      return NextResponse.json({ error: "UNAUTHORIZED", message: "يرجى تسجيل الدخول أولاً." }, { status: 401 });
    }

    // Role Capability Matrix: inventory mutation (storefront toggle) is ADMIN-only
    assertRolePermission(session.user.role, "inventory:mutate");

    // Security boundary: check fresh subscription status in DB
    await assertTenantWritable(session.user.tenantId);

    const { id } = await params;
    const tenantId = session.user.tenantId;
    const db = getTenantDb(tenantId);

    const existingProduct = await db.product.findFirst({
      where: {
        id,
      },
      include: {
        units: true,
      },
    });

    if (!existingProduct) {
      return NextResponse.json({ error: "NOT_FOUND", message: "المنتج غير موجود." }, { status: 404 });
    }

    const nextIsPublic = !existingProduct.isPublic;

    // PUBLISHING GATE RULE: imageUrl only required before publishing.
    if (nextIsPublic) {
      const isPublishable = existingProduct.units.some(
        (u) =>
          u.imageUrl !== null &&
          u.imageUrl !== undefined &&
          u.imageUrl.trim().length > 0
      );

      if (!isPublishable) {
        return NextResponse.json(
          {
            error: "PUBLISH_GATE_BLOCKED",
            message: "لا يمكن نشر المنتج في المتجر إلا بعد إضافة صورة للمنتج على الأقل.",
          },
          { status: 400 }
        );
      }
    }

    const updated = await db.product.update({
      where: { id },
      data: {
        isPublic: nextIsPublic,
      },
    });

    return NextResponse.json({
      success: true,
      isPublic: updated.isPublic,
      message: updated.isPublic ? "تم نشر المنتج في متجر العملاء." : "تم إخفاء المنتج من متجر العملاء.",
    });
  } catch (error) {
    if (error instanceof ForbiddenRoleError) {
      return forbiddenRoleResponse(error);
    }
    if (error instanceof SubscriptionLockedError) {
      return subscriptionLockedResponse(error);
    }
    console.error("Error toggling product storefront status:", error);
    return NextResponse.json({ error: "SERVER_ERROR", message: "حدث خطأ أثناء تعديل حالة المنتج." }, { status: 500 });
  }
}
