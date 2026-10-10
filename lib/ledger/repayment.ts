/**
 * lib/ledger/repayment.ts
 *
 * T4e — "customer repayment" (تسديد دفعة): the ONE server-side implementation.
 *
 * CALL SITES (both go through recordRepaymentIdempotent, which opens the
 * $transaction around recordRepayment — there is no second copy of the
 * repayment logic anywhere):
 *   1. POST /api/ledger/repayments — the online ledger screen
 *      (app/api/ledger/repayments/route.ts).
 *   2. The Payment pass of POST /api/sync (app/api/sync/route.ts) — an offline
 *      repayment queued on a device, replayed later.
 * The offline QUEUE side (lib/offline/pos-service.ts's submitOfflinePayment)
 * deliberately writes to Dexie only; it never writes to the server itself.
 *
 * WHAT IT GUARANTEES:
 *   - amountSYP is a decimal.js string, quantized ONCE to the column's
 *     precision (4 decimal places), > 0, and <= the customer's CURRENT
 *     balance. The value that is validated, the value that is written, and the
 *     value used to derive the balance-after are all that same quantized
 *     string — they can never disagree by a sub-precision remainder. The
 *     balance comes from lib/ledger/balance.ts — the same function
 *     GET /api/customers (the ledger screen) uses. This file does not
 *     re-implement the formula.
 *   - The customer is real: resolved through resolveActiveCustomerId() INSIDE
 *     this same transaction (so a merged-away customer's repayment lands on
 *     the survivor, never on the deactivated row), then checked for
 *     isActive / !isSystemGenerated.
 *   - exchangeRate / amountUSD are NULLABLE (schema v4.9) and never a
 *     sentinel. params.frozenRate has THREE meanings:
 *       * a usable number (> 0)  -> frozen onto the row (sync path, same rule
 *                                   as Invoice.exchangeRateUsed);
 *       * null                   -> the record was created while NO rate
 *                                   existed: exchangeRate and amountUSD are
 *                                   persisted as NULL. The tenant's CURRENT
 *                                   rate is NEVER substituted (it would stamp
 *                                   a rate nobody used when the money moved);
 *       * undefined (omitted)    -> online path: "now" IS the moment of the
 *                                   transaction, so today's
 *                                   Tenant.dailyExchangeRate is read FRESH
 *                                   inside this transaction (never from the
 *                                   JWT/session). If the tenant has none,
 *                                   the result is NULL — never an error.
 *     A supplied rate that is unusable (empty, non-numeric, <= 0) is treated
 *     exactly like a missing one (null), matching deriveUsd(). amountUSD is
 *     derived ONLY through deriveUsd() (display-only; SYP stays authoritative).
 *   - Exactly ONE top-level `customerPayment.create` with `invoiceId: null` —
 *     no nested writes anywhere (see lib/db/tenant-scope.ts's rule #2).
 *   - `offlineId`, when supplied, is an idempotency key: a repeated offlineId
 *     returns the row already recorded instead of creating a second one.
 *     Concurrent unique-constraint races are recovered by
 *     recordRepaymentIdempotent (never inside recordRepayment itself: a
 *     failed statement aborts the Postgres transaction, so a re-read in the
 *     same tx would fail).
 *
 * REJECTION CODES: every rejection is a RepaymentError carrying an HTTP
 * `status` and a machine-readable `code`. `code` exists so a caller never has
 * to string-match an Arabic message: the sync engine uses
 * code === "EXCEEDS_BALANCE" to mark the item FAILED with the Arabic reason
 * (never auto-retried).
 *
 * KNOWN, ACCEPTED LIMITATION (documented, deliberately NOT fixed here):
 * The "amount may not exceed the balance" check is a FRIENDLY GUARD, not a
 * guarantee under concurrent writes. Two ADMINs repaying the same customer at
 * the same instant can both read the same balance and both pass this check,
 * producing an overpayment on the second commit. No row lock and no new raw
 * query is added for this: the ledger formula already displays the resulting
 * negative (credit) balance correctly, and the alternative — a SELECT ... FOR
 * UPDATE on the customer or an advisory lock around every repayment — would
 * add contention and a raw-query exception for a case the books already
 * represent honestly. Any future "hard guarantee" requirement must come with
 * its own explicit decision record, not be smuggled in here.
 */

import { Prisma, PaymentMethod } from "@prisma/client";
import type { TxOrClient } from "@/lib/db/tenant-scope";
import { resolveActiveCustomerId } from "@/lib/customers/resolve-active";
import {
  addMoney,
  compareMoney,
  deriveUsd,
  formatMoney,
  serializeMoney,
  subtractMoney,
  toDecimal,
  MoneyError,
} from "@/lib/utils/money";
import { getCustomerBalanceSYP } from "./balance";

export type RepaymentErrorCode =
  /** The amount is larger than the customer's current balance. */
  | "EXCEEDS_BALANCE"
  /** Any other rejection (validation, unknown/inactive/system customer...). */
  | "REJECTED";

/**
 * Every rejection this module produces. Carries an HTTP `status` so the online
 * route can answer with a specific code, a `code` so the sync engine can
 * classify the rejection without parsing text, and an Arabic `.message` that is
 * shown to the user (and stored as the per-item FAILED reason by the sync
 * engine) — one error type, no parallel message tables.
 */
export class RepaymentError extends Error {
  readonly status: number;
  readonly code: RepaymentErrorCode;

  constructor(message: string, status = 400, code: RepaymentErrorCode = "REJECTED") {
    super(message);
    this.name = "RepaymentError";
    this.status = status;
    this.code = code;
  }
}

export interface RecordRepaymentParams {
  customerId: string;
  amountSYP: string | number;
  /** Defaults to CASH — see the CustomerPayment model. */
  paymentMethod?: PaymentMethod;
  receiptNo?: string | null;
  notes?: string | null;
  /** Idempotency key for an offline-originated repayment. */
  offlineId?: string | null;
  /** Sync-time replay: the original local creation timestamp. */
  createdAt?: Date;
  /** Sync-time replay: when this row was actually pushed to the server. */
  syncedAt?: Date | null;
  /**
   * [v4.9] The rate frozen on the record when it was created.
   *   - usable number (> 0): frozen onto the row.
   *   - null: no rate existed then -> persisted as NULL (NEVER replaced by the
   *     tenant's current rate). The sync path passes the offline record's
   *     exchangeRate as-is, so a null stays null.
   *   - undefined (omit the key): online path — today's
   *     Tenant.dailyExchangeRate is read fresh inside the transaction; if the
   *     tenant has none the result is NULL (never an error).
   * An unusable value (empty / non-numeric / <= 0) behaves like null.
   */
  frozenRate?: string | number | null;
}

export interface RecordedRepayment {
  paymentId: string;
  /** The RESOLVED (survivor) customer this row was written against. */
  customerId: string;
  amountSYP: string;
  // [v4.9] Nullable — null when no rate existed at record time.
  amountUSD: string | null;
  exchangeRate: string | null;
  balanceBeforeSYP: string;
  balanceAfterSYP: string;
  /** true when `offlineId` was already on record — nothing was written. */
  alreadyRecorded: boolean;
}

const DEFAULT_PAYMENT_METHOD: PaymentMethod = PaymentMethod.CASH;

const EXISTING_PAYMENT_SELECT = {
  id: true,
  customerId: true,
  amountSYP: true,
  amountUSD: true,
  exchangeRate: true,
} as const;

// Derived from the generated Prisma enum itself, so this list can never drift
// from schema.prisma (there is no second hand-typed copy to forget to update).
const PAYMENT_METHODS: readonly PaymentMethod[] = Object.values(PaymentMethod);

function isPaymentMethod(value: unknown): value is PaymentMethod {
  return typeof value === "string" && (PAYMENT_METHODS as readonly string[]).includes(value);
}

/**
 * P2002 unique-constraint helper used ONLY by the repayment write path.
 * Narrows by error.meta.target including the field name — never a substring
 * match on the error message. The sync route's shared isUniqueConflict is
 * left untouched.
 */
export function isUniqueConflictOn(error: unknown, field: string): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002" &&
    Array.isArray(error.meta?.target) &&
    (error.meta.target as unknown[]).includes(field)
  );
}

/**
 * Arabic, fail-loud parse of the caller's amount — never a silent 0/NaN.
 *
 * Quantizes to 4 decimal places exactly ONCE (the precision of
 * CustomerPayment.amountSYP, Decimal(18,4)) BEFORE the "> 0" check: an amount
 * like 0.00001 rounds to 0.0000 and is rejected as zero here, instead of being
 * accepted and then stored as a meaningless 0.0000 payment. Every later step
 * (balance comparison, the write, balance-after) uses this same string.
 */
function parseAmountSYP(raw: string | number): string {
  let amount: string;
  try {
    amount = toDecimal(serializeMoney(raw)).toFixed(4);
  } catch (error) {
    if (error instanceof MoneyError) {
      throw new RepaymentError("قيمة الدفعة غير صالحة — يرجى إدخال مبلغ رقمي صحيح بالليرة السورية.");
    }
    throw error;
  }
  if (compareMoney(amount, 0) <= 0) {
    throw new RepaymentError("قيمة الدفعة يجب أن تكون أكبر من الصفر.");
  }
  return amount;
}

/**
 * Builds the result for an offlineId that is already on record (a replayed or
 * double-submitted repayment). Nothing is written.
 *
 * The existing row is already reflected in the customer's current balance, so
 * the current balance IS the balance AFTER this payment. The balance BEFORE it
 * is reconstructed as current balance + this payment's amount.
 *
 * APPROXIMATION: that "before" figure is exact only if no other invoice or
 * payment touched this customer after the original write. It is display-only
 * (the "الرصيد قبل" line on a retried submit); nothing financial reads it.
 */
async function recordedFromExistingRow(
  db: TxOrClient,
  tenantId: string,
  existing: {
    id: string;
    customerId: string;
    amountSYP: { toString(): string };
    // [v4.9] Nullable — null for repayments recorded with no rate.
    amountUSD: { toString(): string } | null;
    exchangeRate: { toString(): string } | null;
  }
): Promise<RecordedRepayment> {
  const balanceAfterSYP = await getCustomerBalanceSYP(db, tenantId, existing.customerId);
  const amountSYP = existing.amountSYP.toString();
  return {
    paymentId: existing.id,
    customerId: existing.customerId,
    amountSYP,
    amountUSD: existing.amountUSD?.toString() ?? null,
    exchangeRate: existing.exchangeRate?.toString() ?? null,
    balanceBeforeSYP: addMoney(balanceAfterSYP, amountSYP),
    balanceAfterSYP,
    alreadyRecorded: true,
  };
}

/** A rate is usable only when it parses and is > 0 (same rule as deriveUsd). */
function usableRateOrNull(raw: string | number): string | null {
  if (typeof raw === "string" && raw.trim() === "") return null;
  let rate: string;
  try {
    rate = serializeMoney(raw);
  } catch (error) {
    if (error instanceof MoneyError) return null;
    throw error;
  }
  return compareMoney(rate, 0) > 0 ? rate : null;
}

/**
 * [v4.9] Resolves the rate to freeze on the row — NEVER throws for a missing
 * or unusable rate, returns null instead. See RecordRepaymentParams.frozenRate
 * for the three-way meaning of undefined / null / value.
 */
async function resolveExchangeRate(
  tx: TxOrClient,
  tenantId: string,
  frozenRate: RecordRepaymentParams["frozenRate"]
): Promise<string | null> {
  // Sync path, record created with no rate: stays null. Do NOT fall through
  // to the tenant's current rate.
  if (frozenRate === null) {
    return null;
  }

  // Sync path, record carried a rate: freeze it (unusable -> null).
  if (frozenRate !== undefined) {
    return usableRateOrNull(frozenRate);
  }

  // Online path (key omitted): the moment of this transaction is "now", so
  // today's tenant rate is the right one — read fresh, never from the JWT.
  // Optional: no rate configured -> null.
  const tenantRow = await tx.tenant.findUnique({
    where: { id: tenantId },
    select: { dailyExchangeRate: true },
  });
  if (!tenantRow?.dailyExchangeRate) {
    return null;
  }
  return usableRateOrNull(tenantRow.dailyExchangeRate.toString());
}

/**
 * Records one independent customer repayment (تسديد دفعة).
 *
 * Must be called INSIDE a transaction: the customer-merge resolution, the
 * balance read, and the write all have to agree on one consistent snapshot.
 * Call sites open that transaction via recordRepaymentIdempotent so a
 * concurrent offlineId race can be recovered outside the aborted tx.
 *
 * Does NOT catch Prisma P2002 — a failed unique insert aborts the Postgres
 * transaction, and a re-read inside it would fail.
 */
export async function recordRepayment(
  tx: TxOrClient,
  tenantId: string,
  params: RecordRepaymentParams
): Promise<RecordedRepayment> {
  if (!tenantId || !tenantId.trim()) {
    throw new RepaymentError("لا يمكن تسجيل دفعة دون تحديد هوية المتجر (تسجيل الدخول مطلوب).");
  }
  if (!params.customerId || !params.customerId.trim()) {
    throw new RepaymentError("يجب تحديد الزبون المراد تسديد دفعة له.");
  }

  const amountSYP = parseAmountSYP(params.amountSYP);

  // A replayed (offline) repayment carries its original creation time. An
  // invalid Date would otherwise surface later as an opaque Prisma error, which
  // the sync engine could misclassify; reject it here with a clear reason.
  if (params.createdAt && Number.isNaN(params.createdAt.getTime())) {
    throw new RepaymentError("تاريخ إنشاء الدفعة غير صالح.");
  }

  // ---- Idempotency: a repeated offlineId must never create a second row. ----
  // Checked BEFORE the balance check on purpose: replaying an already-recorded
  // payment must be a no-op even if the customer has since paid the rest off,
  // otherwise a retried sync would wrongly burn the item into FAILED.
  if (params.offlineId) {
    const existing = await tx.customerPayment.findFirst({
      where: { offlineId: params.offlineId, tenantId },
      select: EXISTING_PAYMENT_SELECT,
    });
    if (existing) {
      return recordedFromExistingRow(tx, tenantId, existing);
    }
  }

  // ---- The customer must be real, and must be the CURRENT survivor. ----
  // Resolved INSIDE this transaction (lib/customers/resolve-active.ts), so a
  // customer merged away moments ago receives this repayment on the survivor
  // instead of splitting that customer's ledger in two.
  const resolvedCustomerId = await resolveActiveCustomerId(tx, tenantId, params.customerId);

  const customer = await tx.customer.findFirst({
    where: { id: resolvedCustomerId, tenantId },
    select: { id: true, isActive: true, isSystemGenerated: true },
  });

  if (!customer) {
    throw new RepaymentError("الزبون غير موجود.", 404);
  }
  if (customer.isSystemGenerated) {
    throw new RepaymentError(
      "لا يمكن تسجيل دفعة على حساب الزبون النقدي العام — الدفعات تُسجَّل على زبائن حقيقيين فقط."
    );
  }
  if (!customer.isActive) {
    throw new RepaymentError("حساب هذا الزبون غير مفعّل — لا يمكن تسجيل دفعة عليه.");
  }

  // ---- Balance, from the SAME function the ledger screen uses. ----
  const balanceBeforeSYP = await getCustomerBalanceSYP(tx, tenantId, resolvedCustomerId);

  // Friendly guard only — see the file header's KNOWN, ACCEPTED LIMITATION.
  if (compareMoney(amountSYP, balanceBeforeSYP) > 0) {
    throw new RepaymentError(
      `قيمة الدفعة (${formatMoney(amountSYP, "SYP")} ل.س) أكبر من الرصيد الحالي المستحق ` +
      `(${formatMoney(balanceBeforeSYP, "SYP")} ل.س) — لا يمكن تسديد أكثر من الدين القائم.`,
      400,
      "EXCEEDS_BALANCE"
    );
  }

  // ---- Exchange rate: frozenRate (sync) or fresh DB (online). Never JWT. ----
  // [v4.9] May be null (no rate existed) — that is valid, never an error.
  const exchangeRate = await resolveExchangeRate(tx, tenantId, params.frozenRate);

  // Derived, display-only — SYP stays authoritative. deriveUsd() is the ONLY
  // place that decides "USD unavailable" (returns null for a null/<=0 rate).
  const amountUSD = deriveUsd(amountSYP, exchangeRate);

  const paymentMethod = isPaymentMethod(params.paymentMethod)
    ? params.paymentMethod
    : DEFAULT_PAYMENT_METHOD;

  // ONE top-level write — never a nested relation write (T1's isolation rule).
  const created = await tx.customerPayment.create({
    data: {
      tenantId,
      customerId: resolvedCustomerId,
      // An independent repayment is never tied to one invoice — it reduces the
      // customer's whole balance. That is also exactly what makes the ledger
      // formula (balance.ts) subtract it.
      invoiceId: null,
      amountSYP,
      amountUSD,
      exchangeRate,
      paymentMethod,
      receiptNo: params.receiptNo?.trim() || null,
      notes: params.notes?.trim() || null,
      offlineId: params.offlineId ?? null,
      // An online repayment (no offlineId) is synced by definition; syncedAt is
      // only meaningful for a row that arrived through /api/sync.
      syncedAt: params.syncedAt ?? null,
      createdAt: params.createdAt ?? new Date(),
    },
    select: { id: true },
  });

  // amountSYP is already the exact 4-dp value that was validated and written —
  // no further rounding step exists that could make this disagree with the row.
  const balanceAfterSYP = subtractMoney(balanceBeforeSYP, amountSYP);

  return {
    paymentId: created.id,
    customerId: resolvedCustomerId,
    amountSYP,
    amountUSD,
    exchangeRate,
    balanceBeforeSYP,
    balanceAfterSYP,
    alreadyRecorded: false,
  };
}

export interface RecordRepaymentIdempotentOptions {
  transactionOptions?: { maxWait?: number; timeout?: number };
  /** Sync path: map offlineCustomerId / merge before recordRepayment runs. */
  resolveCustomerId?: (tx: TxOrClient) => Promise<string>;
}

type IdempotentDb = TxOrClient & {
  $transaction: (
    fn: (tx: TxOrClient) => Promise<RecordedRepayment>,
    options?: { maxWait?: number; timeout?: number }
  ) => Promise<RecordedRepayment>;
};

/**
 * Opens `$transaction` around recordRepayment. On a concurrent offlineId
 * unique-constraint race (P2002 whose meta.target includes "offlineId"),
 * re-reads the winner's row OUTSIDE that aborted transaction and returns it
 * as success. Any other P2002 is a real error.
 */
export async function recordRepaymentIdempotent(
  db: IdempotentDb,
  tenantId: string,
  params: RecordRepaymentParams,
  options?: RecordRepaymentIdempotentOptions
): Promise<RecordedRepayment> {
  try {
    return await db.$transaction(async (tx) => {
      const customerId = options?.resolveCustomerId
        ? await options.resolveCustomerId(tx)
        : params.customerId;
      return recordRepayment(tx, tenantId, { ...params, customerId });
    }, options?.transactionOptions);
  } catch (error) {
    if (isUniqueConflictOn(error, "offlineId") && params.offlineId) {
      const existing = await db.customerPayment.findFirst({
        where: { offlineId: params.offlineId, tenantId },
        select: EXISTING_PAYMENT_SELECT,
      });
      if (existing) {
        return recordedFromExistingRow(db, tenantId, existing);
      }
    }
    throw error;
  }
}