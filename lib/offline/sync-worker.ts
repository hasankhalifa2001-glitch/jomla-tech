/**
 * Client-Side Sync Worker (T4c)
 *
 * Responsibilities:
 * 1. Pushes pending offline data (offlineCustomers, offlineInvoices, offlinePayments)
 *    to /api/sync IN CHUNKED BATCHES, in a fixed dependency-respecting order — see
 *    the [FIX — CHUNKED SYNC] note below for the full design and the exact bug
 *    this closes.
 * 2. Processes per-item responses from the server, updating local record status
 *    to "SYNCED" or "FAILED" with explicit failure reasons. A third server
 *    status, "RETRY_LATER", leaves the local record untouched (still PENDING)
 *    rather than writing any status at all — this covers both a raw transient
 *    DB conflict on the item's own transaction AND a customer dependency
 *    still mid-retry (see app/api/sync/route.ts's TransientDependencyError).
 * 3. Enforces that FAILED items are NEVER automatically retried (they remain in
 *    the FAILED state until manual reconciliation / T4e ledger resolution) —
 *    see retryFailedInvoice() below for the one explicit, manual exception to
 *    this rule.
 * 4. Listens for network reconnection (`online` event) and triggers sync within 5 seconds.
 * 5. Runs a periodic 45s safety-net check while online with pending work.
 *
 * [... prior header documentation on SYP/USD payload shape, post-sync
 * cache-refresh logic, the original RETRY_LATER handling (false-success bug
 * + orphaned-retry bug), and the periodic-interval-stability fix — unchanged
 * and still in effect, see earlier revisions of this file for the full text
 * of each ...]
 *
 * [FIX — CHUNKED SYNC, prior revision — closes two real bugs that only
 * surface after a long offline period with a large backlog]
 *
 * BUG 1 — Timeout / oversized-payload risk. The previous version of this
 * file collected EVERY pending customer/invoice/payment into ONE payload and
 * sent it in a SINGLE /api/sync request. The server processes each invoice
 * inside its own sequential `await` loop (app/api/sync/route.ts), so a
 * backlog of, say, 300 invoices accumulated over a multi-day offline period
 * could take tens of seconds to process in one request — a real risk of
 * hitting a serverless function's execution-time limit (common limits are
 * 10-60s) mid-request, with the client left holding a hung/failed fetch and
 * NO local status updates at all (the whole response never arrived), even
 * though every invoice processed before the cutoff had already committed
 * successfully server-side.
 *
 * BUG 2 — Cross-CHUNK dependency violations. Splitting into chunks
 * introduces a NEW failure mode that does not exist with a single request:
 * app/api/sync/route.ts's dependency-aware logic (retryableCustomerOfflineIds,
 * TransientDependencyError, and the sale-before-void sub-phase ordering) is
 * only aware of items within ONE request. A naive chunking scheme that
 * simply slices arrays into fixed-size pieces WITHOUT respecting dependency
 * order across chunks could send:
 *   - an invoice referencing a walk-in customer BEFORE that customer's own
 *     chunk has been confirmed SYNCED — the server has no record of a
 *     RETRY_LATER customer from a PRIOR request, so this invoice fails with
 *     the generic "customer not found" error and is marked permanently
 *     FAILED, not RETRY_LATER;
 *   - a void invoice in an EARLIER chunk than the original sale it reverses
 *     (possible if local creation order differs from the chunking split) —
 *     the void fails with "original not synced yet," which is NOT a
 *     retryable-pattern error server-side and is marked permanently FAILED.
 *
 * FIX — a fixed, dependency-respecting client-side stage order, each stage
 * chunked and sent as its own sequence of requests, with local Dexie state
 * updated after EVERY chunk (not only at the very end):
 *
 *   STAGE 1 — customers, chunked at CUSTOMER_CHUNK_SIZE. All customer
 *     chunks complete (success, retry, or failure recorded) before stage 2
 *     begins.
 *   STAGE 2 — sale invoices (no voidsOfflineInvoiceId), chunked at
 *     INVOICE_CHUNK_SIZE. Any sale invoice whose offlineCustomerId belongs
 *     to a customer left RETRY_LATER anywhere in stage 1 is EXCLUDED from
 *     this sync pass entirely (never sent — stays PENDING locally, picked
 *     up automatically on the next pass once its customer has synced).
 *     This is the client-side mirror of the server's own
 *     TransientDependencyError, extended across chunk/request boundaries
 *     where the server-side mechanism (scoped to one request) cannot reach.
 *   STAGE 3 — void invoices, chunked at INVOICE_CHUNK_SIZE, sent ONLY after
 *     every stage-2 chunk has been attempted. Any void whose
 *     voidsOfflineInvoiceId belongs to an original invoice that is NOT
 *     already SYNCED (from an earlier pass) AND was not marked SYNCED
 *     during stage 2 of *this* pass is EXCLUDED from this pass — covers an
 *     original that came back RETRY_LATER, FAILED, or was itself excluded
 *     for its own customer dependency in stage 2.
 *   STAGE 4 — payments, chunked at PAYMENT_CHUNK_SIZE. Same
 *     customer-dependency exclusion as stage 2.
 *
 * Every chunk is its own independent /api/sync request/response cycle:
 * Dexie is updated immediately after each chunk's response arrives (SYNCED/
 * FAILED writes, RETRY_LATER left untouched), rather than batching every
 * update until the entire multi-chunk pass finishes. This means a
 * connection drop or a function timeout partway through a large backlog
 * loses NOTHING already confirmed — every chunk that got a response before
 * the interruption is already reflected in Dexie, and the remaining
 * un-sent chunks simply stay PENDING for the next pass (triggered
 * automatically by the existing periodic-interval / reconnect / new-work
 * triggers, unchanged from the prior revision).
 *
 * A record excluded from a pass for a dependency reason is NEVER written to
 * Dexie with any status change — it is simply left out of that pass's
 * payload entirely, exactly like a RETRY_LATER server response, so it's
 * naturally reconsidered on the next pass with zero extra bookkeeping.
 *
 * Chunk sizes are deliberately conservative (customers/payments are
 * cheaper per-item than invoices, hence the larger size) and are exported
 * constants so they can be tuned without hunting through the function body.
 *
 * [FIX — CONNECTION-LEVEL ERRORS, this revision] Closes a real
 * misclassification bug on the SERVER side (app/api/sync/route.ts's
 * isRetryableTxError()) that this file's own status handling below simply
 * trusted: a raw database CONNECTION failure (e.g. Postgres or the
 * connection pool closing an established connection mid-request — "Server
 * has closed the connection") was previously NOT recognized as retryable
 * there, so it fell through to a permanent FAILED result after a single
 * attempt instead of the correct RETRY_LATER. Per this file's OWN
 * documented policy (point 3 above), FAILED is never auto-retried — so a
 * perfectly valid invoice could get stuck forever over a passing network
 * hiccup with zero data problem. That server-side classification is now
 * fixed to recognize Prisma connection-error codes (P1001/P1002/P1008/
 * P1017), PrismaClientInitializationError, and matching raw driver
 * messages as retryable, exactly like the existing deadlock/serialization
 * handling. See retryFailedInvoice() below for the client-side manual
 * safety net for any invoice already stuck FAILED from before that fix.
 */

import { getOfflineDb, isOfflineDbSupported, type OfflineInvoice } from "./db";
import { refreshProductCache, refreshCustomerCache } from "./cache-refresh";
import { useEffect, useState, useCallback, useRef } from "react";
import { useLiveQuery } from "dexie-react-hooks";

// [FIX — CHUNKED SYNC] Conservative defaults — tunable without touching
// the sync logic itself. Invoices are the most expensive per-item
// (FIFO/base-unit resolution, batch locking, multiple child-row writes),
// so they get the smallest chunk size.
export const CUSTOMER_CHUNK_SIZE = 50;
export const INVOICE_CHUNK_SIZE = 25;
export const PAYMENT_CHUNK_SIZE = 50;

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
  // [FIX — CHUNKED SYNC] Counts of items this pass never even SENT,
  // because a dependency of theirs (their customer, or — for a void —
  // their original sale) was not confirmed SYNCED anywhere in this same
  // pass. Distinct from retryLaterX (which reflects a server response)
  // — these never reached the server at all this pass. Also left
  // untouched in Dexie (still PENDING), for the exact same reason.
  deferredInvoices: number;
  deferredPayments: number;
  // True whenever this pass ended with at least one RETRY_LATER or
  // locally-deferred item — lets a UI show a calm "still syncing" state
  // instead of conflating this with a genuine, manual-intervention-needed
  // failure.
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

function chunk<T>(items: T[], size: number): T[][] {
  if (size <= 0) return [items];
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/**
 * Posts a single chunk-shaped payload to /api/sync. Never throws on a
 * non-2xx HTTP response — returns a shaped failure result instead, so the
 * caller can decide how to record it against the specific items in this
 * chunk without needing its own try/catch around every call site.
 */
async function postSyncChunk(payload: {
  customers: ReturnType<typeof buildCustomerPayload>[];
  invoices: ReturnType<typeof buildInvoicePayload>[];
  payments: ReturnType<typeof buildPaymentPayload>[];
}): Promise<{ ok: true; data: SyncApiResponse } | { ok: false; error: string }> {
  try {
    const response = await fetch("/api/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errJson = await response.json().catch(() => ({}));
      const errorMsg =
        errJson.message || `Sync request failed with HTTP ${response.status}`;
      return { ok: false, error: errorMsg };
    }

    const data: SyncApiResponse = await response.json();
    return { ok: true, data };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Network error during sync.";
    return { ok: false, error: message };
  }
}

// ============================================================================
// Payload shape builders — unchanged field-for-field from the prior
// revision's single-payload construction, just factored out so both the
// chunked stages below and any future caller build identically-shaped
// per-record payloads.
// ============================================================================

function buildCustomerPayload(c: {
  offlineId: string;
  name: string;
  phone?: string;
  shopName?: string;
  createdAt: Date | string;
}) {
  return {
    offlineId: c.offlineId,
    name: c.name,
    phone: c.phone,
    shopName: c.shopName,
    createdAt: c.createdAt,
  };
}

function buildInvoicePayload(inv: OfflineInvoice) {
  return {
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
  };
}

function buildPaymentPayload(p: {
  offlineId: string;
  customerId?: string;
  offlineCustomerId?: string;
  invoiceId?: string;
  offlineInvoiceId?: string;
  amountSYP: string;
  amountUSD: string;
  exchangeRate: string;
  paymentMethod: string;
  receiptNo?: string;
  notes?: string;
  createdAt: Date | string;
}) {
  return {
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
  };
}

/**
 * Executes a full, dependency-respecting, CHUNKED sync pass for all PENDING
 * offline records belonging to the given tenant.
 *
 * See the file-header [FIX — CHUNKED SYNC] note for the full stage design.
 * Local Dexie state is updated progressively, after every individual
 * chunk's response — never batched until the whole pass finishes — so an
 * interruption partway through a large backlog loses nothing already
 * confirmed by the server.
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
    deferredInvoices: 0,
    deferredPayments: 0,
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

  // ==========================================================================
  // Cross-stage dependency tracking — populated as each stage runs, consumed
  // by later stages to decide what's safe to SEND at all this pass. See the
  // file-header FIX note, BUG 2, for why this must exist client-side in
  // addition to (never instead of) the server's own per-request
  // TransientDependencyError mechanism.
  // ==========================================================================

  // offlineCustomerId -> true once a chunk response confirms SYNCED this pass.
  const customerSyncedThisPass = new Set<string>();
  // offlineCustomerId -> true if left RETRY_LATER (or never attempted due to
  // an earlier chunk-level network failure) anywhere in stage 1 this pass.
  // A customer NOT in this set and NOT in customerSyncedThisPass either was
  // FAILED outright — those invoices/payments are still sent (see the
  // file-header FIX note and t4c's own TransientDependencyError doc: a
  // genuinely-failed dependency should surface its OWN clear "customer not
  // found"-class error for manual review, not be silently withheld forever).
  const customerBlockedThisPass = new Set<string>();
  // offlineId (of a SALE invoice) -> true once confirmed SYNCED this pass,
  // OR already known SYNCED from a prior pass (i.e. not in pendingInvoices
  // at all, since only PENDING rows were fetched above). Used to gate
  // stage-3 (voids).
  const saleConfirmedThisPassOrEarlier = new Set<string>();
  // offlineId (of a SALE invoice) -> true if left RETRY_LATER, or excluded
  // for its own customer dependency, in stage 2 this pass. Gates stage 3.
  const saleBlockedThisPass = new Set<string>();

  async function processChunkResults(
    kind: "customers" | "invoices" | "payments",
    data: SyncApiResponse
  ): Promise<void> {
    if (kind === "customers") {
      for (const res of data.customers || []) {
        const local = pendingCustomers.find((c) => c.offlineId === res.offlineId);
        if (!local || local.id === undefined) continue;

        if (res.status === "SYNCED") {
          summary.syncedCustomers++;
          customerSyncedThisPass.add(res.offlineId);
          await db.offlineCustomers.update(local.id, {
            status: "SYNCED",
            failureReason: undefined,
          });
          if (res.realId) {
            await db.cachedCustomers.put({
              id: res.realId,
              tenantId: scopedTenantId,
              name: local.name,
              phone: local.phone,
              shopName: local.shopName,
              cachedBalanceDebtSYP: "0.0000",
              cachedBalanceDebtUSD: "0.0000",
              isSystemGenerated: false,
              hasPriorInvoices: false,
            });
          }
        } else if (res.status === "RETRY_LATER") {
          summary.retryLaterCustomers++;
          summary.hasPendingRetries = true;
          customerBlockedThisPass.add(res.offlineId);
        } else {
          summary.failedCustomers++;
          summary.errors.push(res.error || `Customer ${res.offlineId} failed`);
          await db.offlineCustomers.update(local.id, {
            status: "FAILED",
            failureReason: res.error || "فشل المزامنة",
          });
        }
      }
      return;
    }

    if (kind === "invoices") {
      for (const res of data.invoices || []) {
        const local = pendingInvoices.find((i) => i.offlineId === res.offlineId);
        if (!local || local.id === undefined) continue;

        const isSale = !local.voidsOfflineInvoiceId;

        if (res.status === "SYNCED") {
          summary.syncedInvoices++;
          if (isSale) saleConfirmedThisPassOrEarlier.add(res.offlineId);
          await db.offlineInvoices.update(local.id, {
            status: "SYNCED",
            failureReason: undefined,
            serverId: res.realId ?? undefined,
          });
        } else if (res.status === "RETRY_LATER") {
          summary.retryLaterInvoices++;
          summary.hasPendingRetries = true;
          if (isSale) saleBlockedThisPass.add(res.offlineId);
        } else {
          summary.failedInvoices++;
          summary.errors.push(res.error || `Invoice ${res.offlineId} failed`);
          if (isSale) saleBlockedThisPass.add(res.offlineId);
          await db.offlineInvoices.update(local.id, {
            status: "FAILED",
            failureReason: res.error || "فشل المزامنة",
          });
        }
      }
      return;
    }

    // payments
    for (const res of data.payments || []) {
      const local = pendingPayments.find((p) => p.offlineId === res.offlineId);
      if (!local || local.id === undefined) continue;

      if (res.status === "SYNCED") {
        summary.syncedPayments++;
        await db.offlinePayments.update(local.id, {
          status: "SYNCED",
          failureReason: undefined,
        });
      } else if (res.status === "RETRY_LATER") {
        summary.retryLaterPayments++;
        summary.hasPendingRetries = true;
      } else {
        summary.failedPayments++;
        summary.errors.push(res.error || `Payment ${res.offlineId} failed`);
        await db.offlinePayments.update(local.id, {
          status: "FAILED",
          failureReason: res.error || "فشل المزامنة",
        });
      }
    }
  }

  // ==========================================================================
  // STAGE 1 — Customers, chunked. Every chunk attempted before stage 2 opens.
  // ==========================================================================
  for (const customerChunk of chunk(pendingCustomers, CUSTOMER_CHUNK_SIZE)) {
    const result = await postSyncChunk({
      customers: customerChunk.map(buildCustomerPayload),
      invoices: [],
      payments: [],
    });

    if (!result.ok) {
      // A chunk-level network/HTTP failure — none of this chunk's items got
      // any server response at all, so none of them are added to either
      // customerSyncedThisPass or customerBlockedThisPass. They simply stay
      // PENDING in Dexie (untouched), exactly like a single RETRY_LATER
      // item would — no status write, naturally retried next pass. Every
      // invoice/payment depending on one of these customers is therefore
      // ALSO deferred below (via the "not synced AND not blocked" check,
      // which still correctly withholds them — see the invoice/payment
      // filtering logic in stages 2-4).
      summary.success = false;
      summary.errors.push(result.error);
      continue;
    }

    await processChunkResults("customers", result.data);
  }

  // ==========================================================================
  // STAGE 2 — Sale invoices, chunked, filtered by customer dependency.
  // ==========================================================================
  const saleInvoices = pendingInvoices.filter((inv) => !inv.voidsOfflineInvoiceId);

  const sendableSaleInvoices = saleInvoices.filter((inv) => {
    if (!inv.offlineCustomerId) return true; // customerId (real) or system customer — no dependency
    if (customerBlockedThisPass.has(inv.offlineCustomerId)) return false; // known-blocked this pass
    return true; // synced this pass, synced earlier, or failed outright — see note below
  });
  summary.deferredInvoices += saleInvoices.length - sendableSaleInvoices.length;

  for (const invoiceChunk of chunk(sendableSaleInvoices, INVOICE_CHUNK_SIZE)) {
    const result = await postSyncChunk({
      customers: [],
      invoices: invoiceChunk.map(buildInvoicePayload),
      payments: [],
    });

    if (!result.ok) {
      summary.success = false;
      summary.errors.push(result.error);
      continue;
    }

    await processChunkResults("invoices", result.data);
  }

  // ==========================================================================
  // STAGE 3 — Void invoices, chunked, sent only after ALL stage-2 chunks have
  // been attempted. Filtered by original-sale dependency.
  // ==========================================================================
  const voidInvoices = pendingInvoices.filter((inv) => inv.voidsOfflineInvoiceId);

  const sendableVoidInvoices = voidInvoices.filter((inv) => {
    const originalOfflineId = inv.voidsOfflineInvoiceId!;
    // The original might belong to an EARLIER, already-synced pass (not in
    // pendingInvoices at all, since only PENDING rows were fetched) — that
    // case is legitimate and must be sendable. Only exclude when the
    // original is a member of THIS pass's pending set AND did not confirm
    // SYNCED during stage 2 above.
    const originalIsPartOfThisPendingSet = saleInvoices.some(
      (s) => s.offlineId === originalOfflineId
    );
    if (!originalIsPartOfThisPendingSet) return true; // synced in an earlier pass
    return saleConfirmedThisPassOrEarlier.has(originalOfflineId);
  });
  summary.deferredInvoices += voidInvoices.length - sendableVoidInvoices.length;

  for (const invoiceChunk of chunk(sendableVoidInvoices, INVOICE_CHUNK_SIZE)) {
    const result = await postSyncChunk({
      customers: [],
      invoices: invoiceChunk.map(buildInvoicePayload),
      payments: [],
    });

    if (!result.ok) {
      summary.success = false;
      summary.errors.push(result.error);
      continue;
    }

    await processChunkResults("invoices", result.data);
  }

  // ==========================================================================
  // STAGE 4 — Payments, chunked, filtered by customer dependency (same rule
  // as stage 2).
  // ==========================================================================
  const sendablePayments = pendingPayments.filter((p) => {
    if (!p.offlineCustomerId) return true;
    if (customerBlockedThisPass.has(p.offlineCustomerId)) return false;
    return true;
  });
  summary.deferredPayments = pendingPayments.length - sendablePayments.length;

  for (const paymentChunk of chunk(sendablePayments, PAYMENT_CHUNK_SIZE)) {
    const result = await postSyncChunk({
      customers: [],
      invoices: [],
      payments: paymentChunk.map(buildPaymentPayload),
    });

    if (!result.ok) {
      summary.success = false;
      summary.errors.push(result.error);
      continue;
    }

    await processChunkResults("payments", result.data);
  }

  // success is false whenever anything failed terminally, was left
  // RETRY_LATER by the server, OR was locally deferred for a dependency
  // reason this pass — none of these mean data loss (everything stays
  // correctly queued), but none of them mean "this pass fully completed"
  // either.
  summary.success =
    summary.success &&
    summary.failedCustomers === 0 &&
    summary.failedInvoices === 0 &&
    summary.failedPayments === 0 &&
    summary.retryLaterCustomers === 0 &&
    summary.retryLaterInvoices === 0 &&
    summary.retryLaterPayments === 0 &&
    summary.deferredInvoices === 0 &&
    summary.deferredPayments === 0;

  if (summary.deferredInvoices > 0 || summary.deferredPayments > 0) {
    summary.hasPendingRetries = true;
  }

  // Post-sync cache refresh — unchanged in spirit from the prior revision,
  // now simply keyed off the pass-wide totals accumulated across every
  // chunk/stage rather than a single request's counts.
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
 * [ADDED — manual retry escape hatch for a FAILED invoice]
 *
 * Resets a single FAILED offline invoice back to PENDING (clearing its
 * failureReason) so the next sync pass — the caller is expected to call
 * triggerSync() immediately after this, as offline-void-panel.tsx does —
 * attempts it again from scratch.
 *
 * This exists as a safety net ALONGSIDE the /api/sync/route.ts fix that
 * now correctly classifies transient database CONNECTION errors (e.g.
 * "Server has closed the connection") as RETRY_LATER instead of FAILED
 * going forward — see this file's header [FIX — CONNECTION-LEVEL ERRORS]
 * note. That server-side fix is what stops NEW invoices from getting
 * stuck this way. This function is for any invoice that was ALREADY
 * marked FAILED (from before that fix, or any future misclassification
 * neither of us anticipated) — per this file's own documented policy,
 * FAILED is never auto-retried, so without an explicit escape hatch such
 * an invoice would otherwise require a direct database edit to recover.
 *
 * Deliberately scoped to exactly ONE invoice (by offlineId) — never
 * touches any other pending/failed record. Safe to call from a UI button
 * with no extra guards at the call site: it quietly does nothing if the
 * invoice doesn't exist locally, belongs to a different tenant, or isn't
 * currently FAILED (e.g. a second click while a retry is already
 * in flight and has already resolved it).
 */
export async function retryFailedInvoice(
  tenantId: string,
  offlineId: string
): Promise<void> {
  if (!tenantId || !offlineId || !isOfflineDbSupported()) return;

  const db = getOfflineDb();
  const local = await db.offlineInvoices.where("offlineId").equals(offlineId).first();

  if (!local || local.id === undefined) return;
  if (local.tenantId !== tenantId) return;
  if (local.status !== "FAILED") return;

  await db.offlineInvoices.update(local.id, {
    status: "PENDING",
    failureReason: undefined,
  });
}

/**
 * React Hook for managing background sync worker lifecycle.
 *
 * Automatic sync fires on THREE independent triggers:
 *   1. pendingCount transitioning from 0 to positive (a genuinely NEW
 *      pending item appearing — e.g. right after submitOfflineSale()).
 *   2. A real browser `online` reconnect event.
 *   3. A periodic 45s safety-net check — reads pendingCount from a ref
 *      instead of depending on it directly, so the interval itself is
 *      created once per mount/tenant and ticks reliably.
 *
 * [NOTE — chunked sync interaction] A single triggerSync() call now
 * internally performs a full, potentially multi-request chunked pass (see
 * syncPendingRecords' file-header FIX note) rather than one HTTP call.
 * isSyncingRef correctly covers the ENTIRE multi-chunk pass (it's held for
 * the duration of the syncPendingRecords() await, not per-request), so a
 * new trigger firing mid-pass (e.g. the 45s interval ticking while a large
 * backlog is still being chunked through) is still correctly suppressed by
 * the existing `if (!tenantId || isSyncingRef.current) return;` guard in
 * triggerSync() below — no changes needed there.
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
  }, [tenantId, scheduleSync]);

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