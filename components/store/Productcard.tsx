"use client";

import styles from "./store.module.css";
import { cx } from "./cx";
import { useCart } from "./Cart";
import { QtyInput } from "./Qtyinput";
import { MinusIcon, PlusIcon } from "./Icons";
import { fmtMoney } from "@/lib/utils/digits";
import type { CartLineBase, StoreProductDTO, StoreUnitDTO } from "./types";

function UnitRow({ product, unit }: { product: StoreProductDTO; unit: StoreUnitDTO }) {
    const cart = useCart();
    const qty = cart.qtyOf(product.id, unit.id);
    const base: CartLineBase = {
        productId: product.id,
        unitId: unit.id,
        productName: product.name,
        unitName: unit.name,
        price: unit.price,
        currency: unit.currency,
    };
    // A line that is not already in the cart cannot be added past the line limit.
    const cannotAdd = !product.inStock || (qty === null && cart.limitReached);

    return (
        <div className={cx(styles.unit, qty !== null && styles.on, !product.inStock && styles.off)}>
            <div className={styles.uinfo}>
                <span className={styles.uname}>
                    {unit.name}
                    {unit.factorText && <span className={styles.ufac}>{unit.factorText}</span>}
                </span>

                {unit.currency === "SYP" ? (
                    <span className={styles.price}>
                        <bdi dir="ltr">{fmtMoney(unit.price, "SYP")}</bdi>
                        <small>ل.س</small>
                    </span>
                ) : (
                    <>
                        <span className={cx(styles.price, styles.usd)}>
                            <bdi dir="ltr">$ {fmtMoney(unit.price, "USD")}</bdi>
                        </span>
                        {unit.approxSYP && (
                            <span className={styles.approx}>≈ {fmtMoney(unit.approxSYP, "SYP")} ل.س</span>
                        )}
                        <span className={styles.unote}>السعر النهائي بالليرة يتحدد عند تأكيد التاجر</span>
                    </>
                )}
            </div>

            <div>
                {qty === null ? (
                    <button
                        type="button"
                        className={styles.addbtn}
                        disabled={cannotAdd}
                        onClick={() => cart.setQty(base, 1)}
                        aria-label={`أضف ${product.name} (${unit.name}) إلى الطلب`}
                    >
                        <PlusIcon />
                    </button>
                ) : (
                    <div className={styles.stepper}>
                        <button type="button" onClick={() => cart.step(base, -1)} aria-label="إنقاص">
                            <MinusIcon />
                        </button>
                        <QtyInput
                            className={styles.qin}
                            label={`كمية ${product.name} (${unit.name})`}
                            value={qty}
                            onCommit={(raw) => cart.setQty(base, raw)}
                        />
                        <button type="button" onClick={() => cart.step(base, 1)} aria-label="زيادة">
                            <PlusIcon size={18} />
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}

export function ProductCard({ product, eager = false }: { product: StoreProductDTO; eager?: boolean }) {
    const initial = product.name.trim().charAt(0);

    return (
        <article className={styles.pc}>
            {/* Fixed aspect ratio reserves the space, so the layout never jumps while
          images load; the initial letter shows through until they do. */}
            <div className={styles.pimg}>
                <span className={styles.pinit} aria-hidden="true">
                    {initial}
                </span>
                {product.imageUrl && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                        className={styles.pimgImg}
                        src={product.imageUrl}
                        alt={product.name}
                        loading={eager ? "eager" : "lazy"}
                        decoding="async"
                    />
                )}
                {product.category && <span className={styles.pcat}>{product.category}</span>}
            </div>

            <div className={styles.pbody}>
                <h3 className={styles.pname}>{product.name}</h3>

                {product.inStock && product.stockText ? (
                    <span className={cx(styles.stock, styles.ok)}>
                        <i className={styles.dot} />
                        {product.stockText}
                    </span>
                ) : (
                    <span className={cx(styles.stock, styles.no)}>غير متوفر</span>
                )}

                <div className={styles.units}>
                    {product.units.map((unit) => (
                        <UnitRow key={unit.id} product={product} unit={unit} />
                    ))}
                </div>
            </div>
        </article>
    );
}