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
import { checkProductPublishable } from "@/lib/inventory/publishing-gate";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string; unitId: string }> }
) {
  try {
    const session = await auth();
    if (!session || !session.user || !session.user.tenantId) {
      return NextResponse.json({ error: "UNAUTHORIZED", message: "يرجى تسجيل الدخول أولاً." }, { status: 401 });
    }

    if (session.user.role !== "ADMIN") {
      return NextResponse.json(
        { error: "FORBIDDEN", message: "غير مصرح: تعديل حالة الوحدة متاح لمدير المتجر فقط." },
        { status: 403 }
      );
    }
    assertRolePermission(session.user.role, "inventory:mutate");

    await assertTenantWritable(session.user.tenantId);

    const { id: productId, unitId } = await params;
    const tenantId = session.user.tenantId;
    const db = getTenantDb(tenantId);

    const product = await db.product.findFirst({
      where: { id: productId },
      include: { units: true },
    });

    if (!product) {
      return NextResponse.json({ error: "NOT_FOUND", message: "المنتج غير موجود." }, { status: 404 });
    }

    const unit = product.units.find((u) => u.id === unitId);
    if (!unit) {
      return NextResponse.json({ error: "NOT_FOUND", message: "الوحدة غير موجودة لهذا المنتج." }, { status: 404 });
    }

    const nextUnitActive = !unit.isActive;

    // Evaluate impact on storefront publishing gate if product is currently public
    let nextProductIsPublic = product.isPublic;
    if (product.isPublic) {
      const updatedUnits = product.units.map((u) =>
        u.id === unitId ? { ...u, isActive: nextUnitActive } : u
      );
      const gateCheck = checkProductPublishable({
        isActive: product.isActive,
        units: updatedUnits,
      });
      if (!gateCheck.publishable) {
        nextProductIsPublic = false;
      }
    }

    const result = await db.$transaction(async (tx) => {
      const updatedUnit = await tx.productUnit.update({
        where: { id: unitId },
        data: { isActive: nextUnitActive },
      });

      if (nextProductIsPublic !== product.isPublic) {
        await tx.product.update({
          where: { id: productId },
          data: { isPublic: nextProductIsPublic },
        });
      }

      return { updatedUnit, isPublic: nextProductIsPublic };
    });

    return NextResponse.json({
      success: true,
      unit: result.updatedUnit,
      productIsPublic: result.isPublic,
      message: nextUnitActive ? "تم تفعيل الوحدة بنجاح." : "تم إيقاف تفعيل الوحدة بنجاح.",
    });
  } catch (error) {
    if (error instanceof SubscriptionLockedError) {
      return subscriptionLockedResponse(error);
    }
    if (error instanceof ForbiddenRoleError) {
      return forbiddenRoleResponse();
    }
    console.error("PATCH toggle unit active error:", error);
    return NextResponse.json({ error: "SERVER_ERROR", message: "حدث خطأ أثناء تعديل حالة الوحدة." }, { status: 500 });
  }
}
