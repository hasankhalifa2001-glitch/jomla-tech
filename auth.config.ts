import type { NextAuthConfig } from "next-auth";
import { applySessionFromToken } from "@/lib/auth/session-callback";

// Edge-safe config: NO providers with real logic, NO Prisma, NO bcrypt,
// NO Upstash. This is the only version of the auth config that gets
// bundled into middleware.ts, which runs on the Edge runtime and has
// Vercel's 1 MB size limit on the Hobby plan.
//
// The full config (with the real Credentials provider, Prisma adapter
// lookups, rate limiting, etc.) lives in auth.ts and is used everywhere
// else (API routes, Server Components, Server Actions) — those run on
// the Node.js runtime and have no such size limit.
export const authConfig = {
    pages: {
        signIn: "/login",
    },
    // Left empty on purpose. auth.ts spreads this config and adds the
    // real Credentials provider on top — that provider (and everything
    // it imports: prisma, bcryptjs, @upstash/*) must never end up in
    // this file or anything it imports.
    providers: [],
    session: {
        strategy: "jwt",
    },
    callbacks: {
        // [FIX — CRITICAL] Previously left empty on the assumption that
        // "the middleware only ever reads req.auth (the JWT already on the
        // request)" — that's true of the underlying token, but req.auth is
        // NOT the raw token, it's whatever this callback below produces.
        // NextAuth(authConfig) inside middleware.ts is a separate instance
        // from the one built in auth.ts and does NOT inherit auth.ts's
        // callbacks. Without a session() callback here, req.auth.user in
        // middleware silently fell back to the default `{ name, email,
        // image }` shape — every check reading role/tenantId/
        // subscriptionStatus/isPlatformAdmin was comparing against
        // `undefined` and always taking the "unlocked" branch. See
        // lib/auth/session-callback.ts for the full explanation.
        //
        // No jwt() callback is needed here — this instance never receives
        // `trigger: "update"` calls (those originate client-side against
        // the Node instance in auth.ts) and never needs to populate a token
        // from a fresh sign-in (that only happens through auth.ts's
        // Credentials provider). It only ever needs to read a token that
        // was already fully populated elsewhere and shape it into a
        // session object.
        async session({ session, token }) {
            return applySessionFromToken(session, token);
        },
    },
} satisfies NextAuthConfig;