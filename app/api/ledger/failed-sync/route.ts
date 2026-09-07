import { NextResponse } from "next/server";
import { auth } from "@/auth";
import {
  assertRolePermission,
  ForbiddenRoleError,
  forbiddenRoleResponse,
} from "@/lib/auth/role-matrix";

export async function GET() {
  try {
    const session = await auth();
    if (!session || !session.user || !session.user.tenantId) {
      return NextResponse.json({ error: "UNAUTHORIZED", message: "يرجى تسجيل الدخول أولاً." }, { status: 401 });
    }

    // Role Capability Matrix: viewing failed-sync items list is ADMIN-only
    assertRolePermission(session.user.role, "ledger:view_failed_sync");

    return NextResponse.json({
      success: true,
      failedSyncItems: [],
    });
  } catch (error) {
    if (error instanceof ForbiddenRoleError) {
      return forbiddenRoleResponse(error);
    }
    console.error("Error fetching failed sync items:", error);
    return NextResponse.json({ error: "SERVER_ERROR", message: "حدث خطأ أثناء جلب العناصر غير المتزامنة." }, { status: 500 });
  }
}
