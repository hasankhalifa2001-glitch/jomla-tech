import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { Prisma, InvoiceStatus, type PaymentMethod } from "@prisma/client";
import { auth } from "@/auth";
// commitFifoAllocation() and tenantScopedRawQuery() are both typed to accept
// TxOrClient (see lib/db/tenant-scope.ts for the full type derivation, and
// lib/inventory/fifo.ts / lib/inventory/base-unit.ts for how it's consumed).
// This route opens its transaction via raw `prisma.$transaction(...)`,
// producing a plain `Prisma.TransactionClient` — now structurally covered
// by TxOrClient's union. This route IS on lib/db.ts's documented raw-client
// allowlist (category 5) — see that file's header comment.
import { prisma } from "@/lib/db";
import { tenantScopedRawQuery } from "@/lib/db/tenant-scope";
import { commitFifoAllocation } from "@/lib/inventory/fifo";
import { lockBatchesForFifoAllocations } from "@/lib/inventory/batch-locking";
import { requireBaseUnit, MissingBaseUnitError } from "@/lib/inventory/base-unit";
import { getUnitConversionFactor, toBaseUnit, fromBaseUnit } from "@/lib/inventory/units";
import {
  compareMoney,
  convertCurrency,
  subtractMoney,
  serializeMoney,
  multiplyMoney,
  sumMoney,
  MoneyError,
} from "@/lib/utils/money";
import { resolveActiveCustomerId } from "@/lib/customers/resolve-active";
import {
  assertTenantWritable,
  SubscriptionLockedError,
  subscriptionLockedResponse,
} from "@/lib/auth/tenant";

export const dynamic = "force-dynamic";

/**
 * T4c — /api/sync
 *
 * [... prior header documentation on nullable USD fields, quantity type
 * coercion, double-rounding fix, v4.0 base-unit conversion fix, v4.1 sync
 * ordering fix, and v4.1 lost-ack idempotency fix — all unchanged and
 * still in effect, see earlier revisions of this file for the full text
 * of each ...]
 *
 * [FIX — RETRY_LATER, prior revision — closes a real "false success" bug]
 * When a retryable transaction error (deadlock, serialization failure)
 * exhausted all MAX_TX_ATTEMPTS retries, the per-item catch block used to
 * `console.error(...)` followed by a bare `continue`/`return` — the item
 * was NEVER pushed into customerResults/invoiceResults/paymentResults at
 * all, so `success = allResults.every(r => r.status === "SYNCED")`
 * silently ignored it and reported `success: true` even though a real
 * record never reached the server.
 *
 * FIX: every such item is now pushed into its results array with a THIRD,
 * explicit status — "RETRY_LATER" — distinct from both "SYNCED" and
 * "FAILED". The client-side sync worker treats "FAILED" as terminal (per
 * this route's documented per-item semantics) and treats "RETRY_LATER" as
 * still-PENDING (eligible for automatic retry on the next sync pass, with
 * no local status change at all).
 *
 * [FIX — TRANSIENT CUSTOMER DEPENDENCY, this revision — restores a
 * regression] A single sync request can contain a brand-new walk-in
 * customer AND a sale/void/payment that references that same customer,
 * created moments apart on the same device (T4b's ordinary "create
 * customer, sell to them" flow). If that customer's own PASS 1 sync hit a
 * TRANSIENT error and exhausted all MAX_TX_ATTEMPTS retries, PASS 1
 * correctly records it as RETRY_LATER (per the FIX above) rather than
 * FAILED.
 *
 * But without this fix, nothing connects that outcome to the
 * invoice/payment that depends on it: when PASS 2/3 then calls
 * resolveTargetCustomerId() for the same offlineCustomerId, it correctly
 * finds no matching Customer row yet and throws the GENERIC "الزبون
 * المرتبط... غير موجود" error — which is NOT recognized by
 * isRetryableTxError() (it's not a deadlock/serialization message), so
 * the invoice/payment would be marked permanently FAILED even though the
 * only real problem is a passing, already-self-healing hiccup on an
 * unrelated row earlier in this SAME request. The next sync pass would
 * have synced the customer fine — but the invoice/payment that depended
 * on it would already be burned into FAILED and never retried.
 *
 * Fixed by tracking every offlineId that PASS 1 left RETRY_LATER
 * specifically because of a transient (retryable) error, in
 * `retryableCustomerOfflineIds`. resolveTargetCustomerId() now checks
 * this set before falling back to the generic "not found" error: if the
 * missing customer is in it, it throws the new `TransientDependencyError`
 * instead — which processInvoiceSyncItem and PASS 3's payment loop both
 * handle by recording the item as RETRY_LATER (never FAILED, never
 * silently dropped) rather than as a permanent failure. A customer that
 * is missing for any OTHER reason (never submitted, a genuinely bad id)
 * still falls through to the original generic error and is still marked
 * FAILED as before — this only changes behavior for the specific "my own
 * dependency is still mid-retry" case.
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
  quantity: z.coerce.number().refine((n) => n !== 0, {
    message: "الكمية يجب ألا تساوي صفر.",
  }),
  unitPriceSYP: z.string().min(1),
  unitPriceUSD: z.string().min(1).nullable(),
  batchId: z.string().min(1).optional(),
});

const offlineInvoiceSchema = z
  .object({
    offlineId: z.string().min(1),
    customerId: z.string().min(1).optional(),
    offlineCustomerId: z.string().min(1).optional(),
    items: z.array(offlineInvoiceItemSchema).min(1),
    totalSYP: z.string().min(1),
    totalUSD: z.string().min(1).nullable(),
    exchangeRateUsed: z.string().min(1).nullable(),
    paidAmountSYP: z.string().min(1),
    paidAmountUSD: z.string().min(1).nullable(),
    debtAmountSYP: z.string().min(1),
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

// Third status added (see RETRY_LATER FIX note above).
interface ItemResult {
  offlineId: string;
  status: "SYNCED" | "FAILED" | "RETRY_LATER";
  realId?: string;
  error?: string;
}

const TX_OPTIONS = { maxWait: 10_000, timeout: 20_000 } as const;
const MAX_TX_ATTEMPTS = 3;

// [FIX — TRANSIENT CUSTOMER DEPENDENCY] Thrown by resolveTargetCustomerId()
// specifically when the missing customer's OWN sync failed transiently in
// PASS 1 of this same request — handled by every caller as RETRY_LATER,
// never as a permanent FAILED result and never silently dropped.
class TransientDependencyError extends Error { }

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

// Shared, human-readable Arabic message for every RETRY_LATER push below —
// kept as one constant so the wording never drifts between the three passes.
const RETRY_LATER_MESSAGE =
  "تعارض مؤقت في قاعدة البيانات — سيُعاد المحاولة تلقائياً عند المزامنة التالية.";

// [FIX — TRANSIENT CUSTOMER DEPENDENCY] Dedicated message for the
// dependency-specific case, distinguishable in logs/UI from a raw DB
// conflict on the item's own transaction.
const RETRY_LATER_DEPENDENCY_MESSAGE =
  "بانتظار مزامنة الزبون المرتبط (تعارض مؤقت) — سيُعاد المحاولة تلقائياً عند المزامنة التالية.";

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

// [FIX — TRANSIENT CUSTOMER DEPENDENCY] New optional last parameter,
// `retryableCustomerOfflineIds` — see the file-header FIX note. Only
// changes behavior when the missing customer is a member of that set;
// every other call site/scenario is unchanged.
async function resolveTargetCustomerId(
  tx: Prisma.TransactionClient,
  tenantId: string,
  customerMap: Map<string, string>,
  refs: { offlineCustomerId?: string; customerId?: string },
  missingMessage: string,
  retryableCustomerOfflineIds?: Set<string>
): Promise<string> {
  if (refs.offlineCustomerId) {
    const mapped = customerMap.get(refs.offlineCustomerId);
    if (mapped) {
      // [v4.2] Auto-Redirect on Write: resolve active customer in case of merge
      return await resolveActiveCustomerId(tx, tenantId, mapped);
    }

    const matched = await tx.customer.findFirst({
      where: { offlineId: refs.offlineCustomerId, tenantId },
      select: { id: true },
    });
    if (matched) {
      // [v4.2] Auto-Redirect on Write: resolve active customer in case of merge
      const activeId = await resolveActiveCustomerId(tx, tenantId, matched.id);
      customerMap.set(refs.offlineCustomerId, activeId);
      return activeId;
    }

    // [FIX — TRANSIENT CUSTOMER DEPENDENCY] Not found — but if this
    // customer's own sync failed transiently in PASS 1 of THIS SAME
    // request, the right response is "try again next pass", not a
    // permanent failure.
    if (retryableCustomerOfflineIds?.has(refs.offlineCustomerId)) {
      throw new TransientDependencyError(
        `العميل المرتبط (${refs.offlineCustomerId}) لم تتم مزامنته بعد بسبب خطأ مؤقت — سيُعاد المحاولة تلقائياً.`
      );
    }
  } else if (refs.customerId) {
    const matched = await tx.customer.findFirst({
      where: { id: refs.customerId, tenantId },
      select: { id: true },
    });
    if (matched) {
      // [v4.2] Auto-Redirect on Write: resolve active customer in case of merge
      return await resolveActiveCustomerId(tx, tenantId, matched.id);
    }
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
  // [FIX — TRANSIENT CUSTOMER DEPENDENCY] Populated during PASS 1 below
  // whenever a customer's sync exhausts all retries on a TRANSIENT error
  // and is recorded RETRY_LATER — see the file-header FIX note.
  // resolveTargetCustomerId() consults this to distinguish "genuinely
  // missing" from "my dependency is mid-retry" for every invoice/payment
  // that references one of these offlineCustomerIds.
  const retryableCustomerOfflineIds = new Set<string>();

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
          `[sync] customer ${c.offlineId}: transient failure after ${MAX_TX_ATTEMPTS} attempts, marking RETRY_LATER`,
          err
        );
        // [FIX — TRANSIENT CUSTOMER DEPENDENCY] Record this offlineId so
        // any invoice/payment referencing it below is treated as
        // transiently blocked (RETRY_LATER), not permanently failed.
        retryableCustomerOfflineIds.add(c.offlineId);
        // [FIX — RETRY_LATER] Explicitly recorded — never silently
        // dropped — so `allResults.every(status === "SYNCED")` correctly
        // reflects that this pass did not fully succeed.
        customerResults.push({
          offlineId: c.offlineId,
          status: "RETRY_LATER",
          error: RETRY_LATER_MESSAGE,
        });
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
  // Split into two ORDERED SUB-PHASES (v4.1) — sales first, then voids.
  // ==========================================================================
  async function processInvoiceSyncItem(inv: InvoicePayload): Promise<void> {
    if (inv.voidsOfflineInvoiceId && userRole !== "ADMIN") {
      invoiceResults.push({
        offlineId: inv.offlineId,
        status: "FAILED",
        error: "عملية إلغاء الفاتورة متاحة فقط لحساب المدير (ADMIN).",
      });
      return;
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

          const totalUSD = convertCurrency(totalSYP, exchangeRateUsed, "SYP", "USD");
          const paidUSD = convertCurrency(paidSYP, exchangeRateUsed, "SYP", "USD");
          const debtUSD = convertCurrency(debtSYP, exchangeRateUsed, "SYP", "USD");

          const expectedDebtSYP = subtractMoney(totalSYP, paidSYP);
          if (compareMoney(expectedDebtSYP, debtSYP) !== 0) {
            throw new Error(
              "قيمة الدين بالليرة السورية لا تطابق الفرق بين إجمالي الفاتورة والمبلغ المدفوع."
            );
          }

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
            if (originalInvoice.status !== InvoiceStatus.COMPLETED) {
              throw new Error(
                "لا يمكن إلغاء إلا الفواتير المكتملة — الفواتير قيد المراجعة تُرفض عبر مسار الطلبات."
              );
            }

            const alreadyVoided = await tx.invoice.findFirst({
              where: { voidsInvoiceId: originalInvoice.id, tenantId },
              select: { id: true, offlineId: true },
            });
            if (alreadyVoided) {
              if (alreadyVoided.offlineId === inv.offlineId) {
                return alreadyVoided;
              }
              throw new Error("تم إلغاء هذه الفاتورة مسبقاً عبر مزامنة أخرى.");
            }

            interface OriginalBatchPortion {
              batchId: string;
              quantity: string;
              unitPriceSYP: string;
            }
            interface OriginalGroup {
              batches: OriginalBatchPortion[];
              totalQuantity: string;
            }

            const originalByProductUnit = new Map<string, OriginalGroup>();
            for (const item of originalInvoice.items) {
              const key = `${item.productId}::${item.unitId}`;
              const group = originalByProductUnit.get(key) ?? { batches: [], totalQuantity: "0" };
              group.batches.push({
                batchId: item.batchId,
                quantity: item.quantity.toString(),
                unitPriceSYP: item.unitPriceSYP.toString(),
              });
              group.totalQuantity = sumMoney([group.totalQuantity, item.quantity.toString()]);
              originalByProductUnit.set(key, group);
            }

            if (originalByProductUnit.size !== inv.items.length) {
              throw new Error(
                "عدد عناصر الإلغاء لا يطابق عدد المنتجات/الوحدات المختلفة بالفاتورة الأصلية."
              );
            }

            const matchedGroups = inv.items.map((voidItem) => {
              const key = `${voidItem.productId}::${voidItem.unitId}`;
              const group = originalByProductUnit.get(key);
              if (!group) {
                throw new Error(
                  `المنتج/الوحدة (${voidItem.productId}/${voidItem.unitId}) لا يطابق أي بند بالفاتورة الأصلية.`
                );
              }

              const priceMismatch = group.batches.some(
                (b) =>
                  compareMoney(serializeMoney(voidItem.unitPriceSYP), serializeMoney(b.unitPriceSYP)) !== 0
              );
              if (priceMismatch) {
                throw new Error(
                  `سعر عنصر الإلغاء (${voidItem.unitPriceSYP}) لا يطابق السعر الأصلي لـ ` +
                  `${voidItem.productId}/${voidItem.unitId}.`
                );
              }

              if (
                compareMoney(serializeMoney(Math.abs(voidItem.quantity)), group.totalQuantity) !== 0
              ) {
                throw new Error(
                  `كمية عنصر الإلغاء (${Math.abs(voidItem.quantity)}) لا تطابق الكمية الإجمالية الأصلية ` +
                  `(${group.totalQuantity}) لـ ${voidItem.productId}/${voidItem.unitId} — الإلغاء يجب ` +
                  "أن يكون استرجاعاً كاملاً، أي تصحيح جزئي يُسجَّل كدفعة (CustomerPayment) بدلاً من إلغاء."
                );
              }

              return {
                productId: voidItem.productId,
                unitId: voidItem.unitId,
                group,
                unitPriceSYP: serializeMoney(voidItem.unitPriceSYP),
                unitPriceUSD: convertCurrency(
                  serializeMoney(voidItem.unitPriceSYP),
                  exchangeRateUsed,
                  "SYP",
                  "USD"
                ),
              };
            });

            const expectedVoidTotalSYP = subtractMoney("0", originalInvoice.totalSYP.toString());
            const expectedVoidPaidSYP = subtractMoney("0", originalInvoice.paidAmountSYP.toString());
            const expectedVoidDebtSYP = subtractMoney("0", originalInvoice.debtAmountSYP.toString());

            if (compareMoney(totalSYP, expectedVoidTotalSYP) !== 0) {
              throw new Error(
                `إجمالي فاتورة الإلغاء (${totalSYP}) لا يساوي سالب إجمالي الفاتورة الأصلية (${expectedVoidTotalSYP}).`
              );
            }
            if (compareMoney(paidSYP, expectedVoidPaidSYP) !== 0) {
              throw new Error(
                `المبلغ المدفوع بفاتورة الإلغاء (${paidSYP}) لا يساوي سالب المبلغ المدفوع بالفاتورة الأصلية (${expectedVoidPaidSYP}).`
              );
            }
            if (compareMoney(debtSYP, expectedVoidDebtSYP) !== 0) {
              throw new Error(
                `قيمة الدين بفاتورة الإلغاء (${debtSYP}) لا تساوي سالب قيمة الدين بالفاتورة الأصلية (${expectedVoidDebtSYP}).`
              );
            }

            const targetCustomerId = await resolveActiveCustomerId(
              tx,
              tenantId,
              originalInvoice.customerId
            );

            const batchAdjustments: Array<{ batchId: string; qtyToRestore: string }> = [];
            for (const matched of matchedGroups) {
              const soldUnitFactor = await getUnitConversionFactor(tx, tenantId, matched.unitId);
              for (const portion of matched.group.batches) {
                const qtyToRestore = toBaseUnit(portion.quantity, soldUnitFactor).toFixed(4);
                batchAdjustments.push({ batchId: portion.batchId, qtyToRestore });
              }
            }

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
                isPaid: originalInvoice.isPaid,
                status: InvoiceStatus.VOIDED,
                offlineId: inv.offlineId,
                syncedAt: new Date(),
                voidsInvoiceId: originalInvoice.id,
                voidReason: inv.voidReason,
                createdAt: new Date(inv.createdAt),
              },
              select: { id: true },
            });

            for (const matched of matchedGroups) {
              for (const portion of matched.group.batches) {
                await tx.invoiceItem.create({
                  data: {
                    tenantId,
                    invoiceId: voidInvoice.id,
                    productId: matched.productId,
                    unitId: matched.unitId,
                    batchId: portion.batchId,
                    quantity: subtractMoney("0", portion.quantity),
                    unitPriceSYP: matched.unitPriceSYP,
                    unitPriceUSD: matched.unitPriceUSD,
                  },
                });
              }
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
            "الزبون المرتبط بهذه الفاتورة غير موجود.",
            // [FIX — TRANSIENT CUSTOMER DEPENDENCY]
            retryableCustomerOfflineIds
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

          const productIdsInInvoice = [...new Set(inv.items.map((it) => it.productId))];
          await lockBatchesForFifoAllocations(tx, tenantId, productIdsInInvoice);

          for (const item of inv.items) {
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
            const baseQtyRequested = toBaseUnit(item.quantity, soldUnitFactor);

            const resolution = await commitFifoAllocation(tx, {
              tenantId,
              productId: item.productId,
              unitId: baseUnit.id,
              requestedQty: baseQtyRequested.toString(),
            });

            if (resolution.allocations.length === 0) {
              throw new Error(`لا توجد أي دفعة متاحة لـ ${item.productId}/${item.unitId}.`);
            }

            const itemUnitPriceUSD = convertCurrency(
              serializeMoney(item.unitPriceSYP),
              exchangeRateUsed,
              "SYP",
              "USD"
            );

            for (const alloc of resolution.allocations) {
              const soldQtyForAlloc = fromBaseUnit(alloc.allocatedQty, soldUnitFactor);
              resolvedAllocations.push({
                productId: item.productId,
                unitId: item.unitId,
                batchId: alloc.batchId,
                unitPriceSYP: serializeMoney(item.unitPriceSYP),
                unitPriceUSD: itemUnitPriceUSD,
                quantitySold: soldQtyForAlloc.toFixed(4),
                deductQtyInBaseUnit: alloc.allocatedQty,
              });
            }

            if (!resolution.isSufficient && compareMoney(resolution.remainingQty, 0) > 0) {
              const last = resolution.allocations[resolution.allocations.length - 1];
              const remainingSoldQty = fromBaseUnit(resolution.remainingQty, soldUnitFactor);

              resolvedAllocations.push({
                productId: item.productId,
                unitId: item.unitId,
                batchId: last.batchId,
                unitPriceSYP: serializeMoney(item.unitPriceSYP),
                unitPriceUSD: itemUnitPriceUSD,
                quantitySold: remainingSoldQty.toFixed(4),
                deductQtyInBaseUnit: resolution.remainingQty,
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
                quantity: alloc.quantitySold,
                unitPriceSYP: alloc.unitPriceSYP,
                unitPriceUSD: alloc.unitPriceUSD,
              },
            });
          }

          for (const alloc of resolvedAllocations) {
            await tx.productBatch.update({
              where: { id: alloc.batchId, tenantId },
              data: { quantity: { decrement: alloc.deductQtyInBaseUnit } },
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
          return;
        }
      }
      // [FIX — TRANSIENT CUSTOMER DEPENDENCY] Recorded as RETRY_LATER —
      // never FAILED, and never silently dropped (see the earlier
      // RETRY_LATER regression this restores against).
      if (err instanceof TransientDependencyError) {
        console.error(
          `[sync] invoice ${inv.offlineId}: blocked on a customer still mid-retry, marking RETRY_LATER`,
          err
        );
        invoiceResults.push({
          offlineId: inv.offlineId,
          status: "RETRY_LATER",
          error: RETRY_LATER_DEPENDENCY_MESSAGE,
        });
        return;
      }
      if (isRetryableTxError(err)) {
        console.error(
          `[sync] invoice ${inv.offlineId}: transient failure after ${MAX_TX_ATTEMPTS} attempts, marking RETRY_LATER`,
          err
        );
        invoiceResults.push({
          offlineId: inv.offlineId,
          status: "RETRY_LATER",
          error: RETRY_LATER_MESSAGE,
        });
        return;
      }
      invoiceResults.push({
        offlineId: inv.offlineId,
        status: "FAILED",
        error: errorMessage(err, "فشل في مزامنة الفاتورة."),
      });
    }
  }

  // Sub-phase A — every non-void (sale) invoice.
  const saleInvoices = (invoices as InvoicePayload[]).filter(
    (inv) => !inv.voidsOfflineInvoiceId
  );
  for (const inv of saleInvoices) {
    await processInvoiceSyncItem(inv);
  }

  // Sub-phase B — every void, only after ALL sales above have been attempted.
  const voidInvoices = (invoices as InvoicePayload[]).filter(
    (inv) => inv.voidsOfflineInvoiceId
  );
  for (const inv of voidInvoices) {
    await processInvoiceSyncItem(inv);
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
            "الزبون المرتبط بهذه الدفعة غير موجود.",
            // [FIX — TRANSIENT CUSTOMER DEPENDENCY]
            retryableCustomerOfflineIds
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
      // [FIX — TRANSIENT CUSTOMER DEPENDENCY] See processInvoiceSyncItem's
      // identical branch above and the file-header FIX note.
      if (err instanceof TransientDependencyError) {
        console.error(
          `[sync] payment ${p.offlineId}: blocked on a customer still mid-retry, marking RETRY_LATER`,
          err
        );
        paymentResults.push({
          offlineId: p.offlineId,
          status: "RETRY_LATER",
          error: RETRY_LATER_DEPENDENCY_MESSAGE,
        });
        continue;
      }
      if (isRetryableTxError(err)) {
        console.error(
          `[sync] payment ${p.offlineId}: transient failure after ${MAX_TX_ATTEMPTS} attempts, marking RETRY_LATER`,
          err
        );
        paymentResults.push({
          offlineId: p.offlineId,
          status: "RETRY_LATER",
          error: RETRY_LATER_MESSAGE,
        });
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
  // No change needed to this line itself — now that every RETRY_LATER
  // item (including the dependency-triggered ones) is actually present
  // in its results array, `.every()` correctly evaluates to false
  // whenever one exists.
  const success = allResults.every((r) => r.status === "SYNCED");

  return NextResponse.json({
    success,
    customers: customerResults,
    invoices: invoiceResults,
    payments: paymentResults,
  });
}