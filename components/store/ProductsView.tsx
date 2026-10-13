import styles from "./store.module.css";
import { cx } from "./cx";
import { cairo } from "./font";
import { StoreShell } from "./Storeshell";
import { StoreHeaderBar } from "./Storeheaderbar";
import { StoreFooter } from "./Storefooter";
import { ProductCard } from "./Productcard";
import { ProductsLoadMore } from "./ProductsLoadMore";
import { ChevronLeftIcon, CloseIcon, SearchIcon } from "./Icons";
import { storePath } from "@/lib/utils/store-href";
import type { StoreCategoryDTO, StoreInfoDTO, StoreProductDTO } from "./types";

export interface ProductsViewProps {
    store: StoreInfoDTO;
    categories: Array<StoreCategoryDTO & { count: number }>;
    activeCategory: string | null;
    query: string;
    title: string;
    firstPage: { products: StoreProductDTO[]; nextCursor: string | null };
}

function hrefFor(slug: string, next: { q?: string; category?: string | null }): string {
    const params = new URLSearchParams();
    if (next.q) params.set("q", next.q);
    if (next.category) params.set("category", next.category);
    const qs = params.toString();
    return `${storePath(slug, "products")}${qs ? `?${qs}` : ""}`;
}

/**
 * The products page (T5a §6.4) as a SERVER component: filters are plain links
 * over the URL (?q=, ?category=) so they are shareable and need no JavaScript.
 * The real page.tsx does the gate + gateway calls, then renders this.
 */
export function ProductsView({
    store,
    categories,
    activeCategory,
    query,
    title,
    firstPage,
}: ProductsViewProps) {
    const hasFilters = Boolean(query || activeCategory);

    return (
        <div className={cx(styles.store, cairo.className)}>
            <StoreShell store={store}>
                <StoreHeaderBar store={store} defaultQuery={query} />

                <main className={cx(styles.wrap, styles.pageMain)}>
                    <a className={styles.crumb} href={storePath(store.slug)}>
                        <ChevronLeftIcon size={16} />
                        الرئيسية
                    </a>
                    <h1 className={styles.pageTitle}>{title}</h1>

                    <div className={styles.filters}>
                        {query && (
                            <span className={styles.activeQuery}>
                                <SearchIcon size={14} />
                                {query}
                                <a
                                    href={hrefFor(store.slug, { category: activeCategory })}
                                    aria-label="إزالة البحث"
                                >
                                    <CloseIcon size={14} />
                                </a>
                            </span>
                        )}

                        {categories.length > 0 && (
                            <div className={styles.pills}>
                                <a
                                    className={cx(styles.pill, !activeCategory && styles.pillOn)}
                                    href={hrefFor(store.slug, { q: query })}
                                >
                                    الكل
                                </a>
                                {categories.map((c) => (
                                    <a
                                        key={c.key}
                                        className={cx(styles.pill, activeCategory === c.key && styles.pillOn)}
                                        href={hrefFor(store.slug, { q: query, category: c.key })}
                                    >
                                        {c.label}
                                        <span className={styles.pillCount}>{c.count}</span>
                                    </a>
                                ))}
                                {hasFilters && (
                                    <a className={styles.clearAll} href={storePath(store.slug, "products")}>
                                        مسح الكل
                                    </a>
                                )}
                            </div>
                        )}
                    </div>

                    {firstPage.products.length > 0 ? (
                        <>
                            <div className={styles.pgrid}>
                                {firstPage.products.map((p, i) => (
                                    <ProductCard key={p.id} product={p} eager={i < 4} />
                                ))}
                            </div>
                            <ProductsLoadMore
                                key={`${query}|${activeCategory ?? ""}`}
                                slug={store.slug}
                                query={query}
                                category={activeCategory ?? ""}
                                initialCursor={firstPage.nextCursor}
                            />
                        </>
                    ) : (
                        <div className={styles.noRes}>
                            <div className={styles.noResIcon}>
                                <SearchIcon size={26} />
                            </div>
                            <h3>لا توجد نتائج</h3>
                            <p>جرّب كلمات بحث أخرى أو أزل عوامل التصفية.</p>
                            {hasFilters && (
                                <a className={styles.btnLink} href={storePath(store.slug, "products")}>
                                    إزالة كل عوامل التصفية
                                </a>
                            )}
                        </div>
                    )}
                </main>

                <StoreFooter store={store} />
            </StoreShell>
        </div>
    );
}