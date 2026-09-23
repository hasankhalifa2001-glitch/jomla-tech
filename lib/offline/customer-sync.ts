/**
 * lib/offline/customer-sync.ts
 *
 * Wholesale Arabic SaaS Platform — T4e Addendum (v4.2)
 *
 * Cashier-Facing Live Cache Invalidation:
 * When an ADMIN merges duplicate customers, this module broadcasts a cache invalidation
 * signal via BroadcastChannel so all open tabs/windows on the same device immediately:
 *   1. Evict the merged (deactivated) customer from Dexie's cachedCustomers table.
 *   2. Trigger refreshCustomerCache() to pull fresh debt balances for the surviving customer.
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
 * evicts the merged customer from local Dexie storage, and refreshes the customer cache.
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
 * Evicts a merged customer from cachedCustomers and refreshes the cache.
 */
export async function evictMergedCustomerAndRefresh(
  tenantId: string,
  mergedCustomerId: string
): Promise<void> {
  if (!isOfflineDbSupported()) return;

  try {
    const db = getOfflineDb();
    // Delete the merged (deactivated) customer so cashiers cannot pick them
    await db.cachedCustomers.delete(mergedCustomerId);
    // Refresh the customer cache in background to update survivor balance
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
