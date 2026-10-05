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
// Sole gateway for tenant-scoped product reads (see PRODUCT_MODEL_RULES).
import { findProductById } from "@/lib/data/products";
import { Prisma } from "@prisma/client";
import { z } from "zod";
// [Batch cost entry] The ONE shared 8dp cost pattern (see units.ts) — the
// correction path below validates the per-base-unit figure directly against
// it, exactly as the creation helper and the correction form do.
import Decimal from "decimal.js";
import { COST_PER_BASE_UNIT_REGEX } from "@/lib/inventory/units";
// [FIX] BatchOperationError used to be exported from THIS file. Next.js only
// permits specific exports from a route.ts (GET, POST, dynamic, ...), so any
// other export fails `next build`'s type check. It now lives in a shared lib
// file; the reconcile route imports it from there too.
// [FIX] One implementation of the suffix/expiry rules for every route.
import { batchNumberSuffixSchema, expiryDateSchema } from "@/lib/inventory/batch-creation";
// [FIX] The ONE sanctioned way to split a stored batchNumber. Replaces this
// file's local BATCH_NUMBER_PATTERN, which accepted impossible dates.
import { parseBatchNumber } from "@/lib/inventory/batch-number";
import { BatchOperationError } from "@/lib/inventory/batch-errors";

// [v4.4, T4g] A per-base-unit cost supplied DIRECTLY. Unlike every CREATION
// path — which takes a quantity + a total paid and derives the per-base-unit
// figure — a correction supplies the per-base-unit figure itself, because the
// batch's current quantity is no longer what was originally received, so there
// is no quantity/total pair left to divide. 8 decimals, matching
// ProductBatch.costPricePerBaseUnit's real Decimal(18,8) column.
const costPricePerBaseUnitSchema = z
  .string()
  .trim()
  .regex(
    COST_PER_BASE_UNIT_REGEX,
    "صيغة سعر التكلفة للوحدة الأساسية غير صالحة (حتى 8 خانات عشرية)."
  )
  .refine(
    (val) => {
      try {
        return new Decimal(val).gt(0);
      } catch {
        return false;
      }
    },
    { message: "سعر التكلفة للوحدة الأساسية يجب أن يكون أكبر من صفر." }
  );

// `quantity` is deliberately NOT part of this schema — the direct-edit
// rejection in PATCH checks the raw body first, so there is nothing for zod
// to (mis)validate here.
const updateBatchSchema = z.object({
  // Only the merchant-supplied suffix is ever accepted; the date prefix is
  // always preserved from the existing row.
  batchNumberSuffix: batchNumberSuffixSchema.optional(),
  expiryDate: expiryDateSchema,
  costPricePerBaseUnit: costPricePerBaseUnitSchema.optional(),
  // Required whenever costPricePerBaseUnit is supplied — enforced explicitly
  // in PATCH, BEFORE the batch is loaded.
  costPriceChangeReason: z.string().trim().optional(),
});

const deleteBatchSchema = z.object({
  reason: z.string().min(3, "يرجى تحديد سبب حذف الدفعة (3 أحرف على الأقل)."),
});

export async function GET(
  _req: Request,
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

    assertRolePermission(session.user.role, "inventory:view");

    const tenantId = session.user.tenantId;
    // [v4.4, T4g] The only ADMIN check this read path needs: whether the
    // batch's purchase-cost figure is allowed into the response at all.
    // `inventory:view` is held by a CASHIER too, so WITHOUT this the cost
    // would leak — the key is omitted from the JSON entirely for a non-ADMIN,
    // never merely hidden client-side.
    const isAdmin = session.user.role === "ADMIN";
    const db = getTenantDb(tenantId);

    // `unit` is narrowed to exclude conversionFactor; adjustment history is
    // read from StockAdjustment's plain snapshot fields (v4.3 corrigendum).
    const batch = await db.productBatch.findFirst({
      where: { id, tenantId },
      include: {
        unit: {
          select: { id: true, unitName: true, isActive: true },
        },
        _count: {
          select: { invoiceItems: true },
        },
      },
    });

    if (!batch) {
      return NextResponse.json(
        { error: "NOT_FOUND", message: "الدفعة المحددة غير موجودة." },
        { status: 404 }
      );
    }

    const product = await findProductById(db, tenantId, batch.productId);

    const adjustmentRows = await db.stockAdjustment.findMany({
      where: { tenantId, batchId: id },
      select: {
        id: true,
        quantityDelta: true,
        reason: true,
        createdAt: true,
        adjustedByUser: {
          select: { id: true, name: true, email: true },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    const adjustments = adjustmentRows.map((adj) => ({
      id: adj.id,
      quantityDelta: Number(adj.quantityDelta),
      reason: adj.reason,
      adjustedByUserName:
        adj.adjustedByUser?.name || adj.adjustedByUser?.email || "مستخدم",
      createdAt: adj.createdAt,
    }));

    const now = new Date();
    let daysToExpiry: number | null = null;
    let expiryStatus: "RED" | "YELLOW" | "NORMAL" = "NORMAL";

    if (batch.expiryDate) {
      const exp = new Date(batch.expiryDate);
      const diffMs = exp.getTime() - now.getTime();
      daysToExpiry = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
      if (daysToExpiry < 30) expiryStatus = "RED";
      else if (daysToExpiry < 60) expiryStatus = "YELLOW";
    }

    const quantityNum = Number(batch.quantity);

    return NextResponse.json({
      success: true,
      batch: {
        id: batch.id,
        productId: batch.productId,
        productName: product?.name ?? "",
        unitId: batch.unitId,
        unitName: batch.unit.unitName,
        batchNumber: batch.batchNumber,
        quantity: quantityNum,
        // [v4.4, T4g] ADMIN-only cost figure. Decimal string, as stored —
        // never Number(). Omitted from the JSON object entirely for a
        // non-ADMIN, consistent with the batches[] list in
        // app/api/inventory/products/route.ts.
        ...(isAdmin
          ? { costPricePerBaseUnit: batch.costPricePerBaseUnit.toString() }
          : {}),
        expiryDate: batch.expiryDate,
        daysToExpiry,
        expiryStatus,
        isNegative: quantityNum < 0,
        createdAt: batch.createdAt,
        adjustments,
        _count: {
          invoiceItems: batch._count.invoiceItems,
          adjustments: adjustments.length,
        },
      },
    });
  } catch (error) {
    if (error instanceof ForbiddenRoleError) return forbiddenRoleResponse(error);
    console.error("Error fetching batch:", error);
    return NextResponse.json(
      { error: "SERVER_ERROR", message: "حدث خطأ أثناء جلب بيانات الدفعة." },
      { status: 500 }
    );
  }
}

export async function PATCH(
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

    assertRolePermission(session.user.role, "inventory:mutate");
    await assertTenantWritable(session.user.tenantId);

    const tenantId = session.user.tenantId;
    const userId = session.user.id;
    const db = getTenantDb(tenantId);

    // [FIX] Malformed / non-object body -> 400, not 500.
    let body;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "INVALID_JSON", message: "صيغة الطلب غير صالحة." }, { status: 400 });
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "INVALID_JSON", message: "صيغة الطلب غير صالحة." }, { status: 400 });
    }

    // Quantity immutability guard — on the RAW body, before schema validation.
    if (body.quantity !== undefined) {
      return NextResponse.json(
        {
          error: "QUANTITY_IMMUTABLE_DIRECT_EDIT",
          message:
            "لا يمكن تعديل كمية الدفعة مباشرة — يجب إجراء تسوية مخزنية (Stock Reconciliation) لتسجيل سبب التعديل بدقة.",
        },
        { status: 400 }
      );
    }

    // The date prefix of batchNumber is a creation-time-only fact; the only
    // sanctioned way to change the merchant half is `batchNumberSuffix`.
    if (body.batchNumber !== undefined) {
      return NextResponse.json(
        {
          error: "BATCH_NUMBER_DIRECT_EDIT_NOT_ALLOWED",
          message:
            "لا يمكن تعديل رقم الدفعة بالكامل مباشرة — يمكن فقط تعديل الجزء الذي أدخلته عند إنشاء الدفعة (الجزء بعد التاريخ).",
        },
        { status: 400 }
      );
    }

    const validation = updateBatchSchema.safeParse(body);
    if (!validation.success) {
      return NextResponse.json(
        {
          error: "VALIDATION_ERROR",
          message: validation.error.issues[0]?.message || "بيانات التعديل غير صالحة.",
        },
        { status: 400 }
      );
    }

    const {
      batchNumberSuffix,
      expiryDate,
      costPricePerBaseUnit,
      costPriceChangeReason,
    } = validation.data;

    // [v4.4, T4g] A cost figure without a reason is rejected outright — checked
    // BEFORE the batch is loaded, so a malformed correction never costs a
    // database round-trip. Every correction is append-only and audited.
    if (costPricePerBaseUnit !== undefined) {
      if (!costPriceChangeReason || costPriceChangeReason.length < 3) {
        return NextResponse.json(
          {
            error: "COST_PRICE_CHANGE_REASON_REQUIRED",
            message: "يرجى تحديد سبب تصحيح سعر التكلفة (3 أحرف على الأقل).",
          },
          { status: 400 }
        );
      }
    }

    // [v4.4, T4g] The batch's cost correction is TWO top-level calls in ONE
    // transaction: the ProductBatch write and its CostPriceChangeLog row. A
    // failure of either rolls back both, so a corrected cost and its audit
    // trail can never disagree.
    const updatedBatch = await db.$transaction(async (tx) => {
      const existingBatch = await tx.productBatch.findFirst({
        where: { id, tenantId },
      });

      if (!existingBatch) {
        throw new BatchOperationError("NOT_FOUND", "الدفعة المحددة غير موجودة.", 404);
      }

      const updateData: Prisma.ProductBatchUpdateInput = {};

      if (batchNumberSuffix !== undefined) {
        // Recover the batch's ORIGINAL creation-date prefix — never today's
        // date — and rebuild the stored string with only the suffix swapped.
        const parsed = parseBatchNumber(existingBatch.batchNumber);

        if (!parsed) {
          // Surfaced loudly rather than silently falling back to today's date,
          // which would corrupt the batch's real creation-date record.
          throw new BatchOperationError(
            "BATCH_NUMBER_FORMAT_UNRECOGNIZED",
            "تعذر تعديل رقم الدفعة: صيغة رقم الدفعة الحالية غير متوافقة مع تنسيق النظام.",
            409
          );
        }

        updateData.batchNumber = `${parsed.datePrefix}-${batchNumberSuffix}`;
      }

      if (expiryDate !== undefined) {
        updateData.expiryDate = expiryDate ? new Date(expiryDate) : null;
      }

      // [v4.4, T4g] Cost-price correction. old/new are decimal STRINGS end to
      // end — never Number() — so an 8dp figure such as 333.33333333 survives
      // the round-trip intact and the log row reproduces the batch column
      // exactly. A no-op correction (the value already equals the stored one)
      // writes NOTHING: a spurious audit row would be misleading.
      if (costPricePerBaseUnit !== undefined) {
        const oldCost = new Decimal(existingBatch.costPricePerBaseUnit.toString());
        const newCost = new Decimal(costPricePerBaseUnit);

        if (!newCost.equals(oldCost)) {
          updateData.costPricePerBaseUnit = costPricePerBaseUnit;

          await tx.costPriceChangeLog.create({
            data: {
              tenantId,
              batchId: existingBatch.id,
              oldCostPrice: oldCost.toFixed(8),
              newCostPrice: newCost.toFixed(8),
              changedByUserId: userId,
              reason: costPriceChangeReason as string,
            },
          });
        }
      }

      // No `include: { unit: true }` — the response is built by hand from
      // scalar ProductBatch fields so no raw ProductUnit (conversionFactor)
      // can leak to the client.
      return tx.productBatch.update({
        where: { id, tenantId },
        data: updateData,
      });
    });

    return NextResponse.json({
      success: true,
      batch: {
        id: updatedBatch.id,
        productId: updatedBatch.productId,
        unitId: updatedBatch.unitId,
        batchNumber: updatedBatch.batchNumber,
        quantity: Number(updatedBatch.quantity),
        // [v4.4, T4g] Decimal string, as stored — never Number(): an 8dp cost
        // can carry more precision than a JS double represents exactly.
        costPricePerBaseUnit: updatedBatch.costPricePerBaseUnit.toString(),
        expiryDate: updatedBatch.expiryDate,
        createdAt: updatedBatch.createdAt,
      },
      message: "تم تحديث بيانات الدفعة بنجاح.",
    });
  } catch (error) {
    if (error instanceof BatchOperationError) {
      return NextResponse.json(
        { error: error.code, message: error.message },
        { status: error.statusCode }
      );
    }
    if (error instanceof ForbiddenRoleError) return forbiddenRoleResponse(error);
    if (error instanceof SubscriptionLockedError) return subscriptionLockedResponse(error);
    // [FIX] The batch disappeared between the read and the update.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
      return NextResponse.json(
        { error: "NOT_FOUND", message: "الدفعة المحددة غير موجودة." },
        { status: 404 }
      );
    }
    console.error("Error updating batch:", error);
    return NextResponse.json(
      { error: "SERVER_ERROR", message: "حدث خطأ أثناء تحديث الدفعة." },
      { status: 500 }
    );
  }
}

export async function DELETE(
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

    assertRolePermission(session.user.role, "inventory:mutate");
    await assertTenantWritable(session.user.tenantId);

    const tenantId = session.user.tenantId;
    const userId = session.user.id;
    const db = getTenantDb(tenantId);

    let body: unknown = {};
    try {
      body = await req.json();
    } catch {
      // Body may legitimately be empty; validation below rejects the missing
      // `reason` either way.
    }

    const validation = deleteBatchSchema.safeParse(body);
    if (!validation.success) {
      return NextResponse.json(
        {
          error: "VALIDATION_ERROR",
          message: validation.error.issues[0]?.message || "يرجى تحديد سبب حذف الدفعة.",
        },
        { status: 400 }
      );
    }

    const { reason } = validation.data;

    await db.$transaction(async (tx) => {
      const batch = await tx.productBatch.findFirst({
        where: { id, tenantId },
      });

      if (!batch) {
        throw new BatchOperationError("NOT_FOUND", "الدفعة المحددة غير موجودة.", 404);
      }

      const invoiceItemsCount = await tx.invoiceItem.count({
        where: { batchId: id, tenantId },
      });

      if (invoiceItemsCount > 0) {
        throw new BatchOperationError(
          "CANNOT_DELETE_BATCH_WITH_SALES",
          "لا يمكن حذف الدفعة لوجود مبيعات مسجلة عليها. يجب استخدام تسوية المخزون (Stock Reconciliation) لتصحيح الكميات.",
          400
        );
      }

      // Zero InvoiceItem references is the ONE hard-delete eligibility
      // condition (v4.3 corrigendum): prior StockAdjustment /
      // CostPriceChangeLog rows are plain snapshots and never block this.
      await tx.batchDeletionLog.create({
        data: {
          tenantId,
          batchId: batch.id,
          productId: batch.productId,
          unitId: batch.unitId,
          batchNumber: batch.batchNumber,
          quantityAtDeletion: batch.quantity,
          costPriceAtDeletion: batch.costPricePerBaseUnit,
          deletedByUserId: userId,
          reason,
        },
      });

      await tx.productBatch.delete({
        where: { id, tenantId },
      });
    });

    return NextResponse.json({
      success: true,
      message: "تم حذف الدفعة بنجاح وتوثيق العملية في سجل التدقيق.",
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
    // [FIX] Two concurrent deletes: the loser's delete() raises P2025.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
      return NextResponse.json(
        { error: "NOT_FOUND", message: "الدفعة المحددة غير موجودة." },
        { status: 404 }
      );
    }
    // A sale referencing the batch landed between the count and the delete
    // (InvoiceItem.batch is Restrict).
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003") {
      return NextResponse.json(
        {
          error: "FOREIGN_KEY_VIOLATION",
          message: "لا يمكن حذف الدفعة لوجود سجلات مرتبطة بها في قاعدة البيانات.",
        },
        { status: 400 }
      );
    }

    console.error("Error deleting batch:", error);
    return NextResponse.json(
      { error: "SERVER_ERROR", message: "حدث خطأ أثناء حذف الدفعة." },
      { status: 500 }
    );
  }
}