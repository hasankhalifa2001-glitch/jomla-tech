"use client";

import { useLiveQuery } from "dexie-react-hooks";
import { getOfflineDb, isOfflineDbSupported } from "./db";
import { getCachedRate } from "./exchange-rate";

export type OfflineDbStatus =
  | "INITIALIZING"
  | "READY"
  | "NO_CACHED_DATA"
  | "UNSUPPORTED"
  | "ERROR";

export interface OfflineDbReadyResult {
  isReady: boolean;
  isDbOpen: boolean;
  hasCachedData: boolean;
  isEmptyCache: boolean;
  status: OfflineDbStatus;
  /** Present only when status === "ERROR". */
  error?: string;
}

const UNSUPPORTED_RESULT: OfflineDbReadyResult = {
  isReady: false,
  isDbOpen: false,
  hasCachedData: false,
  isEmptyCache: true,
  status: "UNSUPPORTED",
};

const INITIALIZING_RESULT: OfflineDbReadyResult = {
  isReady: false,
  isDbOpen: false,
  hasCachedData: false,
  isEmptyCache: false,
  status: "INITIALIZING",
};

/**
 * Checks the database readiness and cache population status FOR A SPECIFIC
 * TENANT. tenantId is REQUIRED — throws rather than falling back to an
 * unscoped, cross-tenant count.
 *
 * [MERGE NOTE] An earlier revision of this file made tenantId optional and,
 * when omitted, counted across `db.cachedProducts.count()` /
 * `cachedCustomers.count()` / `cachedTenantSettings.count()` with NO
 * tenantId filter at all — i.e. a sum across every tenant that has ever
 * used this device. That is exactly the class of cross-tenant leak T1's
 * isolation rules exist to prevent (the same reasoning that removed
 * exchange-rate.ts's DEFAULT_TENANT_CACHE_KEY shared fallback). A caller
 * missing tenantId is a bug and must fail loudly here, not silently
 * receive a meaningless aggregate count. Every count below is always
 * scoped to the one tenantId this call was given.
 *
 * isReady requires ALL THREE caches to be populated together — products,
 * customers, AND the exchange rate — not any single one (AND, not OR).
 * T4b's POS needs all three to function correctly: products/units/batches
 * to sell, real customer balances to record debt against, and a rate to
 * price a sale. A device with only a cached exchange rate (the most
 * likely partial state, since the rate updates and gets written most
 * often) reporting READY would let POS open onto an empty product list
 * with no explanation — exactly the silent-failure this check exists to
 * prevent.
 *
 * [MERGE NOTE] An earlier revision computed `isReady: hasCachedData` (an
 * OR across the three counts) — that is precisely the silent-failure
 * scenario the paragraph above warns against, and is NOT used here.
 * hasCachedData itself remains an OR (useful for "is there SOMETHING
 * cached at all" contexts, e.g. deciding whether to show a "no data yet"
 * vs. "partial data" message) but never drives isReady/status on its own.
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

    return {
      isReady,
      isDbOpen: true,
      hasCachedData,
      isEmptyCache: !hasCachedData,
      status: isReady ? "READY" : "NO_CACHED_DATA",
    };
  } catch (error) {
    // [MERGE NOTE] A genuine runtime failure (a blocked connection, a
    // quota error, a corrupted table) is distinguished from
    // "UNSUPPORTED" (this browser has no IndexedDB at all) — the two call
    // for different UI responses, so they're reported as separate
    // statuses rather than collapsing a real error into the
    // never-offline-capable case.
    console.error("Dexie failed to inspect database readiness:", error);
    return {
      isReady: false,
      isDbOpen: false,
      hasCachedData: false,
      isEmptyCache: true,
      status: "ERROR",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Reactive Dexie readiness hook with cold empty-cache detection, scoped to
 * a single tenant.
 *
 * [MERGE NOTE — why useLiveQuery] An earlier revision used a one-shot
 * `useEffect` keyed only on `[tenantId, supported]`. That meant a cold,
 * offline app load reporting NO_CACHED_DATA would never transition to
 * READY on its own once refreshProductCache()/refreshCustomerCache()
 * populated the tables in the background after connectivity returned — a
 * screen depending on this hook (T4b's POS) would stay stuck on the
 * empty-cache message until an unrelated remount. useLiveQuery subscribes
 * directly to the underlying Dexie tables accessed inside
 * checkOfflineCacheStatus, so a write from either refresh function is
 * reflected here automatically, with no manual re-check required by any
 * caller.
 *
 * When tenantId is not yet known (e.g. session still loading), the query
 * function deliberately never calls checkOfflineCacheStatus at all —
 * calling it with an empty tenantId would throw (by design, see above) —
 * and instead resolves INITIALIZING_RESULT directly, matching the
 * pre-tenant state a caller should render as "still loading," not as an
 * error.
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
 * string — never a native JS number — so any consumer doing further
 * arithmetic (T4b's cart math) stays on the decimal.js-safe path the
 * whole way through, per T1's money-handling rule.
 *
 * [MERGE NOTE] An earlier revision of this hook called the legacy
 * getCachedDailyExchangeRate(), which returns a plain `number` explicitly
 * documented (in exchange-rate.ts) as DISPLAY ONLY and "must NEVER be used
 * as an input to further monetary arithmetic" — yet this hook's own doc
 * comment at the time claimed it "enables dual-currency math," a direct
 * contradiction. A native-number exchange rate multiplied against a cart
 * total can reintroduce float drift before the value ever reaches
 * lib/utils/money.ts. This hook now calls getCachedRate() directly and
 * returns the raw decimal string; converting to a number for display is
 * the caller's job, at the point it's actually rendered, not here.
 *
 * Reactive via useLiveQuery (see useOfflineDbReady's note above) instead
 * of a one-shot effect, so a rate written by T2c's top-bar edit or by the
 * initial online cache load is picked up automatically.
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
    /** Decimal-serialized string, or null if no rate is cached yet.
     * NEVER use this for further arithmetic without going back through
     * lib/utils/money.ts's toDecimal() first. */
    rate: cached?.rate ?? null,
    cachedAt: cached?.cachedAt ?? null,
    /** True until the first live-query resolution (undefined = pending). */
    isLoading: cached === undefined,
  };
}