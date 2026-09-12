"use client";

import { useEffect } from "react";
import { useSession } from "next-auth/react";
import { refreshProductCache, refreshCustomerCache } from "@/lib/offline/cache-refresh";

/**
 * Mounted once near the root of the authenticated app shell, alongside
 * <ExchangeRateInitializer /> and <SyncWorkerInitializer />. Its only job
 * is T4a's "Cache population (sync-down)" requirement: pull this tenant's
 * current products/units/batches and customers/balances from the server
 * and overwrite the corresponding Dexie tables (cachedProducts,
 * cachedCustomers) — for every screen, not just the future offline POS
 * (T4b) that will actually read from them.
 *
 * Unlike ExchangeRateInitializer, there is no "step 1: hydrate from Dexie
 * first" here — Dexie's cachedProducts/cachedCustomers are the
 * WRITE TARGET this component refreshes, not a value it needs to read on
 * mount. Nothing in this component ever reads from Dexie or from the
 * Zustand store; the offline POS (T4b) is what will read cachedProducts/
 * cachedCustomers directly, whenever they were last written.
 *
 * Both refresh calls are fire-and-forget by design (never awaited before
 * rendering children, never surfaced to the user) — matching T4a's "must
 * not throw, must not block app load" requirement. Each of
 * refreshProductCache/refreshCustomerCache already resolves quietly with
 * { ok: false, reason: "offline" } when there's no connection, and logs
 * its own console.error on a real fetch/write failure — there is nothing
 * further for this component to do with either result today.
 *
 * session.user.tenantId (the JWT) is fine to read here, unlike
 * dailyExchangeRate on ExchangeRateInitializer — a stale/missing tenantId
 * on this token would only ever cause this refresh to no-op via
 * refreshProductCache's own "no_tenant" guard, never apply a wrong
 * tenant's data (each call is scoped server-side to the authenticated
 * session, never to a client-supplied tenantId param).
 */
export function OfflineCacheInitializer() {
    const { data: session } = useSession();

    useEffect(() => {
        const tenantId = session?.user?.tenantId;
        if (!tenantId) return;

        let cancelled = false;

        (async () => {
            // Run both in parallel — they touch independent Dexie tables
            // (cachedProducts vs cachedCustomers) and independent server
            // endpoints, so there is no ordering dependency between them.
            const [productResult, customerResult] = await Promise.all([
                refreshProductCache(tenantId),
                refreshCustomerCache(tenantId),
            ]);

            if (cancelled) return;

            // Real failures (not "offline", which is expected and silent) are
            // logged here for visibility during development/QA. Neither
            // function throws, so this is purely observational — the app shell
            // renders normally either way, per T4a's "never block app load."
            if (!productResult.ok && productResult.reason !== "offline") {
                console.error("OfflineCacheInitializer: product cache refresh failed:", productResult.reason);
            }
            if (!customerResult.ok && customerResult.reason !== "offline") {
                console.error("OfflineCacheInitializer: customer cache refresh failed:", customerResult.reason);
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [session?.user?.tenantId]);

    return null;
}