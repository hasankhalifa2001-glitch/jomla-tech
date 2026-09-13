"use client";

import { SessionProvider as NextAuthSessionProvider } from "next-auth/react";
import type { Session } from "next-auth";

/**
 * Thin wrapper around next-auth's own SessionProvider.
 *
 * [FIX — session prop deliberately UNUSED by current callers] This still
 * accepts an optional `session` prop for API compatibility (a future
 * offline-fallback caller, per T4a's cachedSession work, may legitimately
 * want to seed an initial value this way), but no server layout in this
 * codebase currently passes one — see app/(dashboard)/layout.tsx's own
 * fix note. Passing session server-side into this component previously
 * meant Next.js had to serialize the full session object (email, user
 * id, tenantId, role...) into the initial HTML/RSC payload, readable via
 * plain "View Page Source" before any client code ran — a real
 * information-exposure issue, not just a style preference. Every client
 * child (ExchangeRateInitializer, SyncWorkerInitializer,
 * SubscriptionBanner, etc.) now starts from `undefined` and resolves its
 * own session via useSession()'s automatic client-side fetch to
 * /api/auth/session — a single small same-origin request, not a
 * meaningful delay for any of T2/T4c's timing requirements.
 */
export function SessionProvider({
  children,
  session,
}: {
  children: React.ReactNode;
  session?: Session | null;
}) {
  return (
    <NextAuthSessionProvider session={session}>{children}</NextAuthSessionProvider>
  );
}