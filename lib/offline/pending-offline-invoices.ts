import { useLiveQuery } from "dexie-react-hooks";
import { isOfflineDbSupported } from "./db";
import {
    listPendingOfflineInvoices,
    type PendingOfflineInvoicesResult,
} from "./pos-service";

/**
 * lib/offline/pending-offline-invoices.ts
 *
 * T4d v4.1 §6.2 — the reactive data source behind T4b's offline void panel
 * (components/pos/offline-void-panel.tsx). Built on the EXACT same
 * useLiveQuery pattern as lib/offline/sync-worker.ts's useSyncWorker()
 * pendingCount: any write to offlineInvoices/offlineCustomers/
 * cachedCustomers — from anywhere in the app (a new sale, a void, a
 * completed sync marking a row SYNCED) — re-runs this query automatically.
 * No manual refresh call exists anywhere in this file, on purpose — there
 * is nothing to manually refresh; the live query IS the source of truth,
 * matching useSyncWorker's own comment on why it removed its old
 * refreshPendingCount plumbing.
 *
 * Deliberately its OWN small hook rather than folded into useSyncWorker —
 * this is POS/void-panel-facing display data (which rows to render,
 * whether to show the panel at all), not sync-orchestration state (is a
 * sync in flight right now, when did it last run). A screen that only
 * needs the offline void panel does not need to also pull in
 * useSyncWorker's isSyncing/triggerSync surface, and vice versa.
 */

const EMPTY_RESULT: PendingOfflineInvoicesResult = { rows: [], originals: [], localVoids: [] };

export function usePendingOfflineInvoices(tenantId?: string): PendingOfflineInvoicesResult {
    return (
        useLiveQuery(
            async () => {
                if (!tenantId || !isOfflineDbSupported()) return EMPTY_RESULT;
                return listPendingOfflineInvoices(tenantId);
            },
            [tenantId],
            EMPTY_RESULT
        ) ?? EMPTY_RESULT
    );
}