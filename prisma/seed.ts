import {
    PrismaClient,
    UserRole,
    TenantSubscriptionStatus,
    PaymentMethod,
    InvoiceStatus,
    BarcodeSource,
    Prisma,
} from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

// ============================================================================
// [v3.6] CURRENCY RE-ANCHORING — SYP is now authoritative, USD informational.
// See the currency re-anchoring note at the top of schema.prisma for the
// full rationale. In THIS file specifically: every product below is still
// priced in USD at the ProductUnit level (pricingCurrency: "USD") — that's
// unaffected by this change, it's a per-product merchant choice. What
// changes is how a SALE gets recorded: `unitPriceSYP`, `totalSYP`,
// `paidAmountSYP`, and `debtAmountSYP` are now the fields every downstream
// validation/ledger calculation reads first. The USD fields are still
// written (never dropped — they're real columns, and useful for merchant
// reference), but they're derived from the SYP side conceptually, not the
// other way around, from this revision forward.
//
// `usdToSyp` below is the one place in this seed file that performs that
// conversion — every call site computes its SYP figure through it rather
// than inlining `x * exchangeRateUsed` by hand, so there's one spot to fix
// if the direction of this conversion is ever revisited again.
// ============================================================================
function usdToSyp(usdAmount: number, exchangeRate: number): number {
    return usdAmount * exchangeRate;
}

// ============================================================================
// NESTED-WRITE COMPLIANCE (v3.4 Tenant Isolation rule): every write to a
// tenant-scoped model in this file is its own top-level `tx.<model>.<method>`
// call, never a nested `create`/`update` buried inside another model's
// `data` object — the same rule schema.prisma documents as project-wide,
// with no exception carved out for seed/dev scripts. The two helpers below
// (`createProductWithUnit`, `createInvoiceAtomic`) exist specifically so
// every call site in `main()` gets this for free instead of hand-rolling it
// per product/invoice. Both helpers take a `Prisma.TransactionClient` (`tx`)
// and are always invoked from inside `prisma.$transaction(async (tx) => ...)`
// — mirroring T4c's real /api/sync shape, so this script doubles as a
// correct usage example, not just seed data.
//
// SCOPE OF THAT "usage example" CLAIM — read before copying this into T4c:
// `createInvoiceAtomic` below correctly demonstrates the NESTED-WRITE rule
// (every write is a top-level call inside one $transaction) — that part is
// safe to copy verbatim. It does NOT demonstrate T4c's separate, equally-
// mandatory BATCH LOCKING rule: its `batchAdjustments` loop calls
// `tx.productBatch.update({ increment })` directly, with no preceding
// `SELECT ... FOR UPDATE ORDER BY id ASC`. That's correct here — this
// script runs single-threaded with no concurrent writers, so there's
// nothing to lock against — but it means this helper is NOT a template for
// T4c's real invoice-sync path as-is. When adapting this shape for the
// actual /api/sync implementation, the deterministic `ORDER BY id ASC`
// batch lock (documented on ProductBatch in schema.prisma) must be added
// explicitly before the equivalent update loop; do not assume this
// function already covers it just because it looks similar.
//
// v3.5 FIX — see `ensureSystemCustomer` below: the previous version of this
// script created the system-generated Customer row and updated
// `Tenant.systemCustomerId` as two separate, unwrapped `prisma.*` calls —
// not inside a `$transaction`. That directly violated T2's onboarding rule
// ("... runs in one transaction ... so there is never a window where the
// tenant exists without its system customer linked"). A crash between the
// two calls would have left an orphaned system-generated Customer row with
// `Tenant.systemCustomerId` still null. Fixed below by wrapping both writes
// in a single `prisma.$transaction(...)` call, matching the same pattern
// `createInvoiceAtomic` already used correctly.
// ============================================================================

async function createProductWithUnit(
    tx: Prisma.TransactionClient,
    args: {
        tenantId: string;
        name: string;
        category: string;
        isPublic: boolean;
        unit: {
            unitName: string;
            conversionFactor: number;
            pricingCurrency: "USD" | "SYP";
            priceWholesale: number;
            priceRetail?: number;
            barcode?: string;
            barcodeSource?: BarcodeSource;
        };
    }
) {
    const product = await tx.product.create({
        data: {
            tenantId: args.tenantId,
            name: args.name,
            category: args.category,
            isPublic: args.isPublic,
        },
    });

    const unit = await tx.productUnit.create({
        data: {
            tenantId: args.tenantId,
            productId: product.id,
            unitName: args.unit.unitName,
            conversionFactor: args.unit.conversionFactor,
            pricingCurrency: args.unit.pricingCurrency,
            priceWholesale: args.unit.priceWholesale,
            priceRetail: args.unit.priceRetail,
            barcode: args.unit.barcode,
            barcodeSource: args.unit.barcodeSource,
        },
    });

    return { product, unit };
}

async function createInvoiceAtomic(
    tx: Prisma.TransactionClient,
    args: {
        tenantId: string;
        userId: string;
        customerId: string;
        status: InvoiceStatus;
        // [v3.6] totalSYP is authoritative; totalUSD is informational
        // (still stored, still real — just no longer what validation or
        // the ledger reads first). See the file-header note above.
        totalUSD: number;
        totalSYP: number;
        exchangeRateUsed: number;
        // [v3.6] paidAmountSYP / debtAmountSYP are NEW required fields —
        // the v3.5 version of this file only carried the USD pair.
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
            // [v3.6] NEW required field — authoritative per-line price;
            // unitPriceUSD stays as the informational figure.
            unitPriceSYP: number;
        }>;
        // Batch quantity deltas applied atomically alongside the invoice —
        // positive to restore stock (a void), negative to deduct it (a
        // sale). Kept as an explicit separate list rather than derived
        // from `items[].quantity` because a void's items are already
        // negated (see the void example below), and folding both
        // conventions into one field would be easy to get backwards.
        //
        // NOT lock-safe for concurrent writers — see the file-header note
        // above. Fine for this single-threaded seed script; must gain an
        // explicit `SELECT ... FOR UPDATE ORDER BY id ASC` step before any
        // of this logic is reused for T4c's real sync endpoint.
        batchAdjustments: Array<{ batchId: string; delta: number }>;
        // Optional — present exactly when paidAmountSYP > 0, matching
        // T4c's rule that a synced invoice with a nonzero sale-time
        // payment always gets exactly one CustomerPayment with invoiceId
        // set to this invoice's id, created in the same transaction.
        // [v3.6] The trigger condition was paidAmountUSD > 0 through v3.5
        // — see the currency re-anchoring note at the top of this file.
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
                unitPriceUSD: item.unitPriceUSD,
                unitPriceSYP: item.unitPriceSYP,
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

// v3.5 FIX: both writes (creating the system-generated Customer row and
// pointing Tenant.systemCustomerId at it) now happen inside a single
// `prisma.$transaction(...)` call, exactly mirroring T2's own onboarding
// rule and the pattern `createInvoiceAtomic` already used correctly. Prior
// to this fix, the two calls were issued directly against the top-level
// `prisma` client with no transaction wrapper, leaving a real window where
// a crash between them could orphan a Customer row while
// `Tenant.systemCustomerId` stayed null — the exact failure mode T2's spec
// explicitly says must never be possible.
async function ensureSystemCustomer(tenantId: string): Promise<string> {
    const tenant = await prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { systemCustomerId: true },
    });

    if (tenant?.systemCustomerId) {
        return tenant.systemCustomerId;
    }

    const systemCustomerId = await prisma.$transaction(async (tx) => {
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

    // Product 1: rice, with a batch and expiry — exercises T3's expiry
    // tracking and FIFO deduction. Barcode is a realistic 13-digit GS1
    // code under Syria's registered prefix (621), with a correctly
    // computed EAN-13 check digit — real enough that a check-digit
    // validation test run against seed data won't spuriously fail.
    const { product: rice, unit: riceUnit } = await prisma.$transaction(
        (tx) =>
            createProductWithUnit(tx, {
                tenantId: tenantAlBaraka.id,
                name: "أرز مصري ممتاز",
                category: "المواد الغذائية",
                isPublic: true,
                unit: {
                    unitName: "كيس 25كغ",
                    conversionFactor: 1,
                    pricingCurrency: "USD",
                    priceWholesale: 20.0,
                    priceRetail: 22.0,
                    barcode: "6211234500011",
                    barcodeSource: BarcodeSource.GS1,
                },
            })
    );

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

    // Product 2: cooking oil. Now carries its own batch (no expiry date
    // set — demonstrates the legitimate case of a batch with no tracked
    // expiry, since ProductBatch.expiryDate is nullable) so it can
    // actually be sold in the cash-customer example below; the original
    // "no batch needed for seed purposes" note no longer holds once the
    // seed needs a second real, sellable product.
    const { product: oil, unit: oilUnit } = await prisma.$transaction(
        (tx) =>
            createProductWithUnit(tx, {
                tenantId: tenantAlBaraka.id,
                name: "زيت نباتي الصافي",
                category: "المواد الغذائية",
                isPublic: true,
                unit: {
                    unitName: "طرد 12 لتر",
                    conversionFactor: 1,
                    pricingCurrency: "USD",
                    priceWholesale: 18.5,
                    priceRetail: 20.0,
                    barcode: "6211234500028",
                    barcodeSource: BarcodeSource.GS1,
                },
            })
    );

    const oilBatch = await prisma.productBatch.create({
        data: {
            tenantId: tenantAlBaraka.id,
            productId: oil.id,
            unitId: oilUnit.id,
            batchNumber: "BATCH-2026-002",
            quantity: 15,
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

    // Invoice 1: 2 bags sold, half paid at sale time, half on credit. Left
    // standing — not voided — so the ledger view has a real outstanding
    // debt to show.
    //
    // [v3.6] debtAmountSYP (not debtAmountUSD) is now the authoritative
    // figure the ledger/T4c validation reads — computed here via
    // usdToSyp() from the same USD figures this seed has always used to
    // author the numbers by hand, since that's the more readable way to
    // write seed data, not because USD is authoritative anymore.
    //
    // paidAmountSYP > 0 here has its matching sale-time CustomerPayment
    // created in the SAME transaction, with invoiceId pointing at this
    // invoice — this is the exact invariant T4c's sync logic and T4e's
    // debt-doubling guard depend on ("a synced invoice with a nonzero
    // sale-time payment always has exactly one corresponding
    // CustomerPayment row").
    const rate1 = 15000;
    await prisma.$transaction((tx) =>
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
                    unitPriceUSD: 20,
                    unitPriceSYP: usdToSyp(20, rate1),
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

    // A second, independent repayment against the customer's remaining
    // debt — logged later, unrelated to any specific invoice, so
    // invoiceId is correctly left unset (null). This is the kind of row
    // T4e's `WHERE invoiceId IS NULL` filter is actually meant to count.
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

    // Invoice 2: 1 bag sold, then fully voided — a physical stock return
    // (customer brought back a damaged bag), which is the only kind of
    // void this platform supports; a pure data-entry mistake with no
    // physical stock movement is corrected with an offsetting
    // CustomerPayment instead, not this mechanism.
    //
    // Demonstrates the full append-only reversal end to end: the original
    // COMPLETED invoice is never edited (its own isPaid/debtAmountSYP stay
    // exactly as created below, forever), a new VOIDED invoice with
    // negated totals AND negated item quantities points back at it via
    // voidsInvoiceId, and the batch quantity is restored by that same
    // negated amount — all three (invoice, item, batch update) atomic in
    // one transaction, matching T4d's requirement.
    const invoiceToVoid = await prisma.$transaction((tx) =>
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
                    unitPriceUSD: 20,
                    unitPriceSYP: usdToSyp(20, rate1),
                },
            ],
            batchAdjustments: [{ batchId: riceBatch.id, delta: -1 }],
            // paidAmountSYP is 0 here — fully on credit — so no `payment`
            // is passed, correctly producing zero CustomerPayment rows for
            // this invoice, per the same T4c invariant referenced above.
        })
    );

    // The reversing VOIDED invoice. isPaid is set to `true` here
    // deliberately, even though debtAmountSYP is nonzero (negative) — this
    // is NOT the same meaning `isPaid` carries on a normal sale. On a
    // VOIDED row, the negative debtAmountSYP represents a CREDIT owed back
    // to the customer via the physical stock return, not an amount this
    // platform is still waiting to collect FROM them — there is no
    // outstanding collection action on this row, which is what isPaid is
    // actually signaling here. The original invoiceToVoid above keeps its
    // own isPaid: false / debtAmountSYP: usdToSyp(20, rate1) completely
    // untouched, exactly as the append-only rule requires; only the SUM()
    // across both rows (in T4e's ledger formula, now over debtAmountSYP)
    // is what nets out to what the customer actually owes after the
    // return. If this distinction ever proves confusing in practice,
    // revisit whether `isPaid` belongs on a VOIDED row at all rather than
    // being derived/ignored for that status.
    await prisma.$transaction((tx) =>
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
                    quantity: -1, // mirrors invoiceToVoid's item, negated
                    unitPriceUSD: 20,
                    unitPriceSYP: usdToSyp(20, rate1),
                },
            ],
            // The physical stock return itself — restores the batch by the
            // same amount the voided item negated. Positive delta, unlike
            // a normal sale's negative one; see the field comment on
            // `batchAdjustments` in createInvoiceAtomic for why this isn't
            // just derived from the negated item quantity automatically.
            batchAdjustments: [{ batchId: riceBatch.id, delta: 1 }],
        })
    );
    // Net riceBatch.quantity after all of the above: 40 - 2 - 1 + 1 = 38.

    // Invoice 3: a fully-paid cash sale against the tenant's seeded
    // system customer — exercises T4b's one-tap "زبون نقدي" flow.
    // paidAmountSYP == totalSYP and debtAmountSYP == 0, satisfying the
    // application-level rule that the system-generated customer may only
    // be referenced by a zero-debt invoice (debtAmountSYP = 0 as of
    // [v3.6] — was debtAmountUSD = 0 through v3.5).
    await prisma.$transaction((tx) =>
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
                    unitPriceUSD: 18.5,
                    unitPriceSYP: usdToSyp(18.5, rate1),
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
    //
    // v3.5: this pattern — a placeholder, non-merchant Tenant existing
    // solely to satisfy User.tenantId's required-FK constraint for
    // platform-level accounts — is now documented as the canonical
    // approach in the spec (see "Platform Identity" under T6). The actual
    // authorization check for every /admin/* route is
    // `User.isPlatformAdmin === true`, never this tenant's id or slug.
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