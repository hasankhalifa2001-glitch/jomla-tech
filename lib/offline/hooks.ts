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
// (Full design rationale unchanged from prior revisions — see the
// [FIX — this revision] notes below for what changed this pass.)
// ============================================================================

export type SessionFallbackStatus =
  | "loading"
  | "authenticated"
  | "unauthenticated"
  | "offline-cached"
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
  subscriptionStatus: "ACTIVE" | "EXPIRED" | "PENDING";
}

export interface UseSessionWithOfflineFallbackResult {
  status: SessionFallbackStatus;
  data: SessionFallbackClaims | null;
}

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
 * [FIX — this revision] The raw `liveSession.user` shape is normalized
 * through this ONE helper now, instead of two separately-written inline
 * type casts (one in the write-through effect, one in the "authenticated"
 * return branch) that previously disagreed on which fields were optional.
 * The effect's cast treated tenantName/tenantSlug as optional while the
 * return-branch cast asserted them as required — meaning a session object
 * genuinely missing either field (e.g. an old cached JWT from before
 * tenantName/tenantSlug were added to auth.ts) could silently pass
 * `undefined` into a field CachedSession/SessionFallbackClaims both
 * declare as a required `string`, with no runtime check catching it at
 * either site. This helper applies ONE consistent guard: every required
 * field (id, tenantId, tenantName, tenantSlug, role) must be a genuinely
 * truthy string, or the whole session is treated as not-yet-usable
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
    subscriptionStatus: "ACTIVE" | "EXPIRED" | "PENDING";
  } | null | undefined;

  if (!user) return null;
  if (!user.id || !user.tenantId || !user.tenantName || !user.tenantSlug || !user.role || !user.subscriptionStatus) {
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
  const { data: liveSession, status: liveStatus } = useSession();
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

  // [FIX — this revision] Now goes through extractValidatedUser() instead
  // of a separate, more lenient inline cast — a live session missing
  // tenantName/tenantSlug is treated the same way here as in the
  // "authenticated" return branch below: skipped entirely, never
  // write-through-cached with an undefined field masquerading as a
  // required string.
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

  // 1. A genuinely successful live resolution always wins — now via the
  // same extractValidatedUser() helper the write-through effect uses
  // above, so both call sites agree on exactly which fields are required.
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
    // required field this app depends on (e.g. stale token predating
    // tenantName/tenantSlug) — fall through rather than return a
    // partially-valid claims object.
  }

  // 2. Live is unreachable — fall back to this tab's own known identity,
  // if it has one.
  if (liveIsUnreachable) {
    if (!currentUserId) {
      return { status: "unreachable", data: null };
    }
    if (cachedClaims === undefined) {
      return { status: "loading", data: null };
    }
    if (cachedClaims === null) {
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
  // resolved to "not logged in".
  if (liveStatus === "unauthenticated") {
    return { status: "unauthenticated", data: null };
  }

  // 4. Still genuinely loading, online, within the timeout window.
  return { status: "loading", data: null };
}