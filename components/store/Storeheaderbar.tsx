import styles from "./store.module.css";
import { cx } from "./cx";
import { PhoneIcon, SearchIcon, WhatsAppIcon } from "./Icons";
import { storePath } from "@/lib/utils/store-href";
import type { StoreInfoDTO } from "./types";
import { HeaderCartButton } from "./Headercartbutton";

/**
 * The compact header of the inner pages (products, cart): brand, a GET search
 * form that works without JavaScript, call / WhatsApp, and the cart button.
 * The home page keeps the full hero instead.
 */
export function StoreHeaderBar({
    store,
    defaultQuery = "",
}: {
    store: StoreInfoDTO;
    defaultQuery?: string;
}) {
    const initial = store.name.trim().charAt(0) || "م";
    return (
        <header className={styles.bar}>
            <div className={cx(styles.wrap, styles.barIn)}>
                <a className={styles.barBrand} href={storePath(store.slug)}>
                    <span className={styles.logo}>
                        {store.logoUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img className={styles.logoImg} src={store.logoUrl} alt="" />
                        ) : (
                            initial
                        )}
                    </span>
                    <span className={styles.bname}>{store.name}</span>
                </a>

                <form
                    className={styles.barSearch}
                    action={storePath(store.slug, "products")}
                    method="get"
                    role="search"
                >
                    <SearchIcon size={20} />
                    <input
                        type="search"
                        name="q"
                        defaultValue={defaultQuery}
                        placeholder="ابحث عن صنف بالاسم"
                        aria-label="بحث عن صنف"
                    />
                    <button type="submit">ابحث</button>
                </form>

                <div className={styles.tact}>
                    {store.phone && (
                        <a className={styles.ibtn} href={`tel:${store.phone}`} aria-label="اتصال بالتاجر">
                            <PhoneIcon />
                        </a>
                    )}
                    {store.whatsappNumber && (
                        <a
                            className={styles.ibtn}
                            href={`https://wa.me/${store.whatsappNumber}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            aria-label="واتساب"
                        >
                            <WhatsAppIcon />
                        </a>
                    )}
                    <HeaderCartButton />
                </div>
            </div>
        </header>
    );
}