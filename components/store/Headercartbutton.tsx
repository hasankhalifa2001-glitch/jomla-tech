"use client";

import styles from "./store.module.css";
import { useCart } from "./Cart";
import { CartIcon } from "./Icons";
import { fmtInt } from "@/lib/utils/digits";

/** The cart button in the hero's top bar (opens the drawer). */
export function HeaderCartButton() {
    const cart = useCart();
    return (
        <button
            type="button"
            className={styles.cartbtn}
            onClick={() => cart.setOpen(true)}
            aria-label="عرض طلبي"
        >
            <CartIcon />
            <span className={styles.cartLabel}>طلبي</span>
            {cart.ready && cart.count > 0 && (
                // key re-mounts the badge on every change, so it bumps.
                <span key={cart.count} className={styles.badge}>
                    {fmtInt(cart.count)}
                </span>
            )}
        </button>
    );
}