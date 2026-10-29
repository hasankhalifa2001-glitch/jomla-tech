/**
 * lib/ledger/previous-debts.ts
 *
 * Pure helpers behind the previous-debts entry screen (no React, no I/O), so
 * every rule the spec lists can be unit-tested in the node test environment:
 * amount parsing, duplicate hints, the beforeunload decision and the
 * retry-reuses-the-same-key behaviour.
 *
 * Money rules: SYP only; every parse/compare goes through lib/utils/money.ts,
 * never native numbers. No USD anywhere in this feature.
 */

import { compareMoney, serializeMoney } from "@/lib/utils/money";
import { normalizeArabic } from "@/lib/utils/arabic-search";
import { normalizePhone } from "@/lib/utils/phone";

export type RowStatus = "queued" | "saving" | "saved" | "failed";

/** Max fractional digits of the Decimal(18,4) column. */
const MAX_DECIMALS = 4;

/**
 * Turn whatever the merchant typed into a clean ASCII amount string while
 * typing: Arabic-Indic / Persian digits become ASCII, the Arabic decimal mark
 * becomes ".", thousands separators and spaces are dropped, and EVERY other
 * character (letters, signs, symbols) is rejected. At most one "." and four
 * decimals survive.
 */
export function sanitizeAmountInput(raw: string): string {
    const ascii = raw
        .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
        .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
        .replace(/\u066B/g, ".");
    let s = ascii.replace(/[^\d.]/g, "");
    const firstDot = s.indexOf(".");
    if (firstDot !== -1) {
        s = s.slice(0, firstDot + 1) + s.slice(firstDot + 1).replace(/\./g, "").slice(0, MAX_DECIMALS);
    }
    return s;
}

/**
 * Parse typed text into a canonical money string (via serializeMoney), or null
 * when it is empty, malformed or not strictly positive. Direction (increase /
 * decrease) of a CORRECTION is applied by the caller, never typed here.
 */
export function parseAmountInput(raw: string): string | null {
    const s = sanitizeAmountInput(raw);
    if (!s || s === ".") return null;
    const normalized = (s.startsWith(".") ? `0${s}` : s).replace(/\.$/, "");
    try {
        const amount = serializeMoney(normalized);
        return compareMoney(amount, "0") > 0 ? amount : null;
    } catch {
        return null;
    }
}

/** True while ANY row is queued, saving or failed — drives beforeunload. */
export function hasUnsavedEntries(rows: ReadonlyArray<{ status: RowStatus }>): boolean {
    return rows.some((r) => r.status === "queued" || r.status === "saving" || r.status === "failed");
}

/**
 * A retry re-queues the SAME row: the idempotencyKey is never regenerated, so
 * a request that actually reached the server the first time is recognised as a
 * replay instead of recording the debt twice.
 */
export function markForRetry<T extends { status: RowStatus; error?: string }>(row: T): T {
    return { ...row, status: "queued", error: undefined };
}

/** Customers whose name or shop contains the typed text (Arabic-normalized). */
export function filterSuggestions<T extends { name: string; shopName: string | null }>(
    query: string,
    customers: readonly T[],
    limit = 6
): T[] {
    const q = normalizeArabic(query).trim();
    if (!q) return [];
    return customers
        .filter(
            (c) =>
                normalizeArabic(c.name).includes(q) ||
                (c.shopName ? normalizeArabic(c.shopName).includes(q) : false)
        )
        .slice(0, limit);
}

/**
 * Non-blocking hint (D7): an existing customer whose name equals the typed
 * name after Arabic normalization and trimming. Never prevents saving.
 */
export function findDuplicateByName<T extends { name: string }>(
    typedName: string,
    customers: readonly T[]
): T | null {
    const typed = normalizeArabic(typedName).trim();
    if (!typed) return null;
    return customers.find((c) => normalizeArabic(c.name).trim() === typed) ?? null;
}

/**
 * Non-blocking hint (D7): an existing customer whose NORMALIZED phone equals
 * the typed one (family shops share numbers, so this only ever warns).
 */
export function findDuplicateByPhone<T extends { phone: string | null }>(
    typedPhone: string,
    customers: readonly T[]
): T | null {
    if (!typedPhone.trim()) return null;
    const typed = normalizePhone(typedPhone);
    if (!typed) return null;
    return customers.find((c) => (c.phone ? normalizePhone(c.phone) === typed : false)) ?? null;
}