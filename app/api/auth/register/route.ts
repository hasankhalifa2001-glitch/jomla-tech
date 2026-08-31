/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import bcrypt from "bcryptjs";
import { z } from "zod";

const registerSchema = z.object({
    tenantName: z.string().min(2, "اسم المتجر يجب أن يكون من حرفين على الأقل"),
    tenantSlug: z
        .string()
        .min(2, "معرف المتجر (slug) يجب أن يكون من حرفين على الأقل")
        .regex(/^[a-z0-9-]+$/, "معرف المتجر يجب أن يحتوي على أحرف إنجليزية صغيرة وأرقام وشرطات فقط"),
    phone: z.string().optional().nullable(),
    adminName: z.string().min(2, "اسم المدير يجب أن يكون من حرفين على الأقل"),
    adminEmail: z.string().email("البريد الإلكتروني غير صالح"),
    password: z.string().min(6, "كلمة المرور يجب أن تكون 6 أحرف على الأقل"),
});

export async function POST(req: Request) {
    try {
        const body = await req.json();
        const validation = registerSchema.safeParse(body);

        if (!validation.success) {
            return NextResponse.json(
                {
                    error: "VALIDATION_ERROR",
                    message: validation.error.issues[0]?.message || "بيانات التسجيل غير صالحة.",
                },
                { status: 400 }
            );
        }

        const { tenantName, tenantSlug, phone, adminName, adminEmail, password } = validation.data;

        const cleanEmail = adminEmail.toLowerCase().trim();
        const cleanSlug = tenantSlug.toLowerCase().trim();

        // 1. Check if tenant slug already exists
        const existingTenant = await prisma.tenant.findUnique({
            where: { slug: cleanSlug },
        });

        if (existingTenant) {
            return NextResponse.json(
                {
                    error: "SLUG_TAKEN",
                    message: "معرف المتجر (Slug) مستخدم بالفعل. يرجى اختيار اسم/رمز آخر للمتجر.",
                },
                { status: 400 }
            );
        }

        // 2. Check if user email already exists
        const existingUser = await prisma.user.findUnique({
            where: { email: cleanEmail },
        });

        if (existingUser) {
            return NextResponse.json(
                {
                    error: "EMAIL_TAKEN",
                    message: "البريد الإلكتروني مسجل بالفعل. يرجى تسجيل الدخول أو استخدام بريد آخر.",
                },
                { status: 400 }
            );
        }

        // 3. Hash password
        const passwordHash = await bcrypt.hash(password, 10);

        // 4. Execute creation in a single transaction (Scope 3 atomicity rule):
        // Create Tenant (subscriptionStatus = PENDING) -> Create Customer (isSystemGenerated = true, "زبون نقدي") -> Update Tenant (systemCustomerId) -> Create ADMIN User
        const result = await prisma.$transaction(async (tx: any) => {
            // Step A: Create Tenant
            const tenant = await tx.tenant.create({
                data: {
                    name: tenantName.trim(),
                    slug: cleanSlug,
                    phone: phone ? phone.trim() : null,
                    subscriptionStatus: "PENDING",
                },
            });

            // Step B: Create system-generated cash customer
            const systemCustomer = await tx.customer.create({
                data: {
                    tenantId: tenant.id,
                    name: "زبون نقدي",
                    isSystemGenerated: true,
                },
            });

            // Step C: Link systemCustomerId on Tenant
            await tx.tenant.update({
                where: { id: tenant.id },
                data: {
                    systemCustomerId: systemCustomer.id,
                },
            });

            // Step D: Create ADMIN User
            const adminUser = await tx.user.create({
                data: {
                    tenantId: tenant.id,
                    name: adminName.trim(),
                    email: cleanEmail,
                    passwordHash,
                    role: "ADMIN",
                    isActive: true,
                    isPlatformAdmin: false,
                },
            });

            return { tenant, systemCustomer, adminUser };
        });

        return NextResponse.json({
            success: true,
            message: "تم تسجيل المتجر بنجاح وهو قيد التفعيل.",
            tenantId: result.tenant.id,
            tenantSlug: result.tenant.slug,
            userId: result.adminUser.id,
        });
    } catch (error) {
        console.error("Error during tenant registration:", error);
        return NextResponse.json(
            {
                error: "SERVER_ERROR",
                message: "حدث خطأ في الخادم أثناء إنشاء الحساب. يرجى المحاولة لاحقاً.",
            },
            { status: 500 }
        );
    }
}
