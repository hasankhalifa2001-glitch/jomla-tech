"use client";

import { useEffect, useState } from "react";
import { getOfflineDb, isOfflineDbSupported } from "./db";
import { getCachedDailyExchangeRate } from "./exchange-rate";

/**
 * Dexie initialization hook.
 * Exposes whether client-side local storage is open and ready to accept reads/writes,
 * ensuring downstream UI (e.g. POS T4b) never reads or writes to an uninitialized database.
 */
export function useOfflineDbReady(): boolean {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!isOfflineDbSupported()) {
      return;
    }

    let isMounted = true;
    const db = getOfflineDb();

    db.open()
      .then(() => {
        if (isMounted) {
          setReady(true);
        }
      })
      .catch((error) => {
        console.error("Dexie failed to open database:", error);
      });

    return () => {
      isMounted = false;
    };
  }, []);

  return ready;
}

/**
 * Hook to read the cached daily exchange rate from Dexie.
 * Enables dual-currency math (consumed by POS T4b) even when completely disconnected.
 */
export function useCachedExchangeRate(tenantId?: string) {
  const [cachedRate, setCachedRate] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const isDbReady = useOfflineDbReady();

  useEffect(() => {
    if (!isDbReady) {
      return;
    }

    let isMounted = true;
    getCachedDailyExchangeRate(tenantId)
      .then((rate) => {
        if (isMounted) {
          setCachedRate(rate);
          setIsLoading(false);
        }
      })
      .catch(() => {
        if (isMounted) {
          setIsLoading(false);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [isDbReady, tenantId]);

  return { cachedRate, isLoading };
}
