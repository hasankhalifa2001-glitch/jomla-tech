import { NextResponse } from "next/server";
import { auth } from "@/auth";
import {
  assertTenantWritable,
  SubscriptionLockedError,
  subscriptionLockedResponse,
} from "@/lib/auth/tenant";
import {
  assertRolePermission,
  ForbiddenRoleError,
  forbiddenRoleResponse,
} from "@/lib/auth/role-matrix";
// [T5 — FIX, launch-blocking] The RAW client is REQUIRED here, not preferred.
// lockBatchesForFifoAllocations() is typed to accept exactly
// `Prisma.TransactionClient`, and getTenantDb()'s extended client/$transaction
// callback is explicitly NOT structurally assignable to it (see lib/db.ts's
// category-5 rationale and lib/db/tenant-scope.ts's header). This file is
// therefore a category-5 call site — it filters by `tenantId` explicitly in
// EVERY query's own `where`, exactly as app/api/sync/route.ts does.
import { prisma } from "@/lib/db";
import { resolveActiveCustomerId } from "@/lib/customers/resolve-active";
import { lockBatchesForFifoAllocations } from "@/lib/inventory/batch-locking";
import { commitFifoAllocation } from "@/lib/inventory/fifo";
import { requireBaseUnit, MissingBaseUnitError } from "@/lib/inventory/base-unit";
import { getUnitConversionFactor, toBaseUnit, fromBaseUnit } from "@/lib/inventory/units";
import {
  compareMoney,
  convertCurrency,
  multiplyMoney,
  serializeMoney,
  subtractMoney,
  sumMoney,
  MoneyError,
} from "@/lib/utils/money";
import { z } from "zod";

/**
 * PATCH /api/orders/[id]/status — T5's Wholesaler Order Approval Queue.
 *
 * ============================================================================
 * [T5 — FIX, launch-blocking] APPROVAL NOW PERFORMS THE REAL WORK.
 *
 * This handler previously ONLY flipped B2BOrderRequest.status, with no
 * commitFifoAllocation(), no batch locks, no Invoice / InvoiceItem, no
 * ProductBatch decrement, no CustomerPayment and no write to
 * resultingInvoiceId — so approving an order had ZERO financial or inventory
 * effect and still removed the request from the pending queue. No other route
 * or service in this repository did that work either, verified exhaustively:
 * `resultingInvoiceId` had no production writer anywhere; commitFifoAllocation
 * and lockBatchesForFifoAllocations had exactly one production call site each
 * (app/api/sync/route.ts); `B2BOrderRequestItem` was never read or written by
 * any production code; nothing read priceWholesaleSnapshot.
 *
 * The T5 spec requires: "Only after confirming exactly one row was updated
 * does commitFifoAllocation (T3) run against the order's items for the first
 * time... and a real Invoice + InvoiceItem(s) written through the exact same
 * top-level-calls-in-one-$transaction path as every other invoice".
 *
 * This file now mirrors app/api/sync/route.ts's sale path step for step:
 *   lock batches (ORDER BY id ASC) → per item: resolve the ORDERED unit's
 *   conversionFactor → toBaseUnit() → commitFifoAllocation() → create the
 *   Invoice + one InvoiceItem per FIFO allocation → decrement each
 *   ProductBatch → optionally record a CustomerPayment → set
 *   resultingInvoiceId. ALL of it inside the ONE transaction that performs the
 *   status change, so a failure anywhere leaves the status, the stock, the
 *   ledger and the order row exactly as they were.
 *
 * ORDER OF OPERATIONS (the spec's "exactly one row was updated" clause):
 * the row is CLAIMED first via a conditional `updateMany` scoped to
 * `status: "PENDING_REVIEW"`, and the allocation work runs only when
 * `count === 1`. Two admins approving the same order concurrently therefore
 * cannot both create an invoice: PostgreSQL re-evaluates the `where` predicate
 * once the row lock is available, so the loser observes count 0 and its whole
 * transaction rolls back. (A findFirst-then-update guard would NOT be
 * race-safe: both readers could pass the guard and the later writer would
 * silently win, leaving two invoices against one order.)
 *
 * [ASSUMPTION — please confirm/adjust] Four inputs are not in the original
 * contract; each default below is the conservative option that cannot invent
 * money movement:
 *   1. PAYMENT — the spec's "optionally create CustomerPayment (when the order
 *      is marked paid/partial)" had no request field to read, so optional
 *      `paidAmountSYP` + `paymentMethod` (+ optional `receiptNo`/`notes`) were
 *      added to the body. Omitted → the invoice is fully unpaid (paid 0,
 *      debt = total) and no payment row is written. `paymentMethod` is
 *      required whenever a paid amount is supplied, as in the sync engine.
 *   2. NO MATCHED CUSTOMER — Invoice.customerId is a required FK, and the T5
 *      spec fixes customerId as "either the order's matchedCustomerId or a
 *      newly created real Customer (never the system-generated cash customer,
 *      since a B2B invoice is expected to carry debt in the ordinary case)".
 *      Most first-time submitters have no Customer row yet, so when
 *      matchedCustomerId is null a NEW Customer (isSystemGenerated: false) is
 *      created inside this SAME transaction from the request's own
 *      retailerName / retailerPhone / retailerShopName, and that id drives the
 *      claim, the Invoice and the optional CustomerPayment. Approval is
 *      rejected (400) only when the request carries no usable retailer name to
 *      build that Customer from. Debt directed at the tenant's system-generated
 *      "cash" customer is refused too, mirroring the sync engine's guard.
 *   3. INSUFFICIENT STOCK — mirrored from the sync engine: the sale is never
 *      blocked, and a shortfall is allocated against the last candidate batch
 *      (which is exactly how an offline sale syncs when stock ran out).
 *      Change here if approval should instead hard-fail.
 *   4. PRICING / FX — line prices come from the frozen
 *      priceWholesaleSnapshot + pricingCurrencySnapshot of each order item,
 *      converted via the tenant's dailyExchangeRate (the same fallback source
 *      the sync engine uses).
 * ============================================================================
 */

const orderStatusSchema = z
  .object({
    status: z.enum(["APPROVED", "REJECTED"]),
    rejectionReason: z.string().optional(),
    // [T5] Optional payment capture — honoured on APPROVED only (see
    // assumption 1 in the file header). Decimal STRINGS, never native
    // numbers, per this codebase's rule for every monetary value.
    paidAmountSYP: z.string().min(1).optional(),
    paymentMethod: z
      .enum(["CASH", "SHAM_CASH", "SYRIATEL_CASH", "BANK_TRANSFER", "OTHER"])
      .optional(),
    receiptNo: z.string().optional(),
    notes: z.string().optional(),
  })
  .refine((v) => !v.paidAmountSYP || Boolean(v.paymentMethod), {
    message: "يجب تحديد طريقة الدفع عند تسجيل مبلغ مدفوع.",
  })
  .refine(
    (v) =>
      v.status === "APPROVED" ||
      (!v.paidAmountSYP && !v.paymentMethod && !v.receiptNo && !v.notes),
    {
      message: "لا يمكن تسجيل دفعة (أو بياناتها) مع رفض الطلب.",
    }
  );

// Same transaction envelope as the sync engine's invoice transactions: a FIFO
// allocation across several products, an invoice, its items and an optional
// payment legitimately run longer than Prisma's 5s default.
const TX_OPTIONS = { maxWait: 10_000, timeout: 20_000 } as const;

interface OrderItemRow {
  productId: string;
  unitId: string;
  // Prisma Decimal columns — always serialized through .toString(), never
  // through Number() (T1's exact-precision rule for quantity/money shapes).
  quantity: { toString(): string };
  priceWholesaleSnapshot: { toString(): string };
  pricingCurrencySnapshot: "USD" | "SYP";
}

/**
 * Resolves an order item's FROZEN wholesale price into BOTH invoice
 * currencies. Invoice rows carry SYP and USD side by side (T1), and the
 * snapshot may be denominated in either — so exactly one direction of
 * conversion is needed per item. The live ProductUnit price is deliberately
 * never re-read here: priceWholesaleSnapshot exists precisely because the
 * retailer's agreed price must survive later price changes.
 */
function resolveItemUnitPrices(
  item: OrderItemRow,
  exchangeRateUsed: string
): { unitPriceSYP: string; unitPriceUSD: string } {
  const snapshot = serializeMoney(item.priceWholesaleSnapshot.toString());
  if (item.pricingCurrencySnapshot === "USD") {
    return {
      unitPriceUSD: snapshot,
      unitPriceSYP: convertCurrency(snapshot, exchangeRateUsed, "USD", "SYP"),
    };
  }
  return {
    unitPriceSYP: snapshot,
    unitPriceUSD: convertCurrency(snapshot, exchangeRateUsed, "SYP", "USD"),
  };
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await auth();
    if (!session || !session.user || !session.user.tenantId || !session.user.id) {
      return NextResponse.json({ error: "UNAUTHORIZED", message: "يرجى تسجيل الدخول أولاً." }, { status: 401 });
    }

    // Role Capability Matrix: approving/rejecting B2B orders is ADMIN-only
    assertRolePermission(session.user.role, "orders:manage");

    const tenantId = session.user.tenantId;
    const userId = session.user.id;

    // Security boundary: assert tenant subscription is active
    await assertTenantWritable(tenantId);

    const { id } = await params;
    const body = await req.json();
    const validation = orderStatusSchema.safeParse(body);

    if (!validation.success) {
      return NextResponse.json(
        {
          error: "VALIDATION_ERROR",
          message: validation.error.issues[0]?.message || "بيانات حالة الطلب غير صالحة.",
        },
        { status: 400 }
      );
    }

    const { status, rejectionReason, paidAmountSYP, paymentMethod, receiptNo, notes } =
      validation.data;

    // ONE transaction for the status claim, the FIFO allocation, the Invoice,
    // its items, the stock decrement, the optional payment and the
    // resultingInvoiceId link. Any failure rolls all of it back together.
    const result = await prisma.$transaction(async (tx) => {
      // 1. Tenant-scoped read of the request (PENDING_REVIEW only — cheapest
      //    rejection first). matchedCustomerId is read here because the claim
      //    below freezes its RESOLVED value onto the row (v4.2).
      const order = await tx.b2BOrderRequest.findFirst({
        where: { id, tenantId, status: "PENDING_REVIEW" },
        select: {
          id: true,
          matchedCustomerId: true,
          // Used ONLY when matchedCustomerId is null: a first-time submission
          // has no Customer row yet, so the request's own retailer details
          // build the new one (T5 spec — see assumption 2 in the header).
          retailerName: true,
          retailerPhone: true,
          retailerShopName: true,
        },
      });

      if (!order) {
        throw new Error("الطلب غير موجود أو تمت مراجعته مسبقاً.");
      }

      if (status !== "APPROVED") {
        // ---- REJECT PATH: claim the row; nothing financial happens --------
        const rejected = await tx.b2BOrderRequest.updateMany({
          where: { id, tenantId, status: "PENDING_REVIEW" },
          data: {
            status: "REJECTED",
            rejectionReason: rejectionReason?.trim() || null,
            reviewedByUserId: userId,
            reviewedAt: new Date(),
          },
        });
        if (rejected.count !== 1) {
          throw new Error("تمت مراجعة الطلب من قِبل مستخدم آخر.");
        }
        return { orderId: id, status: "REJECTED" as const, invoiceId: null, itemsCount: 0 };
      }
      // ---- APPROVAL PATH ------------------------------------------------

      // 2. Customer resolution. Invoice.customerId is a required FK, and the
      //    T5 spec fixes customerId as "either the order's matchedCustomerId
      //    or a newly created real Customer (never the system-generated cash
      //    customer, since a B2B invoice is expected to carry debt in the
      //    ordinary case)". Most first-time submitters have no Customer row
      //    yet, so a null matchedCustomerId CREATEs one here — a top-level
      //    write inside this same transaction, before the claim (which itself
      //    writes matchedCustomerId, so the FK target must exist first) and
      //    before any FIFO/Invoice work. Should the claim or anything later
      //    fail, this Customer rolls back with the whole transaction.
      let customerId: string;
      if (order.matchedCustomerId) {
        // The RESOLVED (survivor) id is what the claim freezes onto the row.
        customerId = await resolveActiveCustomerId(tx, tenantId, order.matchedCustomerId);
      } else {
        const retailerName = order.retailerName?.trim() || "";
        if (!retailerName) {
          // The one remaining case where Invoice.customerId genuinely cannot
          // be satisfied: the request carries no name to build a Customer
          // from. (retailerName is NOT NULL in the schema, but the public
          // submission endpoint is still an unvalidated placeholder, so an
          // empty string is not impossible — never invent a name here.)
          throw new Error(
            "لا يمكن قبول الطلب قبل ربطه بزبون — لا يحمل الطلب اسم زبون صالح لإنشاء زبون جديد."
          );
        }
        const createdCustomer = await tx.customer.create({
          data: {
            tenantId,
            name: retailerName,
            phone: order.retailerPhone?.trim() || null,
            shopName: order.retailerShopName?.trim() || null,
            // Never the system-generated cash customer — a B2B invoice is
            // expected to carry debt in the ordinary case.
            isSystemGenerated: false,
          },
          select: { id: true },
        });
        customerId = createdCustomer.id;
      }

      // 3. CLAIM the row — the spec's "exactly one row was updated" gate. The
      //    allocation work below runs only for the winner; a concurrent second
      //    approval re-reads status after the row lock and rolls back on
      //    count 0, so one order can never produce two invoices.
      const claimed = await tx.b2BOrderRequest.updateMany({
        where: { id, tenantId, status: "PENDING_REVIEW" },
        data: {
          status: "APPROVED",
          matchedCustomerId: customerId,
          reviewedByUserId: userId,
          reviewedAt: new Date(),
        },
      });
      if (claimed.count !== 1) {
        throw new Error("تمت مراجعة الطلب من قِبل مستخدم آخر.");
      }

      // 4. The order's line items — tenant-scoped, deterministic order.
      const items = (await tx.b2BOrderRequestItem.findMany({
        where: { orderRequestId: id, tenantId },
        orderBy: { id: "asc" },
        select: {
          productId: true,
          unitId: true,
          quantity: true,
          priceWholesaleSnapshot: true,
          pricingCurrencySnapshot: true,
        },
      })) as unknown as OrderItemRow[];

      if (items.length === 0) {
        throw new Error("لا يمكن قبول طلب بلا بنود — هذا الطلب فارغ.");
      }

      // 5. Exchange rate: the tenant's daily rate, exactly as the sync engine
      //    falls back to. A missing/zero rate is a real configuration error,
      //    never something to paper over with an un-converted figure.
      const tenantRow = await tx.tenant.findUnique({
        where: { id: tenantId },
        select: { dailyExchangeRate: true },
      });
      if (!tenantRow?.dailyExchangeRate) {
        throw new Error(
          "لا يمكن قبول هذا الطلب: لم يتم تحديد سعر الصرف اليومي لهذا المتجر بعد. " +
            "يرجى ضبط سعر الصرف من الإعدادات ثم إعادة المحاولة."
        );
      }
      const exchangeRateUsed = serializeMoney(tenantRow.dailyExchangeRate.toString());
      if (compareMoney(exchangeRateUsed, 0) <= 0) {
        throw new Error("سعر الصرف المستخدم يجب أن يكون أكبر من الصفر.");
      }

      // 6. Price every line from its FROZEN snapshot (assumption 4 in the
      //    header) and total the invoice in SYP, with USD derived once.
      const pricedItems = items.map((item) => {
        const { unitPriceSYP, unitPriceUSD } = resolveItemUnitPrices(item, exchangeRateUsed);
        return {
          item,
          unitPriceSYP,
          unitPriceUSD,
          lineTotalSYP: multiplyMoney(item.quantity.toString(), unitPriceSYP),
        };
      });

      const totalSYP = sumMoney(pricedItems.map((p) => p.lineTotalSYP));
      const totalUSD = convertCurrency(totalSYP, exchangeRateUsed, "SYP", "USD");

      // 7. Optional payment capture. Omitted → fully unpaid credit invoice,
      //    byte-identical to what every order did before this fix.
      const paidSYP = paidAmountSYP ? serializeMoney(paidAmountSYP) : "0.0000";
      if (compareMoney(paidSYP, 0) < 0) {
        throw new Error("المبلغ المدفوع لا يمكن أن يكون سالباً.");
      }
      if (compareMoney(paidSYP, totalSYP) > 0) {
        throw new Error("المبلغ المدفوع لا يمكن أن يتجاوز إجمالي قيمة الطلب.");
      }
      const paidUSD = convertCurrency(paidSYP, exchangeRateUsed, "SYP", "USD");
      const debtSYP = subtractMoney(totalSYP, paidSYP);
      const debtUSD = convertCurrency(debtSYP, exchangeRateUsed, "SYP", "USD");

      // 8. The same guard the sync engine applies: no debt may be parked on
      //    the tenant's system-generated "cash" customer.
      const customerRecord = await tx.customer.findFirst({
        where: { id: customerId, tenantId },
        select: { isSystemGenerated: true },
      });
      if (customerRecord?.isSystemGenerated && compareMoney(debtSYP, 0) > 0) {
        throw new Error(
          "لا يمكن تسجيل دين على الزبون النقدي العام — يجب اختيار زبون حقيقي له اسم ورقم هاتف."
        );
      }

      // 9. Lock every batch that could be touched, ONCE, in global ascending
      //    id order, before any per-item allocation (T1's deadlock rule —
      //    the same lockBatchesForFifoAllocations() the sync engine calls).
      const productIds = [...new Set(items.map((it) => it.productId))];
      await lockBatchesForFifoAllocations(tx, tenantId, productIds);

      interface ResolvedAllocation {
        productId: string;
        unitId: string;
        batchId: string;
        unitPriceSYP: string;
        unitPriceUSD: string;
        quantitySold: string;
        deductQtyInBaseUnit: string;
      }
      const resolvedAllocations: ResolvedAllocation[] = [];

      // 10. Convert each ordered quantity into the product's BASE unit using
      //     the ORDERED unit's own conversionFactor — never requireBaseUnit()'s
      //     (whose factor is 1 by definition) — then allocate FIFO.
      for (const { item, unitPriceSYP, unitPriceUSD } of pricedItems) {
        let baseUnit;
        try {
          baseUnit = await requireBaseUnit(tx, tenantId, item.productId);
        } catch (e) {
          if (e instanceof MissingBaseUnitError) {
            throw new Error(
              `المنتج ${item.productId} بدون وحدة أساسية محددة (بيانات قديمة تحتاج ` +
                "تصحيح) — الرجاء التواصل مع الدعم الفني."
            );
          }
          throw e;
        }

        const soldUnitFactor = await getUnitConversionFactor(tx, tenantId, item.unitId);
        const baseQtyRequested = toBaseUnit(item.quantity.toString(), soldUnitFactor);

        const resolution = await commitFifoAllocation(tx, {
          tenantId,
          productId: item.productId,
          unitId: baseUnit.id,
          requestedQty: baseQtyRequested.toString(),
        });

        if (resolution.allocations.length === 0) {
          throw new Error(`لا توجد أي دفعة متاحة لـ ${item.productId}/${item.unitId}.`);
        }

        for (const alloc of resolution.allocations) {
          resolvedAllocations.push({
            productId: item.productId,
            unitId: item.unitId,
            batchId: alloc.batchId,
            unitPriceSYP,
            unitPriceUSD,
            // Sold-unit figure for the InvoiceItem (display/ledger facing),
            // distinct from the base-unit figure applied to the batch.
            quantitySold: fromBaseUnit(alloc.allocatedQty, soldUnitFactor).toFixed(4),
            deductQtyInBaseUnit: alloc.allocatedQty,
          });
        }

        // Shortfall — mirrored from the sync engine (assumption 3 in the
        // header): the remaining quantity is drawn against the last candidate
        // batch instead of blocking the approval.
        if (!resolution.isSufficient && compareMoney(resolution.remainingQty, 0) > 0) {
          const last = resolution.allocations[resolution.allocations.length - 1];
          resolvedAllocations.push({
            productId: item.productId,
            unitId: item.unitId,
            batchId: last.batchId,
            unitPriceSYP,
            unitPriceUSD,
            quantitySold: fromBaseUnit(resolution.remainingQty, soldUnitFactor).toFixed(4),
            deductQtyInBaseUnit: resolution.remainingQty,
          });
        }
      }

      // 11. The real Invoice — same shape the sync engine writes for a sale.
      const invoice = await tx.invoice.create({
        data: {
          tenantId,
          userId,
          customerId,
          totalSYP,
          totalUSD,
          exchangeRateUsed,
          paidAmountSYP: paidSYP,
          paidAmountUSD: paidUSD,
          debtAmountSYP: debtSYP,
          debtAmountUSD: debtUSD,
          isPaid: compareMoney(debtSYP, 0) <= 0,
          status: "COMPLETED",
          isSynced: true,
          syncedAt: new Date(),
        },
        select: { id: true },
      });

      // 12. One InvoiceItem per FIFO allocation — top-level calls only, never
      //     nested writes (tenant-scope rule 2).
      for (const alloc of resolvedAllocations) {
        await tx.invoiceItem.create({
          data: {
            tenantId,
            invoiceId: invoice.id,
            productId: alloc.productId,
            unitId: alloc.unitId,
            batchId: alloc.batchId,
            quantity: alloc.quantitySold,
            unitPriceSYP: alloc.unitPriceSYP,
            unitPriceUSD: alloc.unitPriceUSD,
          },
        });
      }

      // 13. Decrement the batches this approval actually drew from.
      for (const alloc of resolvedAllocations) {
        await tx.productBatch.update({
          where: { id: alloc.batchId, tenantId },
          data: { quantity: { decrement: alloc.deductQtyInBaseUnit } },
        });
      }

      // 14. Optional payment row (1:1 with the invoice via invoiceId @unique).
      if (compareMoney(paidSYP, 0) > 0) {
        if (!paymentMethod) {
          throw new Error("يجب تحديد طريقة الدفع عند تسجيل مبلغ مدفوع.");
        }
        await tx.customerPayment.create({
          data: {
            tenantId,
            customerId,
            invoiceId: invoice.id,
            amountSYP: paidSYP,
            amountUSD: paidUSD,
            exchangeRate: exchangeRateUsed,
            paymentMethod,
            receiptNo: receiptNo?.trim() || null,
            notes: notes?.trim() || null,
            isSynced: true,
            syncedAt: new Date(),
          },
        });
      }

      // 15. Link the invoice back to the request — the field that previously
      //     had no writer in the entire codebase.
      await tx.b2BOrderRequest.update({
        where: { id, tenantId },
        data: { resultingInvoiceId: invoice.id },
      });

      return {
        orderId: id,
        status: "APPROVED" as const,
        invoiceId: invoice.id,
        itemsCount: resolvedAllocations.length,
      };
    }, TX_OPTIONS);

    return NextResponse.json({
      success: true,
      orderId: result.orderId,
      status: result.status,
      // Only ever set on approval; null for a rejection.
      invoiceId: result.invoiceId,
      itemsCount: result.itemsCount,
      message:
        result.status === "APPROVED" ? "تم قبول الطلب وإنشاء الفاتورة بنجاح." : "تم رفض الطلب بنجاح.",
    });
  } catch (error) {
    if (error instanceof ForbiddenRoleError) {
      return forbiddenRoleResponse(error);
    }
    if (error instanceof SubscriptionLockedError) {
      return subscriptionLockedResponse(error);
    }
    // A malformed/empty monetary figure (from the request or from a stale
    // tenant exchange rate) is a client-actionable validation problem, not a
    // server fault — mapped to its own error code so the caller can tell the
    // two apart without reading an English decimal.js message.
    if (error instanceof MoneyError) {
      console.error("Invalid monetary value while reviewing an order:", error);
      return NextResponse.json(
        { error: "VALIDATION_ERROR", message: "قيمة مالية غير صالحة في بيانات الطلب." },
        { status: 400 }
      );
    }
    const message = error instanceof Error ? error.message : "حدث خطأ أثناء تحديث حالة الطلب.";
    console.error("Error updating order status:", error);
    return NextResponse.json({ error: "SERVER_ERROR", message }, { status: 400 });
  }
}
