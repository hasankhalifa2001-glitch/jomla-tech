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

    // Role Capability Matrix (T2b) is the single authoritative permission
    // check — no separate manual role comparison here, to avoid two sources
    // of truth drifting apart if the matrix ever changes.
    assertRolePermission(session.user.role, "inventory:mutate");

    await assertTenantWritable(session.user.tenantId);

    const { id } = await params;
    const tenantId = session.user.tenantId;
    const db = getTenantDb(tenantId);

    const product = await db.product.findFirst({
      where: { id },
    });

    if (!product) {
      return NextResponse.json({ error: "NOT_FOUND", message: "المنتج غير موجود." }, { status: 404 });
    }

    const nextIsActive = !product.isActive;

    // Deactivation/reactivation is PURELY a visibility toggle (T1 Tenant
    // Lifecycle & Deletion Policy / T3a scope item 3) — it must never be a
    // data-migration event and requires no field re-validation. isPublic is
    // deliberately left untouched here: the storefront query already
    // filters on isActive AND isPublic together, so isActive: false alone
    // already hides the product. A reactivated product's isPublic value
    // must return to whatever it was before deactivation, automatically,
    // with zero manual re-publishing required from the admin.
    const updated = await db.product.update({
      where: { id },
      data: {
        isActive: nextIsActive,
      },
    });

    return NextResponse.json({
      success: true,
      isActive: updated.isActive,
      isPublic: updated.isPublic,
      message: updated.isActive ? "تم تفعيل المنتج بنجاح." : "تم تعطيل المنتج بنجاح.",
    });
  } catch (error) {
    if (error instanceof SubscriptionLockedError) {
      return subscriptionLockedResponse(error);
    }
    if (error instanceof ForbiddenRoleError) {
      return forbiddenRoleResponse();
    }
    console.error("PATCH toggle product active error:", error);
    return NextResponse.json({ error: "SERVER_ERROR", message: "حدث خطأ أثناء تعديل حالة المنتج." }, { status: 500 });
  }
}