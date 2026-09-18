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
import { z } from "zod";
import { BatchOperationError } from "../route";

const DECIMAL_STRING_REGEX = /^-?\d{1,14}(\.\d{1,4})?$/;

// [FIX] Previously `z.union([z.string(), z.number()]).transform((val) =>
// String(val))`. Accepting a native `number` here reopens the exact
// precision hole the rest of T3c's decimal-string convention exists to
// close: if the frontend ever sends a JS number, `JSON.parse` has already
// converted it to an IEEE-754 double *before* this schema even runs — the
// later `String(val)` and regex check happen on an already-lossy value, so
// the union/transform gave no real protection, only the appearance of it.
// `quantityDelta` now accepts a string only; the frontend is required to
// serialize the delta as a decimal string itself.
//
// [v4.0 NOTE] Per T1's Unit Conversion Architecture / T3c's edit:
// quantityDelta here is always in the batch's BASE unit, exactly like
// ProductBatch.quantity itself. If the reconciliation UI lets an admin
// enter the correction in a non-base unit (e.g. "one pack short"), that
// conversion (via toBaseUnit(), using the entered unit's own
// conversionFactor) must happen on the client BEFORE this value reaches
// this route — this endpoint receives and stores the value as-is, with
// no unit context of its own to convert against. No change made here;
// flagged for confirmation that the frontend reconciliation screen
// actually performs this conversion before submitting, since this route
// has no way to verify it server-side.
const reconcileBatchSchema = z.object({
  quantityDelta: z
    .string()
    .trim()
    .regex(DECIMAL_STRING_REGEX, "صيغة قيمة التعديل غير صالحة (مثال: 5 أو -2.5).")
    .refine((val) => Number(val) !== 0, {
      message: "قيمة التعديل يجب ألا تساوي صفراً.",
    }),
  reason: z
    .string()
    .min(3, "يرجى تحديد سبب التسوية المخزنية بالتفصيل (3 أحرف على الأقل)."),
});

export async function POST(
  req: Request,
  props: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await props.params;
    const session = await auth();
    if (!session || !session.user || !session.user.tenantId) {
      return NextResponse.json(
        { error: "UNAUTHORIZED", message: "يرجى تسجيل الدخول أولاً." },
        { status: 401 }
      );
    }

    // Role Capability Matrix: inventory mutation (reconciling stock) is ADMIN-only
    assertRolePermission(session.user.role, "inventory:mutate");

    // Security boundary: check fresh subscription status in DB
    await assertTenantWritable(session.user.tenantId);

    const tenantId = session.user.tenantId;
    const userId = session.user.id;
    const db = getTenantDb(tenantId);
    const body = await req.json();

    const validation = reconcileBatchSchema.safeParse(body);
    if (!validation.success) {
      return NextResponse.json(
        {
          error: "VALIDATION_ERROR",
          message: validation.error.issues[0]?.message || "بيانات التسوية غير صالحة.",
        },
        { status: 400 }
      );
    }

    const { quantityDelta, reason } = validation.data;

    const result = await db.$transaction(async (tx) => {
      // [FIX] `include: { unit: true }` removed — this read is only ever
      // used for the existence check and `batch.id` below; nothing here
      // ever touched `.unit`. Dropping the include avoids pulling a raw
      // ProductUnit row (real conversionFactor Decimal) into scope for
      // no reason.
      const batch = await tx.productBatch.findFirst({
        where: { id, tenantId },
      });

      if (!batch) {
        throw new BatchOperationError("NOT_FOUND", "الدفعة المحددة غير موجودة.", 404);
      }

      // 1. Create StockAdjustment row
      const adjustment = await tx.stockAdjustment.create({
        data: {
          tenantId,
          batchId: batch.id,
          adjustedByUserId: userId,
          quantityDelta,
          reason,
        },
        include: {
          adjustedByUser: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
        },
      });

      // 2. Atomic increment update to ProductBatch.quantity
      // [FIX] `include: { unit: true }` removed — this route has no
      // per-file exemption for conversionFactor (unlike
      // products/route.ts / products/[id]/route.ts), so carrying a raw
      // ProductUnit row downstream at all — even unnamed, via a later
      // spread — defeats the point of the restriction. This route only
      // ever needs scalar ProductBatch fields for its response.
      const updatedBatch = await tx.productBatch.update({
        where: { id: batch.id, tenantId },
        data: {
          quantity: {
            increment: quantityDelta,
          },
        },
      });

      return {
        batch: updatedBatch,
        adjustment,
      };
    });

    return NextResponse.json({
      success: true,
      message: "تم تسجيل التسوية المخزنية وتحديث كمية الدفعة بنجاح.",
      // [FIX] Built by hand from scalar ProductBatch fields only — no
      // `...result.batch` spread, which previously leaked
      // `result.batch.unit.conversionFactor` (a real Decimal) straight
      // into the JSON response.
      batch: {
        id: result.batch.id,
        productId: result.batch.productId,
        unitId: result.batch.unitId,
        batchNumber: result.batch.batchNumber,
        quantity: Number(result.batch.quantity),
        expiryDate: result.batch.expiryDate,
        createdAt: result.batch.createdAt,
      },
      adjustment: {
        id: result.adjustment.id,
        quantityDelta: Number(result.adjustment.quantityDelta),
        reason: result.adjustment.reason,
        adjustedByUserName:
          result.adjustment.adjustedByUser?.name ||
          result.adjustment.adjustedByUser?.email ||
          "مستخدم",
        createdAt: result.adjustment.createdAt,
      },
    });
  } catch (error) {
    if (error instanceof BatchOperationError) {
      return NextResponse.json(
        { error: error.code, message: error.message },
        { status: error.statusCode }
      );
    }
    if (error instanceof ForbiddenRoleError) {
      return forbiddenRoleResponse(error);
    }
    if (error instanceof SubscriptionLockedError) {
      return subscriptionLockedResponse(error);
    }
    console.error("Error reconciling batch:", error);
    return NextResponse.json(
      { error: "SERVER_ERROR", message: "حدث خطأ أثناء إجراء التسوية المخزنية." },
      { status: 500 }
    );
  }
}