import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { auth } from "@/auth";
import { getTenantDb } from "@/lib/db/tenant-scope";
import {
  assertRolePermission,
  ForbiddenRoleError,
  forbiddenRoleResponse,
} from "@/lib/auth/role-matrix";
import {
  assertTenantWritable,
  SubscriptionLockedError,
  subscriptionLockedResponse,
} from "@/lib/auth/tenant";
import { getReceiptDetail } from "@/lib/data/receipt-history";
import { purchaseDateSchema, supplierNameSchema } from "@/lib/data/receipts";
import { businessDateToDbDate } from "@/lib/inventory/date-utils";

/**
 * GET/PATCH /api/receipts/[id] — [v4.7, Phase 6] receipt detail (live lines
 * + deleted lines + reconciliation) and the STRICT header edit.
 *
 * [ROLE] Both methods assert rows from lib/auth/role-matrix.ts — GET with
 * `receipts:view`, PATCH with `receipts:edit` (both ADMIN-only, added in
 * Round B) — exactly like GET /api/receipts and GET /api/receipts/defaults.
 * The response carries purchase-cost figures; a CASHIER's direct call is
 * 403 BEFORE any query (zero data read) either way.
 *
 * [GET] 404 for a foreign/unknown id (never 403): existence-in-tenant is
 * all a tenant-scoped read may reveal. Read-only, no subscription gate.
 *
 * [PATCH — strict allowlist] ONLY `purchaseDate` and `supplierName` may
 * appear in the body. The raw body's keys are checked BEFORE any validation,
 * any role-adjacent work beyond auth, and — crucially — BEFORE any database
 * read or write: an unknown key (e.g. `initialQuantity`, `totalCostSYP`,
 * `supplier`, any typo) is 400 with zero queries issued. Rationale: those
 * columns are the receipt's historical identity — initialQuantity is
 * write-once on the BATCH rows and the total is the frozen Σ of what was
 * paid; letting them even pass validation would blur which fields are
 * mutable. purchaseDate reuses Round A's own schema (same required/valid/
 * not-future/not-too-old rules, same Damascus "today" definition), so a
 * client can never learn a different boundary here than at receiving time.
 *
 * [PATCH — write gate] assertTenantWritable() runs (fresh DB read of the
 * subscription status) — the same T2b boundary every mutating route uses.
 * The update is a single top-level `productReceipt.update` (nested-write
 * ban): batches are never touched by this route.
 */

export const dynamic = "force-dynamic";

/** The ONLY body keys PATCH will ever accept — see file header. */
const ALLOWED_PATCH_KEYS = ["purchaseDate", "supplierName"] as const;

const patchSchema = z
  .object({
    purchaseDate: purchaseDateSchema.optional(),
    supplierName: supplierNameSchema.optional(),
  })
  .strict();

// ============================================================================
// GET — detail with reconciliation
// ============================================================================

export async function GET(
  _req: NextRequest,
  props: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await props.params;
    const session = await auth();
    if (!session || !session.user || !session.user.tenantId) {
      return NextResponse.json(
        { error: "UNAUTHORIZED", message: "يرجى تسجيل الدخول أولاً." },
        { status: 401 }
      );
    }

    try {
      assertRolePermission(session.user.role, "receipts:view");
    } catch (error) {
      if (error instanceof ForbiddenRoleError) return forbiddenRoleResponse(error);
      throw error;
    }

    const tenantId = session.user.tenantId;
    const db = getTenantDb(tenantId);
    const detail = await getReceiptDetail(db, tenantId, id);
    if (!detail) {
      return NextResponse.json(
        { error: "NOT_FOUND", message: "الاستلام المحدد غير موجود." },
        { status: 404 }
      );
    }

    return NextResponse.json({ success: true, ...detail });
  } catch (error) {
    console.error("Error loading receipt detail:", error);
    return NextResponse.json(
      { error: "SERVER_ERROR", message: "تعذّر تحميل تفاصيل الاستلام." },
      { status: 500 }
    );
  }
}

// ============================================================================
// PATCH — strict allowlist edit of purchaseDate / supplierName only
// ============================================================================

export async function PATCH(
  req: NextRequest,
  props: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await props.params;
    const session = await auth();
    if (!session || !session.user || !session.user.tenantId) {
      return NextResponse.json(
        { error: "UNAUTHORIZED", message: "يرجى تسجيل الدخول أولاً." },
        { status: 401 }
      );
    }

    try {
      assertRolePermission(session.user.role, "receipts:edit");
    } catch (error) {
      if (error instanceof ForbiddenRoleError) return forbiddenRoleResponse(error);
      throw error;
    }

    // 1) Parse the raw body. Malformed JSON → 400, never a 500.
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return NextResponse.json(
        { error: "VALIDATION_ERROR", message: "جسم الطلب غير صالح." },
        { status: 400 }
      );
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return NextResponse.json(
        { error: "VALIDATION_ERROR", message: "جسم الطلب غير صالح." },
        { status: 400 }
      );
    }

    // 2) THE strict allowlist — checked on the RAW keys, before zod, before
    //    any database read or write. Any key outside {purchaseDate,
    //    supplierName} → 400 listing it. An empty object is also rejected:
    //    a PATCH that changes nothing is a client bug, not a no-op 200.
    const keys = Object.keys(raw as Record<string, unknown>);
    const unknownKeys = keys.filter(
      (key) => !(ALLOWED_PATCH_KEYS as readonly string[]).includes(key)
    );
    if (unknownKeys.length > 0) {
      return NextResponse.json(
        {
          error: "FIELD_NOT_ALLOWED",
          message: `حقول غير مسموح بتعديلها: ${unknownKeys.join(", ")}. الحقول المسموح بها فقط: ${ALLOWED_PATCH_KEYS.join(", ")}.`,
          unknownKeys,
        },
        { status: 400 }
      );
    }
    if (keys.length === 0) {
      return NextResponse.json(
        {
          error: "VALIDATION_ERROR",
          message: `لا توجد حقول للتعديل — الحقول المسموح بها فقط: ${ALLOWED_PATCH_KEYS.join(", ")}.`,
        },
        { status: 400 }
      );
    }

    // 3) Value validation — Round A's own schemas (same not-future /
    //    not-too-old purchase-date boundary the receiving forms use).
    const parsed = patchSchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: "VALIDATION_ERROR",
          message: "بيانات التعديل غير صالحة.",
          details: parsed.error.flatten(),
        },
        { status: 400 }
      );
    }

    // 4) Fresh subscription gate — the T2b write boundary. Runs only after
    //    the payload is known to be acceptable, so an invalid body never
    //    costs a DB round-trip.
    const tenantId = session.user.tenantId;
    await assertTenantWritable(tenantId);

    const db = getTenantDb(tenantId);

    // 404 before writing: distinguish "does not exist (for this tenant)"
    // from a successful edit of a foreign id.
    const existing = await db.productReceipt.findFirst({
      where: { id, tenantId },
      select: { id: true },
    });
    if (!existing) {
      return NextResponse.json(
        { error: "NOT_FOUND", message: "الاستلام المحدد غير موجود." },
        { status: 404 }
      );
    }

    // 5) One top-level update of the two allowed columns — nothing else.
    //    (nested-write ban: batches are never part of this payload)
    const data: { purchaseDate?: Date; supplierName?: string | null } = {};
    if (parsed.data.purchaseDate !== undefined) {
      data.purchaseDate = businessDateToDbDate(parsed.data.purchaseDate);
    }
    if (parsed.data.supplierName !== undefined) {
      // "" → null: an emptied supplier field stores as "no supplier", the
      // same shape the receiving gateway writes.
      data.supplierName = (parsed.data.supplierName ?? "").trim() || null;
    }

    await db.productReceipt.update({
      where: { id, tenantId },
      data,
    });

    return NextResponse.json({
      success: true,
      message: "تم تحديث بيانات الاستلام بنجاح.",
      updatedFields: Object.keys(data),
    });
  } catch (error) {
    if (error instanceof SubscriptionLockedError) {
      return subscriptionLockedResponse(error);
    }
    // Concurrent delete between the existence check and the update.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
      return NextResponse.json(
        { error: "NOT_FOUND", message: "الاستلام المحدد غير موجود." },
        { status: 404 }
      );
    }
    console.error("Error updating receipt:", error);
    return NextResponse.json(
      { error: "SERVER_ERROR", message: "تعذّر تحديث بيانات الاستلام." },
      { status: 500 }
    );
  }
}

