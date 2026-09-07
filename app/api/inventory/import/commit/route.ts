import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { commitCsvImport } from "@/lib/inventory/csv-parser";
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

// [FIX] Field names below were out of sync with lib/inventory/csv-parser.ts
// after that file's own currency-safety fix renamed `priceUSD` →
// `priceWholesale` (NewProductImportData) and `currentPriceUSD`/
// `newPriceUSD` → `currentPriceWholesale`/`newPriceWholesale` plus added a
// required `pricingCurrency` field (PriceUpdateImportData). The previous
// version of this schema still validated against the OLD, removed field
// names — meaning every real commit request built from the current
// preview endpoint's actual response shape would fail Zod validation
// outright (a required `newPriceUSD`/`priceUSD` field that no longer
// exists anywhere in the real payload), breaking the entire CSV import
// commit path silently behind a generic "VALIDATION_ERROR" response. Kept
// in exact sync with NewProductImportData / PriceUpdateImportData in
// lib/inventory/csv-parser.ts — update both together if that file's shape
// ever changes again.
const newProductRowSchema = z.object({
  lineNumber: z.number(),
  barcode: z.string().optional(),
  name: z.string().min(1, "اسم المنتج مطلوب"),
  category: z.string().optional(),
  unitName: z.string().min(1, "اسم الوحدة مطلوب"),
  conversionFactor: z.number().positive("معامل التحويل يجب أن يكون رقماً موجباً"),
  priceWholesale: z.number().positive("السعر يجب أن يكون رقماً موجباً"),
  priceRetail: z.number().min(0).optional(),
  pricingCurrency: z.enum(["SYP", "USD"]).optional(),
  batchNumber: z.string().optional(),
  quantity: z.number().min(0).optional(),
  expiryDate: z.string().optional(),
});

const priceUpdateRowSchema = z.object({
  lineNumber: z.number(),
  barcode: z.string().min(1, "الباركود مطلوب لتحديث السعر"),
  productName: z.string(),
  unitName: z.string(),
  currentPriceWholesale: z.number(),
  newPriceWholesale: z.number().positive("السعر يجب أن يكون رقماً موجباً"),
  // [FIX] Was missing entirely. `pricingCurrency` is a required field on
  // PriceUpdateImportData as of csv-parser.ts's currency-safety fix — the
  // preview endpoint always sends it, and its presence here is what would
  // let a future version of this route re-validate currency consistency
  // at commit time too (see the currency-safety note in csv-parser.ts
  // about the small race window between preview and commit).
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

    // NOT wrapped in prisma.$transaction(...) — commitCsvImport does not
    // need an outer transaction: each row's product/unit/batch creation,
    // and each price update, is already atomic on its own (see that
    // function's own docstring). Passing the plain `prisma` client makes
    // each row's success or failure genuinely independent.
    const result = await commitCsvImport(prisma, tenantId, {
      newProducts,
      priceUpdates,
    });

    // [FIX] Previously only checked `failedNewProducts.length` and
    // `skippedPriceUpdates` — missing `failedPriceUpdates`, the array
    // csv-parser.ts's own per-row error-isolation fix introduced for price
    // updates that threw an unexpected error (as opposed to `skipped`,
    // which specifically means "0 rows matched — the unitId no longer
    // resolves"). Without this, a price update that failed for a real
    // reason (e.g. a transient DB error on that one row) was reported back
    // to the merchant as a clean, fully-successful import.
    const hasFailures =
      result.failedNewProducts.length > 0 ||
      result.skippedPriceUpdates > 0 ||
      result.failedPriceUpdates.length > 0;

    const baseMessage = `تم تنفيذ الاستيراد: تم إنشاء ${result.createdProductsCount} منتج جديد وتحديث ${result.updatedPricesCount} سعر.`;
    const failureParts: string[] = [];
    if (result.failedNewProducts.length > 0) {
      failureParts.push(`تعذّر إنشاء ${result.failedNewProducts.length} منتج بسبب تعارض في الباركود`);
    }
    if (result.skippedPriceUpdates > 0) {
      failureParts.push(`تم تجاهل ${result.skippedPriceUpdates} تحديث سعر (الوحدة غير موجودة)`);
    }
    // [FIX] New message segment for failedPriceUpdates — previously silent.
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