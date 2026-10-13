import { CartLine } from "./types";

export type SubmitResult =
    | { ok: true; orderRef: string }
    | { ok: false; code: string; message: string };

interface ApiBody {
    success?: boolean;
    orderRef?: string;
    code?: string;
    message?: string;
}

/**
 * POST /api/store/orders (T5a §6.8). The server re-reads every product/unit and
 * never trusts a client price, so only ids and quantities are sent. `website`
 * is the honeypot (always empty for a real person). Errors come back as
 * { code, message } with an Arabic message (RATE_LIMITED, PENDING_LIMIT,
 * STORE_UNAVAILABLE, VALIDATION_ERROR, INVALID_LINE …) and are shown as-is.
 */
export async function submitStoreOrder(input: {
    slug: string;
    name: string;
    phone: string;
    shopName: string;
    website: string;
    lines: CartLine[];
}): Promise<SubmitResult> {
    try {
        const res = await fetch("/api/store/orders", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                // Field names match app/api/store/orders/route.ts's STRICT zod schema
                // (unknown keys are rejected), so they must not be renamed here alone.
                tenantSlug: input.slug,
                retailerName: input.name,
                retailerPhone: input.phone,
                retailerShopName: input.shopName || undefined,
                website: input.website,
                items: input.lines.map((l) => ({
                    productId: l.productId,
                    unitId: l.unitId,
                    quantity: l.quantity,
                })),
            }),
        });

        let body: ApiBody | null = null;
        try {
            body = (await res.json()) as ApiBody;
        } catch {
            /* non-JSON gateway error page — handled below */
        }

        if (res.ok && body?.success && typeof body.orderRef === "string") {
            return { ok: true, orderRef: body.orderRef };
        }
        return {
            ok: false,
            code: body?.code ?? "UNKNOWN",
            message: body?.message ?? "تعذّر إرسال الطلب. حاول مرة ثانية.",
        };
    } catch {
        return {
            ok: false,
            code: "NETWORK",
            message: "تعذّر الاتصال بالإنترنت. طلبك محفوظ بالسلة، حاول بعد قليل.",
        };
    }
}