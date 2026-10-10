/* eslint-disable @typescript-eslint/no-explicit-any */
import {
    UserRole,
    TenantSubscriptionStatus,
    SubscriptionRecordStatus,
    PaymentMethod,
    InvoiceStatus,
    BarcodeSource,
    Prisma,
} from "@prisma/client";
import bcrypt from "bcryptjs";
// [FIX] seed.ts lives at prisma/seed.ts, while lib/db.ts lives at the
// project root's lib/ directory — NOT under prisma/. The previous
// "./lib/db" import resolved to a nonexistent prisma/lib/db.ts and failed
// to compile. Corrected to walk up one directory first.
import { prisma } from "../lib/db";
// [v4.5] Sole gateway for ProductUnitBarcode writes. Imported RELATIVELY (not
// via the "@/" alias) to match this file's existing "../lib/db" import, since
// this script runs outside Next's bundler (`npx tsx prisma/seed.ts`).
import { createUnitBarcode } from "../lib/data/products";
// [v4.5, lint fix] The ONE sanctioned way to write a conversionFactor — the
// same builder lib/data/products.ts and lib/inventory/base-unit.ts spread.
import { buildConversionFactorField } from "../lib/inventory/units";

// ============================================================================
// [v3.6] CURRENCY RE-ANCHORING — SYP is now authoritative, USD informational.
// (unchanged from previous revision — see file history)
// ============================================================================
function usdToSyp(usdAmount: number, exchangeRate: number): number {
    return usdAmount * exchangeRate;
}

async function createProductWithUnit(
    tx: Prisma.TransactionClient,
    args: {
        tenantId: string;
        name: string;
        category: string;
        isPublic: boolean;
        // [v4.6] The ONE image for this product (moved here from ProductUnit).
        // The publishing gate blocks isPublic: true unless this is non-empty,
        // so every isPublic: true seed row below MUST supply it -- an
        // application-level rule with no DB constraint to catch a mistake.
        imageUrl?: string;
        unit: {
            unitName: string;
            conversionFactor: number;
            pricingCurrency: "USD" | "SYP";
            priceWholesale: number;            // [v4.5] Was `barcode?: string; barcodeSource?: BarcodeSource;` —
            // ProductUnit no longer carries barcode scalars. A seeded unit may
            // carry zero, one, or many barcodes; each row below is written as
            // its own top-level ProductUnitBarcode.create() inside the same
            // $transaction (T1's nested-write rule).
            barcodes?: Array<{ barcode: string; barcodeSource: BarcodeSource }>;
        };
    }
) {
    // [FIX] Fail loudly here too, not just rely on remembering to pass
    // imageUrl correctly at every call site — this is the one place that
    // actually enforces the publishing gate for seed data, mirroring the
    // real application-layer rule T3 describes for the live product form.
    if (args.isPublic && !args.imageUrl) {
        throw new Error(
            `Cannot seed "${args.name}" with isPublic: true — imageUrl is required before a product may be public.`
        );
    }

    const product = await tx.product.create({
        data: {
            tenantId: args.tenantId,
            name: args.name,
            category: args.category,
            isPublic: args.isPublic,
            imageUrl: args.imageUrl,
        },
    });

    const unit = await tx.productUnit.create({
        data: {
            tenantId: args.tenantId,
            productId: product.id,
            unitName: args.unit.unitName,
            // [v4.5, lint fix] The value is written through the SAME sanctioned
            // builder every other creation path uses, so the stored decimal
            // string is formalized identically to the live app's (never this
            // file's own un-formalized literal).
            //
            // The one remaining read of a `.conversionFactor` property is
            // disabled deliberately and locally: this seed factory receives the
            // factor as plain DEMO DATA on a hand-written in-memory object, and
            // no conversion math happens anywhere in this file — the rounding-
            // error class CONVERSION_FACTOR_RULES exists to prevent cannot
            // occur here. lib/data/products.ts avoids even this read by taking
            // the factor as a separate positional argument, which is not
            // possible here without restructuring every one of this file's
            // createProductWithUnit() call sites (dozens of hand-written demo
            // rows) for a lint-only gain. The rule itself stays fully ACTIVE for
            // this file — see eslint.config.mjs's prisma/seed.ts block. Do NOT
            // copy this disable anywhere else, and revisit it if seed.ts ever
            // gains real quantity conversion.
            // eslint-disable-next-line no-restricted-syntax -- plain demo-data read, never a conversion (see the note above).
            ...buildConversionFactorField(args.unit.conversionFactor),
            pricingCurrency: args.unit.pricingCurrency,
            priceWholesale: args.unit.priceWholesale,
        },
    });

    // [v4.5] Barcodes live in their own model now — one top-level gateway call
    // per barcode row, in the SAME transaction as the unit above, so a failure
    // can never leave a unit with a partial barcode set. Routed through
    // lib/data/products.ts's createUnitBarcode() rather than writing
    // tx.productUnitBarcode directly: seed.ts is exempt from
    // PRODUCT_MODEL_RULES (it creates Product/ProductUnit itself, documented in
    // T1's Developer Tooling section) but it is NOT one of the two files
    // permitted to touch ProductUnitBarcode — see eslint.config.mjs's
    // PRODUCT_UNIT_BARCODE_MODEL_RULES block.
    for (const row of args.unit.barcodes ?? []) {
        await createUnitBarcode(tx, args.tenantId, unit.id, {
            barcode: row.barcode,
            barcodeSource: row.barcodeSource,
        });
    }

    return { product, unit };
}

async function createInvoiceAtomic(
    tx: Prisma.TransactionClient,
    args: {
        tenantId: string;
        userId: string;
        customerId: string;
        status: InvoiceStatus;
        totalUSD: number;
        totalSYP: number;
        exchangeRateUsed: number;
        paidAmountUSD: number;
        paidAmountSYP: number;
        debtAmountUSD: number;
        debtAmountSYP: number;
        isPaid: boolean;
        voidsInvoiceId?: string;
        items: Array<{
            productId: string;
            unitId: string;
            batchId: string;
            quantity: number;
            unitPriceUSD: number;
            unitPriceSYP: number;
            /**
             * [v4.4, T4g] The frozen cost basis for this seeded line, in SYP.
             * Required and non-nullable on InvoiceItem — seed data must
             * supply a real figure, exactly like every live write path
             * (T4c's sync commit and T5's B2B approval). Demo values are
             * derived by the caller from the same batch's
             * costPricePerBaseUnit, so seeded profit figures stay coherent
             * with the seeded batches.
             */
            costAmountSYP: number;
            /**
             * [v4.8] The exact base-unit amount deducted for this seeded
             * line. Pre-v4.8 seed-style rows sold in the base unit, so
             * callers pass quantity here (base unit factor is 1 by
             * definition); kept explicit so the write below stays
             * byte-identical to every live T4c/T5 write path.
             */
            baseQuantity: number;
        }>;
        batchAdjustments: Array<{ batchId: string; delta: number }>;
        payment?: {
            amountUSD: number;
            amountSYP: number;
            exchangeRate: number;
            paymentMethod: PaymentMethod;
            receiptNo?: string;
        };
    }
) {
    const invoice = await tx.invoice.create({
        data: {
            tenantId: args.tenantId,
            userId: args.userId,
            customerId: args.customerId,
            status: args.status,
            totalUSD: args.totalUSD,
            totalSYP: args.totalSYP,
            exchangeRateUsed: args.exchangeRateUsed,
            paidAmountUSD: args.paidAmountUSD,
            paidAmountSYP: args.paidAmountSYP,
            debtAmountUSD: args.debtAmountUSD,
            debtAmountSYP: args.debtAmountSYP,
            isPaid: args.isPaid,
            voidsInvoiceId: args.voidsInvoiceId,
        },
    });

    for (const item of args.items) {
        await tx.invoiceItem.create({
            data: {
                tenantId: args.tenantId,
                invoiceId: invoice.id,
                productId: item.productId,
                unitId: item.unitId,
                batchId: item.batchId,
                quantity: item.quantity,
                // [v4.8] Exact base-unit amount, never derived by division.
                baseQuantity: item.baseQuantity,
                unitPriceUSD: item.unitPriceUSD,
                unitPriceSYP: item.unitPriceSYP,
                // [v4.4, T4g] Required, non-nullable — see the item type note.
                costAmountSYP: item.costAmountSYP,
            },
        });
    }

    for (const adj of args.batchAdjustments) {
        await tx.productBatch.update({
            where: { id: adj.batchId },
            data: { quantity: { increment: adj.delta } },
        });
    }

    if (args.payment) {
        await tx.customerPayment.create({
            data: {
                tenantId: args.tenantId,
                customerId: args.customerId,
                invoiceId: invoice.id,
                amountUSD: args.payment.amountUSD,
                amountSYP: args.payment.amountSYP,
                exchangeRate: args.payment.exchangeRate,
                paymentMethod: args.payment.paymentMethod,
                receiptNo: args.payment.receiptNo,
            },
        });
    }

    return invoice;
}

// v3.5 FIX: both writes happen inside a single prisma.$transaction(...)
// call. [FIX] `tx` parameter now typed explicitly as Prisma.TransactionClient
// instead of relying on TypeScript's inferred inline object-literal type —
// consistent with createProductWithUnit/createInvoiceAtomic above, and
// safer: an inferred inline type only describes the two methods actually
// called inside this function today, so it would silently fail to warn if
// this function were later extended to call a third tx method incorrectly.
async function ensureSystemCustomer(tenantId: string): Promise<string> {
    const tenant = await prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { systemCustomerId: true },
    });

    if (tenant?.systemCustomerId) {
        return tenant.systemCustomerId;
    }

    const systemCustomerId = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const sysCustomer = await tx.customer.create({
            data: {
                tenantId,
                name: "زبون نقدي عام",
                isSystemGenerated: true,
            },
        });
        await tx.tenant.update({
            where: { id: tenantId },
            data: { systemCustomerId: sysCustomer.id },
        });

        return sysCustomer.id;
    });

    return systemCustomerId;
}

// [FIX — ADDED] Idempotency guard for everything that ISN'T Tenant/User
// (those already use upsert). Without this, running `npx prisma db seed`
// twice duplicated every Product, Customer, ProductBatch, and Invoice for
// a given tenant — silently doubling stock quantities and debt balances,
// which would corrupt any manual testing or demo relying on a predictable
// seed state. Deletes only this tenant's non-system-customer, non-auth
// data, in FK-dependency order (children before parents), then lets the
// rest of main() recreate everything fresh. isSystemGenerated customer and
// the Tenant/User rows themselves are deliberately never touched here —
// they're managed by upsert above and must survive a reseed untouched
// (Tenant.systemCustomerId's Restrict relation would block deleting the
// system customer anyway).
async function resetTenantTransactionalData(tenantId: string): Promise<void> {
    await prisma.invoiceItem.deleteMany({ where: { tenantId } });
    await prisma.customerPayment.deleteMany({ where: { tenantId } });
    await prisma.invoice.deleteMany({ where: { tenantId } });
    await prisma.productBatch.deleteMany({ where: { tenantId } });
    await prisma.productUnit.deleteMany({ where: { tenantId } });
    await prisma.product.deleteMany({ where: { tenantId } });
    // Excludes the system-generated customer deliberately — see comment
    // above.
    await prisma.customer.deleteMany({ where: { tenantId, isSystemGenerated: false } });
}

async function main() {
    if (process.env.NODE_ENV === "production") {
        throw new Error(
            "❌ Refusing to run: seed.ts must never execute against a production environment."
        );
    }

    console.log("🌱 Starting seed script...");

    const passwordHash = await bcrypt.hash("password123", 10);

    // ---------------------------------------------------------------------
    // 1. Tenant: Active subscription (al-baraka)
    // ---------------------------------------------------------------------
    // [FIX — ADDED] expiresAt now set on every tenant whose subscription
    // has actually moved past PENDING. T6's middleware is documented as
    // checking expiresAt directly for grace-period/lockout enforcement —
    // leaving it null on every seeded tenant meant that logic could never
    // be exercised against seed data at all. al-baraka (ACTIVE) gets a
    // real future expiry.
    const albarakaExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days out
    const tenantAlBaraka = await prisma.tenant.upsert({
        where: { slug: "al-baraka" },
        update: {
            dailyExchangeRate: 15000,
            subscriptionStatus: TenantSubscriptionStatus.ACTIVE,
            expiresAt: albarakaExpiresAt,
        },
        create: {
            name: "مؤسسة البركة لتجارة الجملة",
            slug: "al-baraka",
            phone: "+963911223344",
            dailyExchangeRate: 15000,
            subscriptionStatus: TenantSubscriptionStatus.ACTIVE,
            expiresAt: albarakaExpiresAt,
        },
    });

    // [FIX — ADDED] Reset this tenant's transactional data before
    // recreating it below — see resetTenantTransactionalData's comment.
    await resetTenantTransactionalData(tenantAlBaraka.id);

    const systemCustomerAlBaraka = await ensureSystemCustomer(tenantAlBaraka.id);

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

    // [FIX — ADDED] An ACTIVE tenant is only meant to reach that status
    // via a Super-Admin-approved Subscription (T6: "Approving a merchant's
    // first subscription is also what transitions that merchant's
    // Tenant.subscriptionStatus from PENDING to ACTIVE"). Nothing
    // previously created a Subscription row at all, leaving no audit
    // trail for why al-baraka is ACTIVE and nothing to exercise T6's
    // Super-Admin approval-history view against.
    await prisma.subscription.create({
        data: {
            tenantId: tenantAlBaraka.id,
            tier: "STANDARD",
            amountUSD: 25,
            referenceCode: "REF-ALBARAKA-0001",
            status: SubscriptionRecordStatus.ACTIVE,
            expiresAt: albarakaExpiresAt,
        },
    });

    // Product 1: rice, with a batch and expiry.
    // [v4.6] Product.imageUrl now supplied — required because isPublic: true
    // needs an image on the product (see createProductWithUnit's guard).
    const { product: rice, unit: riceUnit } = await prisma.$transaction(
        (tx: Prisma.TransactionClient) =>
            createProductWithUnit(tx, {
                tenantId: tenantAlBaraka.id,
                name: "أرز مصري ممتاز",
                category: "المواد الغذائية",
                isPublic: true,
                imageUrl: "https://placehold.co/600x400?text=Rice",
                unit: {
                    unitName: "كيس 25كغ",
                    conversionFactor: 1,
                    pricingCurrency: "USD",
                    priceWholesale: 20.0,
                    barcodes: [
                        { barcode: "6211234500011", barcodeSource: BarcodeSource.GS1 },
                    ],
                },
            })
    );

    // [v4.4, T4g] Cost per BASE unit, in SYP — required from creation on every
    // write path, seed included. The base unit here IS the bag/طرد
    // (conversionFactor 1), so these are simply per-sale-unit figures.
    const riceCostPerBaseUnitSYP = 120000;
    // [v4.4, Section 10] batchNumber now follows the standardized
    // "{date}-{merchant text}" format. Seed data uses a FIXED date prefix
    // (rather than today's) so repeated seed runs are byte-identical —
    // this is demo data written directly by prisma/seed.ts, never through
    // an API route, so no server-clock rule applies to it.
    // [v4.7] ONE demo receipt for both seeded batches (goods "bought" on the
    // same fixed demo day as their batchNumber prefixes). Written with a
    // plain top-level prisma.productReceipt.create — seed.ts is demo data,
    // never an API path; the API path is lib/data/receipts.ts's
    // createReceiptWithBatches().
    const demoReceipt = await prisma.productReceipt.create({
        data: {
            tenantId: tenantAlBaraka.id,
            createdByUserId: adminAlBaraka.id,
            supplierName: "موردون محليون (بيانات تجريبية)",
            purchaseDate: new Date(Date.UTC(2026, 0, 15)),
        },
    });

    const riceBatch = await prisma.productBatch.create({
        data: {
            tenantId: tenantAlBaraka.id,
            productId: rice.id,
            unitId: riceUnit.id,
            batchNumber: "2026-01-15-RICE-001",
            receiptId: demoReceipt.id,
            quantity: 40,
            // [v4.7] Write-once snapshots: received quantity (base units) and
            // the TOTAL paid for this line (120,000 SYP x 40 = 4,800,000).
            initialQuantity: 40,
            costPricePerBaseUnit: riceCostPerBaseUnitSYP,
            totalCostSYP: 4800000,
            expiryDate: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000),
        },
    });

    // Product 2: cooking oil.
    // [v4.6] Product.imageUrl now supplied — same reasoning as rice above.
    const { product: oil, unit: oilUnit } = await prisma.$transaction(
        (tx: Prisma.TransactionClient) =>
            createProductWithUnit(tx, {
                tenantId: tenantAlBaraka.id,
                name: "زيت نباتي الصافي",
                category: "المواد الغذائية",
                isPublic: true,
                imageUrl: "https://placehold.co/600x400?text=Cooking+Oil",
                unit: {
                    unitName: "طرد 12 لتر",
                    conversionFactor: 1,
                    pricingCurrency: "USD",
                    priceWholesale: 18.5,
                    barcodes: [
                        { barcode: "6211234500028", barcodeSource: BarcodeSource.GS1 },
                    ],
                },
            })
    );

    // [v4.4, T4g] Always SYP (≈15 USD at this tenant's seeded 15000 rate),
    // even though the unit's selling prices are denominated in USD — the cost
    // figure deliberately has no pricingCurrency counterpart.
    const oilCostPerBaseUnitSYP = 225000;
    // [v4.4, Section 10] Same fixed-prefix demo value as the rice batch above.
    const oilBatch = await prisma.productBatch.create({
        data: {
            tenantId: tenantAlBaraka.id,
            productId: oil.id,
            unitId: oilUnit.id,
            batchNumber: "2026-01-15-OIL-001",
            receiptId: demoReceipt.id,
            quantity: 15,
            // [v4.7] Write-once snapshots (225,000 SYP x 15 = 3,375,000).
            initialQuantity: 15,
            costPricePerBaseUnit: oilCostPerBaseUnitSYP,
            totalCostSYP: 3375000,
            expiryDate: null,
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

    // Invoice 1: 2 bags sold, half paid at sale time, half on credit.
    const rate1 = 15000;
    await prisma.$transaction((tx: Prisma.TransactionClient) =>
        createInvoiceAtomic(tx, {
            tenantId: tenantAlBaraka.id,
            userId: adminAlBaraka.id,
            customerId: customer.id,
            status: InvoiceStatus.COMPLETED,
            totalUSD: 40,
            totalSYP: usdToSyp(40, rate1),
            exchangeRateUsed: rate1,
            paidAmountUSD: 20,
            paidAmountSYP: usdToSyp(20, rate1),
            debtAmountUSD: 20,
            debtAmountSYP: usdToSyp(20, rate1),
            isPaid: false,
            items: [
                {
                    productId: rice.id,
                    unitId: riceUnit.id,
                    batchId: riceBatch.id,
                    quantity: 2,
                    // [v4.8] Base-unit sale: base quantity equals quantity.
                    baseQuantity: 2,
                    unitPriceUSD: 20,
                    unitPriceSYP: usdToSyp(20, rate1),
                    // [v4.4, T4g] Frozen cost basis for this line:
                    // quantity (base units) × the batch's cost per base unit.
                    costAmountSYP: 2 * riceCostPerBaseUnitSYP,
                },
            ],
            batchAdjustments: [{ batchId: riceBatch.id, delta: -2 }],
            payment: {
                amountUSD: 20,
                amountSYP: usdToSyp(20, rate1),
                exchangeRate: rate1,
                paymentMethod: PaymentMethod.CASH,
                receiptNo: "RCPT-0001",
            },
        })
    );

    // A second, independent repayment against remaining debt.
    await prisma.customerPayment.create({
        data: {
            tenantId: tenantAlBaraka.id,
            customerId: customer.id,
            amountUSD: 10,
            amountSYP: usdToSyp(10, rate1),
            exchangeRate: rate1,
            paymentMethod: PaymentMethod.CASH,
            receiptNo: "RCPT-0002",
        },
    });

    // Invoice 2: 1 bag sold, then fully voided.
    const invoiceToVoid = await prisma.$transaction((tx: Prisma.TransactionClient) =>
        createInvoiceAtomic(tx, {
            tenantId: tenantAlBaraka.id,
            userId: adminAlBaraka.id,
            customerId: customer.id,
            status: InvoiceStatus.COMPLETED,
            totalUSD: 20,
            totalSYP: usdToSyp(20, rate1),
            exchangeRateUsed: rate1,
            paidAmountUSD: 0,
            paidAmountSYP: 0,
            debtAmountUSD: 20,
            debtAmountSYP: usdToSyp(20, rate1),
            isPaid: false,
            items: [
                {
                    productId: rice.id,
                    unitId: riceUnit.id,
                    batchId: riceBatch.id,
                    quantity: 1,
                    // [v4.8] Base-unit sale: base quantity equals quantity.
                    baseQuantity: 1,
                    unitPriceUSD: 20,
                    unitPriceSYP: usdToSyp(20, rate1),
                    // [v4.4, T4g] Frozen cost basis for this line.
                    costAmountSYP: riceCostPerBaseUnitSYP,
                },
            ],
            batchAdjustments: [{ batchId: riceBatch.id, delta: -1 }],
        })
    );

    await prisma.$transaction((tx: Prisma.TransactionClient) =>
        createInvoiceAtomic(tx, {
            tenantId: tenantAlBaraka.id,
            userId: adminAlBaraka.id,
            customerId: customer.id,
            status: InvoiceStatus.VOIDED,
            voidsInvoiceId: invoiceToVoid.id,
            totalUSD: -20,
            totalSYP: usdToSyp(-20, rate1),
            exchangeRateUsed: rate1,
            paidAmountUSD: 0,
            paidAmountSYP: 0,
            debtAmountUSD: -20,
            debtAmountSYP: usdToSyp(-20, rate1),
            isPaid: true,
            items: [
                {
                    productId: rice.id,
                    unitId: riceUnit.id,
                    batchId: riceBatch.id,
                    quantity: -1,
                    // [v4.8] Void mirror restores the exact base-unit amount.
                    baseQuantity: -1,
                    unitPriceUSD: 20,
                    unitPriceSYP: usdToSyp(20, rate1),
                    // [v4.4, T4d/T4g] A voided line always carries the NEGATED
                    // cost of the line it reverses, so (original + void) sums
                    // to exactly zero here and in every live void path.
                    costAmountSYP: -riceCostPerBaseUnitSYP,
                },
            ],
            batchAdjustments: [{ batchId: riceBatch.id, delta: 1 }],
        })
    );
    // Net riceBatch.quantity after all of the above: 40 - 2 - 1 + 1 = 38.

    // Invoice 3: fully-paid cash sale against the system customer.
    await prisma.$transaction((tx: Prisma.TransactionClient) =>
        createInvoiceAtomic(tx, {
            tenantId: tenantAlBaraka.id,
            userId: adminAlBaraka.id,
            customerId: systemCustomerAlBaraka,
            status: InvoiceStatus.COMPLETED,
            totalUSD: 18.5,
            totalSYP: usdToSyp(18.5, rate1),
            exchangeRateUsed: rate1,
            paidAmountUSD: 18.5,
            paidAmountSYP: usdToSyp(18.5, rate1),
            debtAmountUSD: 0,
            debtAmountSYP: 0,
            isPaid: true,
            items: [
                {
                    productId: oil.id,
                    unitId: oilUnit.id,
                    batchId: oilBatch.id,
                    quantity: 1,
                    // [v4.8] Base-unit sale: base quantity equals quantity.
                    baseQuantity: 1,
                    unitPriceUSD: 18.5,
                    unitPriceSYP: usdToSyp(18.5, rate1),
                    // [v4.4, T4g] Frozen cost basis for this line.
                    costAmountSYP: oilCostPerBaseUnitSYP,
                },
            ],
            batchAdjustments: [{ batchId: oilBatch.id, delta: -1 }],
            payment: {
                amountUSD: 18.5,
                amountSYP: usdToSyp(18.5, rate1),
                exchangeRate: rate1,
                paymentMethod: PaymentMethod.CASH,
                receiptNo: "RCPT-0003",
            },
        })
    );
    // Net oilBatch.quantity after the above: 15 - 1 = 14.

    // ---------------------------------------------------------------------
    // 2. Tenant: Expired subscription (al-noor)
    // ---------------------------------------------------------------------
    // [FIX — ADDED] expiresAt set in the PAST, consistent with EXPIRED
    // status — this tenant previously had expiresAt = null despite being
    // EXPIRED, which cannot exercise a middleware that actually checks
    // `expiresAt < now()` rather than status alone.
    const tenantAlNoor = await prisma.tenant.upsert({
        where: { slug: "al-noor" },
        update: {
            dailyExchangeRate: 14800,
            subscriptionStatus: TenantSubscriptionStatus.EXPIRED,
            expiresAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000), // 5 days ago
        },
        create: {
            name: "شركة النور للمواد الغذائية",
            slug: "al-noor",
            phone: "+963955667788",
            dailyExchangeRate: 14800,
            subscriptionStatus: TenantSubscriptionStatus.EXPIRED,
            expiresAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
        },
    });

    await resetTenantTransactionalData(tenantAlNoor.id);
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
    // 3. Tenant: Pending subscription (al-fajr)
    // ---------------------------------------------------------------------
    // expiresAt intentionally left null: a PENDING tenant has never had a
    // subscription approved yet, so there is no expiry to set — this is
    // the one case where null remains correct, not an oversight.
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

    await resetTenantTransactionalData(tenantAlFajr.id);
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

    // [FIX — ADDED] al-fajr is PENDING, meaning it's awaiting exactly the
    // kind of first-approval Subscription row T6's Super-Admin dashboard
    // is meant to review. Without one, that dashboard's "pending requests
    // table" has nothing to display against seed data.
    await prisma.subscription.create({
        data: {
            tenantId: tenantAlFajr.id,
            tier: "STANDARD",
            amountUSD: 25,
            referenceCode: "REF-ALFAJR-0001",
            status: SubscriptionRecordStatus.PENDING_APPROVAL,
        },
    });

    // ---------------------------------------------------------------------
    // 4. Platform Super-Admin
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