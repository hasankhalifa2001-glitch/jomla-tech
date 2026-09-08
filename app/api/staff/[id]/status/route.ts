import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getTenantDb } from "@/lib/db";
import {
    assertTenantWritable,
    SubscriptionLockedError,
    subscriptionLockedResponse,
} from "@/lib/auth/tenant";
import {
    assertUserActive,
    UserInactiveError,
    userInactiveResponse,
} from "@/lib/auth/user";
import {
    assertAdmin,
    ForbiddenRoleError,
    forbiddenRoleResponse,
} from "@/lib/auth/role-matrix";
import { z } from "zod";

// [FIX] Zod v4 renamed the per-field error customization API: v3's
// `{ required_error: "..." }` no longer exists on the options object — the
// unified replacement is `{ error: "..." }`.
const updateStatusSchema = z.object({
    isActive: z.boolean({ error: "حالة التفعيل مطلوبة" }),
});

export async function PATCH(
    req: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const session = await auth();
        if (!session || !session.user || !session.user.tenantId || !session.user.id) {
            return NextResponse.json(
                { error: "UNAUTHORIZED", message: "يرجى تسجيل الدخول أولاً." },
                { status: 401 }
            );
        }

        assertAdmin(session.user.role, "settings:manage");
        // [FIX] Now passes tenantId — see lib/auth/user.ts's header comment.
        await assertUserActive(session.user.tenantId, session.user.id);
        await assertTenantWritable(session.user.tenantId);

        const { id } = await params;
        const body = await req.json();
        const validation = updateStatusSchema.safeParse(body);

        if (!validation.success) {
            return NextResponse.json(
                {
                    error: "VALIDATION_ERROR",
                    message: validation.error.issues[0]?.message || "بيانات الحالة غير صالحة.",
                },
                { status: 400 }
            );
        }

        const { isActive } = validation.data;

        // Security rule 1: An ADMIN cannot deactivate their own account through this screen
        if (id === session.user.id && !isActive) {
            return NextResponse.json(
                {
                    error: "SELF_DEACTIVATION_FORBIDDEN",
                    message: "لا يمكنك إلغاء تفعيل حسابك الشخصي.",
                },
                { status: 400 }
            );
        }

        const db = getTenantDb(session.user.tenantId);

        // Fetch target user — scoped to this tenant via getTenantDb's
        // Client Extension (tenantId is injected into the `where` clause
        // automatically). A user belonging to a different tenant simply
        // resolves to null here, same as a genuinely nonexistent id.
        const targetUser = await db.user.findUnique({
            where: { id },
        });

        if (!targetUser) {
            return NextResponse.json(
                { error: "NOT_FOUND", message: "الموظف غير موجود في هذا المتجر." },
                { status: 404 }
            );
        }

        // Security rule 2: A tenant must always retain at least one active ADMIN.
        // The count below is also tenant-scoped via the same extension, so
        // this only ever counts ADMINs within the CURRENT tenant — an active
        // ADMIN belonging to a different tenant can never satisfy this check.
        if (targetUser.role === "ADMIN" && !isActive) {
            const activeAdminCount = await db.user.count({
                where: {
                    role: "ADMIN",
                    isActive: true,
                },
            });

            if (activeAdminCount <= 1) {
                return NextResponse.json(
                    {
                        error: "LAST_ADMIN_DEACTIVATION_FORBIDDEN",
                        message: "لا يمكن إلغاء تفعيل المدير الأخير في المتجر. يجب أن يبقى مدير واحد نشط على الأقل.",
                    },
                    { status: 400 }
                );
            }
        }

        const updatedUser = await db.user.update({
            where: { id },
            data: { isActive },
            select: {
                id: true,
                name: true,
                email: true,
                role: true,
                isActive: true,
                updatedAt: true,
            },
        });

        return NextResponse.json({
            success: true,
            user: updatedUser,
            message: isActive ? "تم تفعيل حساب الموظف بنجاح." : "تم إلغاء تفعيل حساب الموظف بنجاح.",
        });
    } catch (error) {
        if (error instanceof ForbiddenRoleError) {
            return forbiddenRoleResponse(error);
        }
        if (error instanceof UserInactiveError) {
            return userInactiveResponse(error);
        }
        if (error instanceof SubscriptionLockedError) {
            return subscriptionLockedResponse(error);
        }
        console.error("Error updating staff status:", error);
        return NextResponse.json(
            { error: "SERVER_ERROR", message: "حدث خطأ غير متوقع أثناء تعديل حالة الموظف." },
            { status: 500 }
        );
    }
}