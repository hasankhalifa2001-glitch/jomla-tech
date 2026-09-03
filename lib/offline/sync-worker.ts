/**
 * Client-Side Sync Worker (T4c)
 *
 * Responsibilities:
 * 1. Pushes pending offline data (offlineCustomers, offlineInvoices, offlinePayments)
 *    to /api/sync sorted by local `createdAt` ascending.
 * 2. Processes per-item responses from the server, updating local record status
 *    to "SYNCED" or "FAILED" with explicit failure reasons.
 * 3. Enforces that FAILED items are NEVER automatically retried (they remain in
 *    the FAILED state until manual reconciliation / T4e ledger resolution).
 * 4. Listens for network reconnection (`online` event) and triggers sync within 5 seconds.
 */

import { getOfflineDb, isOfflineDbSupported } from "./db";
import { useEffect, useState, useCallback, useRef } from "react";

export interface SyncSummary {
  success: boolean;
  syncedCustomers: number;
  syncedInvoices: number;
  syncedPayments: number;
  failedCustomers: number;
  failedInvoices: number;
  failedPayments: number;
  errors: string[];
}

export interface SyncItemResult {
  offlineId: string;
  status: "SYNCED" | "FAILED";
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
    errors: [],
  };

  if (!isOfflineDbSupported()) {
    return summary;
  }

  const db = getOfflineDb();

  // Fetch only records whose status is PENDING (never FAILED or SYNCED)
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

  // If there is nothing pending, return immediately
  if (
    pendingCustomers.length === 0 &&
    pendingInvoices.length === 0 &&
    pendingPayments.length === 0
  ) {
    return summary;
  }

  // Sort per device by local createdAt ASC
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
        unitPriceUSD: it.unitPriceUSD,
      })),
      totalUSD: inv.totalUSD,
      totalSYP: inv.totalSYP,
      exchangeRateUsed: inv.exchangeRateUsed,
      paidAmountUSD: inv.paidAmountUSD,
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
      amountUSD: p.amountUSD,
      amountSYP: p.amountSYP,
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

          // Also insert into cachedCustomers if realId is provided
          if (res.realId) {
            await db.cachedCustomers.put({
              id: res.realId,
              tenantId: scopedTenantId,
              name: localCustomer.name,
              phone: localCustomer.phone,
              shopName: localCustomer.shopName,
              cachedBalanceDebtUSD: "0.0000",
              isSystemGenerated: false,
            });
          }
        } else {
          summary.failedCustomers++;
          summary.errors.push(res.error || `Customer ${res.offlineId} failed`);
          // Mark as FAILED — never retried automatically
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
        } else {
          summary.failedInvoices++;
          summary.errors.push(res.error || `Invoice ${res.offlineId} failed`);
          // Mark as FAILED — never retried automatically
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
        } else {
          summary.failedPayments++;
          summary.errors.push(res.error || `Payment ${res.offlineId} failed`);
          // Mark as FAILED — never retried automatically
          await db.offlinePayments.update(localPayment.id, {
            status: "FAILED",
            failureReason: res.error || "فشل المزامنة",
          });
        }
      }
    }

    summary.success =
      summary.failedCustomers === 0 &&
      summary.failedInvoices === 0 &&
      summary.failedPayments === 0;

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
 * Automatically initiates sync within 5 seconds of network reconnection.
 */
export function useSyncWorker(tenantId?: string) {
  const [isSyncing, setIsSyncing] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [lastSyncTime, setLastSyncTime] = useState<Date | null>(null);
  const [lastSummary, setLastSummary] = useState<SyncSummary | null>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isSyncingRef = useRef(false);

  const refreshPendingCount = useCallback(async () => {
    if (!tenantId) return;
    try {
      const count = await getPendingRecordsCount(tenantId);
      setPendingCount(count);
    } catch {
      // Ignore Dexie errors during unmount/initialization
    }
  }, [tenantId]);

  const triggerSync = useCallback(async () => {
    if (!tenantId || isSyncingRef.current) return;
    isSyncingRef.current = true;
    setIsSyncing(true);
    try {
      const summary = await syncPendingRecords(tenantId);
      setLastSummary(summary);
      setLastSyncTime(new Date());
      await refreshPendingCount();
    } catch (err) {
      console.error("Background sync error:", err);
    } finally {
      isSyncingRef.current = false;
      setIsSyncing(false);
    }
  }, [tenantId, refreshPendingCount]);

  useEffect(() => {
    if (!tenantId) return;

    let isMounted = true;
    getPendingRecordsCount(tenantId)
      .then((count) => {
        if (isMounted) {
          setPendingCount(count);
        }
      })
      .catch(() => {});

    const scheduleSync = () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
      // Within 5 seconds of reconnection (and of dashboard mount while online)
      debounceTimerRef.current = setTimeout(() => {
        void triggerSync();
      }, 2000);
    };

    if (typeof window !== "undefined") {
      window.addEventListener("online", scheduleSync);
      if (navigator.onLine) {
        scheduleSync();
      }
    }

    return () => {
      isMounted = false;
      if (typeof window !== "undefined") {
        window.removeEventListener("online", scheduleSync);
      }
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, [tenantId, triggerSync]);

  return {
    isSyncing,
    pendingCount,
    lastSyncTime,
    lastSummary,
    triggerSync,
    refreshPendingCount,
  };
}
