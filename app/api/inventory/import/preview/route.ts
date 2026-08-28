import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/db";
import { validateAndPreviewCsv } from "@/lib/inventory/csv-parser";

// A reasonable ceiling for a product-catalog CSV. validateAndPreviewCsv
// also runs a full productUnit.findMany() scan over the tenant's barcodes,
// so an unbounded file size means unbounded work on a single request.
const MAX_CSV_SIZE_BYTES = 5 * 1024 * 1024; // 5MB

export async function POST(req: Request) {
  try {
    const session = await auth();
    if (!session || !session.user || !session.user.tenantId) {
      return NextResponse.json({ error: "UNAUTHORIZED", message: "يرجى تسجيل الدخول أولاً." }, { status: 401 });
    }

    const tenantId = session.user.tenantId;

    // FIX: req.json() throws on a malformed/non-JSON body — previously that
    // fell through to the generic catch block below and returned a vague
    // "error analyzing the file" message even when the real problem was a
    // malformed request, not the CSV content itself.
    let csvString: unknown;
    try {
      const body = await req.json();
      csvString = body?.csvString;
    } catch {
      return NextResponse.json(
        { error: "BAD_REQUEST", message: "الطلب غير صالح (تنسيق JSON خاطئ)." },
        { status: 400 }
      );
    }

    if (!csvString || typeof csvString !== "string" || !csvString.trim()) {
      return NextResponse.json({ error: "BAD_REQUEST", message: "يرجى تزويد ملف CSV صالح للاستيراد." }, { status: 400 });
    }

    // FIX: no prior ceiling on file size — an unbounded CSV (accidental or
    // otherwise) would be parsed in full and matched against every existing
    // barcode in the tenant on a single request.
    if (csvString.length > MAX_CSV_SIZE_BYTES) {
      return NextResponse.json(
        { error: "FILE_TOO_LARGE", message: "حجم الملف كبير جداً، الحد الأقصى المسموح هو 5 ميغابايت." },
        { status: 413 }
      );
    }

    const previewResult = await validateAndPreviewCsv(prisma, tenantId, csvString);

    return NextResponse.json({
      success: true,
      preview: previewResult,
    });
  } catch (error) {
    console.error("Error generating CSV import preview:", error);
    return NextResponse.json({ error: "SERVER_ERROR", message: "حدث خطأ أثناء تحليل ومعاينة ملف CSV." }, { status: 500 });
  }
}