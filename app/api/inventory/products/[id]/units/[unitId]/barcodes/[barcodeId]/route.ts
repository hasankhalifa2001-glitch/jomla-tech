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
// [v4.5] Sole gateway for tx.productUnitBarcode.* — this route (like every
// other inventory route outside lib/data/products.ts and
// lib/inventory/base-unit.ts) never touches the model itself; see
// eslint.config.mjs's PRODUCT_UNIT_BARCODE_MODEL_RULES.
import { findProductWithUnits, deleteUnitBarcode } from "@/lib/data/products";

/**
 * DELETE /api/inventory/products/[id]/units/[unitId]/barcodes/[barcodeId]
 *
 * Removes ONE barcode from ONE unit. This is the ONLY way a barcode is ever
 * removed — the product PATCH endpoint is additive-only (re-saving the edit
 * form can add barcodes but never deletes one), precisely so that removal
 * always travels through this single, ADMIN-gated, auditable path.
 *
 * ADMIN-only: `inventory:mutate` is ADMIN-only in T2b's Role Capability
 * Matrix, and a hard DELETE of a barcode row is at least as consequential as
 * adding one. No new AppAction was introduced — every other inventory
 * mutation in this codebase rides the same existing action key.
 *
 * Safe by construction (schema.prisma's [v4.5] note): InvoiceItem and
 * B2BOrderRequestItem reference `unitId`, never a barcode row, so deleting a
 * barcode can never orphan or alter a completed sale, a FIFO allocation, or
 * any ledger figure. This route touches no financial row at all.
 */
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string; unitId: string; barcodeId: string }> }
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

    const { id: productId, unitId, barcodeId } = await params;
    const tenantId = session.user.tenantId;
    const db = getTenantDb(tenantId);

    // The unit must belong to THIS product, in THIS tenant — verified through
    // the sanctioned gateway rather than assumed from the URL.
    const product = await findProductWithUnits(db, tenantId, productId);
    if (!product) {
      return NextResponse.json({ error: "NOT_FOUND", message: "المنتج غير موجود." }, { status: 404 });
    }

    const unit = product.units.find((u) => u.id === unitId);
    if (!unit) {
      return NextResponse.json({ error: "NOT_FOUND", message: "الوحدة غير موجودة لهذا المنتج." }, { status: 404 });
    }

    // deleteUnitBarcode() itself re-verifies tenant ownership AND that the row
    // belongs to this exact unit (see its [v4.5] note) — the check above only
    // turns the common case into a clean 404 instead of a thrown error.
    await deleteUnitBarcode(db, tenantId, unitId, barcodeId);

    return NextResponse.json({
      success: true,
      message: "تم حذف الباركود بنجاح.",
    });
  } catch (error) {
    if (error instanceof SubscriptionLockedError) {
      return subscriptionLockedResponse(error);
    }
    if (error instanceof ForbiddenRoleError) {
      return forbiddenRoleResponse();
    }
    console.error("DELETE unit barcode error:", error);
    return NextResponse.json(
      { error: "SERVER_ERROR", message: "حدث خطأ أثناء حذف الباركود." },
      { status: 500 }
    );
  }
}
