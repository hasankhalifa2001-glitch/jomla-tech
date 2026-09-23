/**
 * lib/offline/customer-sync.ts
 *
 * Wholesale Arabic SaaS Platform — T4e Addendum (v4.2)
 *
 * Cashier-Facing Live Cache Invalidation:
 * When an ADMIN merges duplicate customers, this module broadcasts a cache invalidation
 * signal via BroadcastChannel so all open tabs/windows on the same device immediately:
 *   1. Evict the merged (deactivated) customer from Dexie's cachedCustomers table —
 *      UNLESS a local, not-yet-synced offlineInvoice/offlinePayment still references
 *      it (see [FIX — STALE-NAME REGRESSION] below).
 *   2. Trigger refreshCustomerCache() to pull fresh debt balances for the surviving customer.
 *
 * [FIX — STALE-NAME REGRESSION, this revision]
 * The original version of evictMergedCustomerAndRefresh() unconditionally hard-deleted
 * the merged customer's cachedCustomers row the instant the broadcast/local call landed.
 * Real gap: a cashier can have a PENDING (not yet synced) offlineInvoice or
 * offlinePayment whose `customerId` still points at the just-merged customer — e.g. a
 * sale rung up moments before an ADMIN, on a different tab/device, merges that same
 * customer into a survivor. Once the row was deleted, every local lookup that resolves
 * a display name via cachedCustomers/offlineCustomers (most notably
 * lib/offline/pos-service.ts's listPendingOfflineInvoices(), which backs the T4b
 * offline-void panel's customer-name column) fell through to "زبون غير معروف" for that
 * invoice/payment — confusing for a cashier looking at a sale they just rang up
 * themselves. No data was lost (offlineInvoices/offlinePayments keep the raw customerId
 * regardless, and it resolves correctly server-side via resolveActiveCustomerId() at
 * sync time) — this was purely a local-display regression.
 *
 * Fixed: before deleting, evictMergedCustomerAndRefresh() now checks whether any local,
 * not-yet-synced offlineInvoices/offlinePayments row still references mergedCustomerId.
 * If so, the cachedCustomers row is intentionally KEPT (so the name/shop still resolve
 * in the offline void panel and anywhere else that reads cachedCustomers) but is
 * relabeled in-place to make the merge visible (name suffixed with "(تم الدمج)") rather
 * than silently left looking like an ordinary, still-selectable customer — a merged
 * customer must never be offered again as a NEW sale's customer, only tolerated as the
 * historical customerId on an invoice/payment that predates the merge. Once every local
 * reference to it has synced (or none ever existed), the row is deleted exactly as
 * before.
 *
 * [DOCUMENTED CAVEAT — BroadcastChannel Scope]
 * BroadcastChannel only communicates between tabs/windows on the same browser, on the same device.
 * It does not propagate across the network to a different device. Other devices remain on the normal
 * refresh-on-reconnect cycle (refreshCustomerCache() during app load or after sync), not real-time push.
 */

"use client";

import { useEffect } from "react";
import { getOfflineDb, isOfflineDbSupported } from "./db";
import { refreshCustomerCache } from "./cache-refresh";

export const CUSTOMER_SYNC_BROADCAST_CHANNEL = "jomla_customer_sync";

/** Suffix appended to a merged customer's cached name when its row must be
 * kept around temporarily (a local, not-yet-synced record still references
 * it) instead of being deleted outright. Kept as a single named constant so
 * the offline void panel / any other reader can strip or detect it
 * consistently if ever needed, rather than each call site re-deriving the
 * same literal string.
 */
export const MERGED_CUSTOMER_NAME_SUFFIX = " (تم الدمج)";

export interface CustomerMergedBroadcastMessage {
  type: "CUSTOMER_MERGED";
  tenantId: string;
  mergedCustomerId: string;
  survivingCustomerId: string;
  timestamp: number;
}

let customerBroadcastChannel: BroadcastChannel | null = null;
if (typeof window !== "undefined" && typeof BroadcastChannel !== "undefined") {
  try {
    customerBroadcastChannel = new BroadcastChannel(CUSTOMER_SYNC_BROADCAST_CHANNEL);
  } catch {
    customerBroadcastChannel = null;
  }
}

/**
 * Broadcasts customer merge event across tabs on the same device,
 * evicts the merged customer from local Dexie storage (subject to the
 * still-referenced-locally guard below), and refreshes the customer cache.
 */
export async function broadcastCustomerMerged(
  tenantId: string,
  mergedCustomerId: string,
  survivingCustomerId: string
): Promise<void> {
  const message: CustomerMergedBroadcastMessage = {
    type: "CUSTOMER_MERGED",
    tenantId,
    mergedCustomerId,
    survivingCustomerId,
    timestamp: Date.now(),
  };

  // 1. Post to broadcast channel for other tabs on this device
  if (customerBroadcastChannel) {
    try {
      customerBroadcastChannel.postMessage(message);
    } catch (e) {
      console.warn("[customer-sync] BroadcastChannel postMessage failed:", e);
    }
  }

  // 2. Local eviction and refresh on this tab
  await evictMergedCustomerAndRefresh(tenantId, mergedCustomerId);
}

/**
 * Returns true iff at least one local, not-yet-synced offlineInvoice or
 * offlinePayment for this tenant still carries `customerId === mergedCustomerId`.
 *
 * Scoped to status !== "SYNCED" deliberately — a SYNCED local record's
 * customerId is already historical/display-only at that point (the real
 * source of truth is the server row, already resolved via
 * resolveActiveCustomerId() at sync time); only a still-pending/failed local
 * record depends on this device's own cachedCustomers row to render a name
 * right now.
 */
async function hasLocalUnsyncedReference(
  tenantId: string,
  mergedCustomerId: string
): Promise<boolean> {
  const db = getOfflineDb();

  const [invoiceMatch, paymentMatch] = await Promise.all([
    db.offlineInvoices
      .where("tenantId")
      .equals(tenantId)
      .filter((inv) => inv.status !== "SYNCED" && inv.customerId === mergedCustomerId)
      .first(),
    db.offlinePayments
      .where("tenantId")
      .equals(tenantId)
      .filter((p) => p.status !== "SYNCED" && p.customerId === mergedCustomerId)
      .first(),
  ]);

  return Boolean(invoiceMatch || paymentMatch);
}

/**
 * Evicts a merged customer from cachedCustomers and refreshes the cache —
 * UNLESS a local, not-yet-synced offlineInvoice/offlinePayment still
 * references it (see [FIX — STALE-NAME REGRESSION] above), in which case the
 * row is kept but visibly relabeled instead of deleted.
 */
export async function evictMergedCustomerAndRefresh(
  tenantId: string,
  mergedCustomerId: string
): Promise<void> {
  if (!isOfflineDbSupported()) return;

  try {
    const db = getOfflineDb();

    const stillReferencedLocally = await hasLocalUnsyncedReference(tenantId, mergedCustomerId);

    if (stillReferencedLocally) {
      // Keep the row so name/shop lookups (e.g. the T4b offline void panel's
      // listPendingOfflineInvoices()) keep resolving correctly for the
      // still-pending local record — but relabel it in place so it's
      // visibly a merged/historical customer, never offered again as a
      // selectable option for a NEW sale.
      const existing = await db.cachedCustomers.get(mergedCustomerId);
      if (existing && !existing.name.endsWith(MERGED_CUSTOMER_NAME_SUFFIX)) {
        await db.cachedCustomers.update(mergedCustomerId, {
          name: `${existing.name}${MERGED_CUSTOMER_NAME_SUFFIX}`,
        });
      }
    } else {
      // No local, not-yet-synced record depends on this row anymore (or
      // never did) — safe to delete outright, exactly as before.
      await db.cachedCustomers.delete(mergedCustomerId);
    }

    // Refresh the customer cache in background to update survivor balance
    // (and, once every local reference has synced, a later refresh's
    // server snapshot naturally omits the merged customer entirely,
    // completing the eventual cleanup even if this pass kept the row).
    void refreshCustomerCache(tenantId);
  } catch (error) {
    console.error("[customer-sync] Failed to evict merged customer from cache:", error);
  }
}

/**
 * Hook to be mounted in POS layouts: listens for customer merge events
 * and keeps the local customer cache synchronized across tabs.
 */
export function useCustomerCacheSync(tenantId?: string) {
  useEffect(() => {
    if (!tenantId || typeof window === "undefined" || typeof BroadcastChannel === "undefined") {
      return;
    }

    let channel: BroadcastChannel | null = null;
    try {
      channel = new BroadcastChannel(CUSTOMER_SYNC_BROADCAST_CHANNEL);
      channel.onmessage = (event: MessageEvent<CustomerMergedBroadcastMessage>) => {
        if (
          event.data &&
          event.data.type === "CUSTOMER_MERGED" &&
          event.data.tenantId === tenantId
        ) {
          void evictMergedCustomerAndRefresh(tenantId, event.data.mergedCustomerId);
        }
      };
    } catch {
      channel = null;
    }

    return () => {
      if (channel) {
        channel.close();
      }
    };
  }, [tenantId]);
}