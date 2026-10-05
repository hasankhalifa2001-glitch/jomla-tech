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
// [v4.0 / v4.4] ProductBatch.unitId is ALWAYS the product's base unit. The
// submitted `unitId` is an ENTRY convenience only: everything (base-unit
// resolution, quantity conversion, cost derivation, batchNumber
// construction, the write itself) lives in ONE shared implementation —
// lib/inventory/batch-creation.ts's createBatchRow().
import Decimal from "decimal.js";
import { Prisma } from "@prisma/client";
import {
  createBatchRow,
  findClientComputedBatchField,
  batchNumberSuffixSchema,
  expiryDateSchema,
  InactiveEntryUnitError,
  InvalidBatchNumberError,
  InvalidExpiryDateError,
  UnitNotBelongingToProductError,
} from "@/lib/inventory/batch-creation";
import { InvalidCostInputError } from "@/lib/inventory/units";
import { MissingBaseUnitError } from "@/lib/inventory/base-unit";
import { z } from "zod";

// Quantity and totalCost are decimal STRINGS (never z.number()): a JS double
// would silently lose precision on Decimal(18,4) values. The submitted field
// is `totalCost` — the TOTAL paid for the whole quantity, in the ENTERED
// unit. The per-base-unit cost is derived ONCE on the server by
// createBatchRow() (via costFromTotal()); a client sending
// `costPricePerBaseUnit` is rejected by findClientComputedBatchField().
const AMOUNT_REGEX = /^\d{1,14}(\.\d{1,4})?$/;

// Safe against a malformed string: zod still runs .refine() after a failed
// regex, and new Decimal("abc") would throw -> 500.
function isPositiveAmount(value: string): boolean {
  if (!AMOUNT_REGEX.test(value)) return false;
  try { return new Decimal(value).gt(0); } catch { return false; }
}

const createBatchSchema = z.object({
  productId: z.string().min(1, "معرف المنتج مطلوب"),
  unitId: z.string().min(1, "معرف الوحدة مطلوب"),
  // [FIX] Shared schemas — the single source of truth for suffix/date rules
  // (real calendar dates only; suffix max length and no control characters).
  batchNumberSuffix: batchNumberSuffixSchema,
  quantity: z
    .string()
    .trim()
    .regex(AMOUNT_REGEX, "صيغة الكمية غير صالحة (مثال: 10 أو 10.5).")
    .refine(isPositiveAmount, { message: "الكمية يجب أن تكون أكبر من صفر." }),
  totalCost: z
    .string()
    .trim()
    .regex(AMOUNT_REGEX, "صيغة إجمالي التكلفة غير صالحة (مثال: 9000 أو 9000.5).")
    .refine(isPositiveAmount, { message: "إجمالي تكلفة الشراء يجب أن يكون أكبر من صفر." }),
  expiryDate: expiryDateSchema,
});

export async function POST(req: Request) {
  try {
    const session = await auth();
    if (!session || !session.user || !session.user.tenantId) {
      return NextResponse.json({ error: "UNAUTHORIZED", message: "يرجى تسجيل الدخول أولاً." }, { status: 401 });
    }

    // Role Capability Matrix: adding batches is ADMIN-only.
    assertRolePermission(session.user.role, "inventory:mutate");

    // Security boundary: fresh subscription status from the DB.
    await assertTenantWritable(session.user.tenantId);

    const tenantId = session.user.tenantId;
    const db = getTenantDb(tenantId);

    // [FIX] A malformed / non-object body is a client error (400), not a 500.
    let body
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "INVALID_JSON", message: "صيغة الطلب غير صالحة." }, { status: 400 });
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "INVALID_JSON", message: "صيغة الطلب غير صالحة." }, { status: 400 });
    }

    // Checked on the RAW body, before schema validation, so a direct API
    // call can never smuggle a full pre-formatted batchNumber through.
    if (body.batchNumber !== undefined) {
      return NextResponse.json(
        {
          error: "BATCH_NUMBER_DIRECT_SET_NOT_ALLOWED",
          message:
            "لا يمكن تحديد رقم الدفعة بالكامل مباشرة — يُبنى تلقائياً من تاريخ اليوم بالإضافة إلى الجزء الذي تدخله.",
        },
        { status: 400 }
      );
    }

    const clientComputed = findClientComputedBatchField(body);
    if (clientComputed) {
      return NextResponse.json(
        {
          error: "CLIENT_COMPUTED_FIELD_NOT_ALLOWED",
          message: `الحقل "${clientComputed}" يُحسب على الخادم ولا يُقبل من العميل.`,
        },
        { status: 400 }
      );
    }

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

    const { productId, unitId, batchNumberSuffix, quantity, totalCost, expiryDate } = validation.data;

    const result = await db.$transaction(async (tx) =>
      createBatchRow(tx, {
        tenantId,
        productId,
        entryUnitId: unitId,
        batchNumberSuffix,
        quantityInEntryUnit: quantity,
        totalCost,
        expiryDate: expiryDate ?? null,
      })
    );

    const responseBatch = {
      id: result.batchId,
      productId,
      unitId: result.resolvedBaseUnitId,
      batchNumber: result.batchNumber,
      // [FIX] Decimal string, as stored — never Number(): a Decimal(18,4)
      // value can exceed what a JS double represents exactly.
      quantity: result.baseQuantity,
      costPricePerBaseUnit: result.costPricePerBaseUnit, // decimal string, as stored
      expiryDate: expiryDate ? new Date(expiryDate) : null,
      createdAt: new Date(),
      baseUnitName: result.resolvedBaseUnitName,
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
    // The submitted unit doesn't belong to the submitted product (or either
    // does not exist).
    if (error instanceof UnitNotBelongingToProductError) {
      return NextResponse.json(
        { error: "NOT_FOUND", message: "المنتج أو الوحدة المحددة غير موجودة." },
        { status: 404 }
      );
    }
    // [FIX] findUniqueOrThrow inside requireBaseUnit()/getUnitConversionFactor()
    // raises P2025 when a row disappears (or never existed) — a 404, not a 500.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
      return NextResponse.json(
        { error: "NOT_FOUND", message: "المنتج أو الوحدة المحددة غير موجودة." },
        { status: 404 }
      );
    }
    if (error instanceof InvalidCostInputError) {
      return NextResponse.json({ error: "INVALID_COST_INPUT", message: error.message }, { status: 400 });
    }
    if (error instanceof InvalidBatchNumberError) {
      return NextResponse.json({ error: "INVALID_BATCH_NUMBER", message: error.message }, { status: 400 });
    }
    if (error instanceof InvalidExpiryDateError) {
      return NextResponse.json({ error: "INVALID_EXPIRY_DATE", message: error.message }, { status: 400 });
    }
    if (error instanceof InactiveEntryUnitError) {
      return NextResponse.json({ error: "ENTRY_UNIT_INACTIVE", message: "هذه الوحدة متوقفة ولا يمكن الاستلام بها." }, { status: 400 });
    }
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