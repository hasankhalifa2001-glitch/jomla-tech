import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getTenantDb } from "@/lib/db/tenant-scope";
import { previewFifoAllocation } from "@/lib/inventory/fifo";
// [FIX — real v4.0 architectural gap] previewFifoAllocation operates
// purely on ProductBatch.quantity figures, which are always base-unit
// numbers under v4.0 (see T1's Unit Conversion Architecture). This
// route previously passed the SUBMITTED unitId (the sale/display unit
// the user picked, e.g. "طرد") and the raw requestedQty straight
// through, with no conversion — but every ProductBatch.unitId is always
// the product's base unit now, so a preview against a non-base unitId
// would look for batches under the wrong unit entirely, and an
// unconverted requestedQty would be off by exactly the conversion
// factor whenever the previewed unit isn't the base unit. Fixed by
// resolving the real base unit via requireBaseUnit() and converting the
// submitted quantity via toBaseUnit(), using the SUBMITTED unit's own
// conversionFactor (fetched fresh server-side via
// getUnitConversionFactor() — never trusted from any client-supplied
// factor) — the same corrected pattern T4c/T5/the batch-creation route
// already apply.
import { requireBaseUnit, MissingBaseUnitError } from "@/lib/inventory/base-unit";
import { getUnitConversionFactor, toBaseUnit } from "@/lib/inventory/units";
// [FIX] Sole gateway for tx.product.* / tx.productUnit.* — this route
// previously called db.product.findFirst() / db.productUnit.findFirst()
// directly, which is exactly the model-level access
// eslint.config.mjs's PRODUCT_MODEL_RULES bans. This file is not in the
// per-file override list that lifts that ban.
import { findProductById, findProductUnitById } from "@/lib/data/products";
import { Prisma } from "@prisma/client";
import { z } from "zod";

const DECIMAL_STRING_REGEX = /^-?\d{1,14}(\.\d{1,4})?$/;

// [FIX] Previously `z.union([z.number(), z.string()]).transform((val) =>
// new Decimal(val).toNumber())` — the final `.toNumber()` converts back
// to a native JS double regardless of how the value arrived, reopening
// exactly the precision hole the project's decimal.js-everywhere rule
// exists to close for large/fractional quantities. `requestedQty` now
// accepts a decimal string only, validated by the same regex used
// elsewhere for quantity/decimal fields — never coerced to `number`
// anywhere in this handler.
const fifoPreviewSchema = z.object({
  productId: z.string().min(1, "معرف المنتج مطلوب"),
  unitId: z.string().min(1, "معرف الوحدة مطلوب"),
  requestedQty: z
    .string()
    .trim()
    .regex(DECIMAL_STRING_REGEX, "صيغة الكمية المطلوبة غير صالحة.")
    .refine((val) => Number(val) > 0, {
      message: "الكمية المطلوبة يجب أن تكون أكبر من الصفر",
    }),
});

export async function POST(req: Request) {
  try {
    const session = await auth();
    if (!session || !session.user || !session.user.tenantId) {
      return NextResponse.json({ error: "UNAUTHORIZED", message: "يرجى تسجيل الدخول أولاً." }, { status: 401 });
    }

    const tenantId = session.user.tenantId;
    const body = await req.json();
    const validation = fifoPreviewSchema.safeParse(body);

    if (!validation.success) {
      return NextResponse.json(
        {
          error: "VALIDATION_ERROR",
          message: validation.error.issues[0]?.message || "بيانات طلب المعاينة غير صالحة.",
        },
        { status: 400 }
      );
    }

    const { productId, unitId, requestedQty } = validation.data;
    const db = getTenantDb(tenantId);

    // [FIX] Routed through lib/data/products.ts, tenant-scoped.
    const product = await findProductById(db, tenantId, productId);
    if (!product) {
      return NextResponse.json(
        { error: "NOT_FOUND", message: "المنتج المحدد غير موجود." },
        { status: 404 }
      );
    }

    // [FIX] Routed through lib/data/products.ts, tenant-scoped, and
    // matched against productId explicitly (findProductUnitById alone
    // only scopes by tenantId — the productId match still needs to
    // happen here, same as this project's other routes doing this same
    // check).
    const submittedUnit = await findProductUnitById(db, tenantId, unitId);
    if (!submittedUnit || submittedUnit.productId !== productId) {
      return NextResponse.json(
        { error: "VALIDATION_ERROR", message: "وحدة القياس المحددة غير صالحة لهذا المنتج." },
        { status: 400 }
      );
    }

    // [FIX — the real architectural gap] Resolve the product's actual
    // base unit and convert the submitted quantity into it, using the
    // SUBMITTED unit's own conversionFactor (never the base unit's,
    // which is always 1 and would apply no conversion at all — see
    // units.ts's toBaseUnit() direction rules). previewFifoAllocation
    // is called against the BASE unit id, since that is the only unit
    // any ProductBatch is ever scoped to under v4.0.
    let baseUnit;
    try {
      baseUnit = await requireBaseUnit(db, tenantId, productId);
    } catch (e) {
      if (e instanceof MissingBaseUnitError) {
        return NextResponse.json(
          {
            error: "MISSING_BASE_UNIT",
            message: "هذا المنتج بدون وحدة أساسية محددة (بيانات قديمة تحتاج تصحيح) — الرجاء التواصل مع الدعم الفني.",
          },
          { status: 409 }
        );
      }
      throw e;
    }

    const submittedUnitFactor = await getUnitConversionFactor(db, tenantId, unitId);
    const requestedQtyInBaseUnit = toBaseUnit(requestedQty, submittedUnitFactor);

    // Read-only FIFO preview execution:
    // Never opens a transaction, never issues locks, never writes to database.
    const resolution = await previewFifoAllocation({
      tenantId,
      productId,
      unitId: baseUnit.id,
      requestedQty: requestedQtyInBaseUnit.toString(),
    });

    // Derive explicit shortfall indicators from the core allocation plan
    const fullyAllocated = resolution.isSufficient;
    const shortfallQty = resolution.remainingQty;

    return NextResponse.json({
      success: true,
      resolution: {
        ...resolution,
        fullyAllocated,
        shortfallQty,
      },
    });
  } catch (error) {
    // Distinguish Prisma DB/infrastructure failures from expected business logic validation errors
    const isInfrastructureError =
      error instanceof Prisma.PrismaClientKnownRequestError ||
      error instanceof Prisma.PrismaClientInitializationError ||
      error instanceof Prisma.PrismaClientRustPanicError ||
      error instanceof Prisma.PrismaClientUnknownRequestError;

    const message =
      error instanceof Error
        ? error.message
        : "حدث خطأ أثناء معاينة سحب المخزون.";

    console.error("Error running FIFO preview:", error);

    if (isInfrastructureError) {
      return NextResponse.json(
        { error: "SERVER_ERROR", message: "حدث خطأ أثناء معاينة سحب المخزون." },
        { status: 500 }
      );
    }

    return NextResponse.json(
      { error: "FIFO_RESOLUTION_ERROR", message },
      { status: 400 }
    );
  }
}