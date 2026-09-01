import { NextResponse } from "next/server";
import { auth } from "@/auth";
// [NOTE] ProductCatalogEntry is platform-wide, NOT tenant-scoped (see
// schema.prisma: "id, barcode (unique), name, category, imageUrl,
// addedByTenantId, createdAt, updatedAt" — no tenantId field at all).
// Importing the raw `prisma` client here is therefore correct, not an
// oversight: `getTenantDb(tenantId)`'s auto-injection has nothing to
// inject into a model with no tenantId column. This is a deliberate
// exception to the "always use getTenantDb" rule, scoped specifically to
// this platform-wide model.
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