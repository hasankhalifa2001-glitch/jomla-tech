"use client";

import { SessionProvider as NextAuthSessionProvider } from "next-auth/react";
import type { Session } from "next-auth";

/**
 * [FIX] Now accepts an optional `session` prop and forwards it to
 * next-auth's own SessionProvider. Server layouts (e.g.
 * app/(dashboard)/layout.tsx, app/(locked)/layout.tsx) fetch the session
 * via `await auth()` and pass it in here — this is what lets every client
 * child's `useSession()` (ExchangeRateInitializer, SyncWorkerInitializer,
 * SubscriptionBanner, etc.) have real session data on its very first
 * render instead of starting from `undefined` and fetching it again on
 * the client. Without this prop, next-auth's SessionProvider ignores the
 * server session entirely and always re-fetches — passing `session` here
 * closes that gap.
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