"use client";

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { useLiveQuery } from "dexie-react-hooks";
import { getOfflineDb, isOfflineDbSupported, type CachedSession } from "./db";
import { getCachedRate } from "./exchange-rate";
import { getCachedSession, setCachedSession } from "./session-cache";
import { useActiveSessionStore } from "@/lib/store/useActiveSessionStore";

export type OfflineDbStatus =
  | "INITIALIZING"
  | "READY"
  /** Some, but not all, of products/customers/rate are cached yet — a
   * genuinely different situation from NO_CACHED_DATA (nothing at all). */
  | "PARTIAL"
  | "NO_CACHED_DATA"
  | "UNSUPPORTED"
  | "ERROR";

export type MissingCachePiece = "products" | "customers" | "rate";

export interface OfflineDbReadyResult {
  isReady: boolean;
  isDbOpen: boolean;
  hasCachedData: boolean;
  isEmptyCache: boolean;
  status: OfflineDbStatus;
  missing: MissingCachePiece[];
  error?: string;
}

const ALL_MISSING: MissingCachePiece[] = ["products", "customers", "rate"];

const UNSUPPORTED_RESULT: OfflineDbReadyResult = {
  isReady: false,
  isDbOpen: false,
  hasCachedData: false,
  isEmptyCache: true,
  status: "UNSUPPORTED",
  missing: ALL_MISSING,
};

const INITIALIZING_RESULT: OfflineDbReadyResult = {
  isReady: false,
  isDbOpen: false,
  hasCachedData: false,
  isEmptyCache: false,
  status: "INITIALIZING",
  missing: [],
};

/**
 * Checks the database readiness and cache population status FOR A SPECIFIC
 * TENANT. tenantId is REQUIRED — throws rather than falling back to an
 * unscoped, cross-tenant count.
 *
 * isReady requires ALL THREE caches to be populated together — products,
 * customers, AND the exchange rate — not any single one (AND, not OR).
 */
export async function checkOfflineCacheStatus(tenantId: string): Promise<OfflineDbReadyResult> {
  if (!isOfflineDbSupported()) {
    return UNSUPPORTED_RESULT;
  }
  if (!tenantId || !tenantId.trim()) {
    throw new Error("tenantId is required to check offline cache status.");
  }

  try {
    const db = getOfflineDb();
    if (!db.isOpen()) {
      await db.open();
    }

    const scopedTenantId = tenantId.trim();

    const [productCount, customerCount, settingsCount] = await Promise.all([
      db.cachedProducts.where("tenantId").equals(scopedTenantId).count(),
      db.cachedCustomers.where("tenantId").equals(scopedTenantId).count(),
      db.cachedTenantSettings.where("tenantId").equals(scopedTenantId).count(),
    ]);

    const hasProducts = productCount > 0;
    const hasCustomers = customerCount > 0;
    const hasRate = settingsCount > 0;

    const hasCachedData = hasProducts || hasCustomers || hasRate;
    const isReady = hasProducts && hasCustomers && hasRate;

    const missing: MissingCachePiece[] = [
      ...(!hasProducts ? (["products"] as const) : []),
      ...(!hasCustomers ? (["customers"] as const) : []),
      ...(!hasRate ? (["rate"] as const) : []),
    ];

    return {
      isReady,
      isDbOpen: true,
      hasCachedData,
      isEmptyCache: !hasCachedData,
      status: isReady ? "READY" : hasCachedData ? "PARTIAL" : "NO_CACHED_DATA",
      missing,
    };
  } catch (error) {
    console.error("Dexie failed to inspect database readiness:", error);
    return {
      isReady: false,
      isDbOpen: false,
      hasCachedData: false,
      isEmptyCache: true,
      status: "ERROR",
      missing: ALL_MISSING,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Reactive Dexie readiness hook with cold empty-cache detection, scoped to
 * a single tenant.
 */
export function useOfflineDbReady(tenantId?: string): OfflineDbReadyResult {
  const supported = isOfflineDbSupported();

  const result = useLiveQuery(
    async () => {
      if (!tenantId) {
        return INITIALIZING_RESULT;
      }
      return checkOfflineCacheStatus(tenantId);
    },
    [tenantId],
    supported ? INITIALIZING_RESULT : UNSUPPORTED_RESULT
  );

  if (!supported) {
    return UNSUPPORTED_RESULT;
  }
  return result ?? INITIALIZING_RESULT;
}

/**
 * Hook to read the cached daily exchange rate from Dexie as a decimal
 * string — never a native JS number.
 */
export function useCachedExchangeRate(tenantId?: string) {
  const { isReady } = useOfflineDbReady(tenantId);

  const cached = useLiveQuery(
    async () => {
      if (!isReady || !tenantId) return null;
      return getCachedRate(tenantId);
    },
    [isReady, tenantId]
  );

  return {
    rate: cached?.rate ?? null,
    cachedAt: cached?.cachedAt ?? null,
    isLoading: cached === undefined,
  };
}

// ============================================================================
// useSessionWithOfflineFallback — T4a's session-leak-fix gap closer.
//
// T4a2 correctly moves session resolution client-side via next-auth's
// useSession(), which itself resolves via a network call to
// /api/auth/session. On a genuine offline reload, that call cannot
// resolve — leaving the app with no tenantId to scope any Dexie read by,
// defeating the entire point of this offline-first task. This hook tries
// useSession() first and falls back to lib/offline/session-cache.ts's
// cachedSession table only when the live call is genuinely unreachable —
// never as a routine substitute for it.
//
// Every place in the app that reads useSession() directly for
// tenantId/role/isPlatformAdmin should use this wrapper instead on any
// offline-reachable screen (T4a2's own acceptance criteria).
//
// Like the JWT claims it mirrors (T2a) and cachedSession itself, this is
// informational/client-routing ONLY — never trusted for the actual
// API-mutation-layer authorization check, which always re-validates
// server-side once connectivity returns (see auth.ts's jwt callback: a
// client-supplied `update({ subscriptionStatus: ... })` payload is always
// ignored and the value is re-read fresh from the database instead).
// ============================================================================

export type SessionFallbackStatus =
  | "loading"
  | "authenticated"
  | "unauthenticated"
  | "offline-cached"
  /** Genuinely offline/unreachable AND this tab never resolved a live
   * session, so there is no known userId to look up in the cache. Not
   * the same as "unauthenticated" — that would claim to know the user
   * is logged out, which cannot be trusted while offline (see below). */
  | "unreachable";

export interface SessionFallbackClaims {
  userId: string;
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  role: "ADMIN" | "CASHIER";
  isPlatformAdmin: boolean;
  name?: string;
  source: "live" | "cached";
  /**
   * DISPLAY-ONLY WHEN source === "cached". Mirrors the JWT's own
   * short-TTL-cached claim (T2a) — never trusted for any write/navigation
   * decision. The one place this codebase reads it (SyncWorkerInitializer)
   * uses it purely to skip a doomed sync attempt as a performance
   * optimization; the real security boundary is always
   * assertTenantWritable(tenantId) on the server, which re-reads fresh
   * from the database on every mutating request regardless of what this
   * value says. May be stale by an arbitrary amount while offline — see
   * the reconnect-triggered update() call below for how staleness is
   * bounded once connectivity returns.
   */
  subscriptionStatus: "ACTIVE" | "EXPIRED" | "PENDING";
}

export interface UseSessionWithOfflineFallbackResult {
  status: SessionFallbackStatus;
  data: SessionFallbackClaims | null;
}

/** How long a "loading" next-auth session is allowed to hang before this
 * hook stops waiting and treats the live call as unreachable. next-auth
 * does not cleanly distinguish "genuinely still loading" from "the
 * /api/auth/session fetch failed and will never resolve" — a real
 * network partition can leave status stuck on "loading" indefinitely.
 * This timeout is the practical way to avoid waiting forever; it is
 * deliberately generous so it never fires on a normal, merely-slow
 * connection. */
const LIVE_SESSION_TIMEOUT_MS = 4000;

function useIsBrowserOnline(): boolean {
  const [isOnline, setIsOnline] = useState<boolean>(() =>
    typeof navigator === "undefined" ? true : navigator.onLine
  );

  useEffect(() => {
    if (typeof window === "undefined") return;

    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  return isOnline;
}

/**
 * The raw `liveSession.user` shape is normalized through this ONE helper,
 * instead of separately-written inline type casts that could disagree on
 * which fields were optional. Every required field (id, tenantId,
 * tenantName, tenantSlug, role, subscriptionStatus) must be a genuinely
 * truthy value, or the whole session is treated as not-yet-usable
 * (returns null) rather than producing a partially-valid object with a
 * silently-wrong field.
 */
function extractValidatedUser(rawUser: unknown): {
  id: string;
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  role: "ADMIN" | "CASHIER";
  isPlatformAdmin: boolean;
  name?: string;
  subscriptionStatus: "ACTIVE" | "EXPIRED" | "PENDING";
} | null {
  const user = rawUser as {
    id?: string;
    tenantId?: string;
    tenantName?: string;
    tenantSlug?: string;
    role?: "ADMIN" | "CASHIER";
    isPlatformAdmin?: boolean;
    name?: string | null;
    subscriptionStatus?: "ACTIVE" | "EXPIRED" | "PENDING";
  } | null | undefined;

  if (!user) return null;
  if (
    !user.id ||
    !user.tenantId ||
    !user.tenantName ||
    !user.tenantSlug ||
    !user.role ||
    !user.subscriptionStatus
  ) {
    return null;
  }

  return {
    id: user.id,
    tenantId: user.tenantId,
    tenantName: user.tenantName,
    tenantSlug: user.tenantSlug,
    role: user.role,
    isPlatformAdmin: !!user.isPlatformAdmin,
    name: user.name ?? undefined,
    subscriptionStatus: user.subscriptionStatus,
  };
}

export function useSessionWithOfflineFallback(): UseSessionWithOfflineFallbackResult {
  const { data: liveSession, status: liveStatus, update } = useSession();
  const currentUserId = useActiveSessionStore((s) => s.currentUserId);
  const setCurrentUserId = useActiveSessionStore((s) => s.setCurrentUserId);
  const isOnline = useIsBrowserOnline();

  const [timedOut, setTimedOut] = useState(false);
  const [prevLiveStatus, setPrevLiveStatus] = useState(liveStatus);
  if (liveStatus !== prevLiveStatus) {
    setPrevLiveStatus(liveStatus);
    setTimedOut(false);
  }

  useEffect(() => {
    if (liveStatus !== "loading") return;
    const timer = setTimeout(() => setTimedOut(true), LIVE_SESSION_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [liveStatus]);

  // [FIX — reconnect handling] Connectivity returning is a strong signal
  // that whatever caused liveStatus to hang (or the browser to report
  // offline) may no longer apply. The moment `isOnline` flips true:
  //   1. `timedOut` is cleared immediately, so `liveIsUnreachable` stops
  //      being forced true purely by a stale timeout flag left over from
  //      the outage that just ended.
  //   2. next-auth is asked to re-resolve the live session right away via
  //      update(), rather than passively waiting for its own refetch
  //      schedule (window focus / refetchInterval) to eventually notice
  //      the network is back. This is also what triggers auth.ts's jwt
  //      callback to re-read subscriptionStatus/dailyExchangeRate fresh
  //      from the database (trigger === "update") — without this call,
  //      a stale subscriptionStatus could persist for an arbitrarily long
  //      stretch after reconnection, bounded only by next-auth's own
  //      refetch timing, not by this app's actual connectivity.
  // Without this effect, a device that was offline long enough to hit the
  // 4s timeout could stay on "offline-cached" for an indefinite,
  // user-visible stretch after connectivity genuinely returns — exactly
  // the intermittent-connection pattern this app is built around.
  useEffect(() => {
    if (!isOnline) return;
    setTimedOut(false);
    update().catch((err) => {
      console.error(
        "useSessionWithOfflineFallback: session re-check on reconnect failed:",
        err
      );
    });
    // Deliberately keyed on isOnline only — this should fire once per
    // offline->online transition, not on every render where isOnline
    // happens to already be true, and next-auth's `update` reference is
    // stable across renders in practice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOnline]);

  // On a successful LIVE resolution: remember this tab's userId (plain
  // sessionStorage-backed Zustand — see useActiveSessionStore's own doc
  // comment for why this must never be localStorage), and write-through
  // to the offline cache — the same write-through pattern T2c's
  // exchange-rate top-bar edit already follows for setCachedRate.
  useEffect(() => {
    if (liveStatus !== "authenticated") return;
    const validUser = extractValidatedUser(liveSession?.user);
    if (!validUser) return;

    setCurrentUserId(validUser.id);
    setCachedSession({
      userId: validUser.id,
      tenantId: validUser.tenantId,
      tenantName: validUser.tenantName,
      tenantSlug: validUser.tenantSlug,
      role: validUser.role,
      isPlatformAdmin: validUser.isPlatformAdmin,
      name: validUser.name,
      subscriptionStatus: validUser.subscriptionStatus,
    }).catch((err) => {
      console.error("Failed to write-through cached session claims:", err);
    });
  }, [liveStatus, liveSession, setCurrentUserId]);

  // The live call is considered unreachable — not merely "still
  // loading" — either because the browser reports it's offline, or
  // because a "loading" status has hung past LIVE_SESSION_TIMEOUT_MS.
  // Deliberately NOT based on liveStatus === "unauthenticated": while
  // offline, next-auth cannot actually verify that and may report
  // "unauthenticated" purely because the session fetch failed — trusting
  // that while offline would treat a real, still-logged-in user as
  // logged out the moment connectivity drops.
  const liveIsUnreachable = !isOnline || (liveStatus === "loading" && timedOut);

  const cacheLookupKey = liveIsUnreachable ? currentUserId : null;

  const [cachedClaims, setCachedClaims] = useState<CachedSession | null | undefined>(undefined);
  const [trackedLookupKey, setTrackedLookupKey] = useState<string | null>(null);
  if (cacheLookupKey !== trackedLookupKey) {
    setTrackedLookupKey(cacheLookupKey);
    setCachedClaims(undefined);
  }

  useEffect(() => {
    if (!cacheLookupKey) return;
    let cancelled = false;
    getCachedSession(cacheLookupKey).then((row) => {
      if (!cancelled) setCachedClaims(row);
    });
    return () => {
      cancelled = true;
    };
  }, [cacheLookupKey]);

  // 1. A genuinely successful live resolution always wins, even if
  // liveIsUnreachable's onLine check is a false positive (e.g. a captive
  // portal or flaky navigator.onLine) — if useSession() actually got a
  // real answer, trust it over any cached guess.
  if (liveStatus === "authenticated") {
    const validUser = extractValidatedUser(liveSession?.user);
    if (validUser) {
      return {
        status: "authenticated",
        data: {
          userId: validUser.id,
          tenantId: validUser.tenantId,
          tenantName: validUser.tenantName,
          tenantSlug: validUser.tenantSlug,
          role: validUser.role,
          isPlatformAdmin: validUser.isPlatformAdmin,
          name: validUser.name,
          source: "live",
          subscriptionStatus: validUser.subscriptionStatus,
        },
      };
    }
    // Authenticated per next-auth, but the session object is missing a
    // required field this app depends on (e.g. a stale token predating
    // tenantName/tenantSlug) — fall through rather than return a
    // partially-valid claims object.
  }

  // 2. Live is unreachable — fall back to this tab's own known identity,
  // if it has one. Never falls back for a tab that never resolved a live
  // session (currentUserId === null) — that tab honestly doesn't know
  // who's using it, and unreachable/unknown must not be papered over
  // with someone else's cached claims.
  if (liveIsUnreachable) {
    if (!currentUserId) {
      return { status: "unreachable", data: null };
    }
    if (cachedClaims === undefined) {
      return { status: "loading", data: null };
    }
    if (cachedClaims === null) {
      // Known userId, but nothing cached for it (e.g. first-ever login
      // happened to fail before any write-through completed).
      return { status: "unreachable", data: null };
    }
    return {
      status: "offline-cached",
      data: {
        userId: cachedClaims.userId,
        tenantId: cachedClaims.tenantId,
        tenantName: cachedClaims.tenantName,
        tenantSlug: cachedClaims.tenantSlug,
        role: cachedClaims.role,
        isPlatformAdmin: cachedClaims.isPlatformAdmin,
        name: cachedClaims.name,
        source: "cached",
        subscriptionStatus: cachedClaims.subscriptionStatus,
      },
    };
  }

  // 3. Live is reachable (we're online) and next-auth has definitively
  // resolved to "not logged in" — this is the one case it's safe to
  // trust that status at face value.
  if (liveStatus === "unauthenticated") {
    return { status: "unauthenticated", data: null };
  }

  // 4. Still genuinely loading, online, within the timeout window.
  return { status: "loading", data: null };
}