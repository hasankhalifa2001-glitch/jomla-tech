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
// [FIX] Sole gateway for tx.product.* / tx.productUnit.* — this route
// previously called db.product.findFirst() / db.product.update()
// directly, which is exactly the model-level access
// eslint.config.mjs's PRODUCT_MODEL_RULES bans. This file is not in the
// per-file override list that lifts that ban for
// products/route.ts / products/[id]/route.ts — a different, nested
// route gets no such exemption. Routed through lib/data/products.ts
// instead, same as every other inventory route.
//
// findProductWithUnits() also closes a second real gap this route had:
// the previous db.product.findFirst({ include: { units: true } }) call
// handed back RAW ProductUnit rows — each one still carrying a real
// `conversionFactor` Decimal field — straight into this route's own
// source (existingProduct.units.map(...)), before any per-field
// normalization. That's exactly the leak lib/data/products.ts's FIX 3
// exists to close (see that file's header): a raw fetched relation
// crossing this file's boundary, not just a literal `.conversionFactor`
// property read. findProductWithUnits() returns
// DisplayUnitWithBaseFlag[] instead — conversionFactor pre-serialized,
// never a raw Decimal.
import {
  findProductWithUnits,
  updateProduct,
} from "@/lib/data/products";

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

    // [FIX] Tenant-scoped read via the sanctioned gateway — the previous
    // db.product.findFirst({ where: { id } }) never filtered by
    // tenantId explicitly, relying solely on the Prisma Client
    // Extension. Every other route in this codebase additionally scopes
    // explicitly (belt-and-suspenders, per T1's isolation architecture)
    // — this route was the exception.
    const existingProduct = await findProductWithUnits(db, tenantId, id);

    if (!existingProduct) {
      return NextResponse.json({ error: "NOT_FOUND", message: "المنتج غير موجود." }, { status: 404 });
    }

    const nextIsPublic = !existingProduct.isPublic;

    if (nextIsPublic) {
      // [FIX] existingProduct.units are now DisplayUnitWithBaseFlag[]
      // (via findProductWithUnits() -> toSafeProductWithUnits() ->
      // toDisplayUnits()), never raw ProductUnit rows — conversionFactor
      // was already pre-serialized to a string before reaching this
      // file, and priceRetail here is still normalized to a plain
      // number the same way the main PATCH /api/inventory/products/[id]
      // handler does, so this route can never disagree with it on the
      // same publishing-gate rule.
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

    // [FIX] Routed through updateProduct() — tenantId is now a required
    // argument on that function's current signature; the write's own
    // `where` is additionally scoped by tenantId inside that helper
    // (belt-and-suspenders, see products.ts's FIX 2 note), not relied on
    // via the Client Extension alone.
    const updated = await updateProduct(db, tenantId, id, {
      isPublic: nextIsPublic,
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