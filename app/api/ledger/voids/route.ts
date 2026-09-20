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
import { getTenantDb, tenantScopedRawQuery } from "@/lib/db/tenant-scope";
import { Prisma } from "@prisma/client";
import Decimal from "decimal.js";
import {
  getUnitConversionFactor,
  toBaseUnit,
} from "@/lib/inventory/units";

export async function POST(req: Request) {
  try {
    const session = await auth();
    if (!session || !session.user || !session.user.tenantId) {
      return NextResponse.json({ error: "UNAUTHORIZED", message: "يرجى تسجيل الدخول أولاً." }, { status: 401 });
    }

    // Role Capability Matrix: voiding/refunding invoices is ADMIN-only.
    // Rejects CASHIER at the API level even on a raw HTTP call.
    assertRolePermission(session.user.role, "ledger:void_invoice");

    // Security boundary: assert tenant subscription is active.
    await assertTenantWritable(session.user.tenantId);

    const body = await req.json();
    const { invoiceId, voidReason } = body;

    if (!invoiceId || !voidReason || !voidReason.trim()) {
      return NextResponse.json(
        { error: "VALIDATION_ERROR", message: "يجب تحديد الفاتورة وسبب الإلغاء." },
        { status: 400 }
      );
    }

    const tenantId = session.user.tenantId;
    const adminUserId = session.user.id;
    const db = getTenantDb(tenantId);

    // [FIX] Single read carrying everything the rest of this handler
    // needs — the previous version fetched the invoice TWICE (once for
    // an early check, once with items). `batch`/`unit` are NOT included
    // here — the restore logic below resolves the sold unit's factor
    // exclusively through getUnitConversionFactor() (the sanctioned
    // gateway), so a raw ProductUnit/ProductBatch relation carrying
    // conversionFactor has no legitimate reason to be fetched into this
    // route at all.
    const originalInvoice = await db.invoice.findUnique({
      where: { id: invoiceId, tenantId },
      include: { items: true },
    });

    if (!originalInvoice) {
      return NextResponse.json(
        { error: "NOT_FOUND", message: "الفاتورة غير موجودة." },
        { status: 404 }
      );
    }

    // Voiding a void (or a row that's already a void of something else)
    // is nonsensical — this is a DIFFERENT check from "has this invoice
    // already been voided" below; both are needed.
    if (originalInvoice.status === "VOIDED" || originalInvoice.voidsInvoiceId) {
      return NextResponse.json(
        { error: "INVALID_STATE", message: "لا يمكن إلغاء فاتورة إلغاء أو فاتورة غير صالحة للإلغاء." },
        { status: 400 }
      );
    }

    // [FIX — real bug] The previous pre-check read
    // `originalInvoice.voidsInvoiceId` — a field on the invoice being
    // voided, which only tells you whether THIS row is itself a void of
    // something else. It says nothing about whether some OTHER row
    // already voids THIS one, which is the actual double-void question.
    // Since the original invoice is append-only and never mutated, that
    // field (and .status) stay unchanged forever regardless of whether a
    // void was already created for it — so the old check could never
    // catch a real double-void attempt; every one would silently fall
    // through to the transaction below and only get caught by the raw
    // P2002 constraint error, defeating the whole point of having a
    // fast/friendly pre-check. Fixed: explicitly search for an existing
    // void row pointing AT this invoice (the correct direction).
    //
    // Still informational/fast-path only — the @unique constraint on
    // voidsInvoiceId, hit via Invoice.create() inside the transaction
    // below, remains the actual concurrency guarantee against a genuine
    // race between two simultaneous void attempts. This check exists so
    // the OVERWHELMINGLY common non-racing case (someone re-clicking
    // "void" on an already-voided invoice a while later) gets a clean
    // 400 instead of relying on a raw P2002 catch every time.
    const existingVoid = await db.invoice.findFirst({
      where: { voidsInvoiceId: invoiceId, tenantId },
      select: { id: true },
    });
    if (existingVoid) {
      return NextResponse.json(
        { error: "INVALID_STATE", message: "لا يمكن إلغاء هذه الفاتورة لأنها ملغاة بالفعل." },
        { status: 400 }
      );
    }

    if (originalInvoice.items.length === 0) {
      return NextResponse.json(
        { error: "INVALID_STATE", message: "هذه الفاتورة لا تحتوي على أي عناصر لاسترجاعها." },
        { status: 400 }
      );
    }

    // Perform the void operation in a transaction.
    //
    // Write order is critical for concurrency safety:
    //   (1) Invoice.create() first — carries the @unique constraint on
    //       voidsInvoiceId; THIS is the concurrency guard. If two void
    //       attempts race past the pre-check above, only one can succeed
    //       here — the other fails on the unique constraint before ever
    //       reaching a batch update, and its whole transaction rolls back
    //       with zero side effects.
    //   (2) InvoiceItem.create() per line.
    //   (3) ProductBatch.update() per affected batch, AFTER locking them.
    // Never reorder ProductBatch writes before Invoice.create() — doing
    // so would reopen the exact double-restore race this ordering exists
    // to prevent.
    const voidResult = await db.$transaction(async (tx) => {
      // [FIX — was entirely missing] Lock every batch this void will
      // touch, ORDER BY id ASC, BEFORE any write in this transaction —
      // required because a void can span multiple batches (whenever the
      // original sale itself was FIFO-split across more than one), and a
      // concurrent operation (another sync commit, a B2B approval, a
      // second void racing on an overlapping set of batches) touching
      // the same batches in a different order could otherwise deadlock.
      // The increment itself is already atomic per row — this lock
      // guards against deadlock across transactions, not against
      // corruption within one.
      const distinctBatchIds = Array.from(
        new Set(originalInvoice.items.map((item) => item.batchId))
      );

      await tenantScopedRawQuery(
        tx,
        tenantId,
        (tenantCondition) => Prisma.sql`
          SELECT id FROM "ProductBatch"
          WHERE id = ANY(${distinctBatchIds}) AND ${tenantCondition}
          ORDER BY id ASC
          FOR UPDATE
        `
      );

      // Step 1: Create the void invoice — the real concurrency guard,
      // see the note above this transaction.
      const voidInvoice = await tx.invoice.create({
        data: {
          tenantId,
          // [FIX — pre-existing type error, runtime-identical] These six
          // figures arrive as Prisma's own Decimal instances, and
          // @types/decimal.js types the decimal.js constructor's parameter as
          // `string | number | decimal.js.Decimal` — a structurally different
          // class from Prisma's, so passing the instance straight in failed
          // `next build`'s type-check (7 errors: these six + the item
          // quantity below). `.toString()` preserves the exact value and is
          // what every other call site in this codebase already does
          // (e.g. lib/data/invoices.ts). No runtime behaviour change.
          userId: adminUserId,
          customerId: originalInvoice.customerId,
          totalSYP: new Decimal(originalInvoice.totalSYP.toString()).negated().toString(),
          totalUSD: new Decimal(originalInvoice.totalUSD.toString()).negated().toString(),
          exchangeRateUsed: originalInvoice.exchangeRateUsed,
          paidAmountSYP: new Decimal(originalInvoice.paidAmountSYP.toString()).negated().toString(),
          paidAmountUSD: new Decimal(originalInvoice.paidAmountUSD.toString()).negated().toString(),
          debtAmountSYP: new Decimal(originalInvoice.debtAmountSYP.toString()).negated().toString(),
          debtAmountUSD: new Decimal(originalInvoice.debtAmountUSD.toString()).negated().toString(),
          isPaid: originalInvoice.isPaid,
          status: "VOIDED",
          isSynced: true,
          voidsInvoiceId: originalInvoice.id,
          voidReason: voidReason.trim(),
        },
      });

      // Step 2: Create void invoice items.
      // quantity = negated original (display only, never what's applied
      //   to the batch); unitId = same original sold unit; batchId =
      //   same as the original item.batchId; unitPriceSYP/USD = UNCHANGED
      //   (never negated) — negating price too would double-negate the
      //   line total and break the ledger's zero-sum property.
      const voidItems = [];
      for (const item of originalInvoice.items) {
        const voidItem = await tx.invoiceItem.create({
          data: {
            tenantId,
            invoiceId: voidInvoice.id,
            productId: item.productId,
            unitId: item.unitId,
            batchId: item.batchId,
            quantity: new Decimal(item.quantity.toString()).negated().toString(),
            unitPriceSYP: item.unitPriceSYP,
            unitPriceUSD: item.unitPriceUSD,
          },
        });
        voidItems.push(voidItem);
      }

      // Step 3: Restore inventory to the original batches. Never
      // requireBaseUnit() — that resolves the base unit (factor always
      // 1), not the unit actually sold. Never commitFifoAllocation — a
      // void restores to a pre-determined batch, it does not reallocate.
      for (const item of originalInvoice.items) {
        const soldUnitFactor = await getUnitConversionFactor(tx, tenantId, item.unitId);
        const restoreQtyInBaseUnit = toBaseUnit(item.quantity.toString(), soldUnitFactor);

        await tx.productBatch.update({
          where: { id: item.batchId, tenantId },
          data: { quantity: { increment: restoreQtyInBaseUnit.toString() } },
        });
      }

      return { voidInvoice, voidItems };
    });

    return NextResponse.json({
      success: true,
      message: "تم إلغاء الفاتورة واسترجاع المخزون بنجاح.",
      voidInvoiceId: voidResult.voidInvoice.id,
      voidItemsCount: voidResult.voidItems.length,
    });
  } catch (error) {
    if (error instanceof ForbiddenRoleError) {
      return forbiddenRoleResponse(error);
    }
    if (error instanceof SubscriptionLockedError) {
      return subscriptionLockedResponse(error);
    }

    // Handle a genuine race: two void attempts both passed the
    // pre-check above and hit Invoice.create()'s @unique constraint
    // concurrently. [FIX] Narrowed to check this IS actually the
    // voidsInvoiceId constraint (via Prisma's structured error, not a
    // substring match on .message) — a P2002 on some unrelated
    // constraint should not be silently mislabeled as "already voided."
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002" &&
      Array.isArray(error.meta?.target) &&
      (error.meta.target as string[]).includes("voidsInvoiceId")
    ) {
      return NextResponse.json(
        { error: "CONCURRENCY_ERROR", message: "هذه الفاتورة تم إلغاؤها بالفعل من قِبل مستخدم آخر." },
        { status: 409 }
      );
    }

    console.error("Error voiding invoice:", error);
    return NextResponse.json({ error: "SERVER_ERROR", message: "حدث خطأ أثناء إلغاء الفاتورة." }, { status: 500 });
  }
}