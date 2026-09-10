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

// [FIX] Quantity is a Prisma Decimal(18,4) column — same precision class as
// every monetary field in this schema. Accepting it as `z.number()` (a
// native JS double) risks silent precision loss for large batch quantities
// or fractional units (e.g. 99999999999.9999 cannot round-trip through an
// IEEE-754 double without drift), which is exactly what this project's
// decimal.js-everywhere rule (T1) exists to prevent. Prisma's Decimal
// fields accept a numeric string directly and construct an exact
// Prisma.Decimal from it with no float in between — so quantity is
// received as a string and validated with a regex, never coerced to
// `number` at any point in this handler.
const DECIMAL_STRING_REGEX = /^-?\d{1,14}(\.\d{1,4})?$/;

const createBatchSchema = z.object({
  productId: z.string().min(1, "معرف المنتج مطلوب"),
  unitId: z.string().min(1, "معرف الوحدة مطلوب"),
  batchNumber: z.string().min(1, "رقم الدفعة مطلوب"),
  // [FIX] was z.number().min(0) — see the note above the regex constant.
  quantity: z
    .string()
    .min(1, "الكمية مطلوبة")
    .regex(DECIMAL_STRING_REGEX, "صيغة الكمية غير صالحة (مثال: 10 أو 10.5).")
    .refine((val) => Number(val) >= 0, {
      message: "الكمية يجب أن تكون صفر أو أكثر عند إنشاء دفعة جديدة.",
    }),
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
        // [FIX] `quantity` is the validated decimal-shaped string itself —
        // Prisma parses it directly into an exact Decimal(18,4). No
        // `Number(...)` conversion happens anywhere on this write path.
        quantity,
        expiryDate: expiryDate ? new Date(expiryDate) : null,
      },
      include: {
        unit: true,
      },
    });

    // NOTE: converting Decimal -> Number below is fine here because this is
    // purely a display-shape transform on the JSON response being sent back
    // to the browser, not a value being written to the database or used in
    // any further calculation — the authoritative Decimal already landed
    // in Postgres via the create() call above.
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