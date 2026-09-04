import { NextResponse } from "next/server";
import { auth } from "@/auth";
// [FIX — real gap, not just hygiene] The raw `prisma.product.update(...)`
// call below had `where: { id }` with NO `tenantId` at all — the preceding
// `findFirst` check confirms tenant ownership before this call, but the
// `update` itself carried zero protection of its own. If that `findFirst`
// pre-check were ever removed (e.g. as a perceived "duplicate" query
// during a refactor) or this pattern were copied elsewhere without it,
// this would become a real cross-tenant write: any authenticated ADMIN
// could toggle any OTHER tenant's product's storefront visibility just by
// knowing its id. Switching to `getTenantDb(tenantId)` closes this
// concretely, not just in principle — the Client Extension injects
// `tenantId` into this exact `update` call's `where` automatically (see
// lib/db/tenant-scope.ts's WHERE_SCOPED_WRITE_OPS handling), so the write
// is scoped correctly even if a future edit ever removes the pre-check.
import { getTenantDb } from "@/lib/db/tenant-scope";

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

    // [v3.5] Locked out identically for EXPIRED and PENDING.
    if (session.user.subscriptionStatus === "EXPIRED" || session.user.subscriptionStatus === "PENDING") {
      return NextResponse.json(
        { error: "SUBSCRIPTION_LOCKED", message: "اشتراكك منتهي أو معلق. لا يمكنك تعديل المنتجات." },
        { status: 403 }
      );
    }

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

    // PUBLISHING GATE RULE: [FIX] same relaxation as the POST route —
    // imageUrl only. `priceWholesale` is already required and strictly
    // positive on every unit at creation time, so a real, charge-able
    // price is guaranteed to exist by the time a product can even reach
    // this toggle. `priceRetail` stays optional and is never a publishing
    // requirement — it's a display-only suggested resale price for the
    // storefront buyer, never itself charged, so a merchant publishing at
    // plain wholesale price with no suggested retail number must be able
    // to.
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

    // [FIX] `where: { id }` now goes through `db` (getTenantDb(tenantId)),
    // so the extension injects `tenantId` into this update's `where`
    // automatically — this write can no longer target a row belonging to
    // a different tenant under any circumstance, independent of whether
    // the `findFirst` pre-check above stays in place.
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
    console.error("Error toggling product storefront status:", error);
    return NextResponse.json({ error: "SERVER_ERROR", message: "حدث خطأ أثناء تعديل حالة المنتج." }, { status: 500 });
  }
}