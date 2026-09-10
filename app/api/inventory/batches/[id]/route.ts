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

// [FIX] Moved above every handler that references it. The previous version
// declared this at the very bottom of the file, after the DELETE handler
// that uses it — in a module with `const`, that binding isn't initialized
// until its own declaration line runs at module-evaluation time, so any
// code path that could execute before the module finished loading would
// have thrown a ReferenceError (temporal dead zone). In practice Next.js
// fully evaluates the route module before serving any request, so this
// specific case likely never triggered at runtime — but the DELETE
// function body was also byte-for-byte pasted inside PATCH's body in the
// submitted file, which is the real breakage; consolidating the schema up
// here removes any ambiguity either way and matches every other schema's
// placement in this file.
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

    const batch = await db.productBatch.findFirst({
      where: { id, tenantId },
      include: {
        unit: true,
        product: {
          select: { id: true, name: true, category: true },
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
        productName: batch.product.name,
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

    // [FIX] The submitted file's `update()` call was left open — its
    // closing `});` was replaced by the entire DELETE function body being
    // pasted inline as if it were another property of the `data`/options
    // object, which does not even parse as valid TypeScript. Restored to
    // a normal, fully-closed call.
    const updatedBatch = await db.productBatch.update({
      where: { id, tenantId },
      data: updateData,
      include: { unit: true },
    });

    return NextResponse.json({
      success: true,
      batch: { ...updatedBatch, quantity: Number(updatedBatch.quantity) },
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

    // Every rejection path below THROWS a BatchOperationError instead of
    // returning a NextResponse — required so Prisma's interactive
    // transaction aborts and rolls back automatically on any of these
    // paths, and so the BatchDeletionLog write + productBatch.delete()
    // stay atomic with the checks that gate them (closing the TOCTOU
    // window between the count checks and the delete itself). The catch
    // block below the transaction is the only place a NextResponse is
    // ever constructed for these cases.
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
    // Last-line defense: even though the count checks above should catch
    // every ordinary case, a genuine race (another transaction inserting
    // an InvoiceItem/StockAdjustment between our count and our delete)
    // would surface here as a Postgres foreign-key violation via Prisma's
    // typed error class — never as a raw/opaque error shown to the user.
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