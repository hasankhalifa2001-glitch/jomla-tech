import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { getTenantDb } from "@/lib/db/tenant-scope";
import {
  assertRolePermission,
  ForbiddenRoleError,
  forbiddenRoleResponse,
} from "@/lib/auth/role-matrix";
import {
  InvalidReceiptCursorError,
  RECEIPT_LIST_DEFAULT_LIMIT,
  RECEIPT_LIST_MAX_LIMIT,
  listReceiptsForTenant,
} from "@/lib/data/receipt-history";
import { isRealCalendarDate } from "@/lib/inventory/date-utils";

/**
 * GET /api/receipts — [v4.7, Phase 6] the goods-receiving history, newest
 * first, cursor-paginated.
 *
 * [ROLE — ADMIN-only via `receipts:view`, checked BEFORE anything else] The
 * response carries purchase-cost figures (a receipt's total), so
 * schema.prisma's [v4.7] header makes the screen ADMIN-only. The role matrix
 * row (lib/auth/role-matrix.ts) is asserted BEFORE the query schema is even
 * parsed and long before getTenantDb() — a CASHIER's direct API call is 403
 * with ZERO data read, regardless of what the UI hides.
 *
 * [READ-ONLY] No assertTenantWritable: a locked merchant may still look at
 * what they already received (app/api/invoices/route.ts's precedent).
 *
 * [PAGINATION] cursor + limit only — see lib/data/receipt-history.ts's
 * header for why the cursor encodes all three sort keys. A malformed
 * cursor or an over-max limit is 400; the DB is never touched for either.
 *
 * [FILTERS — Round B] from/to (business dates on purchaseDate) and an
 * optional case-insensitive supplierName contains-match, validated here and
 * applied inside the same indexed query (never post-filtered in JS, which
 * would break page boundaries under a cursor).
 */

export const dynamic = "force-dynamic";

const querySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce
    .number()
    .int()
    .positive()
    .max(RECEIPT_LIST_MAX_LIMIT)
    .default(RECEIPT_LIST_DEFAULT_LIMIT),
  // [Round B] Date-range + supplier filters. from/to are BUSINESS date
  // strings filtered against the @db.Date purchaseDate column — strictly
  // YYYY-MM-DD and a real calendar date (isRealCalendarDate rejects
  // "2026-02-31", which V8 would silently roll over), with from ≤ to
  // enforced here so a swapped range is a 400 rather than a silently empty
  // page. Not-future / not-too-old bounds deliberately do NOT apply: this
  // is a read window over history, not a value being written.
  from: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "تاريخ البداية يجب أن يكون بالصيغة YYYY-MM-DD.")
    .refine(isRealCalendarDate, { message: "تاريخ البداية غير صالح." })
    .optional(),
  to: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "تاريخ النهاية يجب أن يكون بالصيغة YYYY-MM-DD.")
    .refine(isRealCalendarDate, { message: "تاريخ النهاية غير صالح." })
    .optional(),
  // Case-insensitive partial supplier match — same shape/limits as the
  // receiving forms' own supplierNameSchema (120 chars, trimmed).
  supplierName: z.string().trim().min(1).max(120).optional(),
});
// from ≤ to as a cross-field rule (pure 'YYYY-MM-DD' string comparison —
// no Date parsing, per date-utils' note on string-first comparisons).
const querySchemaWithRange = querySchema.superRefine((value, ctx) => {
  if (value.from && value.to && value.from > value.to) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["from"],
      message: "تاريخ البداية يجب أن يكون قبل تاريخ النهاية.",
    });
  }
});

export async function GET(req: NextRequest) {
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

  const { searchParams } = new URL(req.url);
  const parsed = querySchemaWithRange.safeParse(Object.fromEntries(searchParams));
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "VALIDATION_ERROR",
        message: "معاملات التصفح أو الفلترة غير صالحة.",
        details: parsed.error.flatten(),
      },
      { status: 400 }
    );
  }

  try {
    const tenantId = session.user.tenantId;
    const db = getTenantDb(tenantId);
    const page = await listReceiptsForTenant(db, tenantId, parsed.data);
    return NextResponse.json({ success: true, ...page });
  } catch (error) {
    if (error instanceof InvalidReceiptCursorError) {
      return NextResponse.json(
        { error: error.code, message: error.message },
        { status: 400 }
      );
    }
    console.error("Error listing receipts:", error);
    return NextResponse.json(
      { error: "SERVER_ERROR", message: "تعذّر جلب سجل الاستلام." },
      { status: 500 }
    );
  }
}
