import styles from "./store.module.css";
import { cx } from "./cx";
import { cairo } from "./font";
import { CATEGORY_ICONS, ChevronLeftIcon, PhoneIcon, SearchIcon, WhatsAppIcon } from "./Icons";
import { storePath } from "@/lib/utils/store-href";
import type { HomeData, StoreProductDTO } from "./types";
import { StoreShell } from "./Storeshell";
import { HeaderCartButton } from "./Headercartbutton";
import { ProductCard } from "./Productcard";
import { ReorderCard } from "./Reordercard";

/**
 * The storefront home page (T5a §6.3), as a SERVER component: every number and
 * label arrives already computed in `data` (see types.ts). Only the cart
 * pieces are client components. The real app/(store)/[tenantSlug]/page.tsx does
 * the tenant gate + gateway calls, then renders <HomeView data={...} />.
 */
export function HomeView({ data }: { data: HomeData }) {
    const { store, categories, newest, bestSellers, reorderIndex } = data;
    const initial = store.name.trim().charAt(0) || "م";
    const quick = categories.slice(0, 3);
    // storePath is the single source of truth for store URLs (lib/utils/store-href.ts).
    const productsHref = storePath(store.slug, "products");

    return (
        <div className={cx(styles.store, cairo.className)}>
            <StoreShell store={store}>
                {/* ------------------------------------------------------ hero */}
                <header className={styles.hero}>
                    <div className={cx(styles.ring, styles.r1)} />
                    <div className={cx(styles.ring, styles.r2)} />
                    <div className={styles.wrap}>
                        <div className={cx(styles.topbar, styles.rise)}>
                            <div className={styles.brand}>
                                <span className={styles.logo}>
                                    {/* eslint-disable-next-line @next/next/no-img-element */}
                                    <img className={styles.logoImg} src={store.logoUrl ?? "/icon-B-light.svg"} alt="" />
                                </span>
                                <span className={styles.bname}>{store.name}</span>
                            </div>
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

                        <div className={styles.herogrid}>
                            <div>
                                <span className={cx(styles.eyebrow, styles.rise, styles.d1)}>
                                    <i />
                                    اطلب جملة بدون اتصال
                                </span>
                                <h1 className={cx(styles.heroTitle, styles.rise, styles.d2)}>
                                    اطلب بضاعتك بالجملة
                                    <br />
                                    <span className={styles.heroAccent}>مباشرة من {store.name}</span>
                                </h1>
                                <p className={cx(styles.hsub, styles.rise, styles.d3)}>
                                    اختار الأصناف والكميات وأرسل الطلب، التاجر بيراجعه ويتواصل معك على رقمك.
                                </p>

                                {/* A plain GET form: works without JavaScript. */}
                                <form
                                    className={cx(styles.search, styles.rise, styles.d4)}
                                    action={productsHref}
                                    method="get"
                                    role="search"
                                >
                                    <SearchIcon />
                                    <input type="search" name="q" placeholder="ابحث عن صنف بالاسم" aria-label="بحث عن صنف" />
                                    <button type="submit">ابحث</button>
                                </form>

                                {quick.length > 0 && (
                                    <div className={cx(styles.quick, styles.rise, styles.d5)}>
                                        <span>الأقسام:</span>
                                        {quick.map((c) => (
                                            <a
                                                key={c.key}
                                                className={styles.qchip}
                                                href={`${productsHref}?category=${encodeURIComponent(c.key)}`}
                                            >
                                                {c.label}
                                            </a>
                                        ))}
                                    </div>
                                )}
                            </div>

                            {/* Decorative: an order card that fills itself (CSS only). */}
                            <div className={cx(styles.vis, styles.rise, styles.d3)} aria-hidden="true">
                                <span className={cx(styles.fchip, styles.fc1)}>طرد = 24 قطعة</span>
                                <span className={cx(styles.fchip, styles.fc2)}>سعر الجملة</span>
                                <div className={styles.ocard}>
                                    <div className={styles.oh}>
                                        <b>طلبك</b>
                                        <span>3 أصناف</span>
                                    </div>
                                    <div className={cx(styles.ol, styles.l1)}>
                                        <span className={styles.oi}>ز</span>
                                        <span className={styles.ot}>
                                            <b>زيت الزهرة</b>
                                            <small>طرد × 3</small>
                                        </span>
                                        <span className={styles.op}>17,640</span>
                                    </div>
                                    <div className={cx(styles.ol, styles.l2)}>
                                        <span className={styles.oi}>م</span>
                                        <span className={styles.ot}>
                                            <b>متة خارطة</b>
                                            <small>طرد × 2</small>
                                        </span>
                                        <span className={styles.op}>7,100</span>
                                    </div>
                                    <div className={cx(styles.ol, styles.l3)}>
                                        <span className={styles.oi}>م</span>
                                        <span className={styles.ot}>
                                            <b>مدار سائل جلي</b>
                                            <small>كرتونة × 1</small>
                                        </span>
                                        <span className={styles.op}>13,500</span>
                                    </div>
                                    <div className={styles.otot}>
                                        <span>المجموع</span>
                                        <b>38,240 ل.س</b>
                                    </div>
                                    <div className={styles.obtn}>
                                        <span className={styles.s1}>أرسل الطلب</span>
                                        <span className={styles.s2}>وصل طلبك</span>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </header>

                <main className={styles.wrap}>
                    {/* ---------------------------------------------------- steps */}
                    <div className={styles.steps}>
                        <div className={styles.step}>
                            <span className={styles.sn}>1</span>
                            <div>
                                <b>اختار بضاعتك</b>
                                <small>حدد الوحدة والكمية لكل صنف</small>
                            </div>
                        </div>
                        <div className={styles.step}>
                            <span className={styles.sn}>2</span>
                            <div>
                                <b>أرسل الطلب</b>
                                <small>بدون دفع، بس اسمك ورقمك</small>
                            </div>
                        </div>
                        <div className={styles.step}>
                            <span className={styles.sn}>3</span>
                            <div>
                                <b>التاجر يتواصل معك</b>
                                <small>بعد ما يراجع طلبك</small>
                            </div>
                        </div>
                    </div>

                    <ReorderCard slug={store.slug} available={reorderIndex} />

                    {/* ----------------------------------------------- categories */}
                    {categories.length > 0 && (
                        <section className={styles.sec}>
                            <div className={styles.sh}>
                                <div>
                                    <h2>الأقسام</h2>
                                    <p>تصفح حسب نوع البضاعة</p>
                                </div>
                            </div>
                            <div className={styles.cats}>
                                {categories.map((c, i) => {
                                    const Icon = CATEGORY_ICONS[i % CATEGORY_ICONS.length];
                                    return (
                                        <a
                                            key={c.key}
                                            className={styles.cat}
                                            href={`${productsHref}?category=${encodeURIComponent(c.key)}`}
                                        >
                                            <span className={styles.cico}>
                                                <Icon />
                                            </span>
                                            {c.label}
                                        </a>
                                    );
                                })}
                            </div>
                        </section>
                    )}

                    <ProductSection
                        title="الأحدث"
                        subtitle="أصناف وصلت مؤخراً"
                        href={productsHref}
                        products={newest}
                        eagerCount={4}
                    />

                    {/* Omitted entirely (no empty box) when there is not enough data. */}
                    {bestSellers && bestSellers.length > 0 && (
                        <ProductSection
                            title="الأكثر مبيعاً"
                            subtitle="الأصناف الأكثر طلباً هالفترة"
                            href={productsHref}
                            products={bestSellers}
                        />
                    )}
                </main>

                <footer className={styles.foot}>
                    <div className={styles.wrap}>
                        <div className={styles.ftop}>
                            <div className={styles.fbrand}>
                                <span className={styles.flogo}>
                                    {/* eslint-disable-next-line @next/next/no-img-element */}
                                    <img className={styles.logoImg} src={store.logoUrl ?? "/icon-B-light.svg"} alt="" />
                                </span>
                                <span className={styles.fname}>{store.name}</span>
                            </div>

                            {(store.phone || store.whatsappNumber) && (
                                <div className={styles.fact}>
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
                                </div>
                            )}
                        </div>

                        <div className={styles.fbottom}>
                            <small>© {new Date().getFullYear()} {store.name}</small>
                            <small className={styles.fpower}>
                                متجر مبني على <a href={store.platformHref}>جملة تك</a>
                            </small>
                        </div>
                    </div>
                </footer>
            </StoreShell>
        </div>
    );
}

function ProductSection({
    title,
    subtitle,
    href,
    products,
    eagerCount = 0,
}: {
    title: string;
    subtitle: string;
    href: string;
    products: StoreProductDTO[];
    /** The first row loads its images eagerly; everything else is lazy. */
    eagerCount?: number;
}) {
    if (products.length === 0) return null;
    return (
        <section className={styles.sec}>
            <div className={styles.sh}>
                <div>
                    <h2>{title}</h2>
                    <p>{subtitle}</p>
                </div>
                <a className={styles.more} href={href}>
                    عرض الكل
                    <ChevronLeftIcon />
                </a>
            </div>
            <div className={styles.prow}>
                {products.map((p, i) => (
                    <ProductCard key={p.id} product={p} eager={i < eagerCount} />
                ))}
            </div>
        </section>
    );
}