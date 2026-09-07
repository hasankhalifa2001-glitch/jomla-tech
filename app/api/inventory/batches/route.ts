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

const STRICT_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

const createBatchSchema = z.object({
  productId: z.string().min(1, "معرف المنتج مطلوب"),
  unitId: z.string().min(1, "معرف الوحدة مطلوب"),
  batchNumber: z.string().min(1, "رقم الدفعة مطلوب"),
  quantity: z.number().min(0, "الكمية يجب أن تكون صفر أو أكثر"),
  expiryDate: z
    .string()
    .optional()
    .nullable()
    .refine(
      (val) => !val || STRICT_DATE_REGEX.test(val),
      { message: "تاريخ الانتهاء يجب أن يكون بالصيغة YYYY-MM-DD (مثال: 2026-12-31)." }
    )
    .refine(
      (val) => !val || !isNaN(new Date(val).getTime()),
      { message: "تاريخ الانتهاء غير صالح." }
    ),
});

export async function POST(req: Request) {
  try {
    const session = await auth();
    if (!session || !session.user || !session.user.tenantId) {
      return NextResponse.json({ error: "UNAUTHORIZED", message: "يرجى تسجيل الدخول أولاً." }, { status: 401 });
    }

    // Role Capability Matrix: inventory mutation (adding batches) is ADMIN-only
    assertRolePermission(session.user.role, "inventory:mutate");

    // Security boundary: check fresh subscription status in DB
    await assertTenantWritable(session.user.tenantId);

    const tenantId = session.user.tenantId;
    const db = getTenantDb(tenantId);
    const body = await req.json();
    const validation = createBatchSchema.safeParse(body);

    if (!validation.success) {
      return NextResponse.json(
        {
          error: "VALIDATION_ERROR",
          message: validation.error.issues[0]?.message || "بيانات الدفعة غير صالحة.",
        },
        { status: 400 }
      );
    }

    const { productId, unitId, batchNumber, quantity, expiryDate } = validation.data;

    // Verify product & unit belong to tenant.
    const productUnit = await db.productUnit.findFirst({
      where: {
        id: unitId,
        productId,
        tenantId,
      },
    });

    if (!productUnit) {
      return NextResponse.json({ error: "NOT_FOUND", message: "المنتج أو الوحدة المحددة غير موجودة." }, { status: 404 });
    }

    const batch = await db.productBatch.create({
      data: {
        tenantId,
        productId,
        unitId,
        batchNumber,
        quantity,
        expiryDate: expiryDate ? new Date(expiryDate) : null,
      },
      include: {
        unit: true,
      },
    });

    const responseBatch = {
      ...batch,
      quantity: Number(batch.quantity),
      unit: batch.unit
        ? {
          ...batch.unit,
          conversionFactor: Number(batch.unit.conversionFactor),
          priceWholesale: Number(batch.unit.priceWholesale),
          priceRetail:
            batch.unit.priceRetail !== null && batch.unit.priceRetail !== undefined
              ? Number(batch.unit.priceRetail)
              : null,
        }
        : null,
    };

    return NextResponse.json({
      success: true,
      batch: responseBatch,
      message: "تمت إضافة الدفعة الجديدة بنجاح.",
    });
  } catch (error) {
    if (error instanceof ForbiddenRoleError) {
      return forbiddenRoleResponse(error);
    }
    if (error instanceof SubscriptionLockedError) {
      return subscriptionLockedResponse(error);
    }
    console.error("Error creating batch:", error);
    return NextResponse.json({ error: "SERVER_ERROR", message: "حدث خطأ أثناء إضافة الدفعة." }, { status: 500 });
  }
}
