/**
 * Exchange Rate Cache Helper
 *
 * Manages the offline cached exchange rate in Dexie (cachedTenantSettings).
 * - Written whenever the app is online: on load and when the admin updates the rate.
 * - Read by any component needing dual-currency math (POS, checkout, reports).
 *
 * [FIX] dailyExchangeRate is a monetary field per T4a's schema — it must be
 * stored as a decimal.js-serialized string via lib/utils/money.ts, never a
 * native JS number, matching every other monetary field in the Dexie schema.
 * [FIX] tenantId defaulting is now IDENTICAL on the write path and the read
 * path (DEFAULT_TENANT_CACHE_KEY in both directions). The previous version
 * defaulted the write to a sentinel key but had the read fall back to
 * "whichever tenant was cached most recently" when no tenantId was passed —
 * that mismatch could leak one tenant's exchange rate into another tenant's
 * session on a shared device. There is no longer any code path that returns
 * a rate belonging to a tenant other than the one asked for.
 * [FIX — fail-loud, not fail-silent] setCachedDailyExchangeRate previously
 * validated its input with `if (... ) { return; }` — an invalid or
 * non-positive rate was silently discarded, with no error, no log entry,
 * and no signal to the caller that the write never happened. That
 * contradicts money.ts's own stated philosophy ("a silently-wrong number
 * is strictly worse than a thrown error"): a caller (e.g. the top-bar rate
 * input, or a future scheduled sync job) could reasonably assume the write
 * succeeded and move on, leaving the cashier checking out against a stale
 * or missing rate with no indication why. The function now takes the same
 * `MoneyInput` shape every other money.ts-adjacent function takes, routes
 * it through `toDecimal()`, and throws `MoneyError` for anything invalid
 * or non-positive — callers must handle the rejection explicitly instead
 * of the failure disappearing.
 */

import { getOfflineDb, isOfflineDbSupported } from "./db";
import { serializeMoney, toDecimal, MoneyError, type MoneyInput } from "../utils/money";

export const DEFAULT_TENANT_CACHE_KEY = "global_tenant";

/**
 * Retrieves the cached daily exchange rate from Dexie for a specific tenant
 * (or the sentinel key if no tenantId is available — e.g. pre-login state).
 * Never returns a different tenant's cached rate.
 */
export async function getCachedDailyExchangeRate(tenantId?: string): Promise<number | null> {
  if (!isOfflineDbSupported()) {
    return null;
  }

  const key = tenantId || DEFAULT_TENANT_CACHE_KEY;

  try {
    const db = getOfflineDb();
    const setting = await db.cachedTenantSettings.get(key);
    if (!setting || !setting.dailyExchangeRate) {
      return null;
    }
    // Stored as a decimal.js-serialized string; converted back to a plain
    // number here only for UI/display consumption (Zustand store, inputs).
    return toDecimal(setting.dailyExchangeRate).toNumber();
  } catch (error) {
    console.error("Failed to read cached daily exchange rate from Dexie:", error);
    return null;
  }
}

/**
 * Writes or updates the cached daily exchange rate in Dexie, for a specific
 * tenant (or the sentinel key if no tenantId is available).
 *
 * Throws MoneyError — does not silently no-op — if `rate` is not a valid,
 * finite, positive monetary value. The Dexie write itself (a genuine I/O
 * failure) is still caught and logged rather than thrown, matching the
 * read side's behavior; only input *validation* is fail-loud here, since
 * that failure is a caller bug worth surfacing immediately, not a runtime
 * condition the caller is expected to already handle.
 */
export async function setCachedDailyExchangeRate(
  rate: MoneyInput,
  tenantId?: string
): Promise<void> {
  if (!isOfflineDbSupported()) {
    return;
  }

  const decimalRate = toDecimal(rate); // throws MoneyError for non-finite/invalid input
  if (decimalRate.isZero() || decimalRate.isNegative()) {
    throw new MoneyError(
      `Invalid daily exchange rate (${decimalRate.toString()}): must be a positive value.`
    );
  }

  const key = tenantId || DEFAULT_TENANT_CACHE_KEY;

  try {
    const db = getOfflineDb();
    await db.cachedTenantSettings.put({
      tenantId: key,
      dailyExchangeRate: serializeMoney(decimalRate),
      cachedAt: new Date(),
    });
  } catch (error) {
    console.error("Failed to write daily exchange rate to Dexie cache:", error);
  }
}

/**
 * Removes cached exchange rate setting for a specific tenant or all.
 */
export async function clearCachedExchangeRate(tenantId?: string): Promise<void> {
  if (!isOfflineDbSupported()) {
    return;
  }

  try {
    const db = getOfflineDb();
    if (tenantId) {
      await db.cachedTenantSettings.delete(tenantId);
    } else {
      await db.cachedTenantSettings.clear();
    }
  } catch (error) {
    console.error("Failed to clear cached exchange rate:", error);
  }
}