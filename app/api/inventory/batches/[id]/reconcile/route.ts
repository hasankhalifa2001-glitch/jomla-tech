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
      const batch = await tx.productBatch.findFirst({
        where: { id, tenantId },
        include: { unit: true },
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
      const updatedBatch = await tx.productBatch.update({
        where: { id: batch.id, tenantId },
        data: {
          quantity: {
            increment: quantityDelta,
          },
        },
        include: {
          unit: true,
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
      batch: {
        ...result.batch,
        quantity: Number(result.batch.quantity),
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