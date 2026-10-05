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
import { Prisma } from "@prisma/client";
import Decimal from "decimal.js";
import { z } from "zod";
import { BatchOperationError } from "@/lib/inventory/batch-errors";

const DECIMAL_STRING_REGEX = /^-?\d{1,14}(\.\d{1,4})?$/;
// ProductBatch.quantity is Decimal(18,4): 14 integer digits + 4 decimals.
const MAX_ABS_QUANTITY = new Decimal("99999999999999.9999");

// quantityDelta accepts a decimal STRING only: a JS number would already be a
// lossy double by the time this schema runs.
//
// [v4.0 NOTE — STILL OPEN] quantityDelta is always in the batch's BASE unit.
// This endpoint has no unit context, so it cannot verify that the client
// converted a non-base entry (e.g. "one pack short") before sending. The
// spec (T3c) says the API must reject unconverted values; today that is only
// a convention. The robust fix is to accept { quantity, unitId } and convert
// server-side with the unit's own factor, as the batch-creation routes do.
const reconcileBatchSchema = z.object({
  quantityDelta: z
    .string()
    .trim()
    .regex(DECIMAL_STRING_REGEX, "صيغة قيمة التعديل غير صالحة (مثال: 5 أو -2.5).")
    .refine((val) => !new Decimal(val).isZero(), {
      message: "قيمة التعديل يجب ألا تساوي صفراً.",
    }),
  reason: z
    .string()
    .trim()
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

    // Role Capability Matrix: reconciling stock is ADMIN-only.
    assertRolePermission(session.user.role, "inventory:mutate");

    // Security boundary: fresh subscription status from the DB.
    await assertTenantWritable(session.user.tenantId);

    const tenantId = session.user.tenantId;
    const userId = session.user.id;
    const db = getTenantDb(tenantId);

    // [FIX] Malformed / non-object body -> 400, not 500.
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json(
        { error: "INVALID_JSON", message: "صيغة الطلب غير صالحة." },
        { status: 400 }
      );
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json(
        { error: "INVALID_JSON", message: "صيغة الطلب غير صالحة." },
        { status: 400 }
      );
    }

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
      // No `include: { unit: true }` — nothing here needs a raw ProductUnit.
      const batch = await tx.productBatch.findFirst({
        where: { id, tenantId },
      });

      if (!batch) {
        throw new BatchOperationError("NOT_FOUND", "الدفعة المحددة غير موجودة.", 404);
      }

      // [FIX] Validation-only range check (NOT the write itself — the write
      // below stays an atomic increment). Without it, a delta that pushes the
      // quantity past Decimal(18,4) surfaces as an opaque database error (500).
      const projected = new Decimal(batch.quantity.toString()).plus(quantityDelta);
      if (projected.abs().gt(MAX_ABS_QUANTITY)) {
        throw new BatchOperationError(
          "QUANTITY_OUT_OF_RANGE",
          "الكمية الناتجة بعد التسوية خارج النطاق المسموح — تحقق من قيمة التعديل.",
          400
        );
      }

      // 1. StockAdjustment row. StockAdjustment.batchId is a plain snapshot
      // field (v4.3 corrigendum), so the row carries its own
      // productId/unitId/batchNumber, captured as the batch is right now.
      const adjustment = await tx.stockAdjustment.create({
        data: {
          tenantId,
          batchId: batch.id,
          productId: batch.productId,
          unitId: batch.unitId,
          batchNumber: batch.batchNumber,
          adjustedByUserId: userId,
          quantityDelta,
          reason,
        },
        include: {
          adjustedByUser: {
            select: { id: true, name: true, email: true },
          },
        },
      });

      // 2. Atomic increment — never read-then-write (a concurrent sync or B2B
      // approval may be decrementing this exact row).
      const updatedBatch = await tx.productBatch.update({
        where: { id: batch.id, tenantId },
        data: {
          quantity: {
            increment: quantityDelta,
          },
        },
      });

      return { batch: updatedBatch, adjustment };
    });

    return NextResponse.json({
      success: true,
      message: "تم تسجيل التسوية المخزنية وتحديث كمية الدفعة بنجاح.",
      // Built by hand from scalar fields only — no raw ProductUnit can leak.
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
    // [FIX] The batch was deleted between the read and the increment; the
    // transaction (and the StockAdjustment row inside it) rolls back.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
      return NextResponse.json(
        { error: "NOT_FOUND", message: "الدفعة المحددة غير موجودة." },
        { status: 404 }
      );
    }
    console.error("Error reconciling batch:", error);
    return NextResponse.json(
      { error: "SERVER_ERROR", message: "حدث خطأ أثناء إجراء التسوية المخزنية." },
      { status: 500 }
    );
  }
}