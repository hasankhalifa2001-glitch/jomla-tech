import { auth } from "@/auth";
import { NextResponse } from "next/server";

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

export default auth((req) => {
    const { nextUrl } = req;
    const isLoggedIn = !!req.auth;
    const user = req.auth?.user;
    const pathname = nextUrl.pathname;

    // ── 1a. Explicit sub-link rewrite: /store/tenantSlug/... -> /tenantSlug/...
    if (pathname.startsWith("/store/")) {
        const segments = pathname.split("/").filter(Boolean);
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
    }

    // ── 4. Block write operations on API endpoints for expired/pending tenants.
    if (pathname.startsWith("/api/") && !pathname.startsWith("/api/auth")) {
        const isWriteMethod = ["POST", "PUT", "DELETE", "PATCH"].includes(req.method);
        const isReceiptUpload = pathname.startsWith("/api/upload/receipt");
        // FIX: fifo-preview and import/preview are POST (they need a request
        // body) but never write to the database. Without this exception, a
        // locked tenant couldn't even preview a FIFO allocation or a CSV
        // import — which defeats the point of "read-only mode" being
        // read-only rather than fully inert.
        const isReadOnlyAction = READ_ONLY_POST_PREFIXES.some((p) => pathname.startsWith(p));
        const isLocked =
            user?.subscriptionStatus === "EXPIRED" || user?.subscriptionStatus === "PENDING";

        if (isWriteMethod && !isReceiptUpload && !isReadOnlyAction && isLocked) {
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