"use client";

/**
 * components/store/cart.tsx
 *
 * The retailer's cart (T5a §6.7). State only — no network. Persisted in
 * localStorage keyed by the tenant slug; every storage access is wrapped in
 * try/catch and the first render is always empty (so server and client markup
 * agree), then hydrated in a deferred callback.
 *
 * Quantities are decimal STRINGS handled through lib/utils/money.ts (toDecimal);
 * line totals and per-currency totals use multiplyMoney / sumMoney. Native JS
 * numbers never touch a quantity or an amount. The cart never caps a quantity
 * at the displayed availability — the admin reconciles at approval (T5c).
 */

import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useState,
    type ReactNode,
} from "react";
import { multiplyMoney, sumMoney, toDecimal } from "@/lib/utils/money";
import { fmtMoney } from "@/lib/utils/digits";
import { STORE_MAX_LINES_PER_ORDER, STORE_MAX_QTY_PER_LINE } from "./limits";
import { lineKey } from "./keys";
import type { CartLine, CartLineBase, Confirmation } from "./types";


/** Valid quantity -> canonical decimal string (<= 4 dp, <= cap); otherwise null. */
export function normalizeQty(raw: string | number): string | null {
    try {
        const d = toDecimal(String(raw));
        if (!d.isFinite() || d.lte(0)) return null;
        const rounded = d.toDecimalPlaces(4);
        const cap = toDecimal(STORE_MAX_QTY_PER_LINE);
        return (rounded.gt(cap) ? cap : rounded).toString();
    } catch {
        return null;
    }
}

function addToQty(current: string, delta: number): string | null {
    try {
        return normalizeQty(toDecimal(current).plus(delta).toString());
    } catch {
        return null;
    }
}

export interface CartTotals {
    SYP: string | null;
    USD: string | null;
}

/** "24,740 ل.س + $ 12.50" — each currency on its own, never converted. */
export function formatTotals(t: CartTotals): string {
    const parts: string[] = [];
    if (t.SYP !== null) parts.push(`${fmtMoney(t.SYP, "SYP")} ل.س`);
    if (t.USD !== null) parts.push(`$ ${fmtMoney(t.USD, "USD")}`);
    return parts.join(" + ");
}

function sanitizeLines(input: unknown): CartLine[] {
    if (!Array.isArray(input)) return [];
    const out: CartLine[] = [];
    const seen = new Set<string>();
    for (const raw of input) {
        if (out.length >= STORE_MAX_LINES_PER_ORDER) break;
        if (!raw || typeof raw !== "object") continue;
        const l = raw as Record<string, unknown>;
        if (
            typeof l.productId !== "string" ||
            typeof l.unitId !== "string" ||
            typeof l.productName !== "string" ||
            typeof l.unitName !== "string" ||
            typeof l.price !== "string" ||
            (l.currency !== "SYP" && l.currency !== "USD") ||
            (typeof l.quantity !== "string" && typeof l.quantity !== "number")
        ) {
            continue;
        }
        const q = normalizeQty(l.quantity);
        const key = lineKey(l.productId, l.unitId);
        if (q === null || seen.has(key)) continue;
        seen.add(key);
        out.push({
            productId: l.productId,
            unitId: l.unitId,
            productName: l.productName,
            unitName: l.unitName,
            price: l.price,
            currency: l.currency,
            quantity: q,
        });
    }
    return out;
}

interface CartApi {
    slug: string;
    /** False until localStorage has been read (avoid flashing an empty cart). */
    ready: boolean;
    lines: CartLine[];
    count: number;
    totals: CartTotals;
    limitReached: boolean;
    qtyOf: (productId: string, unitId: string) => string | null;
    setQty: (base: CartLineBase, raw: string | number) => void;
    step: (base: CartLineBase, delta: 1 | -1) => void;
    clear: () => void;
    replaceAll: (lines: CartLine[]) => void;
    open: boolean;
    setOpen: (open: boolean) => void;
    /** One-line info shown at the top of the drawer (e.g. skipped reorder lines). */
    notice: string | null;
    setNotice: (notice: string | null) => void;
    confirmation: Confirmation | null;
    showConfirmation: (c: Confirmation) => void;
    dismissConfirmation: () => void;
}

const CartContext = createContext<CartApi | null>(null);

export function useCart(): CartApi {
    const ctx = useContext(CartContext);
    if (!ctx) throw new Error("useCart must be used inside <CartProvider> (StoreShell).");
    return ctx;
}

export function CartProvider({ slug, children }: { slug: string; children: ReactNode }) {
    const storageKey = `store:${slug}:cart`;
    const [lines, setLines] = useState<CartLine[]>([]);
    const [ready, setReady] = useState(false);
    const [open, setOpen] = useState(false);
    const [notice, setNotice] = useState<string | null>(null);
    const [confirmation, setConfirmation] = useState<Confirmation | null>(null);

    // Hydrate from localStorage in a deferred callback (same pattern the rest of
    // the project uses to avoid setState-in-effect cascades).
    useEffect(() => {
        let cleared = false;
        const id = setTimeout(() => {
            if (cleared) return;
            try {
                const raw = window.localStorage.getItem(storageKey);
                if (raw) setLines(sanitizeLines(JSON.parse(raw)));
            } catch {
                /* unavailable / corrupt storage -> start empty */
            }
            setReady(true);
        }, 0);
        return () => {
            cleared = true;
            clearTimeout(id);
        };
    }, [storageKey]);

    useEffect(() => {
        if (!ready) return;
        try {
            window.localStorage.setItem(storageKey, JSON.stringify(lines));
        } catch {
            /* ignore */
        }
    }, [lines, ready, storageKey]);

    const qtyOf = useCallback(
        (productId: string, unitId: string) =>
            lines.find((l) => l.productId === productId && l.unitId === unitId)?.quantity ?? null,
        [lines]
    );

    const setQty = useCallback((base: CartLineBase, raw: string | number) => {
        const q = normalizeQty(raw);
        setLines((prev) => {
            const i = prev.findIndex((l) => l.productId === base.productId && l.unitId === base.unitId);
            if (q === null) return i === -1 ? prev : prev.filter((_, idx) => idx !== i);
            if (i === -1) {
                if (prev.length >= STORE_MAX_LINES_PER_ORDER) return prev;
                return [...prev, { ...base, quantity: q }];
            }
            const copy = [...prev];
            copy[i] = { ...copy[i], quantity: q };
            return copy;
        });
    }, []);

    const step = useCallback(
        (base: CartLineBase, delta: 1 | -1) => {
            const current = lines.find((l) => l.productId === base.productId && l.unitId === base.unitId);
            const next = addToQty(current?.quantity ?? "0", delta);
            setQty(base, next ?? 0);
        },
        [lines, setQty]
    );

    const clear = useCallback(() => setLines([]), []);
    const replaceAll = useCallback((next: CartLine[]) => setLines(sanitizeLines(next)), []);

    const totals = useMemo<CartTotals>(() => {
        const syp: string[] = [];
        const usd: string[] = [];
        for (const l of lines) {
            const t = multiplyMoney(l.price, l.quantity);
            (l.currency === "USD" ? usd : syp).push(t);
        }
        return {
            SYP: syp.length ? sumMoney(syp) : null,
            USD: usd.length ? sumMoney(usd) : null,
        };
    }, [lines]);

    const handleSetOpen = useCallback((next: boolean) => {
        setOpen(next);
        if (!next) setNotice(null);
    }, []);

    const value = useMemo<CartApi>(
        () => ({
            slug,
            ready,
            lines,
            count: lines.length,
            totals,
            limitReached: lines.length >= STORE_MAX_LINES_PER_ORDER,
            qtyOf,
            setQty,
            step,
            clear,
            replaceAll,
            open,
            setOpen: handleSetOpen,
            notice,
            setNotice,
            confirmation,
            showConfirmation: setConfirmation,
            dismissConfirmation: () => setConfirmation(null),
        }),
        [
            slug,
            ready,
            lines,
            totals,
            qtyOf,
            setQty,
            step,
            clear,
            replaceAll,
            open,
            handleSetOpen,
            notice,
            confirmation,
        ]
    );

    return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}