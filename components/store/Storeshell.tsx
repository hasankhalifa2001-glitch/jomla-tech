"use client";

import type { ReactNode } from "react";
import { CartProvider } from "./Cart";
import { CartBar } from "./Cartbar";
import { CartDrawer } from "./Cartdrawer";
import { ConfirmScreen } from "./Confirmscreen";
import type { StoreInfoDTO } from "./types";

/**
 * Client boundary for everything that shares the cart: the provider, the
 * sticky bar, the drawer and the confirmation screen. Server-rendered page
 * content is passed in as children, so it stays a server component.
 */
export function StoreShell({ store, children }: { store: StoreInfoDTO; children: ReactNode }) {
    return (
        <CartProvider slug={store.slug}>
            {children}
            <CartBar />
            <CartDrawer store={store} />
            <ConfirmScreen store={store} />
        </CartProvider>
    );
}