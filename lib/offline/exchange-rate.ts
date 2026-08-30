/**
 * Exchange Rate Cache Helper
 * 
 * Manages the offline cached exchange rate in Dexie (cachedTenantSettings).
 * - Written whenever the app is online: on load and when the admin updates the rate.
 * - Read by any component needing dual-currency math (POS, checkout, reports).
 */

import { getOfflineDb, isOfflineDbSupported } from "./db";

export const DEFAULT_TENANT_CACHE_KEY = "global_tenant";

/**
 * Retrieves the cached daily exchange rate from Dexie.
 * If tenantId is provided, returns that tenant's rate; otherwise returns the latest recorded rate.
 */
export async function getCachedDailyExchangeRate(tenantId?: string): Promise<number | null> {
  if (!isOfflineDbSupported()) {
    return null;
  }

  try {
    const db = getOfflineDb();
    if (tenantId) {
      const setting = await db.cachedTenantSettings.get(tenantId);
      return setting ? setting.dailyExchangeRate : null;
    }

    // Return the most recently updated tenant settings cache
    const latest = await db.cachedTenantSettings.orderBy("cachedAt").last();
    return latest ? latest.dailyExchangeRate : null;
  } catch (error) {
    console.error("Failed to read cached daily exchange rate from Dexie:", error);
    return null;
  }
}

/**
 * Writes or updates the cached daily exchange rate in Dexie.
 */
export async function setCachedDailyExchangeRate(
  rate: number,
  tenantId: string = DEFAULT_TENANT_CACHE_KEY
): Promise<void> {
  if (!isOfflineDbSupported()) {
    return;
  }

  if (typeof rate !== "number" || isNaN(rate) || rate <= 0) {
    return;
  }

  try {
    const db = getOfflineDb();
    await db.cachedTenantSettings.put({
      tenantId,
      dailyExchangeRate: rate,
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
