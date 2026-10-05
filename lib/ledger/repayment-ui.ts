/**
 * lib/ledger/repayment-ui.ts
 *
 * T4e — the PURE decision helpers behind the ledger screen's "تسديد دفعة"
 * button/dialog. No DOM, no React, no Dexie: every function here is a plain
 * input → output decision, so it is unit-testable in this project's `node`
 * test environment (vitest.config.ts has no jsdom — the same constraint the
 * offline void panel documented, and the same reason canVoidOfflineInvoice /
 * shouldShowOfflineVoidPanel live in lib/offline/pos-service.ts rather than in
 * the panel).
 *
 * The RENDERED component (components/ledger/customer-card.tsx +
 * components/ledger/repayment-modal.tsx) is deliberately thin: it calls these
 * functions and renders their result. Anything a reviewer needs to reason
 * about is here.
 *
 * Money rules still apply: nothing in this file does float arithmetic on a
 * monetary value — everything goes through lib/utils/money.ts's decimal.js
 * wrapper. The only non-money string handling is normalization of raw
 * text-input keystrokes (digits, separators), BEFORE anything is treated as an
 * amount.
 *
 * PARITY WITH THE SERVER: parseAmountInput() quantizes to 4 decimal places —
 * the precision of CustomerPayment.amountSYP and exactly what
 * lib/ledger/repayment.ts's parseAmountSYP() does — so the amount the dialog
 * validates, previews and sends is the same value the server will validate and
 * write. A client guard that disagreed with the server by a sub-precision
 * remainder would be worse than no guard.
 */

import type { PaymentMethod } from "@prisma/client";
import {
  compareMoney,
  convertCurrency,
  formatMoney,
  serializeMoney,
  subtractMoney,
  toDecimal,
  MoneyError,
} from "@/lib/utils/money";

/**
 * Should the "تسديد دفعة" button be in the DOM for this customer card?
 *
 * Rules (all four must hold):
 *   - the viewer is an ADMIN. A CASHIER gets NO button at all — absent from
 *     the DOM, never rendered disabled — matching T4d's void button
 *     convention. The server enforces the same thing independently
 *     (ledger:log_repayment → 403), because a UI is never the boundary.
 *   - the customer is NOT the system-generated cash customer (that bucket
 *     carries no debt and no credit by construction — every repayment path
 *     rejects it).
 *   - the balance is a valid, STRICTLY POSITIVE amount. A zero balance has
 *     nothing to settle; a negative one is a credit the merchant owes back and
 *     is never "settled" by this flow.
 *   - garbage/absent balance (a stale cache, a malformed API response) → false.
 *     Unparseable input must hide the button, never throw during render.
 */
export function canShowRepaymentButton(
  isAdmin: boolean,
  balanceSYP: string | null | undefined,
  isSystemGenerated: boolean
): boolean {
  if (!isAdmin) return false;
  if (isSystemGenerated) return false;
  if (balanceSYP == null) return false;

  try {
    return compareMoney(balanceSYP, 0) > 0;
  } catch (error) {
    if (error instanceof MoneyError) return false;
    throw error;
  }
}

/**
 * The dialog's live "الرصيد بعد التسديد" line: balance − amount.
 *
 * Returns null (rather than throwing) whenever the dialog should show "—":
 * an unparseable amount, or an amount above the balance (which the dialog
 * shows as an inline error instead of a remaining balance). The server
 * re-validates all of this; this is display only.
 */
export function computeRemainingBalanceSYP(
  balanceSYP: string,
  amountSYP: string
): string | null {
  const amount = parseAmountInput(amountSYP);
  if (amount === null) return null;

  try {
    if (compareMoney(amount, balanceSYP) > 0) return null;
    return subtractMoney(balanceSYP, amount);
  } catch (error) {
    if (error instanceof MoneyError) return null;
    throw error;
  }
}

/**
 * Should the dialog's submit button be enabled, and does the typed amount pass
 * the friendly client-side guard (0 < amount <= balance)?
 *
 * parseAmountInput() already guarantees amount > 0 (after 4-dp quantization),
 * so only the upper bound is checked here.
 */
export function canSubmitRepayment(balanceSYP: string, amountSYP: string): boolean {
  const amount = parseAmountInput(amountSYP);
  if (amount === null) return false;

  try {
    return compareMoney(amount, balanceSYP) <= 0;
  } catch (error) {
    if (error instanceof MoneyError) return false;
    throw error;
  }
}

/**
 * "تسديد كامل الرصيد" shortcut — the customer's whole outstanding balance,
 * serialized for the amount input. null when the balance itself is not a valid
 * positive amount (then there is nothing to settle).
 *
 * Returned WITHOUT trailing zeros ("2800", "2800.5") so the input does not
 * show "2800.0000". It round-trips exactly through parseAmountInput().
 */
export function fullBalanceAmountSYP(balanceSYP: string): string | null {
  try {
    if (compareMoney(balanceSYP, 0) <= 0) return null;
    return toDecimal(serializeMoney(balanceSYP)).toDecimalPlaces(4).toFixed();
  } catch (error) {
    if (error instanceof MoneyError) return null;
    throw error;
  }
}

/**
 * Normalizes a raw text-input value into a decimal.js-safe, 4-dp amount string
 * (e.g. "2500.0000"), or null when the text is not a valid positive amount.
 *
 * What a real Arabic-first RTL numeric input produces, and how each is handled:
 *   - Arabic-Indic (٠-٩) and Extended Arabic-Indic (۰-۹) digits → Latin digits.
 *   - Arabic decimal separator "٫" → ".".  Arabic comma "،" → ",".
 *   - Arabic thousands separator "٬" → removed.
 *   - Whitespace (incl. NBSP / narrow NBSP, which Intl emits) and invisible
 *     bidi marks (LRM/RLM/ALM, embeddings) → removed.
 *   - ASCII comma — the ambiguous one:
 *       "1,234,567" / "1,234.5"  → thousands grouping (groups of exactly 3)
 *       "2,5" / "12,75"          → decimal comma
 *       "2,500"                  → THOUSANDS (= 2500). Documented decision:
 *                                  exactly-3 digits after a single comma reads
 *                                  as grouping; for SYP amounts that is far
 *                                  more likely than 2.5. The dialog previews
 *                                  the parsed value live, so a misread is
 *                                  visible before submit.
 *       anything else ("1.234,56", "1,2,3") → null. Rejected, never guessed.
 *   - Anything that is not plain digits with at most one decimal point after
 *     that ("-5", "1e3", "abc", "Infinity") → null.
 *
 * The result is quantized to 4 decimal places BEFORE the "> 0" check, exactly
 * like the server: "0.00001" rounds to 0.0000 and is rejected as zero, and
 * "100.00004" becomes "100.0000". Empty/garbage is null — never coerced to 0
 * (a silently-zero amount is exactly the "plausible but wrong number"
 * lib/utils/money.ts's header forbids).
 */
export function parseAmountInput(raw: string | null | undefined): string | null {
  if (raw == null) return null;

  let s = raw
    .replace(/[\u200E\u200F\u061C\u202A-\u202E\u2066-\u2069]/g, "")
    .trim()
    // Arabic-Indic digits U+0660–0669 and Extended (Persian) U+06F0–06F9.
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/\u066B/g, ".") // ٫ Arabic decimal separator
    .replace(/\u066C/g, "") // ٬ Arabic thousands separator
    .replace(/\u060C/g, ",") // ، Arabic comma
    .replace(/\s/g, "");

  if (!s) return null;

  if (s.includes(",")) {
    if (/^\d{1,3}(,\d{3})+(\.\d*)?$/.test(s)) {
      s = s.replace(/,/g, ""); // thousands grouping
    } else if (/^\d+,\d+$/.test(s)) {
      s = s.replace(",", "."); // decimal comma
    } else {
      return null; // ambiguous / mixed — reject, never guess
    }
  }

  // Strict shape: digits with at most one decimal point. A leading or trailing
  // dot is tolerated because it is a normal intermediate typing state.
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(s)) return null;
  if (s.startsWith(".")) s = `0${s}`;
  if (s.endsWith(".")) s = s.slice(0, -1);

  try {
    // Same quantization as the server's parseAmountSYP(): ONE rounding to the
    // column's precision, then the positivity check on the rounded value.
    const amount = toDecimal(serializeMoney(s)).toFixed(4);
    return compareMoney(amount, 0) > 0 ? amount : null;
  } catch (error) {
    if (error instanceof MoneyError) return null;
    throw error;
  }
}

/**
 * The ledger's payment-method labels. Typed as Record<PaymentMethod, string>
 * on purpose: if schema.prisma's PaymentMethod enum gains a value, this object
 * stops compiling until it gets a label — and PAYMENT_METHODS below is derived
 * from these keys, so there is no second hand-typed list that can drift.
 * (Type-only import: no Prisma runtime is pulled into the client bundle.)
 */
export const PAYMENT_METHOD_LABELS_AR: Record<PaymentMethod, string> = {
  CASH: "نقداً",
  SHAM_CASH: "شام كاش",
  SYRIATEL_CASH: "سيرياتيل كاش",
  BANK_TRANSFER: "حوالة بنكية",
  OTHER: "أخرى",
};

/** The ledger's payment-method picker — derived from the labels above. */
export const PAYMENT_METHODS = Object.keys(PAYMENT_METHOD_LABELS_AR) as PaymentMethod[];

/** The one label for a repayment queued offline and not yet synced. */
export const PENDING_SYNC_LABEL = "بانتظار المزامنة";

/**
 * Confirmation step copy: "تسديد X من Y، الرصيد بعدها Z".
 * Display-only; the server re-validates the amount.
 */
export function repaymentConfirmationLine(
  amountSYP: string,
  balanceSYP: string,
  remainingSYP: string
): string {
  return (
    `تسديد ${formatMoney(amountSYP, "SYP")} من ${formatMoney(balanceSYP, "SYP")}، ` +
    `الرصيد بعدها ${formatMoney(remainingSYP, "SYP")}`
  );
}

/**
 * Secondary USD figure for the dialog (≈). Null when no usable cached rate.
 */
export function usdApproxFromSyp(
  amountSYP: string,
  rateSYPPerUSD: string | null | undefined
): string | null {
  if (rateSYPPerUSD == null) return null;
  try {
    if (compareMoney(rateSYPPerUSD, 0) <= 0) return null;
    return convertCurrency(amountSYP, rateSYPPerUSD, "SYP", "USD");
  } catch (error) {
    if (error instanceof MoneyError) return null;
    throw error;
  }
}

/**
 * A queued repayment the server rejected (status FAILED). It is NEVER retried
 * automatically, so it must not be shown as "pending": the card shows this
 * label together with the stored failureReason instead.
 */
export const FAILED_SYNC_LABEL = "فشلت المزامنة";