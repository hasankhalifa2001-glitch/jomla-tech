import { NextResponse } from "next/server";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import {
    assertStorefrontOpen,
    getStorefrontPage,
    InvalidCursorError,
} from "@/lib/data/store";
import { toStoreProductDTO } from "@/lib/data/store-dto";
import { getClientIp } from "@/lib/utils/client-ip";
import { STORE_READ_RATE_LIMIT, STORE_ERROR } from "@/lib/config/storefront";

/**
 * app/api/store/products/route.ts — GET
 *
 * T5a — the paginated catalog feed for "عرض المزيد" (spec §6.4/§6.10). Public,
 * no session. Order of operations is mandatory and fixed (§6.10.2):
 *   1. Read rate limit (STORE_READ_RATE_LIMIT, per client IP) → 429.
 *   2. Tenant gate — a FRESH DB read via assertStorefrontOpen (never cached) →
 *      403 STORE_UNAVAILABLE for unknown slug OR closed store (indistinguishable
 *      on purpose, so the endpoint does not confirm which slugs exist).
 *   3. ONLY THEN the (per-tenant cached) page slice.
 *
 * CHANGED vs the previous version: the response is now
 *   { products: StoreProductDTO[], nextCursor }
 * (render-ready DTOs built on the server by lib/data/store-dto.ts) instead of
 * raw StorefrontCard[]. Stock wording, unit captions and the USD courtesy figure
 * are computed here, so no unit math ever runs in the browser.
 *
 * Error shape: { code, message } (spec §4).
 *
 * RISK: when UPSTASH_REDIS_REST_* are not configured the limiter is disabled
 * (dev convenience). In production that leaves this endpoint unprotected, so a
 * warning is logged at startup.
 */

const MAX_QUERY_LENGTH = 100;

const upstashConfigured = Boolean(
    process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
);

if (!upstashConfigured && process.env.NODE_ENV === "production") {
    console.warn(
        "[store/products] Upstash is not configured: the public read rate limit is DISABLED."
    );
}

const readRatelimit = upstashConfigured
    ? new Ratelimit({
        redis: new Redis({
            url: process.env.UPSTASH_REDIS_REST_URL!,
            token: process.env.UPSTASH_REDIS_REST_TOKEN!,
        }),
        limiter: Ratelimit.slidingWindow(
            STORE_READ_RATE_LIMIT.requests,
            `${STORE_READ_RATE_LIMIT.windowMinutes} m`
        ),
        prefix: "ratelimit:store-read",
    })
    : null;

export async function GET(request: Request) {
    // 1. Read rate limit (trusted client IP).
    if (readRatelimit) {
        const ip = getClientIp(request);
        const { success, reset } = await readRatelimit.limit(ip);
        if (!success) {
            const retryAfter = Math.max(1, Math.ceil((reset - Date.now()) / 1000));
            return NextResponse.json(
                { code: STORE_ERROR.RATE_LIMITED, message: "طلبات كثيرة. انتظر لحظة." },
                { status: 429, headers: { "Retry-After": String(retryAfter) } }
            );
        }
    }

    const { searchParams } = new URL(request.url);
    const tenantSlug = searchParams.get("tenantSlug")?.trim();
    if (!tenantSlug) {
        return NextResponse.json(
            { code: STORE_ERROR.VALIDATION_ERROR, message: "tenantSlug مطلوب." },
            { status: 400 }
        );
    }

    // 2. Tenant gate — fresh read, before any cache.
    const tenant = await assertStorefrontOpen(tenantSlug);
    if (!tenant) {
        return NextResponse.json(
            { code: STORE_ERROR.STORE_UNAVAILABLE, message: "هذا المتجر غير متاح حالياً." },
            { status: 403 }
        );
    }

    // 3. Cached page slice (gate already passed).
    try {
        const page = await getStorefrontPage(tenant.id, {
            q: searchParams.get("q")?.trim().slice(0, MAX_QUERY_LENGTH) || null,
            category: searchParams.get("category")?.trim() || null,
            cursor: searchParams.get("cursor"),
        });
        return NextResponse.json(
            {
                products: page.cards.map((card) =>
                    toStoreProductDTO(card, tenant.dailyExchangeRate)
                ),
                nextCursor: page.nextCursor,
            },
            { headers: { "Cache-Control": "private, no-store" } }
        );
    } catch (err) {
        if (err instanceof InvalidCursorError) {
            return NextResponse.json(
                { code: STORE_ERROR.VALIDATION_ERROR, message: "رمز الصفحة غير صالح." },
                { status: 400 }
            );
        }
        throw err;
    }
}