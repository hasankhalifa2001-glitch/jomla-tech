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
import { tenantScopedRawQuery, type TxOrClient } from "@/lib/db/tenant-scope";
import { commitFifoAllocation } from "@/lib/inventory/fifo";
import { lockBatchesForFifoAllocations } from "@/lib/inventory/batch-locking";
import { requireBaseUnit, MissingBaseUnitError } from "@/lib/inventory/base-unit";
import { getUnitConversionFactor, toBaseUnit, fromBaseUnit } from "@/lib/inventory/units";
import {
  compareMoney,
  deriveUsd,
  negateNullableMoney,
  subtractMoney,
  serializeMoney,
  multiplyMoney,
  sumMoney,
  MoneyError,
} from "@/lib/utils/money";
import { resolveActiveCustomerId } from "@/lib/customers/resolve-active";
// [T4e] The ONE repayment core — this route's Payment pass and
// POST /api/ledger/repayments both call recordRepaymentIdempotent.
import { recordRepaymentIdempotent } from "@/lib/ledger/repayment";
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
 * [FIX — TRANSIENT CUSTOMER DEPENDENCY, prior revision — restores a
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
 *
 * [FIX — CONNECTION-LEVEL ERRORS, prior revision — closes a real
 * misclassification bug] isRetryableTxError() previously recognized ONLY
 * transaction write-conflict errors (Prisma code P2034, and
 * deadlock/serialization messages) as retryable. It had NO awareness of a
 * raw database CONNECTION failure — the connection pool losing its link to
 * Postgres mid-request, a brief network blip between this server and the
 * database, or Postgres itself closing an established/idle connection
 * ("Server has closed the connection", observed in production; see the
 * accompanying client-side sync-worker.ts fix note for the exact symptom).
 *
 * That is an INFRASTRUCTURE problem, not a problem with the invoice/
 * customer/payment DATA being synced — yet it fell through to the generic
 * branch in every catch block below and was recorded as a permanent
 * "FAILED" after a single attempt (withTxRetries only retries when this
 * function returns true). Per this route's own documented per-item
 * semantics (see the client's sync-worker.ts header), FAILED is NEVER
 * automatically retried — so a perfectly valid invoice with zero actual
 * data problem could get stuck FAILED forever purely because of a passing
 * network hiccup.
 *
 * FIX: isRetryableTxError() now ALSO recognizes:
 *   - Prisma error codes P1001 (can't reach database server), P1002 (the
 *     database server was reached but timed out), P1008 (operation
 *     timed out), and P1017 (server has closed the connection) — all
 *     surfaced as Prisma.PrismaClientKnownRequestError.
 *   - Prisma.PrismaClientInitializationError — the client couldn't even
 *     (re-)establish a connection to the database at all.
 *   - A message-based fallback covering P2024 (connection-pool timeout,
 *     which doesn't always surface as a typed error depending on engine
 *     version) and common raw driver-level connection-loss phrases.
 *
 * Any of these now correctly triggers a retry inside withTxRetries() (up
 * to MAX_TX_ATTEMPTS) and, if still failing after that, is recorded as
 * RETRY_LATER instead of FAILED — exactly the same treatment as the
 * existing deadlock/serialization case, with no other behavior change.
 *
 * ============================================================================
 * [v4.8 FIXES — found in manual testing of the sync + void flow]
 *
 * (1) QUANTITY DRIFT ON SPLIT SALES — InvoiceItem.baseQuantity.
 * A sale of 1 طرد (factor 24) allocated 20 pieces from batch A and 4 from
 * batch B used to be stored as two rows whose `quantity` (sale unit) was
 * derived by DIVIDING: 20/24 = 0.8333 and 4/24 = 0.1667. A void multiplied
 * them back (x24) and restored 19.9992 / 4.0008 — the very "21.9984 قطعة"
 * error v4.0 was meant to kill — and a full void of an 8/8/8 split could
 * never match "void quantity == original quantity". Every InvoiceItem now
 * ALSO stores `baseQuantity`: the exact base-unit amount deducted from its
 * batch, copied straight from the FIFO allocation (never divided). `quantity`
 * is display-only from here on. A void restores `baseQuantity` as-is and the
 * "is it a full reversal" check compares SUM(baseQuantity) per product/unit.
 *
 * (2) PER-ITEM STOCK DEDUCTION (same-product lines in one cart).
 * commitFifoAllocation() only READS batches. The sale path used to run it for
 * EVERY cart line first and apply all decrements afterwards, so two lines of
 * the same product (e.g. 1 طرد + 5 قطع) both planned against the SAME
 * snapshot: both drew from batch A, driving A to -5 while B stayed untouched.
 * The decrement for each line is now applied immediately after that line is
 * planned, inside the same transaction, so the next line plans against the
 * updated quantities.
 *
 * (3) SHORTFALL POLICY — a sale that already happened physically is never
 * rejected for lack of recorded stock. Any quantity the positive batches
 * cannot cover is booked on an "overdraw" batch (the last batch the FIFO plan
 * drew from, or the newest batch when none had stock), which goes negative
 * and surfaces under T3c's "يحتاج تسوية" filter. The only hard failure left is
 * a product with no batch at all.
 *
 * (4) VOID DEPENDENCY ON A RETRY_LATER SALE. A void whose original sale is
 * RETRY_LATER in this same request used to fail with a generic error
 * (permanent FAILED). It now throws TransientDependencyError -> RETRY_LATER,
 * the same treatment the customer dependency already gets.
 *
 * (5) ACTOR ATTRIBUTION. Invoice.userId used to be whoever happened to run the
 * sync, so a sale queued by cashier A and synced while admin B was logged in
 * on the same device was attributed to B (breaking the cashier's own sales
 * log and the void/payment role gates). Items may now carry `createdByUserId`
 * (client: store it in Dexie when the record is queued). The server NEVER
 * trusts a client-sent role: it looks the creator up in the database
 * (same tenant) and uses THAT role. A non-ADMIN session may only sync records
 * it created itself — anything else is RETRY_LATER (it syncs the next time its
 * creator or an ADMIN runs the sync) instead of a permanent FAILED. Records
 * without createdByUserId keep the previous behaviour (session user).
 *
 * (6) P2002 on Invoice.voidsInvoiceId (a racing second void) now returns a
 * clear Arabic FAILED reason instead of leaking the raw Prisma message.
 * (7) Quantities are parsed as decimal strings (never native numbers), and
 * requestedQty is passed to FIFO as toFixed(4), never toString() (which can
 * produce exponent notation).
 * ============================================================================
 *
 * ============================================================================
 * [v4.9 FIXES]
 *
 * (1) VOID USD ZERO-SUM. The void path used to derive totalUSD / paidUSD /
 * debtUSD and every item's unitPriceUSD from the payload's exchangeRateUsed
 * (or, when null, from the tenant's CURRENT daily rate). If the rate changed
 * between the sale and the void, (original + void) summed to zero in SYP but
 * NOT in USD. The void now copies exchangeRateUsed and every USD figure from
 * the ORIGINAL invoice (negated via negateNullableMoney, item unit prices
 * copied verbatim) — identical to POST /api/ledger/voids. Void math is
 * SYP-authoritative, so the payload's own USD fields/rate are ignored.
 *
 * (2) NULLABLE USD ON SALES (schema v4.9). A sale never substitutes the
 * tenant's CURRENT daily rate for a null payload rate and never fails for a
 * missing rate: exchangeRateUsed and every derived USD field (invoice,
 * items, payment) are persisted as NULL, via deriveUsd() only. A rate that
 * is present but not usable (<= 0) is treated exactly like a missing one
 * (null), never stored as a sentinel and never a reason to reject the
 * record. A void copies exchangeRateUsed from the ORIGINAL invoice and
 * negates its stored USD (null stays null) via negateNullableMoney(), so
 * (original + void) is zero in USD whenever USD exists. Rate resolution
 * lives in the SALE path only; the shared SYP checks (debt = total − paid,
 * total = Σ items) run first for both paths.
 *
 * (3) paymentMethod VALIDATION STAYS PER-ITEM (reverses an earlier v4.9
 * draft). A request-level zod .refine() on "paid > 0 requires paymentMethod"
 * rejects the WHOLE request with 400, so one malformed record stuck in a
 * device's Dexie queue would block every record queued behind it, forever
 * (a poison pill). The check inside the transaction is the authority: it
 * rolls back that single invoice (stock deduction included) and reports it
 * as FAILED while the rest of the batch syncs normally.
 * NOTE: the three remaining request-level refine()s (customer reference,
 * voidReason, quantity sign) carry the same whole-request-rejection risk;
 * that is an older design decision, left as is.
 *
 * (4) VOID ITEM GROUPING. Original items are grouped by productId::unitId,
 * but the void payload's items were compared one-to-one: a payload listing
 * the same product/unit twice (e.g. the cashier added it as two cart lines)
 * could pass the count check while restoring one group twice and another not
 * at all. Void payload items are now merged by the same key (quantities
 * summed, differing unit prices rejected) before being compared with the
 * original groups.
 *
 * (5) SALE-ONLY SANITY BOUNDS. For a sale, paid and debt must be >= 0 and
 * unit prices must be >= 0 (the shared debt = total − paid check alone let a
 * tampered payload with negative paid / inflated debt through).
 *
 * (6) createdAt VALIDATION IS PER-ITEM, NOT REQUEST-LEVEL (revised — an
 * earlier v4.9 draft put a zod .refine() on it, which rejected the WHOLE
 * request with 400 for one corrupt date: the same poison-pill failure mode
 * as (3)). The zod field is a plain non-empty string. An unparseable date is
 * checked per item (customers, invoices, payments): THAT item is reported
 * FAILED with an Arabic reason and every other record in the request syncs
 * normally. sortByCreatedAt() is NaN-safe: an item with an unparseable date
 * sorts last instead of corrupting the comparator.
 *
 * (7) PAYMENTS WITHOUT A RATE. offlinePaymentSchema.amountUSD and
 * exchangeRate are nullable: a repayment recorded while no exchange rate
 * existed is accepted (it used to be rejected by the schema, failing the
 * WHOLE request with 400 and blocking every record queued behind it).
 * recordRepaymentIdempotent receives frozenRate = null in that case and
 * must persist amountUSD/exchangeRate as NULL.
 *
 * (8) RETRY CLASSIFICATION BY CODE, NOT BY BARE NUMBERS. isRetryableTxError()
 * used to match the bare tokens "40001" / "40P01" anywhere in the error
 * MESSAGE. Validation messages on this route embed amounts (for example
 * "... (140001.0000) ..."), which matched /40001/, so a plain data error was
 * treated as a transient DB conflict: retried, then parked as RETRY_LATER
 * forever instead of FAILED. Postgres SQLSTATE 40001 / 40P01 are now
 * recognized ONLY through the structured error (raw-query failures surface
 * as Prisma code P2010 with meta.code = the SQLSTATE; write conflicts as
 * P2034). The message fallback keeps only unambiguous phrases.
 *
 * (9) ABSENT USD KEYS ARE NULL. The optional USD/rate fields are
 * .nullish().transform(v => v ?? null) (and an empty/blank string is also
 * null): a payload that omits the key — JSON.stringify drops undefined, and
 * records queued before this fix may lack it — used to fail zod and reject
 * the whole request with 400. These fields are informational on the server
 * (USD is always re-derived via deriveUsd; a void copies the original), so
 * absent == null is the only sensible reading.
 * ============================================================================
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

// [v4.9] createdAt: plain non-empty string at the schema level. Date
// validity is checked PER ITEM (see header FIX 6) so one corrupt date can
// never reject the whole request.
const createdAtString = z.string().min(1);

// [v4.9] Optional USD / rate field: an absent key, null, or blank string all
// mean "no value" and normalize to null (see header FIX 9).
const nullableMoneyString = z
  .string()
  .nullish()
  .transform((v) => (v && v.trim() !== "" ? v : null));

// [v4.8] Quantities arrive as a decimal string OR (legacy clients) a JS
// number; both are normalized to a serialized decimal STRING here so no
// native number ever reaches money/unit arithmetic below.
const quantityString = z
  .union([z.string().min(1), z.number()])
  .transform((v, ctx) => {
    try {
      return serializeMoney(v);
    } catch {
      ctx.addIssue({ code: "custom", message: "كمية غير صالحة." });
      return z.NEVER;
    }
  })
  .refine((q) => compareMoney(q, 0) !== 0, {
    message: "الكمية يجب ألا تساوي صفر.",
  });

const offlineInvoiceItemSchema = z.object({
  productId: z.string().min(1),
  unitId: z.string().min(1),
  quantity: quantityString,
  unitPriceSYP: z.string().min(1),
  unitPriceUSD: nullableMoneyString,
  batchId: z.string().min(1).optional(),
});

const offlineInvoiceSchema = z
  .object({
    offlineId: z.string().min(1),
    customerId: z.string().min(1).optional(),
    offlineCustomerId: z.string().min(1).optional(),
    items: z.array(offlineInvoiceItemSchema).min(1),
    totalSYP: z.string().min(1),
    totalUSD: nullableMoneyString,
    exchangeRateUsed: nullableMoneyString,
    paidAmountSYP: z.string().min(1),
    paidAmountUSD: nullableMoneyString,
    debtAmountSYP: z.string().min(1),
    debtAmountUSD: nullableMoneyString,
    paymentMethod: paymentMethodEnum.optional(),
    voidsOfflineInvoiceId: z.string().min(1).optional(),
    voidReason: z.string().min(1).optional(),
    // [v4.8] Who created this record on the device (see FIX 5). Optional for
    // backward compatibility with clients that don't send it yet.
    createdByUserId: z.string().min(1).optional(),
    createdAt: createdAtString,
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
      return v.items.every((it) =>
        isVoid ? compareMoney(it.quantity, 0) < 0 : compareMoney(it.quantity, 0) > 0
      );
    },
    {
      message:
        "إشارة الكمية غير صحيحة: يجب أن تكون كل الكميات موجبة في فاتورة بيع، " +
        "وسالبة بالكامل في فاتورة إلغاء.",
      path: ["items"],
    }
  );
// [v4.9] NOTE: there is deliberately NO request-level refine for
// "paidAmountSYP > 0 requires paymentMethod" — see header FIX (3). That rule
// is enforced per-item inside the transaction (FAILED for that invoice only).

const offlinePaymentSchema = z
  .object({
    offlineId: z.string().min(1),
    customerId: z.string().min(1).optional(),
    offlineCustomerId: z.string().min(1).optional(),
    amountSYP: z.string().min(1),
    // [v4.9] NULLABLE — a repayment recorded while no exchange rate existed
    // carries null (or omits the key) for both (see header FIX 7 and 9).
    // Never a sentinel 0/1.
    amountUSD: nullableMoneyString,
    exchangeRate: nullableMoneyString,
    paymentMethod: paymentMethodEnum,
    receiptNo: z.string().optional(),
    notes: z.string().optional(),
    // [v4.8] see offlineInvoiceSchema.createdByUserId
    createdByUserId: z.string().min(1).optional(),
    createdAt: createdAtString,
  })
  .refine((v) => Boolean(v.customerId) !== Boolean(v.offlineCustomerId), {
    message: "يجب توفير customerId أو offlineCustomerId، وليس كليهما أو لا شيء.",
  });

const offlineCustomerSchema = z.object({
  offlineId: z.string().min(1),
  name: z.string().min(1),
  phone: z.string().optional(),
  shopName: z.string().optional(),
  createdAt: createdAtString,
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

type ActorRole = "ADMIN" | "CASHIER";
type ActorResolution =
  | { kind: "ok"; actor: { userId: string; role: ActorRole } }
  | { kind: "deferred" }
  | { kind: "invalid" };

const TX_OPTIONS = { maxWait: 10_000, timeout: 20_000 } as const;
const MAX_TX_ATTEMPTS = 3;

// [FIX — TRANSIENT CUSTOMER DEPENDENCY] Thrown by resolveTargetCustomerId()
// specifically when the missing customer's OWN sync failed transiently in
// PASS 1 of this same request — handled by every caller as RETRY_LATER,
// never as a permanent FAILED result and never silently dropped.
// [v4.8] Also thrown for a void whose original sale is RETRY_LATER.
class TransientDependencyError extends Error { }

function isUniqueConflict(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

// [v4.8] A P2002 is only "the same constraint" when its structured target
// says so — never a substring match on the message.
function uniqueTargetIncludes(err: unknown, field: string): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === "P2002" &&
    Array.isArray(err.meta?.target) &&
    (err.meta.target as string[]).includes(field)
  );
}

// [FIX — CONNECTION-LEVEL ERRORS] See the file-header FIX note for the
// full rationale. Recognizes both transaction write-conflicts (the
// original P2034/deadlock/serialization case) AND raw database
// connection failures (new) as retryable — the latter being an
// infrastructure hiccup, never a data problem with the item being synced.
//
// [v4.9 FIX 8] Postgres SQLSTATE codes (40001 serialization_failure,
// 40P01 deadlock_detected) are recognized ONLY via the structured Prisma
// error, never as bare numbers inside the message text: validation messages
// on this route embed amounts ("(140001.0000)"), and a bare /40001/ match
// turned plain data errors into endless RETRY_LATER.
function isRetryableTxError(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    // P2034: write conflict / deadlock, reported by the query engine's own
    //        "please retry this transaction" mechanism.
    // P1001: the database server could not be reached at all.
    // P1002: the database server was reached but the connection timed out.
    // P1008: an operation on the database timed out.
    // P1017: the server closed an established connection
    //        ("Server has closed the connection").
    if (["P2034", "P1001", "P1002", "P1008", "P1017"].includes(err.code)) {
      return true;
    }
    // P2010: a RAW query failed; the underlying Postgres SQLSTATE is in
    // meta.code. 40001 = serialization failure, 40P01 = deadlock detected.
    if (err.code === "P2010") {
      const sqlState = (err.meta as { code?: unknown } | undefined)?.code;
      if (sqlState === "40001" || sqlState === "40P01") {
        return true;
      }
    }
  }
  // The Prisma client failed to even establish/re-establish a connection
  // to the database at all — always transient from this route's
  // perspective, never a reason to burn the item into permanent FAILED.
  if (err instanceof Prisma.PrismaClientInitializationError) {
    return true;
  }
  const message = err instanceof Error ? err.message : String(err);
  // Message fallback: unambiguous phrases only — NO bare numeric tokens.
  return /deadlock detected|could not serialize|P2024|server has closed the connection|connection terminated|connection reset|econnreset|etimedout|timed out fetching a new connection|can't reach database server/i.test(
    message
  );
}

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof MoneyError || err instanceof Error) return err.message;
  return fallback;
}

// [v4.8] |q| for a serialized decimal string, via money.ts only.
function absQty(q: string): string {
  return compareMoney(q, 0) < 0 ? subtractMoney("0", q) : q;
}

// Shared, human-readable Arabic message for every RETRY_LATER push below —
// kept as one constant so the wording never drifts between the three passes.
const RETRY_LATER_MESSAGE =
  "تعارض مؤقت في قاعدة البيانات — سيُعاد المحاولة تلقائياً عند المزامنة التالية.";

// [FIX — TRANSIENT CUSTOMER DEPENDENCY] Dedicated message for the
// dependency-specific case, distinguishable in logs/UI from a raw DB
// conflict on the item's own transaction. [v4.8] Now also covers a void
// waiting on its original sale.
const RETRY_LATER_DEPENDENCY_MESSAGE =
  "بانتظار مزامنة عنصر مرتبط (زبون أو الفاتورة الأصلية) بسبب تعارض مؤقت — سيُعاد المحاولة تلقائياً عند المزامنة التالية.";

// [v4.8] The record was created under another user's account and this
// (non-ADMIN) session may not sync it on their behalf.
const RETRY_LATER_ACTOR_MESSAGE =
  "هذه العملية أُنشئت بحساب مستخدم آخر — ستتم مزامنتها عند دخول صاحبها أو حساب مدير.";

// [v4.9 FIX 6] Per-item rejection for an unparseable createdAt.
const INVALID_CREATED_AT_MESSAGE = "تاريخ إنشاء العملية غير صالح.";

// [v4.9 FIX 6] createdAt is validated PER ITEM (never at the zod/request
// level), so one corrupt date fails only its own record.
function isParseableDate(s: string): boolean {
  return !Number.isNaN(Date.parse(s));
}

// [v4.9 FIX 6] NaN-safe ordering: an unparseable date sorts LAST (the item
// will be reported FAILED anyway) instead of poisoning the comparator.
function sortKey(s: string): number {
  const t = Date.parse(s);
  return Number.isNaN(t) ? Number.MAX_SAFE_INTEGER : t;
}

function sortByCreatedAt<T extends { createdAt: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const ta = sortKey(a.createdAt);
    const tb = sortKey(b.createdAt);
    return ta < tb ? -1 : ta > tb ? 1 : 0;
  });
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
  tx: TxOrClient,
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
  const userRole = session.user.role as ActorRole;

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
  // [v4.8] Same idea for SALES: a void whose original sale is RETRY_LATER in
  // this request waits (RETRY_LATER) instead of failing permanently.
  const retryableInvoiceOfflineIds = new Set<string>();

  const customerResults: ItemResult[] = [];
  const invoiceResults: ItemResult[] = [];
  const paymentResults: ItemResult[] = [];

  // [v4.8] Actor resolution (FIX 5). The creator's role always comes from the
  // DATABASE, never from the payload.
  const actorCache = new Map<string, { id: string; role: ActorRole } | null>();
  async function resolveActor(createdByUserId?: string): Promise<ActorResolution> {
    if (!createdByUserId || createdByUserId === userId) {
      return { kind: "ok", actor: { userId, role: userRole } };
    }
    // A non-ADMIN session may only sync its own records.
    if (userRole !== "ADMIN") return { kind: "deferred" };

    if (!actorCache.has(createdByUserId)) {
      const found = await prisma.user.findFirst({
        where: { id: createdByUserId, tenantId },
        select: { id: true, role: true },
      });
      actorCache.set(
        createdByUserId,
        found ? { id: found.id, role: found.role as ActorRole } : null
      );
    }
    const cached = actorCache.get(createdByUserId);
    return cached
      ? { kind: "ok", actor: { userId: cached.id, role: cached.role } }
      : { kind: "invalid" };
  }

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
    // [v4.9 FIX 6] Per-item date validation — fails THIS customer only.
    if (!isParseableDate(c.createdAt)) {
      customerResults.push({
        offlineId: c.offlineId,
        status: "FAILED",
        error: INVALID_CREATED_AT_MESSAGE,
      });
      continue;
    }

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
  //
  // [v4.4] BOTH sub-phases independently call resolveActiveCustomerId():
  //   - the non-void pass resolves through resolveTargetCustomerId() below,
  //     whose three mapped/matched branches each route through the helper;
  //   - the void pass resolves its own originalInvoice.customerId directly.
  // Neither reuses a value the other resolved — each resolves FRESH inside its
  // own transaction, because a customer merge can complete in the narrow gap
  // between the two sub-phases of a single batch. Carrying a value over would
  // land the void on a deactivated, merged-away customer and split that
  // customer's ledger in two.
  // ==========================================================================
  async function processInvoiceSyncItem(inv: InvoicePayload): Promise<void> {
    const isVoidItem = Boolean(inv.voidsOfflineInvoiceId);

    // [v4.9 FIX 6] Per-item date validation — fails THIS invoice only.
    if (!isParseableDate(inv.createdAt)) {
      invoiceResults.push({
        offlineId: inv.offlineId,
        status: "FAILED",
        error: INVALID_CREATED_AT_MESSAGE,
      });
      return;
    }

    try {
      // [v4.8] Who created this record (FIX 5).
      const resolvedActor = await resolveActor(inv.createdByUserId);
      if (resolvedActor.kind === "deferred") {
        if (!isVoidItem) retryableInvoiceOfflineIds.add(inv.offlineId);
        invoiceResults.push({
          offlineId: inv.offlineId,
          status: "RETRY_LATER",
          error: RETRY_LATER_ACTOR_MESSAGE,
        });
        return;
      }
      if (resolvedActor.kind === "invalid") {
        invoiceResults.push({
          offlineId: inv.offlineId,
          status: "FAILED",
          error: "المستخدم الذي أنشأ هذه العملية غير موجود في هذا المتجر.",
        });
        return;
      }
      const actor = resolvedActor.actor;

      if (isVoidItem && actor.role !== "ADMIN") {
        invoiceResults.push({
          offlineId: inv.offlineId,
          status: "FAILED",
          error: "عملية إلغاء الفاتورة متاحة فقط لحساب المدير (ADMIN).",
        });
        return;
      }

      const { id } = await withTxRetries(() =>
        prisma.$transaction(async (tx) => {
          const existing = await tx.invoice.findFirst({
            where: { offlineId: inv.offlineId, tenantId },
            select: { id: true },
          });
          if (existing) return existing;

          // ---- SYP checks shared by sale AND void -----------------------
          // [v4.9] Only SYP-authoritative checks run here. Exchange-rate
          // resolution and every USD computation moved into the SALE path
          // below (a void copies USD from the original invoice instead).
          const totalSYP = serializeMoney(inv.totalSYP);
          const paidSYP = serializeMoney(inv.paidAmountSYP);
          const debtSYP = serializeMoney(inv.debtAmountSYP);

          const expectedDebtSYP = subtractMoney(totalSYP, paidSYP);
          if (compareMoney(expectedDebtSYP, debtSYP) !== 0) {
            throw new Error(
              "قيمة الدين بالليرة السورية لا تطابق الفرق بين إجمالي الفاتورة والمبلغ المدفوع."
            );
          }

          const isVoid = Boolean(inv.voidsOfflineInvoiceId);

          // [v4.9 FIX 5] Sale-only sanity bounds. debt = total − paid alone
          // lets a tampered payload through (paid = -500, debt = total + 500,
          // or a negative unit price). debt < 0 means paid > total; if
          // over-payment (customer credit) is ever a supported scenario,
          // drop ONLY the debt condition below.
          if (!isVoid) {
            if (compareMoney(paidSYP, 0) < 0 || compareMoney(debtSYP, 0) < 0) {
              throw new Error("المبلغ المدفوع أو الدين لا يمكن أن يكون سالباً في فاتورة بيع.");
            }
            if (inv.items.some((it) => compareMoney(serializeMoney(it.unitPriceSYP), 0) < 0)) {
              throw new Error("سعر الوحدة لا يمكن أن يكون سالباً.");
            }
          }

          const computedItemsTotalSYP = sumMoney(
            inv.items.map((item) => multiplyMoney(absQty(item.quantity), item.unitPriceSYP))
          );
          const expectedTotalSYP = isVoid
            ? subtractMoney("0", computedItemsTotalSYP)
            : computedItemsTotalSYP;
          if (compareMoney(expectedTotalSYP, totalSYP) !== 0) {
            throw new Error(
              `إجمالي الفاتورة بالليرة السورية (${totalSYP}) لا يطابق مجموع البنود (${expectedTotalSYP}).`
            );
          }

          if (isVoid) {
            // ---- VOID PATH -----------------------------------------------
            const originalInvoice = await tx.invoice.findFirst({
              where: { offlineId: inv.voidsOfflineInvoiceId, tenantId },
              include: { items: true },
            });
            if (!originalInvoice) {
              // [v4.8] FIX 4 — the original sale is only mid-retry in this
              // request: wait for it instead of failing permanently.
              if (retryableInvoiceOfflineIds.has(inv.voidsOfflineInvoiceId as string)) {
                throw new TransientDependencyError(
                  `الفاتورة الأصلية (${inv.voidsOfflineInvoiceId}) لم تتم مزامنتها بعد بسبب خطأ مؤقت — سيُعاد المحاولة تلقائياً.`
                );
              }
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
              // [v4.8] sale-unit quantity — DISPLAY ONLY (negated onto the
              // void row for receipts); never converted back into base units.
              quantity: string;
              // [v4.8] the EXACT base-unit amount that was deducted from
              // batchId at sale time. This — not `quantity` — is what the
              // void restores, and what the "full reversal" check sums.
              baseQuantity: string;
              unitPriceSYP: string;
              // [v4.9] The original line's unit price in USD, copied
              // VERBATIM onto the void line (never recomputed from any
              // rate, never negated — same rule as unitPriceSYP).
              // Nullable: null when the original had no frozen rate.
              unitPriceUSD: string | null;
              // [v4.4, T4g] The original line's FROZEN cost basis, carried
              // straight off the original InvoiceItem row — never
              // recomputed from the batch's current costPricePerBaseUnit,
              // which may have been corrected since the sale. The void
              // simply negates this exact value, which is what makes
              // (original + void) sum to exactly zero per line.
              costAmountSYP: string;
            }
            interface OriginalGroup {
              batches: OriginalBatchPortion[];
              totalBaseQuantity: string;
            }

            const originalByProductUnit = new Map<string, OriginalGroup>();
            for (const item of originalInvoice.items) {
              const key = `${item.productId}::${item.unitId}`;
              const group = originalByProductUnit.get(key) ?? { batches: [], totalBaseQuantity: "0" };
              group.batches.push({
                batchId: item.batchId,
                quantity: item.quantity.toString(),
                baseQuantity: item.baseQuantity.toString(),
                unitPriceSYP: item.unitPriceSYP.toString(),
                unitPriceUSD: item.unitPriceUSD?.toString() ?? null,
                costAmountSYP: item.costAmountSYP.toString(),
              });
              group.totalBaseQuantity = sumMoney([
                group.totalBaseQuantity,
                item.baseQuantity.toString(),
              ]);
              originalByProductUnit.set(key, group);
            }

            // [v4.9 FIX 4] Merge the void payload's items by the SAME
            // productId::unitId key used for the original groups. Without
            // this, a payload like [A, A] against an original {A, B} passed
            // the count check (2 === 2), restored A's group twice and never
            // restored B; and a legitimate payload with the same product/
            // unit on two cart lines could never match a single original
            // group. Quantities are summed (all negative, so the sum stays
            // negative); differing unit prices for one key are rejected.
            const voidByKey = new Map<
              string,
              { productId: string; unitId: string; quantity: string; unitPriceSYP: string }
            >();
            for (const it of inv.items) {
              const key = `${it.productId}::${it.unitId}`;
              const prev = voidByKey.get(key);
              if (!prev) {
                voidByKey.set(key, {
                  productId: it.productId,
                  unitId: it.unitId,
                  quantity: it.quantity,
                  unitPriceSYP: it.unitPriceSYP,
                });
              } else {
                if (
                  compareMoney(
                    serializeMoney(prev.unitPriceSYP),
                    serializeMoney(it.unitPriceSYP)
                  ) !== 0
                ) {
                  throw new Error("أسعار مختلفة لنفس المنتج/الوحدة في بنود الإلغاء.");
                }
                prev.quantity = sumMoney([prev.quantity, it.quantity]);
              }
            }

            if (originalByProductUnit.size !== voidByKey.size) {
              throw new Error(
                "عدد عناصر الإلغاء لا يطابق عدد المنتجات/الوحدات المختلفة بالفاتورة الأصلية."
              );
            }

            const matchedGroups: Array<{
              productId: string;
              unitId: string;
              group: OriginalGroup;
            }> = [];

            for (const voidItem of voidByKey.values()) {
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

              // [v4.8] "Full reversal" is judged in BASE units against the
              // exact sum of what was deducted — comparing the rounded
              // sale-unit pieces (0.8333 + 0.1667, or 0.3333 x 3) could
              // never equal the clean quantity the cashier voids.
              const voidUnitFactor = await getUnitConversionFactor(tx, tenantId, voidItem.unitId);
              const voidBaseQty = toBaseUnit(absQty(voidItem.quantity), voidUnitFactor).toFixed(4);
              if (compareMoney(voidBaseQty, group.totalBaseQuantity) !== 0) {
                throw new Error(
                  `كمية عنصر الإلغاء (${absQty(voidItem.quantity)}) لا تطابق الكمية الأصلية المباعة ` +
                  `لـ ${voidItem.productId}/${voidItem.unitId} — الإلغاء يجب أن يكون استرجاعاً كاملاً، ` +
                  "أي تصحيح جزئي يُسجَّل كدفعة (CustomerPayment) بدلاً من إلغاء."
                );
              }

              matchedGroups.push({
                productId: voidItem.productId,
                unitId: voidItem.unitId,
                group,
              });
            }

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

            // [v4.4 §1] resolved FRESH here, inside this transaction.
            const targetCustomerId = await resolveActiveCustomerId(
              tx,
              tenantId,
              originalInvoice.customerId
            );

            // [v4.8] Restore EXACTLY what was deducted, batch by batch — no
            // conversionFactor lookup, no division/multiplication.
            const batchAdjustments: Array<{ batchId: string; qtyToRestore: string }> = [];
            for (const matched of matchedGroups) {
              for (const portion of matched.group.batches) {
                batchAdjustments.push({
                  batchId: portion.batchId,
                  qtyToRestore: portion.baseQuantity,
                });
              }
            }

            await lockBatchesById(tx, tenantId, batchAdjustments.map((b) => b.batchId));

            const voidInvoice = await tx.invoice.create({
              data: {
                tenantId,
                userId: actor.userId,
                customerId: targetCustomerId,
                totalSYP,
                paidAmountSYP: paidSYP,
                debtAmountSYP: debtSYP,
                // [v4.9] USD figures and the exchange rate come from the
                // ORIGINAL invoice, negated via negateNullableMoney (null
                // stays null) — never recomputed from the payload's rate or
                // from the tenant's current daily rate. This is what makes
                // (original + void) sum to exactly zero in USD too, even if
                // the rate changed between the sale and the void.
                totalUSD: negateNullableMoney(originalInvoice.totalUSD?.toString() ?? null),
                paidAmountUSD: negateNullableMoney(originalInvoice.paidAmountUSD?.toString() ?? null),
                debtAmountUSD: negateNullableMoney(originalInvoice.debtAmountUSD?.toString() ?? null),
                exchangeRateUsed: originalInvoice.exchangeRateUsed?.toString() ?? null,
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
                    // display-only, negated in the SOLD unit
                    quantity: subtractMoney("0", portion.quantity),
                    // [v4.8] the exact base-unit amount being given back,
                    // negated — SUM(original + void) is exactly zero.
                    baseQuantity: subtractMoney("0", portion.baseQuantity),
                    unitPriceSYP: portion.unitPriceSYP,
                    // [v4.9] original USD unit price, verbatim (not negated,
                    // not recomputed) — same rule as unitPriceSYP.
                    unitPriceUSD: portion.unitPriceUSD,
                    // [v4.4, T4g] The negated ORIGINAL frozen cost — via
                    // subtractMoney("0", …), the same negation discipline
                    // used for quantity/paid/debt above, never a raw
                    // Decimal negation. Summing this against the original
                    // line's own costAmountSYP is exactly zero.
                    costAmountSYP: subtractMoney("0", portion.costAmountSYP),
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

          // [v4.9] Exchange-rate resolution + USD derivation live HERE now:
          // only a sale needs a rate. (A void copies it from the original.)
          // NEVER substitute the tenant's CURRENT daily rate for a null
          // payload rate (that would stamp a rate the cashier never used at
          // sale time), and never throw for a missing rate — persist null
          // rate and null USD fields. A rate that is present but unusable
          // (<= 0) is treated exactly like a missing one: null, never a
          // sentinel and never a reason to reject the record (deriveUsd
          // applies the same rule). SYP validations above stay unchanged.
          let exchangeRateUsed: string | null = null;
          if (inv.exchangeRateUsed !== null) {
            const parsedRate = serializeMoney(inv.exchangeRateUsed);
            exchangeRateUsed = compareMoney(parsedRate, 0) > 0 ? parsedRate : null;
          }

          const totalUSD = deriveUsd(totalSYP, exchangeRateUsed);
          const paidUSD = deriveUsd(paidSYP, exchangeRateUsed);
          const debtUSD = deriveUsd(debtSYP, exchangeRateUsed);

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
            unitPriceUSD: string | null;
            // sale-unit quantity — DISPLAY ONLY (rounded by construction)
            quantitySold: string;
            // [v4.8] exact base-unit amount deducted from batchId; copied
            // straight from the FIFO allocation, written to
            // InvoiceItem.baseQuantity, never derived by division.
            deductQtyInBaseUnit: string;
            // [v4.4, T4g] Frozen cost basis for this invoice line:
            //   multiplyMoney(allocatedQty, batch.costPricePerBaseUnit)
            // computed HERE, once, from the value read off the same locked
            // batch row the deduction below applies to. Never re-derived on
            // read, so a later cost correction cannot alter an already-sold
            // invoice's profit — the same principle as exchangeRateUsed.
            costAmountSYP: string;
          }

          const resolvedAllocations: ResolvedAllocation[] = [];

          // [v4.8] Lock EVERY batch of every product on this invoice (no
          // quantity filter), in one global ORDER BY id ASC — before any
          // read-for-allocation or write below.
          const productIdsInInvoice = [...new Set(inv.items.map((it) => it.productId))];
          await lockBatchesForFifoAllocations(tx, tenantId, productIdsInInvoice);

          for (const item of inv.items) {
            let baseUnit: Awaited<ReturnType<typeof requireBaseUnit>>;
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
            const baseQtyRequested = toBaseUnit(item.quantity, soldUnitFactor).toFixed(4);

            const unitPriceSYP = serializeMoney(item.unitPriceSYP);
            const itemUnitPriceUSD = deriveUsd(unitPriceSYP, exchangeRateUsed);

            const resolution = await commitFifoAllocation(tx, {
              tenantId,
              productId: item.productId,
              unitId: baseUnit.id,
              requestedQty: baseQtyRequested,
            });

            const itemAllocations: ResolvedAllocation[] = [];

            for (const alloc of resolution.allocations) {
              itemAllocations.push({
                productId: item.productId,
                unitId: item.unitId,
                batchId: alloc.batchId,
                unitPriceSYP,
                unitPriceUSD: itemUnitPriceUSD,
                quantitySold: fromBaseUnit(alloc.allocatedQty, soldUnitFactor).toFixed(4),
                deductQtyInBaseUnit: alloc.allocatedQty,
                // [v4.4, T4g] Frozen here, once — see the interface note.
                costAmountSYP: multiplyMoney(alloc.allocatedQty, alloc.costPricePerBaseUnit),
              });
            }

            // [v4.8] FIX 3 — shortfall policy. Whatever the positive
            // batches could not cover is booked on an "overdraw" batch
            // (negative stock, flagged for reconciliation) — a sale that
            // physically happened is never rejected for missing records.
            const shortfall =
              resolution.allocations.length === 0 ? baseQtyRequested : resolution.remainingQty;

            if (compareMoney(shortfall, 0) > 0) {
              let overdrawBatchId: string;
              let overdrawCost: string;

              if (resolution.allocations.length > 0) {
                const last = resolution.allocations[resolution.allocations.length - 1];
                overdrawBatchId = last.batchId;
                overdrawCost = last.costPricePerBaseUnit;
              } else {
                const newest = await tx.productBatch.findFirst({
                  where: { tenantId, productId: item.productId },
                  orderBy: [{ createdAt: "desc" }, { id: "desc" }],
                  select: { id: true, costPricePerBaseUnit: true },
                });
                if (!newest) {
                  throw new Error(
                    `لا توجد أي دفعة مسجلة للمنتج ${item.productId} — أضف دفعة (استلام بضاعة) قبل المزامنة.`
                  );
                }
                overdrawBatchId = newest.id;
                overdrawCost = newest.costPricePerBaseUnit.toString();
              }

              itemAllocations.push({
                productId: item.productId,
                unitId: item.unitId,
                batchId: overdrawBatchId,
                unitPriceSYP,
                unitPriceUSD: itemUnitPriceUSD,
                quantitySold: fromBaseUnit(shortfall, soldUnitFactor).toFixed(4),
                deductQtyInBaseUnit: shortfall,
                costAmountSYP: multiplyMoney(shortfall, overdrawCost),
              });
            }

            // [v4.8] FIX 2 — deduct NOW, so the next cart line (possibly the
            // same product in another unit) plans against updated quantities.
            for (const alloc of itemAllocations) {
              await tx.productBatch.update({
                where: { id: alloc.batchId, tenantId },
                data: { quantity: { decrement: alloc.deductQtyInBaseUnit } },
              });
            }

            resolvedAllocations.push(...itemAllocations);
          }

          const invoice = await tx.invoice.create({
            data: {
              tenantId,
              userId: actor.userId,
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
                // [v4.8] the exact base-unit amount deducted above.
                baseQuantity: alloc.deductQtyInBaseUnit,
                unitPriceSYP: alloc.unitPriceSYP,
                unitPriceUSD: alloc.unitPriceUSD,
                // [v4.4, T4g] REQUIRED, non-nullable — the frozen cost basis
                // for this line. See ResolvedAllocation's note above.
                costAmountSYP: alloc.costAmountSYP,
              },
            });
          }

          if (compareMoney(paidSYP, 0) > 0) {
            // [v4.9] This is THE paymentMethod check (see header FIX 3): a
            // throw here rolls back this one invoice — including the stock
            // deduction above — and reports it FAILED without blocking the
            // other records in the request.
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
        // [v4.8] FIX 6 — a racing second void hit Invoice.voidsInvoiceId's
        // @unique: a clean, specific reason instead of a raw Prisma message.
        if (uniqueTargetIncludes(err, "voidsInvoiceId")) {
          invoiceResults.push({
            offlineId: inv.offlineId,
            status: "FAILED",
            error: "تم إلغاء هذه الفاتورة مسبقاً عبر مزامنة أخرى.",
          });
          return;
        }
      }
      // [FIX — TRANSIENT CUSTOMER DEPENDENCY] Recorded as RETRY_LATER —
      // never FAILED, and never silently dropped (see the earlier
      // RETRY_LATER regression this restores against).
      if (err instanceof TransientDependencyError) {
        console.error(
          `[sync] invoice ${inv.offlineId}: blocked on a dependency still mid-retry, marking RETRY_LATER`,
          err
        );
        if (!isVoidItem) retryableInvoiceOfflineIds.add(inv.offlineId);
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
        // [v4.8] FIX 4 — a void waiting on THIS sale must wait too.
        if (!isVoidItem) retryableInvoiceOfflineIds.add(inv.offlineId);
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
  // PASS 3 — Payments (customer repayments). Idempotent via
  // CustomerPayment.offlineId, and — like both PASS 2 sub-phases — resolved and
  // written by ONE shared core.
  //
  // Exchange rate follows the SAME rule as the Invoice pass: when the device
  // record carries a rate, freeze THAT rate onto the row via frozenRate and
  // derive amountUSD as SYP ÷ that frozen rate. [v4.9] A payment recorded
  // while no rate existed carries exchangeRate = null (or omits it; the zod
  // schema normalizes both to null): frozenRate is passed as null and
  // recordRepaymentIdempotent must persist amountUSD/exchangeRate as NULL
  // (never a sentinel, never the tenant's current rate). Payload amountUSD is
  // never persisted. A duplicate offlineId is SYNCED
  // (recordRepaymentIdempotent), not FAILED. An amount above the current
  // balance is FAILED with the Arabic reason — never RETRY_LATER.
  // ==========================================================================
  for (const p of payments as PaymentPayload[]) {
    // [v4.9 FIX 6] Per-item date validation — fails THIS payment only.
    if (!isParseableDate(p.createdAt)) {
      paymentResults.push({
        offlineId: p.offlineId,
        status: "FAILED",
        error: INVALID_CREATED_AT_MESSAGE,
      });
      continue;
    }

    try {
      // ADMIN only — same posture as the void sub-phase in PASS 2. The sync
      // endpoint is an API-mutation path, so it enforces the Role Capability
      // Matrix's "log a repayment" row itself, regardless of what the client
      // did. [v4.8] The role checked is the record CREATOR's (from the DB),
      // not whoever happens to be running the sync.
      const resolvedActor = await resolveActor(p.createdByUserId);
      if (resolvedActor.kind === "deferred") {
        paymentResults.push({
          offlineId: p.offlineId,
          status: "RETRY_LATER",
          error: RETRY_LATER_ACTOR_MESSAGE,
        });
        continue;
      }
      if (resolvedActor.kind === "invalid") {
        paymentResults.push({
          offlineId: p.offlineId,
          status: "FAILED",
          error: "المستخدم الذي أنشأ هذه الدفعة غير موجود في هذا المتجر.",
        });
        continue;
      }
      if (resolvedActor.actor.role !== "ADMIN") {
        paymentResults.push({
          offlineId: p.offlineId,
          status: "FAILED",
          error: "تسجيل الدفعات متاح فقط لحساب المدير (ADMIN).",
        });
        continue;
      }

      const recorded = await withTxRetries(() =>
        recordRepaymentIdempotent(
          prisma,
          tenantId,
          {
            customerId: p.customerId ?? "",
            amountSYP: p.amountSYP,
            paymentMethod: p.paymentMethod as PaymentMethod,
            receiptNo: p.receiptNo ?? null,
            notes: p.notes ?? null,
            offlineId: p.offlineId,
            createdAt: new Date(p.createdAt),
            syncedAt: new Date(),
            // [v4.9] string | null — null means "no rate existed" (an absent
            // key was already normalized to null by the zod schema).
            frozenRate: p.exchangeRate,
          },
          {
            transactionOptions: TX_OPTIONS,
            resolveCustomerId: (tx) =>
              resolveTargetCustomerId(
                tx,
                tenantId,
                customerMap,
                { offlineCustomerId: p.offlineCustomerId, customerId: p.customerId },
                "الزبون المرتبط بهذه الدفعة غير موجود.",
                retryableCustomerOfflineIds
              ),
          }
        )
      );

      paymentResults.push({
        offlineId: p.offlineId,
        status: "SYNCED",
        realId: recorded.paymentId,
      });
    } catch (err) {
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