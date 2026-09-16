import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { Prisma, InvoiceStatus, type PaymentMethod } from "@prisma/client";
import { auth } from "@/auth";
// commitFifoAllocation() and tenantScopedRawQuery() are both typed to accept
// exactly `Prisma.TransactionClient` (see fifo.ts's own header comment on
// why it deliberately does NOT accept the Client Extension's dynamic
// transaction type). getTenantDb(tenantId).$transaction(...)'s callback
// produces a `DynamicClientExtensionThis<...>` that is NOT structurally
// assignable to `Prisma.TransactionClient` — passing it into either helper
// fails to compile. tenantId is therefore injected manually into every
// where/data clause below instead of relying on the extension. This route
// IS on lib/db.ts's documented raw-client allowlist — see that file's
// header comment.
// eslint-disable-next-line no-restricted-imports
import { prisma } from "@/lib/db";
import { tenantScopedRawQuery } from "@/lib/db/tenant-scope";
import { commitFifoAllocation } from "@/lib/inventory/fifo";
import { lockBatchesForFifoAllocations } from "@/lib/inventory/batch-locking";
import {
  compareMoney,
  convertCurrency,
  subtractMoney,
  serializeMoney,
  multiplyMoney,
  divideMoney,
  sumMoney,
  MoneyError,
} from "@/lib/utils/money";
import {
  assertTenantWritable,
  SubscriptionLockedError,
  subscriptionLockedResponse,
} from "@/lib/auth/tenant";

export const dynamic = "force-dynamic";

/**
 * T4c — /api/sync
 *
 * [... existing header documentation unchanged ...]
 *
 * [FIX — NULLABLE CLIENT EXCHANGE RATE / USD FIELDS] lib/offline/db.ts's
 * review pass 6 allows a purely SYP-priced offline sale to be created and
 * persisted LOCALLY (Dexie) with exchangeRateUsed — and every USD-derived
 * field it feeds (totalUSD, paidAmountUSD, debtAmountUSD, each item's
 * unitPriceUSD) — stored as `null`, genuinely meaning "this sale never
 * needed a rate to resolve," per T4b's own acceptance criterion ("checkout
 * blocks only for a USD-priced item with no cached rate, never for
 * SYP-only carts"). But on the SERVER, Invoice.exchangeRateUsed/totalUSD/
 * paidAmountUSD/debtAmountUSD and InvoiceItem.unitPriceUSD are all
 * REQUIRED, non-nullable Decimal columns (schema.prisma) — a straight
 * pass-through of `null` would fail a NOT NULL constraint the moment this
 * route tried to write it, immediately after Zod validation was loosened
 * to accept it.
 *
 * Two changes close this gap:
 *   1. The Zod schemas below now accept `null` on every USD-derived field
 *      (they must — this is what the client legitimately sends for a
 *      SYP-only sale) — but the invoice-processing logic no longer READS
 *      any of them as input. Every USD-derived figure written to the
 *      database is now computed HERE, server-side, from the authoritative
 *      SYP figures plus a resolved exchangeRateUsed — never trusted from
 *      the client payload, consistent with USD being purely
 *      derived/informational under the v3.6 currency re-anchoring.
 *   2. exchangeRateUsed itself is resolved with a fallback: if the client
 *      sent a real rate, it's used (after the same > 0 validation as
 *      before). If the client sent `null` (a SYP-only sale), the tenant's
 *      CURRENT `dailyExchangeRate` is read fresh from the database and
 *      used instead — this is exactly the server-side "a valid exchange
 *      rate is required and validated before [a record] is ever created"
 *      check T1 describes, just performed at the one point every offline
 *      invoice must actually pass through before being persisted. If the
 *      tenant has no dailyExchangeRate set at all, the sync fails loud
 *      with an actionable Arabic message rather than writing a fabricated
 *      or zero rate that would silently corrupt every USD-derived figure
 *      on this invoice going forward.
 *
 * [FIX — QUANTITY TYPE MISMATCH] OfflineInvoiceItem.quantity is a
 * decimal.js-serialized STRING on the client (db.ts, per T1's mandate
 * that quantity is never a native JS number over the wire/in storage) —
 * the Zod schema previously required `z.number()`, rejecting every real
 * payload outright with "expected number, received string". Changed to
 * `z.coerce.number()`, which parses the incoming decimal string into the
 * JS number every downstream FIFO/quantity calculation in this file
 * already expects (fifo.ts's commitFifoAllocation takes requestedQty as a
 * plain number by design — see that file) — no other logic in this route
 * needed to change as a result.
 *
 * [FIX — DOUBLE-ROUNDING PRECISION BUG] fifo.ts's commitFifoAllocation now
 * returns allocatedQty/deductQtyInBatchUnit (and remainingQty) as
 * decimal-serialized STRINGS, not rounded JS numbers — see that file's own
 * FIX note for the full reasoning. Every place below that previously did
 * native JS arithmetic on those fields (Number(...), *, /, Math.abs on a
 * FIFO-derived quantity) now goes through lib/utils/money.ts's decimal.js-
 * backed helpers instead, so a quantity requiring more precision than a
 * clean 4-decimal value (e.g. 2 pieces ÷ a 24-piece carton factor) is
 * rounded to the database column's real 4-decimal limit exactly ONCE, at
 * the point fifo.ts itself produces it — never re-touched by IEEE-754
 * float arithmetic on its way into ProductBatch.quantity's decrement or
 * InvoiceItem.quantity's write.
 */

// ============================================================================
// REQUEST SHAPE — matches OfflineInvoice / OfflinePayment / OfflineCustomer
// from lib/offline/db.ts. All monetary fields arrive as decimal.js-
// serialized strings, never native numbers (T4a's rule). Client-side
// validation in db.ts's factories is not trusted here — every check is
// re-run server-side against a payload that could be stale, hand-edited,
// or malicious.
// ============================================================================

const paymentMethodEnum = z.enum([
  "CASH",
  "SHAM_CASH",
  "SYRIATEL_CASH",
  "BANK_TRANSFER",
  "OTHER",
]);

const offlineInvoiceItemSchema = z.object({
  productId: z.string().min(1),
  unitId: z.string().min(1),
  // [FIX — QUANTITY TYPE MISMATCH] See file-header note above.
  quantity: z.coerce.number().refine((n) => n !== 0, {
    message: "الكمية يجب ألا تساوي صفر.",
  }),
  // unitPriceSYP is AUTHORITATIVE (InvoiceItem.unitPriceSYP is a required,
  // no-default Decimal column).
  unitPriceSYP: z.string().min(1),
  // [FIX — NULLABLE CLIENT EXCHANGE RATE / USD FIELDS] Nullable — see
  // file-header note above. No longer read as input anywhere below; every
  // unitPriceUSD actually written is computed server-side from
  // unitPriceSYP plus the resolved exchangeRateUsed.
  unitPriceUSD: z.string().min(1).nullable(),
  // Present only on a void item, mirroring the original sale's batch.
  batchId: z.string().min(1).optional(),
});

const offlineInvoiceSchema = z
  .object({
    offlineId: z.string().min(1),
    customerId: z.string().min(1).optional(),
    offlineCustomerId: z.string().min(1).optional(),
    items: z.array(offlineInvoiceItemSchema).min(1),
    // totalSYP / paidAmountSYP / debtAmountSYP are AUTHORITATIVE
    // (Invoice's required, no-default Decimal columns).
    totalSYP: z.string().min(1),
    // [FIX — NULLABLE CLIENT EXCHANGE RATE / USD FIELDS] Nullable — see
    // file-header note above. No longer read as input; server always
    // computes this from totalSYP + the resolved exchangeRateUsed.
    totalUSD: z.string().min(1).nullable(),
    // [FIX — NULLABLE CLIENT EXCHANGE RATE / USD FIELDS] Nullable — a
    // SYP-only sale genuinely has no rate on the client. See the
    // exchangeRateUsed resolution block in POST below for the
    // server-side fallback (tenant.dailyExchangeRate) this now triggers.
    exchangeRateUsed: z.string().min(1).nullable(),
    paidAmountSYP: z.string().min(1),
    // [FIX — NULLABLE CLIENT EXCHANGE RATE / USD FIELDS] Nullable — see above.
    paidAmountUSD: z.string().min(1).nullable(),
    debtAmountSYP: z.string().min(1),
    // [FIX — NULLABLE CLIENT EXCHANGE RATE / USD FIELDS] Nullable — see above.
    debtAmountUSD: z.string().min(1).nullable(),
    paymentMethod: paymentMethodEnum.optional(),
    voidsOfflineInvoiceId: z.string().min(1).optional(),
    voidReason: z.string().min(1).optional(),
    createdAt: z.string().min(1),
  })
  .refine((v) => Boolean(v.customerId) !== Boolean(v.offlineCustomerId), {
    message: "يجب توفير customerId أو offlineCustomerId، وليس كليهما أو لا شيء.",
  })
  .refine((v) => !v.voidsOfflineInvoiceId || Boolean(v.voidReason), {
    message: "voidReason مطلوب عند إلغاء فاتورة.",
  })
  .refine(
    (v) => {
      const isVoid = Boolean(v.voidsOfflineInvoiceId);
      return v.items.every((it) => (isVoid ? it.quantity < 0 : it.quantity > 0));
    },
    {
      message:
        "إشارة الكمية غير صحيحة: يجب أن تكون كل الكميات موجبة في فاتورة بيع، " +
        "وسالبة بالكامل في فاتورة إلغاء.",
      path: ["items"],
    }
  );

const offlinePaymentSchema = z
  .object({
    offlineId: z.string().min(1),
    customerId: z.string().min(1).optional(),
    offlineCustomerId: z.string().min(1).optional(),
    // CustomerPayment.amountSYP is AUTHORITATIVE. amountUSD/exchangeRate
    // are deliberately left required/non-nullable here — a repayment is
    // always collected at a real, known moment (db.ts's
    // createOfflinePaymentRecord never allows a null rate for this
    // record type), unlike a cart that might contain zero USD-priced
    // lines. No change needed for payments.
    amountSYP: z.string().min(1),
    amountUSD: z.string().min(1),
    exchangeRate: z.string().min(1),
    paymentMethod: paymentMethodEnum,
    receiptNo: z.string().optional(),
    notes: z.string().optional(),
    createdAt: z.string().min(1),
  })
  .refine((v) => Boolean(v.customerId) !== Boolean(v.offlineCustomerId), {
    message: "يجب توفير customerId أو offlineCustomerId، وليس كليهما أو لا شيء.",
  });

const offlineCustomerSchema = z.object({
  offlineId: z.string().min(1),
  name: z.string().min(1),
  phone: z.string().optional(),
  shopName: z.string().optional(),
  createdAt: z.string().min(1),
});

const syncRequestSchema = z.object({
  customers: z.array(offlineCustomerSchema).default([]),
  invoices: z.array(offlineInvoiceSchema).default([]),
  payments: z.array(offlinePaymentSchema).default([]),
});

type SyncRequest = z.infer<typeof syncRequestSchema>;
type InvoicePayload = SyncRequest["invoices"][number];
type PaymentPayload = SyncRequest["payments"][number];
type CustomerPayload = SyncRequest["customers"][number];

interface ItemResult {
  offlineId: string;
  status: "SYNCED" | "FAILED";
  realId?: string;
  error?: string;
}

const TX_OPTIONS = { maxWait: 10_000, timeout: 20_000 } as const;
const MAX_TX_ATTEMPTS = 3;

function isUniqueConflict(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

function isRetryableTxError(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2034") {
    return true;
  }
  const message = err instanceof Error ? err.message : String(err);
  return /deadlock detected|could not serialize|40001|40P01/i.test(message);
}

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof MoneyError || err instanceof Error) return err.message;
  return fallback;
}

function sortByCreatedAt<T extends { createdAt: string }>(items: T[]): T[] {
  return [...items].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );
}

async function lockBatchesById(
  tx: Prisma.TransactionClient,
  tenantId: string,
  batchIds: string[]
): Promise<void> {
  const candidateIds = [...new Set(batchIds.filter(Boolean))].sort();
  if (candidateIds.length === 0) return;

  await tenantScopedRawQuery(tx, tenantId, (tenantCondition) => Prisma.sql`
    SELECT id, quantity
    FROM "ProductBatch"
    WHERE id IN (${Prisma.join(candidateIds)})
      AND ${tenantCondition}
    ORDER BY id ASC
    FOR UPDATE
  `);
}

async function resolveTargetCustomerId(
  tx: Prisma.TransactionClient,
  tenantId: string,
  customerMap: Map<string, string>,
  refs: { offlineCustomerId?: string; customerId?: string },
  missingMessage: string
): Promise<string> {
  if (refs.offlineCustomerId) {
    const mapped = customerMap.get(refs.offlineCustomerId);
    if (mapped) return mapped;

    const matched = await tx.customer.findFirst({
      where: { offlineId: refs.offlineCustomerId, tenantId },
      select: { id: true },
    });
    if (matched) {
      customerMap.set(refs.offlineCustomerId, matched.id);
      return matched.id;
    }
  } else if (refs.customerId) {
    const matched = await tx.customer.findFirst({
      where: { id: refs.customerId, tenantId },
      select: { id: true },
    });
    if (matched) return matched.id;
  }

  throw new Error(missingMessage);
}

export async function POST(req: NextRequest) {
  const session = await auth();

  if (!session?.user?.tenantId || !session.user.id) {
    return NextResponse.json(
      { error: "UNAUTHORIZED", message: "يرجى تسجيل الدخول أولاً للمزامنة." },
      { status: 401 }
    );
  }

  try {
    await assertTenantWritable(session.user.tenantId);
  } catch (error) {
    if (error instanceof SubscriptionLockedError) {
      return subscriptionLockedResponse(error);
    }
    throw error;
  }

  const tenantId = session.user.tenantId;
  const userId = session.user.id;
  const userRole = session.user.role;

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return NextResponse.json(
      { error: "BAD_REQUEST", message: "طلب غير صالح (JSON غير صحيح)." },
      { status: 400 }
    );
  }

  const parsed = syncRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "VALIDATION_ERROR",
        message: "شكل بيانات المزامنة غير صحيح.",
        details: parsed.error.flatten(),
      },
      { status: 400 }
    );
  }

  const customers = sortByCreatedAt(parsed.data.customers);
  const invoices = sortByCreatedAt(parsed.data.invoices);
  const payments = sortByCreatedAt(parsed.data.payments);

  const customerMap = new Map<string, string>();

  const customerResults: ItemResult[] = [];
  const invoiceResults: ItemResult[] = [];
  const paymentResults: ItemResult[] = [];

  async function withTxRetries<T>(run: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_TX_ATTEMPTS; attempt++) {
      try {
        return await run();
      } catch (err) {
        lastError = err;
        if (isUniqueConflict(err) || !isRetryableTxError(err) || attempt === MAX_TX_ATTEMPTS) {
          throw err;
        }
      }
    }
    throw lastError;
  }

  // ==========================================================================
  // PASS 1 — Customers. Idempotent via Customer.offlineId.
  // ==========================================================================
  for (const c of customers as CustomerPayload[]) {
    try {
      const { id } = await withTxRetries(() =>
        prisma.$transaction(async (tx) => {
          const existing = await tx.customer.findFirst({
            where: { offlineId: c.offlineId, tenantId },
            select: { id: true },
          });
          if (existing) return existing;

          const created = await tx.customer.create({
            data: {
              tenantId,
              name: c.name.trim(),
              phone: c.phone?.trim() || null,
              shopName: c.shopName?.trim() || null,
              offlineId: c.offlineId,
              isSystemGenerated: false,
              createdAt: new Date(c.createdAt),
            },
            select: { id: true },
          });
          return created;
        }, TX_OPTIONS)
      );

      customerMap.set(c.offlineId, id);
      customerResults.push({ offlineId: c.offlineId, status: "SYNCED", realId: id });
    } catch (err) {
      if (isUniqueConflict(err)) {
        const existing = await prisma.customer.findFirst({
          where: { offlineId: c.offlineId, tenantId },
          select: { id: true },
        });
        if (existing) {
          customerMap.set(c.offlineId, existing.id);
          customerResults.push({ offlineId: c.offlineId, status: "SYNCED", realId: existing.id });
          continue;
        }
      }
      if (isRetryableTxError(err)) {
        console.error(
          `[sync] customer ${c.offlineId}: transient failure after ${MAX_TX_ATTEMPTS} attempts, leaving PENDING`,
          err
        );
        continue;
      }
      customerResults.push({
        offlineId: c.offlineId,
        status: "FAILED",
        error: errorMessage(err, "فشل في حفظ الزبون."),
      });
    }
  }

  // ==========================================================================
  // PASS 2 — Invoices (sale or void). Idempotent via Invoice.offlineId.
  // ==========================================================================
  for (const inv of invoices as InvoicePayload[]) {
    if (inv.voidsOfflineInvoiceId && userRole !== "ADMIN") {
      invoiceResults.push({
        offlineId: inv.offlineId,
        status: "FAILED",
        error: "عملية إلغاء الفاتورة متاحة فقط لحساب المدير (ADMIN).",
      });
      continue;
    }

    try {
      const { id } = await withTxRetries(() =>
        prisma.$transaction(async (tx) => {
          const existing = await tx.invoice.findFirst({
            where: { offlineId: inv.offlineId, tenantId },
            select: { id: true },
          });
          if (existing) return existing;

          const totalSYP = serializeMoney(inv.totalSYP);
          const paidSYP = serializeMoney(inv.paidAmountSYP);
          const debtSYP = serializeMoney(inv.debtAmountSYP);

          // [FIX — NULLABLE CLIENT EXCHANGE RATE / USD FIELDS] See the
          // file-header note above for the full reasoning. Resolves a
          // real, positive exchangeRateUsed either from the client
          // payload (an item was USD-priced) or, when the client sent
          // null (a SYP-only sale), from the tenant's current
          // dailyExchangeRate — the server-side "a valid exchange rate is
          // required and validated before creation" check T1 describes.
          let exchangeRateUsed: string;
          if (inv.exchangeRateUsed !== null) {
            exchangeRateUsed = serializeMoney(inv.exchangeRateUsed);
            if (compareMoney(exchangeRateUsed, 0) <= 0) {
              throw new Error("سعر الصرف المستخدم يجب أن يكون أكبر من الصفر.");
            }
          } else {
            const tenantRow = await tx.tenant.findUnique({
              where: { id: tenantId },
              select: { dailyExchangeRate: true },
            });
            if (!tenantRow?.dailyExchangeRate) {
              throw new Error(
                "لا يمكن مزامنة هذه الفاتورة: لم يتم تحديد سعر الصرف اليومي لهذا المتجر بعد. " +
                "يرجى ضبط سعر الصرف من الإعدادات ثم إعادة المحاولة."
              );
            }
            exchangeRateUsed = serializeMoney(tenantRow.dailyExchangeRate.toString());
          }

          // [FIX — NULLABLE CLIENT EXCHANGE RATE / USD FIELDS] Every
          // USD-derived figure is computed HERE, from the authoritative
          // SYP figures plus the resolved exchangeRateUsed above — never
          // read from inv.totalUSD/paidAmountUSD/debtAmountUSD, which may
          // be null on the payload and are purely informational even
          // when present (v3.6 currency re-anchoring).
          const totalUSD = convertCurrency(totalSYP, exchangeRateUsed, "SYP", "USD");
          const paidUSD = convertCurrency(paidSYP, exchangeRateUsed, "SYP", "USD");
          const debtUSD = convertCurrency(debtSYP, exchangeRateUsed, "SYP", "USD");

          // AUTHORITATIVE (v3.6): debtAmountSYP ≈ totalSYP − paidAmountSYP.
          const expectedDebtSYP = subtractMoney(totalSYP, paidSYP);
          if (compareMoney(expectedDebtSYP, debtSYP) !== 0) {
            throw new Error(
              "قيمة الدين بالليرة السورية لا تطابق الفرق بين إجمالي الفاتورة والمبلغ المدفوع."
            );
          }

          // Recomputes totalSYP independently from the line items
          // (unitPriceSYP × quantity) and requires it to match what the
          // client claims — AUTHORITATIVE.
          const isVoidForTotalCheck = Boolean(inv.voidsOfflineInvoiceId);
          const computedItemsTotalSYP = sumMoney(
            inv.items.map((item) => multiplyMoney(Math.abs(item.quantity), item.unitPriceSYP))
          );
          const expectedTotalSYP = isVoidForTotalCheck
            ? subtractMoney("0", computedItemsTotalSYP)
            : computedItemsTotalSYP;
          if (compareMoney(expectedTotalSYP, totalSYP) !== 0) {
            throw new Error(
              `إجمالي الفاتورة بالليرة السورية (${totalSYP}) لا يطابق مجموع البنود (${expectedTotalSYP}).`
            );
          }

          const isVoid = Boolean(inv.voidsOfflineInvoiceId);

          if (isVoid) {
            // ---- VOID PATH -----------------------------------------------
            const originalInvoice = await tx.invoice.findFirst({
              where: { offlineId: inv.voidsOfflineInvoiceId, tenantId },
              include: { items: true },
            });
            if (!originalInvoice) {
              throw new Error("الفاتورة الأصلية المراد إلغاؤها لم تتم مزامنتها بعد.");
            }
            if (originalInvoice.status === InvoiceStatus.VOIDED) {
              throw new Error("لا يمكن إلغاء فاتورة ملغاة مسبقاً.");
            }
            const alreadyVoided = await tx.invoice.findFirst({
              where: { voidsInvoiceId: originalInvoice.id, tenantId },
              select: { id: true },
            });
            if (alreadyVoided) {
              throw new Error("تم إلغاء هذه الفاتورة مسبقاً عبر مزامنة أخرى.");
            }
            if (originalInvoice.items.length !== inv.items.length) {
              throw new Error("عدد بنود الإلغاء لا يطابق عدد بنود الفاتورة الأصلية.");
            }

            const targetCustomerId = originalInvoice.customerId;

            const matchedItems = inv.items.map((voidItem) => {
              if (!voidItem.batchId) {
                throw new Error(
                  `عنصر الإلغاء (${voidItem.productId}/${voidItem.unitId}) بلا batchId — ` +
                  "يجب أن يرسل التطبيق batchId الأصلي مع كل عنصر إلغاء."
                );
              }
              const originalItem = originalInvoice.items.find(
                (oi) =>
                  oi.batchId === voidItem.batchId &&
                  oi.productId === voidItem.productId &&
                  oi.unitId === voidItem.unitId
              );
              if (!originalItem) {
                throw new Error(
                  `batchId المرسل لعنصر الإلغاء (${voidItem.batchId}) لا يطابق أي بند بالفاتورة الأصلية.`
                );
              }
              if (
                compareMoney(
                  serializeMoney(Math.abs(voidItem.quantity)),
                  serializeMoney(originalItem.quantity.toString())
                ) !== 0
              ) {
                throw new Error(
                  `كمية عنصر الإلغاء (${Math.abs(voidItem.quantity)}) لا تطابق الكمية الأصلية ` +
                  `(${originalItem.quantity.toString()}) — الإلغاء يجب أن يكون استرجاعاً كاملاً، ` +
                  "أي تصحيح جزئي يُسجَّل كدفعة (CustomerPayment) بدلاً من إلغاء."
                );
              }
              return {
                productId: voidItem.productId,
                unitId: voidItem.unitId,
                batchId: voidItem.batchId,
                quantity: voidItem.quantity,
                unitPriceSYP: serializeMoney(voidItem.unitPriceSYP),
                // [FIX — NULLABLE CLIENT EXCHANGE RATE / USD FIELDS]
                // Computed from unitPriceSYP + the resolved
                // exchangeRateUsed — never trusted from the payload.
                unitPriceUSD: convertCurrency(
                  serializeMoney(voidItem.unitPriceSYP),
                  exchangeRateUsed,
                  "SYP",
                  "USD"
                ),
              };
            });

            const batchAdjustments = matchedItems.map((it) => ({
              batchId: it.batchId,
              qtyToRestore: Math.abs(it.quantity),
            }));

            await lockBatchesById(tx, tenantId, batchAdjustments.map((b) => b.batchId));

            const voidInvoice = await tx.invoice.create({
              data: {
                tenantId,
                userId,
                customerId: targetCustomerId,
                totalSYP,
                totalUSD,
                exchangeRateUsed,
                paidAmountSYP: paidSYP,
                paidAmountUSD: paidUSD,
                debtAmountSYP: debtSYP,
                debtAmountUSD: debtUSD,
                isPaid: true,
                status: InvoiceStatus.VOIDED,
                offlineId: inv.offlineId,
                syncedAt: new Date(),
                voidsInvoiceId: originalInvoice.id,
                voidReason: inv.voidReason,
                createdAt: new Date(inv.createdAt),
              },
              select: { id: true },
            });

            for (const item of matchedItems) {
              await tx.invoiceItem.create({
                data: {
                  tenantId,
                  invoiceId: voidInvoice.id,
                  productId: item.productId,
                  unitId: item.unitId,
                  batchId: item.batchId,
                  quantity: item.quantity,
                  unitPriceSYP: item.unitPriceSYP,
                  unitPriceUSD: item.unitPriceUSD,
                },
              });
            }

            for (const adj of batchAdjustments) {
              await tx.productBatch.update({
                where: { id: adj.batchId, tenantId },
                data: { quantity: { increment: adj.qtyToRestore } },
              });
            }

            return voidInvoice;
          }

          // ---- SALE PATH -------------------------------------------------
          const targetCustomerId = await resolveTargetCustomerId(
            tx,
            tenantId,
            customerMap,
            { offlineCustomerId: inv.offlineCustomerId, customerId: inv.customerId },
            "الزبون المرتبط بهذه الفاتورة غير موجود."
          );

          const customerRecord = await tx.customer.findFirst({
            where: { id: targetCustomerId, tenantId },
            select: { isSystemGenerated: true },
          });
          if (customerRecord?.isSystemGenerated && compareMoney(debtSYP, 0) > 0) {
            throw new Error(
              "لا يمكن تسجيل دين على الزبون النقدي العام — يجب اختيار زبون حقيقي له اسم ورقم هاتف."
            );
          }

          // [FIX — precision] Both quantity fields are now decimal-
          // serialized STRINGS, matching fifo.ts's own output type — see
          // that file's FIX note. Never re-wrapped in Number(...)
          // anywhere below; every arithmetic operation on them (the
          // negative-stock conversion fallback) uses lib/utils/money.ts's
          // decimal.js-backed helpers.
          interface ResolvedAllocation {
            productId: string;
            unitId: string;
            batchId: string;
            unitPriceSYP: string;
            unitPriceUSD: string;
            allocatedQtyInRequestedUnit: string;
            deductQtyInBatchUnit: string;
          }

          const resolvedAllocations: ResolvedAllocation[] = [];

          const productIdsInInvoice = [...new Set(inv.items.map((it) => it.productId))];
          await lockBatchesForFifoAllocations(
            tx,
            tenantId,
            productIdsInInvoice
          );

          for (const item of inv.items) {
            const resolution = await commitFifoAllocation(tx, {
              tenantId,
              productId: item.productId,
              unitId: item.unitId,
              requestedQty: item.quantity,
            });

            if (resolution.allocations.length === 0) {
              throw new Error(`لا توجد أي دفعة متاحة لـ ${item.productId}/${item.unitId}.`);
            }

            // [FIX — NULLABLE CLIENT EXCHANGE RATE / USD FIELDS] Computed
            // once per item from unitPriceSYP + the resolved
            // exchangeRateUsed — never trusted from item.unitPriceUSD.
            const itemUnitPriceUSD = convertCurrency(
              serializeMoney(item.unitPriceSYP),
              exchangeRateUsed,
              "SYP",
              "USD"
            );

            for (const alloc of resolution.allocations) {
              resolvedAllocations.push({
                productId: item.productId,
                unitId: item.unitId,
                batchId: alloc.batchId,
                unitPriceSYP: serializeMoney(item.unitPriceSYP),
                unitPriceUSD: itemUnitPriceUSD,
                // [FIX — precision] alloc.allocatedQty / .deductQtyInBatchUnit
                // are already decimal-serialized strings from fifo.ts —
                // passed through directly, never Number()-wrapped.
                allocatedQtyInRequestedUnit: alloc.allocatedQty,
                deductQtyInBatchUnit: alloc.deductQtyInBatchUnit,
              });
            }

            // [FIX — precision] resolution.remainingQty is a string now —
            // compared via compareMoney, never coerced to number first.
            if (!resolution.isSufficient && compareMoney(resolution.remainingQty, 0) > 0) {
              const last = resolution.allocations[resolution.allocations.length - 1];

              const [requestedUnitRecord, batchUnitRecord] = await Promise.all([
                tx.productUnit.findFirst({
                  where: { id: item.unitId, productId: item.productId, tenantId },
                  select: { conversionFactor: true },
                }),
                tx.productUnit.findFirst({
                  where: { id: last.batchUnitId, tenantId },
                  select: { conversionFactor: true },
                }),
              ]);

              // [FIX — precision] Converts the leftover requested-unit
              // quantity into the last batch's own unit using
              // lib/utils/money.ts's decimal.js-backed multiplyMoney/
              // divideMoney — the exact same conversion fifo.ts itself
              // performs internally, kept in string/Decimal form the
              // entire way instead of round-tripping through native JS
              // `*`/`/` on floats.
              const requestedFactor = requestedUnitRecord?.conversionFactor?.toString() ?? "1";
              const batchFactor = batchUnitRecord?.conversionFactor?.toString() ?? "1";
              const remainingInBaseUnits = multiplyMoney(resolution.remainingQty, requestedFactor);
              const remainingDeductInBatchUnit = divideMoney(remainingInBaseUnits, batchFactor);

              resolvedAllocations.push({
                productId: item.productId,
                unitId: item.unitId,
                batchId: last.batchId,
                unitPriceSYP: serializeMoney(item.unitPriceSYP),
                unitPriceUSD: itemUnitPriceUSD,
                allocatedQtyInRequestedUnit: resolution.remainingQty,
                deductQtyInBatchUnit: remainingDeductInBatchUnit,
              });
            }
          }

          const invoice = await tx.invoice.create({
            data: {
              tenantId,
              userId,
              customerId: targetCustomerId,
              totalSYP,
              totalUSD,
              exchangeRateUsed,
              paidAmountSYP: paidSYP,
              paidAmountUSD: paidUSD,
              debtAmountSYP: debtSYP,
              debtAmountUSD: debtUSD,
              isPaid: compareMoney(debtSYP, 0) <= 0,
              status: InvoiceStatus.COMPLETED,
              offlineId: inv.offlineId,
              syncedAt: new Date(),
              createdAt: new Date(inv.createdAt),
            },
            select: { id: true },
          });

          for (const alloc of resolvedAllocations) {
            await tx.invoiceItem.create({
              data: {
                tenantId,
                invoiceId: invoice.id,
                productId: alloc.productId,
                unitId: alloc.unitId,
                batchId: alloc.batchId,
                // [FIX — precision] Prisma's Decimal columns accept a
                // decimal string directly — no native-number conversion
                // needed or wanted here.
                quantity: alloc.allocatedQtyInRequestedUnit,
                unitPriceSYP: alloc.unitPriceSYP,
                unitPriceUSD: alloc.unitPriceUSD,
              },
            });
          }

          for (const alloc of resolvedAllocations) {
            await tx.productBatch.update({
              where: { id: alloc.batchId, tenantId },
              // [FIX — precision] `decrement` accepts a decimal string
              // directly — this is the single point the fully-precise
              // deduction value actually reaches the database, with no
              // intervening float arithmetic.
              data: { quantity: { decrement: alloc.deductQtyInBatchUnit } },
            });
          }

          if (compareMoney(paidSYP, 0) > 0) {
            if (!inv.paymentMethod) {
              throw new Error("paymentMethod مطلوب عندما paidAmountSYP > 0.");
            }
            await tx.customerPayment.create({
              data: {
                tenantId,
                customerId: targetCustomerId,
                invoiceId: invoice.id,
                amountSYP: paidSYP,
                amountUSD: paidUSD,
                exchangeRate: exchangeRateUsed,
                paymentMethod: inv.paymentMethod as PaymentMethod,
                syncedAt: new Date(),
                createdAt: new Date(inv.createdAt),
              },
            });
          }

          return invoice;
        }, TX_OPTIONS)
      );

      invoiceResults.push({ offlineId: inv.offlineId, status: "SYNCED", realId: id });
    } catch (err) {
      if (isUniqueConflict(err)) {
        const existing = await prisma.invoice.findFirst({
          where: { offlineId: inv.offlineId, tenantId },
          select: { id: true },
        });
        if (existing) {
          invoiceResults.push({
            offlineId: inv.offlineId,
            status: "SYNCED",
            realId: existing.id,
          });
          continue;
        }
      }
      if (isRetryableTxError(err)) {
        console.error(
          `[sync] invoice ${inv.offlineId}: transient failure after ${MAX_TX_ATTEMPTS} attempts, leaving PENDING`,
          err
        );
        continue;
      }
      invoiceResults.push({
        offlineId: inv.offlineId,
        status: "FAILED",
        error: errorMessage(err, "فشل في مزامنة الفاتورة."),
      });
    }
  }

  // ==========================================================================
  // PASS 3 — Payments. Idempotent via CustomerPayment.offlineId.
  // ==========================================================================
  for (const p of payments as PaymentPayload[]) {
    try {
      const { id } = await withTxRetries(() =>
        prisma.$transaction(async (tx) => {
          const existing = await tx.customerPayment.findFirst({
            where: { offlineId: p.offlineId, tenantId },
            select: { id: true },
          });
          if (existing) return existing;

          const amountSYP = serializeMoney(p.amountSYP);
          const amountUSD = serializeMoney(p.amountUSD);
          const exchangeRate = serializeMoney(p.exchangeRate);

          if (compareMoney(amountSYP, 0) <= 0) {
            throw new Error("قيمة الدفعة بالليرة السورية يجب أن تكون أكبر من الصفر.");
          }
          if (compareMoney(exchangeRate, 0) <= 0) {
            throw new Error("سعر الصرف يجب أن يكون أكبر من الصفر.");
          }

          const targetCustomerId = await resolveTargetCustomerId(
            tx,
            tenantId,
            customerMap,
            { offlineCustomerId: p.offlineCustomerId, customerId: p.customerId },
            "الزبون المرتبط بهذه الدفعة غير موجود."
          );

          const created = await tx.customerPayment.create({
            data: {
              tenantId,
              customerId: targetCustomerId,
              invoiceId: null,
              amountSYP,
              amountUSD,
              exchangeRate,
              paymentMethod: p.paymentMethod as PaymentMethod,
              receiptNo: p.receiptNo || null,
              notes: p.notes || null,
              offlineId: p.offlineId,
              syncedAt: new Date(),
              createdAt: new Date(p.createdAt),
            },
            select: { id: true },
          });
          return created;
        }, TX_OPTIONS)
      );

      paymentResults.push({ offlineId: p.offlineId, status: "SYNCED", realId: id });
    } catch (err) {
      if (isUniqueConflict(err)) {
        const existing = await prisma.customerPayment.findFirst({
          where: { offlineId: p.offlineId, tenantId },
          select: { id: true },
        });
        if (existing) {
          paymentResults.push({
            offlineId: p.offlineId,
            status: "SYNCED",
            realId: existing.id,
          });
          continue;
        }
      }
      if (isRetryableTxError(err)) {
        console.error(
          `[sync] payment ${p.offlineId}: transient failure after ${MAX_TX_ATTEMPTS} attempts, leaving PENDING`,
          err
        );
        continue;
      }
      paymentResults.push({
        offlineId: p.offlineId,
        status: "FAILED",
        error: errorMessage(err, "فشل في مزامنة الدفعة."),
      });
    }
  }

  const allResults = [...customerResults, ...invoiceResults, ...paymentResults];
  const success = allResults.every((r) => r.status === "SYNCED");

  return NextResponse.json({
    success,
    customers: customerResults,
    invoices: invoiceResults,
    payments: paymentResults,
  });
}