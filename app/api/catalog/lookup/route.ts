import { NextResponse } from "next/server";
import { auth } from "@/auth";
// [NOTE] ProductCatalogEntry is platform-wide, NOT tenant-scoped (see
// schema.prisma: "id, barcode (unique), name, category, imageUrl,
// addedByTenantId, createdAt, updatedAt" — no tenantId field at all).
// getTenantDb(tenantId)'s Prisma Client Extension auto-injects tenantId
// into tenant-scoped models only (see TENANT_SCOPED_MODELS in
// lib/db/tenant-scope.ts) — ProductCatalogEntry is deliberately excluded
// from that set, so there is nothing for the extension to inject here.
// This is a legitimate, narrow exception to the "always use getTenantDb"
// rule, scoped specifically to platform-wide models with no tenantId
// column — the same structural reasoning as VerifiedRetailer/
// ProductCatalogEntryReport elsewhere in this codebase.
//
// [FIX] This exception was previously undocumented in both lib/db.ts's
// header (whose six numbered categories don't cover it) and
// eslint.config.mjs's no-restricted-imports exemption list — meaning
// this import would fail lint despite being architecturally correct.
// Only ONE line in this whole file needs the raw client, so per
// lib/db.ts's own guidance for that case, this uses an inline
// eslint-disable rather than a whole-file exemption.
// eslint-disable-next-line no-restricted-imports
import { prisma } from "@/lib/db";

export async function GET(req: Request) {
  try {
    const session = await auth();
    if (!session || !session.user || !session.user.tenantId) {
      return NextResponse.json({ error: "UNAUTHORIZED", message: "يرجى تسجيل الدخول أولاً." }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const barcode = (searchParams.get("barcode") || "").trim();

    if (!barcode) {
      return NextResponse.json({ error: "BAD_REQUEST", message: "الباركود مطلوب للبحث في الكتالوج المشترك." }, { status: 400 });
    }

    const tenantId = session.user.tenantId;

    const entry = await prisma.productCatalogEntry.findUnique({
      where: { barcode },
    });

    if (!entry) {
      return NextResponse.json({ success: true, entry: null });
    }

    return NextResponse.json({
      success: true,
      entry: {
        id: entry.id,
        barcode: entry.barcode,
        name: entry.name,
        category: entry.category,
        imageUrl: entry.imageUrl,
        // [FIX] `addedByTenantId` (the raw owning tenant's id) removed from
        // the response. The only thing the frontend needs to decide
        // whether direct-edit vs. report-a-correction applies is the
        // boolean `isOwner` below — returning the actual tenant id of
        // whichever OTHER merchant added this entry leaks a competitive
        // signal (which tenant carries/sources this product) to any tenant
        // that scans the same barcode. Nothing in the spec requires
        // exposing this, and the analogous VerifiedRetailer model is
        // explicit about exposing no more than a yes/no signal for the
        // same reason.
        isOwner: entry.addedByTenantId === tenantId,
      },
    });
  } catch (error) {
    console.error("Error looking up catalog entry:", error);
    return NextResponse.json({ error: "SERVER_ERROR", message: "حدث خطأ أثناء البحث في الكتالوج المشترك." }, { status: 500 });
  }
}