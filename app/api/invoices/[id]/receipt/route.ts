import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getTenantDb } from "@/lib/db/tenant-scope";
import {
  assertTenantWritable,
  SubscriptionLockedError,
  subscriptionLockedResponse,
} from "@/lib/auth/tenant";
import {
  findInvoiceAccessRow,
  canSessionUserAccessInvoice,
} from "@/lib/data/invoices";
import {
  validateReceiptRasterPng,
  ReceiptRasterValidationError,
} from "@/lib/receipts/raster-validation";
import { buildReceiptPdfFromPng } from "@/lib/receipts/pdf";
import { cacheReceiptPdfOnce } from "@/lib/data/receipts";

/**
 * T4f — POST /api/invoices/[id]/receipt
 *
 * Implements the approved plan's Option 1 (Client raster -> Server wraps into PDF):
 * 1. Checks session, tenant, and invoice existence.
 * 2. Checks cashier ownership via shared canSessionUserAccessInvoice helper.
 * 3. Enforces subscription writability (assertTenantWritable): generating a cached
 *    receipt PDF is a write mutation on Invoice.receiptPdfUrl.
 * 4. Fast path: If invoice.receiptPdfUrl is already set, returns it immediately without
 *    processing or requiring an upload body (subsequent shares reuse existing cached PDF).
 * 5. Validates uploaded PNG raster (magic bytes, dimensions, size, IHDR).
 * 6. Wraps raster into single-page PDF at fixed 80mm width.
 * 7. Atomically caches PDF URL via conditional UPDATE (Rule 3 concurrency guard).
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const session = await auth();

  if (!session?.user?.tenantId || !session.user.id) {
    return NextResponse.json(
      { error: "UNAUTHORIZED", message: "يرجى تسجيل الدخول أولاً." },
      { status: 401 }
    );
  }

  const tenantId = session.user.tenantId;
  const db = getTenantDb(tenantId);

  try {
    const invoice = await findInvoiceAccessRow(db, tenantId, id);
    if (!invoice) {
      return NextResponse.json(
        { error: "NOT_FOUND", message: "الفاتورة غير موجودة." },
        { status: 404 }
      );
    }

    if (!canSessionUserAccessInvoice(session.user, invoice)) {
      return NextResponse.json(
        { error: "FORBIDDEN", message: "لا يمكنك مشاركة إيصال فاتورة موظف آخر." },
        { status: 403 }
      );
    }

    // Fast path: subsequent shares reuse persisted URL with no new generation or upload
    if (invoice.receiptPdfUrl) {
      return NextResponse.json({
        success: true,
        receiptPdfUrl: invoice.receiptPdfUrl,
        cached: true,
      });
    }

    // Generating and caching the PDF is a mutating operation; verify tenant is writable
    await assertTenantWritable(tenantId);

    const formData = await req.formData().catch(() => null);
    if (!formData) {
      return NextResponse.json(
        { error: "VALIDATION_ERROR", message: "لم يتم إرسال بيانات صالحة (FormData مطلوب)." },
        { status: 400 }
      );
    }

    const file = formData.get("raster");
    if (!(file instanceof File)) {
      return NextResponse.json(
        { error: "VALIDATION_ERROR", message: "حقل صورة الإيصال (raster) مفقود أو غير صالح." },
        { status: 400 }
      );
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    let dimensions: { widthPx: number; heightPx: number };
    try {
      dimensions = validateReceiptRasterPng(buffer, file.type);
    } catch (valErr) {
      if (valErr instanceof ReceiptRasterValidationError) {
        return NextResponse.json(
          { error: "VALIDATION_ERROR", code: valErr.code, message: valErr.message },
          { status: 400 }
        );
      }
      throw valErr;
    }

    const pdfBytes = await buildReceiptPdfFromPng(buffer, {
      width: dimensions.widthPx,
      height: dimensions.heightPx,
    });

    const result = await cacheReceiptPdfOnce({
      db,
      tenantId,
      invoiceId: id,
      pdf: pdfBytes,
    });

    return NextResponse.json({
      success: true,
      receiptPdfUrl: result.url,
      wonRace: result.wonRace,
      cached: false,
    });
  } catch (error) {
    if (error instanceof SubscriptionLockedError) {
      return subscriptionLockedResponse(error);
    }
    console.error("Error generating/caching receipt PDF:", error);
    return NextResponse.json(
      { error: "SERVER_ERROR", message: "حدث خطأ أثناء إنشاء إيصال PDF." },
      { status: 500 }
    );
  }
}
