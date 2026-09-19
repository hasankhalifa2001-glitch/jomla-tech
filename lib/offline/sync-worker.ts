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
 *
 * [FIX — critical, payload was sending the wrong currency fields] This
 * file previously built its /api/sync payload around unitPriceUSD/
 * totalUSD/paidAmountUSD/debtAmountUSD only — a leftover from the
 * pre-v3.6 USD-authoritative currency model. db.ts and schema.prisma have
 * since re-anchored to SYP as the sole authoritative currency (see
 * db.ts's CURRENCY MODEL note and schema.prisma's v3.6 CURRENCY
 * RE-ANCHORING note): unitPriceSYP/totalSYP/paidAmountSYP/debtAmountSYP
 * are what every validation and business rule actually reads, and the
 * USD fields are informational-only and NULLABLE (a SYP-only cart that
 * never needed a rate has unitPriceUSD/totalUSD/etc. stored as `null` —
 * see db.ts's review-pass-6 note). The old payload never sent the SYP
 * fields at all, so:
 *   - A SYP-only sale (unitPriceUSD/totalUSD/etc. all null) sent a
 *     payload with NO usable price/total/debt figures whatsoever.
 *   - Even a USD-priced sale sent only the derived, informational USD
 *     figures — never the authoritative SYP figures the server is
 *     required to validate (debtAmountSYP ≈ totalSYP − paidAmountSYP)
 *     and persist as the source of truth.
 * Every authoritative SYP field is now included alongside its
 * informational USD counterpart, matching OfflineInvoice/
 * OfflineInvoiceItem's actual shape in db.ts exactly.
 *
 * [FIX — critical, this revision] syncPendingRecords() previously never
 * refreshed cachedProducts/cachedCustomers after a successful sync pass
 * at all — it only ever updated each offline record's own status field
 * (SYNCED/FAILED) in Dexie. This produced a real, UNBOUNDED display bug,
 * not a narrow timing edge case:
 *
 *   1. pos-service.ts's getOfflineProducts() correctly subtracts every
 *      NOT-YET-SYNCED offlineInvoices item from the last-synced batch
 *      total, so a stock count stays accurate WHILE a sale is pending.
 *   2. The instant this file marks that same invoice SYNCED, it drops
 *      out of that subtraction — correctly, since the server has now
 *      committed the real deduction via commitFifoAllocation (T4c/T3b).
 *   3. But nothing in THIS file ever called refreshProductCache() to
 *      pull that real, now-lower server-side quantity back down into
 *      cachedProducts.batches — so the displayed stock count would jump
 *      back UP to its pre-sale value and STAY there indefinitely, until
 *      some unrelated code path happened to trigger a refresh (e.g. the
 *      user manually pressing a "sync products" button, or an app-load
 *      refresh on a completely different screen). There was no bound on
 *      how long this could persist — potentially the rest of the
 *      cashier's shift.
 *
 * Fixed: syncPendingRecords() now calls refreshProductCache() whenever
 * at least one invoice was actually synced this pass (the only source of
 * stock-affecting writes), and refreshCustomerCache() whenever at least
 * one invoice OR payment was synced (both can change a customer's
 * server-side debt balance). Both are best-effort: a refresh failure
 * (e.g. the network drops again immediately after the sync itself
 * succeeded) is logged but does not flip the overall sync summary to
 * failed — the sync itself genuinely succeeded; only the subsequent
 * cache-refresh attempt didn't, and the next successful refresh (from
 * any trigger) will still catch up correctly, so this is not silently
 * losing data the way the original missing-refresh gap was.
 */

import { getOfflineDb, isOfflineDbSupported } from "./db";
import { refreshProductCache, refreshCustomerCache } from "./cache-refresh";
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
    // [FIX] Every field below now matches OfflineInvoice/OfflineInvoiceItem's
    // actual shape in db.ts — SYP fields (authoritative) sent alongside
    // their USD counterparts (informational, possibly null for a
    // SYP-only sale that never needed a rate).
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

          // Also insert into cachedCustomers if realId is provided
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
              // [NOTE] Explicitly false: a walk-in customer synced just
              // now has no documented invoice history yet — matches
              // pos-service.ts's isEligibleForCredit(), which only ever
              // accepts an explicit `true`. This customer becomes
              // credit-eligible once a real /api/customers refresh
              // reports a real prior invoice for them.
              hasPriorInvoices: false,
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

    // [FIX — critical, this revision] Refresh the caches that whatever
    // just got synced actually invalidated — see the file-header FIX
    // note for the full "stock silently reverts after a successful sync"
    // bug this closes. Best-effort: a refresh failure here is logged but
    // does NOT flip summary.success — the sync itself already committed
    // successfully server-side; only the local cache didn't catch up
    // this pass, and the next refresh from any trigger still corrects it.
    //
    // Product cache: only invoices affect ProductBatch.quantity server-
    // side (via commitFifoAllocation) — a synced customer or a synced
    // payment alone never does, so skip this refresh when no invoice
    // synced, to avoid an unnecessary network round-trip.
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

    // Customer cache: either a synced invoice (debt) or a synced payment
    // (repayment) can change a customer's server-side balance.
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
 * Automatically initiates sync within 5 seconds of network reconnection.
 */
// أضف هاد الاستيراد فوق مع باقي الاستيرادات
import { useLiveQuery } from "dexie-react-hooks";

/**
 * React Hook for managing background sync worker lifecycle.
 *
 * [FIX — critical] Previously, automatic sync only ever fired once per
 * mount: a single `useEffect` ran `scheduleSync()` exactly once when the
 * component first mounted (and again only on a genuine browser
 * online/offline transition). Nothing in this hook ever noticed that a
 * NEW PENDING record had been written to Dexie while the page was
 * already open and already online — e.g. right after
 * submitOfflineSale() completes a sale. The invoice sat PENDING
 * indefinitely until the user manually reloaded the page (which
 * remounted this hook and re-ran the one-time scheduleSync()).
 *
 * Fixed by making `pendingCount` itself REACTIVE via useLiveQuery
 * (same pattern lib/offline/hooks.ts's useOfflineDbReady already uses)
 * instead of a one-shot state variable populated by a plain fetch. Any
 * write to offlineInvoices/offlinePayments/offlineCustomers — from
 * anywhere in the app, at any time — now re-runs this query
 * automatically and updates `pendingCount` live. A separate effect below
 * watches for `pendingCount` transitioning from 0 to a positive number
 * (a genuinely NEW pending item appearing) and, if online, schedules a
 * sync the same debounced way the original online-reconnect path
 * already did — no manual triggerSync() call needed anywhere else in
 * the app.
 */
export function useSyncWorker(tenantId?: string) {
  const [isSyncing, setIsSyncing] = useState(false);
  const [lastSyncTime, setLastSyncTime] = useState<Date | null>(null);
  const [lastSummary, setLastSummary] = useState<SyncSummary | null>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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

  // [FIX] Reactive pending count — re-evaluates automatically on ANY
  // write to these three tables, from any code path in the app (a new
  // sale, a repayment, a walk-in customer, or this hook's own
  // status-update writes after a sync pass completes). Replaces the
  // previous one-shot getPendingRecordsCount() call + manual
  // refreshPendingCount() plumbing entirely — there is nothing left to
  // manually refresh; the live query IS the source of truth.
  const pendingCount = useLiveQuery(
    async () => {
      if (!tenantId || !isOfflineDbSupported()) return 0;
      return getPendingRecordsCount(tenantId);
    },
    [tenantId],
    0
  ) ?? 0;

  const scheduleSync = useCallback(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }
    debounceTimerRef.current = setTimeout(() => {
      void triggerSync();
    }, 2000);
  }, [triggerSync]);

  // [FIX] Fires a debounced sync attempt whenever pendingCount
  // transitions from 0 to a positive number (a genuinely NEW pending
  // item just appeared) — e.g. right after submitOfflineSale() writes
  // its Dexie record. Also fires on the initial mount if there's already
  // a nonzero pendingCount (e.g. a reload with leftover PENDING items),
  // matching the original mount-time behavior. Does NOT fire on every
  // pendingCount change — only on the 0 -> positive transition, so a
  // sync pass's own status-update writes (which move items OUT of
  // PENDING) never re-trigger themselves.
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

  // Reconnect handling — unchanged in spirit from the original: a real
  // browser online transition still schedules a sync (covers PENDING
  // items that piled up while genuinely offline, where the effect above
  // deliberately skipped scheduling).
  useEffect(() => {
    if (!tenantId || typeof window === "undefined") return;

    const handleOnline = () => {
      if (pendingCount > 0) scheduleSync();
    };
    window.addEventListener("online", handleOnline);

    return () => {
      window.removeEventListener("online", handleOnline);
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, [tenantId, pendingCount, scheduleSync]);

  return {
    isSyncing,
    pendingCount,
    lastSyncTime,
    lastSummary,
    triggerSync,
    // [FIX] refreshPendingCount kept as a no-op-returning-current-value
    // for backward compatibility with any existing caller — pendingCount
    // is now always live and needs no manual refresh trigger.
    refreshPendingCount: useCallback(async () => { }, []),
  };
}