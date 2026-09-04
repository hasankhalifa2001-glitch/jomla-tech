import type { NextAuthConfig } from "next-auth";

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
        // No jwt/session callbacks here. The middleware only ever reads
        // req.auth (i.e. the JWT already on the request) — it doesn't
        // need to re-derive or refresh any claims, since token
        // population happens in auth.ts's jwt() callback at sign-in
        // time, and update()-triggered refreshes (re-reading
        // subscriptionStatus/dailyExchangeRate from Tenant) are also
        // handled there, not in middleware. Keeping these callbacks out
        // of authConfig means NextAuth(authConfig) in middleware.ts just
        // passes the token through unchanged, which is exactly the
        // behavior we want here.
    },
} satisfies NextAuthConfig;