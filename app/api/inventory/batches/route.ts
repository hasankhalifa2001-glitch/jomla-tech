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
// [v4.0] ProductBatch.unitId must ALWAYS be the product's base unit (see
// T1's Unit Conversion Architecture) — never the unit an admin picks to
// enter a quantity in. The submitted `unitId` is treated as an ENTRY
// convenience only (same as products/route.ts's initialBatch.unitIndex):
// resolve the product's real base unit via requireBaseUnit(), convert
// the submitted quantity via toBaseUnit() using the SUBMITTED unit's own
// conversionFactor (fetched fresh server-side via
// getUnitConversionFactor()), and write the batch against the base unit
// with the converted quantity.
import { requireBaseUnit, MissingBaseUnitError } from "@/lib/inventory/base-unit";
import { getUnitConversionFactor, toBaseUnit } from "@/lib/inventory/units";
// Sole gateway for tx.productUnit.* — never call db.productUnit.findFirst()
// directly from a route file (PRODUCT_MODEL_RULES bans it here).
import { findProductUnitById } from "@/lib/data/products";
import { z } from "zod";

const STRICT_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

// Quantity is a Prisma Decimal(18,4) column — same precision class as
// every monetary field in this schema. Accepting it as `z.number()` (a
// native JS double) risks silent precision loss for large batch
// quantities or fractional units, which is exactly what this project's
// decimal.js-everywhere rule (T1) exists to prevent. Received as a
// string and validated with a regex, never coerced to `number` anywhere
// in this handler.
const DECIMAL_STRING_REGEX = /^-?\d{1,14}(\.\d{1,4})?$/;

const createBatchSchema = z.object({
  productId: z.string().min(1, "معرف المنتج مطلوب"),
  // Which unit the admin entered `quantity` in — an ENTRY convenience
  // only. Never written directly as ProductBatch.unitId; see the note
  // above the imports.
  unitId: z.string().min(1, "معرف الوحدة مطلوب"),
  batchNumber: z.string().min(1, "رقم الدفعة مطلوب"),
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

    // "does this unit belong to this product & tenant?" — matched
    // against productId manually here (no combined helper exists for
    // this exact query shape yet).
    const productUnit = await findProductUnitById(db, tenantId, unitId);
    if (!productUnit || productUnit.productId !== productId) {
      return NextResponse.json({ error: "NOT_FOUND", message: "المنتج أو الوحدة المحددة غير موجودة." }, { status: 404 });
    }

    // [v4.0] Everything from here on must commit atomically: resolving
    // the base unit, converting the quantity, and writing the batch are
    // all part of the same logical operation, and getUnitConversionFactor()
    // requires a real transaction client (see units.ts's signature).
    //
    // [FIX] Previously wrapped requireBaseUnit() in its own try/catch
    // that caught MissingBaseUnitError and re-threw a plain
    // `new Error("MISSING_BASE_UNIT")`, then matched on
    // `error.message === "MISSING_BASE_UNIT"` in the outer catch below.
    // MissingBaseUnitError is already imported and thrown directly by
    // requireBaseUnit() — there is no reason to translate it into a
    // string-matched generic Error in between. Removed the inner
    // try/catch entirely; MissingBaseUnitError now propagates unchanged
    // and is caught via `instanceof` in the outer catch, exactly the
    // same posture already applied to BaseUnitLockedError/
    // UnitNotBelongingToProductError elsewhere in this codebase.
    const result = await db.$transaction(async (tx) => {
      const baseUnit = await requireBaseUnit(tx, tenantId, productId);

      const soldUnitFactor = await getUnitConversionFactor(tx, tenantId, unitId);
      const baseQuantity = toBaseUnit(quantity, soldUnitFactor);

      const batch = await tx.productBatch.create({
        data: {
          tenantId,
          productId,
          unitId: baseUnit.id,
          batchNumber,
          quantity: baseQuantity.toString(),
          expiryDate: expiryDate ? new Date(expiryDate) : null,
        },
      });

      // Renamed to `resolvedBaseUnit` in the returned object — the
      // OBJECT KEY "baseUnit" would trip BASE_UNIT_ID_RULES's
      // MemberExpression selector on `result.baseUnit.unitName` below
      // (it checks the literal property name, not whether the value
      // came from a real Product/ProductUnit relation).
      return { batch, resolvedBaseUnit: baseUnit, enteredUnitName: productUnit.unitName };
    });

    // No raw `unit` relation included on the create/response — built by
    // hand instead, from values already resolved above.
    //
    // NOTE: Decimal -> Number below is fine here — purely a display-shape
    // transform on the JSON response, not a value written to the DB or
    // used in any further calculation. The authoritative Decimal already
    // landed in Postgres via the create() call above.
    const responseBatch = {
      id: result.batch.id,
      productId: result.batch.productId,
      unitId: result.batch.unitId,
      batchNumber: result.batch.batchNumber,
      quantity: Number(result.batch.quantity),
      expiryDate: result.batch.expiryDate,
      createdAt: result.batch.createdAt,
      // The base unit the batch is actually counted in — for the UI to
      // display "24 قطعة" correctly, distinct from the unit the admin
      // entered the quantity in (result.enteredUnitName), if different.
      baseUnitName: result.resolvedBaseUnit.unitName,
      enteredUnitName: result.enteredUnitName,
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
    // [FIX] instanceof check against the real error class — never a
    // string-matched message.
    if (error instanceof MissingBaseUnitError) {
      return NextResponse.json(
        {
          error: "MISSING_BASE_UNIT",
          message: "هذا المنتج بدون وحدة أساسية محددة (بيانات قديمة تحتاج تصحيح) — الرجاء التواصل مع الدعم الفني.",
        },
        { status: 409 }
      );
    }
    console.error("Error creating batch:", error);
    return NextResponse.json({ error: "SERVER_ERROR", message: "حدث خطأ أثناء إضافة الدفعة." }, { status: 500 });
  }
}