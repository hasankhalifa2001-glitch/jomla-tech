import NextAuth from "next-auth";
import { NextResponse } from "next/server";
import { authConfig } from "@/auth.config";

// Edge-safe: uses ONLY authConfig (no providers, no Prisma, no bcrypt,
// no Upstash), instead of importing `auth` from "@/auth" — that import
// would pull the full config (and everything it imports) into this
// file's bundle, which is what pushed the middleware Edge Function past
// Vercel's 1 MB Hobby-plan limit.
const { auth } = NextAuth(authConfig);

const DASHBOARD_PATH_PREFIXES = [
    "/dashboard", "/pos", "/inventory", "/ledger", "/orders", "/settings", "/account-locked",
];

function isPathUnder(pathname: string, prefixes: string[]) {
    return prefixes.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

const APP_ROOT_HOST = (() => {
    try {
        return new URL(process.env.NEXT_PUBLIC_APP_URL || "").host.split(":")[0];
    } catch {
        return "";
    }
})();

function resolveTenantSlugFromHost(host: string): string | null {
    const hostWithoutPort = host.split(":")[0];

    if (hostWithoutPort.endsWith(".localhost") && hostWithoutPort !== "localhost") {
        const sub = hostWithoutPort.slice(0, -".localhost".length);
        return sub && sub !== "www" && sub !== "app" ? sub : null;
    }

    if (!APP_ROOT_HOST) return null;
    if (hostWithoutPort === APP_ROOT_HOST) return null;

    if (hostWithoutPort.endsWith(`.${APP_ROOT_HOST}`)) {
        const sub = hostWithoutPort.slice(0, -(`.${APP_ROOT_HOST}`.length));
        if (sub && sub !== "www" && sub !== "app" && !sub.includes(".")) {
            return sub;
        }
    }

    return null;
}

function resolveTenantSlugFromStorePath(pathname: string): string | null {
    if (!pathname.startsWith("/store/")) return null;
    const segments = pathname.split("/").filter(Boolean);
    return segments.length >= 2 ? segments[1] : null;
}

export default auth((req) => {
    const { nextUrl } = req;
    const isLoggedIn = !!req.auth;
    const user = req.auth?.user;
    const pathname = nextUrl.pathname;

    // Resolved once, used both for the rewrite below AND forwarded to
    // downstream route handlers via a header.
    const host = req.headers.get("host") || "";
    const tenantSlug =
        resolveTenantSlugFromStorePath(pathname) || resolveTenantSlugFromHost(host);

    // ── 1a. Explicit sub-link rewrite: /store/tenantSlug/... -> /tenantSlug/...
    //
    // [FIX — DNS_HOSTNAME_RESOLVED_PRIVATE] Previously built the rewrite target
    // via `new URL(targetPath, req.url)`. On Vercel, `req.url` inside a
    // NextAuth-wrapped Edge middleware is not guaranteed to carry the public
    // request origin — it can resolve to an internal/private host, which then
    // makes Vercel treat NextResponse.rewrite(...) as a rewrite to an EXTERNAL
    // target and reject it with 404 DNS_HOSTNAME_RESOLVED_PRIVATE before the
    // request ever reaches application code. `req.nextUrl` (NextURL) is the
    // platform-correct source of truth for the current request's public
    // origin/pathname inside middleware — cloning it and only mutating
    // `pathname` guarantees the rewrite target always shares the exact same,
    // correct origin as the incoming request, on every environment
    // (localhost, preview, and production alike).
    if (pathname.startsWith("/store/")) {
        const segments = pathname.split("/").filter(Boolean);
        if (segments.length >= 2) {
            const slug = segments[1];
            const rest = segments.slice(2).join("/");
            const targetPath = `/${slug}${rest ? `/${rest}` : ""}`;
            const rewrittenUrl = req.nextUrl.clone();
            rewrittenUrl.pathname = targetPath;
            const rewritten = NextResponse.rewrite(rewrittenUrl);
            rewritten.headers.set("x-tenant-slug", slug);
            return rewritten;
        }
    }

    // ── 1b. Subdomain rewrite: tenant.domain.com -> /tenantSlug
    // [FIX — same DNS_HOSTNAME_RESOLVED_PRIVATE issue as 1a] Same
    // req.nextUrl.clone() + pathname-only mutation fix applied here.
    const subdomainSlug = resolveTenantSlugFromHost(host);

    if (subdomainSlug) {
        const isReservedPath =
            isPathUnder(pathname, DASHBOARD_PATH_PREFIXES) ||
            pathname.startsWith("/admin") ||
            pathname.startsWith("/api") ||
            pathname.startsWith("/login") ||
            pathname.startsWith("/register") ||
            pathname.startsWith("/account-locked");

        if (!isReservedPath && !pathname.startsWith(`/${subdomainSlug}`)) {
            const rewrittenUrl = req.nextUrl.clone();
            rewrittenUrl.pathname = `/${subdomainSlug}${pathname}`;
            const rewritten = NextResponse.rewrite(rewrittenUrl);
            rewritten.headers.set("x-tenant-slug", subdomainSlug);
            return rewritten;
        }
    }

    // ── 2. Platform Super-Admin routes
    if (pathname.startsWith("/admin")) {
        if (!isLoggedIn) {
            const loginUrl = new URL("/login", req.url);
            loginUrl.searchParams.set("callbackUrl", pathname);
            return NextResponse.redirect(loginUrl);
        }
        if (!user?.isPlatformAdmin) {
            return NextResponse.redirect(new URL("/dashboard", req.url));
        }
        return NextResponse.next();
    }

    // ── 3. Protected tenant dashboard routes
    const isDashboardRoute = isPathUnder(pathname, DASHBOARD_PATH_PREFIXES);

    if (isDashboardRoute) {
        if (!isLoggedIn) {
            const loginUrl = new URL("/login", req.url);
            loginUrl.searchParams.set("callbackUrl", pathname);
            return NextResponse.redirect(loginUrl);
        }

        const isSettingsRoute =
            pathname === "/settings" ||
            pathname.startsWith("/settings/") ||
            pathname === "/dashboard/settings" ||
            pathname.startsWith("/dashboard/settings/");

        const isBillingRoute =
            pathname === "/settings/billing" ||
            pathname.startsWith("/settings/billing/") ||
            pathname === "/dashboard/settings/billing" ||
            pathname.startsWith("/dashboard/settings/billing/");

        const isAccountLockedRoute = pathname.startsWith("/account-locked");
        const isLocked =
            user?.subscriptionStatus === "EXPIRED" || user?.subscriptionStatus === "PENDING";

        // CASHIER settings restriction: CASHIER is never permitted to access settings.
        // If the tenant is locked, cashier goes to /account-locked; if active, to /dashboard/pos.
        if (user?.role === "CASHIER" && isSettingsRoute) {
            if (isLocked) {
                return NextResponse.redirect(new URL("/account-locked", req.url));
            }
            const posUrl = new URL("/pos", req.url);
            posUrl.searchParams.set("error", "unauthorized");
            return NextResponse.redirect(posUrl);
        }

        // CASHIER default landing page: /dashboard (analytics/KPIs) is ADMIN-only per
        // Role Capability Matrix. CASHIER's default landing page is /pos instead.
        if (user?.role === "CASHIER" && (pathname === "/dashboard" || pathname === "/dashboard/")) {
            if (isLocked) {
                return NextResponse.redirect(new URL("/account-locked", req.url));
            }
            return NextResponse.redirect(new URL("/pos", req.url));
        }

        // Page-navigation layer subscription lockout:
        // Locked tenants (EXPIRED or PENDING) are routed by role:
        // - ADMIN -> /settings/billing (where they can act on the subscription)
        // - CASHIER -> /account-locked (read-only explanation)
        //
        // NOTE: this check may rely on a short-TTL cached/session subscriptionStatus for
        // redirect speed — staleness here only delays how fast an already-approved
        // merchant sees the dashboard. It is NOT a security boundary. The actual write
        // protection for mutating API requests lives exclusively inside each route
        // handler via assertTenantWritable(tenantId), which performs a fresh database
        // read at request time — never in this middleware, since middleware only has
        // access to the JWT session snapshot which can be stale by design.
        if (isLocked && !isBillingRoute && !isAccountLockedRoute) {
            if (user?.role === "CASHIER") {
                return NextResponse.redirect(new URL("/account-locked", req.url));
            }
            const billingUrl = new URL("/settings/billing", req.url);
            billingUrl.searchParams.set("reason", user!.subscriptionStatus!.toLowerCase());
            return NextResponse.redirect(billingUrl);
        }

        // Cross-bounce safeguard 1: an ADMIN who navigates to /account-locked directly
        // is bounced to /settings/billing where they can act on subscription.
        if (isAccountLockedRoute && user?.role === "ADMIN" && isLocked) {
            const billingUrl = new URL("/settings/billing", req.url);
            billingUrl.searchParams.set("reason", user!.subscriptionStatus!.toLowerCase());
            return NextResponse.redirect(billingUrl);
        }

        // Cross-bounce safeguard 2: a CASHIER who navigates to /settings/billing directly
        // is bounced to /account-locked if locked, or /dashboard/pos if active.
        if (isBillingRoute && user?.role === "CASHIER") {
            if (isLocked) {
                return NextResponse.redirect(new URL("/account-locked", req.url));
            }
            const posUrl = new URL("/pos", req.url);
            posUrl.searchParams.set("error", "unauthorized");
            return NextResponse.redirect(posUrl);
        }
    }

    // NOTE: there is deliberately no API-mutation subscription-lock check here.
    // Section 4 (a fast-path session-based 403 for locked tenants on mutating API
    // routes) was removed: it read subscriptionStatus from the JWT, which can be
    // stale, and would incorrectly block an already-approved tenant's writes until
    // the ADMIN logged out and back in — failing the T2b requirement that an
    // approved subscription unblocks writes on the tenant's very next request with
    // no session refresh. The real security boundary is assertTenantWritable(tenantId)
    // inside each mutating route handler (see lib/auth/tenant.ts), which reads
    // subscriptionStatus fresh from the database on every request.

    const response = NextResponse.next();
    if (tenantSlug) {
        response.headers.set("x-tenant-slug", tenantSlug);
    }
    return response;
});

export const config = {
    matcher: [
        "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
    ],
};