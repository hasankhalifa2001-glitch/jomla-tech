import type { Metadata } from "next";
import {
    getStorefrontBestSellerIds,
    getStorefrontCategories,
    getStorefrontNewestIds,
    hydrateStorefrontCards,
} from "@/lib/data/store";
import { resolveStorefrontTenantOnce } from "@/lib/data/store-request";
import { getStorefrontReorderIndex } from "@/lib/data/store-reorder";
import { toStoreInfoDTO, toStoreProductDTO } from "@/lib/data/store-dto";
import { storeHref } from "@/lib/utils/store-href";
import { HomeView } from "@/components/store/Homeview";
import { StoreNotFound, StoreUnavailable } from "@/components/store/Storestatus";
import type { HomeData } from "@/components/store/types";

/**
 * app/(store)/[tenantSlug]/page.tsx — the storefront home (T5a §6.3, D15).
 *
 * Data flow, gate order and caching are unchanged from the previous version:
 * the tenant gate is a FRESH DB read that runs before any cached read
 * (§6.1/§6.10); everything below it may come from the per-tenant caches. All
 * presentation lives in components/store/HomeView.tsx.
 */

type PageProps = { params: Promise<{ tenantSlug: string }> };

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
    const { tenantSlug } = await params;
    const resolution = await resolveStorefrontTenantOnce(tenantSlug);

    if (resolution.kind !== "tenant") {
        return { title: "متجر جملة تك", robots: { index: false, follow: false } };
    }

    const { tenant } = resolution;
    const url = storeHref(tenant.slug);
    return {
        title: tenant.name,
        description: `كتالوج جملة ${tenant.name} — تصفّح المنتجات وأرسل طلبك مباشرة للمتجر.`,
        robots: { index: false, follow: false },
        alternates: { canonical: url },
        openGraph: {
            title: tenant.name,
            description: `كتالوج جملة ${tenant.name} — تصفّح المنتجات وأرسل طلبك مباشرة.`,
            url,
            images: tenant.logo ? [{ url: tenant.logo }] : undefined,
        },
    };
}

export default async function StorefrontHomePage({ params }: PageProps) {
    const { tenantSlug } = await params;

    // 1. Tenant gate — fresh read, before any cache.
    const resolution = await resolveStorefrontTenantOnce(tenantSlug);
    if (resolution.kind === "not_found") return <StoreNotFound slug={tenantSlug} />;
    if (resolution.kind === "unavailable") return <StoreUnavailable />;

    const { tenant } = resolution;
    const rate = tenant.dailyExchangeRate;

    // 2. Catalog sections (cached per tenant; the gate already passed above).
    const [categories, newestIds, bestSellerIds, reorderIndex] = await Promise.all([
        getStorefrontCategories(tenant.id),
        getStorefrontNewestIds(tenant.id),
        getStorefrontBestSellerIds(tenant.id),
        getStorefrontReorderIndex(tenant.id),
    ]);
    const [newestCards, bestSellerCards] = await Promise.all([
        hydrateStorefrontCards(tenant.id, newestIds),
        hydrateStorefrontCards(tenant.id, bestSellerIds),
    ]);

    const data: HomeData = {
        store: toStoreInfoDTO(tenant),
        categories: categories.map((c) => ({ key: c.key, label: c.label })),
        newest: newestCards.map((c) => toStoreProductDTO(c, rate)),
        // Omitted when there is not enough sales data (§6.6). Cards only: no
        // sales figure, count or revenue ever reaches the public payload.
        bestSellers:
            bestSellerCards.length > 0
                ? bestSellerCards.map((c) => toStoreProductDTO(c, rate))
                : null,
        reorderIndex,
    };

    return <HomeView data={data} />;
}