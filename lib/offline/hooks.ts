/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";

import { useEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { useLiveQuery } from "dexie-react-hooks";
import { getOfflineDb, isOfflineDbSupported, type CachedSession } from "./db";
// [v4.1 — T4d offline void] The read helper behind usePendingOfflineInvoices
// below. No cycle: pos-service.ts never imports this file.
import {
  listPendingOfflineInvoices,
  type PendingOfflineInvoiceRow,
  type PendingOfflineInvoicesResult,
} from "./pos-service";
import { getCachedRate } from "./exchange-rate";
import { getCachedSession, setCachedSession, clearCachedSession } from "./session-cache";
import { useActiveSessionStore } from "@/lib/store/useActiveSessionStore";

export type OfflineDbStatus =
  | "INITIALIZING"
  | "READY"
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
   * decision. The real security boundary is always
   * assertTenantWritable(tenantId) on the server, which re-reads fresh
   * from the database on every mutating request regardless of what this
   * value says.
   */
  subscriptionStatus: "ACTIVE" | "EXPIRED" | "PENDING";
}

export interface UseSessionWithOfflineFallbackResult {
  status: SessionFallbackStatus;
  data: SessionFallbackClaims | null;
  update?: (data?: any) => Promise<any>;
}

/** How long a "loading" next-auth session is allowed to hang before this
 * hook stops waiting and treats the live call as unreachable. Also reused
 * as the timeout for the direct /api/auth/session verification fetch
 * below, so no path in this hook can hang longer than this single,
 * consistent ceiling. */
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
 * which fields were optional. Every required field must be a genuinely
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
  const hasHydrated = useActiveSessionStore((s) => s.hasHydrated);
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

  // [FIX — reconnect handling] On a genuine offline->online transition,
  // clear any stale timeout flag during render (not inside the effect —
  // see the render-purity note this mirrors on prevLiveStatus above), and
  // ask next-auth to re-resolve the live session via update() from inside
  // the effect below, which is the only place a real network call belongs.
  const [prevIsOnlineForReconnect, setPrevIsOnlineForReconnect] = useState(isOnline);
  if (isOnline !== prevIsOnlineForReconnect) {
    setPrevIsOnlineForReconnect(isOnline);
    if (isOnline) {
      setTimedOut(false);
    }
  }

  // [FIX — review pass 2: real transition only, not "first time we see
  // isOnline === true"] A prior revision gated update() behind a ref that
  // flipped to `true` the first time the effect ran WHILE isOnline was
  // already true — intended to skip firing update() on an ordinary mount
  // that happens to already be online (ubiquitous case, no reconnect
  // occurred). That logic had a real bug: if the tab mounted OFFLINE
  // (isOnline === false), the effect's very first invocation returned
  // early on `if (!isOnline) return;` BEFORE ever reaching the
  // "first run" check — so the ref was never set to true during that
  // offline mount. The very next time the effect ran with isOnline ===
  // true (i.e. the actual, real reconnect this whole mechanism exists to
  // detect) was then WRONGLY treated as "the first time we've seen
  // online", swallowing the update() call on exactly the scenario this
  // hook is built around: a tab that starts offline and later reconnects.
  //
  // Fixed by decoupling "is this the effect's first invocation" from
  // "what was isOnline's value on that first invocation" — isFirstRun is
  // set unconditionally on the effect's first run, regardless of
  // isOnline, so only a genuine SUBSEQUENT change to isOnline (a real
  // transition, in either direction) can ever reach the isOnline check
  // below and fire update().
  const isFirstRun = useRef(true);

  useEffect(() => {
    if (isFirstRun.current) {
      isFirstRun.current = false;
      return;
    }
    if (!isOnline) return;
    update().catch((err) => {
      console.error(
        "useSessionWithOfflineFallback: session re-check on reconnect failed:",
        err
      );
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOnline]);

  // On a successful LIVE resolution: remember this tab's userId and
  // write-through to the offline cache — the same write-through pattern
  // T2c's exchange-rate top-bar edit already follows for setCachedRate.
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

  // ==========================================================================
  // [FIX — real logout verification] next-auth can report "unauthenticated"
  // within milliseconds of a FAILED /api/auth/session fetch (a flaky
  // connection, a captive portal, a DNS blip) — not only after a genuine
  // server-confirmed "no session" response. navigator.onLine can easily
  // still read `true` in that exact scenario. Trusting "unauthenticated" at
  // face value here would silently sign out a real, still-logged-in user.
  //
  // The moment liveStatus flips to "unauthenticated" AND this tab
  // previously knew a real identity (currentUserId is set), independently
  // confirm it with a direct, timeout-bounded fetch to the session
  // endpoint:
  //   - resolves with no user  -> genuinely logged out server-side. Trust
  //     it, and clean up this tab's cached identity.
  //   - resolves with a user   -> next-auth's client state was out of
  //     sync; ask it to re-resolve via update(), NOT a logout.
  //   - throws OR times out (AbortController, same LIVE_SESSION_TIMEOUT_MS
  //     ceiling used everywhere else in this hook) -> never a confirmed
  //     logout, just unreachable/too-slow. Falls through to the
  //     offline-cached path instead of hanging indefinitely on a merely
  //     slow (not dead) connection.
  // A tab that never had a known identity (currentUserId is null) has
  // nothing to verify — trust "unauthenticated" immediately, same as
  // before.
  //
  // NOTE: a real, user-initiated logout button should call
  // setCurrentUserId(null) itself before signOut() runs, so this
  // verification path is skipped entirely for the single most common
  // "unauthenticated" case — see the Logout button implementation.
  //
  // [FIX — render-purity] The two "obvious, no-fetch-needed" outcomes are
  // knowable synchronously from this render's own liveStatus/currentUserId:
  //   - liveStatus isn't "unauthenticated" at all -> verifiedLogout should
  //     just be false (irrelevant/reset).
  //   - it IS "unauthenticated", but this tab never knew a real userId to
  //     begin with -> trivially "verified" (nothing to lose, nothing to
  //     check).
  // Neither needs an effect, and definitely not a synchronous setState as
  // the first statement inside one (same class of issue already fixed
  // above for prevLiveStatus/prevIsOnlineForReconnect — see React's
  // "Avoid calling setState() directly within an effect" warning). Only
  // the genuinely ambiguous case — unauthenticated AND a known
  // currentUserId — needs a real async side effect (the fetch below),
  // which is exactly what's left inside the effect itself.
  // ==========================================================================
  const logoutCheckKey =
    liveStatus === "unauthenticated" ? currentUserId ?? "" : null;

  const [verifiedLogout, setVerifiedLogout] = useState(false);
  const [prevLogoutCheckKey, setPrevLogoutCheckKey] = useState<string | null>(
    logoutCheckKey
  );
  if (logoutCheckKey !== prevLogoutCheckKey) {
    setPrevLogoutCheckKey(logoutCheckKey);
    if (liveStatus !== "unauthenticated") {
      // Not in the unauthenticated case at all right now — reset.
      setVerifiedLogout(false);
    } else if (!currentUserId) {
      // Unauthenticated, and this tab never knew a real identity to
      // begin with — trivially verified, no fetch needed.
      setVerifiedLogout(true);
    } else {
      // The genuinely ambiguous case: unauthenticated AND a known prior
      // identity. Not yet verified — the effect below will confirm it.
      setVerifiedLogout(false);
    }
  }

  useEffect(() => {
    // Only the ambiguous case needs the actual network round-trip.
    if (liveStatus !== "unauthenticated" || !currentUserId) return;

    let cancelled = false;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), LIVE_SESSION_TIMEOUT_MS);

    fetch("/api/auth/session", { cache: "no-store", signal: controller.signal })
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
          setVerifiedLogout(false);
          return;
        }
        const body = await res.json().catch(() => null);
        const reallyLoggedOut = !body || !body.user;
        setVerifiedLogout(reallyLoggedOut);
        if (reallyLoggedOut) {
          setCurrentUserId(null);
          clearCachedSession(currentUserId).catch((err) => {
            console.error("Failed to clear cached session on confirmed logout:", err);
          });
        } else {
          update().catch(() => { });
        }
      })
      .catch(() => {
        // Covers both a genuine network failure AND the AbortController
        // timeout firing — either way, never a confirmed logout, just
        // unreachable/too-slow. Falls through to offline-cached instead
        // of hanging indefinitely.
        if (!cancelled) setVerifiedLogout(false);
      })
      .finally(() => {
        clearTimeout(timeoutId);
      });

    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(timeoutId);
    };
  }, [liveStatus, currentUserId, setCurrentUserId, update]);

  // liveIsUnreachable also covers an UNVERIFIED "unauthenticated" while a
  // known prior identity exists — until the check above confirms it one
  // way or the other (bounded by LIVE_SESSION_TIMEOUT_MS), treat it the
  // same as offline rather than as a confirmed logout.
  const liveIsUnreachable =
    !isOnline ||
    (liveStatus === "loading" && timedOut) ||
    (liveStatus === "unauthenticated" && !!currentUserId && !verifiedLogout);

  const cacheLookupKey = liveIsUnreachable && hasHydrated ? currentUserId : null;

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

  // 1. A genuinely successful live resolution always wins.
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
        update,
      };
    }
  }

  // 2. Live is unreachable (or an unconfirmed "unauthenticated") — fall
  // back to this tab's own known identity, if it has one.
  if (liveIsUnreachable) {
    if (!hasHydrated) {
      return { status: "loading", data: null, update };
    }
    if (!currentUserId) {
      return { status: "unreachable", data: null, update };
    }
    if (cachedClaims === undefined) {
      return { status: "loading", data: null, update };
    }
    if (cachedClaims === null) {
      return { status: "unreachable", data: null, update };
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
      update,
    };
  }

  // 3. liveStatus === "unauthenticated" reaches here ONLY when there was
  // never a known identity, or the direct check above confirmed it — a
  // real, trustworthy logout either way.
  if (liveStatus === "unauthenticated") {
    return { status: "unauthenticated", data: null, update };
  }

  // 4. Still genuinely loading, online, within the timeout window.
  return { status: "loading", data: null, update };
}

// ============================================================================
// usePendingOfflineInvoices — T4d v4.1's live data source for the POS offline
// void panel (components/pos/offline-void-panel.tsx).
//
// Deliberately its OWN hook rather than a reuse of useSyncWorker's
// pendingCount: that count is a combined customers+invoices+payments figure
// and says nothing about WHICH invoices are outstanding, whereas the panel
// needs per-invoice rows (customer, total, time, status badge). Same
// useLiveQuery pattern as useSyncWorker's pendingCount (sync-worker.ts),
// scoped to invoices specifically, so the panel updates the instant the
// underlying data changes: a newly-queued offline sale makes it appear, a
// completed sync of the last pending/failed invoice makes it disappear — with
// no manual refresh and no remount.
//
// `isReady` distinguishes "the live query has not resolved yet" from "there is
// genuinely nothing to show". The panel renders nothing in BOTH cases, but it
// uses isReady so Dexie's very first read cannot flash a stale/absent state.
// ============================================================================
const EMPTY_PENDING_OFFLINE_INVOICES: PendingOfflineInvoicesResult = {
  rows: [],
  originals: [],
  localVoids: [],
};

export function usePendingOfflineInvoices(tenantId?: string): {
  rows: PendingOfflineInvoiceRow[];
  originals: PendingOfflineInvoiceRow[];
  localVoids: PendingOfflineInvoiceRow[];
  isReady: boolean;
} {
  const result = useLiveQuery(
    async () => {
      if (!tenantId || !isOfflineDbSupported()) return EMPTY_PENDING_OFFLINE_INVOICES;
      return listPendingOfflineInvoices(tenantId);
    },
    [tenantId]
  );

  const resolved = result ?? EMPTY_PENDING_OFFLINE_INVOICES;
  return { ...resolved, isReady: result !== undefined };
}
