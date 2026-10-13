"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import styles from "./store.module.css";
import { cx } from "./cx";
import { useCart } from "./Cart";
import { QtyInput } from "./Qtyinput";
import { submitStoreOrder } from "./submit";
import { ChevronLeftIcon, CloseIcon, InfoIcon, MinusIcon, PlusIcon, CartIcon } from "./Icons";
import { fmtInt, fmtMoney } from "@/lib/utils/digits";
import { multiplyMoney } from "@/lib/utils/money";
import type { StoreInfoDTO } from "./types";

interface Retailer {
    name: string;
    phone: string;
    shopName: string;
}

/**
 * Bottom sheet on a phone, side panel from 881px up. The retailer's details are
 * remembered in localStorage after the first successful order (D4) with a
 * "مو أنا / تغيير" control; nothing here ever looks anything up by phone.
 */
export function CartDrawer({ store }: { store: StoreInfoDTO }) {
    const cart = useCart();
    const { lines, open, setOpen } = cart;

    const retailerKey = `store:${store.slug}:retailer`;
    const lastOrderKey = `store:${store.slug}:lastOrder`;

    const [name, setName] = useState("");
    const [phone, setPhone] = useState("");
    const [shopName, setShopName] = useState("");
    const [website, setWebsite] = useState(""); // honeypot — real people never fill it
    const [remembered, setRemembered] = useState<string | null>(null);
    const [submitting, setSubmitting] = useState(false);
    const submittingRef = useRef(false); // the ref blocks a second click in the same tick
    const [error, setError] = useState<string | null>(null);

    // Prefill from a previous order each time the drawer opens.
    useEffect(() => {
        if (!open) return;
        let cleared = false;
        const id = setTimeout(() => {
            if (cleared) return;
            try {
                const raw = window.localStorage.getItem(retailerKey);
                if (!raw) return;
                const r = JSON.parse(raw) as Partial<Retailer> | null;
                if (r && typeof r.name === "string" && typeof r.phone === "string") {
                    setName(r.name);
                    setPhone(r.phone);
                    setShopName(typeof r.shopName === "string" ? r.shopName : "");
                    setRemembered(r.name);
                }
            } catch {
                /* ignore */
            }
        }, 0);
        return () => {
            cleared = true;
            clearTimeout(id);
        };
    }, [open, retailerKey]);

    // Escape closes (unless sending) and the page behind stops scrolling.
    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape" && !submittingRef.current) setOpen(false);
        };
        document.addEventListener("keydown", onKey);
        const previous = document.body.style.overflow;
        document.body.style.overflow = "hidden";
        return () => {
            document.removeEventListener("keydown", onKey);
            document.body.style.overflow = previous;
        };
    }, [open, setOpen]);

    if (!open) return null;

    function forgetRetailer() {
        try {
            window.localStorage.removeItem(retailerKey);
        } catch {
            /* ignore */
        }
        setName("");
        setPhone("");
        setShopName("");
        setRemembered(null);
    }

    async function onSubmit(e: FormEvent) {
        e.preventDefault();
        if (submittingRef.current || lines.length === 0) return;

        const n = name.trim();
        const p = phone.trim();
        if (n.length < 2) {
            setError("اكتب اسمك (حرفين على الأقل).");
            return;
        }
        if (p.replace(/\D/g, "").length < 9) {
            setError("اكتب رقم هاتف صحيح.");
            return;
        }

        submittingRef.current = true;
        setSubmitting(true);
        setError(null);

        const sentLines = lines;
        const sentTotals = cart.totals;

        const res = await submitStoreOrder({
            slug: store.slug,
            name: n,
            phone: p,
            shopName: shopName.trim(),
            website,
            lines: sentLines,
        });

        submittingRef.current = false;
        setSubmitting(false);

        if (!res.ok) {
            setError(res.message);
            return;
        }

        try {
            const retailer: Retailer = { name: n, phone: p, shopName: shopName.trim() };
            window.localStorage.setItem(retailerKey, JSON.stringify(retailer));
            window.localStorage.setItem(
                lastOrderKey,
                JSON.stringify(
                    sentLines.map((l) => ({ productId: l.productId, unitId: l.unitId, quantity: l.quantity }))
                )
            );
        } catch {
            /* remembering is a convenience only */
        }

        cart.showConfirmation({
            orderRef: res.orderRef,
            retailerName: n,
            lineCount: sentLines.length,
            totalSYP: sentTotals.SYP,
            totalUSD: sentTotals.USD,
        });
        cart.clear();
        setOpen(false);
    }

    return (
        <>
            <div className={styles.scrim} onClick={() => !submitting && setOpen(false)} aria-hidden="true" />
            <section className={styles.sheet} role="dialog" aria-modal="true" aria-label="طلبي">
                <div className={styles.grab} />

                <div className={styles.dh}>
                    <h2>
                        طلبي
                        {lines.length > 0 && <span className={styles.cnt}>{fmtInt(lines.length)}</span>}
                    </h2>
                    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                        {lines.length > 0 && (
                            <button type="button" className={styles.textbtn} onClick={cart.clear} disabled={submitting}>
                                إفراغ
                            </button>
                        )}
                        <button
                            type="button"
                            className={styles.closebtn}
                            onClick={() => setOpen(false)}
                            disabled={submitting}
                            aria-label="إغلاق"
                        >
                            <CloseIcon />
                        </button>
                    </div>
                </div>

                {lines.length === 0 ? (
                    <div className={styles.dbody}>
                        <div className={styles.empty}>
                            <CartIcon size={36} />
                            <b>طلبك فاضي</b>
                            <span>أضف أصناف من المتجر وبترجع لهون.</span>
                        </div>
                    </div>
                ) : (
                    <form
                        onSubmit={onSubmit}
                        style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}
                        noValidate
                    >
                        <div className={styles.dbody}>
                            {cart.notice && (
                                <div className={styles.note}>
                                    <InfoIcon />
                                    {cart.notice}
                                </div>
                            )}

                            <div className={styles.lines}>
                                {lines.map((l) => {
                                    const base = {
                                        productId: l.productId,
                                        unitId: l.unitId,
                                        productName: l.productName,
                                        unitName: l.unitName,
                                        price: l.price,
                                        currency: l.currency,
                                    };
                                    const lineTotal = multiplyMoney(l.price, l.quantity);
                                    return (
                                        <div key={`${l.productId}:${l.unitId}`} className={styles.ln}>
                                            <span className={styles.li} aria-hidden="true">
                                                {l.productName.trim().charAt(0)}
                                            </span>
                                            <span className={styles.lt}>
                                                <b>{l.productName}</b>
                                                <small>
                                                    {l.unitName} ·{" "}
                                                    {l.currency === "USD"
                                                        ? `$ ${fmtMoney(l.price, "USD")}`
                                                        : `${fmtMoney(l.price, "SYP")} ل.س`}
                                                </small>
                                            </span>
                                            <span className={styles.lineStepper}>
                                                <button type="button" onClick={() => cart.step(base, -1)} aria-label="إنقاص">
                                                    <MinusIcon size={16} />
                                                </button>
                                                <QtyInput
                                                    className={styles.qin}
                                                    label={`كمية ${l.productName}`}
                                                    value={l.quantity}
                                                    onCommit={(raw) => cart.setQty(base, raw)}
                                                />
                                                <button type="button" onClick={() => cart.step(base, 1)} aria-label="زيادة">
                                                    <PlusIcon size={16} />
                                                </button>
                                            </span>
                                            <span className={cx(styles.lp, l.currency === "USD" && styles.lpUsd)}>
                                                {l.currency === "USD"
                                                    ? `$ ${fmtMoney(lineTotal, "USD")}`
                                                    : fmtMoney(lineTotal, "SYP")}
                                            </span>
                                        </div>
                                    );
                                })}
                            </div>

                            {/* Each currency on its own — never converted (T5a §6.7). */}
                            <div className={styles.tot}>
                                {cart.totals.SYP !== null && (
                                    <div className={cx(styles.tb, styles.tbSyp)}>
                                        <small>المجموع بالليرة</small>
                                        <b>{fmtMoney(cart.totals.SYP, "SYP")} ل.س</b>
                                    </div>
                                )}
                                {cart.totals.USD !== null && (
                                    <div className={cx(styles.tb, styles.tbUsd)}>
                                        <small>المجموع بالدولار</small>
                                        <b>$ {fmtMoney(cart.totals.USD, "USD")}</b>
                                    </div>
                                )}
                            </div>

                            {remembered && (
                                <div className={styles.hello}>
                                    <span>
                                        أهلاً <b>{remembered}</b>
                                    </span>
                                    <button type="button" onClick={forgetRetailer}>
                                        مو أنا / تغيير
                                    </button>
                                </div>
                            )}

                            <div className={styles.fields}>
                                <div className={styles.fld}>
                                    <label htmlFor="store-name">الاسم</label>
                                    <input
                                        id="store-name"
                                        name="name"
                                        type="text"
                                        autoComplete="name"
                                        value={name}
                                        onChange={(e) => setName(e.target.value)}
                                        maxLength={80}
                                        required
                                    />
                                </div>
                                <div className={styles.fld}>
                                    <label htmlFor="store-phone">رقم الهاتف</label>
                                    <input
                                        id="store-phone"
                                        name="tel"
                                        type="tel"
                                        dir="ltr"
                                        autoComplete="tel"
                                        value={phone}
                                        onChange={(e) => setPhone(e.target.value)}
                                        maxLength={20}
                                        required
                                    />
                                </div>
                                <div className={cx(styles.fld, styles.fldWide)}>
                                    <label htmlFor="store-shop">اسم المحل (اختياري)</label>
                                    <input
                                        id="store-shop"
                                        name="organization"
                                        type="text"
                                        autoComplete="organization"
                                        value={shopName}
                                        onChange={(e) => setShopName(e.target.value)}
                                        maxLength={120}
                                    />
                                </div>
                                <div className={styles.hp} aria-hidden="true">
                                    <label htmlFor="store-website">لا تملأ هذا الحقل</label>
                                    <input
                                        id="store-website"
                                        name="website"
                                        type="text"
                                        tabIndex={-1}
                                        autoComplete="off"
                                        value={website}
                                        onChange={(e) => setWebsite(e.target.value)}
                                    />
                                </div>
                            </div>

                            <div className={styles.note}>
                                <InfoIcon />
                                ما في دفع الآن، التاجر بيراجع الطلب ويتواصل معك.
                            </div>

                            {error && (
                                <div className={styles.err} role="alert">
                                    {error}
                                </div>
                            )}
                        </div>

                        <div className={styles.dfoot}>
                            <button type="submit" className={styles.submit} disabled={submitting}>
                                {submitting ? (
                                    "جاري الإرسال…"
                                ) : (
                                    <>
                                        أرسل الطلب · {fmtInt(lines.length)} {lines.length === 1 ? "صنف" : "أصناف"}
                                        <ChevronLeftIcon size={20} />
                                    </>
                                )}
                            </button>
                        </div>
                    </form>
                )}
            </section>
        </>
    );
}