"use client";

/**
 * lib/store/use-storefront-cart.ts
 *
 * T5a — the React binding for the storefront cart (§6.7). Holds the cart, the
 * remembered retailer details (D4) and the last submitted order in state, and
 * mirrors each one into localStorage under the TENANT-SLUG-namespaced key.
 *
 * All of the RULES (validation, per-currency totals, storage discipline) live
 * in lib/store/storefront-cart.ts so they are unit-testable without React; this
 * hook only wires state to that pure layer and to localStorage.
 *
 * It is a plain hook, not a context provider: the storefront renders the cart
 * as ONE drawer per page (components/store/cart-drawer.tsx), so a single
 * useStorefrontCart() instance owns the whole cart for that page. The drawer is
 * opened by the header trigger, which the same hook controls.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    addCartLine,
    cartTotalsByCurrency,
    clearCart,
    loadCart,
    loadLastOrder,
    loadRetailerDetails,
    removeCartLine,
    saveCart,
    saveLastOrder,
    saveRetailerDetails,
    setCartLineQuantity,
    type CartLine,
    type LastOrder,
    type RetailerDetails,
} from "./storefront-cart";

export interface UseStorefrontCart {
    lines: CartLine[];
    lineCount: number;
    totals: ReturnType<typeof cartTotalsByCurrency>;
    retailer: RetailerDetails;
    /** True once the remembered details have been read from localStorage. */
    retailerLoaded: boolean;
    lastOrder: LastOrder | null;
    /** The most recent Arabic status message from a cart mutation. */
    message: string | null;

    add: (line: CartLine) => void;
    setQuantity: (productId: string, unitId: string, quantity: string) => void;
    remove: (productId: string, unitId: string) => void;
    clear: () => void;

    /**
     * Replace the whole cart with a new line set (used by "reorder my last
     * order"). Persists to localStorage like every other mutation.
     */
    replaceAll: (lines: CartLine[]) => void;

    /** Save the remembered retailer details (D4 — after a successful order). */
    rememberRetailer: (details: RetailerDetails) => void;
    /** Forget the remembered details — the "مو أنا / تغيير" control (D4). */
    forgetRetailer: () => void;
    /** Save the submitted lines for "أعد طلبي الأخير" (§6.7). */
    rememberLastOrder: (order: LastOrder) => void;
}

const EMPTY_RETAILER: RetailerDetails = { name: "", phone: "", shopName: "" };

export function useStorefrontCart(slug: string): UseStorefrontCart {
    const [lines, setLines] = useState<CartLine[]>([]);
    const [retailer, setRetailer] = useState<RetailerDetails>(EMPTY_RETAILER);
    const [retailerLoaded, setRetailerLoaded] = useState(false);
    const [lastOrder, setLastOrder] = useState<LastOrder | null>(null);
    const [message, setMessage] = useState<string | null>(null);
    /**
     * Guards the cart-mirroring effect below: it must not fire before the
     * hydration effect has run, or it would overwrite a persisted cart with the
     * initial empty state on every mount.
     */
    const [hydrated, setHydrated] = useState(false);

    // Hydrate ONCE per slug. Every read is try/catch-guarded in the pure layer,
    // so a storefront with storage disabled simply starts empty.
    //
    // The setters are called from the async-adjacent effect body rather than
    // synchronously deriving state during render: localStorage is not available
    // during SSR, so the values can only be known after mount.
    useEffect(() => {
        const load = () => {
            setLines(loadCart(slug));
            setRetailer(loadRetailerDetails(slug) ?? EMPTY_RETAILER);
            setRetailerLoaded(true);
            setLastOrder(loadLastOrder(slug));
            setMessage(null);
            setHydrated(true);
        };
        load();
    }, [slug]);

    // Mirror the cart to localStorage whenever it changes — but only AFTER
    // hydration, so the first run never clobbers the stored value.
    useEffect(() => {
        if (!hydrated) return;
        saveCart(slug, lines);
    }, [slug, lines, hydrated]);

    /**
     * A ref mirroring `lines` so `applyMutation` below can read the CURRENT
     * value without listing it as a dependency (which would recreate every
     * handler on each edit). Updated in an EFFECT, never during render — writing
     * a ref during render is exactly what react-hooks/refs forbids.
     */
    const linesRef = useRef(lines);
    useEffect(() => {
        linesRef.current = lines;
    }, [lines]);

    const applyMutation = useCallback(
        (
            mutate: (current: CartLine[]) => {
                lines: CartLine[];
                message: string;
                ok: boolean;
            }
        ) => {
            const result = mutate(linesRef.current);
            setLines(result.lines);
            setMessage(result.message);
        },
        []
    );

    const add = useCallback(
        (line: CartLine) => applyMutation((current) => addCartLine(current, line)),
        [applyMutation]
    );

    const setQuantity = useCallback(
        (productId: string, unitId: string, quantity: string) =>
            applyMutation((current) =>
                setCartLineQuantity(current, productId, unitId, quantity)
            ),
        [applyMutation]
    );

    const remove = useCallback(
        (productId: string, unitId: string) =>
            applyMutation((current) => removeCartLine(current, productId, unitId)),
        [applyMutation]
    );

    const clear = useCallback(() => {
        setLines([]);
        clearCart(slug);
        setMessage(null);
    }, [slug]);

    const replaceAll = useCallback(
        (next: CartLine[]) => {
            setLines(next);
            saveCart(slug, next);
            setMessage(
                next.length > 0 ? "تمت إعادة طلبك الأخير إلى السلة." : null
            );
        },
        [slug]
    );

    const rememberRetailer = useCallback(
        (details: RetailerDetails) => {
            setRetailer(details);
            saveRetailerDetails(slug, details);
        },
        [slug]
    );

    const forgetRetailer = useCallback(() => {
        setRetailer(EMPTY_RETAILER);
        setRetailerLoaded(true);
        saveRetailerDetails(slug, EMPTY_RETAILER);
    }, [slug]);

    const rememberLastOrder = useCallback(
        (order: LastOrder) => {
            setLastOrder(order);
            saveLastOrder(slug, order);
        },
        [slug]
    );

    const totals = useMemo(() => cartTotalsByCurrency(lines), [lines]);

    return {
        lines,
        lineCount: lines.length,
        totals,
        retailer,
        retailerLoaded,
        lastOrder,
        message,
        add,
        setQuantity,
        remove,
        clear,
        replaceAll,
        rememberRetailer,
        forgetRetailer,
        rememberLastOrder,
    };
}
