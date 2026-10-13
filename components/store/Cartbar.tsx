"use client";

import styles from "./store.module.css";
import { formatTotals, useCart } from "./Cart";
import { CartIcon } from "./Icons";
import { fmtInt } from "@/lib/utils/digits";

/** Sticky "عرض طلبي" bar: appears once the cart has a line. */
export function CartBar() {
    const cart = useCart();
    if (!cart.ready || cart.count === 0 || cart.open) return null;

    return (
        <button type="button" className={styles.cbar} onClick={() => cart.setOpen(true)}>
            <span className={styles.cbl}>
                <span className={styles.cbi}>
                    <CartIcon size={22} />
                    <span key={cart.count} className={styles.badge}>
                        {fmtInt(cart.count)}
                    </span>
                </span>
                <span>
                    <b>عرض طلبي</b>
                    <small>
                        {fmtInt(cart.count)} {cart.count === 1 ? "صنف" : "أصناف"}
                    </small>
                </span>
            </span>
            <span className={styles.cbtot}>{formatTotals(cart.totals)}</span>
        </button>
    );
}