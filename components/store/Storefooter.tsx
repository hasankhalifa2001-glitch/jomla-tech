import styles from "./store.module.css";
import { cx } from "./cx";
import type { StoreInfoDTO } from "./types";

export function StoreFooter({ store }: { store: StoreInfoDTO }) {
    const initial = store.name.trim().charAt(0) || "م";
    return (
        <footer className={styles.foot}>
            <div className={cx(styles.wrap, styles.fgrid)}>
                <div className={styles.fbrand}>
                    <span className={styles.fmark}>{initial}</span>
                    {store.name}
                </div>
                <small>
                    متجر مبني على <a href={store.platformHref}>جملة تك</a>
                </small>
            </div>
        </footer>
    );
}