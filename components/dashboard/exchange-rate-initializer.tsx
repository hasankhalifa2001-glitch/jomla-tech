"use client";

import { useEffect } from "react";
import { useSession } from "next-auth/react";
import { useExchangeRateStore } from "@/lib/store/useExchangeRateStore";

export function ExchangeRateInitializer() {
    const { data: session } = useSession();
    const setExchangeRate = useExchangeRateStore((state) => state.setExchangeRate);

    useEffect(() => {
        if (session?.user?.dailyExchangeRate !== undefined) {
            setExchangeRate(session.user.dailyExchangeRate);
        }
    }, [session?.user?.dailyExchangeRate, setExchangeRate]);

    return null;
}
