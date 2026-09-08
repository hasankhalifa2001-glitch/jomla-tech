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

const createStaffSchema = z.object({
    name: z.string().min(1, "اسم الموظف مطلوب"),
    email: z.string().email("البريد الإلكتروني غير صالح"),
    password: z.string().min(6, "يجب أن تكون كلمة المرور 6 أحرف على الأقل"),
    role: z.enum(["ADMIN", "CASHIER"]).default("CASHIER"),
});

export async function GET() {
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

        const db = getTenantDb(session.user.tenantId);
        const users = await db.user.findMany({
            select: {
                id: true,
                name: true,
                email: true,
                role: true,
                isActive: true,
                isPlatformAdmin: true,
                createdAt: true,
            },
            orderBy: { createdAt: "asc" },
        });

        return NextResponse.json({
            success: true,
            users,
        });
    } catch (error) {
        if (error instanceof ForbiddenRoleError) {
            return forbiddenRoleResponse(error);
        }
        if (error instanceof UserInactiveError) {
            return userInactiveResponse(error);
        }
        console.error("Error fetching staff list:", error);
        return NextResponse.json(
            { error: "SERVER_ERROR", message: "حدث خطأ غير متوقع أثناء جلب بيانات طاقم العمل." },
            { status: 500 }
        );
    }
}

export async function POST(req: Request) {
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

        const body = await req.json();
        const validation = createStaffSchema.safeParse(body);
        if (!validation.success) {
            return NextResponse.json(
                {
                    error: "VALIDATION_ERROR",
                    message: validation.error.issues[0]?.message || "بيانات الموظف غير صالحة.",
                },
                { status: 400 }
            );
        }

        const { name, email, password, role } = validation.data;
        const cleanEmail = email.trim().toLowerCase();

        const db = getTenantDb(session.user.tenantId);

        // Email is unique GLOBALLY across the whole system (User.email has
        // no tenant-scoped composite unique — see schema), so this check is
        // intentionally NOT tenant-filtered. A user's email must be unique
        // across every merchant on the platform, not just within one tenant.
        const existing = await db.user.findUnique({
            where: { email: cleanEmail },
        });
        if (existing) {
            return NextResponse.json(
                {
                    error: "EMAIL_EXISTS",
                    message: "البريد الإلكتروني مستخدم بالفعل لحساب آخر.",
                },
                { status: 400 }
            );
        }

        const passwordHash = await bcrypt.hash(password, 10);

        // [FIX] tenantId is now passed explicitly in `data`. getTenantDb()'s
        // Client Extension injects it at RUNTIME regardless, but Prisma's
        // generated TypeScript type for User.create still requires it (or
        // the `tenant` relation) statically — passing the same value
        // explicitly here satisfies the type without changing runtime
        // behavior (the extension overwrites/confirms the same value).
        const newUser = await db.user.create({
            data: {
                tenantId: session.user.tenantId,
                name: name.trim(),
                email: cleanEmail,
                passwordHash,
                role,
                isActive: true,
                isPlatformAdmin: false,
            },
            select: {
                id: true,
                name: true,
                email: true,
                role: true,
                isActive: true,
                createdAt: true,
            },
        });

        return NextResponse.json(
            {
                success: true,
                user: newUser,
                message: "تمت إضافة الموظف بنجاح.",
            },
            { status: 201 }
        );
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
        console.error("Error creating staff user:", error);
        return NextResponse.json(
            { error: "SERVER_ERROR", message: "حدث خطأ غير متوقع أثناء إضافة الموظف." },
            { status: 500 }
        );
    }
}