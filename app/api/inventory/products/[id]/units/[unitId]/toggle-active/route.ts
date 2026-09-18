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
// [FIX] Sole gateway for tx.product.* / tx.productUnit.* — this route
// previously called db.product.findFirst() / db.productUnit.update()
// directly, which is exactly the model-level access
// eslint.config.mjs's PRODUCT_MODEL_RULES bans. This file is NOT in the
// per-file override list that lifts that ban for
// products/route.ts / products/[id]/route.ts — it's a different,
// nested route and gets no such exemption. Routed through
// lib/data/products.ts instead, same as every other inventory route.
import {
  findProductWithUnits,
  updateProductUnit,
} from "@/lib/data/products";

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

    // [FIX] Tenant-scoped read via the sanctioned gateway — the previous
    // db.product.findFirst({ where: { id: productId } }) never filtered
    // by tenantId explicitly at all, relying solely on the Prisma Client
    // Extension to have scoped it. Every other route in this codebase
    // additionally scopes explicitly (belt-and-suspenders, per T1's
    // isolation architecture) — this route was the one exception.
    const product = await findProductWithUnits(db, tenantId, productId);

    if (!product) {
      return NextResponse.json({ error: "NOT_FOUND", message: "المنتج غير موجود." }, { status: 404 });
    }

    const unit = product.units.find((u) => u.id === unitId);
    if (!unit) {
      return NextResponse.json({ error: "NOT_FOUND", message: "الوحدة غير موجودة لهذا المنتج." }, { status: 404 });
    }

    const nextUnitActive = !unit.isActive;

    // [FLAGGED — open question, unresolved, unrelated to this fix] T3a
    // §4's original spec text doesn't explicitly address whether
    // deactivating a product's BASE unit should be blocked under v4.0
    // (every ProductBatch.unitId is always the base unit, so
    // deactivating it hides the very unit every batch is counted in
    // from POS/storefront pickers, while batches/stock stay untouched
    // per the pure-visibility-toggle rule below). No new restriction is
    // added here — `unit.isBaseUnit` is available if/when a product
    // decision is made to guard this.

    // Deactivating/reactivating a ProductUnit is also a PURE visibility
    // toggle (T3a scope item 4) — it must never cascade into changing
    // Product.isPublic. The storefront already filters units by isActive,
    // so a deactivated unit simply disappears from pickers on its own; if
    // that was the product's only eligible unit, the product's own
    // storefront card just won't have a valid display unit to show — no
    // need to also flip isPublic to enforce that. Reactivating the unit
    // must restore full pre-deactivation behavior automatically, with no
    // admin re-publishing step required anywhere.
    const updatedUnit = await updateProductUnit(db, tenantId, unitId, {
      isActive: nextUnitActive,
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