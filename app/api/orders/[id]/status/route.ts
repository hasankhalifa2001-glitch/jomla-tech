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
import { getTenantDb } from "@/lib/db/tenant-scope";
import { resolveActiveCustomerId } from "@/lib/customers/resolve-active";
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
    if (!session || !session.user || !session.user.tenantId || !session.user.id) {
      return NextResponse.json({ error: "UNAUTHORIZED", message: "يرجى تسجيل الدخول أولاً." }, { status: 401 });
    }

    // Role Capability Matrix: approving/rejecting B2B orders is ADMIN-only
    assertRolePermission(session.user.role, "orders:manage");

    const tenantId = session.user.tenantId;
    const userId = session.user.id;

    // Security boundary: assert tenant subscription is active
    await assertTenantWritable(tenantId);

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

    const { status, rejectionReason } = validation.data;
    const db = getTenantDb(tenantId);

    // Conditional-update / status guard inside transaction:
    // Guarantees only PENDING_REVIEW orders can be approved or rejected (cheapest rejection first).
    const result = await db.$transaction(async (tx) => {
      // 1. Guard check: Must be in PENDING_REVIEW (cheapest rejection first)
      const order = await tx.b2BOrderRequest.findFirst({
        where: { id, tenantId, status: "PENDING_REVIEW" },
      });

      if (!order) {
        throw new Error("الطلب غير موجود أو تمت مراجعته مسبقاً.");
      }

      if (status === "APPROVED") {
        // [v4.2] Auto-Redirect on Write: resolve active customer ID if matchedCustomerId is present.
        // Executes strictly AFTER the PENDING_REVIEW status guard above.
        let resolvedCustomerId = order.matchedCustomerId;
        if (resolvedCustomerId) {
          resolvedCustomerId = await resolveActiveCustomerId(tx, tenantId, resolvedCustomerId);
        }

        const updated = await tx.b2BOrderRequest.update({
          where: { id, tenantId },
          data: {
            status: "APPROVED",
            matchedCustomerId: resolvedCustomerId,
            reviewedByUserId: userId,
            reviewedAt: new Date(),
          },
        });

        return updated;
      } else {
        const updated = await tx.b2BOrderRequest.update({
          where: { id, tenantId },
          data: {
            status: "REJECTED",
            rejectionReason: rejectionReason?.trim() || null,
            reviewedByUserId: userId,
            reviewedAt: new Date(),
          },
        });

        return updated;
      }
    });

    return NextResponse.json({
      success: true,
      orderId: result?.id ?? id,
      status: result?.status ?? status,
      message: status === "APPROVED" ? "تم قبول الطلب بنجاح." : "تم رفض الطلب بنجاح.",
    });
  } catch (error) {
    if (error instanceof ForbiddenRoleError) {
      return forbiddenRoleResponse(error);
    }
    if (error instanceof SubscriptionLockedError) {
      return subscriptionLockedResponse(error);
    }
    const message = error instanceof Error ? error.message : "حدث خطأ أثناء تحديث حالة الطلب.";
    console.error("Error updating order status:", error);
    return NextResponse.json({ error: "SERVER_ERROR", message }, { status: 400 });
  }
}
