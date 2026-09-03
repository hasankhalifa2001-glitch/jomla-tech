/* eslint-disable no-restricted-imports */
import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { CredentialsSignin } from "next-auth";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/db";
import type { DefaultSession } from "next-auth";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

declare module "next-auth" {
    interface User {
        id?: string;
        role?: "ADMIN" | "CASHIER";
        tenantId?: string;
        tenantSlug?: string;
        tenantName?: string;
        dailyExchangeRate?: number | null;
        subscriptionStatus?: "ACTIVE" | "EXPIRED" | "PENDING";
        // Platform-level privilege (T6 Super-Admin dashboard), distinct
        // from tenant-scoped `role` — a platform admin isn't a member of
        // any tenant's staff, just additionally privileged.
        isPlatformAdmin?: boolean;
    }

    interface Session {
        user: {
            id: string;
            email: string;
            name?: string | null;
            image?: string | null;
            role: "ADMIN" | "CASHIER";
            tenantId: string;
            tenantSlug: string;
            tenantName: string;
            // Snapshot from the moment this session was issued or last
            // refreshed via update() — NOT a live value. The POS/dashboard
            // must still poll or re-fetch the rate independently, since a
            // second device (e.g. a cashier's phone) won't see an admin's
            // edit until its own session is refreshed.
            dailyExchangeRate: number | null;
            subscriptionStatus: "ACTIVE" | "EXPIRED" | "PENDING";
            isPlatformAdmin: boolean;
        } & DefaultSession["user"];
    }
}

declare module "@auth/core/jwt" {
    interface JWT {
        id?: string;
        role?: "ADMIN" | "CASHIER";
        tenantId?: string;
        tenantSlug?: string;
        tenantName?: string;
        dailyExchangeRate?: number | null;
        subscriptionStatus?: "ACTIVE" | "EXPIRED" | "PENDING";
        isPlatformAdmin?: boolean;
    }
}

// Fail fast if the secret is missing, instead of silently falling back to a
// value that would otherwise sit in source control. An app running with an
// unset AUTH_SECRET should never boot.
function requireAuthSecret(): string {
    const secret = process.env.AUTH_SECRET;
    if (!secret || secret.trim().length === 0) {
        throw new Error(
            "AUTH_SECRET is not set. Generate one with `openssl rand -base64 32` " +
            "and add it to your environment before starting the app."
        );
    }
    return secret;
}

// FIX (timing side-channel): a bcrypt hash of a value nobody will ever type,
// compared against on every "user not found" / "user inactive" path below so
// that path takes roughly the same time as a real password check. Without
// this, `findUnique` returning null short-circuits authorize() almost
// instantly while a real user always pays bcrypt's ~100ms+ cost — an
// attacker can distinguish "this email doesn't exist" from "this email
// exists, wrong password" purely by response time, effectively letting them
// enumerate valid emails (which, per this codebase's admin@<slug>.com
// convention, are not hard to guess in the first place).
const DUMMY_PASSWORD_HASH =
    "$2a$10$CwTycUXWue0Thq9StjUM0uJ8Dj9K7L9E9zQK6mF2b9v6QGZ4rXKdG";

// FIX (rate-limit UX): Auth.js v5 swallows any plain `Error` thrown inside
// authorize() and surfaces only a generic "CredentialsSignin" error to the
// client, by design (it never leaks *why* a credentials attempt failed). A
// plain `throw new Error("Too many login attempts...")` therefore never
// reaches the user — they'd just see the same "invalid credentials" message
// as a wrong password, which is actively misleading (it encourages *more*
// attempts, the opposite of the rate limit's purpose). A named
// CredentialsSignin subclass with a stable `code` DOES survive the trip to
// `useSession`/`signIn()`'s returned `error` field, so the login page can
// branch on `error === "RateLimited"` and show the right message.
class RateLimitedError extends CredentialsSignin {
    code = "RateLimited";
}

// Throttle login attempts so a brute-force script can't hammer authorize().
// Reuses the same Upstash Redis instance already provisioned for T5's order
// rate limiting. Activates automatically once UPSTASH_REDIS_REST_URL/TOKEN
// are set — no-op until then.
const loginRatelimit =
    process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
        ? new Ratelimit({
            redis: new Redis({
                url: process.env.UPSTASH_REDIS_REST_URL,
                token: process.env.UPSTASH_REDIS_REST_TOKEN,
            }),
            limiter: Ratelimit.slidingWindow(5, "5 m"), // 5 attempts / 5 min per key
            prefix: "ratelimit:login",
        })
        : null;

export const { handlers, auth, signIn, signOut } = NextAuth({
    providers: [
        Credentials({
            name: "credentials",
            credentials: {
                email: { label: "Email", type: "email" },
                password: { label: "Password", type: "password" },
            },
            async authorize(credentials, request) {
                if (!credentials?.email || !credentials?.password) {
                    return null;
                }

                const email = String(credentials.email).toLowerCase().trim();
                const password = String(credentials.password);

                // FIX (rate-limit scope): keyed on email + a best-effort IP,
                // not email alone. Email-only keying means anyone who knows
                // (or guesses — this project's seed convention is literally
                // admin@<slug>.com) a target's email can lock THEM out for
                // everyone by deliberately failing 5 times from anywhere,
                // repeatedly, with no cost to the attacker. Combining with
                // IP means an attacker can still hammer a single victim from
                // one IP, but can no longer indefinitely deny that specific
                // account to its real owner from an unrelated IP. This is a
                // mitigation, not a complete fix — a distributed attacker
                // rotating IPs can still target one email; a second layer
                // (e.g. a CAPTCHA after N failures, independent of IP) is
                // recommended before this ships to production.
                const ip =
                    request?.headers?.get("x-forwarded-for")?.split(",")[0]?.trim() ||
                    "unknown";

                if (loginRatelimit) {
                    const { success } = await loginRatelimit.limit(`${email}:${ip}`);
                    if (!success) {
                        throw new RateLimitedError();
                    }
                }

                const user = await prisma.user.findUnique({
                    where: { email },
                    include: { tenant: true },
                });

                // FIX (timing side-channel): always run a bcrypt comparison
                // on this path — against the dummy hash when there's no real
                // user/hash to check against — instead of returning
                // immediately. Keeps "no such user" and "wrong password"
                // taking roughly the same wall-clock time.
                if (!user || !user.passwordHash || !user.isActive) {
                    await bcrypt.compare(password, DUMMY_PASSWORD_HASH);
                    return null;
                }

                const passwordsMatch = await bcrypt.compare(password, user.passwordHash);

                if (!passwordsMatch) {
                    return null;
                }

                return {
                    id: user.id,
                    name: user.name,
                    email: user.email,
                    role: user.role,
                    tenantId: user.tenantId,
                    tenantSlug: user.tenant.slug,
                    tenantName: user.tenant.name,
                    dailyExchangeRate: user.tenant.dailyExchangeRate
                        ? Number(user.tenant.dailyExchangeRate)
                        : null,
                    subscriptionStatus: user.tenant.subscriptionStatus,
                    isPlatformAdmin: user.isPlatformAdmin,
                };
            },
        }),
    ],
    session: {
        strategy: "jwt",
    },
    pages: {
        signIn: "/login",
    },
    callbacks: {
        async jwt({ token, user, trigger }) {
            if (user) {
                token.id = user.id;
                token.role = user.role;
                token.tenantId = user.tenantId;
                token.tenantSlug = user.tenantSlug;
                token.tenantName = user.tenantName;
                token.dailyExchangeRate = user.dailyExchangeRate;
                token.subscriptionStatus = user.subscriptionStatus;
                token.isPlatformAdmin = user.isPlatformAdmin;
            }

            // [FIX — SECURITY CRITICAL] Previously trusted a client-supplied
            // `session.subscriptionStatus` / `session.dailyExchangeRate`
            // verbatim on `trigger === "update"`. `update()` is callable
            // directly from the browser (including from devtools) by ANY
            // signed-in session — a CASHIER on a PENDING or EXPIRED tenant
            // could call `update({ subscriptionStatus: "ACTIVE" })` and
            // write that value straight into their own token, with zero
            // server-side verification. Because subscriptionStatus is
            // exactly the field T2's middleware and T4c's /api/sync gate
            // writes on, that was a full lockout bypass — a client could
            // unlock its own tenant.
            //
            // `update()` is now treated as a signal to REFRESH from the
            // database, never as a payload to write verbatim. Whatever the
            // client passes into `session` on the update call is ignored
            // entirely for these two fields; the current, authoritative
            // values are re-read from Tenant via the token's own tenantId
            // (never from anything the client supplied) and written back.
            // This preserves the original UX goal (an admin editing the
            // exchange rate, or a super-admin approving a subscription,
            // still reflects on THIS session immediately after calling
            // `update()`) without trusting the client for the value itself.
            if (trigger === "update" && token.tenantId) {
                const tenant = await prisma.tenant.findUnique({
                    where: { id: token.tenantId as string },
                    select: { subscriptionStatus: true, dailyExchangeRate: true },
                });
                if (tenant) {
                    token.subscriptionStatus = tenant.subscriptionStatus;
                    token.dailyExchangeRate = tenant.dailyExchangeRate
                        ? Number(tenant.dailyExchangeRate)
                        : null;
                }
            }

            return token;
        },
        async session({ session, token }) {
            if (token && session.user) {
                session.user.id = token.id as string;
                session.user.role = (token.role as "ADMIN" | "CASHIER") || "CASHIER";
                session.user.tenantId = token.tenantId as string;
                session.user.tenantSlug = (token.tenantSlug as string) || "";
                session.user.tenantName = (token.tenantName as string) || "";
                session.user.dailyExchangeRate = (token.dailyExchangeRate as number | null) ?? null;
                // Fail-closed: if this field is ever missing/falsy on the
                // token, treat the tenant as locked (EXPIRED) rather than
                // fully active. A token glitch must never silently unlock a
                // suspended tenant's write access.
                session.user.subscriptionStatus =
                    (token.subscriptionStatus as "ACTIVE" | "EXPIRED" | "PENDING") || "EXPIRED";
                // Default false so a missing/stale token never grants
                // platform-admin access.
                session.user.isPlatformAdmin = (token.isPlatformAdmin as boolean) ?? false;
            }
            return session;
        },
    },
    secret: requireAuthSecret(),
    trustHost: true,
});