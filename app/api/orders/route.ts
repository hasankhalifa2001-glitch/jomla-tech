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

    // Role Capability Matrix: viewing pending B2B requests is allowed for both ADMIN and CASHIER
    assertRolePermission(session.user.role, "orders:view");

    return NextResponse.json({
      success: true,
      orders: [],
    });
  } catch (error) {
    if (error instanceof ForbiddenRoleError) {
      return forbiddenRoleResponse(error);
    }
    console.error("Error fetching orders:", error);
    return NextResponse.json({ error: "SERVER_ERROR", message: "حدث خطأ أثناء جلب الطلبات." }, { status: 500 });
  }
}
