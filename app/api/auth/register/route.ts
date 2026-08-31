/* app/api/auth/register/route.ts */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { Prisma } from "@prisma/client";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

// FIX: reused Upstash instance, IP-keyed. This endpoint has no email
// verification and no CAPTCHA, and creates real DB rows (Tenant + Customer
// + User) on every accepted request — without a limit it's a trivial DoS
// vector for flooding the platform with junk tenants.
const registerRatelimit =
    process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
        ? new Ratelimit({
            redis: new Redis({
                url: process.env.UPSTASH_REDIS_REST_URL,
                token: process.env.UPSTASH_REDIS_REST_TOKEN,
            }),
            limiter: Ratelimit.slidingWindow(3, "10 m"), // 3 registrations / 10 min per IP
            prefix: "ratelimit:register",
        })
        : null;

// FIX: every top-level path segment this app treats as a real, static
// route (see middleware.ts's DASHBOARD_PATH_PREFIXES, the /admin gate, the
// auth pages, and resolveTenantSlugFromHost's own "www"/"app" exclusions)
// must never be assignable as a tenant slug. Without this, a tenant
// registering with e.g. slug="login" collides with the real /login page:
// Next.js resolves a static route over the dynamic [tenantSlug] route, so
// that tenant's own storefront becomes silently unreachable at their own
// subdomain root. Kept as an explicit list, not inferred from the route
// tree, so it stays reviewable in one place.
const RESERVED_SLUGS = new Set([
    "login", "register", "admin", "api", "dashboard", "pos", "inventory",
    "ledger", "orders", "settings", "account-locked", "store", "www", "app",
]);

const registerSchema = z.object({
    tenantName: z.string().min(2, "اسم المتجر يجب أن يكون من حرفين على الأقل"),
    tenantSlug: z
        .string()
        .min(2, "معرف المتجر (slug) يجب أن يكون من حرفين على الأقل")
        .max(50, "معرف المتجر طويل جداً")
        .regex(/^[a-z0-9-]+$/, "معرف المتجر يجب أن يحتوي على أحرف إنجليزية صغيرة وأرقام وشرطات فقط")
        .refine((slug) => !RESERVED_SLUGS.has(slug), {
            message: "معرف المتجر هذا محجوز، الرجاء اختيار معرف آخر.",
        }),
    phone: z.string().optional().nullable(),
    adminName: z.string().min(2, "اسم المدير يجب أن يكون من حرفين على الأقل"),
    adminEmail: z.string().email("البريد الإلكتروني غير صالح"),
    password: z.string().min(6, "كلمة المرور يجب أن تكون 6 أحرف على الأقل"),
});

export async function POST(req: Request) {
    try {
        const ip =
            req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";

        if (registerRatelimit) {
            const { success } = await registerRatelimit.limit(ip);
            if (!success) {
                return NextResponse.json(
                    {
                        error: "RATE_LIMITED",
                        message: "محاولات تسجيل كثيرة جداً. الرجاء الانتظار قليلاً قبل إعادة المحاولة.",
                    },
                    { status: 429 }
                );
            }
        }

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

        // Pre-checks stay (fast, friendly error for the common case) — the
        // FIX below is that a race past THESE checks is no longer an
        // unhandled 500; see the catch block's P2002 handling.
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

        const passwordHash = await bcrypt.hash(password, 10);

        // Single transaction (Scope 3 atomicity rule): Tenant (PENDING) ->
        // system Customer -> link systemCustomerId -> ADMIN User.
        const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
            const tenant = await tx.tenant.create({
                data: {
                    name: tenantName.trim(),
                    slug: cleanSlug,
                    phone: phone ? phone.trim() : null,
                    subscriptionStatus: "PENDING",
                },
            });

            const systemCustomer = await tx.customer.create({
                data: {
                    tenantId: tenant.id,
                    name: "زبون نقدي",
                    isSystemGenerated: true,
                },
            });

            await tx.tenant.update({
                where: { id: tenant.id },
                data: { systemCustomerId: systemCustomer.id },
            });

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
        // FIX: a P2002 unique-constraint violation here means two
        // registrations for the same slug/email raced past the pre-checks
        // above and both entered the transaction — the loser gets a clear,
        // actionable message instead of a generic 500.
        if (
            error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === "P2002"
        ) {
            const target = (error.meta?.target as string[] | undefined) ?? [];
            const message = target.includes("email")
                ? "البريد الإلكتروني مسجل بالفعل. يرجى تسجيل الدخول أو استخدام بريد آخر."
                : "معرف المتجر (Slug) مستخدم بالفعل. يرجى اختيار اسم/رمز آخر للمتجر.";
            return NextResponse.json({ error: "DUPLICATE", message }, { status: 409 });
        }

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