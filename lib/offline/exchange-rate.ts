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
 */

import { getOfflineDb, isOfflineDbSupported } from "./db";
import { serializeMoney, toDecimal } from "../utils/money";

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
 */
export async function setCachedDailyExchangeRate(
  rate: number,
  tenantId?: string
): Promise<void> {
  if (!isOfflineDbSupported()) {
    return;
  }

  if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) {
    return;
  }

  const key = tenantId || DEFAULT_TENANT_CACHE_KEY;

  try {
    const db = getOfflineDb();
    await db.cachedTenantSettings.put({
      tenantId: key,
      dailyExchangeRate: serializeMoney(rate),
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