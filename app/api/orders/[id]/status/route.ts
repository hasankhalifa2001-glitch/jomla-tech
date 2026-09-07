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
import { z } from "zod";

const orderStatusSchema = z.object({
  status: z.enum(["APPROVED", "REJECTED"]),
  rejectionReason: z.string().optional(),
});

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await auth();
    if (!session || !session.user || !session.user.tenantId) {
      return NextResponse.json({ error: "UNAUTHORIZED", message: "يرجى تسجيل الدخول أولاً." }, { status: 401 });
    }

    // Role Capability Matrix: approving/rejecting B2B orders is ADMIN-only
    assertRolePermission(session.user.role, "orders:manage");

    // Security boundary: assert tenant subscription is active
    await assertTenantWritable(session.user.tenantId);

    const { id } = await params;
    const body = await req.json();
    const validation = orderStatusSchema.safeParse(body);

    if (!validation.success) {
      return NextResponse.json(
        {
          error: "VALIDATION_ERROR",
          message: validation.error.issues[0]?.message || "بيانات حالة الطلب غير صالحة.",
        },
        { status: 400 }
      );
    }

    const { status } = validation.data;

    return NextResponse.json({
      success: true,
      orderId: id,
      status,
      message: status === "APPROVED" ? "تم قبول الطلب بنجاح." : "تم رفض الطلب بنجاح.",
    });
  } catch (error) {
    if (error instanceof ForbiddenRoleError) {
      return forbiddenRoleResponse(error);
    }
    if (error instanceof SubscriptionLockedError) {
      return subscriptionLockedResponse(error);
    }
    console.error("Error updating order status:", error);
    return NextResponse.json({ error: "SERVER_ERROR", message: "حدث خطأ أثناء تحديث حالة الطلب." }, { status: 500 });
  }
}
