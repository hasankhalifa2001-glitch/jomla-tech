import type { Metadata } from "next";
import { resolveStorefrontTenantOnce } from "@/lib/data/store-request";
import { toStoreInfoDTO } from "@/lib/data/store-dto";
import { storeHref } from "@/lib/utils/store-href";
import { CartPageView } from "@/components/store/Cartpageview";
import { StoreNotFound, StoreUnavailable } from "@/components/store/Storestatus";

/**
 * app/(store)/[tenantSlug]/cart/page.tsx — the cart PAGE (T5a §6.7). The cart is
 * a drawer; this page runs the same tenant gate as every store page and gives
 * the cart a link-able entry. Gate is a fresh DB read (§6.1/§6.10).
 */

type PageProps = { params: Promise<{ tenantSlug: string }> };

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
    const { tenantSlug } = await params;
    const resolution = await resolveStorefrontTenantOnce(tenantSlug);
    if (resolution.kind !== "tenant") {
        return { title: "طلبي", robots: { index: false, follow: false } };
    }
    const { tenant } = resolution;
    return {
        title: `طلبي — ${tenant.name}`,
        description: `راجع طلبك من ${tenant.name} وأرسله للمتجر.`,
        // D16: every store page is noindex/nofollow by default.
        robots: { index: false, follow: false },
        alternates: { canonical: storeHref(tenant.slug, "cart") },
        openGraph: {
            title: `طلبي — ${tenant.name}`,
            description: `راجع طلبك من ${tenant.name}.`,
            url: storeHref(tenant.slug, "cart"),
            images: tenant.logo ? [{ url: tenant.logo }] : undefined,
        },
    };
}

export default async function StorefrontCartPage({ params }: PageProps) {
    const { tenantSlug } = await params;

    // 1. Tenant gate — fresh read, before anything else.
    const resolution = await resolveStorefrontTenantOnce(tenantSlug);
    if (resolution.kind === "not_found") return <StoreNotFound slug={tenantSlug} />;
    if (resolution.kind === "unavailable") return <StoreUnavailable />;

    return <CartPageView store={toStoreInfoDTO(resolution.tenant)} />;
}