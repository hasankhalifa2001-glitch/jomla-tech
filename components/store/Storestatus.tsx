import styles from "./store.module.css";
import { cx } from "./cx";
import { cairo } from "./font";
import Link from "next/link";

/**
 * The two non-catalog states: unknown slug, and "هذا المتجر غير متاح حالياً"
 * (tenant EXPIRED/PENDING — D7: a closed store shows NO catalog data at all).
 * Both render with HTTP 200; every store page is noindex.
 */
function StatusShell({
    tone,
    icon,
    title,
    text,
    children,
}: {
    tone: string;
    icon: React.ReactNode;
    title: string;
    text: string;
    children?: React.ReactNode;
}) {
    return (
        <main className={cx(styles.store, cairo.className, styles.statusPage)}>
            <div className={styles.statusCard}>
                <div className={cx(styles.statusIcon, tone)} aria-hidden="true">
                    {icon}
                </div>
                <h1>{title}</h1>
                <p>{text}</p>
                {children}
            </div>
        </main>
    );
}

const storeIcon = (
    <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 9l1.5-5h15L21 9" />
        <path d="M4 9v11h16V9" />
        <path d="M9 20v-6h6v6" />
    </svg>
);
const closedIcon = (
    <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5M12 16h.01" />
    </svg>
);

export function StoreNotFound({ slug }: { slug: string }) {
    return (
        <StatusShell
            tone={styles.statusAmber}
            icon={storeIcon}
            title="المتجر غير موجود"
            text={`لم يتم العثور على أي متجر مسجل تحت الرابط (${slug}).`}
        >
            <Link className={styles.btnLink} href="/">
                الصفحة الرئيسية
            </Link>
        </StatusShell>
    );
}

export function StoreUnavailable() {
    return (
        <StatusShell
            tone={styles.statusSlate}
            icon={closedIcon}
            title="هذا المتجر غير متاح حالياً"
            text="نعتذر، المتجر غير متاح للطلبات في الوقت الحالي. يُرجى المحاولة لاحقاً."
        />
    );
}