/**
 * lib/data/orders-approval-tx.ts
 *
 * T5c — the ONE approval gateway transaction. Every financial/physical effect
 * of turning a PENDING_REVIEW B2B order into a real, COMPLETED invoice happens
 * here, inside the SINGLE `$transaction` the route opens on the RAW `prisma`
 * client (category-5, same as T4c's sync sale path — this file needs
 * lockBatchesForFifoAllocations()/commitFifoAllocation(), both typed to
 * `Prisma.TransactionClient`).
 *
 * HARD RULES (enforced + unit-tested):
 *  - NO raw `prisma` import here: the client is passed in. All DB access is
 *    top-level `tx.<model>.<method>()` calls (no nested writes).
 *  - Because the raw client does NOT run the tenant-scope extension, EVERY
 *    query/write below carries `tenantId` explicitly. The single documented
 *    exception is `tx.verifiedRetailer.*` (platform-wide, no tenantId column).
 *  - Throw ONLY typed domain errors (never a bare Error/500). The route maps
 *    them to HTTP OUTSIDE the transaction. Any throw rolls the whole
 *    transaction back — the order stays PENDING_REVIEW.
 *  - Money via lib/utils/money.ts only; unit conversion via lib/inventory/
 *    units.ts only; FIFO via lib/inventory/fifo.ts; the sold line's OWN factor
 *    via getUnitConversionFactor — never requireBaseUnit()'s factor.
 *  - The caller applies batch decrements (commitFifoAllocation is read-only):
 *    one `tx.productBatch.update({ decrement })` per allocation row, per line,
 *    immediately — later lines see earlier decrements. A running balance per
 *    batch guards that no decrement can drive a batch below zero.
 *  - NO overdraw/shortfall booking (unlike T4c's sync path): B2B approval
 *    never creates negative stock (D9).
 *
 * TENANT PROVENANCE: the step-1 claim (updateMany on { id, tenantId,
 * PENDING_REVIEW }, count==1) proves (orderId, tenantId) is live and owned;
 * every later id comes from tenant-scoped reads, and every update keeps
 * { id, tenantId } in `where`.
 */

import { Prisma, type PaymentMethod } from "@prisma/client";
import {
    ApprovalAlreadyReviewedError,
    ApprovalInsufficientStockError,
    ApprovalInvalidCustomerError,
    ApprovalInvalidPaymentError,
    ApprovalOrderNotFoundError,
    ApprovalProductInactiveError,
    ApprovalRateRequiredError,
    ApprovalValidationError,
    approvalRequestedBaseQty,
    approvalTotalSYP,
    approvalUnitPriceSYP,
    assertApprovalLineSet,
    assertSufficientStock,
    groupLockedQuantitiesByProduct,
    normalizeRate,
    resolveApprovalPayment,
    type ApproveOrderInput,
    type ApproveOrderResult,
    type SufficiencyLineInput,
} from "@/lib/data/orders-approval";
import {
    listProductNamesByIds,
    listProductsActiveFlags,
    listUnitNamesByIds,
    listUnitConversionFactors,
    listUnitsActiveFlags,
} from "@/lib/data/products";
import { resolveActiveCustomerId } from "@/lib/customers/resolve-active";
import { lockBatchesForFifoAllocations } from "@/lib/inventory/batch-locking";
import { commitFifoAllocation } from "@/lib/inventory/fifo";
import { requireBaseUnit } from "@/lib/inventory/base-unit";
import { fromBaseUnit } from "@/lib/inventory/units";
import { compareMoney, deriveUsd, multiplyMoney, serializeMoney, subtractMoney } from "@/lib/utils/money";
import { normalizePhone } from "@/lib/utils/phone";

/** A committed approval is only "recoverable" for a short window after it landed. */
const RECOVERY_WINDOW_MS = 2 * 60 * 1000;

/**
 * The one approval transaction. `tx` MUST be the RAW `prisma.$transaction`
 * client. Returns the success figures; on any rule violation it THROWS a typed
 * domain error and the caller's `$transaction` rolls everything back.
 */
export async function approveOrderInTransaction(
    tx: Prisma.TransactionClient,
    input: ApproveOrderInput
): Promise<ApproveOrderResult> {
    const { orderId, tenantId, approvingUserId, body } = input;

    // ---- Step 1: CLAIM the order (FIRST write) ---------------------------
    const claimed = await tx.b2BOrderRequest.updateMany({
        where: { id: orderId, tenantId, status: "PENDING_REVIEW" },
        data: { status: "APPROVED", reviewedByUserId: approvingUserId, reviewedAt: new Date() },
    });
    if (claimed.count !== 1) {
        const existing = await tx.b2BOrderRequest.findFirst({
            where: { id: orderId, tenantId },
            select: { id: true },
        });
        if (!existing) throw new ApprovalOrderNotFoundError();
        throw new ApprovalAlreadyReviewedError();
    }

    // Retailer identity, read ONCE right after the claim (used only by the
    // final VerifiedRetailer step).
    const requestRow = await tx.b2BOrderRequest.findFirst({
        where: { id: orderId, tenantId },
        select: { retailerPhone: true, retailerShopName: true },
    });
    if (!requestRow) {
        // Unreachable after the claim — fail loud.
        throw new ApprovalOrderNotFoundError();
    }

    // ---- Step 2: load + validate lines -----------------------------------
    const items = await tx.b2BOrderRequestItem.findMany({
        where: { orderRequestId: orderId, tenantId },
        select: {
            id: true,
            productId: true,
            unitId: true,
            priceWholesaleSnapshot: true,
            pricingCurrencySnapshot: true,
        },
        orderBy: { id: "asc" },
    });
    assertApprovalLineSet(
        body.lines.map((l) => l.itemId),
        items.map((i) => i.id)
    );
    const approvedByItemId = new Map(body.lines.map((l) => [l.itemId, l.approvedQuantity]));

    const productIds = [...new Set(items.map((i) => i.productId))];
    const unitIds = [...new Set(items.map((i) => i.unitId))];
    const [productNames, unitNames, unitFactors] = await Promise.all([
        listProductNamesByIds(tx, tenantId, productIds),
        listUnitNamesByIds(tx, tenantId, unitIds),
        listUnitConversionFactors(tx, tenantId, unitIds),
    ]);

    // Each product and unit must still be active, else 409 naming the line.
    // A missing map entry counts as inactive; the unit must belong to the
    // line's product.
    const [productActiveById, unitActiveById] = await Promise.all([
        listProductsActiveFlags(tx, tenantId, productIds),
        listUnitsActiveFlags(tx, tenantId, unitIds),
    ]);
    for (const item of items) {
        if (productActiveById.get(item.productId) !== true) {
            throw new ApprovalProductInactiveError(item.id, productNames.get(item.productId) ?? "—");
        }
        const unitFlag = unitActiveById.get(item.unitId);
        if (!unitFlag || unitFlag.isActive !== true || unitFlag.productId !== item.productId) {
            throw new ApprovalProductInactiveError(item.id, productNames.get(item.productId) ?? "—");
        }
    }

    // ---- Step 3: exchange rate (normalized; read FRESH inside the tx) ----
    const tenantRow = await tx.tenant.findUnique({
        where: { id: tenantId },
        select: { dailyExchangeRate: true },
    });
    const exchangeRate = normalizeRate(
        tenantRow?.dailyExchangeRate != null ? tenantRow.dailyExchangeRate.toString() : null
    );
    if (items.some((i) => i.pricingCurrencySnapshot === "USD") && exchangeRate === null) {
        throw new ApprovalRateRequiredError();
    }

    // ---- Step 3b: per-line SOLD-unit factor + base qty + unit price ------
    interface LinePlan {
        itemId: string;
        productId: string;
        unitId: string;
        approvedQuantity: string;
        unitPriceSYP: string;
        soldUnitFactor: string;
        requestedBaseQty: string;
    }
    const linePlans: LinePlan[] = items.map((item) => {
        const approvedQuantity = approvedByItemId.get(item.id);
        if (approvedQuantity === undefined) {
            throw new ApprovalValidationError();
        }
        // Factor comes ONLY from the SOLD unit's own row (units.ts).
        const soldUnitFactor = unitFactors.get(item.unitId);
        if (soldUnitFactor === undefined) {
            throw new ApprovalValidationError();
        }
        const unitPriceSYP = approvalUnitPriceSYP(
            {
                priceWholesaleSnapshot: item.priceWholesaleSnapshot.toString(),
                pricingCurrencySnapshot: item.pricingCurrencySnapshot,
            },
            exchangeRate
        );
        return {
            itemId: item.id,
            productId: item.productId,
            unitId: item.unitId,
            approvedQuantity,
            unitPriceSYP,
            soldUnitFactor,
            // ONE value used by the sufficiency check AND the FIFO request.
            // Throws ApprovalValidationError when it converts to zero.
            requestedBaseQty: approvalRequestedBaseQty(
                approvedQuantity,
                soldUnitFactor,
                productNames.get(item.productId) ?? undefined
            ),
        };
    });

    // ---- Step 6: prices + total (pre-lock) ---------------------------------
    // totalSYP is computed per UN-SPLIT order line, exactly as T4c computes a
    // cart total (before any FIFO split).
    const { totalSYP } = approvalTotalSYP(
        linePlans.map((lp, idx) => ({
            itemId: lp.itemId,
            approvedQuantity: lp.approvedQuantity,
            priceWholesaleSnapshot: items[idx].priceWholesaleSnapshot.toString(),
            pricingCurrencySnapshot: items[idx].pricingCurrencySnapshot,
        })),
        exchangeRate
    );
    if (compareMoney(totalSYP, "0") <= 0) {
        throw new ApprovalValidationError("إجمالي الفاتورة يجب أن يكون أكبر من صفر.");
    }

    // ---- Step 7: payment validation, pre-lock (T4b parity) -----------------
    const resolvedPayment = resolveApprovalPayment(totalSYP, body.payment);
    const paidAmountSYP = resolvedPayment.paidAmountSYP;
    const debtAmountSYP = subtractMoney(totalSYP, paidAmountSYP);
    const paymentMethod = resolvedPayment.paymentMethod;

    // ---- Step 4: LOCK all batches of all involved products (one query) ---
    // Single SELECT ... FOR UPDATE ORDER BY id ASC over EVERY batch of the
    // products (no quantity filter). The claim precedes any lock, so no
    // deadlock cycle exists with reject (which holds no locks).
    const lockedByBatch = await lockBatchesForFifoAllocations(tx, tenantId, productIds);

    // ---- Step 5: sufficiency check AFTER the lock, from LOCKED rows ------
    const lockedBatchRows = await tx.productBatch.findMany({
        where: { id: { in: [...lockedByBatch.keys()] }, tenantId },
        select: { id: true, productId: true },
    });
    const batchToProduct = new Map(lockedBatchRows.map((r) => [r.id, r.productId]));
    const sufficiencyLines: SufficiencyLineInput[] = linePlans.map((lp) => ({
        itemId: lp.itemId,
        productId: lp.productId,
        productName: productNames.get(lp.productId) ?? "—",
        unitId: lp.unitId,
        unitName: unitNames.get(lp.unitId) ?? "—",
        approvedQuantity: lp.approvedQuantity,
        soldUnitFactor: lp.soldUnitFactor,
    }));
    const lockedByProductMap = groupLockedQuantitiesByProduct(
        [...lockedByBatch].flatMap(([batchId, quantity]) => {
            const pid = batchToProduct.get(batchId);
            return pid ? [{ productId: pid, quantity }] : [];
        })
    );
    // Throws ApprovalInsufficientStockError (409) with per-line details.
    assertSufficientStock(sufficiencyLines, lockedByProductMap);

    // ---- Step 8: resolve the customer (admin-chosen, never system) -------
    // After lock + sufficiency so INSUFFICIENT_STOCK / RATE_REQUIRED /
    // INVALID_PAYMENT never create a customer row.
    let customerId: string;
    if (body.customer.mode === "EXISTING") {
        const resolvedId = await resolveActiveCustomerId(tx, tenantId, body.customer.customerId);
        const customer = await tx.customer.findFirst({
            where: { id: resolvedId, tenantId, isActive: true, isSystemGenerated: false },
            select: { id: true },
        });
        if (!customer) throw new ApprovalInvalidCustomerError();
        customerId = resolvedId;
    } else {
        const normalizedPhone = normalizePhone(body.customer.phone);
        if (normalizedPhone === null) throw new ApprovalValidationError("رقم هاتف الزبون غير صالح.");
        const created = await tx.customer.create({
            data: {
                tenantId,
                name: body.customer.name.trim(),
                phone: normalizedPhone,
                shopName: body.customer.shopName?.trim() || null,
                offlineId: null,
                isActive: true,
                isSystemGenerated: false,
            },
            select: { id: true },
        });
        customerId = created.id;
    }

    // ---- Steps 9-12: FIFO allocate + deduct + build invoice items ---------
    interface BuiltInvoiceItem {
        productId: string;
        unitId: string; // the SOLD unit
        batchId: string;
        baseQuantity: string; // exact, from the allocation
        quantity: string; // display-only share
        unitPriceSYP: string;
        unitPriceUSD: string | null;
        costAmountSYP: string;
    }
    const builtItems: BuiltInvoiceItem[] = [];
    // Running per-batch balance: starts from the LOCKED quantities and is
    // decremented after every deduction, so the "never below zero" guard
    // always sees the quantity remaining AFTER earlier lines.
    const runningQtyByBatch = new Map<string, string>(lockedByBatch);

    for (const lp of linePlans) {
        const baseUnit = await requireBaseUnit(tx, tenantId, lp.productId);
        const plan = await commitFifoAllocation(tx, {
            tenantId,
            productId: lp.productId,
            unitId: baseUnit.id,
            requestedQty: lp.requestedBaseQty,
        });
        const productLines = sufficiencyLines.filter((l) => l.productId === lp.productId);
        // D9 defensive assertion: no shortfall. A miss is a bug/race and B2B
        // approval must NEVER create negative stock. Typed 409, never a 500.
        if (!plan.isSufficient || compareMoney(plan.remainingQty, "0") > 0) {
            throw ApprovalInsufficientStockError.fromSufficiencyLines(productLines, lockedByProductMap);
        }
        for (const alloc of plan.allocations) {
            const currentQty = runningQtyByBatch.get(alloc.batchId);
            if (currentQty === undefined) {
                // The allocation drew from a batch that was not locked: never proceed.
                throw ApprovalInsufficientStockError.fromSufficiencyLines(productLines, lockedByProductMap);
            }
            const afterQty = subtractMoney(currentQty, alloc.allocatedQty);
            if (compareMoney(afterQty, "0") < 0) {
                throw ApprovalInsufficientStockError.fromSufficiencyLines(productLines, lockedByProductMap);
            }
            // Caller applies the decrement immediately (mirrors T4c).
            await tx.productBatch.update({
                where: { id: alloc.batchId, tenantId },
                data: { quantity: { decrement: alloc.allocatedQty } },
            });
            runningQtyByBatch.set(alloc.batchId, afterQty);
            builtItems.push({
                productId: lp.productId,
                unitId: lp.unitId,
                batchId: alloc.batchId,
                baseQuantity: alloc.allocatedQty, // exact; never derived by division
                quantity: fromBaseUnit(alloc.allocatedQty, lp.soldUnitFactor).toFixed(4), // display share
                unitPriceSYP: lp.unitPriceSYP,
                unitPriceUSD: deriveUsd(lp.unitPriceSYP, exchangeRate),
                costAmountSYP: multiplyMoney(alloc.allocatedQty, alloc.costPricePerBaseUnit),
            });
        }
    }

    // ---- Step 10: create the Invoice -------------------------------------
    const paidAmountUSD = deriveUsd(paidAmountSYP, exchangeRate);
    const debtAmountUSD = deriveUsd(debtAmountSYP, exchangeRate);
    const totalUSD = deriveUsd(totalSYP, exchangeRate);
    const invoice = await tx.invoice.create({
        data: {
            tenantId,
            userId: approvingUserId, // the approving ADMIN, never the retailer
            customerId,
            totalSYP,
            totalUSD,
            exchangeRateUsed: exchangeRate, // frozen at approval, or null
            paidAmountSYP,
            paidAmountUSD,
            debtAmountSYP,
            debtAmountUSD,
            isPaid: compareMoney(debtAmountSYP, "0") <= 0,
            status: "COMPLETED",
            isSynced: true,
            offlineId: null,
            syncedAt: new Date(),
        },
        select: { id: true },
    });

    // ---- Step 11: one InvoiceItem per allocation row ---------------------
    for (const it of builtItems) {
        await tx.invoiceItem.create({
            data: {
                tenantId,
                invoiceId: invoice.id,
                productId: it.productId,
                unitId: it.unitId,
                batchId: it.batchId,
                quantity: it.quantity, // display-only
                baseQuantity: it.baseQuantity, // exact
                unitPriceSYP: it.unitPriceSYP,
                unitPriceUSD: it.unitPriceUSD,
                costAmountSYP: it.costAmountSYP,
            },
        });
    }

    // ---- Step 12: optional sale-time CustomerPayment ---------------------
    if (compareMoney(paidAmountSYP, "0") > 0) {
        if (!paymentMethod) {
            // Defensive: resolveApprovalPayment already enforces this.
            throw new ApprovalInvalidPaymentError();
        }
        await tx.customerPayment.create({
            data: {
                tenantId,
                customerId,
                invoiceId: invoice.id,
                amountSYP: paidAmountSYP,
                amountUSD: paidAmountUSD,
                exchangeRate: exchangeRate,
                paymentMethod: paymentMethod as PaymentMethod,
                isSynced: true,
                syncedAt: new Date(),
            },
        });
    }

    // ---- Step 13: persist approvedQuantity once, per line ----------------
    for (const lp of linePlans) {
        // Writes ONLY approvedQuantity. quantity and the price snapshots are
        // NEVER touched here (static test).
        await tx.b2BOrderRequestItem.update({
            where: { id: lp.itemId, tenantId },
            data: { approvedQuantity: lp.approvedQuantity },
        });
    }

    // ---- Step 14: link the invoice back to the request -------------------
    await tx.b2BOrderRequest.update({
        where: { id: orderId, tenantId },
        data: { resultingInvoiceId: invoice.id },
    });

    // ---- Step 15: platform-wide retailer signal (NATIVE upsert) ----------
    // Single unique field (phone) equal in where and create, no nested writes,
    // no select/include -> INSERT ... ON CONFLICT DO UPDATE, so two concurrent
    // first-approvals cannot raise P2002 inside the transaction. No tenantId
    // (platform-wide model). A phone that cannot be normalized never blocks an
    // otherwise valid approval: the signal is simply skipped.
    const retailerPhone = normalizePhone(requestRow.retailerPhone);
    if (retailerPhone === null) {
        console.warn(`[orders-approval] order ${orderId}: retailer phone not normalizable — VerifiedRetailer upsert skipped.`);
    } else {
        await tx.verifiedRetailer.upsert({
            where: { phone: retailerPhone },
            create: {
                phone: retailerPhone,
                shopName: requestRow.retailerShopName?.trim() || null,
                verificationCount: 1,
            },
            update: { verificationCount: { increment: 1 } },
        });
    }

    return {
        invoiceId: invoice.id,
        totalSYP,
        paidAmountSYP,
        debtAmountSYP,
        customerId,
    };
}

/**
 * Ambiguous-commit recovery. If the approval transaction COMMITTED but the
 * response (or the connection) was lost, a retry hits the step-1 claim and
 * would report ALREADY_REVIEWED although the invoice exists. This returns the
 * committed result ONLY when the order is APPROVED by THIS user, has a
 * resulting invoice, and was reviewed within the last RECOVERY_WINDOW_MS —
 * otherwise null (the caller keeps its original error).
 *
 * Read-only. `db` is the raw client; every query carries tenantId.
 */
export async function recoverCommittedApproval(
    db: Prisma.TransactionClient,
    params: { orderId: string; tenantId: string; userId: string; now?: Date }
): Promise<ApproveOrderResult | null> {
    const { orderId, tenantId, userId } = params;
    const now = params.now ?? new Date();
    const order = await db.b2BOrderRequest.findFirst({
        where: {
            id: orderId,
            tenantId,
            status: "APPROVED",
            reviewedByUserId: userId,
            resultingInvoiceId: { not: null },
            reviewedAt: { gte: new Date(now.getTime() - RECOVERY_WINDOW_MS) },
        },
        select: { resultingInvoiceId: true },
    });
    if (!order?.resultingInvoiceId) return null;

    const invoice = await db.invoice.findFirst({
        where: { id: order.resultingInvoiceId, tenantId },
        select: {
            id: true,
            customerId: true,
            totalSYP: true,
            paidAmountSYP: true,
            debtAmountSYP: true,
        },
    });
    if (!invoice) return null;

    return {
        invoiceId: invoice.id,
        totalSYP: serializeMoney(invoice.totalSYP.toString()),
        paidAmountSYP: serializeMoney(invoice.paidAmountSYP.toString()),
        debtAmountSYP: serializeMoney(invoice.debtAmountSYP.toString()),
        customerId: invoice.customerId,
    };
}