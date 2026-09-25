import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { getTenantDb } from "@/lib/db/tenant-scope";
import { canSessionUserAccessInvoice } from "@/lib/data/invoices";

/**
 * T4f — GET /api/invoices/by-offline-id?offlineId=...
 *
 * Resolves a synced server Invoice row using its client-generated offlineId.
 * Used by client surfaces (offline void panel, post-checkout modal) to bridge
 * from local Dexie offlineId -> server Invoice.id & receiptPdfUrl once status === "SYNCED".
 */
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.tenantId || !session.user.id) {
    return NextResponse.json(
      { error: "UNAUTHORIZED", message: "يرجى تسجيل الدخول أولاً." },
      { status: 401 }
    );
  }

  const { searchParams } = new URL(req.url);
  const offlineId = searchParams.get("offlineId");
  if (!offlineId || !offlineId.trim()) {
    return NextResponse.json(
      { error: "VALIDATION_ERROR", message: "معرّف الفاتورة المحلي (offlineId) مطلوب." },
      { status: 400 }
    );
  }

  const tenantId = session.user.tenantId;
  const db = getTenantDb(tenantId);

  try {
    const invoice = await db.invoice.findFirst({
      where: { tenantId, offlineId: offlineId.trim() },
      select: {
        id: true,
        status: true,
        userId: true,
        receiptPdfUrl: true,
        voidsInvoice: { select: { userId: true } },
      },
    });

    if (!invoice) {
      return NextResponse.json(
        { error: "NOT_FOUND", message: "لم يتم العثور على الفاتورة المتزامنة بعد." },
        { status: 404 }
      );
    }

    const accessCheck = {
      userId: invoice.userId,
      originalInvoiceUserId: invoice.voidsInvoice?.userId ?? null,
    };

    if (!canSessionUserAccessInvoice(session.user, accessCheck)) {
      return NextResponse.json(
        { error: "FORBIDDEN", message: "لا يمكنك الوصول لفاتورة موظف آخر." },
        { status: 403 }
      );
    }

    return NextResponse.json({
      success: true,
      invoice: {
        id: invoice.id,
        status: invoice.status,
        receiptPdfUrl: invoice.receiptPdfUrl,
      },
    });
  } catch (error) {
    console.error("Error finding invoice by offlineId:", error);
    return NextResponse.json(
      { error: "SERVER_ERROR", message: "حدث خطأ أثناء جلب الفاتورة." },
      { status: 500 }
    );
  }
}
