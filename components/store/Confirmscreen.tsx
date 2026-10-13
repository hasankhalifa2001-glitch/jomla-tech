"use client";

import { useEffect, useState } from "react";
import styles from "./store.module.css";
import { useCart } from "./Cart";
import { CopyIcon, WhatsAppIcon } from "./Icons";
import { fmtInt, fmtMoney } from "@/lib/utils/digits";
import type { StoreInfoDTO } from "./types";

/**
 * Shown after a successful POST /api/store/orders. The WhatsApp button is a
 * user-initiated wa.me link (not a system notification) and exists only when
 * the wholesaler has a valid phone (store.whatsappNumber comes from
 * toWhatsAppNumber on the server — never build this URL from a raw phone).
 */
export function ConfirmScreen({ store }: { store: StoreInfoDTO }) {
    const { confirmation, dismissConfirmation } = useCart();
    const [copied, setCopied] = useState(false);

    useEffect(() => {
        if (!confirmation) return;
        const previous = document.body.style.overflow;
        document.body.style.overflow = "hidden";
        return () => {
            document.body.style.overflow = previous;
        };
    }, [confirmation]);

    if (!confirmation) return null;

    const { orderRef, retailerName, lineCount, totalSYP, totalUSD } = confirmation;

    const whatsappHref = store.whatsappNumber
        ? `https://wa.me/${store.whatsappNumber}?text=${encodeURIComponent(
            `السلام عليكم، أنا ${retailerName}. أرسلت طلباً من متجر ${store.name}، رقم الطلب: ${orderRef}`
        )}`
        : null;

    async function copyRef() {
        try {
            await navigator.clipboard.writeText(orderRef);
            setCopied(true);
            setTimeout(() => setCopied(false), 1600);
        } catch {
            /* clipboard unavailable — the reference is still on screen */
        }
    }

    return (
        <div className={styles.done} role="dialog" aria-modal="true" aria-label="تم إرسال الطلب">
            <div className={styles.doneTop}>
                <div className={styles.okwrap} aria-hidden="true">
                    <span className={styles.okring} />
                    <span className={`${styles.okring} ${styles.okring2}`} />
                    <span className={styles.okc}>
                        <svg
                            width="44"
                            height="44"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2.8"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        >
                            <path d="M5 12.5l4.5 4.5L19 7.5" />
                        </svg>
                    </span>
                </div>
                <h1>وصل طلبك</h1>
                <p>رح يراجعه التاجر ويتواصل معك على رقمك.</p>
            </div>

            <div className={styles.doneBody}>
                <div className={styles.ref}>
                    <div>
                        <small>رقم الطلب</small>
                        <b>{orderRef}</b>
                    </div>
                    <button type="button" className={styles.copybtn} onClick={copyRef}>
                        <CopyIcon />
                        {copied ? "تم النسخ" : "نسخ"}
                    </button>
                </div>

                <div className={styles.sum}>
                    <div className={styles.row}>
                        <span>الأصناف</span>
                        <b>
                            {fmtInt(lineCount)} {lineCount === 1 ? "صنف" : "أصناف"}
                        </b>
                    </div>
                    {totalSYP !== null && (
                        <div className={styles.row}>
                            <span>المجموع بالليرة</span>
                            <b>{fmtMoney(totalSYP, "SYP")} ل.س</b>
                        </div>
                    )}
                    {totalUSD !== null && (
                        <div className={styles.row}>
                            <span>المجموع بالدولار</span>
                            <b style={{ color: "var(--violet)" }}>$ {fmtMoney(totalUSD, "USD")}</b>
                        </div>
                    )}
                </div>

                {whatsappHref && (
                    <>
                        <p className={styles.next}>لتسريع المراجعة، ابعث الطلب كمان على واتساب برقم الطلب جاهز.</p>
                        <a className={styles.wa} href={whatsappHref} target="_blank" rel="noopener noreferrer">
                            <WhatsAppIcon size={22} />
                            أرسل الطلب على واتساب
                        </a>
                    </>
                )}

                <button type="button" className={styles.nw} onClick={dismissConfirmation}>
                    طلب جديد
                </button>
            </div>
        </div>
    );
}