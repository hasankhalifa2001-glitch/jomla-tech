/* eslint-disable no-restricted-syntax */
/**
 * lib/data/__tests__/t5c-orders-approval.real.test.ts
 *
 * T5c — REAL-DATABASE concurrency tests. Gated on TEST_DATABASE_URL (skipped
 * when absent). It NEVER reads DATABASE_URL. TEST_DATABASE_URL MUST point to a
 * DISPOSABLE test database/branch with the current schema applied — never
 * production, never the dev database. Each run inserts rows with unique
 * slugs/phones and does NOT clean up (FK Restrict makes cleanup fragile):
 * use a throwaway database.
 *
 * Modules under test are imported DYNAMICALLY inside beforeAll so that a
 * skipped run never loads them (they may import lib/db at module level).
 *
 * What this proves (and the mock suite cannot): real FOR UPDATE serialization,
 * the claim's conditional update under true concurrency, the native upsert on
 * VerifiedRetailer, and exact FIFO-split quantities in a real database.
 *
 * NOT covered here (needs the sync route/session harness): approval racing a
 * POS sync on the same batches, and the 50-line / 20s-timeout case. Test 2
 * emulates reject with the same conditional updateMany the reject gateway uses
 * (pattern-level, not a call to the reject function itself).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Prisma, PrismaClient } from "@prisma/client";

const hasTestDb = Boolean(process.env.TEST_DATABASE_URL);

type ApproveMod = typeof import("@/lib/data/orders-approval-tx");
type ApprovalMod = typeof import("@/lib/data/orders-approval");

interface World {
    tenantId: string;
    userId: string;
    productId: string;
    baseUnitId: string;
    packUnitId: string; // factor 24
    customerId: string;
    batchIds: string[];
}

const rand = () => Math.random().toString(36).slice(2, 8);
const randomPhone = () => `0944${Math.floor(100000 + Math.random() * 899999)}`;

describe.skipIf(!hasTestDb)("T5c approval — real-database concurrency", () => {
    let prisma: PrismaClient;
    let approveMod: ApproveMod;
    let approvalMod: ApprovalMod;

    beforeAll(async () => {
        prisma = new PrismaClient({ datasourceUrl: process.env.TEST_DATABASE_URL });
        approveMod = await import("@/lib/data/orders-approval-tx");
        approvalMod = await import("@/lib/data/orders-approval");
    }, 60_000);

    afterAll(async () => {
        await prisma?.$disconnect();
    });

    // ---- seed helpers (plain client, tenantId written explicitly) ---------
    async function seedWorld(
        tag: string,
        batches: Array<{ qty: string; expiry?: Date }>
    ): Promise<World> {
        const slug = `t5c-${tag}-${rand()}`;
        const tenant = await prisma.tenant.create({
            data: { name: `T5C ${slug}`, slug, subscriptionStatus: "ACTIVE" },
        });
        const user = await prisma.user.create({
            data: {
                tenantId: tenant.id,
                name: "Admin",
                email: `${slug}@test.local`,
                passwordHash: "x",
                role: "ADMIN",
            },
        });
        const product = await prisma.product.create({
            data: { tenantId: tenant.id, name: `P-${slug}`, isPublic: true },
        });
        const baseUnit = await prisma.productUnit.create({
            data: {
                tenantId: tenant.id,
                productId: product.id,
                unitName: "قطعة",
                conversionFactor: "1",
                priceWholesale: "1000",
            },
        });
        const packUnit = await prisma.productUnit.create({
            data: {
                tenantId: tenant.id,
                productId: product.id,
                unitName: "طرد",
                conversionFactor: "24",
                priceWholesale: "20000",
            },
        });
        await prisma.product.update({
            where: { id: product.id },
            data: { baseUnitId: baseUnit.id },
        });
        const receipt = await prisma.productReceipt.create({
            data: { tenantId: tenant.id, createdByUserId: user.id, purchaseDate: new Date() },
        });
        const batchIds: string[] = [];
        for (let i = 0; i < batches.length; i++) {
            const b = await prisma.productBatch.create({
                data: {
                    tenantId: tenant.id,
                    productId: product.id,
                    unitId: baseUnit.id,
                    batchNumber: `b${i + 1}-${rand()}`,
                    quantity: batches[i].qty,
                    initialQuantity: batches[i].qty,
                    totalCostSYP: "1000",
                    costPricePerBaseUnit: "500",
                    receiptId: receipt.id,
                    expiryDate: batches[i].expiry ?? null,
                },
            });
            batchIds.push(b.id);
        }
        const customer = await prisma.customer.create({
            data: {
                tenantId: tenant.id,
                name: "زبون اختبار",
                phone: randomPhone(),
                isSystemGenerated: false,
            },
        });
        return {
            tenantId: tenant.id,
            userId: user.id,
            productId: product.id,
            baseUnitId: baseUnit.id,
            packUnitId: packUnit.id,
            customerId: customer.id,
            batchIds,
        };
    }

    async function seedOrder(world: World, phone: string, packs = "1") {
        const order = await prisma.b2BOrderRequest.create({
            data: { tenantId: world.tenantId, retailerName: "تاجر", retailerPhone: phone },
        });
        const item = await prisma.b2BOrderRequestItem.create({
            data: {
                tenantId: world.tenantId,
                orderRequestId: order.id,
                productId: world.productId,
                unitId: world.packUnitId,
                quantity: packs,
                priceWholesaleSnapshot: "20000",
                pricingCurrencySnapshot: "SYP",
            },
        });
        return { orderId: order.id, itemId: item.id };
    }

    function runApproval(world: World, orderId: string, itemId: string, qty = "1") {
        const body = {
            lines: [{ itemId, approvedQuantity: qty }],
            customer: { mode: "EXISTING" as const, customerId: world.customerId },
            payment: { mode: "FULL_CREDIT" as const },
        };
        return prisma.$transaction(
            (tx) =>
                approveMod.approveOrderInTransaction(tx, {
                    orderId,
                    tenantId: world.tenantId,
                    approvingUserId: world.userId,
                    body,
                }),
            approvalMod.APPROVAL_TX_OPTIONS
        );
    }

    const qtyOf = async (batchId: string) =>
        (await prisma.productBatch.findUniqueOrThrow({ where: { id: batchId } })).quantity.toFixed(4);

    // ---- 1. double approval of ONE order ----------------------------------
    it("two simultaneous approvals of one order -> exactly one invoice, one deduction", async () => {
        const world = await seedWorld("dbl", [{ qty: "100" }]);
        const { orderId, itemId } = await seedOrder(world, randomPhone());

        const results = await Promise.allSettled([
            runApproval(world, orderId, itemId),
            runApproval(world, orderId, itemId),
        ]);

        const ok = results.filter((r) => r.status === "fulfilled");
        const failed = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
        expect(ok).toHaveLength(1);
        expect(failed).toHaveLength(1);
        expect(failed[0].reason).toBeInstanceOf(approvalMod.ApprovalAlreadyReviewedError);

        expect(await prisma.invoice.count({ where: { tenantId: world.tenantId } })).toBe(1);
        expect(await qtyOf(world.batchIds[0])).toBe("76.0000"); // 100 - 24, once
        const order = await prisma.b2BOrderRequest.findUniqueOrThrow({ where: { id: orderId } });
        expect(order.status).toBe("APPROVED");
        expect(order.resultingInvoiceId).not.toBeNull();
    }, 60_000);

    // ---- 2. approval racing a reject (pattern-level) ----------------------
    it("approval racing reject -> exactly one wins, state is consistent", async () => {
        const world = await seedWorld("rej", [{ qty: "100" }]);
        const { orderId, itemId } = await seedOrder(world, randomPhone());

        const [approval, rejected] = await Promise.all([
            runApproval(world, orderId, itemId).then(
                () => "approved" as const,
                (e) => e
            ),
            prisma.$transaction(async (tx) => {
                const r = await tx.b2BOrderRequest.updateMany({
                    where: { id: orderId, tenantId: world.tenantId, status: "PENDING_REVIEW" },
                    data: {
                        status: "REJECTED",
                        rejectionReason: "اختبار",
                        reviewedByUserId: world.userId,
                        reviewedAt: new Date(),
                    },
                });
                return r.count;
            }),
        ]);

        const approvalWon = approval === "approved";
        const rejectWon = rejected === 1;
        expect(approvalWon !== rejectWon).toBe(true); // XOR
        const invoices = await prisma.invoice.count({ where: { tenantId: world.tenantId } });
        if (approvalWon) {
            expect(invoices).toBe(1);
            expect(await qtyOf(world.batchIds[0])).toBe("76.0000");
        } else {
            expect(approval).toBeInstanceOf(approvalMod.ApprovalAlreadyReviewedError);
            expect(invoices).toBe(0);
            expect(await qtyOf(world.batchIds[0])).toBe("100.0000");
        }
    }, 60_000);

    // ---- 3. native upsert on VerifiedRetailer -----------------------------
    it("two concurrent first approvals for one phone (two wholesalers) -> one row, count 2", async () => {
        const phone = randomPhone();
        const a = await seedWorld("vrA", [{ qty: "100" }]);
        const b = await seedWorld("vrB", [{ qty: "100" }]);
        const oa = await seedOrder(a, phone);
        const ob = await seedOrder(b, phone);

        const results = await Promise.allSettled([
            runApproval(a, oa.orderId, oa.itemId),
            runApproval(b, ob.orderId, ob.itemId),
        ]);

        // A non-native upsert would surface P2002 as a rejected transaction here.
        expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
        const rows = await prisma.verifiedRetailer.findMany({ where: { phone } });
        expect(rows).toHaveLength(1);
        expect(rows[0].verificationCount).toBe(2);
    }, 60_000);

    // ---- 4. oversell race: never below zero --------------------------------
    it("two orders racing for stock that fits only one -> one INSUFFICIENT_STOCK, batch never negative", async () => {
        const world = await seedWorld("oversell", [{ qty: "30" }]); // fits ONE pack (24)
        const o1 = await seedOrder(world, randomPhone());
        const o2 = await seedOrder(world, randomPhone());

        const results = await Promise.allSettled([
            runApproval(world, o1.orderId, o1.itemId),
            runApproval(world, o2.orderId, o2.itemId),
        ]);

        const ok = results.filter((r) => r.status === "fulfilled");
        const failed = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
        expect(ok).toHaveLength(1);
        expect(failed).toHaveLength(1);
        expect(failed[0].reason).toBeInstanceOf(approvalMod.ApprovalInsufficientStockError);
        expect(await qtyOf(world.batchIds[0])).toBe("6.0000"); // 30 - 24
        expect(await prisma.invoice.count({ where: { tenantId: world.tenantId } })).toBe(1);
    }, 60_000);

    // ---- 5. FIFO split exactness in a real database -----------------------
    it("1 pack (24) over batches 20 + 100 -> two rows, baseQuantity sums to exactly 24", async () => {
        const world = await seedWorld("split", [
            { qty: "20", expiry: new Date("2030-01-01") },
            { qty: "100", expiry: new Date("2031-01-01") },
        ]);
        const { orderId, itemId } = await seedOrder(world, randomPhone());

        await runApproval(world, orderId, itemId);

        const rows = await prisma.invoiceItem.findMany({ where: { tenantId: world.tenantId } });
        expect(rows).toHaveLength(2);
        const sum = rows.reduce((acc, r) => acc.plus(r.baseQuantity), new Prisma.Decimal(0));
        expect(sum.toFixed(4)).toBe("24.0000");
        expect(await qtyOf(world.batchIds[0])).toBe("0.0000");
        expect(await qtyOf(world.batchIds[1])).toBe("96.0000");
    }, 60_000);
});