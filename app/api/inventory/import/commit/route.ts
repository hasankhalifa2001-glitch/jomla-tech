import { NextResponse } from "next/server";
import { auth } from "@/auth";
// [FIX #3 — critical] This route previously imported the RAW, unscoped
// `prisma` client from "@/lib/db". Per lib/db.ts's own header comment, that
// export is restricted to six narrow, documented categories (registration,
// seed.ts, the authorize() callback, isPlatformAdmin-gated super-admin
// routes, the T4c/fifo.ts shared-transaction-client category, and the
// storefront tenant-by-slug lookup) — this route is none of those. It is
// an ordinary authenticated, tenant-context ADMIN action, exactly the case
// lib/db.ts's header says must use getTenantDb(tenantId) instead. Before
// this fix, EVERY tenant-isolation guarantee for this entire CSV import
// path rested solely on csv-parser.ts's manual `tenantId` filtering on each
// individual query — correct today, but with zero structural backstop if a
// future edit to that file ever missed one. getTenantDb(tenantId)'s Prisma
// Client Extension now auto-injects/re-asserts tenantId on every
// tenant-scoped model operation — including inside the `$transaction`
// callback csv-parser.ts opens per row, since the extension is preserved
// through `$transaction` (confirmed via lib/db.ts's own category-5 note:
// the extended transaction client's type is deliberately NOT
// `Prisma.TransactionClient`-compatible, specifically because it carries
// the extension). This closes the gap without changing any of
// csv-parser.ts's existing per-row logic.
import { getTenantDb } from "@/lib/db";
import { commitCsvImport, DECIMAL_STRING_REGEX, STRICT_DATE_REGEX } from "@/lib/inventory/csv-parser";
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

const positiveDecimalSchema = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim())
  .refine((v) => DECIMAL_STRING_REGEX.test(v) && Number(v) > 0, {
    message: "يجب أن يكون رقماً موجباً أكبر من الصفر",
  });

const nonNegativeDecimalSchema = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim())
  .refine((v) => DECIMAL_STRING_REGEX.test(v) && Number(v) >= 0, {
    message: "يجب أن يكون رقماً غير سالب (صفر أو أكثر)",
  });

// [FIX — v4.0 base-unit invariant] A "new product" CSV row's unit ALWAYS
// becomes that product's base unit — see MASTER-SPEC v4.0's T3d §5.1
// ("Importing a 'new product' row creates Product.baseUnitId equal to
// that row's unit automatically, following the same mechanism as T3a's
// Section 0") and T3a §0 ("this first unit automatically becomes the
// product's physical base unit... conversionFactor: 1... the UI does
// not expose an editable conversionFactor field for this first unit at
// all"). A base unit's conversionFactor is ALWAYS exactly 1 — the same
// invariant lib/inventory/units.ts's BASE_UNIT_CONVERSION_FACTOR /
// isReservedBaseUnitFactor() / assertIsValidBaseUnitFactor() enforce
// everywhere else a base unit is created.
//
// Previously, `newProductRowSchema.conversionFactor` was plain
// `positiveDecimalSchema` — it accepted ANY positive value straight from
// the CSV column (e.g. "24") and forwarded it verbatim to
// commitCsvImport(). If csv-parser.ts uses that raw value when creating
// the new product's base ProductUnit, this would silently corrupt the
// exact base-unit invariant the whole v4.0 revision exists to protect —
// reopening the historical "21.9984 قطعة" rounding bug, just via the CSV
// path instead of the UI path. Fixed: the value is VALIDATED, not
// silently overwritten. Blank/omitted defaults to "1" (a merchant who
// leaves the column empty for a brand-new product gets the correct
// behavior for free); any other explicit value is REJECTED with an
// actionable message — silently coercing "24" to "1" would let a
// merchant believe their pack size was recorded when it wasn't.
const newProductConversionFactorSchema = z
  .union([z.string(), z.number()])
  .optional()
  .transform((v) => (v === undefined || String(v).trim() === "" ? "1" : String(v).trim()))
  .refine((v) => DECIMAL_STRING_REGEX.test(v) && Number(v) > 0, {
    message: "معامل التحويل غير صالح.",
  })
  .refine((v) => Number(v) === 1, {
    message:
      "لا يمكن تحديد معامل تحويل مختلف عن 1 لمنتج جديد — أول وحدة تُدخل لمنتج جديد تصبح تلقائياً الوحدة الأساسية (معامل التحويل = 1 دائماً). لإضافة وحدة تعبئة أخرى (مثل طرد أو كرتونة) بمعامل تحويل مختلف، أضفها لاحقاً من شاشة تعديل المنتج بعد إنشائه.",
  });

// [FIX #2 — defensive] A frontend that omits an optional field by sending
// an empty string ("") rather than truly dropping the key from the JSON
// body is a common pattern (e.g. a controlled <input> bound to "" by
// default). Without this normalization, "" reaches STRICT_DATE_REGEX,
// fails it, and the ENTIRE commit request is rejected with 400 — even
// though every other row in the same payload is perfectly valid and the
// merchant's intent was clearly "no expiry date for this row." Empty
// string is treated identically to an absent field: normalized to
// `undefined` BEFORE the date-shape regex ever sees it. A non-empty but
// malformed value (e.g. "31-12-2026") is still rejected with the same
// specific, actionable message as before — this only widens what counts
// as "field not provided," it does not loosen the format check itself.
const expiryDateSchema = z
  .string()
  .optional()
  .transform((v) => (v === "" ? undefined : v))
  .pipe(
    z
      .string()
      .regex(STRICT_DATE_REGEX, "تاريخ الانتهاء يجب أن يكون بالصيغة YYYY-MM-DD (مثال: 2026-12-31)")
      .refine((v) => !isNaN(new Date(v).getTime()), {
        message: "تاريخ الانتهاء غير صالح",
      })
      .optional()
  );

const newProductRowSchema = z
  .object({
    lineNumber: z.number(),
    barcode: z.string().optional(),
    name: z.string().min(1, "اسم المنتج مطلوب"),
    category: z.string().optional(),
    unitName: z.string().min(1, "اسم الوحدة مطلوب"),
    // [FIX] Was `positiveDecimalSchema` — see the dedicated schema above
    // for why this must be locked to "1" for a brand-new product's base
    // unit, not any arbitrary positive value.
    conversionFactor: newProductConversionFactorSchema,
    priceWholesale: positiveDecimalSchema,
    priceRetail: nonNegativeDecimalSchema.optional(),
    pricingCurrency: z.enum(["SYP", "USD"]).optional(),
    initialBatchNumber: z.string().optional(),
    initialQuantity: nonNegativeDecimalSchema.optional(),
    batchNumber: z.string().optional(),
    quantity: nonNegativeDecimalSchema.optional(),
    expiryDate: expiryDateSchema,
  })
  .refine((data) => !!(data.initialBatchNumber || data.batchNumber), {
    message: "رقم الدفعة الأولى مطلوب",
    path: ["initialBatchNumber"],
  })
  .refine(
    (data) => data.initialQuantity !== undefined || data.quantity !== undefined,
    {
      message: "الكمية الأولية مطلوبة",
      path: ["initialQuantity"],
    }
  )
  // [FIX #4 — compile error] The two .refine() calls above only VALIDATE at
  // runtime — Zod's type system can't narrow z.infer's output based on a
  // refine's boolean condition, so TypeScript still saw
  // initialBatchNumber/initialQuantity as optional even on a row that had
  // already passed both refines. That mismatched NewProductImportData's
  // actual shape (both fields required, non-optional) in csv-parser.ts,
  // which is what produced the "Type 'string | undefined' is not
  // assignable to type 'string'" error at the commitCsvImport(db, tenantId,
  // { newProducts, priceUpdates }) call site. This transform runs only
  // AFTER both refines have already passed, so the fallback here is
  // runtime-safe, not just a type-level assertion: it collapses each alias
  // pair into the single guaranteed field NewProductImportData expects,
  // producing an output type that matches it exactly instead of asking
  // TypeScript to trust a validation it structurally cannot see.
  .transform((data) => ({
    ...data,
    initialBatchNumber: (data.initialBatchNumber || data.batchNumber)!,
    initialQuantity: (data.initialQuantity ?? data.quantity)!,
  }));

const priceUpdateRowSchema = z.object({
  lineNumber: z.number(),
  barcode: z.string().min(1, "الباركود مطلوب لتحديث السعر"),
  productName: z.string(),
  unitName: z.string(),
  currentPriceWholesale: z.union([z.number(), z.string()]),
  newPriceWholesale: positiveDecimalSchema,
  pricingCurrency: z.enum(["SYP", "USD"]),
  unitId: z.string().min(1, "معرف الوحدة مطلوب"),
});

const commitImportSchema = z.object({
  newProducts: z.array(newProductRowSchema).default([]),
  priceUpdates: z.array(priceUpdateRowSchema).default([]),
});

export async function POST(req: Request) {
  try {
    const session = await auth();
    if (!session || !session.user || !session.user.tenantId) {
      return NextResponse.json({ error: "UNAUTHORIZED", message: "يرجى تسجيل الدخول أولاً." }, { status: 401 });
    }

    // ADMIN-only: a bulk import is a catalog-wide operation, same reasoning
    // as manual product creation and the storefront toggle.
    assertRolePermission(session.user.role, "inventory:mutate");

    // Security boundary: check fresh subscription status in DB
    await assertTenantWritable(session.user.tenantId);

    const tenantId = session.user.tenantId;
    const body = await req.json();

    const validation = commitImportSchema.safeParse(body);
    if (!validation.success) {
      return NextResponse.json(
        {
          error: "VALIDATION_ERROR",
          message: validation.error.issues[0]?.message || "بيانات الاستيراد غير صالحة.",
        },
        { status: 400 }
      );
    }

    const { newProducts, priceUpdates } = validation.data;

    if (newProducts.length === 0 && priceUpdates.length === 0) {
      return NextResponse.json(
        { error: "NO_DATA", message: "لا توجد عناصر صالحة للاستيراد." },
        { status: 400 }
      );
    }

    // [FIX #3] Tenant-scoped client, not the raw one — see the import
    // comment above. NOT wrapped in an additional outer $transaction here:
    // commitCsvImport does not need one — each row's product/unit/batch
    // creation, and each price update, is already atomic on its own (see
    // that function's own docstring). Using getTenantDb(tenantId) instead
    // of the raw client makes each row's success or failure genuinely
    // independent AND tenant-safe by construction, not just by manual
    // discipline inside csv-parser.ts.
    const db = getTenantDb(tenantId);
    const result = await commitCsvImport(db, tenantId, {
      newProducts,
      priceUpdates,
    });

    // [FIX #1 — critical] `skippedPriceUpdates` and `failedPriceUpdates` are
    // ARRAYS (see CommitCsvImportResult in csv-parser.ts), not counters.
    // The previous code compared `result.skippedPriceUpdates > 0` — an
    // array compared to a number. JS coerces the array via `.toString()`
    // (e.g. "[object Object],[object Object]" for 2+ entries, or the
    // stringified single object for exactly 1), then that string is
    // coerced to a number for `>`, which is always NaN. `NaN > 0` is
    // ALWAYS false. Net effect: `hasFailures` could never become true
    // because of a skipped price update, and the merchant-facing failure
    // message for skipped price updates could never be appended — an
    // import that silently skipped price-update rows (e.g. because the
    // row meant to create their target unit earlier in the same file had
    // itself failed) was reported back as a clean, fully-successful
    // import. Fixed by reading `.length` on both arrays, as already done
    // correctly for `failedNewProducts` and `failedPriceUpdates` elsewhere
    // in this same block.
    const hasFailures =
      result.failedNewProducts.length > 0 ||
      result.skippedPriceUpdates.length > 0 ||
      result.failedPriceUpdates.length > 0;

    const baseMessage = `تم تنفيذ الاستيراد: تم إنشاء ${result.createdProductsCount} منتج جديد وتحديث ${result.updatedPricesCount} سعر.`;
    const failureParts: string[] = [];
    if (result.failedNewProducts.length > 0) {
      failureParts.push(`تعذّر إنشاء ${result.failedNewProducts.length} منتج بسبب تعارض في الباركود`);
    }
    // [FIX #1, continued] `.length`, not the array itself.
    if (result.skippedPriceUpdates.length > 0) {
      failureParts.push(`تم تجاهل ${result.skippedPriceUpdates.length} تحديث سعر (الوحدة غير موجودة)`);
    }
    if (result.failedPriceUpdates.length > 0) {
      failureParts.push(`تعذّر تنفيذ ${result.failedPriceUpdates.length} تحديث سعر بسبب خطأ غير متوقع`);
    }
    const failureSuffix = failureParts.length > 0 ? ` ${failureParts.join("، ")} — راجع التفاصيل أدناه.` : "";

    return NextResponse.json({
      success: true,
      result,
      message: baseMessage + failureSuffix,
      hasFailures,
    });
  } catch (error) {
    if (error instanceof ForbiddenRoleError) {
      return forbiddenRoleResponse(error);
    }
    if (error instanceof SubscriptionLockedError) {
      return subscriptionLockedResponse(error);
    }
    console.error("Error executing CSV import commit:", error);
    return NextResponse.json({ error: "SERVER_ERROR", message: "حدث خطأ أثناء حفظ بيانات الاستيراد." }, { status: 500 });
  }
}