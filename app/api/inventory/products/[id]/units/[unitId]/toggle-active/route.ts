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
  { params }: { params: Promise<{ id: string; unitId: string }> }
) {
  try {
    const session = await auth();
    if (!session || !session.user || !session.user.tenantId) {
      return NextResponse.json({ error: "UNAUTHORIZED", message: "يرجى تسجيل الدخول أولاً." }, { status: 401 });
    }

    // Role Capability Matrix (T2b) is the single authoritative permission
    // check — no separate manual role comparison here.
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

    // Deactivating/reactivating a ProductUnit is also a PURE visibility
    // toggle (T3a scope item 4) — it must never cascade into changing
    // Product.isPublic. The storefront already filters units by isActive,
    // so a deactivated unit simply disappears from pickers on its own; if
    // that was the product's only eligible unit, the product's own
    // storefront card just won't have a valid display unit to show — no
    // need to also flip isPublic to enforce that. Reactivating the unit
    // must restore full pre-deactivation behavior automatically, with no
    // admin re-publishing step required anywhere.
    const updatedUnit = await db.productUnit.update({
      where: { id: unitId },
      data: { isActive: nextUnitActive },
    });

    return NextResponse.json({
      success: true,
      unit: updatedUnit,
      productIsPublic: product.isPublic,
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