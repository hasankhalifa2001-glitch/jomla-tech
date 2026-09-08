"use client";

import { useEffect } from "react";
import { useSession } from "next-auth/react";
import { useExchangeRateStore } from "@/lib/store/useExchangeRateStore";

export function ExchangeRateInitializer() {
    const { data: session } = useSession();
    const setExchangeRate = useExchangeRateStore((state) => state.setExchangeRate);
    const hydrateFromCache = useExchangeRateStore((state) => state.hydrateFromCache);
    const setCurrentTenantId = useExchangeRateStore((state) => state.setCurrentTenantId);

    useEffect(() => {
        const tenantId = session?.user?.tenantId;

        // FIX: register this tab's active tenant BEFORE any broadcast could
        // arrive. Without this, the store's currentTenantId guard (added to
        // reject cross-tenant BroadcastChannel messages) stays null forever,
        // which causes it to reject every incoming broadcast — including
        // legitimate same-tenant ones — silently breaking multi-tab sync
        // entirely rather than just closing the cross-tenant leak.
        setCurrentTenantId(tenantId ?? null);

        if (session?.user?.dailyExchangeRate !== undefined && session?.user?.dailyExchangeRate !== null) {
            setExchangeRate(session.user.dailyExchangeRate, tenantId);
        } else {
            // If session exchange rate is not available (e.g. offline boot), hydrate from local Dexie cache
            void hydrateFromCache(tenantId);
        }
    }, [
        session?.user?.tenantId,
        session?.user?.dailyExchangeRate,
        setExchangeRate,
        hydrateFromCache,
        setCurrentTenantId,
    ]);

    return null;
}