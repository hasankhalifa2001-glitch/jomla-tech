import { NextResponse } from "next/server";
import { auth } from "@/auth";
// [FIX #3 — critical, same class of bug as the commit route] This route
// previously imported the RAW, unscoped `prisma` client from "@/lib/db".
// It matches none of lib/db.ts's six documented exception categories —
// this is an ordinary authenticated, tenant-context ADMIN read. Beyond the
// tenant-isolation gap itself (the preview's own productUnit.findMany() /
// product.findMany() scans would have run completely unscoped across every
// tenant's catalog data), this import now also fails to COMPILE: after the
// fix to lib/inventory/csv-parser.ts, validateAndPreviewCsv()'s first
// parameter is typed as ReturnType<typeof getTenantDb> specifically to
// reject a raw PrismaClient at the type level. getTenantDb(tenantId)'s
// Prisma Client Extension auto-injects tenantId into both findMany() calls
// this route triggers, closing the gap without any change to
// csv-parser.ts's own query logic.
import { getTenantDb } from "@/lib/db";
import { validateAndPreviewCsv } from "@/lib/inventory/csv-parser";
import {
  assertRolePermission,
  ForbiddenRoleError,
  forbiddenRoleResponse,
} from "@/lib/auth/role-matrix";

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

    // Role check: viewing pricing / previewing catalog-wide CSV is ADMIN-only per Role Capability Matrix.
    // Deliberately NO assertTenantWritable here: this route is in READ_ONLY_POST_PREFIXES
    // so locked-out tenants can still preview before committing.
    assertRolePermission(session.user.role, "inventory:mutate");

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

    // [FIX #3] Tenant-scoped client, not the raw one — see the import
    // comment above.
    const db = getTenantDb(tenantId);
    const previewResult = await validateAndPreviewCsv(db, tenantId, csvString);

    return NextResponse.json({
      success: true,
      preview: previewResult,
    });
  } catch (error) {
    if (error instanceof ForbiddenRoleError) {
      return forbiddenRoleResponse(error);
    }
    console.error("Error generating CSV import preview:", error);
    return NextResponse.json({ error: "SERVER_ERROR", message: "حدث خطأ أثناء تحليل ومعاينة ملف CSV." }, { status: 500 });
  }
}