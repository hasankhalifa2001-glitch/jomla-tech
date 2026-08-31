import Decimal from "decimal.js";

/**
 * ============================================================================
 * lib/utils/money.ts — single shared wrapper around decimal.js for every
 * monetary operation used by T4a (Dexie storage) / T4b (cart math) / T4c
 * (sync-time server conversion) / T4e (ledger balance computation).
 *
 * No call site anywhere in the codebase should construct a `Decimal`
 * directly or `import Decimal from "decimal.js"` on its own — always go
 * through this module, so rounding/precision behavior (and error
 * behavior — see below) stays identical across the cart, the offline
 * queue, and the ledger.
 *
 * FAIL-LOUD, NOT FAIL-SILENT:
 * This is financial code. A silently-wrong number (a swallowed NaN, an
 * invalid input coerced to 0, a divide-by-zero coerced to 0) is strictly
 * worse than a thrown error, because it looks like a normal, valid amount
 * everywhere downstream — on an invoice total, a debt balance, a synced
 * payment row — right up until someone notices the books don't add up.
 * Every function below throws a `MoneyError` rather than returning a
 * plausible-looking-but-wrong value for any input it cannot trust.
 * ============================================================================
 */

// Isolated Decimal constructor — NOT `Decimal.set()` on the imported
// module. `Decimal.set()` mutates decimal.js's global/default constructor,
// so it would silently change rounding/precision behavior for any other
// code in the project that does `import Decimal from "decimal.js"`
// directly (accidentally or otherwise), even though this file is meant to
// be the sole owner of that configuration. `Decimal.clone()` produces an
// independent constructor scoped to this module only.
const Money = Decimal.clone({
  precision: 20,
  rounding: Decimal.ROUND_HALF_UP,
});

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

function isMoneyDecimalInstance(value: unknown): value is MoneyDecimal {
  return value instanceof Money;
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
    return value;
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
 * storage (Dexie / API).
 */
export function serializeMoney(value: MoneyInput): string {
  return toDecimal(value).toFixed(4);
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
 * Converts an amount between USD and SYP using an exchange rate (USD to SYP).
 * Throws MoneyError on a zero/invalid exchange rate rather than silently
 * returning the un-converted amount — a zero rate reaching this function
 * is a bug (T4b's checkout flow must never allow a sale with no cached
 * rate — see T1 acceptance criteria), and silently skipping the
 * conversion would produce a plausible-looking number in the wrong
 * currency (e.g. "18.5" shown where "277500" was meant), which is far
 * harder to catch than an explicit failure.
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

  const decAmount = toDecimal(amount);
  if (fromCurrency === "USD" && toCurrency === "SYP") {
    return decAmount.times(rate).toFixed(4);
  }
  if (fromCurrency === "SYP" && toCurrency === "USD") {
    return decAmount.dividedBy(rate).toFixed(4);
  }

  // Unreachable given the "USD" | "SYP" union, but keeps this function
  // fail-loud rather than silently falling through if the type ever widens.
  throw new MoneyError(`Unsupported currency pair: ${fromCurrency} -> ${toCurrency}.`);
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
 */
export function formatMoney(
  amount: MoneyInput,
  currency: "USD" | "SYP" = "USD",
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