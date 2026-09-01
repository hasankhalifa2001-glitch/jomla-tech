import { NextResponse } from "next/server";
import { auth } from "@/auth";
// [FIX] Same fix as products/route.ts: this is an ordinary authenticated
// tenant route, not on the small documented allowlist (registration,
// seed.ts, isPlatformAdmin-gated super-admin routes) permitted to import
// the raw, unscoped `prisma` client from lib/db.ts. Every query here must
// go through `getTenantDb(tenantId)` so tenantId is injected automatically
// by the Prisma Client Extension rather than depending on every `where`/
// `data` clause in this file being hand-written correctly forever.
import { getTenantDb } from "@/lib/db/tenant-scope";
import { z } from "zod";

// [FIX] Same strict-format requirement already established in
// lib/inventory/csv-parser.ts for the exact same field (ProductBatch.
// expiryDate). The previous version of this route accepted any string and
// passed it straight to `new Date(str)`, which happily parses ambiguous
// formats like "03/04/2026" (day/month or month/day, interpreted silently
// and inconsistently depending on the JS engine/locale) — a batch's
// expiry date silently misinterpreted this way corrupts T3's expiry-badge
// logic (RED/YELLOW thresholds) and the negative-stock/reconciliation
// surface with no error at all. Requiring the same YYYY-MM-DD format this
// codebase already enforces elsewhere means a badly-formatted date is
// REJECTED with a clear reason instead of silently stored wrong.
const STRICT_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

const createBatchSchema = z.object({
  productId: z.string().min(1, "معرف المنتج مطلوب"),
  unitId: z.string().min(1, "معرف الوحدة مطلوب"),
  batchNumber: z.string().min(1, "رقم الدفعة مطلوب"),
  quantity: z.number().min(0, "الكمية يجب أن تكون صفر أو أكثر"),
  expiryDate: z
    .string()
    .optional()
    .nullable()
    .refine(
      (val) => !val || STRICT_DATE_REGEX.test(val),
      { message: "تاريخ الانتهاء يجب أن يكون بالصيغة YYYY-MM-DD (مثال: 2026-12-31)." }
    )
    .refine(
      (val) => !val || !isNaN(new Date(val).getTime()),
      { message: "تاريخ الانتهاء غير صالح." }
    ),
});

export async function POST(req: Request) {
  try {
    const session = await auth();
    if (!session || !session.user || !session.user.tenantId) {
      return NextResponse.json({ error: "UNAUTHORIZED", message: "يرجى تسجيل الدخول أولاً." }, { status: 401 });
    }

    // Both ADMIN and CASHIER may record a received batch — restocking is a
    // routine operational task, unlike catalog/pricing decisions (see
    // products/route.ts, which is ADMIN-only). Any authenticated tenant
    // member reaches this far; no further role narrowing needed here.

    // [v3.5] Locked out identically for EXPIRED and PENDING — a tenant
    // awaiting first Super-Admin approval has no more write access than one
    // whose subscription has lapsed.
    if (session.user.subscriptionStatus === "EXPIRED" || session.user.subscriptionStatus === "PENDING") {
      return NextResponse.json(
        { error: "SUBSCRIPTION_LOCKED", message: "اشتراكك منتهي أو معلق. لا يمكنك إضافة دفعات جديدة." },
        { status: 403 }
      );
    }

    const tenantId = session.user.tenantId;
    const db = getTenantDb(tenantId);
    const body = await req.json();
    const validation = createBatchSchema.safeParse(body);

    if (!validation.success) {
      return NextResponse.json(
        {
          error: "VALIDATION_ERROR",
          message: validation.error.issues[0]?.message || "بيانات الدفعة غير صالحة.",
        },
        { status: 400 }
      );
    }

    const { productId, unitId, batchNumber, quantity, expiryDate } = validation.data;

    // Verify product & unit belong to tenant. `tenantId` is included here
    // explicitly even though `db` (the tenant-scoped client) would inject
    // it automatically on this `findFirst` call regardless — kept for
    // readability/defense-in-depth, matching the same pattern used in
    // products/route.ts.
    const productUnit = await db.productUnit.findFirst({
      where: {
        id: unitId,
        productId,
        tenantId,
      },
    });

    if (!productUnit) {
      return NextResponse.json({ error: "NOT_FOUND", message: "المنتج أو الوحدة المحددة غير موجودة." }, { status: 404 });
    }

    const batch = await db.productBatch.create({
      data: {
        tenantId,
        productId,
        unitId,
        batchNumber,
        quantity,
        expiryDate: expiryDate ? new Date(expiryDate) : null,
      },
      include: {
        unit: true,
      },
    });

    // [FIX] `batch.quantity` and `batch.unit.conversionFactor` are Prisma
    // `Decimal` instances. Serializing them straight into
    // `NextResponse.json(...)` relies on `Decimal`'s own `toJSON()`, which
    // returns a STRING — silently handing the frontend a different wire
    // type than the numeric one it likely expects (and than
    // GET /api/inventory/products already returns for the equivalent
    // fields). Explicitly unwrapped with `Number(...)` here so this
    // response is consistent with the rest of the inventory API.
    const responseBatch = {
      ...batch,
      quantity: Number(batch.quantity),
      unit: batch.unit
        ? {
          ...batch.unit,
          conversionFactor: Number(batch.unit.conversionFactor),
          priceWholesale: Number(batch.unit.priceWholesale),
          priceRetail:
            batch.unit.priceRetail !== null && batch.unit.priceRetail !== undefined
              ? Number(batch.unit.priceRetail)
              : null,
        }
        : null,
    };

    return NextResponse.json({
      success: true,
      batch: responseBatch,
      message: "تمت إضافة الدفعة الجديدة بنجاح.",
    });
  } catch (error) {
    console.error("Error creating batch:", error);
    return NextResponse.json({ error: "SERVER_ERROR", message: "حدث خطأ أثناء إضافة الدفعة." }, { status: 500 });
  }
}