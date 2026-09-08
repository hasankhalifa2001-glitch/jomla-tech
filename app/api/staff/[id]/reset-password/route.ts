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
import bcrypt from "bcryptjs";
import { z } from "zod";

const resetPasswordSchema = z.object({
    password: z.string().min(6, "يجب أن تكون كلمة المرور 6 أحرف على الأقل"),
});

export async function POST(
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
        const validation = resetPasswordSchema.safeParse(body);

        if (!validation.success) {
            return NextResponse.json(
                {
                    error: "VALIDATION_ERROR",
                    message: validation.error.issues[0]?.message || "كلمة المرور غير صالحة.",
                },
                { status: 400 }
            );
        }

        const { password } = validation.data;
        const db = getTenantDb(session.user.tenantId);

        // Fetch target user — scoped to this tenant via getTenantDb's
        // Client Extension, same as status/route.ts above.
        const targetUser = await db.user.findUnique({
            where: { id },
        });

        if (!targetUser) {
            return NextResponse.json(
                { error: "NOT_FOUND", message: "الموظف غير موجود في هذا المتجر." },
                { status: 404 }
            );
        }

        const passwordHash = await bcrypt.hash(password, 10);

        await db.user.update({
            where: { id },
            data: { passwordHash },
        });

        return NextResponse.json({
            success: true,
            message: "تمت إعادة تعيين كلمة المرور بنجاح.",
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
        console.error("Error resetting staff password:", error);
        return NextResponse.json(
            { error: "SERVER_ERROR", message: "حدث خطأ غير متوقع أثناء إعادة تعيين كلمة المرور." },
            { status: 500 }
        );
    }
}