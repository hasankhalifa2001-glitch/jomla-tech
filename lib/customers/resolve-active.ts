/**
 * lib/customers/resolve-active.ts
 *
 * Wholesale Arabic SaaS Platform — T4e Addendum (v4.2)
 *
 * Auto-Redirect on Write:
 * Every write path that creates an Invoice, CustomerPayment, or updates
 * B2BOrderRequest.matchedCustomerId against a customerId — namely:
 *   - T4c sync engine (app/api/sync/route.ts)
 *   - T4d online void (app/api/ledger/voids/route.ts)
 *   - T5 B2B order approval (app/api/orders/[id]/status/route.ts)
 *   - Any direct customer-scoped financial write route
 *
 * MUST, inside the same transaction as the write itself, resolve the target
 * customer through this shared helper:
 *
 *   resolveActiveCustomerId(tx, tenantId, customerId): Promise<string>
 *
 * Behavior:
 * Looks up CustomerMergeLog for a row where `mergedCustomerId === customerId`.
 * If found, returns `survivingCustomerId` instead (chased recursively, in case
 * the survivor itself was later merged into some other customer — capped at a
 * fixed depth of 5 to guard against a corrupt chain/loop rather than looping
 * indefinitely). If no such row exists, returns `customerId` unchanged.
 *
 * This is the SOLE SANCTIONED PATH any write path may resolve a customer ID
 * before persisting a financial record — mirroring T1's "one sanctioned path"
 * pattern for raw queries and base-unit access.
 *
 * [v4.4 — WHICH write paths must resolve, and HOW]
 * Two revisions clarified this list and the exact rule each member follows:
 *
 *   1. T4d's void writers are members — both the online route
 *      (app/api/ledger/voids) and the sync engine's void sub-pass. A void
 *      resolves originalInvoice.customerId FRESH, at the moment its own
 *      transaction executes: never copied verbatim from the original invoice's
 *      stored customerId, and never read from a value cached earlier. A
 *      customer merged away between a sale and its later void must receive the
 *      reversal on the CURRENT survivor — the same row the original invoice
 *      itself resolves to — or that customer's ledger silently splits in two,
 *      with part of the reversal sitting on a customer who, from the
 *      merchant's point of view, no longer exists.
 *
 *   2. T4c's sync engine splits PASS 2 into two ORDERED sub-phases (non-void
 *      invoices, then voids). BOTH call this helper independently, each
 *      resolved fresh: the void pass never reuses whatever the non-void pass
 *      resolved earlier in the same batch, because a merge can complete in the
 *      gap between the two sub-phases of one batch.
 *
 * [v4.4 — NO LOCK IS REQUIRED BETWEEN A MERGE AND A CONCURRENT WRITE]
 * When a write and a merge race for the same customer, the outcome depends
 * only on which transaction commits first, and both outcomes are correct:
 *   - write commits first → it lands on the pre-merge customer (true at that
 *     instant), and the merge that runs afterwards re-points that newly
 *     written row along with everything else, per the merge transaction's
 *     existing scope;
 *   - merge commits first → the write's in-transaction resolution returns the
 *     survivor immediately.
 * Correctness comes from calling this helper INSIDE the same transaction as
 * the write it resolves for — not from any ordering guarantee between the two
 * transactions.
 *
 * [DOCUMENTED KNOWN LIMITATION — Concurrency & Row Locks]
 * Customer merge does not place a database-level row lock on the Customer table
 * (to avoid distributed lock contention with offline writers). While
 * resolveActiveCustomerId closes the practical race and stale-offline-write
 * windows (by redirecting writes arriving after or concurrent with the merge),
 * a narrow window remains if a concurrent write commits against `mergedCustomerId`
 * at the exact microsecond before the merge transaction commits and after the
 * IDs were queried. In that case, any write arriving in that sub-millisecond gap
 * would have targeted the merged customer before deactivation, and subsequent
 * writes will auto-redirect to the survivor.
 *
 * [DOCUMENTED CAVEAT — BroadcastChannel Cache Invalidation Scope]
 * BroadcastChannel cache invalidation improves same-device multi-tab UX only
 * (mirroring T2c's exchange-rate live-sync). Other devices remain on the normal
 * refresh-on-reconnect cycle (refreshCustomerCache()), not real-time push.
 */

import type { TxOrClient } from "@/lib/db/tenant-scope";

export const MAX_RESOLVE_DEPTH = 5;

/**
 * Resolves a customer ID to its surviving active customer ID if it has been merged.
 * Chases recursive merges up to MAX_RESOLVE_DEPTH.
 *
 * @param tx - Prisma transaction or tenant-scoped client
 * @param tenantId - The authenticated tenant ID
 * @param customerId - The customer ID to resolve
 * @returns The surviving customer ID, or the unchanged customer ID if never merged
 */
export async function resolveActiveCustomerId(
  tx: TxOrClient,
  tenantId: string,
  customerId: string
): Promise<string> {
  if (!customerId || !customerId.trim()) {
    return customerId;
  }

  let currentId = customerId;
  let depth = 0;
  const visited = new Set<string>([currentId]);

  while (depth < MAX_RESOLVE_DEPTH) {
    const mergeLog = await tx.customerMergeLog.findFirst({
      where: {
        tenantId,
        mergedCustomerId: currentId,
      },
      select: {
        survivingCustomerId: true,
      },
    });

    if (!mergeLog) {
      break;
    }

    const nextId = mergeLog.survivingCustomerId;

    // Cycle guard: if we have seen nextId before in this resolution chain, break immediately
    if (visited.has(nextId)) {
      break;
    }

    visited.add(nextId);
    currentId = nextId;
    depth++;
  }

  return currentId;
}
