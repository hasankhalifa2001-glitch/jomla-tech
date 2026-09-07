import { NextResponse } from "next/server";
import { auth } from "@/auth";
import {
  assertTenantWritable,
  SubscriptionLockedError,
  subscriptionLockedResponse,
} from "@/lib/auth/tenant";
import {
  assertRolePermission,
  ForbiddenRoleError,
  forbiddenRoleResponse,
} from "@/lib/auth/role-matrix";

export async function POST(req: Request) {
  try {
    const session = await auth();
    if (!session || !session.user || !session.user.tenantId) {
      return NextResponse.json({ error: "UNAUTHORIZED", message: "يرجى تسجيل الدخول أولاً." }, { status: 401 });
    }

    // Role Capability Matrix: voiding/refunding invoices is ADMIN-only
    assertRolePermission(session.user.role, "ledger:void_invoice");

    // Security boundary: assert tenant subscription is active
    await assertTenantWritable(session.user.tenantId);

    return NextResponse.json({
      success: true,
      message: "تم إلغاء الفاتورة واسترجاع المخزون بنجاح.",
    });
  } catch (error) {
    if (error instanceof ForbiddenRoleError) {
      return forbiddenRoleResponse(error);
    }
    if (error instanceof SubscriptionLockedError) {
      return subscriptionLockedResponse(error);
    }
    console.error("Error voiding invoice:", error);
    return NextResponse.json({ error: "SERVER_ERROR", message: "حدث خطأ أثناء إلغاء الفاتورة." }, { status: 500 });
  }
}
