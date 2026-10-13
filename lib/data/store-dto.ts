/**
 * lib/data/store-dto.ts
 *
 * Turns the gateway's StorefrontCard / StorefrontTenant into the presentational
 * DTOs the storefront components render (components/store/types.ts). Runs on
 * the SERVER only (pages + GET /api/store/products), so no unit math or stock
 * wording ever reaches the browser.
 *
 *  - Factor math stays in lib/inventory/units.ts (storefrontUnitLabels).
 *  - Prices stay decimal STRINGS (serializeMoney); the USD "≈ N ل.س" courtesy
 *    figure uses convertCurrency with the tenant's CURRENT rate and exists only
 *    when a rate does (the real conversion happens at approval, D10).
 *  - Nothing sensitive: no cost, batch, barcode or internal id is added here.
 */

import { StoreInfoDTO, StoreProductDTO, StoreUnitDTO } from "@/components/store/types";
import type { StorefrontCard, StorefrontTenant } from "@/lib/data/store";
import { storefrontUnitLabels } from "@/lib/inventory/units";
import { convertCurrency, serializeMoney } from "@/lib/utils/money";
import { toWhatsAppNumber } from "@/lib/utils/phone";

function stockText(card: StorefrontCard): string | null {
    if (!card.inStock) return null;
    // availability comes from units.ts breakdownForDisplay (largest unit first):
    // e.g. [{طرد 5}, {قطعة 3}] -> "متوفر 5 طرد و3 قطعة".
    const parts = card.availability
        .filter((a) => a.count !== "" && a.count !== "0")
        .map((a) => `${a.count} ${a.unitName}`);
    return parts.length > 0 ? `متوفر ${parts.join(" و")}` : "متوفر";
}

export function toStoreProductDTO(card: StorefrontCard, rate: string | null): StoreProductDTO {
    const byId = new Map(card.units.map((u) => [u.id, u]));

    const units: StoreUnitDTO[] = storefrontUnitLabels(card.units).flatMap((label) => {
        const u = byId.get(label.unitId);
        if (!u) return [];

        let approxSYP: string | null = null;
        if (u.pricingCurrency === "USD" && rate) {
            try {
                approxSYP = convertCurrency(u.priceWholesale, rate, "USD", "SYP");
            } catch {
                approxSYP = null; // a bad rate never blocks the card
            }
        }

        return [
            {
                id: u.id,
                name: u.unitName,
                factorText: label.factorText,
                price: serializeMoney(u.priceWholesale),
                currency: u.pricingCurrency,
                approxSYP,
            },
        ];
    });

    return {
        id: card.id,
        name: card.name,
        category: card.category,
        imageUrl: card.imageUrl,
        stockText: stockText(card),
        inStock: card.inStock,
        units,
    };
}

export function toStoreInfoDTO(tenant: StorefrontTenant): StoreInfoDTO {
    return {
        slug: tenant.slug,
        name: tenant.name,
        logoUrl: tenant.logo,
        phone: tenant.phone,
        // Digits-only 9639XXXXXXXX, or null (hides WhatsApp). Never a raw phone.
        whatsappNumber: toWhatsAppNumber(tenant.phone),
        // The existing marketing route; adjust if it is not "/".
        platformHref: "/",
    };
}