"use client";

import { useEffect, useState } from "react";
import { getOfflineDb, isOfflineDbSupported } from "@/lib/offline/db";

export function useOfflineDbReady() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!isOfflineDbSupported()) {
      return;
    }

    const db = getOfflineDb();
    void db.open().then(() => setReady(true));
  }, []);

  return ready;
}
