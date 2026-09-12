"use client";

import { useEffect } from "react";
import { useSession } from "next-auth/react";
import { useExchangeRateStore } from "@/lib/store/useExchangeRateStore";

/**
 * Mounted once near the root of the authenticated app shell. Its only job
 * is to get `dailyExchangeRate` into the Zustand store as early and as
 * correctly as possible — for every screen, not just the ones that render
 * <ExchangeRateTopbar />, since T2a requires this field to be sourced fresh
 * from the database (or a short-TTL cache), never from the JWT.
 *
 * Ordering, cheapest/least-trustworthy first, most-trustworthy last:
 *   1. Dexie cache (hydrateFromCache) — instant, works fully offline, but
 *      can be stale by however long it's been since the last online
 *      session. hydrateFromCache only writes when the store is still
 *      null, so it never clobbers a value step 2 already applied.
 *   2. A live GET /api/tenant/exchange-rate — the actual source of
 *      truth, read fresh from the database on every mount. Applied
 *      unconditionally once it resolves — same pattern as
 *      ExchangeRateTopbar's own fetch — because this is what makes the
 *      value authoritative, not an "only if still null" check.
 *
 * session.user.dailyExchangeRate (the JWT) is deliberately never read
 * here. Per T2a, it can go stale mid-session on any device the moment a
 * DIFFERENT admin/tab/device updates the rate, and this tab's JWT has no
 * way to know that happened until its own token is explicitly refreshed —
 * which only ever occurs on the editing admin's own tab after their own
 * save. Seeding the store from it, even as a "same-tick fallback", risks
 * a real sale being priced against a stale rate before step 2 resolves.
 */
export function ExchangeRateInitializer() {
    const { data: session } = useSession();
    const setExchangeRate = useExchangeRateStore((state) => state.setExchangeRate);
    const hydrateFromCache = useExchangeRateStore((state) => state.hydrateFromCache);
    const setCurrentTenantId = useExchangeRateStore((state) => state.setCurrentTenantId);

    useEffect(() => {
        const tenantId = session?.user?.tenantId;

        // Register this tab's active tenant BEFORE any broadcast could
        // arrive — see useExchangeRateStore's currentTenantId guard
        // against cross-tenant BroadcastChannel messages.
        setCurrentTenantId(tenantId ?? null);

        if (!tenantId) return;

        let cancelled = false;

        // Step 1 — instant, offline-safe: whatever was last cached in
        // Dexie for this tenant.
        void hydrateFromCache(tenantId);

        // Step 2 — the actual source of truth: fresh from the database,
        // unconditionally applied once it resolves. Silently no-ops if
        // offline (fetch throws) or the component unmounts first.
        (async () => {
            try {
                const res = await fetch("/api/tenant/exchange-rate", {
                    method: "GET",
                    cache: "no-store",
                });
                if (!res.ok || cancelled) return;
                const data = await res.json();
                if (cancelled) return;
                if (data?.success && data.dailyExchangeRate !== undefined) {
                    setExchangeRate(data.dailyExchangeRate, tenantId);
                }
            } catch (err) {
                // Offline/network failure: step 1's cached value (if any)
                // stays as-is. Not surfaced to the user — this is a
                // background bootstrap call, not a user-initiated action.
                console.error("Failed to fetch fresh daily exchange rate on init:", err);
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [session?.user?.tenantId, setExchangeRate, hydrateFromCache, setCurrentTenantId]);

    return null;
}