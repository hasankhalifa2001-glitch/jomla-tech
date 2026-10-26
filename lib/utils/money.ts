/* eslint-disable @typescript-eslint/no-explicit-any */
import Decimal from "decimal.js";

/**
 * ============================================================================
 * lib/utils/money.ts — single shared wrapper around decimal.js for every
 * MONETARY operation (SYP/USD amounts — invoices, payments, debt) used by
 * T4a (Dexie storage) / T4b (cart math) / T4c (sync-time server conversion)
 * / T4e (ledger balance computation).
 *
 * No call site handling a monetary (SYP/USD) value should construct a
 * `Decimal` directly or `import Decimal from "decimal.js"` on its own for
 * that value — always go through this module, so rounding/precision
 * behavior (and error behavior — see below) stays identical across the
 * cart, the offline queue, and the ledger.
 *
 * [SCOPE NOTE] This rule is specific to MONETARY values (SYP/USD). It
 * does NOT extend to quantity/unit-conversion values — those go through
 * lib/inventory/units.ts's own decimal.js usage instead (conversionFactor,
 * ProductBatch.quantity, StockAdjustment.quantityDelta), which is a
 * separate, deliberately independent decimal.js call site for a different
 * class of value. There is currently no ESLint rule enforcing either
 * module's decimal.js exclusivity (unlike the project's actual
 * CI-enforced rules — $queryRaw, nested-write, conversionFactor, model-
 * level product/productUnit access) — this is a documented convention,
 * not a build-time guarantee.
 *
 * FAIL-LOUD, NOT FAIL-SILENT:
 * This is financial code. A silently-wrong number (a swallowed NaN, an
 * invalid input coerced to 0, a divide-by-zero coerced to 0) is strictly
 * worse than a thrown error, because it looks like a normal, valid amount
 * everywhere downstream — on an invoice total, a debt balance, a synced
 * payment row — right up until someone notices the books don't add up.
 * Every function below throws a `MoneyError` rather than returning a
 * plausible-looking-but-wrong value for any input it cannot trust.
 *
 * [NOTE] The one deliberate exception to "fail loud" is rounding, not
 * validation: serializeMoney()/addMoney()/etc. all round their RESULT to
 * 4 decimal places via toFixed(4), matching every Decimal(18,4) column on
 * the server. A caller passing "10.123456" gets back "10.1235" with no
 * error — this is intentional precision-matching with the DB schema, not
 * a silently-wrong value. It never discards an invalid/NaN/Infinity
 * input; it only rounds an already-valid one to the schema's precision.
 * ============================================================================
 */

// Isolated Decimal constructor — NOT `Decimal.set()` on the imported
// module. `Decimal.set()` mutates decimal.js's global/default constructor,
// so it would silently change rounding/precision behavior for any other
// code in the project that does `import Decimal from "decimal.js"`
// directly (accidentally or otherwise), even though this file is meant to
// be the sole owner of that configuration for monetary values. `Decimal.clone()`
// produces an independent constructor scoped to this module only.
const Money = (Decimal as any).clone({
  precision: 20,
  rounding: Decimal.ROUND_HALF_UP,
}) as typeof Decimal;

export type MoneyDecimal = InstanceType<typeof Money>;
export type MoneyInput = string | number | MoneyDecimal;

/** Thrown by every function in this module instead of returning a
 * silently-wrong value (0, NaN, or an un-converted amount) for bad input. */
export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

/**
 * [D2] Half of the smallest quantity step (0.0001) used by
 * InvoiceItem.quantity / ProductBatch.quantity / baseQuantity - all
 * Decimal(18,4). A by-amount line's derived quantity can differ from its
 * typed amount by up to half a step times the unit price (e.g.
 * 0.3333 kg x 15,000 = 4,999.5 vs 5,000). The invoice-level tolerance is
 * the SUM of this per line (see invoiceTotalTolerance / D3).
 *
 * This is the ONLY definition of this constant in the codebase. Nothing
 * else may declare a second 0.00005 literal or re-implement the tolerance
 * comparison below (a static source scan enforces this - added in Phase 2).
 */
export const QUANTITY_HALF_STEP = "0.00005";

/**
 * [D2/D5] Thrown by quantityFromAmount() when the amount cannot be
 * converted to a valid sellable quantity: price <= 0, amount <= 0, or the
 * derived quantity rounds below the 0.0001 minimum.
 */
export class QuantityFromAmountError extends MoneyError {
  constructor(message: string) {
    super(message);
    this.name = "QuantityFromAmountError";
  }
}

/**
 * [FIX] Uses decimal.js's own `Decimal.isDecimal()` static check instead
 * of `instanceof Money`. `Money` is a `.clone()`'d constructor, entirely
 * separate from the base `Decimal` export and from any OTHER module's own
 * clone (e.g. a future or existing independent decimal.js constructor
 * elsewhere in the codebase, such as lib/inventory/units.ts's plain
 * `Decimal` usage). `instanceof Money` would reject a perfectly valid
 * Decimal instance created via any constructor other than this exact
 * cloned one — throwing a misleading "expected string, number, or
 * Decimal, got object" MoneyError for a value that IS a Decimal, just not
 * from this module's own clone. `Decimal.isDecimal()` recognizes any
 * decimal.js instance regardless of which constructor created it, which
 * is what every call site of this function actually needs — a value
 * still gets re-wrapped in `new Money(...)` when necessary elsewhere in
 * this file, so precision/rounding config is still correctly applied.
 */

function isMoneyDecimalInstance(value: unknown): value is MoneyDecimal {
  return (Decimal as any).isDecimal(value);
}

/**
 * Safely converts any money input into a Decimal instance.
 * Throws MoneyError for anything that isn't a genuine, finite numeric
 * value — never coerces an invalid/missing input to 0, and never lets a
 * NaN/Infinity value pass through as if it were valid money.
 */
export function toDecimal(value: MoneyInput): MoneyDecimal {
  if (isMoneyDecimalInstance(value)) {
    if (!value.isFinite()) {
      throw new MoneyError(
        `Invalid monetary value: Decimal is not finite (${value.toString()}).`
      );
    }
    // Re-wrap in this module's own Money constructor so downstream
    // arithmetic always runs under this file's precision/rounding
    // config, even if the input Decimal came from a different
    // decimal.js constructor (see isMoneyDecimalInstance's doc above).
    return new Money(value.toString());
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new MoneyError(
        `Invalid monetary value: number is not finite (${String(value)}). ` +
        `NaN/Infinity must never be treated as a valid amount.`
      );
    }
    return new Money(value.toString());
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      throw new MoneyError(
        "Invalid monetary value: empty string is not a valid amount."
      );
    }
    let dec: MoneyDecimal;
    try {
      dec = new Money(trimmed);
    } catch {
      throw new MoneyError(`Invalid monetary value: "${value}" is not a valid decimal string.`);
    }
    if (!dec.isFinite()) {
      throw new MoneyError(`Invalid monetary value: "${value}" resolved to a non-finite Decimal.`);
    }
    return dec;
  }

  throw new MoneyError(
    `Invalid monetary value: expected string, number, or Decimal, got ${typeof value}.`
  );
}

/**
 * Serializes any monetary value to a string representation for safe DB
 * storage (Dexie / API). Rounds to 4 decimal places — see the file-header
 * NOTE on rounding vs. fail-loud validation.
 */
export function serializeMoney(value: MoneyInput): string {
  return toDecimal(value).toFixed(4);
}

/**
 * Truncates a monetary value TOWARD ZERO to 4 decimal places, using
 * decimal.js's own named `Decimal.ROUND_DOWN` constant (never a bare numeric
 * literal). Contrast `serializeMoney`, which rounds HALF_UP.
 *
 * "Toward zero" == "down" for every NON-NEGATIVE value, which is the only
 * class of value this is used for (a positive available-stock figure). For a
 * negative input it would round toward zero (i.e. up in magnitude terms), so
 * do NOT reach for this to floor a possibly-negative amount — use an explicit
 * ROUND_FLOOR path if that case ever arises.
 *
 * WHY it exists (T5c approval): a "how much is available" figure shown to the
 * admin must truncate so an admin who retypes exactly that number into the
 * approve form requests at most what is truly on hand. Rounding up (e.g.
 * 70 / 24 = 2.91666… shown as "2.9167") would let them request 2.9167 and then
 * be rejected again by the very check that produced the figure. Truncating
 * makes the displayed figure a value the sufficiency check accepts.
 */
export function truncateMoney(value: MoneyInput): string {
  return toDecimal(value).toDecimalPlaces(4, Decimal.ROUND_DOWN).toFixed(4);
}

/** Adds two monetary values and returns the result as a Decimal string. */
export function addMoney(a: MoneyInput, b: MoneyInput): string {
  return toDecimal(a).plus(toDecimal(b)).toFixed(4);
}

/** Subtracts value b from value a and returns the result as a Decimal string. */
export function subtractMoney(a: MoneyInput, b: MoneyInput): string {
  return toDecimal(a).minus(toDecimal(b)).toFixed(4);
}

/** Multiplies two monetary values (e.g. price * quantity) and returns a Decimal string. */
export function multiplyMoney(a: MoneyInput, b: MoneyInput): string {
  return toDecimal(a).times(toDecimal(b)).toFixed(4);
}

/**
 * Divides value a by value b and returns a Decimal string.
 * Throws MoneyError on division by zero — a caller hitting this is a real
 * bug upstream (e.g. a zero quantity/rate that should never have reached
 * here) and must be surfaced, not silently reported as "0.0000".
 */
export function divideMoney(a: MoneyInput, b: MoneyInput): string {
  const divisor = toDecimal(b);
  if (divisor.isZero()) {
    throw new MoneyError("Division by zero: cannot divide a monetary value by 0.");
  }
  return toDecimal(a).dividedBy(divisor).toFixed(4);
}

/**
 * [D2/D3] Derive the sell quantity from a customer-requested amount.
 * quantity = amount / unitPriceSYP, rounded ONCE (HALF_UP) to 4 dp - the
 * precision of InvoiceItem.quantity / ProductBatch.quantity / baseQuantity.
 * Throws QuantityFromAmountError for price <= 0, amount <= 0, or a derived
 * quantity below the 0.0001 minimum (D5). Uses divideMoney() so the division
 * itself stays within this module's decimal.js rounding config.
 */
export function quantityFromAmount(
  amountSYP: MoneyInput,
  unitPriceSYP: MoneyInput
): string {
  const amount = toDecimal(amountSYP);
  const price = toDecimal(unitPriceSYP);

  if (price.isZero() || price.isNegative()) {
    throw new QuantityFromAmountError("سعر الوحدة يجب أن يكون أكبر من صفر.");
  }
  if (amount.isZero() || amount.isNegative()) {
    throw new QuantityFromAmountError("المبلغ يجب أن يكون أكبر من صفر.");
  }

  // divideMoney rounds HALF_UP to 4 dp - matches Decimal(18,4) quantity precision.
  const quantity = toDecimal(divideMoney(amountSYP, unitPriceSYP));

  // D5: minimum derived quantity is 0.0001.
  if (quantity.lessThan(toDecimal("0.0001"))) {
    throw new QuantityFromAmountError(
      "المبلغ أدنى من الكمية الدنيا القابلة للبيع (0.0001)."
    );
  }

  return quantity.toFixed(4);
}

/**
 * Converts an amount between USD and SYP using an exchange rate (USD to SYP).
 * Throws MoneyError on a zero/invalid exchange rate rather than silently
 * returning the un-converted amount — a zero rate reaching this function
 * is a bug (T4b's checkout flow must never allow a sale with no cached
 * rate — see T1 acceptance criteria), and silently skipping the
 * conversion would produce a plausible-looking number in the wrong
 * currency (e.g. "18.5" shown where "277500" was meant), which is far
 * harder to catch than an explicit failure.
 *
 * Direction-agnostic by design: this function does not encode which
 * currency is "authoritative" (that's a v3.6 business-logic decision made
 * at the call site — see Invoice/CustomerPayment/InvoiceItem in
 * schema.prisma), it just converts whichever direction is asked for.
 *
 * [FIX] Previously duplicated divideMoney's own zero-divisor logic inline
 * (`decAmount.dividedBy(rate)`) instead of calling divideMoney() itself —
 * two independent implementations of "divide with a validated divisor"
 * for the exact same operation, one extra place a future change (e.g. a
 * stricter minimum-rate floor) could be applied to one path and forgotten
 * on the other. Now routes through multiplyMoney()/divideMoney() directly;
 * the single rate validation below covers both directions.
 */
export function convertCurrency(
  amount: MoneyInput,
  exchangeRate: MoneyInput,
  fromCurrency: "USD" | "SYP",
  toCurrency: "USD" | "SYP"
): string {
  if (fromCurrency === toCurrency) {
    return serializeMoney(amount);
  }

  const rate = toDecimal(exchangeRate);
  if (rate.isZero() || rate.isNegative()) {
    throw new MoneyError(
      `Invalid exchange rate (${rate.toString()}): cannot convert ${fromCurrency} to ${toCurrency}.`
    );
  }

  if (fromCurrency === "USD" && toCurrency === "SYP") {
    return multiplyMoney(amount, rate);
  }
  if (fromCurrency === "SYP" && toCurrency === "USD") {
    // rate is already validated non-zero/non-negative above; divideMoney's
    // own isZero() guard is defense-in-depth, not the primary check here.
    return divideMoney(amount, rate);
  }

  // Unreachable given the "USD" | "SYP" union, but keeps this function
  // fail-loud rather than silently falling through if the type ever widens.
  throw new MoneyError(`Unsupported currency pair: ${fromCurrency} -> ${toCurrency}.`);
}

/**
 * [v4.9] THE ONLY place that decides "USD unavailable".
 *
 * Derives the informational USD figure from an authoritative SYP amount and
 * the rate frozen at the moment of the transaction. Returns null when no
 * usable rate exists (null/undefined/empty, non-numeric, or <= 0) — never a
 * sentinel 0/1. Every write path and every UI view-model must go through
 * this helper; no ad-hoc null checks scattered around.
 */
export function deriveUsd(amountSYP: MoneyInput, rate: MoneyInput | string | null | undefined): string | null {
  if (rate === null || rate === undefined) {
    return null;
  }
  if (typeof rate === "string" && rate.trim() === "") {
    return null;
  }
  let parsed: MoneyDecimal;
  try {
    parsed = toDecimal(rate as MoneyInput);
  } catch {
    return null;
  }
  if (parsed.isZero() || parsed.isNegative()) {
    return null;
  }
  return convertCurrency(amountSYP, parsed, "SYP", "USD");
}

/**
 * [v4.9] Void-row negation for NULLABLE USD fields: null stays null,
 * otherwise subtractMoney("0", x). Use for void rows that negate the
 * ORIGINAL invoice's stored USD values.
 */
export function negateNullableMoney(value: MoneyInput | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return subtractMoney("0", value);
}

/**
 * Compares two monetary values. Returns -1 if a < b, 0 if a == b, 1 if a > b.
 */
export function compareMoney(a: MoneyInput, b: MoneyInput): number {
  return toDecimal(a).comparedTo(toDecimal(b));
}

/**
 * Formats a monetary value for LOCALIZED DISPLAY ONLY (never for storage —
 * use serializeMoney for that). Uses Intl.NumberFormat('ar-SY') per the
 * spec's Global UI/UX & Localization Architecture section, so digit
 * grouping/decimal separators follow the same convention as the rest of
 * the Arabic-first UI instead of a hand-rolled, locale-unaware comma
 * formatter. Defaults to 2 decimals for USD, 0 for SYP.
 *
 * Defaults to "SYP" since that's the ledger's authoritative currency
 * (see schema.prisma). Treat this as a safety net only — every real
 * call site should pass `currency` explicitly.
 *
 * DO NOT reuse this function's output (a `Number`-rounded display string)
 * as an input to any further monetary calculation — it exists purely to
 * feed Intl.NumberFormat's digit grouping and is not part of the
 * decimal.js-safe calculation chain.
 */
export function formatMoney(
  amount: MoneyInput,
  currency: "USD" | "SYP" = "SYP",
  decimals?: number
): string {
  const dec = toDecimal(amount);
  const targetDecimals = decimals ?? (currency === "SYP" ? 0 : 2);

  // Intl.NumberFormat operates on JS numbers, not arbitrary-precision
  // Decimals — that's fine here because this function's OUTPUT is a
  // rounded display string, not a value anything downstream computes
  // with further. The Decimal -> fixed-string -> Number handoff below
  // rounds to `targetDecimals` using decimal.js first (avoiding native
  // float rounding on the raw high-precision value), then only formats
  // digit grouping/separators via Intl on the already-rounded number.
  const rounded = dec.toFixed(targetDecimals);

  return new Intl.NumberFormat("ar-SY", {
    minimumFractionDigits: targetDecimals,
    maximumFractionDigits: targetDecimals,
  }).format(Number(rounded));
}

/** Sums an array of monetary values and returns the result as a Decimal string.
 * Exists so T4b's "summation across line items" always goes through the
 * shared decimal.js wrapper instead of a hand-rolled .reduce((a,b)=>a+b) that
 * would silently reintroduce native float arithmetic on money.
 *
 * An empty array returns "0.0000" (same 4-dp format as every other function
 * in this module) so callers can compare/serialize the result uniformly. */
export function sumMoney(values: MoneyInput[]): string {
  return values.reduce<string>((acc, v) => addMoney(acc, v), "0.0000");
}

/**
 * [D2/D3] Invoice-level tolerance = SUM over lines of (|unitPriceSYP| x 0.00005).
 * Uniform across every line because the server cannot know which lines were
 * entered by amount. The result is a SYP tolerance amount.
 *
 * The sum is computed at full decimal precision (no intermediate 4-dp
 * rounding) and rounded ONCE, UPWARD (ROUND_CEIL), to 4 dp. The tolerance may
 * only ever be rounded up, never down: a legitimate by-amount line that sits
 * exactly on the half-step boundary (possible with a fractional, e.g.
 * USD-converted, unit price) must never be rejected merely because the
 * tolerance itself was rounded below its true value.
 */
export function invoiceTotalTolerance(unitPricesSYP: string[]): string {
  const total = unitPricesSYP.reduce(
    (acc, price) =>
      acc.plus(toDecimal(price).abs().times(toDecimal(QUANTITY_HALF_STEP))),
    new Money(0)
  );
  return total.toDecimalPlaces(4, Decimal.ROUND_CEIL).toFixed(4);
}

/**
 * [D2/D3] Inclusive tolerance check: |expectedTotal - actualTotal| <=
 * SUM(|unitPriceSYP| x 0.00005) over the invoice's lines.
 * Returns true when the difference is within tolerance (inclusive).
 * D1 (base-unit only) is enforced in the POS service, not on the server,
 * by design - the server cannot know which lines were entered by amount.
 */
export function isTotalWithinTolerance(
  expectedTotalSYP: MoneyInput,
  actualTotalSYP: MoneyInput,
  unitPricesSYP: string[]
): boolean {
  const tolerance = toDecimal(invoiceTotalTolerance(unitPricesSYP));
  const diff = toDecimal(expectedTotalSYP)
    .minus(toDecimal(actualTotalSYP))
    .abs();
  return diff.lessThanOrEqualTo(tolerance);
}

/**
 * Rounds a monetary value to a whole lira (zero decimal places), HALF_UP,
 * using this module's decimal.js wrapper (ROUND_HALF_UP). Used to freeze the
 * SYP amount at subscription-request time: priceUSD × exchangeRate, rounded
 * to a whole lira, never a native JS number and never client-supplied.
 *
 * Returns a Decimal string with no fractional part (e.g. "172500").
 */

//  NOTE: pass the RAW product(priceUSD × rate) to avoid double rounding.The
//  intermediate multiplyMoney() already rounds to 4 dp; with $10 / $100 and a
//  4 - dp rate this is exact, but keep the order "multiply, then round once".
export function roundToWholeLira(value: MoneyInput): string {
  return toDecimal(value).toFixed(0);
}