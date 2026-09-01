import { NextResponse } from "next/server";
import { auth } from "@/auth";
// [NOTE — intentionally the raw client, not getTenantDb()] Same
// architectural category as fifo-preview/route.ts and import/commit/route.ts:
// `validateAndPreviewCsv` enforces tenant isolation manually and explicitly
// inside itself (`db.productUnit.findMany({ where: { tenantId } })`), not
// via the Client Extension, and is typed to accept either a plain
// PrismaClient or a Prisma.TransactionClient for that reason. This import
// needs the same documented-allowlist treatment as the other two files;
// the ESLint suppression below stays narrowly scoped to this one line
// pending that config update.
// eslint-disable-next-line no-restricted-imports -- see note above: raw client required for validateAndPreviewCsv's type compatibility; tenant isolation enforced manually inside csv-parser.ts itself.
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

    // Role check stays — this is a permission/visibility decision
    // (CASHIER shouldn't see catalog-wide pricing), unrelated to whether
    // the tenant is locked. Matches products/route.ts and commit/route.ts.
    if (session.user.role !== "ADMIN") {
      return NextResponse.json(
        { error: "FORBIDDEN", message: "معاينة استيراد المنتجات بالجملة متاحة لمدير المتجر فقط." },
        { status: 403 }
      );
    }

    // [FIX — removed subscriptionStatus lockout check] This route is
    // deliberately listed in middleware.ts's READ_ONLY_POST_PREFIXES,
    // whose entire documented purpose is to let a locked-out tenant still
    // preview a CSV import while blocked from committing anything (same
    // exemption fifo-preview/route.ts already correctly has no lockout
    // check for). This route's own 403 check was silently overriding the
    // middleware's intent — no locked tenant could ever reach this
    // endpoint despite the middleware explicitly letting the request
    // through. The actual write path (import/commit/route.ts) still
    // enforces the lockout correctly; only the read-only preview is
    // exempt, matching fifo-preview's behavior exactly.

    const tenantId = session.user.tenantId;

    // [FIX] Checked BEFORE reading the body at all, using the real
    // Content-Length header (actual bytes sent by the client) instead of
    // relying only on the parsed string's .length afterward, which counts
    // UTF-16 code units and undercounts real UTF-8 byte size for Arabic
    // content by up to 2x on this Arabic-first platform's own CSV files.
    const declaredLength = req.headers.get("content-length");
    if (declaredLength && Number(declaredLength) > MAX_CSV_SIZE_BYTES) {
      return NextResponse.json(
        { error: "FILE_TOO_LARGE", message: "حجم الملف كبير جداً، الحد الأقصى المسموح هو 5 ميغابايت." },
        { status: 413 }
      );
    }

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

    // [FIX] Fallback check (a client can lie about or omit
    // Content-Length) — now measures REAL UTF-8 byte length via
    // Buffer.byteLength instead of .length.
    if (Buffer.byteLength(csvString, "utf8") > MAX_CSV_SIZE_BYTES) {
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