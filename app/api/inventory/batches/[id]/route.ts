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
// [FIX] Sole gateway for tenant-scoped product reads — the previous GET
// handler pulled `product: { select: {...} } }` directly inside a
// ProductBatch include, which is exactly the Property-key access
// PRODUCT_MODEL_RULES bans (a Property named "product" nested under
// "include"), plus a separate MemberExpression violation on
// `batch.product.name`. Routed through findProductById() instead.
import { findProductById } from "@/lib/data/products";
import { Prisma } from "@prisma/client";
import { z } from "zod";

export class BatchOperationError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode: number = 400) {
    super(message);
    this.name = "BatchOperationError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

const STRICT_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

// [FIX] `quantity` is deliberately NOT part of this schema at all — the
// direct-edit rejection below checks `body.quantity !== undefined` BEFORE
// this schema even runs, so there is nothing for zod to (mis)validate here.
// Keeping a `quantity: z.any().optional()` field in the schema, as the
// previous version did, was dead/confusing: it silently accepted whatever
// shape was sent and did nothing with it, which invites someone later to
// wire it up to `updateData` by mistake and reopen the exact hole T3c's
// spec forbids (direct field writes to ProductBatch.quantity).
const updateBatchSchema = z.object({
  batchNumber: z.string().min(1, "رقم الدفعة مطلوب").optional(),
  expiryDate: z
    .string()
    .optional()
    .nullable()
    .refine((val) => !val || STRICT_DATE_REGEX.test(val), {
      message: "تاريخ الانتهاء يجب أن يكون بالصيغة YYYY-MM-DD (مثال: 2026-12-31).",
    })
    .refine((val) => !val || !isNaN(new Date(val).getTime()), {
      message: "تاريخ الانتهاء غير صالح.",
    }),
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
    const db = getTenantDb(tenantId);

    // [FIX] `product` relation removed from this include entirely — see
    // the import note above. `unit` stays, but NARROWED to exclude
    // conversionFactor (same pattern lib/data/products.ts's FIX 3
    // already established for batch.unit) — this route only ever needs
    // unitName here, never the raw conversionFactor.
    const batch = await db.productBatch.findFirst({
      where: { id, tenantId },
      include: {
        unit: {
          select: { id: true, unitName: true, isActive: true },
        },
        adjustments: {
          include: {
            adjustedByUser: {
              select: { id: true, name: true, email: true },
            },
          },
          orderBy: { createdAt: "desc" },
        },
        _count: {
          select: { invoiceItems: true, adjustments: true },
        },
      },
    });

    if (!batch) {
      return NextResponse.json(
        { error: "NOT_FOUND", message: "الدفعة المحددة غير موجودة." },
        { status: 404 }
      );
    }

    // [FIX] Product name/category fetched via the sanctioned gateway
    // instead of a nested `product: { select: {...} } }` relation on the
    // batch query above.
    const product = await findProductById(db, tenantId, batch.productId);

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
        expiryDate: batch.expiryDate,
        daysToExpiry,
        expiryStatus,
        isNegative: quantityNum < 0,
        createdAt: batch.createdAt,
        adjustments: batch.adjustments.map((adj) => ({
          id: adj.id,
          quantityDelta: Number(adj.quantityDelta),
          reason: adj.reason,
          adjustedByUserName:
            adj.adjustedByUser?.name || adj.adjustedByUser?.email || "مستخدم",
          createdAt: adj.createdAt,
        })),
        _count: batch._count,
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
    const db = getTenantDb(tenantId);
    const body = await req.json();

    // Quantity immutability guard — checked BEFORE schema validation, on
    // the raw body, so a caller can never smuggle a quantity edit through
    // even if updateBatchSchema were ever loosened later.
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

    const { batchNumber, expiryDate } = validation.data;

    const existingBatch = await db.productBatch.findFirst({
      where: { id, tenantId },
    });

    if (!existingBatch) {
      return NextResponse.json(
        { error: "NOT_FOUND", message: "الدفعة المحددة غير موجودة." },
        { status: 404 }
      );
    }

    const updateData: Prisma.ProductBatchUpdateInput = {};
    if (batchNumber !== undefined) updateData.batchNumber = batchNumber;
    if (expiryDate !== undefined) {
      updateData.expiryDate = expiryDate ? new Date(expiryDate) : null;
    }

    // [FIX] No `include: { unit: true }` here anymore — this handler
    // never needed a unit relation at all; it was only ever there so
    // the previous response could spread `...updatedBatch` including
    // `.unit`. That spread leaked a raw ProductUnit row — real
    // conversionFactor Decimal included — straight to the client. This
    // route has no per-file exemption for conversionFactor (unlike
    // products/route.ts / products/[id]/route.ts), so carrying that
    // value downstream at all, even unnamed via a spread, defeats the
    // whole point of the restriction. Fixed by dropping the include
    // entirely and building the response by hand from only the scalar
    // ProductBatch fields actually needed.
    const updatedBatch = await db.productBatch.update({
      where: { id, tenantId },
      data: updateData,
    });

    return NextResponse.json({
      success: true,
      batch: {
        id: updatedBatch.id,
        productId: updatedBatch.productId,
        unitId: updatedBatch.unitId,
        batchNumber: updatedBatch.batchNumber,
        quantity: Number(updatedBatch.quantity),
        expiryDate: updatedBatch.expiryDate,
        createdAt: updatedBatch.createdAt,
      },
      message: "تم تحديث بيانات الدفعة بنجاح.",
    });
  } catch (error) {
    if (error instanceof ForbiddenRoleError) return forbiddenRoleResponse(error);
    if (error instanceof SubscriptionLockedError) return subscriptionLockedResponse(error);
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
      // Body may legitimately be empty for some clients; validation below
      // will reject the missing `reason` either way.
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

      const adjustmentsCount = await tx.stockAdjustment.count({
        where: { batchId: id, tenantId },
      });

      if (adjustmentsCount > 0) {
        throw new BatchOperationError(
          "CANNOT_DELETE_RECONCILED_BATCH",
          "لا يمكن حذف دفعة تم إجراء تسويات مخزنية عليها سابقاً — يجب تصحيح الكمية عبر تسوية جديدة.",
          400
        );
      }

      await tx.batchDeletionLog.create({
        data: {
          tenantId,
          batchId: batch.id,
          productId: batch.productId,
          unitId: batch.unitId,
          batchNumber: batch.batchNumber,
          quantityAtDeletion: batch.quantity,
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