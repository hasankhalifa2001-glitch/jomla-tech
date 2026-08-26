import { auth } from "@/auth";
import { NextResponse } from "next/server";

// Paths that belong to the authenticated tenant dashboard shell (Admin +
// Cashier), never the public storefront. Used both to protect them and to
// make sure the subdomain rewrite below never swallows them by mistake.
const DASHBOARD_PATH_PREFIXES = [
    "/dashboard",
    "/pos",
    "/inventory",
    "/ledger",
    "/orders",
    "/settings",
];

function isPathUnder(pathname: string, prefixes: string[]) {
    return prefixes.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

// Resolve the platform's own root host once, from env, instead of guessing
// from dot-count. Segment-count heuristics misfire on hosts like
// `myapp-git-branch.vercel.app`, which also happen to have 3 parts.
const APP_ROOT_HOST = (() => {
    try {
        return new URL(process.env.NEXT_PUBLIC_APP_URL || "").host.split(":")[0];
    } catch {
        return "";
    }
})();

/**
 * Returns the tenant slug if `host` is a genuine tenant subdomain of our
 * known root domain (or `tenant.localhost` in dev) — otherwise null.
 * Never guesses on hosts that aren't provably ours (preview URLs, etc.).
 */
function resolveTenantSlugFromHost(host: string): string | null {
    const hostWithoutPort = host.split(":")[0];

    // tenant.localhost during local dev
    if (hostWithoutPort.endsWith(".localhost") && hostWithoutPort !== "localhost") {
        const sub = hostWithoutPort.slice(0, -".localhost".length);
        return sub && sub !== "www" && sub !== "app" ? sub : null;
    }

    if (!APP_ROOT_HOST) return null;
    if (hostWithoutPort === APP_ROOT_HOST) return null; // the platform's own root/app domain

    if (hostWithoutPort.endsWith(`.${APP_ROOT_HOST}`)) {
        const sub = hostWithoutPort.slice(0, -(`.${APP_ROOT_HOST}`.length));
        if (sub && sub !== "www" && sub !== "app" && !sub.includes(".")) {
            return sub;
        }
    }

    return null;
}

export default auth((req) => {
    const { nextUrl } = req;
    const isLoggedIn = !!req.auth;
    const user = req.auth?.user;
    const pathname = nextUrl.pathname;

    // ── 1a. Explicit sub-link rewrite: /store/tenantSlug/... -> /tenantSlug/...
    if (pathname.startsWith("/store/")) {
        const segments = pathname.split("/").filter(Boolean); // ["store", "tenantSlug", ...]
        if (segments.length >= 2) {
            const tenantSlug = segments[1];
            const rest = segments.slice(2).join("/");
            const targetPath = `/${tenantSlug}${rest ? `/${rest}` : ""}`;
            return NextResponse.rewrite(new URL(targetPath, req.url));
        }
    }

    // ── 1b. Subdomain rewrite: tenant.domain.com -> /tenantSlug
    const host = req.headers.get("host") || "";
    const tenantSlug = resolveTenantSlugFromHost(host);

    if (tenantSlug) {
        // Only the public storefront lives under a tenant subdomain. Dashboard,
        // admin, auth, and API paths must never be rewritten — a merchant who
        // bookmarks tenant.domain.com/pos should still reach the real POS.
        const isReservedPath =
            isPathUnder(pathname, DASHBOARD_PATH_PREFIXES) ||
            pathname.startsWith("/admin") ||
            pathname.startsWith("/api") ||
            pathname.startsWith("/login") ||
            pathname.startsWith("/register") ||
            pathname.startsWith("/account-locked");

        if (!isReservedPath && !pathname.startsWith(`/${tenantSlug}`)) {
            return NextResponse.rewrite(new URL(`/${tenantSlug}${pathname}`, req.url));
        }
    }

    // ── 2. Platform Super-Admin routes — a distinct privilege from tenant
    // ADMIN, and checked before any tenant-scoped logic below.
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

        // 3a. Role restriction: CASHIER cannot access settings routes.
        const isSettingsRoute = pathname === "/settings" || pathname.startsWith("/settings/");
        if (user?.role === "CASHIER" && isSettingsRoute) {
            const redirectedUrl = new URL("/dashboard", req.url);
            redirectedUrl.searchParams.set("error", "unauthorized");
            return NextResponse.redirect(redirectedUrl);
        }

        // 3b. Expired or pending subscription: full read-only lockout on the
        // dashboard shell itself (not just the API layer).
        //
        // FIX: a CASHIER has no permission to view /settings/billing in the
        // first place (see 3a above) — redirecting a locked tenant's cashier
        // there just bounced them straight back out to /dashboard, which
        // re-triggered this same lockout check, producing an infinite
        // redirect loop. Cashiers now go to a standalone informational page
        // outside /settings entirely; only ADMIN gets sent to billing.
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
    }

    // ── 4. Block write operations on API endpoints for expired/pending tenants.
    // Mirrors the dashboard lockout above so a direct API call (not just page
    // navigation) can never bypass it.
    if (pathname.startsWith("/api/") && !pathname.startsWith("/api/auth")) {
        const isWriteMethod = ["POST", "PUT", "DELETE", "PATCH"].includes(req.method);
        const isReceiptUpload = pathname.startsWith("/api/upload/receipt");
        const isLocked =
            user?.subscriptionStatus === "EXPIRED" || user?.subscriptionStatus === "PENDING";

        if (isWriteMethod && !isReceiptUpload && isLocked) {
            return NextResponse.json(
                {
                    error: "SUBSCRIPTION_LOCKED",
                    message: "عذراً، اشتراك هذا المتجر غير مفعّل حالياً. يرجى التجديد لتفادي إيقاف الميزات.",
                },
                { status: 403 }
            );
        }
    }

    return NextResponse.next();
});

export const config = {
    matcher: [
        "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
    ],
};