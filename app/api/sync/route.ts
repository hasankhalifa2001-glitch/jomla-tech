import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { Prisma, InvoiceStatus, type PaymentMethod } from "@prisma/client";
import { auth } from "@/auth";
// resolveFifoAllocation() and tenantScopedRawQuery() are both typed to accept
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
import { resolveFifoAllocation, lockBatchesForFifoAllocations } from "@/lib/inventory/fifo";
import {
  compareMoney,
  convertCurrency,
  subtractMoney,
  serializeMoney,
  multiplyMoney,
  sumMoney,
  MoneyError,
} from "@/lib/utils/money";

export const dynamic = "force-dynamic";

/**
 * T4c — /api/sync
 *
 * PUBLIC ENTRY POINT USED: the raw `prisma` client (from lib/db.ts), NOT
 * getTenantDb(tenantId). This is a deliberate, structural exception, not a
 * shortcut: resolveFifoAllocation() and tenantScopedRawQuery() both require
 * their `tx` argument to be exactly `Prisma.TransactionClient` — the type
 * produced by the raw client's `$transaction(async (tx) => ...)` callback.
 * The extended client returned by getTenantDb() produces a structurally
 * different type inside its own `$transaction` callback that TypeScript
 * will not accept where `Prisma.TransactionClient` is required. Because
 * every write in this route flows through one of those two helpers (or
 * needs the same lock/read discipline they use), tenantId is injected
 * manually into every `where`/`data` below — there is no automatic
 * injection safety net on this route. Every query and write in this file
 * must be reviewed for an explicit `tenantId` the same way a query would
 * be reviewed for a missing `WHERE` clause in raw SQL.
 *
 * NESTED WRITES: every Invoice / InvoiceItem / CustomerPayment / Customer
 * write below is its own top-level tx.<model>.create(...) call inside the
 * item's own $transaction — never nested under another model's `data`.
 *
 * BATCH LOCKING: seed.ts's createInvoiceAtomic() is a correct template for
 * the nested-write rule only — it does NOT take a `SELECT ... FOR UPDATE
 * ORDER BY id ASC` lock, and is unsafe to copy as-is for this reason (see
 * Developer Tooling — Seed Script in the spec). The void path locks all of
 * its known batchIds in one call to lockBatchesById() below, before any
 * ProductBatch.quantity update. The sale path locks every candidate batch
 * across EVERY line item of the invoice in one call to
 * lockBatchesForFifoAllocations() (lib/inventory/fifo.ts) BEFORE looping
 * over line items — see the CROSS-ITEM LOCK ORDERING note in the sale path
 * below for why per-line-item locking was insufficient.
 *
 * VOID AUTHORIZATION: [FIX] T4d requires a void to be "rejected outright
 * for a CASHIER session." That check previously did not exist anywhere in
 * this route — a CASHIER session could submit an offlineInvoice carrying
 * voidsOfflineInvoiceId and it would be processed like any ADMIN void. The
 * check is now performed per-invoice, BEFORE any transaction is opened for
 * that invoice, using session.user.role (never trusted from the payload).
 *
 * VOID CUSTOMER IDENTITY: [FIX] The void path previously resolved its
 * target customer from the void payload's own customerId/offlineCustomerId
 * — the SAME fields a normal sale uses — instead of from the original
 * invoice it reverses. Nothing compared the two, so a malformed or
 * tampered void payload could reverse invoiceA's stock/financial effect
 * while crediting customerB's ledger, silently corrupting both customers'
 * balances. The void path now takes customerId directly and exclusively
 * from the already-verified originalInvoice row; the void payload's own
 * customer fields are no longer read for this purpose.
 *
 * UNIT-CONFUSION FIX: resolveFifoAllocation() returns TWO distinct
 * quantity fields per allocation, on purpose — `allocatedQty` is
 * denominated in the REQUESTED unit (what the cashier picked, e.g.
 * "carton"), while `deductQtyInBatchUnit` is denominated in the BATCH's
 * own unit (e.g. "piece"), because a single sale can draw from batches
 * that were received in a different packaging unit than the one being
 * sold. Every allocation below carries both numbers explicitly, and each
 * is written to the field that actually expects that unit:
 * `allocatedQtyInRequestedUnit` -> InvoiceItem.quantity (paired with the
 * requested unitId), `deductQtyInBatchUnit` -> ProductBatch.quantity
 * decrement only. Same fix applied to the negative-stock fallback branch.
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
  // [FIX — CRITICAL] Was `z.number().positive()`, which rejected every
  // void payload outright at validation time: a void's line items are
  // ALWAYS negative by construction (see lib/offline/db.ts's
  // createOfflineVoidRecord, which throws if a void item's quantity is
  // >= 0). With `.positive()` here, no void invoice could ever reach this
  // route's void-matching/quantity-matching logic — every one would fail
  // with VALIDATION_ERROR (400) before any handler code ran. The sign
  // itself (positive for a sale, negative for a void) is now enforced at
  // the invoice level below, where whether this is a void is actually
  // known; at the item level, only "not zero" is a meaningful invariant.
  quantity: z.number().refine((n) => n !== 0, {
    message: "الكمية يجب ألا تساوي صفر.",
  }),
  unitPriceUSD: z.string().min(1),
  // Present only on a void item, mirroring the original sale's batch.
  // See VOID MATCHING note below for why this is required, not inferred.
  batchId: z.string().min(1).optional(),
});

const offlineInvoiceSchema = z
  .object({
    offlineId: z.string().min(1),
    customerId: z.string().min(1).optional(),
    offlineCustomerId: z.string().min(1).optional(),
    items: z.array(offlineInvoiceItemSchema).min(1),
    totalUSD: z.string().min(1),
    totalSYP: z.string().min(1),
    exchangeRateUsed: z.string().min(1),
    paidAmountUSD: z.string().min(1),
    debtAmountUSD: z.string().min(1),
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
  // [FIX — CRITICAL, paired with the item-level fix above] Enforces the
  // correct sign PER INVOICE TYPE: every item on a void invoice must be
  // strictly negative (mirrors lib/offline/db.ts's own construction rule);
  // every item on a normal sale invoice must be strictly positive. This
  // is where "is this a void" is actually known, so this is where the
  // sign requirement belongs — the item schema alone can only ever check
  // "not zero".
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
    amountUSD: z.string().min(1),
    amountSYP: z.string().min(1),
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

/** Sorts each device's own pending records by local createdAt ascending —
 * T4c's client-worker rule, applied here too since a single POST body may
 * legitimately batch several records that must still commit in that order
 * relative to each other. Cross-device ordering is governed separately by
 * lock-acquisition order (ORDER BY id ASC), never by comparing createdAt
 * across different devices. */
function sortByCreatedAt<T extends { createdAt: string }>(items: T[]): T[] {
  return [...items].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );
}

/**
 * Locks a fixed set of ProductBatch rows in deterministic `ORDER BY id ASC`
 * order via the one sanctioned raw-query path. Used directly by the void
 * path (which restores known batchIds, gathered across ALL of that void
 * invoice's items before this is called — see the VOID PATH below).
 */
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

  // Middleware already blocks writes for a locked-out tenant, but this is a
  // financially sensitive write endpoint — a single point of enforcement
  // (route matcher) is not enough of a guarantee to skip a second check here.
  if (session.user.subscriptionStatus !== "ACTIVE") {
    return NextResponse.json(
      { error: "SUBSCRIPTION_LOCKED", message: "اشتراكك منتهي أو معلق. لا يمكن إتمام المزامنة." },
      { status: 403 }
    );
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
      // Every item gets a result EXCEPT one specific case, documented
      // below: a transient infra failure (deadlock/serialization
      // conflict) that survived all MAX_TX_ATTEMPTS retries.
      if (isRetryableTxError(err)) {
        // Per T4c's own rule, "FAILED items never retried automatically."
        // Marking a deadlock-exhausted item FAILED would therefore
        // permanently block it — even though nothing is wrong with the
        // DATA, just transient row contention that may well clear by the
        // next sync attempt. Deliberately omitting it from the response:
        // the client's local record simply stays PENDING (never touched)
        // and is resent automatically next time, which is the correct
        // "retry later, not a data problem" semantic. Logged server-side
        // since this is otherwise invisible in the response.
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
    // [FIX — VOID AUTHORIZATION] T4d: void is ADMIN-only, "rejected
    // outright for a CASHIER session." Checked here, before any
    // transaction is opened for this invoice, using session.user.role —
    // never trusted from the payload itself (the payload has no role
    // field to trust in the first place; this guards the session).
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

          const totalUSD = serializeMoney(inv.totalUSD);
          const totalSYP = serializeMoney(inv.totalSYP);
          const exchangeRateUsed = serializeMoney(inv.exchangeRateUsed);
          const paidUSD = serializeMoney(inv.paidAmountUSD);
          const debtUSD = serializeMoney(inv.debtAmountUSD);

          if (compareMoney(exchangeRateUsed, 0) <= 0) {
            throw new Error("سعر الصرف المستخدم يجب أن يكون أكبر من الصفر.");
          }

          const expectedDebt = subtractMoney(totalUSD, paidUSD);
          if (compareMoney(expectedDebt, debtUSD) !== 0) {
            throw new Error("قيمة الدين لا تطابق الفرق بين إجمالي الفاتورة والمبلغ المدفوع.");
          }

          const expectedSYP = convertCurrency(totalUSD, exchangeRateUsed, "USD", "SYP");
          if (compareMoney(expectedSYP, totalSYP) !== 0) {
            throw new Error("قيمة الإجمالي بالليرة السورية غير متطابقة مع سعر الصرف.");
          }

          // Recomputes totalUSD independently from the line items and
          // requires it to match what the client claims — none of the
          // checks above validate totalUSD itself, they all treat it as
          // ground truth and cross-check the *other* fields against it.
          const isVoidForTotalCheck = Boolean(inv.voidsOfflineInvoiceId);
          const computedItemsTotal = sumMoney(
            inv.items.map((item) => multiplyMoney(Math.abs(item.quantity), item.unitPriceUSD))
          );
          const expectedTotalUSD = isVoidForTotalCheck
            ? subtractMoney("0", computedItemsTotal)
            : computedItemsTotal;
          if (compareMoney(expectedTotalUSD, totalUSD) !== 0) {
            throw new Error(
              `إجمالي الفاتورة (${totalUSD}) لا يطابق مجموع البنود (${expectedTotalUSD}).`
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

            // [FIX — VOID CUSTOMER IDENTITY] The target customer for a
            // void is ALWAYS the customer of the invoice being reversed —
            // never taken from the void payload's own customerId /
            // offlineCustomerId (those fields exist on the schema only
            // because the sale path needs them; a void payload should not
            // be trusted to independently name a customer, since that
            // customer is what determines whose debt ledger the reversal
            // credits). Reading it off the already-verified
            // originalInvoice row — instead of calling
            // resolveTargetCustomerId() against the payload — makes it
            // structurally impossible for a void to be applied against a
            // different customer than the one who was actually invoiced.
            const targetCustomerId = originalInvoice.customerId;

            // VOID MATCHING: a void item must carry its own `batchId`,
            // supplied by the client (T4d) from the original sale's data —
            // never guessed here. Falling back to "any batch for this
            // product" when no batchId is given risks restoring stock to
            // the wrong batch (wrong expiry, wrong cost basis) whenever a
            // product was sold from more than one batch. We fail loud
            // instead, and additionally cross-check the supplied batchId
            // AND quantity against the original invoice's own items — a
            // partial-quantity "void" is not a supported operation (voids
            // are full reversals only, per T4d; a partial correction goes
            // through a CustomerPayment adjustment instead), so a quantity
            // mismatch here is rejected rather than silently accepted.
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
                quantity: voidItem.quantity, // already negative — enforced by the schema now
                unitPriceUSD: serializeMoney(voidItem.unitPriceUSD),
              };
            });

            const batchAdjustments = matchedItems.map((it) => ({
              batchId: it.batchId,
              qtyToRestore: Math.abs(it.quantity),
            }));

            // Lock ALL of this void's batches in one call — already
            // gathered across every item of this invoice before this line
            // runs, so this is a single ORDER BY id ASC query covering the
            // void's entire lock footprint (same discipline the sale path
            // below now also follows for its own footprint).
            await lockBatchesById(tx, tenantId, batchAdjustments.map((b) => b.batchId));

            const voidInvoice = await tx.invoice.create({
              data: {
                tenantId,
                userId,
                customerId: targetCustomerId,
                totalUSD,
                totalSYP,
                exchangeRateUsed,
                paidAmountUSD: paidUSD,
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
          // Customer resolution happens here, ONLY on the sale path — the
          // void path above resolves its own targetCustomerId directly
          // from originalInvoice.customerId and never reaches this call.
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
          if (customerRecord?.isSystemGenerated && compareMoney(debtUSD, 0) > 0) {
            throw new Error(
              "لا يمكن تسجيل دين على الزبون النقدي العام — يجب اختيار زبون حقيقي له اسم ورقم هاتف."
            );
          }

          // Every allocation carries BOTH quantities explicitly, in the
          // unit each downstream write actually expects — see the
          // UNIT-CONFUSION FIX note at the top of this file:
          //   - allocatedQtyInRequestedUnit -> InvoiceItem.quantity
          //     (always paired with the REQUESTED unitId, never the
          //     batch's own unit)
          //   - deductQtyInBatchUnit        -> ProductBatch.quantity
          //     decrement only
          interface ResolvedAllocation {
            productId: string;
            unitId: string; // the REQUESTED unit — matches InvoiceItem.unitId
            batchId: string;
            unitPriceUSD: string;
            allocatedQtyInRequestedUnit: number;
            deductQtyInBatchUnit: number;
          }

          const resolvedAllocations: ResolvedAllocation[] = [];

          // CROSS-ITEM LOCK ORDERING FIX: a sale invoice can touch more
          // than one product. Locking each product's candidate batches
          // with its own separate ORDER BY id ASC query (one call per
          // line item) keeps that single product's batches in order, but
          // does NOT guarantee a single, consistent lock-acquisition
          // order for the invoice AS A WHOLE — two concurrent invoices
          // selling the same two products in opposite line-item order
          // could still deadlock against each other, since each
          // product's lock would be a separate SQL statement issued
          // independently. Every batch this invoice could possibly
          // touch, across every line item, is locked here in ONE
          // ORDER BY id ASC query up front, so the whole invoice's lock
          // footprint follows a single global order.
          const productIdsInInvoice = [...new Set(inv.items.map((it) => it.productId))];
          const preLockedQuantities = await lockBatchesForFifoAllocations(
            tx,
            tenantId,
            productIdsInInvoice
          );

          for (const item of inv.items) {
            // resolveFifoAllocation(mode: "COMMIT") uses preLockedQuantities
            // directly instead of taking its own internal lock — the lock
            // for this entire invoice was already acquired above, in one
            // query, across every product.
            const resolution = await resolveFifoAllocation(tx, {
              tenantId,
              productId: item.productId,
              unitId: item.unitId,
              requestedQty: item.quantity,
              mode: "COMMIT",
              preLockedQuantities,
            });

            if (resolution.allocations.length === 0) {
              throw new Error(`لا توجد أي دفعة متاحة لـ ${item.productId}/${item.unitId}.`);
            }

            for (const alloc of resolution.allocations) {
              resolvedAllocations.push({
                productId: item.productId,
                unitId: item.unitId,
                batchId: alloc.batchId,
                unitPriceUSD: serializeMoney(item.unitPriceUSD),
                // allocatedQty is already denominated in the REQUESTED
                // unit (fifo.ts: "Quantity in terms of the requested
                // unit") — correct pairing with `unitId` above.
                allocatedQtyInRequestedUnit: alloc.allocatedQty,
                // deductQtyInBatchUnit is denominated in the BATCH's own
                // unit (fifo.ts: "Quantity in terms of batch's own
                // unit") — used ONLY for the ProductBatch decrement
                // below, never written anywhere paired with `unitId`.
                deductQtyInBatchUnit: alloc.deductQtyInBatchUnit,
              });
            }

            // Accepted negative-stock policy: an offline sale is never
            // blocked by insufficient known stock. Any unmet remainder is
            // deducted from the last batch FIFO touched, letting that
            // batch's quantity go negative for T3's reconciliation view —
            // rather than silently dropping the shortfall or guessing a
            // new batch into existence.
            if (!resolution.isSufficient && resolution.remainingQty > 0) {
              const last = resolution.allocations[resolution.allocations.length - 1];

              // resolution.remainingQty is documented in fifo.ts as
              // "Unallocated in requested unit" — safe to use directly as
              // the InvoiceItem-side quantity, but it must be CONVERTED
              // into the last batch's own unit before it's used to
              // decrement ProductBatch.quantity, exactly the same way
              // fifo.ts itself converts allocatedQty -> deductQtyInBatchUnit
              // internally.
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

              const requestedFactor = Number(requestedUnitRecord?.conversionFactor) || 1;
              const batchFactor = Number(batchUnitRecord?.conversionFactor) || 1;
              const remainingInBaseUnits = resolution.remainingQty * requestedFactor;
              const remainingDeductInBatchUnit = remainingInBaseUnits / batchFactor;

              resolvedAllocations.push({
                productId: item.productId,
                unitId: item.unitId,
                batchId: last.batchId,
                unitPriceUSD: serializeMoney(item.unitPriceUSD),
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
              totalUSD,
              totalSYP,
              exchangeRateUsed,
              paidAmountUSD: paidUSD,
              debtAmountUSD: debtUSD,
              isPaid: compareMoney(debtUSD, 0) <= 0,
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
                // Always the REQUESTED unit, paired with the quantity
                // that's denominated in that same unit — see the
                // UNIT-CONFUSION FIX note above.
                unitId: alloc.unitId,
                batchId: alloc.batchId,
                quantity: alloc.allocatedQtyInRequestedUnit,
                unitPriceUSD: alloc.unitPriceUSD,
              },
            });
          }

          for (const alloc of resolvedAllocations) {
            await tx.productBatch.update({
              where: { id: alloc.batchId, tenantId },
              // Always the batch's own unit — the only quantity that's
              // valid to subtract from ProductBatch.quantity directly.
              data: { quantity: { decrement: alloc.deductQtyInBatchUnit } },
            });
          }

          if (compareMoney(paidUSD, 0) > 0) {
            if (!inv.paymentMethod) {
              throw new Error("paymentMethod مطلوب عندما paidAmountUSD > 0.");
            }
            await tx.customerPayment.create({
              data: {
                tenantId,
                customerId: targetCustomerId,
                invoiceId: invoice.id,
                amountUSD: paidUSD,
                amountSYP: convertCurrency(paidUSD, exchangeRateUsed, "USD", "SYP"),
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
        // See PASS 1's comment on this exact branch — same reasoning:
        // a transient deadlock/serialization conflict must not become a
        // permanent FAILED item. Left out of the response so the client
        // keeps this invoice PENDING and resends it automatically.
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
  // invoiceId is always null by construction (sale-time payments are
  // created inside the invoice pass above, never here).
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

          const amountUSD = serializeMoney(p.amountUSD);
          const amountSYP = serializeMoney(p.amountSYP);
          const exchangeRate = serializeMoney(p.exchangeRate);

          if (compareMoney(amountUSD, 0) <= 0) {
            throw new Error("قيمة الدفعة يجب أن تكون أكبر من الصفر.");
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
              amountUSD,
              amountSYP,
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
        // Same reasoning as PASS 1/PASS 2 above.
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