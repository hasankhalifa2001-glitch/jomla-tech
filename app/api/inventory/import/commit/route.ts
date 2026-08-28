import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { commitCsvImport } from "@/lib/inventory/csv-parser";
import { z } from "zod";

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

    // FIX (critical): previously this call was wrapped in
    // `prisma.$transaction(async (tx) => commitCsvImport(tx, ...))`. On
    // PostgreSQL, ANY error inside a transaction — even one caught and
    // handled in application code — leaves that transaction in an aborted
    // state at the database level; every subsequent statement on the same
    // transaction then fails too, forcing a full rollback of rows that had
    // already committed. That silently defeated the entire point of
    // commitCsvImport's per-row try/catch: one barcode collision midway
    // through a large file could wipe out every row that succeeded before
    // it, while the response still claimed a partial success.
    //
    // commitCsvImport does not need an outer transaction: each row's
    // product/unit/batch creation, and each price update, is already an
    // atomic operation on its own. Passing the plain `prisma` client here
    // makes each row's success or failure genuinely independent, which is
    // what "a failing row does not block the rows around it" requires.
    const result = await commitCsvImport(prisma, tenantId, {
      newProducts,
      priceUpdates,
    });

    const hasFailures = result.failedNewProducts.length > 0;
    const baseMessage = `تم تنفيذ الاستيراد: تم إنشاء ${result.createdProductsCount} منتج جديد وتحديث ${result.updatedPricesCount} سعر.`;
    const failureSuffix = hasFailures
      ? ` تعذّر إنشاء ${result.failedNewProducts.length} منتج بسبب تعارض في الباركود — راجع التفاصيل أدناه.`
      : "";

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