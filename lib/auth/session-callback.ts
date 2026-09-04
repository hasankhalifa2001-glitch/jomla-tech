import type { Session } from "next-auth";
import type { JWT } from "@auth/core/jwt";

// Shared by BOTH auth.config.ts (Edge runtime, used by middleware.ts) and
// auth.ts (Node runtime, used everywhere else). This is what actually turns
// the encrypted JWT into the `session.user` shape every route/component/
// middleware reads via `req.auth` / `useSession()` / `auth()`.
//
// [FIX — CRITICAL] Before this file existed, auth.config.ts's `callbacks`
// object had NO `session()` callback at all (only a comment explaining why
// it seemed unnecessary). NextAuth(authConfig) inside middleware.ts is a
// SEPARATE NextAuth instance from the one in auth.ts — it does NOT inherit
// auth.ts's callbacks. With no session() callback, that instance fell back
// to NextAuth's default session shape: `{ user: { name, email, image },
// expires }` — none of role/tenantId/subscriptionStatus/isPlatformAdmin
// ever made it onto `req.auth.user` inside middleware, even though the
// underlying JWT itself had all of those fields correctly populated by
// auth.ts's jwt() callback at sign-in.
//
// Practical effect: every middleware check reading `user?.subscriptionStatus`,
// `user?.role`, or `user?.isPlatformAdmin` was comparing against `undefined`
// and silently taking the "not locked / not cashier / not platform admin"
// branch every time — the PENDING/EXPIRED lockout, the CASHIER→/settings
// block, and the /admin isPlatformAdmin gate were all no-ops in practice,
// despite the logic itself being correct.
//
// This function contains NO database access and NO imports beyond NextAuth's
// own types, so it is safe to import from auth.config.ts without pulling
// Prisma/bcrypt/Upstash into the Edge middleware bundle.
export function applySessionFromToken(session: Session, token: JWT): Session {
    if (token && session.user) {
        session.user.id = token.id as string;
        session.user.role = (token.role as "ADMIN" | "CASHIER") || "CASHIER";
        session.user.tenantId = token.tenantId as string;
        session.user.tenantSlug = (token.tenantSlug as string) || "";
        session.user.tenantName = (token.tenantName as string) || "";
        session.user.dailyExchangeRate = (token.dailyExchangeRate as number | null) ?? null;
        // Fail-closed: if this field is ever missing/stale on the token,
        // treat the tenant as locked (EXPIRED) rather than fully active. A
        // token glitch must never silently unlock a suspended tenant's
        // write access.
        session.user.subscriptionStatus =
            (token.subscriptionStatus as "ACTIVE" | "EXPIRED" | "PENDING") || "EXPIRED";
        // Default false so a missing/stale token never grants
        // platform-admin access.
        session.user.isPlatformAdmin = (token.isPlatformAdmin as boolean) ?? false;
    }
    return session;
}