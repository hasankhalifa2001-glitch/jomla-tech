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
// [FIX] Sole gateway for tx.product.* — this route previously called
// db.product.findFirst() / db.product.update() directly, which is
// exactly the model-level access eslint.config.mjs's PRODUCT_MODEL_RULES
// bans. This file is not in the per-file override list that lifts that
// ban — routed through lib/data/products.ts instead.
//
// setProductActive() is used for the write rather than the general
// updateProduct() — it's the dedicated, single-field helper
// (lib/data/products.ts's own header explains why: "deliberately
// separate from updateProduct() so a caller can never accidentally
// bundle an isActive toggle with an isPublic change in the same call").
// That's precisely the guarantee this route's own comment below is
// relying on (isPublic must stay untouched) — using the dedicated
// helper makes that guarantee structural instead of just "this call
// happens to omit isPublic from its data object."
import {
  findProductById,
  setProductActive,
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
    // check — no separate manual role comparison here, to avoid two sources
    // of truth drifting apart if the matrix ever changes.
    assertRolePermission(session.user.role, "inventory:mutate");

    await assertTenantWritable(session.user.tenantId);

    const { id } = await params;
    const tenantId = session.user.tenantId;
    const db = getTenantDb(tenantId);

    // [FIX] Tenant-scoped read via the sanctioned gateway — the previous
    // db.product.findFirst({ where: { id } }) never filtered by
    // tenantId explicitly, relying solely on the Prisma Client
    // Extension. This route only needs isActive here, so
    // findProductById() (a plain, full-row read) is sufficient — no need
    // for findProductWithUnits()'s heavier units payload.
    const product = await findProductById(db, tenantId, id);

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
    //
    // [FIX] setProductActive(db, tenantId, id, isActive) touches ONLY the
    // isActive field by construction — see the import note above. The
    // write's own `where` is additionally scoped by tenantId inside that
    // helper (belt-and-suspenders), not relied on via the Client
    // Extension alone.
    const updated = await setProductActive(db, tenantId, id, nextIsActive);

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