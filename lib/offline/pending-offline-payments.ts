import { useLiveQuery } from "dexie-react-hooks";
import { getOfflineDb, isOfflineDbSupported, type OfflineSyncStatus } from "./db";
import { addMoney, compareMoney } from "../utils/money";

/**
 * lib/offline/pending-offline-payments.ts
 *
 * T4e — the reactive data source behind the ledger screen's "بانتظار المزامنة"
 * state on a customer card.
 *
 * Built on the SAME useLiveQuery pattern as
 * lib/offline/pending-offline-invoices.ts: any write to offlinePayments (a new
 * queued repayment, a sync pass marking one SYNCED or FAILED) re-runs this
 * query automatically, so the card's state changes without a reload and
 * without any manual refresh plumbing.
 *
 * READ-ONLY, tenant-scoped, and deliberately never reaches the network — it
 * answers exactly one question for the UI: "does this customer have a
 * repayment queued on THIS device that the server has not confirmed yet?"
 *
 * Which rows count as PENDING: independent repayments only (no invoiceId /
 * offlineInvoiceId — a sale-time payment lives inside its invoice's own debt
 * and is never a card-level repayment), and status === "PENDING". FAILED rows
 * are a distinct UI state (فشلت المزامنة) and are listed separately — never
 * lumped into "بانتظار المزامنة".
 */
export interface PendingOfflineRepayment {
  offlineId: string;
  customerId: string;
  amountSYP: string;
  status: OfflineSyncStatus;
  failureReason?: string;
}

/** Sum of every not-yet-synced repayment per customerId, SYP. */
export type PendingRepaymentTotalsByCustomer = Record<string, string>;

const EMPTY_TOTALS: PendingRepaymentTotalsByCustomer = {};

export async function listPendingOfflineRepayments(
  tenantId?: string
): Promise<PendingOfflineRepayment[]> {
  if (!tenantId || !tenantId.trim() || !isOfflineDbSupported()) return [];

  const db = getOfflineDb();
  const rows = await db.offlinePayments.where("tenantId").equals(tenantId.trim()).toArray();

  return rows
    .filter(
      (row) =>
        row.status === "PENDING" &&
        !row.invoiceId &&
        !row.offlineInvoiceId &&
        !!row.customerId
    )
    .map((row) => ({
      offlineId: row.offlineId,
      customerId: row.customerId as string,
      amountSYP: row.amountSYP,
      status: row.status,
      failureReason: row.failureReason,
    }))
    .sort((a, b) => a.offlineId.localeCompare(b.offlineId));
}

/**
 * customerId -> total pending repayment (SYP). Money arithmetic goes through
 * lib/utils/money.ts, never native floats.
 */
export async function pendingRepaymentTotalsByCustomer(
  tenantId?: string
): Promise<PendingRepaymentTotalsByCustomer> {
  const rows = await listPendingOfflineRepayments(tenantId);
  if (rows.length === 0) return EMPTY_TOTALS;

  const totals: PendingRepaymentTotalsByCustomer = {};
  for (const row of rows) {
    const current = totals[row.customerId] ?? "0.0000";
    totals[row.customerId] = addMoney(current, row.amountSYP);
  }
  return totals;
}

/** True when this customer has at least one PENDING queued repayment. */
export function hasPendingRepayment(
  totals: PendingRepaymentTotalsByCustomer,
  customerId: string
): boolean {
  const total = totals[customerId];
  if (!total) return false;
  try {
    return compareMoney(total, 0) > 0;
  } catch {
    // A malformed cached amount must never break the ledger screen — the card
    // simply shows no pending badge for it. The real value is validated on the
    // server by recordRepayment() and locally by submitOfflinePayment().
    return false;
  }
}

export function usePendingRepaymentTotals(
  tenantId?: string
): PendingRepaymentTotalsByCustomer {
  return (
    useLiveQuery(
      async () => pendingRepaymentTotalsByCustomer(tenantId),
      [tenantId],
      EMPTY_TOTALS
    ) ?? EMPTY_TOTALS
  );
}

const EMPTY_FAILED: PendingOfflineRepayment[] = [];

export async function listFailedOfflineRepayments(
  tenantId?: string
): Promise<PendingOfflineRepayment[]> {
  if (!tenantId || !tenantId.trim() || !isOfflineDbSupported()) return [];

  const db = getOfflineDb();
  const rows = await db.offlinePayments.where("tenantId").equals(tenantId.trim()).toArray();

  return rows
    .filter(
      (row) =>
        row.status === "FAILED" &&
        !row.invoiceId &&
        !row.offlineInvoiceId &&
        !!row.customerId
    )
    .map((row) => ({
      offlineId: row.offlineId,
      customerId: row.customerId as string,
      amountSYP: row.amountSYP,
      status: row.status,
      failureReason: row.failureReason,
    }))
    .sort((a, b) => a.offlineId.localeCompare(b.offlineId));
}

export function useFailedOfflineRepayments(
  tenantId?: string
): PendingOfflineRepayment[] {
  return (
    useLiveQuery(
      async () => listFailedOfflineRepayments(tenantId),
      [tenantId],
      EMPTY_FAILED
    ) ?? EMPTY_FAILED
  );
}
