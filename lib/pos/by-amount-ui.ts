/**
 * lib/pos/by-amount-ui.ts — pure helpers for the "sell by amount" (بيع بالمبلغ)
 * cart UI. No React, no DOM, no network, no Dexie: everything here is a plain
 * function of its arguments so it can be tested in the node environment.
 *
 * Parameter types are structural (a CartLineItem satisfies them), so this
 * module depends on money.ts only, never on the offline/Dexie layer.
 *
 * What is deliberately NOT here: any write to a cart line. Quantity and the
 * amount override are written ONLY by the funnel in lib/offline/pos-service.ts
 * (applyLineAmountOverride, setLineQuantity, clearLineOverride, ...). These
 * helpers parse what the cashier typed, format what the screen shows, and
 * describe a line — nothing more.
 *
 * Money and quantity text go through lib/utils/money.ts (serializeMoney); no
 * native `toFixed` and no arithmetic on a native number appear in this file.
 */

import { serializeMoney } from "@/lib/utils/money";

/** InvoiceItem / Invoice totals are Decimal(18,4): at most 14 integer digits. */
const MAX_INTEGER_DIGITS = 14;
/** Amounts and quantities carry at most 4 decimals (Decimal(18,4)). */
const MAX_DECIMALS = 4;

/** Arabic-Indic (٠-٩) and Eastern Arabic-Indic / Persian (۰-۹) digits -> ASCII. */
function toAsciiDigits(text: string): string {
    return text
        .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
        .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0));
}

/** Thousands separators we accept and discard: "," "٬" (U+066C) "،" (U+060C)
 * and any whitespace (including no-break spaces). AMOUNT field only. */
const THOUSANDS_SEPARATORS_RE = /[,٬،\s]/g;

/** Arabic decimal separator "٫" (U+066B) -> ".". */
const ARABIC_DECIMAL_SEPARATOR_RE = /٫/g;

/**
 * Comma-like characters ("," "٬" "،"). In a QUANTITY they are ambiguous
 * ("0,5" is half a kilo, "1,000" is a thousand pieces), so the quantity
 * parser rejects them instead of guessing. Exported so the UI can show the
 * right hint ("use the dot for fractions").
 *
 * No `g` flag on purpose: a global regex keeps `lastIndex` between `.test()`
 * calls and gives alternating results.
 */
export const AMBIGUOUS_COMMA_RE = /[,٬،]/;

/** Strips leading zeros but keeps one digit ("0005" -> "5", "000" -> "0"). */
function trimLeadingZeros(digits: string): string {
    return digits.replace(/^0+(?=\d)/, "");
}

/**
 * Shared tail of both parsers. Takes text that is ALREADY ASCII with "." as
 * the only possible decimal separator and no grouping characters, and returns
 * a normalized decimal string or null.
 *
 *  - At most ONE ".", at most 4 decimals, at most 14 integer digits.
 *  - A trailing separator ("5000.") parses as the integer; ".5" as "0.5".
 *  - Empty input, ".", letters, a second separator, a minus sign -> null.
 */
function parseNormalizedDecimal(normalized: string): string | null {
    const match = /^(\d*)(?:\.(\d*))?$/.exec(normalized);
    if (!match) return null;

    const integerRaw = match[1] ?? "";
    const fraction = match[2] ?? "";

    if (integerRaw === "" && fraction === "") return null;
    if (fraction.length > MAX_DECIMALS) return null;

    const integer = trimLeadingZeros(integerRaw) || "0";
    if (integer.length > MAX_INTEGER_DIGITS) return null;

    return fraction === "" ? integer : `${integer}.${fraction}`;
}

/**
 * Parses what the cashier typed in the AMOUNT field into a normalized ASCII
 * decimal string, or null when it is not a usable amount.
 *
 *  - ASCII, Arabic-Indic and Persian digits are accepted, mixed freely.
 *  - "," "٬" "،" and spaces are thousands separators and are discarded.
 *  - "." and "٫" are the decimal separator: at most ONE, at most 4 decimals.
 *    A trailing separator ("5000.") parses as the integer; ".5" as "0.5".
 *  - Empty input, ".", letters ("5000abc"), a second separator ("1.2.3"), a
 *    minus sign, more than 4 decimals, or more than 14 integer digits -> null.
 *
 * It does NOT judge the VALUE: "0" parses to "0" and the funnel rejects it
 * with its own Arabic message. The result is a string, never a number, so no
 * precision is lost before applyLineAmountOverride normalizes it to 4 dp.
 *
 * Do NOT use this for quantities: it deletes commas as thousands separators,
 * so "0,5" would become "5". Use parseQuantityInput.
 */
export function parseAmountInput(text: string): string | null {
    return parseNormalizedDecimal(
        toAsciiDigits(text)
            .replace(THOUSANDS_SEPARATORS_RE, "")
            .replace(ARABIC_DECIMAL_SEPARATOR_RE, ".")
    );
}

/**
 * Parses what the cashier typed in the QUANTITY field.
 *
 *  - "." and "٫" are the decimal separator; whitespace is ignored
 *    ("1 000" -> "1000").
 *  - A comma ("," "٬" "،") is AMBIGUOUS ("0,5" = half a kilo, or "1,000" =
 *    a thousand pieces?) and this codebase never guesses, so any comma makes
 *    the input invalid (null). The UI tells the cashier to use the dot.
 *  - Everything else follows parseNormalizedDecimal (max 4 decimals, max 14
 *    integer digits, no letters, no minus sign).
 *
 * Like parseAmountInput it does not judge the VALUE: "0" parses to "0" and
 * the field itself refuses quantities <= 0.
 */
export function parseQuantityInput(text: string): string | null {
    const ascii = toAsciiDigits(text)
        .replace(/\s/g, "")
        .replace(ARABIC_DECIMAL_SEPARATOR_RE, ".");
    if (AMBIGUOUS_COMMA_RE.test(ascii)) return null;
    return parseNormalizedDecimal(ascii);
}

/**
 * Formats the amount input while the cashier is still typing: ASCII digits,
 * "," thousands grouping, an optional decimal part (at most 4 decimals).
 * A trailing decimal separator is KEPT ("5000." -> "5,000.") so typing a
 * decimal point is never swallowed. Idempotent: formatting its own output
 * returns it unchanged. Anything that is not a digit or a separator is dropped.
 *
 * The field uses ASCII digits so the caret stays stable; money displayed
 * elsewhere keeps using formatMoney.
 */
export function formatAmountInputWhileTyping(text: string): string {
    const ascii = toAsciiDigits(text).replace(ARABIC_DECIMAL_SEPARATOR_RE, ".");
    const dotIndex = ascii.indexOf(".");
    const hasDot = dotIndex !== -1;

    const integerRaw = (hasDot ? ascii.slice(0, dotIndex) : ascii).replace(/\D/g, "");
    const fraction = hasDot
        ? ascii.slice(dotIndex + 1).replace(/\D/g, "").slice(0, MAX_DECIMALS)
        : "";

    if (!hasDot && integerRaw === "") return "";

    const integer = trimLeadingZeros(integerRaw).slice(0, MAX_INTEGER_DIGITS) || "0";
    const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return hasDot ? `${grouped}.${fraction}` : grouped;
}

/**
 * A quantity for display: up to 4 decimals, trailing zeros trimmed, NEVER
 * rounded below 4 dp (0.3333 stays "0.3333", not "0.333"). Built from
 * serializeMoney plus string trimming, not from toFixed on a native number,
 * so a float artifact such as 1.3333000000000002 still reads "1.3333".
 */
export function formatQuantityText(quantity: number | string): string {
    const fixed = serializeMoney(quantity);
    if (!fixed.includes(".")) return fixed;
    const trimmed = fixed.replace(/0+$/, "").replace(/\.$/, "");
    return trimmed === "" || trimmed === "-" ? "0" : trimmed;
}

export type LineMode = "amount" | "quantity";

/** "amount" iff the line carries an amount override; otherwise "quantity".
 * The override is the single source of truth for what a line's total means. */
export function lineMode(item: { lineTotalOverrideSYP?: string }): LineMode {
    return item.lineTotalOverrideSYP !== undefined ? "amount" : "quantity";
}

export interface AmountLineDescription {
    /** The typed amount, 4-dp decimal string. Format it with formatMoney. */
    amountSYP: string;
    /** The derived quantity, trimmed ("0.3333"). */
    quantityText: string;
    unitName: string;
}

/**
 * The pieces of the large "5,000 ل.س ← 0.3333 كغ" display for a line sold by
 * amount, or null for a line that is not (there is nothing to describe: its
 * total is simply quantity x price).
 */
export function describeAmountLine(item: {
    lineTotalOverrideSYP?: string;
    quantity: number;
    unitName: string;
}): AmountLineDescription | null {
    if (item.lineTotalOverrideSYP === undefined) return null;
    return {
        amountSYP: serializeMoney(item.lineTotalOverrideSYP),
        quantityText: formatQuantityText(item.quantity),
        unitName: item.unitName,
    };
}

/**
 * Quick weight buttons (D7) for base-unit lines. `quantity` is a decimal
 * STRING handed to setLineQuantity, so applying one exits amount mode and
 * clears any override.
 */
export const QUICK_WEIGHT_BUTTONS = [
    { label: "¼", quantity: "0.25" },
    { label: "½", quantity: "0.5" },
    { label: "1", quantity: "1" },
] as const;