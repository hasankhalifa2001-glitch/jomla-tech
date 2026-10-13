/**
 * lib/store/storefront-cart.ts
 *
 * T5a â€” the storefront cart's PURE logic: line model, validation, per-currency
 * totals, and the localStorage read/write helpers for the cart, the remembered
 * retailer details (D4) and the last submitted order (Â§6.7).
 *
 * Deliberately split from the React hook (useStorefrontCart) so every rule
 * here is unit-testable in the node vitest environment with a plain
 * Storage-like fake â€” no jsdom, no React, no window.
 *
 * â”€â”€ MONEY â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
 * Every total goes through lib/utils/money.ts (decimal.js). NEVER a native JS
 * number, and NEVER any currency conversion: SYP-priced and USD-priced lines
 * are summed SEPARATELY and shown side by side (Â§6.7). A tenant's daily rate
 * is used ONLY for a card's courtesy "â‰ˆ N Ù„.Ø³" caption â€” it must never
 * silently merge two currencies into one total.
 *
 * â”€â”€ STORAGE DISCIPLINE (Â§6.7) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
 *   - Every key is namespaced BY TENANT SLUG, so two stores open in one browser
 *     can never see each other's cart.
 *   - EVERY localStorage access is wrapped in try/catch and degrades to
 *     "empty" â€” Safari private mode and a full quota throw on access, and a
 *     storefront must still work (in-memory only) when they do.
 *   - Everything read back is RE-VALIDATED, because localStorage is writable
 *     via devtools and may hold a value written by an older build.
 */

import {
    STORE_MAX_LINES_PER_ORDER,
    STORE_MAX_QTY_PER_LINE,
} from "@/lib/config/storefront";
import {
    addMoney,
    compareMoney,
    multiplyMoney,
    serializeMoney,
} from "@/lib/utils/money";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A currency, exactly as ProductUnit.pricingCurrency spells it. */
export type StorefrontCurrency = "SYP" | "USD";

/** One cart line: a (product, unit) pair with a quantity (> 0, â‰¤ cap). */
export interface CartLine {
    productId: string;
    unitId: string;
    /** Decimal string in the sale unit `unitId`. Up to 4 dp. */
    quantity: string;
    // --- display snapshots, copied off the card when the line was added ---
    productName: string;
    unitName: string;
    /** Decimal string in `pricingCurrency`. Display only â€” the server re-reads. */
    priceWholesale: string;
    pricingCurrency: StorefrontCurrency;
    imageUrl: string | null;
}

/** The remembered retailer details (D3/D4). Phone is stored NORMALIZED. */
export interface RetailerDetails {
    name: string;
    /** Normalized "09XXXXXXXX". */
    phone: string;
    /** Optional shop name (D3). */
    shopName: string;
}

/**
 * The last submitted order, for "Ø£Ø¹Ø¯ Ø·Ù„Ø¨ÙŠ Ø§Ù„Ø£Ø®ÙŠØ±" (Â§6.7). Only the identifiers
 * needed to re-add the lines are kept â€” no prices, no retailer details.
 */
export interface LastOrder {
    orderRef: string;
    lines: Array<{ productId: string; unitId: string; quantity: string }>;
}

/** Per-currency totals â€” two independent sums, never merged (Â§6.7). */
export interface CartTotalsByCurrency {
    SYP: string;
    USD: string;
    /** True when at least one line is SYP-priced (lets the UI omit an empty row). */
    hasSYP: boolean;
    hasUSD: boolean;
}

// ---------------------------------------------------------------------------
// Storage keys â€” always namespaced by tenant slug
// ---------------------------------------------------------------------------

const KEY_PREFIX = "jomla:store";

export function cartStorageKey(slug: string): string {
    return `${KEY_PREFIX}:cart:${slug}`;
}

export function retailerStorageKey(slug: string): string {
    return `${KEY_PREFIX}:retailer:${slug}`;
}

export function lastOrderStorageKey(slug: string): string {
    return `${KEY_PREFIX}:last-order:${slug}`;
}

// ---------------------------------------------------------------------------
// Validation (pure)
// ---------------------------------------------------------------------------

const QUANTITY_REGEX = /^\d+(\.\d{1,4})?$/;

export interface QuantityCheck {
    ok: boolean;
    /** Arabic message when not ok. */
    error?: string;
}

/**
 * A quantity is valid when it is a plain decimal, > 0, at most 4 decimal
 * places (matching B2BOrderRequestItem.quantity's DECIMAL(18,4)) and at most
 * STORE_MAX_QTY_PER_LINE (D6). All comparisons go through money.ts /
 * decimal.js â€” a native JS number would lose precision past 2^53.
 */
export function checkQuantity(raw: string): QuantityCheck {
    const value = raw.trim();
    if (!value) return { ok: false, error: "Ø£Ø¯Ø®Ù„ Ø§Ù„ÙƒÙ…ÙŠØ©." };
    if (!QUANTITY_REGEX.test(value)) {
        return {
            ok: false,
            error: "Ø§Ù„ÙƒÙ…ÙŠØ© ÙŠØ¬Ø¨ Ø£Ù† ØªÙƒÙˆÙ† Ø±Ù‚Ù…Ø§Ù‹ Ø¨ØµÙŠØºØ© ØµØ­ÙŠØ­Ø© (Ø­ØªÙ‰ 4 Ø®Ø§Ù†Ø§Øª Ø¹Ø´Ø±ÙŠØ©).",
        };
    }
    if (compareMoney(value, 0) <= 0) {
        return { ok: false, error: "Ø§Ù„ÙƒÙ…ÙŠØ© ÙŠØ¬Ø¨ Ø£Ù† ØªÙƒÙˆÙ† Ø£ÙƒØ¨Ø± Ù…Ù† ØµÙØ±." };
    }
    if (compareMoney(value, STORE_MAX_QTY_PER_LINE) > 0) {
        return {
            ok: false,
            error: `Ø§Ù„ÙƒÙ…ÙŠØ© Ø§Ù„Ù‚ØµÙˆÙ‰ Ù„Ù„Ø³Ø·Ø± Ø§Ù„ÙˆØ§Ø­Ø¯ Ù‡ÙŠ ${STORE_MAX_QTY_PER_LINE}.`,
        };
    }
    return { ok: true };
}

/** The (product, unit) identity of a line â€” one line per pair (Â§6.7). */
export function lineKey(productId: string, unitId: string): string {
    return `${productId}|${unitId}`;
}

export interface CartMutationResult {
    lines: CartLine[];
    /** Arabic message describing what happened (added / updated / rejected). */
    message: string;
    ok: boolean;
}

/**
 * Add a line, or increase the existing (product, unit) line (Â§6.7: one line per
 * pair). Adding the same unit twice SUMS the quantities rather than replacing,
 * which is what a retailer expects from a second tap on the same unit â€” and the
 * SUM is re-validated against the per-line cap, so two taps can never smuggle
 * in more than STORE_MAX_QTY_PER_LINE.
 */
export function addCartLine(
    lines: readonly CartLine[],
    incoming: CartLine
): CartMutationResult {
    const quantityCheck = checkQuantity(incoming.quantity);
    if (!quantityCheck.ok) {
        return { lines: [...lines], message: quantityCheck.error!, ok: false };
    }

    const key = lineKey(incoming.productId, incoming.unitId);
    const existingIndex = lines.findIndex(
        (l) => lineKey(l.productId, l.unitId) === key
    );

    if (existingIndex >= 0) {
        const next = [...lines];
        const summed = serializeMoney(
            addMoney(next[existingIndex].quantity, incoming.quantity)
        );
        const sumCheck = checkQuantity(summed);
        if (!sumCheck.ok) {
            return { lines: next, message: sumCheck.error!, ok: false };
        }
        next[existingIndex] = { ...next[existingIndex], quantity: summed };
        return { lines: next, message: "ØªÙ… ØªØ­Ø¯ÙŠØ« Ø§Ù„ÙƒÙ…ÙŠØ© ÙÙŠ Ø§Ù„Ø³Ù„Ø©.", ok: true };
    }

    if (lines.length >= STORE_MAX_LINES_PER_ORDER) {
        return {
            lines: [...lines],
            message: `Ø§Ù„Ø­Ø¯ Ø§Ù„Ø£Ù‚ØµÙ‰ ${STORE_MAX_LINES_PER_ORDER} Ø³Ø·Ø± ÙÙŠ Ø§Ù„Ø·Ù„Ø¨ Ø§Ù„ÙˆØ§Ø­Ø¯.`,
            ok: false,
        };
    }

    return {
        lines: [...lines, { ...incoming, quantity: serializeMoney(incoming.quantity) }],
        message: "ØªÙ…Øª Ø§Ù„Ø¥Ø¶Ø§ÙØ© Ø¥Ù„Ù‰ Ø§Ù„Ø³Ù„Ø©.",
        ok: true,
    };
}

/**
 * Replace one line's quantity. An invalid quantity removes the line instead â€”
 * an empty quantity box means "take it out", which is the least surprising
 * behavior for a retailer clearing a field.
 */
export function setCartLineQuantity(
    lines: readonly CartLine[],
    productId: string,
    unitId: string,
    quantity: string
): CartMutationResult {
    const key = lineKey(productId, unitId);
    const check = checkQuantity(quantity);
    if (!check.ok) {
        return {
            lines: lines.filter((l) => lineKey(l.productId, l.unitId) !== key),
            message: "ØªÙ… Ø­Ø°Ù Ø§Ù„Ø³Ø·Ø± Ù…Ù† Ø§Ù„Ø³Ù„Ø©.",
            ok: true,
        };
    }
    return {
        lines: lines.map((l) =>
            lineKey(l.productId, l.unitId) === key
                ? { ...l, quantity: serializeMoney(quantity) }
                : l
        ),
        message: "ØªÙ… ØªØ­Ø¯ÙŠØ« Ø§Ù„ÙƒÙ…ÙŠØ©.",
        ok: true,
    };
}

/** Remove one line entirely. */
export function removeCartLine(
    lines: readonly CartLine[],
    productId: string,
    unitId: string
): CartMutationResult {
    const key = lineKey(productId, unitId);
    return {
        lines: lines.filter((l) => lineKey(l.productId, l.unitId) !== key),
        message: "ØªÙ… Ø­Ø°Ù Ø§Ù„Ø³Ø·Ø± Ù…Ù† Ø§Ù„Ø³Ù„Ø©.",
        ok: true,
    };
}

/**
 * "Reorder my last order" (spec 6.7) — rebuild the cart from the last submitted
 * order. Pure and client-side only: NO network request is made. `catalog` is
 * the set of lines VISIBLE on the current page (product + unit pairs the page
 * already hydrated), keyed by lineKey. Each last-order line whose pair is
 * still in `catalog` is re-added with its stored quantity; anything else
 * (unpublished, unit deactivated, or simply not on this page) is SILENTLY
 * SKIPPED and counted, and the caller tells the retailer how many were
 * skipped. The cart is REPLACED (not merged): the last order is the whole
 * order.
 *
 * Returns the new lines plus the skip count; the message is the Arabic line
 * the caller renders.
 */
export interface ReorderResult {
    lines: CartLine[];
    added: number;
    skipped: number;
    message: string;
}

export function reorderFromLastOrder(
    lastOrder: LastOrder,
    catalog: ReadonlyMap<string, Omit<CartLine, "quantity">>
): ReorderResult {
    let added = 0;
    let skipped = 0;
    const lines: CartLine[] = [];

    for (const entry of lastOrder.lines) {
        const key = lineKey(entry.productId, entry.unitId);
        const display = catalog.get(key);
        if (!display) {
            skipped += 1;
            continue;
        }
        if (!checkQuantity(entry.quantity).ok) {
            skipped += 1;
            continue;
        }
        if (lines.length >= STORE_MAX_LINES_PER_ORDER) {
            skipped += lastOrder.lines.length - added - skipped;
            break;
        }
        lines.push({
            ...display,
            quantity: serializeMoney(entry.quantity),
        });
        added += 1;
    }

    return { lines, added, skipped, message: "" };
}

/**
 * Per-currency totals (Â§6.7). SYP and USD are summed INDEPENDENTLY and never
 * converted into one another â€” a mixed-currency order shows two totals, because
 * the final lira price of a USD line is set by the merchant at confirmation.
 */
export function cartTotalsByCurrency(
    lines: readonly CartLine[]
): CartTotalsByCurrency {
    let syp = "0.0000";
    let usd = "0.0000";
    let hasSYP = false;
    let hasUSD = false;

    for (const line of lines) {
        const lineTotal = multiplyMoney(line.priceWholesale, line.quantity);
        if (line.pricingCurrency === "USD") {
            usd = addMoney(usd, lineTotal);
            hasUSD = true;
        } else {
            syp = addMoney(syp, lineTotal);
            hasSYP = true;
        }
    }

    return { SYP: syp, USD: usd, hasSYP, hasUSD };
}


// ---------------------------------------------------------------------------
// Safe localStorage access (Â§6.7: every access in try/catch, correct when empty)
// ---------------------------------------------------------------------------

/**
 * The narrow slice of `Storage` these helpers need, so the node tests can pass
 * a plain object instead of a real `window.localStorage`.
 */
export interface StorageLike {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}

/**
 * Resolve the browser's localStorage, or null when it is unavailable or
 * throws. Safari private mode throws on the property ACCESS itself, and a full
 * quota throws on setItem â€” both must degrade to "no persistence" rather than
 * break the storefront.
 */
export function getSafeStorage(): StorageLike | null {
    try {
        if (typeof window === "undefined") return null;
        const storage = window.localStorage;
        // Probe: private mode can hand back an object whose every method throws.
        storage.getItem(KEY_PREFIX);
        return storage;
    } catch {
        return null;
    }
}

/** Read + JSON.parse, returning null on any failure. Never throws. */
function readJson<T>(storage: StorageLike | null, key: string): T | null {
    if (!storage) return null;
    try {
        const raw = storage.getItem(key);
        if (!raw) return null;
        return JSON.parse(raw) as T;
    } catch {
        return null;
    }
}

/** JSON.stringify + write, swallowing quota/security errors. Never throws. */
function writeJson(
    storage: StorageLike | null,
    key: string,
    value: unknown
): void {
    if (!storage) return;
    try {
        storage.setItem(key, JSON.stringify(value));
    } catch {
        // Quota exceeded or storage disabled: the in-memory state is still
        // correct for this session, so there is nothing useful to do here.
    }
}

function asTrimmedString(value: unknown, maxLength: number): string {
    if (typeof value !== "string") return "";
    return value.trim().slice(0, maxLength);
}

// ---------------------------------------------------------------------------
// Cart persistence
// ---------------------------------------------------------------------------

/**
 * Re-validate one stored line. A line that fails ANY check is dropped rather
 * than trusted: localStorage is writable via devtools and may hold a shape from
 * an older build. Quantity validity matters most â€” it is the value the server
 * will be asked to persist.
 */
function toCartLine(value: unknown): CartLine | null {
    if (!value || typeof value !== "object") return null;
    const row = value as Record<string, unknown>;

    const productId = asTrimmedString(row.productId, 64);
    const unitId = asTrimmedString(row.unitId, 64);
    const quantity = asTrimmedString(row.quantity, 24);
    const productName = asTrimmedString(row.productName, 200);
    const unitName = asTrimmedString(row.unitName, 100);
    const priceWholesale = asTrimmedString(row.priceWholesale, 32);

    if (!productId || !unitId || !productName || !unitName) return null;
    if (!checkQuantity(quantity).ok) return null;
    if (row.pricingCurrency !== "SYP" && row.pricingCurrency !== "USD") return null;

    return {
        productId,
        unitId,
        quantity: serializeMoney(quantity),
        productName,
        unitName,
        priceWholesale,
        pricingCurrency: row.pricingCurrency,
        imageUrl: asTrimmedString(row.imageUrl, 2048) || null,
    };
}

/** Read the cart for a tenant slug. Never throws; [] when absent/invalid. */
export function loadCart(
    slug: string,
    storage: StorageLike | null = getSafeStorage()
): CartLine[] {
    const raw = readJson<unknown>(storage, cartStorageKey(slug));
    if (!Array.isArray(raw)) return [];
    const lines: CartLine[] = [];
    for (const entry of raw) {
        const line = toCartLine(entry);
        if (line) lines.push(line);
        // Cap enforced on the way IN as well: a hand-edited storage value must
        // not be able to push an over-long order at the server.
        if (lines.length >= STORE_MAX_LINES_PER_ORDER) break;
    }
    return lines;
}

/** Persist the cart for a tenant slug. Never throws. */
export function saveCart(
    slug: string,
    lines: readonly CartLine[],
    storage: StorageLike | null = getSafeStorage()
): void {
    writeJson(storage, cartStorageKey(slug), lines);
}


// ---------------------------------------------------------------------------
// Remembered retailer details (D3/D4)
// ---------------------------------------------------------------------------

/**
 * Read the remembered retailer details for a tenant slug. Per D4 these are
 * written ONLY after a successful order and are used purely to prefill the form
 * next visit, behind an explicit "Ù…Ùˆ Ø£Ù†Ø§ / ØªØºÙŠÙŠØ±" control. The server never
 * looks anything up by phone and never returns this data to anyone else.
 */
export function loadRetailerDetails(
    slug: string,
    storage: StorageLike | null = getSafeStorage()
): RetailerDetails | null {
    const raw = readJson<unknown>(storage, retailerStorageKey(slug));
    if (!raw || typeof raw !== "object") return null;
    const row = raw as Record<string, unknown>;

    const name = asTrimmedString(row.name, 80);
    const phone = asTrimmedString(row.phone, 20);
    if (!name || !phone) return null;

    return { name, phone, shopName: asTrimmedString(row.shopName, 120) };
}

/** Persist the retailer details. Never throws. */
export function saveRetailerDetails(
    slug: string,
    details: RetailerDetails,
    storage: StorageLike | null = getSafeStorage()
): void {
    writeJson(storage, retailerStorageKey(slug), {
        name: details.name,
        phone: details.phone,
        shopName: details.shopName,
    });
}

// ---------------------------------------------------------------------------
// Last submitted order ("Ø£Ø¹Ø¯ Ø·Ù„Ø¨ÙŠ Ø§Ù„Ø£Ø®ÙŠØ±", Â§6.7)
// ---------------------------------------------------------------------------

/** Read the last submitted order for a tenant slug. Never throws. */
export function loadLastOrder(
    slug: string,
    storage: StorageLike | null = getSafeStorage()
): LastOrder | null {
    const raw = readJson<unknown>(storage, lastOrderStorageKey(slug));
    if (!raw || typeof raw !== "object") return null;
    const row = raw as Record<string, unknown>;
    if (!Array.isArray(row.lines)) return null;

    const lines: LastOrder["lines"] = [];
    for (const entry of row.lines) {
        if (!entry || typeof entry !== "object") continue;
        const line = entry as Record<string, unknown>;
        const productId = asTrimmedString(line.productId, 64);
        const unitId = asTrimmedString(line.unitId, 64);
        const quantity = asTrimmedString(line.quantity, 24);
        if (!productId || !unitId) continue;
        if (!checkQuantity(quantity).ok) continue;
        lines.push({ productId, unitId, quantity: serializeMoney(quantity) });
        if (lines.length >= STORE_MAX_LINES_PER_ORDER) break;
    }

    if (lines.length === 0) return null;
    return { orderRef: asTrimmedString(row.orderRef, 16), lines };
}

/** Persist the last submitted order. Never throws. */
export function saveLastOrder(
    slug: string,
    lastOrder: LastOrder,
    storage: StorageLike | null = getSafeStorage()
): void {
    writeJson(storage, lastOrderStorageKey(slug), lastOrder);
}

/**
 * Clear the cart after a successful submission (Â§6.7). The remembered retailer
 * details and the last order are deliberately KEPT â€” they are exactly what the
 * next visit prefill and "Ø£Ø¹Ø¯ Ø·Ù„Ø¨ÙŠ Ø§Ù„Ø£Ø®ÙŠØ±" need.
 */
export function clearCart(
    slug: string,
    storage: StorageLike | null = getSafeStorage()
): void {
    if (!storage) return;
    try {
        storage.removeItem(cartStorageKey(slug));
    } catch {
        // Nothing useful to do; the in-memory state is already empty.
    }
}
