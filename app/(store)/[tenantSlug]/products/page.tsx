import type { Metadata } from "next";
import { getStorefrontCategories, getStorefrontPage } from "@/lib/data/store";
import { resolveStorefrontTenantOnce } from "@/lib/data/store-request";
import { toStoreInfoDTO, toStoreProductDTO } from "@/lib/data/store-dto";
import { storeHref } from "@/lib/utils/store-href";
import { ProductsView } from "@/components/store/ProductsView";
import { StoreNotFound, StoreUnavailable } from "@/components/store/Storestatus";

/**
 * app/(store)/[tenantSlug]/products/page.tsx — the products page (T5a §6.4):
 * server-side Arabic-folded search (?q=), category filter (?category=), cursor
 * pagination. The FIRST page is server-rendered; "عرض المزيد" fetches the rest
 * from GET /api/store/products. Gate before cache (§6.1/§6.10). noindex in
 * every metadata branch (D16).
 */

type PageProps = {
    params: Promise<{ tenantSlug: string }>;
    searchParams: Promise<{ q?: string; category?: string }>;
};

const MAX_QUERY_LENGTH = 100;

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
    const { tenantSlug } = await params;
    const resolution = await resolveStorefrontTenantOnce(tenantSlug);
    if (resolution.kind !== "tenant") {
        return { title: "منتجات المتجر", robots: { index: false, follow: false } };
    }
    const { tenant } = resolution;
    return {
        title: `منتجات ${tenant.name}`,
        description: `تصفّح كل منتجات ${tenant.name} وابحث وصفِّ حسب التصنيف.`,
        robots: { index: false, follow: false },
        alternates: { canonical: storeHref(tenant.slug, "products") },
        openGraph: {
            title: `منتجات ${tenant.name}`,
            description: `تصفّح كل منتجات ${tenant.name}.`,
            url: storeHref(tenant.slug, "products"),
            images: tenant.logo ? [{ url: tenant.logo }] : undefined,
        },
    };
}

export default async function StorefrontProductsPage({ params, searchParams }: PageProps) {
    const { tenantSlug } = await params;
    const raw = await searchParams;
    const q = raw.q?.trim().slice(0, MAX_QUERY_LENGTH) || undefined;
    const category = raw.category?.trim() || undefined;

    // 1. Tenant gate — fresh read, before any cache.
    const resolution = await resolveStorefrontTenantOnce(tenantSlug);
    if (resolution.kind === "not_found") return <StoreNotFound slug={tenantSlug} />;
    if (resolution.kind === "unavailable") return <StoreUnavailable />;

    const { tenant } = resolution;

    // 2. First page (server-rendered) + the category list for the filter bar.
    const [firstPage, categories] = await Promise.all([
        getStorefrontPage(tenant.id, { q, category }),
        getStorefrontCategories(tenant.id),
    ]);

    const activeLabel = category ? categories.find((c) => c.key === category)?.label : undefined;
    const title = q ? "نتائج البحث" : (activeLabel ?? "كل المنتجات");

    return (
        <ProductsView
            store={toStoreInfoDTO(tenant)}
            categories={categories.map((c) => ({ key: c.key, label: c.label, count: c.count }))}
            activeCategory={category ?? null}
            query={q ?? ""}
            title={title}
            firstPage={{
                products: firstPage.cards.map((c) => toStoreProductDTO(c, tenant.dailyExchangeRate)),
                nextCursor: firstPage.nextCursor,
            }}
        />
    );
}