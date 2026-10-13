"use client";

import styles from "./store.module.css";
import { useCart } from "./Cart";

/** The cart page's one action: open the drawer. */
export function CartOpenButton() {
    const cart = useCart();
    return (
        <button type="button" className={styles.btnLink} onClick={() => cart.setOpen(true)}>
            {cart.ready && cart.count > 0 ? "عرض طلبي" : "افتح طلبي"}
        </button>
    );
}