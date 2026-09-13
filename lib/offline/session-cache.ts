/**
 * Cached Session Offline Helper
 *
 * Manages cached authenticated session claims in Dexie (cachedSession).
 * - Written on every successful online session resolution (login or
 *   useSession() resolving live) — see useSessionWithOfflineFallback() in
 *   lib/offline/hooks.ts, which owns the write-through call.
 * - Read as fallback by useSessionWithOfflineFallback() when genuinely
 *   offline, for a SPECIFIC, already-known userId — never guessed.
 * - Cleared on explicit logout, for that specific user only.
 *
 * NOTE on authorization:
 * This cache is informational / client-routing ONLY (mirrors JWT-cached
 * claims, T2a) and is NEVER trusted for server-side API authorization
 * checks (assertTenantWritable), which always re-validate server-side
 * once connectivity returns.
 *
 * [FIX — review pass] Two issues closed in this revision, both stemming
 * from the same root cause: treating this table as if it could only ever
 * hold one meaningful row, when it's explicitly designed (per
 * CachedSession's doc comment in db.ts) to hold one row PER USER on a
 * device that may be shared across shifts.
 *
 *  1. getCachedSession() previously fell back to "whichever row has the
 *     most recent cachedAt" whenever no userId was resolved. Concretely:
 *     cashier A logs in at 9am (cached), logs out at 2pm; cashier B logs
 *     in at 2:05pm on the SAME device (cached, now the most recent row);
 *     if B's tab then goes offline and reloads before the app otherwise
 *     knows B's userId, this fallback would still work by coincidence
 *     (B's row is newest) — but the moment ordering isn't guaranteed
 *     (e.g. a background re-auth write, a second concurrent tab), it
 *     returns whichever user was cached last, with no verification that
 *     row belongs to whoever is actually at the device right now. userId
 *     is now a required parameter with NO fallback guess: a caller that
 *     doesn't know who the current user is gets `null`, honestly,
 *     instead of a plausible-looking wrong identity.
 *  2. setCachedSession() previously also wrote the resolved userId to
 *     localStorage (a now-removed LAST_USER_ID_STORAGE_KEY) so a future
 *     caller with no explicit userId could look it up. localStorage is
 *     shared across every tab on the same browser origin — NOT scoped to
 *     one tab. A second tab logging in as a different user on the same
 *     shared device would silently overwrite that value, and a first tab
 *     (still legitimately logged in as its original user) reloading
 *     offline afterward would load the SECOND tab's identity through
 *     this exact mechanism — a real cross-user identity leak on a shared
 *     device, not just a display glitch. Removed entirely. The caller
 *     (useSessionWithOfflineFallback(), via useActiveSessionStore, an
 *     in-memory-only, genuinely tab-scoped Zustand store) is now
 *     responsible for remembering which userId THIS tab last resolved a
 *     live session for.
 */

import {
  getOfflineDb,
  isOfflineDbSupported,
  createCachedSessionRecord,
  type CachedSession,
} from "./db";

/**
 * Retrieves the cached session claims for a SPECIFIC user from Dexie.
 * Returns null if unsupported, if userId is empty/missing, or if no row
 * exists for that exact userId — this function never guesses at "the
 * current user" from whatever else happens to be cached on the device.
 */
export async function getCachedSession(userId: string): Promise<CachedSession | null> {
  if (!isOfflineDbSupported() || !userId || !userId.trim()) {
    return null;
  }

  try {
    const db = getOfflineDb();
    const row = await db.cachedSession.get(userId.trim());
    return row ?? null;
  } catch (error) {
    console.error("Failed to read cached session from Dexie:", error);
    return null;
  }
}

/**
 * Writes the resolved online session claims into Dexie's cachedSession
 * table, keyed by userId. `isPlatformAdmin` is strictly required as a
 * boolean (enforced by createCachedSessionRecord in db.ts).
 */
export async function setCachedSession(data: {
  userId: string;
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  role: "ADMIN" | "CASHIER";
  isPlatformAdmin: boolean;
  name?: string;
  cachedAt?: Date;
  subscriptionStatus: "ACTIVE" | "EXPIRED" | "PENDING";
}): Promise<void> {
  if (!isOfflineDbSupported()) return;

  const record = createCachedSessionRecord(data);

  try {
    const db = getOfflineDb();
    await db.cachedSession.put(record);
  } catch (error) {
    console.error("Failed to write session claims to Dexie cache:", error);
  }
}

/**
 * Clears cached session claims for a specific user — the ordinary logout
 * path. `userId` is required and non-optional here on purpose: a logout
 * action must only ever remove the claims for the user actually logging
 * out, never every cached user on a shared device. Use
 * clearAllCachedSessions() below for the genuinely different "wipe this
 * whole device" case.
 */
export async function clearCachedSession(userId: string): Promise<void> {
  if (!isOfflineDbSupported() || !userId || !userId.trim()) return;

  try {
    const db = getOfflineDb();
    await db.cachedSession.delete(userId.trim());
  } catch (error) {
    console.error("Failed to clear cached session from Dexie:", error);
  }
}

/**
 * Clears EVERY cached user's session claims on this device. This is NOT
 * a normal logout path — reserved for a full local-data-wipe action
 * (e.g. a "forget this device" admin action, or test teardown), the same
 * category as exchange-rate.ts's own no-tenantId
 * clearCachedExchangeRate() branch. Ordinary logout must call
 * clearCachedSession(userId) instead.
 */
export async function clearAllCachedSessions(): Promise<void> {
  if (!isOfflineDbSupported()) return;

  try {
    const db = getOfflineDb();
    await db.cachedSession.clear();
  } catch (error) {
    console.error("Failed to clear all cached sessions from Dexie:", error);
  }
}