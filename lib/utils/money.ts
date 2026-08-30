import Decimal from "decimal.js";

// Set default Decimal configuration for monetary calculations
Decimal.set({
  precision: 20,
  rounding: Decimal.ROUND_HALF_UP,
});

export type MoneyInput = string | number | Decimal;

/**
 * Safely converts any money input into a Decimal instance.
 */
export function toDecimal(value: MoneyInput): Decimal {
  if (value instanceof Decimal) {
    return value;
  }
  if (typeof value === "number") {
    return new Decimal(value.toString());
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return new Decimal("0");
    return new Decimal(trimmed);
  }
  return new Decimal("0");
}

/**
 * Serializes any monetary value to a string representation for safe DB storage (Dexie / API).
 */
export function serializeMoney(value: MoneyInput): string {
  return toDecimal(value).toFixed(4);
}

/**
 * Adds two monetary values and returns the result as a Decimal string.
 */
export function addMoney(a: MoneyInput, b: MoneyInput): string {
  return toDecimal(a).plus(toDecimal(b)).toFixed(4);
}

/**
 * Subtracts value b from value a and returns the result as a Decimal string.
 */
export function subtractMoney(a: MoneyInput, b: MoneyInput): string {
  return toDecimal(a).minus(toDecimal(b)).toFixed(4);
}

/**
 * Multiplies two monetary values (e.g. price * quantity) and returns a Decimal string.
 */
export function multiplyMoney(a: MoneyInput, b: MoneyInput): string {
  return toDecimal(a).times(toDecimal(b)).toFixed(4);
}

/**
 * Divides value a by value b and returns a Decimal string.
 */
export function divideMoney(a: MoneyInput, b: MoneyInput): string {
  const divisor = toDecimal(b);
  if (divisor.isZero()) {
    return "0.0000";
  }
  return toDecimal(a).dividedBy(divisor).toFixed(4);
}

/**
 * Converts an amount between USD and SYP using exchange rate (USD to SYP).
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
  if (rate.isZero()) {
    return serializeMoney(amount);
  }
  const decAmount = toDecimal(amount);
  if (fromCurrency === "USD" && toCurrency === "SYP") {
    return decAmount.times(rate).toFixed(4);
  }
  if (fromCurrency === "SYP" && toCurrency === "USD") {
    return decAmount.dividedBy(rate).toFixed(4);
  }
  return serializeMoney(amount);
}

/**
 * Compares two monetary values. Returns -1 if a < b, 0 if a == b, 1 if a > b.
 */
export function compareMoney(a: MoneyInput, b: MoneyInput): number {
  return toDecimal(a).comparedTo(toDecimal(b));
}

/**
 * Formats a monetary value for display (rounds to specified decimals, defaults to 2 for USD, 0 for SYP).
 */
export function formatMoney(
  amount: MoneyInput,
  currency: "USD" | "SYP" = "USD",
  decimals?: number
): string {
  const dec = toDecimal(amount);
  const targetDecimals = decimals ?? (currency === "SYP" ? 0 : 2);
  const rounded = dec.toFixed(targetDecimals);
  const parts = rounded.split(".");
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return parts.join(".");
}
