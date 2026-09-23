/**
 * Client-Side Sync Worker (T4c)
 *
 * Responsibilities:
 * 1. Pushes pending offline data (offlineCustomers, offlineInvoices, offlinePayments)
 *    to /api/sync sorted by local `createdAt` ascending.
 * 2. Processes per-item responses from the server, updating local record status
 *    to "SYNCED" or "FAILED" with explicit failure reasons. A third server
 *    status, "RETRY_LATER", leaves the local record untouched (still PENDING)
 *    rather than writing any status at all — this covers both a raw transient
 *    DB conflict on the item's own transaction AND a customer dependency
 *    still mid-retry (see app/api/sync/route.ts's TransientDependencyError).
 * 3. Enforces that FAILED items are NEVER automatically retried (they remain in
 *    the FAILED state until manual reconciliation / T4e ledger resolution).
 *    RETRY_LATER items ARE automatically retried — see triggers 1-3 below.
 * 4. Listens for network reconnection (`online` event) and triggers sync within 5 seconds.
 * 5. Runs a periodic 45s safety-net check while online with pending work — see
 *    the [FIX — PERIODIC INTERVAL STABILITY] note below for why this needed a
 *    second look in this revision.
 *
 * [... prior header documentation on SYP/USD payload shape, post-sync
 * cache-refresh logic, and the original RETRY_LATER handling (false-success
 * bug + orphaned-retry bug) — unchanged and still in effect, see earlier
 * revisions of this file for the full text ...]
 *
 * [FIX — PERIODIC INTERVAL STABILITY, this revision — closes a real
 * "safety net that resets itself before it ever fires" bug]
 *
 * The periodic 45s safety-net `useEffect` previously listed `pendingCount`
 * in its dependency array:
 *
 *   useEffect(() => {
 *     periodicIntervalRef.current = setInterval(() => { ... }, 45_000);
 *     return () => clearInterval(periodicIntervalRef.current);
 *   }, [tenantId, pendingCount, triggerSync]);
 *
 * `pendingCount` is a live, reactive value (useLiveQuery) that changes on
 * EVERY write to offlineInvoices/offlinePayments/offlineCustomers — a new
 * sale, a new walk-in customer, a new offline void, and every status
 * transition a sync pass itself writes. Each such change re-runs this
 * effect: React tears down the existing interval (clearInterval in the
 * cleanup function) and starts a brand-new 45s countdown from zero.
 *
 * On a device with steady activity (a cashier ringing up sale after sale
 * more often than once every 45 seconds), the interval could be reset
 * indefinitely and NEVER actually fire — defeating the entire purpose of
 * the safety net, which exists specifically to catch a RETRY_LATER item
 * that triggers 1 and 2 (the 0->positive pendingCount transition and the
 * browser `online` event) cannot reach.
 *
 * Fixed: `pendingCount` is read from a ref (`pendingCountRef`, kept in
 * sync by a separate, cheap effect) INSIDE the interval callback instead
 * of being a dependency of the effect that creates the interval. The
 * interval-creating effect now depends only on `[tenantId, triggerSync]`
 * — both stable across ordinary pending-count churn — so the interval is
 * created once per mount (and once per tenant/triggerSync identity
 * change) and ticks reliably every 45s regardless of how often
 * `pendingCount` itself changes in between ticks.
 */

import { getOfflineDb, isOfflineDbSupported } from "./db";
import { refreshProductCache, refreshCustomerCache } from "./cache-refresh";
import { useEffect, useState, useCallback, useRef } from "react";
import { useLiveQuery } from "dexie-react-hooks";

export interface SyncSummary {
  success: boolean;
  syncedCustomers: number;
  syncedInvoices: number;
  syncedPayments: number;
  failedCustomers: number;
  failedInvoices: number;
  failedPayments: number;
  // Counts of items the server explicitly deferred (transient DB
  // conflict on the item itself, or a dependency — e.g. its customer —
  // still mid-retry) — distinct from genuine terminal failures. These
  // items' local Dexie records are left untouched (still PENDING) and
  // will be retried automatically.
  retryLaterCustomers: number;
  retryLaterInvoices: number;
  retryLaterPayments: number;
  // True whenever this pass ended with at least one RETRY_LATER item —
  // lets a UI show a calm "still syncing" state instead of conflating
  // this with a genuine, manual-intervention-needed failure.
  hasPendingRetries: boolean;
  errors: string[];
}

export interface SyncItemResult {
  offlineId: string;
  status: "SYNCED" | "FAILED" | "RETRY_LATER";
  realId?: string;
  error?: string;
}

export interface SyncApiResponse {
  success: boolean;
  customers: SyncItemResult[];
  invoices: SyncItemResult[];
  payments: SyncItemResult[];
  error?: string;
  message?: string;
}

/**
 * Executes a sync pass for all PENDING offline records belonging to the given tenant.
 */
export async function syncPendingRecords(tenantId: string): Promise<SyncSummary> {
  if (!tenantId || !tenantId.trim()) {
    throw new Error("tenantId is required to sync pending records.");
  }

  const scopedTenantId = tenantId.trim();
  const summary: SyncSummary = {
    success: true,
    syncedCustomers: 0,
    syncedInvoices: 0,
    syncedPayments: 0,
    failedCustomers: 0,
    failedInvoices: 0,
    failedPayments: 0,
    retryLaterCustomers: 0,
    retryLaterInvoices: 0,
    retryLaterPayments: 0,
    hasPendingRetries: false,
    errors: [],
  };

  if (!isOfflineDbSupported()) {
    return summary;
  }

  const db = getOfflineDb();

  const [pendingCustomers, pendingInvoices, pendingPayments] = await Promise.all([
    db.offlineCustomers
      .where("tenantId")
      .equals(scopedTenantId)
      .filter((c) => c.status === "PENDING")
      .toArray(),
    db.offlineInvoices
      .where("tenantId")
      .equals(scopedTenantId)
      .filter((i) => i.status === "PENDING")
      .toArray(),
    db.offlinePayments
      .where("tenantId")
      .equals(scopedTenantId)
      .filter((p) => p.status === "PENDING")
      .toArray(),
  ]);

  if (
    pendingCustomers.length === 0 &&
    pendingInvoices.length === 0 &&
    pendingPayments.length === 0
  ) {
    return summary;
  }

  pendingCustomers.sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );
  pendingInvoices.sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );
  pendingPayments.sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );

  const payload = {
    customers: pendingCustomers.map((c) => ({
      offlineId: c.offlineId,
      name: c.name,
      phone: c.phone,
      shopName: c.shopName,
      createdAt: c.createdAt,
    })),
    invoices: pendingInvoices.map((inv) => ({
      offlineId: inv.offlineId,
      customerId: inv.customerId,
      offlineCustomerId: inv.offlineCustomerId,
      items: inv.items.map((it) => ({
        productId: it.productId,
        unitId: it.unitId,
        quantity: it.quantity,
        unitPriceSYP: it.unitPriceSYP,
        unitPriceUSD: it.unitPriceUSD,
      })),
      totalSYP: inv.totalSYP,
      totalUSD: inv.totalUSD,
      exchangeRateUsed: inv.exchangeRateUsed,
      paidAmountSYP: inv.paidAmountSYP,
      paidAmountUSD: inv.paidAmountUSD,
      debtAmountSYP: inv.debtAmountSYP,
      debtAmountUSD: inv.debtAmountUSD,
      paymentMethod: inv.paymentMethod,
      voidsOfflineInvoiceId: inv.voidsOfflineInvoiceId,
      voidReason: inv.voidReason,
      createdAt: inv.createdAt,
    })),
    payments: pendingPayments.map((p) => ({
      offlineId: p.offlineId,
      customerId: p.customerId,
      offlineCustomerId: p.offlineCustomerId,
      invoiceId: p.invoiceId,
      offlineInvoiceId: p.offlineInvoiceId,
      amountSYP: p.amountSYP,
      amountUSD: p.amountUSD,
      exchangeRate: p.exchangeRate,
      paymentMethod: p.paymentMethod,
      receiptNo: p.receiptNo,
      notes: p.notes,
      createdAt: p.createdAt,
    })),
  };

  try {
    const response = await fetch("/api/sync", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errJson = await response.json().catch(() => ({}));
      const errorMsg =
        errJson.message || `Sync request failed with HTTP ${response.status}`;
      summary.success = false;
      summary.errors.push(errorMsg);
      return summary;
    }

    const data: SyncApiResponse = await response.json();

    // 1. Process Customers
    for (const res of data.customers || []) {
      const localCustomer = pendingCustomers.find((c) => c.offlineId === res.offlineId);
      if (localCustomer && localCustomer.id !== undefined) {
        if (res.status === "SYNCED") {
          summary.syncedCustomers++;
          await db.offlineCustomers.update(localCustomer.id, {
            status: "SYNCED",
            failureReason: undefined,
          });

          if (res.realId) {
            await db.cachedCustomers.put({
              id: res.realId,
              tenantId: scopedTenantId,
              name: localCustomer.name,
              phone: localCustomer.phone,
              shopName: localCustomer.shopName,
              cachedBalanceDebtSYP: "0.0000",
              cachedBalanceDebtUSD: "0.0000",
              isSystemGenerated: false,
              hasPriorInvoices: false,
            });
          }
        } else if (res.status === "RETRY_LATER") {
          // Deliberately no Dexie write at all — the local record stays
          // exactly as it was (status: "PENDING"), so it's naturally
          // re-included in the next sync pass's own PENDING query above,
          // with zero extra bookkeeping needed here.
          summary.retryLaterCustomers++;
          summary.hasPendingRetries = true;
        } else {
          summary.failedCustomers++;
          summary.errors.push(res.error || `Customer ${res.offlineId} failed`);
          await db.offlineCustomers.update(localCustomer.id, {
            status: "FAILED",
            failureReason: res.error || "فشل المزامنة",
          });
        }
      }
    }

    // 2. Process Invoices
    for (const res of data.invoices || []) {
      const localInvoice = pendingInvoices.find((i) => i.offlineId === res.offlineId);
      if (localInvoice && localInvoice.id !== undefined) {
        if (res.status === "SYNCED") {
          summary.syncedInvoices++;
          await db.offlineInvoices.update(localInvoice.id, {
            status: "SYNCED",
            failureReason: undefined,
          });
        } else if (res.status === "RETRY_LATER") {
          // Same as above — no Dexie write, stays PENDING. Covers both a
          // raw transient DB conflict AND a customer dependency still
          // mid-retry (server-side TransientDependencyError) — this file
          // does not need to distinguish the two cases, only the server
          // does, via res.error's wording.
          summary.retryLaterInvoices++;
          summary.hasPendingRetries = true;
        } else {
          summary.failedInvoices++;
          summary.errors.push(res.error || `Invoice ${res.offlineId} failed`);
          await db.offlineInvoices.update(localInvoice.id, {
            status: "FAILED",
            failureReason: res.error || "فشل المزامنة",
          });
        }
      }
    }

    // 3. Process Payments
    for (const res of data.payments || []) {
      const localPayment = pendingPayments.find((p) => p.offlineId === res.offlineId);
      if (localPayment && localPayment.id !== undefined) {
        if (res.status === "SYNCED") {
          summary.syncedPayments++;
          await db.offlinePayments.update(localPayment.id, {
            status: "SYNCED",
            failureReason: undefined,
          });
        } else if (res.status === "RETRY_LATER") {
          // Same as above — no Dexie write, stays PENDING.
          summary.retryLaterPayments++;
          summary.hasPendingRetries = true;
        } else {
          summary.failedPayments++;
          summary.errors.push(res.error || `Payment ${res.offlineId} failed`);
          await db.offlinePayments.update(localPayment.id, {
            status: "FAILED",
            failureReason: res.error || "فشل المزامنة",
          });
        }
      }
    }

    // success is also false whenever anything is still RETRY_LATER —
    // this pass did not fully complete, even though nothing failed
    // terminally. hasPendingRetries (set above) lets a UI distinguish
    // this calmly from a genuine failure requiring intervention.
    summary.success =
      summary.failedCustomers === 0 &&
      summary.failedInvoices === 0 &&
      summary.failedPayments === 0 &&
      summary.retryLaterCustomers === 0 &&
      summary.retryLaterInvoices === 0 &&
      summary.retryLaterPayments === 0;

    // Post-sync cache refresh — only triggered by genuinely SYNCED
    // invoices/payments (RETRY_LATER items changed nothing server-side
    // yet, so there's nothing new to refresh for them).
    if (summary.syncedInvoices > 0) {
      try {
        const productResult = await refreshProductCache(scopedTenantId);
        if (!productResult.ok && productResult.reason !== "offline") {
          console.error(
            "syncPendingRecords: post-sync refreshProductCache failed:",
            productResult.reason
          );
        }
      } catch (err) {
        console.error("syncPendingRecords: post-sync refreshProductCache threw:", err);
      }
    }

    if (summary.syncedInvoices > 0 || summary.syncedPayments > 0) {
      try {
        const customerResult = await refreshCustomerCache(scopedTenantId);
        if (!customerResult.ok && customerResult.reason !== "offline") {
          console.error(
            "syncPendingRecords: post-sync refreshCustomerCache failed:",
            customerResult.reason
          );
        }
      } catch (err) {
        console.error("syncPendingRecords: post-sync refreshCustomerCache threw:", err);
      }
    }

    return summary;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Network error during sync.";
    summary.success = false;
    summary.errors.push(message);
    return summary;
  }
}

/**
 * Counts all pending records awaiting sync for the active tenant.
 */
export async function getPendingRecordsCount(tenantId?: string): Promise<number> {
  if (!tenantId || !tenantId.trim() || !isOfflineDbSupported()) return 0;
  const scopedTenantId = tenantId.trim();
  const db = getOfflineDb();

  const [cCount, iCount, pCount] = await Promise.all([
    db.offlineCustomers
      .where("tenantId")
      .equals(scopedTenantId)
      .filter((c) => c.status === "PENDING")
      .count(),
    db.offlineInvoices
      .where("tenantId")
      .equals(scopedTenantId)
      .filter((i) => i.status === "PENDING")
      .count(),
    db.offlinePayments
      .where("tenantId")
      .equals(scopedTenantId)
      .filter((p) => p.status === "PENDING")
      .count(),
  ]);

  return cCount + iCount + pCount;
}

/**
 * React Hook for managing background sync worker lifecycle.
 *
 * Automatic sync fires on THREE independent triggers:
 *   1. pendingCount transitioning from 0 to positive (a genuinely NEW
 *      pending item appearing — e.g. right after submitOfflineSale()).
 *   2. A real browser `online` reconnect event.
 *   3. A periodic 45s safety-net check — see file-header
 *      [FIX — PERIODIC INTERVAL STABILITY] note for why this now reads
 *      pendingCount from a ref instead of depending on it directly.
 */
export function useSyncWorker(tenantId?: string) {
  const [isSyncing, setIsSyncing] = useState(false);
  const [lastSyncTime, setLastSyncTime] = useState<Date | null>(null);
  const [lastSummary, setLastSummary] = useState<SyncSummary | null>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const periodicIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isSyncingRef = useRef(false);

  const triggerSync = useCallback(async () => {
    if (!tenantId || isSyncingRef.current) return;
    isSyncingRef.current = true;
    setIsSyncing(true);
    try {
      const summary = await syncPendingRecords(tenantId);
      setLastSummary(summary);
      setLastSyncTime(new Date());
    } catch (err) {
      console.error("Background sync error:", err);
    } finally {
      isSyncingRef.current = false;
      setIsSyncing(false);
    }
  }, [tenantId]);

  const pendingCount = useLiveQuery(
    async () => {
      if (!tenantId || !isOfflineDbSupported()) return 0;
      return getPendingRecordsCount(tenantId);
    },
    [tenantId],
    0
  ) ?? 0;

  // [FIX — PERIODIC INTERVAL STABILITY] Mirrors the live pendingCount into
  // a ref on every render, so the periodic-interval effect below can read
  // the CURRENT value inside its callback without needing pendingCount in
  // its own dependency array (which would tear down and recreate the
  // interval on every pendingCount change — see the file-header FIX note).
  const pendingCountRef = useRef(pendingCount);
  useEffect(() => {
    pendingCountRef.current = pendingCount;
  }, [pendingCount]);

  const scheduleSync = useCallback(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }
    debounceTimerRef.current = setTimeout(() => {
      void triggerSync();
    }, 2000);
  }, [triggerSync]);

  // Trigger 1 — 0 -> positive pendingCount transition (new local work).
  const prevPendingCountRef = useRef<number | null>(null);
  useEffect(() => {
    if (!tenantId) return;
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      prevPendingCountRef.current = pendingCount;
      return;
    }

    const prev = prevPendingCountRef.current;
    const isNewPendingWork = prev === null ? pendingCount > 0 : prev === 0 && pendingCount > 0;

    if (isNewPendingWork) {
      scheduleSync();
    }
    prevPendingCountRef.current = pendingCount;
  }, [tenantId, pendingCount, scheduleSync]);

  // Trigger 2 — real browser online reconnect event.
  useEffect(() => {
    if (!tenantId || typeof window === "undefined") return;

    const handleOnline = () => {
      if (pendingCountRef.current > 0) scheduleSync();
    };
    window.addEventListener("online", handleOnline);

    return () => {
      window.removeEventListener("online", handleOnline);
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
    // [FIX — PERIODIC INTERVAL STABILITY] pendingCount removed from this
    // effect's dependency array too, for the same reason as trigger 3
    // below — handleOnline reads the live value via pendingCountRef
    // instead, so the listener no longer needs to be torn down and
    // re-added on every pendingCount change.
  }, [tenantId, scheduleSync]);

  // Trigger 3 — periodic 45s safety net. Covers the case where a
  // RETRY_LATER item is stuck PENDING on a device that never actually
  // loses connectivity (so trigger 2 never fires) and where no new local
  // work is created afterward (so trigger 1 never fires either).
  //
  // [FIX — PERIODIC INTERVAL STABILITY] This effect now depends only on
  // [tenantId, triggerSync] — NOT on pendingCount — so the interval is
  // created once per mount/tenant and ticks reliably every 45s. The
  // callback reads the CURRENT pending count via pendingCountRef.current
  // at fire time, so it still behaves correctly (a no-op when nothing is
  // pending) without needing pendingCount as a dependency.
  useEffect(() => {
    if (!tenantId) return;

    periodicIntervalRef.current = setInterval(() => {
      if (
        pendingCountRef.current > 0 &&
        typeof navigator !== "undefined" &&
        navigator.onLine &&
        !isSyncingRef.current
      ) {
        void triggerSync();
      }
    }, 45_000);

    return () => {
      if (periodicIntervalRef.current) {
        clearInterval(periodicIntervalRef.current);
      }
    };
  }, [tenantId, triggerSync]);

  return {
    isSyncing,
    pendingCount,
    lastSyncTime,
    lastSummary,
    triggerSync,
    refreshPendingCount: useCallback(async () => { }, []),
  };
}