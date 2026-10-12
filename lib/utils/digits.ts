/**
 * lib/utils/digits.ts
 *
 * The ONE switch for digit style outside the dashboard (the POS screen uses it
 * today). Arabic-Indic digits made a zero look like a bullet ("٠" → "•"), a one
 * look like a bar ("١" → "I") — fatal on a screen where a cashier reads totals
 * at a glance. Amounts still come from formatMoney() (the single source of
 * truth for money); only the digit glyphs are localised on top of it.
 *
 * When the whole app settles on one digit style, change formatMoney() itself
 * and delete localizeDigits(). The dashboard (analytics-client.tsx) has its own
 * copy of the same switch — it can import from here to keep a single one.
 */

import { formatMoney } from "@/lib/utils/money";

export const USE_LATIN_DIGITS: boolean = true;
export const NUMBER_LOCALE = USE_LATIN_DIGITS ? "ar-SY-u-nu-latn" : "ar-SY";

const intFormatter = new Intl.NumberFormat(NUMBER_LOCALE);
const qtyFormatter = new Intl.NumberFormat(NUMBER_LOCALE, { maximumFractionDigits: 4 });

/** Whatever formatMoney() accepts as its first argument. */
export type MoneyInput = Parameters<typeof formatMoney>[0];

/** Arabic-Indic digits / separators → Latin. Safe on any string. */
export function localizeDigits(s: string): string {
    if (!USE_LATIN_DIGITS) return s;
    return s
        .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
        .replace(/\u066C/g, ",")
        .replace(/\u066B/g, ".");
}

/** formatMoney() + the digit switch. Number only — the unit is rendered by <Money>. */
export const fmtMoney = (value: MoneyInput, currency: "SYP" | "USD") =>
    localizeDigits(formatMoney(value, currency));

/** A whole number (counts) — display-only. */
export const fmtInt = (n: number) => intFormatter.format(n);

/** A QUANTITY (not money) — display-only; trailing zeros dropped. */
export function fmtQty(value: number | string): string {
    const n = Number(value);
    return Number.isFinite(n) ? qtyFormatter.format(n) : String(value);
}