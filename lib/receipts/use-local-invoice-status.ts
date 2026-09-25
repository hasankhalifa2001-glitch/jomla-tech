"use client";

/**
 * lib/receipts/use-local-invoice-status.ts
 *
 * T4f addendum — Rule 1's live-reactivity requirement, stated as an
 * acceptance criterion: the "Share receipt" control must become enabled
 * "the instant that invoice's status transitions to SYNCED", with NO page
 * reload or manual refresh.
 *
 * This is the same `useLiveQuery` mechanism T4d v4.1 already relies on for
 * its offline void panel (lib/offline/pending-offline-invoices.ts, and the
 * original in lib/offline/hooks.ts): lib/offline/sync-worker.ts marks an
 * invoice SYNCED with a plain Dexie write
 * (`db.offlineInvoices.update(id, { status: "SYNCED" })`), and every live
 * query observing `offlineInvoices` re-runs automatically when that write
 * commits — from any code path, any component, any tab's own sync pass. No
 * polling, no interval, no refetch callback, and therefore nothing that can
 * get out of sync with the database.
 *
 * [WHAT IS DELIBERATELY NOT HERE] This hook answers "what is this invoice's
 * sync state?" and nothing else. It does not fetch, resolve, or cache a
 * server invoice id: the gate is the sync state (Rule 1), so the hook that
 * feeds the gate must be able to answer with zero network activity — which
 * is what makes "share is disabled, not hidden, and flips without a reload"
 * testable without mocking fetch at all.
 */

import { useLiveQuery } from "dexie-react-hooks";
import {
  getOfflineDb,
  isOfflineDbSupported,
  type OfflineSyncStatus,
} from "@/lib/offline/db";

export interface LocalInvoiceSyncState {
  /** null when the row does not exist on this device (e.g. a server-only invoice). */
  status: OfflineSyncStatus | null;
  isSynced: boolean;
  /** false until the live query's first read resolves. */
  isReady: boolean;
}

const NOT_READY: LocalInvoiceSyncState = {
  status: null,
  isSynced: false,
  isReady: false,
};

export function useLocalInvoiceSyncStatus(
  offlineId?: string | null
): LocalInvoiceSyncState {
  const resolved = useLiveQuery(
    async () => {
      if (!offlineId || !isOfflineDbSupported()) return null;
      const row = await getOfflineDb()
        .offlineInvoices.where("offlineId")
        .equals(offlineId)
        .first();
      return row?.status ?? null;
    },
    [offlineId]
  );

  if (resolved === undefined) return NOT_READY;

  return {
    status: resolved,
    isSynced: resolved === "SYNCED",
    isReady: true,
  };
}
