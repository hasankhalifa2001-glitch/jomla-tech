import {
    PrismaClient,
    UserRole,
    TenantSubscriptionStatus,
    PaymentMethod,
    InvoiceStatus,
} from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
    // GUARD: this script issues upserts with a shared, publicly-known
    // password ("password123") for every account it touches, including a
    // platform super-admin. Running it against a real database would be a
    // full account takeover of every seeded tenant. Refuse outright.
    if (process.env.NODE_ENV === "production") {
        throw new Error(
            "❌ Refusing to run: seed.ts must never execute against a production environment."
        );
    }

    console.log("🌱 Starting seed script...");

    const passwordHash = await bcrypt.hash("password123", 10);

    async function ensureSystemCustomer(tenantId: string) {
        const tenant = await prisma.tenant.findUnique({
            where: { id: tenantId },
            select: { systemCustomerId: true },
        });

        if (!tenant?.systemCustomerId) {
            const sysCustomer = await prisma.customer.create({
                data: {
                    tenantId,
                    name: "زبون نقدي عام",
                    isSystemGenerated: true,
                },
            });
            await prisma.tenant.update({
                where: { id: tenantId },
                data: { systemCustomerId: sysCustomer.id },
            });
        }
    }

    // ---------------------------------------------------------------------
    // 1. Tenant: Active subscription (al-baraka)
    // ---------------------------------------------------------------------
    const tenantAlBaraka = await prisma.tenant.upsert({
        where: { slug: "al-baraka" },
        update: {
            dailyExchangeRate: 15000,
            subscriptionStatus: TenantSubscriptionStatus.ACTIVE,
        },
        create: {
            name: "مؤسسة البركة لتجارة الجملة",
            slug: "al-baraka",
            phone: "+963911223344",
            dailyExchangeRate: 15000,
            subscriptionStatus: TenantSubscriptionStatus.ACTIVE,
        },
    });

    await ensureSystemCustomer(tenantAlBaraka.id);

    const adminAlBaraka = await prisma.user.upsert({
        where: { email: "admin@albaraka.com" },
        update: { passwordHash, role: UserRole.ADMIN, isPlatformAdmin: false },
        create: {
            tenantId: tenantAlBaraka.id,
            name: "أحمد المدير",
            email: "admin@albaraka.com",
            passwordHash,
            role: UserRole.ADMIN,
            isPlatformAdmin: false,
        },
    });

    await prisma.user.upsert({
        where: { email: "cashier@albaraka.com" },
        update: { passwordHash, role: UserRole.CASHIER, isPlatformAdmin: false },
        create: {
            tenantId: tenantAlBaraka.id,
            name: "سامر الكاشير",
            email: "cashier@albaraka.com",
            passwordHash,
            role: UserRole.CASHIER,
            isPlatformAdmin: false,
        },
    });

    // Product 1: rice, with a batch and expiry — exercises T3's expiry
    // tracking and FIFO deduction.
    const rice = await prisma.product.create({
        data: {
            tenantId: tenantAlBaraka.id,
            name: "أرز مصري ممتاز",
            category: "المواد الغذائية",
            isPublic: true,
            units: {
                create: {
                    tenantId: tenantAlBaraka.id,
                    unitName: "كيس 25كغ",
                    conversionFactor: 1,
                    priceWholesale: 20.0,
                    priceRetail: 22.0,
                    pricingCurrency: "USD",
                    barcode: "6291001001",
                },
            },
        },
        include: { units: true },
    });

    const riceUnit = rice.units[0];

    const riceBatch = await prisma.productBatch.create({
        data: {
            tenantId: tenantAlBaraka.id,
            productId: rice.id,
            unitId: riceUnit.id,
            batchNumber: "BATCH-2026-001",
            quantity: 40,
            expiryDate: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000), // ~20 days out
        },
    });

    // Product 2: cooking oil, no batch needed for seed purposes.
    await prisma.product.create({
        data: {
            tenantId: tenantAlBaraka.id,
            name: "زيت نباتي الصافي",
            category: "المواد الغذائية",
            isPublic: true,
            units: {
                create: {
                    tenantId: tenantAlBaraka.id,
                    unitName: "طرد 12 لتر",
                    conversionFactor: 1,
                    priceWholesale: 18.5,
                    priceRetail: 20.0,
                    pricingCurrency: "USD",
                    barcode: "6291001002",
                },
            },
        },
    });

    const customer = await prisma.customer.create({
        data: {
            tenantId: tenantAlBaraka.id,
            name: "محل أبو خالد",
            phone: "+963933112233",
            shopName: "بقالة أبو خالد",
        },
    });

    // Invoice 1: 2 bags sold, half paid, half on credit. Left standing —
    // not voided — so the ledger view has a real outstanding debt to show.
    await prisma.invoice.create({
        data: {
            tenantId: tenantAlBaraka.id,
            userId: adminAlBaraka.id,
            customerId: customer.id,
            totalUSD: 40,
            totalSYP: 40 * 15000,
            exchangeRateUsed: 15000,
            paidAmountUSD: 20,
            debtAmountUSD: 20,
            isPaid: false,
            status: InvoiceStatus.COMPLETED,
            items: {
                create: {
                    tenantId: tenantAlBaraka.id,
                    productId: rice.id,
                    unitId: riceUnit.id,
                    batchId: riceBatch.id,
                    quantity: 2,
                    unitPriceUSD: 20,
                },
            },
        },
    });
    await prisma.productBatch.update({
        where: { id: riceBatch.id },
        data: { quantity: { decrement: 2 } },
    });

    // Partial repayment against invoice 1's debt.
    await prisma.customerPayment.create({
        data: {
            tenantId: tenantAlBaraka.id,
            customerId: customer.id,
            amountUSD: 10,
            amountSYP: 10 * 15000,
            exchangeRate: 15000,
            paymentMethod: PaymentMethod.CASH,
            receiptNo: "RCPT-0001",
        },
    });

    // Invoice 2: 1 bag sold, then fully voided — a physical stock return
    // (customer brought back a damaged bag), which is the only kind of
    // void this platform supports; a pure data-entry mistake with no
    // physical stock movement is corrected with an offsetting
    // CustomerPayment instead, not this mechanism.
    //
    // Demonstrates the full append-only reversal end to end: the original
    // COMPLETED invoice is never edited, a new VOIDED invoice with negated
    // totals AND negated item quantities points back at it via
    // voidsInvoiceId, and the batch quantity is restored by that same
    // negated amount.
    const invoiceToVoid = await prisma.invoice.create({
        data: {
            tenantId: tenantAlBaraka.id,
            userId: adminAlBaraka.id,
            customerId: customer.id,
            totalUSD: 20,
            totalSYP: 20 * 15000,
            exchangeRateUsed: 15000,
            paidAmountUSD: 0,
            debtAmountUSD: 20,
            isPaid: false,
            status: InvoiceStatus.COMPLETED,
            items: {
                create: {
                    tenantId: tenantAlBaraka.id,
                    productId: rice.id,
                    unitId: riceUnit.id,
                    batchId: riceBatch.id,
                    quantity: 1,
                    unitPriceUSD: 20,
                },
            },
        },
    });
    await prisma.productBatch.update({
        where: { id: riceBatch.id },
        data: { quantity: { decrement: 1 } },
    });

    await prisma.invoice.create({
        data: {
            tenantId: tenantAlBaraka.id,
            userId: adminAlBaraka.id,
            customerId: customer.id,
            totalUSD: -20,
            totalSYP: -20 * 15000,
            exchangeRateUsed: 15000,
            paidAmountUSD: 0,
            debtAmountUSD: -20,
            isPaid: true,
            status: InvoiceStatus.VOIDED,
            voidsInvoiceId: invoiceToVoid.id,
            items: {
                create: {
                    tenantId: tenantAlBaraka.id,
                    productId: rice.id,
                    unitId: riceUnit.id,
                    batchId: riceBatch.id,
                    quantity: -1, // mirrors invoiceToVoid's item, negated
                    unitPriceUSD: 20,
                },
            },
        },
    });
    // The physical stock return itself — restore the batch by the same
    // amount the voided item negated. In the real /api endpoint this must
    // happen atomically with the invoice creation above, in one transaction.
    await prisma.productBatch.update({
        where: { id: riceBatch.id },
        data: { quantity: { increment: 1 } },
    });
    // Net riceBatch.quantity after all of the above: 40 - 2 - 1 + 1 = 38.

    // ---------------------------------------------------------------------
    // 2. Tenant: Expired subscription (al-noor) — verifies the middleware's
    // EXPIRED lockout: admin -> /settings/billing, cashier -> /account-locked.
    // ---------------------------------------------------------------------
    const tenantAlNoor = await prisma.tenant.upsert({
        where: { slug: "al-noor" },
        update: {
            dailyExchangeRate: 14800,
            subscriptionStatus: TenantSubscriptionStatus.EXPIRED,
        },
        create: {
            name: "شركة النور للمواد الغذائية",
            slug: "al-noor",
            phone: "+963955667788",
            dailyExchangeRate: 14800,
            subscriptionStatus: TenantSubscriptionStatus.EXPIRED,
        },
    });

    await ensureSystemCustomer(tenantAlNoor.id);

    await prisma.user.upsert({
        where: { email: "admin@alnoor.com" },
        update: { passwordHash, role: UserRole.ADMIN, isPlatformAdmin: false },
        create: {
            tenantId: tenantAlNoor.id,
            name: "خالد التاجر",
            email: "admin@alnoor.com",
            passwordHash,
            role: UserRole.ADMIN,
            isPlatformAdmin: false,
        },
    });

    await prisma.user.upsert({
        where: { email: "cashier@alnoor.com" },
        update: { passwordHash, role: UserRole.CASHIER, isPlatformAdmin: false },
        create: {
            tenantId: tenantAlNoor.id,
            name: "ريم الكاشير",
            email: "cashier@alnoor.com",
            passwordHash,
            role: UserRole.CASHIER,
            isPlatformAdmin: false,
        },
    });

    // ---------------------------------------------------------------------
    // 3. Tenant: Pending subscription (al-fajr) — a merchant who just
    // registered and hasn't been approved yet. Verifies the middleware's
    // PENDING lockout path specifically, which is otherwise identical in
    // code to EXPIRED but was previously untested by this seed: admin ->
    // /settings/billing, cashier -> /account-locked.
    // ---------------------------------------------------------------------
    const tenantAlFajr = await prisma.tenant.upsert({
        where: { slug: "al-fajr" },
        update: {
            subscriptionStatus: TenantSubscriptionStatus.PENDING,
        },
        create: {
            name: "مؤسسة الفجر للمواد الغذائية",
            slug: "al-fajr",
            phone: "+963944556677",
            subscriptionStatus: TenantSubscriptionStatus.PENDING,
        },
    });

    await ensureSystemCustomer(tenantAlFajr.id);

    await prisma.user.upsert({
        where: { email: "admin@alfajr.com" },
        update: { passwordHash, role: UserRole.ADMIN, isPlatformAdmin: false },
        create: {
            tenantId: tenantAlFajr.id,
            name: "منى صاحبة المحل",
            email: "admin@alfajr.com",
            passwordHash,
            role: UserRole.ADMIN,
            isPlatformAdmin: false,
        },
    });

    await prisma.user.upsert({
        where: { email: "cashier@alfajr.com" },
        update: { passwordHash, role: UserRole.CASHIER, isPlatformAdmin: false },
        create: {
            tenantId: tenantAlFajr.id,
            name: "علي الكاشير",
            email: "cashier@alfajr.com",
            passwordHash,
            role: UserRole.CASHIER,
            isPlatformAdmin: false,
        },
    });

    // ---------------------------------------------------------------------
    // 4. Platform Super-Admin — the only account that can reach /admin/*
    // (T6's subscription approval dashboard, including approving al-fajr's
    // pending request above). Still belongs to a tenant record
    // (User.tenantId is a required FK), so a dedicated internal "platform"
    // tenant keeps it from being confused with a real merchant.
    // ---------------------------------------------------------------------
    const platformTenant = await prisma.tenant.upsert({
        where: { slug: "platform-internal" },
        update: {},
        create: {
            name: "منصة الإدارة الداخلية",
            slug: "platform-internal",
            subscriptionStatus: TenantSubscriptionStatus.ACTIVE,
        },
    });

    await prisma.user.upsert({
        where: { email: "superadmin@platform.com" },
        update: { passwordHash, role: UserRole.ADMIN, isPlatformAdmin: true },
        create: {
            tenantId: platformTenant.id,
            name: "المدير العام للمنصة",
            email: "superadmin@platform.com",
            passwordHash,
            role: UserRole.ADMIN,
            isPlatformAdmin: true,
        },
    });

    console.log("✅ Seed completed successfully!");
}

main()
    .catch((e) => {
        console.error("❌ Error during seed:", e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });