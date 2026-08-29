import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { commitCsvImport } from "@/lib/inventory/csv-parser";
import { z } from "zod";

// Field names below match NewProductImportData / PriceUpdateImportData in
// lib/inventory/csv-parser.ts exactly — keep them in sync if that file's
// shape changes.
const newProductRowSchema = z.object({
  lineNumber: z.number(),
  barcode: z.string().optional(),
  name: z.string().min(1, "اسم المنتج مطلوب"),
  category: z.string().optional(),
  unitName: z.string().min(1, "اسم الوحدة مطلوب"),
  conversionFactor: z.number().positive("معامل التحويل يجب أن يكون رقماً موجباً"),
  priceUSD: z.number().positive("السعر بالدولار يجب أن يكون رقماً موجباً"),
  batchNumber: z.string().optional(),
  quantity: z.number().min(0).optional(),
  expiryDate: z.string().optional(),
});

const priceUpdateRowSchema = z.object({
  lineNumber: z.number(),
  barcode: z.string(),
  productName: z.string(),
  unitName: z.string(),
  currentPriceUSD: z.number(),
  newPriceUSD: z.number().positive("السعر بالدولار يجب أن يكون رقماً موجباً"),
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
    if (session.user.role !== "ADMIN") {
      return NextResponse.json(
        { error: "FORBIDDEN", message: "استيراد المنتجات بالجملة متاح لمدير المتجر فقط." },
        { status: 403 }
      );
    }

    if (session.user.subscriptionStatus === "EXPIRED" || session.user.subscriptionStatus === "PENDING") {
      return NextResponse.json(
        { error: "SUBSCRIPTION_LOCKED", message: "اشتراكك منتهي أو معلق. لا يمكنك تنفيذ عملية الاستيراد." },
        { status: 403 }
      );
    }

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

    // FIX (critical): NOT wrapped in prisma.$transaction(...). On
    // PostgreSQL, any error inside a transaction — even one caught and
    // handled in application code — leaves that transaction in an aborted
    // state; every subsequent statement on the same transaction then fails
    // too, forcing a full rollback of rows that had already committed.
    // commitCsvImport does not need an outer transaction: each row's
    // product/unit/batch creation, and each price update, is already
    // atomic on its own. Passing the plain `prisma` client makes each
    // row's success or failure genuinely independent.
    const result = await commitCsvImport(prisma, tenantId, {
      newProducts,
      priceUpdates,
    });

    // FIX: previously only checked failedNewProducts.length, silently
    // missing the case where a price update was skipped (its unitId
    // didn't resolve to a real ProductUnit in this tenant — e.g. deleted,
    // or a tampered request between preview and commit). A skipped update
    // is exactly as much a "not fully successful" outcome as a failed
    // product creation and must not be reported as a clean success.
    const hasFailures = result.failedNewProducts.length > 0 || result.skippedPriceUpdates > 0;

    const baseMessage = `تم تنفيذ الاستيراد: تم إنشاء ${result.createdProductsCount} منتج جديد وتحديث ${result.updatedPricesCount} سعر.`;
    const failureParts: string[] = [];
    if (result.failedNewProducts.length > 0) {
      failureParts.push(`تعذّر إنشاء ${result.failedNewProducts.length} منتج بسبب تعارض في الباركود`);
    }
    if (result.skippedPriceUpdates > 0) {
      failureParts.push(`تم تجاهل ${result.skippedPriceUpdates} تحديث سعر (الوحدة غير موجودة)`);
    }
    const failureSuffix = failureParts.length > 0 ? ` ${failureParts.join("، ")} — راجع التفاصيل أدناه.` : "";

    return NextResponse.json({
      success: true,
      result,
      message: baseMessage + failureSuffix,
      hasFailures,
    });
  } catch (error) {
    console.error("Error executing CSV import commit:", error);
    return NextResponse.json({ error: "SERVER_ERROR", message: "حدث خطأ أثناء حفظ بيانات الاستيراد." }, { status: 500 });
  }
}