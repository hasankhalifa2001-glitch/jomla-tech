"use client";

import { useCallback, useState } from "react";
import styles from "./store.module.css";
import { ProductCard } from "./Productcard";
import type { StoreProductDTO } from "./types";

interface ProductsApiResponse {
    products: StoreProductDTO[];
    nextCursor: string | null;
}

/**
 * "عرض المزيد" (T5a §6.4). The first page is server-rendered; the rest comes
 * from GET /api/store/products with the opaque cursor. The API applies the read
 * rate limit, the tenant gate and cursor validation, and returns ready-made
 * DTOs. The parent gives this a `key` built from the active filters so it
 * resets when they change.
 */
export function ProductsLoadMore({
    slug,
    query,
    category,
    initialCursor,
}: {
    slug: string;
    query: string;
    category: string;
    initialCursor: string | null;
}) {
    const [cursor, setCursor] = useState<string | null>(initialCursor);
    const [products, setProducts] = useState<StoreProductDTO[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const loadMore = useCallback(async () => {
        if (!cursor || loading) return;
        setLoading(true);
        setError(null);
        try {
            const params = new URLSearchParams();
            params.set("tenantSlug", slug);
            if (query) params.set("q", query);
            if (category) params.set("category", category);
            params.set("cursor", cursor);

            const res = await fetch(`/api/store/products?${params.toString()}`, {
                headers: { accept: "application/json" },
                cache: "no-store",
            });
            if (res.status === 429) {
                setError("طلبات كثيرة. انتظر لحظة ثم أعد المحاولة.");
                return;
            }
            if (!res.ok) {
                setError("تعذّر تحميل المزيد من المنتجات.");
                return;
            }
            const data = (await res.json()) as ProductsApiResponse;
            setProducts((prev) => [...prev, ...data.products]);
            setCursor(data.nextCursor);
        } catch {
            setError("تعذّر تحميل المزيد من المنتجات.");
        } finally {
            setLoading(false);
        }
    }, [cursor, loading, slug, query, category]);

    if (!initialCursor && products.length === 0) return null;

    return (
        <>
            {products.length > 0 && (
                <div className={styles.pgrid}>
                    {products.map((p) => (
                        <ProductCard key={p.id} product={p} />
                    ))}
                </div>
            )}

            <div className={styles.moreRow}>
                {error && (
                    <p className={styles.errorText} role="alert">
                        {error}
                    </p>
                )}
                {cursor ? (
                    <button type="button" className={styles.morebtn} onClick={loadMore} disabled={loading}>
                        {loading ? "جارٍ التحميل…" : "عرض المزيد"}
                    </button>
                ) : (
                    products.length > 0 && <p className={styles.muted}>لا مزيد من المنتجات.</p>
                )}
            </div>
        </>
    );
}