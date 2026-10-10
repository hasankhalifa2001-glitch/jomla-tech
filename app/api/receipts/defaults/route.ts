import { NextResponse } from "next/server";
import { auth } from "@/auth";
import {
  assertRolePermission,
  ForbiddenRoleError,
  forbiddenRoleResponse,
} from "@/lib/auth/role-matrix";
// [v4.7] One business-day definition (delegates to syria-time's localDayKey),
// and the same back-date boundary isTooOldBusinessDate() enforces.
import { getBusinessDate, MAX_BACKDATE_DAYS } from "@/lib/inventory/date-utils";
import { addLocalDays, localDayKey } from "@/lib/utils/syria-time";

export const dynamic = "force-dynamic";

/**
 * GET /api/receipts/defaults — { businessDate, minDate }
 *
 * [v4.7] The SERVER-supplied defaults for every goods-receiving date picker
 * (single add-batch, multi-product receipt, add-product step 3, CSV upload):
 *
 *   - businessDate: today's Damascus business day ('YYYY-MM-DD') — the
 *     default purchase date AND the preview prefix, so a device clock can
 *     never disagree with what the server will actually store. The clients
 *     must NEVER fall back to the device clock if this request fails: the
 *     picker stays empty / submit stays disabled instead.
 *   - minDate: businessDate minus MAX_BACKDATE_DAYS (730) — the exact cutoff
 *     isTooOldBusinessDate() rejects below, computed here through the SAME
 *     addLocalDays/localDayKey pair so client `min` and server validation can
 *     never disagree.
 *
 * ADMIN-only (receipts:view — the Round B role-matrix row every endpoint in
 * this folder shares; a CASHIER's direct API call is rejected 403 BEFORE any
 * work). No assertTenantWritable — this is a pure read: no body, no write,
 * nothing subscription-gated.
 */
export async function GET() {
  try {
    const session = await auth();
    if (!session || !session.user || !session.user.tenantId) {
      return NextResponse.json(
        { error: "UNAUTHORIZED", message: "يرجى تسجيل الدخول أولاً." },
        { status: 401 }
      );
    }

    assertRolePermission(session.user.role, "receipts:view");

    const now = new Date();
    return NextResponse.json({
      businessDate: getBusinessDate(now),
      minDate: localDayKey(addLocalDays(now, -MAX_BACKDATE_DAYS)),
    });
  } catch (error) {
    if (error instanceof ForbiddenRoleError) {
      return forbiddenRoleResponse(error);
    }
    console.error("Error reading receipt defaults:", error);
    return NextResponse.json(
      { error: "SERVER_ERROR", message: "تعذّر قراءة تاريخ الاستلام الافتراضي." },
      { status: 500 }
    );
  }
}
