/**
 * components/store/types.ts
 * The data contract between the T5a gateway (lib/data/store.ts) and the
 * presentational storefront components. The gateway builds these DTOs; the
 * components never compute stock, units or prices themselves.
 *
 *  - stockText is rendered on the SERVER through lib/inventory/units.ts
 *    (e.g. "متوفر 120 طرد"); null when out of stock.
 *  - Money is always a decimal STRING. USD figures are informational only;
 *    approxSYP is present only when the tenant has a rate.
 *  - No cost field, batch id or other internal id is part of any DTO.
 */

export type StoreCurrency = "SYP" | "USD";

export interface StoreUnitDTO {
    id: string;
    name: string;
    /** e.g. "= 24 قطعة" — built server-side via units.ts, null for the base unit. */
    factorText: string | null;
    price: string;
    currency: StoreCurrency;
    /** USD-priced units only, and only when the tenant has a rate. */
    approxSYP: string | null;
}

export interface StoreProductDTO {
    id: string;
    name: string;
    category: string | null;
    imageUrl: string | null;
    stockText: string | null;
    inStock: boolean;
    units: StoreUnitDTO[];
}

export interface StoreInfoDTO {
    slug: string;
    name: string;
    logoUrl: string | null;
    /** Raw tenant phone for the tel: link; null hides the call button. */
    phone: string | null;
    /** toWhatsAppNumber(phone) — digits only (9639XXXXXXXX); null hides WhatsApp. */
    whatsappNumber: string | null;
    /** Existing marketing route for the "متجر مبني على جملة تك" footer link. */
    platformHref: string;
}

export interface StoreCategoryDTO {
    /** normalizeCategory() key, or STORE_UNCATEGORIZED_KEY ("__none__"). */
    key: string;
    label: string;
}

/** What a cart line needs to render without another lookup. */
export interface CartLineBase {
    productId: string;
    unitId: string;
    productName: string;
    unitName: string;
    price: string;
    currency: StoreCurrency;
}

export interface CartLine extends CartLineBase {
    /** Decimal string, > 0, up to 4 dp, <= STORE_MAX_QTY_PER_LINE. */
    quantity: string;
}

export interface Confirmation {
    orderRef: string;
    retailerName: string;
    lineCount: number;
    totalSYP: string | null;
    totalUSD: string | null;
}

export interface HomeData {
    store: StoreInfoDTO;
    categories: StoreCategoryDTO[];
    newest: StoreProductDTO[];
    /** null when there is not enough data (STORE_BESTSELLERS_MIN_PRODUCTS). */
    bestSellers: StoreProductDTO[] | null;
    /**
     * lineKey(productId, unitId) -> snapshot, for every CURRENTLY listable
     * product/unit. Lets "أعد طلبي الأخير" drop stale lines with no network call.
     */
    reorderIndex: Record<string, CartLineBase>;
}