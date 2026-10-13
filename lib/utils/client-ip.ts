/**
 * lib/utils/client-ip.ts
 *
 * T5a — the single, trusted client-IP source for the public storefront's two
 * rate limits: the order-submission limit (STORE_IP_RATE_LIMIT, §6.8) and the
 * public read limit on GET /api/store/products (STORE_READ_RATE_LIMIT, §6.10).
 * Both key @upstash/ratelimit on the value this returns, so there is exactly
 * one place that decides which header is trusted.
 *
 * ORDER OF TRUST:
 *   1. `x-real-ip`                 — set by the platform edge (Vercel).
 *   2. `x-vercel-forwarded-for`    — Vercel's own client-IP header.
 *   3. the RIGHT-MOST `x-forwarded-for` hop, as a last resort only.
 *   4. "unknown"                   — one shared bucket, so a proxy-less
 *                                    deployment still rate-limits collectively.
 *
 * The LEFT-MOST x-forwarded-for entry is client-supplied and spoofable, so it
 * is deliberately never used (the older register/login limiters do use it; we
 * do not copy that).
 *
 * ASSUMPTION (revisit if the deployment changes): exactly ONE trusted proxy
 * (Vercel's edge) sits in front of the app. If a CDN/proxy is ever added in
 * front of Vercel, the right-most x-forwarded-for hop becomes that proxy's IP
 * and every visitor would share one bucket.
 *
 * Every candidate is shape-checked (length + IPv4/IPv6 characters only)
 * because the value becomes part of a Redis key: a forged header must not be
 * able to inject arbitrary or oversized keys.
 *
 * This is still a deterrent, not a hard boundary: someone who can reach the
 * origin directly (bypassing the CDN) can set `x-real-ip` and rotate it. The
 * real protections are the per-phone pending cap
 * (STORE_MAX_PENDING_PER_UNVERIFIED_PHONE) and manual approval; neither
 * depends on the IP.
 */

const MAX_IP_LENGTH = 64;
// IPv4 / IPv6 characters only (hex digits, ':' and '.').
const IP_SHAPE = /^[0-9a-fA-F:.]+$/;

function clean(value: string | null | undefined): string | null {
    const trimmed = value?.trim();
    if (!trimmed) return null;
    if (trimmed.length > MAX_IP_LENGTH) return null;
    return IP_SHAPE.test(trimmed) ? trimmed : null;
}

export function getClientIp(req: Request): string {
    // 1. Platform-set, the strongest signal.
    const realIp = clean(req.headers.get("x-real-ip"));
    if (realIp) return realIp;

    // 2. Vercel's client-IP header (first entry if it ever carries a list).
    const vercelIp = clean(
        req.headers.get("x-vercel-forwarded-for")?.split(",")[0]
    );
    if (vercelIp) return vercelIp;

    // 3. Last resort: the right-most x-forwarded-for hop (see ASSUMPTION above).
    const xff = req.headers.get("x-forwarded-for");
    if (xff) {
        const hops = xff
            .split(",")
            .map((hop) => clean(hop))
            .filter((hop): hop is string => hop !== null);
        if (hops.length > 0) return hops[hops.length - 1];
    }

    // 4. No usable signal: one shared bucket.
    return "unknown";
}