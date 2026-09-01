import { NextResponse } from "next/server";
import { auth } from "@/auth";
// [NOTE] Same as catalog/lookup/route.ts: ProductCatalogEntry and
// ProductCatalogEntryReport are platform-wide, NOT tenant-scoped (no
// tenantId column on either model — see schema.prisma). Raw `prisma` is
// the correct client here, not an oversight; getTenantDb's tenantId
// injection has nothing to attach to on these two models.
import { prisma } from "@/lib/db";
import { z } from "zod";

const reportSchema = z.object({
  catalogEntryId: z.string().min(1, "معرف السجل مطلوب"),
  reason: z.string().min(3, "سبب البلاغ مطلوب (على الأقل 3 أحرف)"),
  suggestedName: z.string().optional().nullable(),
  suggestedCategory: z.string().optional().nullable(),
  suggestedImageUrl: z.string().optional().nullable(),
});

export async function POST(req: Request) {
  try {
    const session = await auth();
    if (!session || !session.user || !session.user.tenantId) {
      return NextResponse.json({ error: "UNAUTHORIZED", message: "يرجى تسجيل الدخول أولاً." }, { status: 401 });
    }

    const tenantId = session.user.tenantId;
    const body = await req.json();

    const validation = reportSchema.safeParse(body);
    if (!validation.success) {
      return NextResponse.json(
        {
          error: "VALIDATION_ERROR",
          message: validation.error.issues[0]?.message || "بيانات البلاغ غير صالحة.",
        },
        { status: 400 }
      );
    }

    const { catalogEntryId, reason, suggestedName, suggestedCategory, suggestedImageUrl } = validation.data;

    const catalogEntry = await prisma.productCatalogEntry.findUnique({
      where: { id: catalogEntryId },
    });

    if (!catalogEntry) {
      return NextResponse.json({ error: "NOT_FOUND", message: "سجل الكتالوج المشترك غير موجود." }, { status: 404 });
    }

    // [FIX] The spec is explicit that this report flow exists for a tenant
    // who is NOT the entry's owner ("A report against a ProductCatalogEntry
    // never edits it directly... it queues a suggested correction... filed
    // by a tenant who is NOT its owner"). The owner already has a direct
    // edit path for this exact entry (see products/route.ts's GS1 catalog
    // update branch: `existingCatalog.addedByTenantId === tenantId` →
    // update in place). Without this check, an owner could file a report
    // against their own entry — harmless, but contradicts the documented
    // design and would sit in the Super-Admin's review queue for no
    // reason a non-owner correction wouldn't already cover.
    if (catalogEntry.addedByTenantId === tenantId) {
      return NextResponse.json(
        {
          error: "OWNER_CANNOT_REPORT",
          message: "أنت صاحب هذا السجل — يمكنك تعديله مباشرة عند إضافة/تحديث منتجك بدل تقديم بلاغ.",
        },
        { status: 400 }
      );
    }

    const report = await prisma.productCatalogEntryReport.create({
      data: {
        catalogEntryId,
        reportedByTenantId: tenantId,
        reason,
        suggestedName: suggestedName || null,
        suggestedCategory: suggestedCategory || null,
        suggestedImageUrl: suggestedImageUrl || null,
        status: "PENDING",
      },
    });

    return NextResponse.json({
      success: true,
      report,
      message: "تم تقديم طلب التصحيح بنجاح، وسيتم مراجعته من قبل إدارة المنصة.",
    });
  } catch (error) {
    console.error("Error submitting catalog report:", error);
    return NextResponse.json({ error: "SERVER_ERROR", message: "حدث خطأ أثناء تقديم طلب التصحيح." }, { status: 500 });
  }
}