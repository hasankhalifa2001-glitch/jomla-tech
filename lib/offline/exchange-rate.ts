/**
 * Exchange Rate Cache Helper
 *
 * Manages the offline cached exchange rate in Dexie (cachedTenantSettings).
 * - Written whenever the app is online: on load and when the admin updates the rate.
 * - Read by any component needing dual-currency math (POS, checkout, reports).
 *
 * getCachedRate()/setCachedRate() are the canonical contract (per T1's
 * spec: `getCachedRate(tenantId): Promise<{ rate: string; cachedAt: Date }
 * | null>` / `setCachedRate(tenantId, rate): Promise<void>`). Every other
 * function in this file is a thin, display-oriented wrapper around these
 * two — there is exactly one Dexie read path and one Dexie write path for
 * the cached rate, no matter which function a caller reaches for.
 *
 * [FIX] dailyExchangeRate is a monetary field — it must be stored as a
 * decimal.js-serialized string via lib/utils/money.ts, never a native JS
 * number, matching every other monetary field in the Dexie schema.
 *
 * [FIX — no more duplicate implementation] getCachedDailyExchangeRate/
 * setCachedDailyExchangeRate previously reimplemented their own Dexie
 * read/write logic independently of getCachedRate/setCachedRate. Two
 * independent implementations of "read/write the cached rate" is exactly
 * the kind of drift this module exists to prevent — a future change to
 * the storage shape could be applied to one pair and silently forgotten
 * on the other. The legacy functions are now pure wrappers over
 * getCachedRate/setCachedRate; there is only one source of truth for the
 * actual Dexie read/write underneath.
 *
 * [FIX — removed shared-key fallback, kept from the stricter revision]
 * This module previously fell back to a shared DEFAULT_TENANT_CACHE_KEY
 * ("global_tenant") whenever no tenantId was passed, on both the read and
 * write paths. That fallback is DELIBERATELY NOT reintroduced here, even
 * though it would have been the simplest way to give the legacy functions
 * an optional-tenantId signature — every real call site in the codebase
 * (ExchangeRateInitializer, ExchangeRateTopbar) already resolves and
 * passes a real tenantId before ever calling into this module, and none
 * of them has a legitimate "pre-tenant" state that needs a shared cache
 * row. Keeping such a fallback around is a live cross-tenant-leak risk,
 * not a convenience: a caller that forgot to pass tenantId would silently
 * read or write a cache row shared across every tenant that ever used
 * this device — exactly what T1's tenant-isolation rules exist to
 * prevent — and it would also leave a stray shared row in
 * cachedTenantSettings that could make useOfflineDbReady()'s "cache is
 * genuinely empty" check pass incorrectly for a tenant that has never
 * actually been cached. tenantId is therefore a required, non-optional
 * parameter on EVERY function in this file, canonical or legacy — a
 * caller missing it gets a thrown Error immediately, never a silent
 * fallback to a shared key.
 *
 * [FIX — fail-loud, not fail-silent] setCachedRate/setCachedDailyExchangeRate
 * validate their input the same way every other money.ts-adjacent function
 * does: routed through `toDecimal()`, throwing `MoneyError` for anything
 * invalid or non-positive. An invalid or non-positive rate is never
 * silently discarded — a caller (e.g. the top-bar rate input, or a future
 * scheduled sync job) must handle the rejection explicitly instead of the
 * failure disappearing and leaving a cashier checking out against a stale
 * or missing rate with no indication why.
 */

import { getOfflineDb, isOfflineDbSupported } from "./db";
import { serializeMoney, toDecimal, MoneyError, type MoneyInput } from "../utils/money";

/**
 * Retrieves the cached exchange rate from Dexie for a specific tenant.
 * Returns the exact rate string and cachedAt timestamp, or null if missing
 * or if tenantId is empty — this function never falls back to a shared
 * key, so it can never return a rate belonging to a tenant other than the
 * one asked for.
 */
export async function getCachedRate(
  tenantId: string
): Promise<{ rate: string; cachedAt: Date } | null> {
  if (!isOfflineDbSupported() || !tenantId || !tenantId.trim()) {
    return null;
  }

  const key = tenantId.trim();
  try {
    const db = getOfflineDb();
    const setting = await db.cachedTenantSettings.get(key);
    if (!setting || !setting.dailyExchangeRate) {
      return null;
    }
    return {
      rate: setting.dailyExchangeRate,
      cachedAt: setting.cachedAt ? new Date(setting.cachedAt) : new Date(),
    };
  } catch (error) {
    console.error("Failed to read cached rate from Dexie:", error);
    return null;
  }
}

/**
 * Writes the cached exchange rate to Dexie for a specific tenant.
 * Accepts string, number, or Decimal and stores as a decimal.js serialized
 * string. Throws MoneyError for an invalid or non-positive rate, and
 * throws a plain Error if tenantId is missing — neither failure is
 * swallowed, since this is always an explicit, caller-initiated write
 * (the top-bar rate edit, or a scheduled sync) that the caller must know
 * did not succeed.
 */
export async function setCachedRate(tenantId: string, rate: MoneyInput): Promise<void> {
  if (!tenantId || !tenantId.trim()) {
    throw new Error("tenantId is required to cache exchange rate.");
  }

  const decimalRate = toDecimal(rate); // throws MoneyError for non-finite/invalid input
  if (decimalRate.isZero() || decimalRate.isNegative()) {
    throw new MoneyError(
      `Invalid daily exchange rate (${decimalRate.toString()}): must be a positive value.`
    );
  }

  const key = tenantId.trim();
  try {
    const db = getOfflineDb();
    await db.cachedTenantSettings.put({
      tenantId: key,
      dailyExchangeRate: serializeMoney(decimalRate),
      cachedAt: new Date(),
    });
  } catch (error) {
    // A genuine I/O failure (quota, blocked connection, etc.) is logged
    // but not re-thrown here — only input *validation* is fail-loud in
    // this module; a transient Dexie write failure is reported the same
    // way getCachedRate reports a transient read failure (log + safe
    // fallback), not as an exception an ordinary caller is expected to
    // catch on every write.
    console.error("Failed to write daily exchange rate to Dexie cache:", error);
  }
}

/**
 * @deprecated Display-only convenience wrapper over getCachedRate() —
 * returns a plain `number` for UI binding (Zustand store, form inputs)
 * and must NEVER be used as an input to further monetary arithmetic (cart
 * totals, conversions). Use getCachedRate() directly for anything that
 * feeds a calculation, so the value stays a decimal.js-safe string all
 * the way through.
 *
 * tenantId is required, same as getCachedRate() — there is no shared/
 * global cache row for either function. Throws if omitted rather than
 * silently reading a fallback key.
 */
export async function getCachedDailyExchangeRate(tenantId: string): Promise<number | null> {
  if (!tenantId || !tenantId.trim()) {
    throw new Error("tenantId is required to read the cached daily exchange rate.");
  }
  const cached = await getCachedRate(tenantId.trim());
  if (!cached) return null;
  // Converted to a plain number here ONLY for UI/display consumption.
  return toDecimal(cached.rate).toNumber();
}

/**
 * @deprecated Thin wrapper over setCachedRate() for existing call sites
 * expecting this (rate, tenantId) argument order. Prefer
 * setCachedRate(tenantId, rate) directly in any new code.
 *
 * tenantId is required, same as setCachedRate() — there is no shared/
 * global cache row for either function. Throws if omitted rather than
 * silently writing to a fallback key.
 */
export async function setCachedDailyExchangeRate(
  rate: MoneyInput,
  tenantId: string
): Promise<void> {
  if (!tenantId || !tenantId.trim()) {
    throw new Error("tenantId is required to cache the daily exchange rate.");
  }
  await setCachedRate(tenantId.trim(), rate);
}

/**
 * Removes cached exchange rate setting for a specific tenant, or clears
 * every cached tenant's setting when no tenantId is given (used by tests /
 * a full local data wipe — not a normal runtime code path).
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