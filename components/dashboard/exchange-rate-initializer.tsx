"use client";

import { useEffect } from "react";
import { useSession } from "next-auth/react";
import { useExchangeRateStore } from "@/lib/store/useExchangeRateStore";

export function ExchangeRateInitializer() {
    const { data: session } = useSession();
    const setExchangeRate = useExchangeRateStore((state) => state.setExchangeRate);
    const hydrateFromCache = useExchangeRateStore((state) => state.hydrateFromCache);

    useEffect(() => {
        const tenantId = session?.user?.tenantId;
        if (session?.user?.dailyExchangeRate !== undefined && session?.user?.dailyExchangeRate !== null) {
            setExchangeRate(session.user.dailyExchangeRate, tenantId);
        } else {
            // If session exchange rate is not available (e.g. offline boot), hydrate from local Dexie cache
            void hydrateFromCache(tenantId);
        }
    }, [session?.user?.dailyExchangeRate, session?.user?.tenantId, setExchangeRate, hydrateFromCache]);

    return null;
}
