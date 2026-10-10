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
// The ONE shared "write one ProductBatch row" implementation — same helper
// the single-batch screen and product-creation's `initialBatch` use.
import Decimal from "decimal.js";
import { Prisma } from "@prisma/client";
import {
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
// [v4.7] The receiving gateway — THE one path that writes a ProductReceipt;
// it also constructs the ONE shared batchNumber for the whole submission.
import { createReceiptWithBatches, purchaseDateSchema, supplierNameSchema } from "@/lib/data/receipts";
import { z } from "zod";

// Each line costs ~4 sequential queries inside ONE transaction; Prisma's
// default interactive-transaction timeout is 5s. Cap the lines and raise the
// timeout explicitly so a legitimate large receipt cannot fail half-way.
const MAX_RECEIPT_ITEMS = 100;
const RECEIPT_TRANSACTION_TIMEOUT_MS = 30_000;

const AMOUNT_REGEX = /^\d{1,14}(\.\d{1,4})?$/;

// Safe against a malformed string: zod still runs .refine() after a failed
// regex, and new Decimal("abc") would throw -> 500.
function isPositiveAmount(value: string): boolean {
  if (!AMOUNT_REGEX.test(value)) return false;
  try { return new Decimal(value).gt(0); } catch { return false; }
}

/**
 * One line item. Validated INDEPENDENTLY and in full. The stored
 * costPricePerBaseUnit is DERIVED from quantity + totalCost by
 * createBatchRow() and is never accepted from the client.
 */
const receiptItemSchema = z.object({
  productId: z.string().min(1, "معرف المنتج مطلوب في كل سطر."),
  unitId: z.string().min(1, "معرف الوحدة مطلوب في كل سطر."),
  quantity: z.string().trim()
    .regex(AMOUNT_REGEX, "صيغة الكمية غير صالحة (مثال: 10 أو 10.5).")
    .refine(isPositiveAmount, { message: "الكمية يجب أن تكون أكبر من صفر في كل سطر." }),
  totalCost: z.string().trim()
    .regex(AMOUNT_REGEX, "صيغة إجمالي التكلفة غير صالحة (مثال: 9000 أو 9000.5).")
    .refine(isPositiveAmount, { message: "لا يمكن قبول سطر بتكلفة صفر — إجمالي تكلفة الشراء يجب أن يكون أكبر من صفر في كل سطر." }),
  // [FIX] Shared schema: real calendar dates only ("2026-02-31" is rejected).
  expiryDate: expiryDateSchema,
});

const createReceiptSchema = z.object({
  // The merchant-supplied SUFFIX only, entered ONCE for the whole submission.
  batchNumberSuffix: batchNumberSuffixSchema,
  items: z
    .array(receiptItemSchema)
    .min(1, "يجب إضافة صنف واحد على الأقل إلى الاستلام.")
    .max(MAX_RECEIPT_ITEMS, `الحد الأقصى ${MAX_RECEIPT_ITEMS} صنف في الاستلام الواحد.`)
    .superRefine((items, ctx) => {
      // The same product + unit + expiry twice in ONE receipt is almost
      // certainly a data-entry slip (it would create two identical lots under
      // one batch number). The same product with a DIFFERENT expiry date is a
      // legitimate second lot and is allowed.
      const seen = new Set<string>();
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const key = `${item.productId}|${item.unitId}|${item.expiryDate ?? ""}`;
        if (seen.has(key)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [i],
            message: `السطر ${i + 1} مكرر: نفس المنتج والوحدة وتاريخ الانتهاء موجودة بسطر سابق.`,
          });
          return;
        }
        seen.add(key);
      }
    }),
  // [v4.7] Replaces the old TRANSIENT `purchaseDateNote` (display-only, never
  // persisted): a REAL persisted goods-receiving date — a Damascus business
  // day, required, never in the future — plus an optional supplier (≤120
  // chars). Both are stored on the ProductReceipt this submission creates.
  purchaseDate: purchaseDateSchema,
  supplierName: supplierNameSchema,
});

export async function POST(req: Request) {
  try {
    const session = await auth();
    if (!session || !session.user || !session.user.tenantId) {
      return NextResponse.json({ error: "UNAUTHORIZED", message: "يرجى تسجيل الدخول أولاً." }, { status: 401 });
    }

    // Multi-product receipt is ADMIN-only; rides the same inventory:mutate gate.
    assertRolePermission(session.user.role, "inventory:mutate");

    // Security boundary: fresh subscription status from the DB.
    await assertTenantWritable(session.user.tenantId);

    const tenantId = session.user.tenantId;
    const db = getTenantDb(tenantId);

    // [FIX] Malformed / non-object body -> 400, not 500.
    let body
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "INVALID_JSON", message: "صيغة الطلب غير صالحة." }, { status: 400 });
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "INVALID_JSON", message: "صيغة الطلب غير صالحة." }, { status: 400 });
    }

    // Checked on the RAW body, before schema validation — neither at the top
    // level nor on any single line item may a full batchNumber be smuggled in.
    const rawItems: unknown[] = Array.isArray(body?.items) ? body.items : [];
    const attemptsDirectBatchNumber =
      body?.batchNumber !== undefined ||
      rawItems.some(
        (item) =>
          !!item &&
          typeof item === "object" &&
          (item as Record<string, unknown>).batchNumber !== undefined
      );
    const clientComputed =
      findClientComputedBatchField(body) ??
      rawItems.map((item) => findClientComputedBatchField(item)).find((f) => f !== null) ??
      null;
    if (clientComputed) {
      return NextResponse.json(
        { error: "CLIENT_COMPUTED_FIELD_NOT_ALLOWED", message: `الحقل "${clientComputed}" يُحسب على الخادم ولا يُقبل من العميل.` },
        { status: 400 }
      );
    }
    if (attemptsDirectBatchNumber) {
      return NextResponse.json(
        {
          error: "BATCH_NUMBER_DIRECT_SET_NOT_ALLOWED",
          message:
            "لا يمكن تحديد رقم الدفعة بالكامل مباشرة — يُبنى تلقائياً من تاريخ اليوم بالإضافة إلى الجزء الذي تدخله.",
        },
        { status: 400 }
      );
    }

    const validation = createReceiptSchema.safeParse(body);
    if (!validation.success) {
      return NextResponse.json(
        {
          error: "VALIDATION_ERROR",
          message: validation.error.issues[0]?.message || "بيانات الاستلام غير صالحة.",
        },
        { status: 400 }
      );
    }

    const { batchNumberSuffix, items, purchaseDate, supplierName } = validation.data;

    // ONE transaction for the whole submission: the receiving gateway writes
    // the ProductReceipt FIRST, then each line's ProductBatch — all top-level
    // calls, so a failure on any line leaves NO receipt and NO partial
    // batches. The gateway constructs the batchNumber exactly ONCE, so every
    // row shares one identical date prefix (business date, not purchaseDate).
    const result = await db.$transaction(
      async (tx) =>
        createReceiptWithBatches(tx, {
          tenantId,
          userId: session.user.id,
          purchaseDate,
          supplierName,
          batchNumberSuffix,
          lines: items.map((item) => ({
            productId: item.productId,
            entryUnitId: item.unitId,
            quantity: item.quantity,
            totalCost: item.totalCost,
            expiryDate: item.expiryDate ?? null,
          })),
        }),
      { timeout: RECEIPT_TRANSACTION_TIMEOUT_MS }
    );

    return NextResponse.json({
      success: true,
      batchNumber: result.batchNumber,
      createdCount: result.created.length,
      receiptId: result.receiptId,
      batches: result.created.map((row, index) => ({
        id: row.batchId,
        receiptId: result.receiptId,
        // The gateway returns batch rows only — the per-line product/expiry
        // come straight back off the validated request items (same order).
        productId: items[index].productId,
        // Always the base unit the batch is counted in.
        unitId: row.resolvedBaseUnitId,
        batchNumber: row.batchNumber,
        // [FIX] Decimal strings, as stored — never Number().
        quantity: row.baseQuantity,
        costPricePerBaseUnit: row.costPricePerBaseUnit,
        totalCostSYP: row.totalCostSYP,
        expiryDate: items[index].expiryDate ? new Date(items[index].expiryDate as string) : null,
        baseUnitName: row.resolvedBaseUnitName,
        enteredUnitName: row.enteredUnitName,
      })),
      message: `تم تسجيل استلام ${result.created.length} دفعة بنجاح تحت رقم الدفعة ${result.batchNumber}.`,
    });
  } catch (error) {
    // [v4.7] Backstop: the route schema validates first, but the receiving
    // gateway re-validates — a ZodError escaping it is a 400, not a 500.
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "VALIDATION_ERROR", message: error.issues[0]?.message || "بيانات الاستلام غير صالحة." },
        { status: 400 }
      );
    }
    if (error instanceof ForbiddenRoleError) {
      return forbiddenRoleResponse(error);
    }
    if (error instanceof SubscriptionLockedError) {
      return subscriptionLockedResponse(error);
    }
    if (error instanceof UnitNotBelongingToProductError) {
      return NextResponse.json(
        { error: "NOT_FOUND", message: "المنتج أو الوحدة المحددة غير موجودة." },
        { status: 404 }
      );
    }
    // [FIX] findUniqueOrThrow raises P2025 for a missing row -> 404, not 500.
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
      return NextResponse.json(
        { error: "ENTRY_UNIT_INACTIVE", message: "هذه الوحدة متوقفة ولا يمكن الاستلام بها." },
        { status: 400 }
      );
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
    console.error("Error creating multi-product batch receipt:", error);
    return NextResponse.json(
      { error: "SERVER_ERROR", message: "حدث خطأ أثناء تسجيل استلام البضاعة." },
      { status: 500 }
    );
  }
}