/**
 * lib/receipts/share-gate.ts
 *
 * T4f addendum — Rule 1: "Share receipt" (PDF) is gated on the invoice's
 * SYNC state, and Rule 2: a locally-queued offline void record is treated
 * exactly like any other unsynced invoice record — no special-casing.
 *
 * This is a PURE decision helper, deliberately separate from the component
 * that renders it, mirroring the exact shape of
 * lib/offline/pos-service.ts's canVoidOfflineInvoice() /
 * shouldShowOfflineVoidPanel(): the online/offline void surfaces, the
 * panel's own visibility, and now the share gate are all decided by
 * `(input) => boolean` functions that a unit test can exhaustively
 * enumerate with no DOM, no Dexie handle, and no React renderer. The
 * component is then a thin, uninteresting mapping from this decision to
 * markup — see components/receipts/receipt-actions.tsx.
 *
 * WHY THE GATE IS ON SYNC STATE AND NOT ON "IS A PDF CACHED YET":
 * The server-generated PDF is keyed off Invoice.receiptPdfUrl, which cannot
 * exist until a real server-side Invoice row does. So the honest question a
 * cashier-facing control can answer locally, with zero network calls, is
 * exactly the T4b/T4c question this codebase already asks everywhere else:
 * "is this sale still only on this device?" Rule 1 explicitly requires the
 * control to be DISABLED (not hidden) with an Arabic explanation, mirroring
 * T4b's existing "saved locally vs synced" distinction rather than inventing
 * a new vocabulary for the same concept. The single canonical string lives
 * here so the toast, the tooltip, and the test all assert one source.
 *
 * THERMAL PRINTING IS DELIBERATELY ABSENT FROM THIS MODULE. Printing reads
 * from whichever local representation is authoritative right now and needs
 * no server row, no receiptPdfUrl, and no network — so it has no gate at
 * all. Keeping print OUT of this file is what makes that asymmetry visible
 * in the file structure itself: there is no `canPrintReceipt()` here to
 * mistakenly start returning false.
 */

import type { OfflineSyncStatus } from "@/lib/offline/db";

/** The one and only Arabic explanation for a disabled share control. */
export const SHARE_SYNC_INCOMPLETE_MESSAGE = "شارك بعد اكتمال المزامنة";

export interface ShareGateResult {
  allowed: boolean;
  /** Arabic explanation when `allowed` is false; null when allowed. */
  reasonAr: string | null;
}

export interface ShareGateInput {
  /**
   * The invoice's local sync status. A server-sourced invoice (one that
   * arrived over GET /api/invoices/[id]) is by construction already on the
   * server, so its callers pass "SYNCED" explicitly — see
   * components/sales-log/invoice-detail-modal.tsx.
   */
  status: OfflineSyncStatus | "SYNCED" | null | undefined;
  /**
   * The server Invoice id, when already known. This does NOT change the
   * gate's answer: an id can be known while a subsequent sync-state re-read
   * is still in flight, and Rule 1 is explicit that the gate is the sync
   * state. It is carried here only so the caller can decide whether it must
   * resolve the id before acting (see receipt-actions.tsx).
   */
  serverInvoiceId?: string | null;
}

/**
 * True only for a fully SYNCED invoice. PENDING, FAILED, and an unknown
 * status (the live query has not resolved yet) all BLOCK — an unknown state
 * must never be treated as "probably synced", the same fail-safe direction
 * lib/offline/pos-service.ts's isEligibleForCredit() takes toward
 * `hasPriorInvoices === undefined`.
 */
export function canShareReceipt(input: ShareGateInput): ShareGateResult {
  if (input.status === "SYNCED") {
    return { allowed: true, reasonAr: null };
  }
  return { allowed: false, reasonAr: SHARE_SYNC_INCOMPLETE_MESSAGE };
}

/**
 * Convenience used by the components: the label to render under/next to the
 * disabled control. Exists so no component ever hand-writes the Arabic
 * string (and so a test can assert the rendered text byte-for-byte).
 */
export function shareGateMessage(input: ShareGateInput): string {
  const gate = canShareReceipt(input);
  return gate.reasonAr ?? "";
}
