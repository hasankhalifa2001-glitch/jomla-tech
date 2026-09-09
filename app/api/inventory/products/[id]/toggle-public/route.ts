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
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await auth();
    if (!session || !session.user || !session.user.tenantId) {
      return NextResponse.json({ error: "UNAUTHORIZED", message: "يرجى تسجيل الدخول أولاً." }, { status: 401 });
    }

    // Role Capability Matrix (T2b) is the single authoritative permission
    // check — no separate manual role comparison here.
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

    if (nextIsPublic) {
      // [FIX] `existingProduct` was previously passed to
      // checkProductPublishable() as-is, straight from Prisma —
      // `units[].priceRetail` on that raw object is a `Prisma.Decimal`
      // instance, not a plain JS number. The PATCH /api/inventory/
      // products/[id] handler (the main edit endpoint) always normalizes
      // this with `Number(u.priceRetail)` before calling the same gate
      // function — this route was the one place that skipped it,
      // meaning the exact same publishing-gate rule could silently
      // evaluate differently here than everywhere else it's checked,
      // depending on how `Decimal` behaves under whatever comparison
      // checkProductPublishable performs internally. Normalized the same
      // way as the main PATCH handler so this route can never disagree
      // with it on the same rule.
      const candidateUnits = existingProduct.units.map((u) => ({
        isActive: u.isActive !== false,
        imageUrl: u.imageUrl,
        priceRetail:
          u.priceRetail !== null && u.priceRetail !== undefined
            ? Number(u.priceRetail)
            : null,
      }));

      const gateCheck = checkProductPublishable({
        isActive: existingProduct.isActive,
        units: candidateUnits,
      });
      if (!gateCheck.publishable) {
        return NextResponse.json(
          {
            error: !existingProduct.isActive ? "PRODUCT_INACTIVE" : "PUBLISH_GATE_BLOCKED",
            message: gateCheck.reason,
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