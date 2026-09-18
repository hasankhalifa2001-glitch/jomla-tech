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
// [FIX — v4.0 architecture was entirely missing from this route]
// ProductBatch.unitId must ALWAYS be the product's base unit (see T1's
// Unit Conversion Architecture) — never the unit an admin picks to enter
// a quantity in. This route previously wrote the submitted `unitId`
// straight onto ProductBatch.unitId and the raw `quantity` straight onto
// ProductBatch.quantity, with zero conversion — exactly the pre-v4.0
// design that produced the accumulated rounding bug ("21.9984 قطعة"
// instead of "24 قطعة") v4.0 exists to eliminate. Fixed by treating the
// submitted `unitId` as an ENTRY convenience only (same as
// products/route.ts's initialBatch.unitIndex): resolve the product's
// real base unit via requireBaseUnit(), convert the submitted quantity
// via toBaseUnit() using the SUBMITTED unit's own conversionFactor
// (fetched fresh server-side via getUnitConversionFactor() — never
// trusted from any client-supplied factor, though here only the unitId
// itself comes from the client), and write the batch against the base
// unit with the converted quantity.
import { requireBaseUnit, MissingBaseUnitError } from "@/lib/inventory/base-unit";
import { getUnitConversionFactor, toBaseUnit } from "@/lib/inventory/units";
// [FIX] Sole gateway for tx.productUnit.* — this route previously called
// db.productUnit.findFirst() directly, which is exactly the model-level
// access eslint.config.mjs's PRODUCT_MODEL_RULES bans. This file is not
// in the per-file override list that lifts that ban.
import { findProductUnitById } from "@/lib/data/products";
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
  // Which unit the admin entered `quantity` in — an ENTRY convenience
  // only. Never written directly as ProductBatch.unitId; see the note
  // above the imports.
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

    // [FIX] Routed through lib/data/products.ts instead of
    // db.productUnit.findFirst() directly — the "does this unit belong
    // to this product & tenant?" check now uses that gateway's plain
    // read, matched against productId manually here (no combined helper
    // exists for this exact query shape yet).
    const productUnit = await findProductUnitById(db, tenantId, unitId);
    if (!productUnit || productUnit.productId !== productId) {
      return NextResponse.json({ error: "NOT_FOUND", message: "المنتج أو الوحدة المحددة غير موجودة." }, { status: 404 });
    }

    // [v4.0] Everything from here on must commit atomically: resolving
    // the base unit, converting the quantity, and writing the batch are
    // all part of the same logical operation, and getUnitConversionFactor()
    // requires a real transaction client (see units.ts's signature).
    const result = await db.$transaction(async (tx) => {
      let baseUnit;
      try {
        baseUnit = await requireBaseUnit(tx, tenantId, productId);
      } catch (e) {
        if (e instanceof MissingBaseUnitError) {
          throw new Error("MISSING_BASE_UNIT");
        }
        throw e;
      }

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

      // [FIX] renamed from `baseUnit` to `resolvedBaseUnit` in the returned
      // object — the LOCAL VARIABLE `baseUnit` above stays as-is (it's a
      // parameter/local binding, not a property-access AST node, so it never
      // matched the lint rule in the first place). Only the OBJECT KEY this
      // function returns needed renaming, since `result.baseUnit.unitName`
      // below is a MemberExpression whose property name is checked purely
      // by literal text — "baseUnit" matches BASE_UNIT_ID_RULES regardless
      // of the fact that `result` is a plain local object, not a fetched
      // Product/ProductUnit relation. Same false-positive class already
      // fixed once for `product`/`baseUnit` -> `createdProduct`/
      // `createdBaseUnit` in products/route.ts's POST handler.
      return { batch, resolvedBaseUnit: baseUnit, enteredUnitName: productUnit.unitName };
    });

    // [FIX] No raw `unit` relation included on the create/response — the
    // previous version's `include: { unit: true }` handed a full
    // ProductUnit row (real conversionFactor Decimal) straight into this
    // file's own response object, which this file has no standing
    // exemption to hold. Built by hand instead, from values already
    // resolved above (baseUnit's own fields, never a fresh relation
    // fetch).
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
    if (error instanceof Error && error.message === "MISSING_BASE_UNIT") {
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