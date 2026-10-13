import styles from "./store.module.css";
import { cx } from "./cx";
import { cairo } from "./font";
import { StoreShell } from "./Storeshell";
import { StoreHeaderBar } from "./Storeheaderbar";
import { StoreFooter } from "./Storefooter";
import { CartOpenButton } from "./Cartopenbutton";
import { CartIcon, ChevronLeftIcon } from "./Icons";
import { storePath } from "@/lib/utils/store-href";
import type { StoreInfoDTO } from "./types";

/** /cart: the cart itself is the drawer; this page is the link-able entry to it. */
export function CartPageView({ store }: { store: StoreInfoDTO }) {
    return (
        <div className={cx(styles.store, cairo.className)}>
            <StoreShell store={store}>
                <StoreHeaderBar store={store} />
                <main className={cx(styles.wrap, styles.pageMain)}>
                    <a className={styles.crumb} href={storePath(store.slug)}>
                        <ChevronLeftIcon size={16} />
                        الرئيسية
                    </a>
                    <div className={styles.cartPageCard}>
                        <div className={styles.noResIcon}>
                            <CartIcon size={28} />
                        </div>
                        <h1>طلبي</h1>
                        <p>راجع الأصناف والكميات ثم أرسل الطلب — التاجر بيتواصل معك على رقمك.</p>
                        <CartOpenButton />
                    </div>
                </main>
                <StoreFooter store={store} />
            </StoreShell>
        </div>
    );
}