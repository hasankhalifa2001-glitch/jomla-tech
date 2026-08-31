import { auth } from "@/auth";
import { NextResponse } from "next/server";

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

// Endpoints that are POST (because they need a request body) but are
// strictly read-only — no database write happens. The isWriteMethod check
// below can't tell these apart from a real write by HTTP method alone, so
// they're listed explicitly here. Locked-tenant "read-only mode" must still
// let a merchant preview things (FIFO allocation, a CSV import) even while
// blocked from committing anything.
const READ_ONLY_POST_PREFIXES = [
    "/api/inventory/fifo-preview",
    "/api/inventory/import/preview",
];

// FIX #1 (chicken-and-egg): a PENDING tenant is locked by definition until
// its FIRST subscription is approved — so the write path that actually
// *submits* that first subscription request must stay reachable while
// locked, not just the receipt-image upload step that precedes it. Both
// prefixes are listed explicitly rather than inferring "billing-related"
// from the URL, so this stays an intentional allow-list, not a guess.
//
// NOTE: adjust "/api/subscriptions" to match T6's real route name once
// that endpoint is implemented — this middleware cannot verify the route
// exists, only that it won't be blocked here if it's named this.
const WRITE_ALLOWED_WHEN_LOCKED_PREFIXES = [
    "/api/upload/receipt",
    "/api/subscriptions",
];

export default auth((req) => {
    const { nextUrl } = req;
    const isLoggedIn = !!req.auth;
    const user = req.auth?.user;
    const pathname = nextUrl.pathname;

    // Resolved once, used both for the rewrite below AND forwarded to
    // downstream route handlers via a header — see FIX #3.
    const host = req.headers.get("host") || "";
    const tenantSlug =
        resolveTenantSlugFromStorePath(pathname) || resolveTenantSlugFromHost(host);

    // ── 1a. Explicit sub-link rewrite: /store/tenantSlug/... -> /tenantSlug/...
    if (pathname.startsWith("/store/")) {
        const segments = pathname.split("/").filter(Boolean);
        if (segments.length >= 2) {
            const slug = segments[1];
            const rest = segments.slice(2).join("/");
            const targetPath = `/${slug}${rest ? `/${rest}` : ""}`;
            const rewritten = NextResponse.rewrite(new URL(targetPath, req.url));
            rewritten.headers.set("x-tenant-slug", slug);
            return rewritten;
        }
    }

    // ── 1b. Subdomain rewrite: tenant.domain.com -> /tenantSlug
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
            const rewritten = NextResponse.rewrite(
                new URL(`/${subdomainSlug}${pathname}`, req.url)
            );
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

        const isSettingsRoute = pathname === "/settings" || pathname.startsWith("/settings/");
        if (user?.role === "CASHIER" && isSettingsRoute) {
            const redirectedUrl = new URL("/dashboard", req.url);
            redirectedUrl.searchParams.set("error", "unauthorized");
            return NextResponse.redirect(redirectedUrl);
        }

        const isBillingRoute = pathname.startsWith("/settings/billing");
        const isAccountLockedRoute = pathname.startsWith("/account-locked");
        const isLocked =
            user?.subscriptionStatus === "EXPIRED" || user?.subscriptionStatus === "PENDING";

        if (isLocked && !isBillingRoute && !isAccountLockedRoute) {
            if (user?.role === "CASHIER") {
                return NextResponse.redirect(new URL("/account-locked", req.url));
            }
            const billingUrl = new URL("/settings/billing", req.url);
            billingUrl.searchParams.set("reason", user!.subscriptionStatus!.toLowerCase());
            return NextResponse.redirect(billingUrl);
        }

        // FIX #4: an ADMIN who navigates to /account-locked directly (e.g. a
        // stale bookmark, or a link meant for a CASHIER) is bounced to
        // /settings/billing instead — keeping the ADMIN-vs-CASHIER lockout
        // split (T1/T2) enforced regardless of how the ADMIN got there, not
        // just on the initial redirect.
        if (isAccountLockedRoute && user?.role === "ADMIN" && isLocked) {
            const billingUrl = new URL("/settings/billing", req.url);
            billingUrl.searchParams.set("reason", user!.subscriptionStatus!.toLowerCase());
            return NextResponse.redirect(billingUrl);
        }
    }

    // ── 4. Block write operations on API endpoints for expired/pending tenants.
    //
    // SCOPE NOTE (FIX #3): this check is necessarily session-based — it can
    // only ever lock down writes made by an AUTHENTICATED merchant user
    // (ADMIN/CASHIER on their own dashboard, e.g. /api/sync). It does NOT
    // and architecturally CANNOT cover /api/store/* (the public B2B
    // storefront submission endpoint): a retail customer placing an order
    // has no session at all, so there is no `user.subscriptionStatus` to
    // read here regardless of how this block is written. Locking a
    // suspended tenant's storefront must be enforced inside the
    // /api/store/orders route handler itself, keyed off the TARGET
    // tenant's live status (looked up via the `x-tenant-slug` header this
    // middleware sets above, or re-derived from the host), not the
    // requester's session — there isn't one to check.
    if (pathname.startsWith("/api/") && !pathname.startsWith("/api/auth")) {
        const isWriteMethod = ["POST", "PUT", "DELETE", "PATCH"].includes(req.method);
        const isAllowedWhenLocked = WRITE_ALLOWED_WHEN_LOCKED_PREFIXES.some((p) =>
            pathname.startsWith(p)
        );
        const isReadOnlyAction = READ_ONLY_POST_PREFIXES.some((p) => pathname.startsWith(p));
        const isLocked =
            user?.subscriptionStatus === "EXPIRED" || user?.subscriptionStatus === "PENDING";

        if (isWriteMethod && !isAllowedWhenLocked && !isReadOnlyAction && isLocked) {
            return NextResponse.json(
                {
                    error: "SUBSCRIPTION_LOCKED",
                    message: "عذراً، اشتراك هذا المتجر غير مفعّل حالياً. يرجى التجديد لتفادي إيقاف الميزات.",
                },
                { status: 403 }
            );
        }
    }

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