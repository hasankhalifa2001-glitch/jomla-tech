/**
 * Offline DB Transaction Helpers
 *
 * Provides transactional write operations ensuring offline records (invoices,
 * payments) and cached customer balances stay synchronized locally.
 *
 * ARCHITECTURAL NOTE FOR T4d (Void Invoices):
 * `saveOfflineInvoiceWithBalance` applies `addMoney(customer.cachedBalanceDebtSYP, invoiceRecord.debtAmountSYP)`.
 * When T4d creates a void invoice with a negative `debtAmountSYP` (per T4e negation formula),
 * passing that void invoice through this exact helper automatically decrements the customer balance
 * correctly (adding a negative number) within the same Dexie transaction, without requiring
 * separate void-balance logic.
 *
 * [FIX — critical] This file previously called `sumMoney(currentBalance,
 * invoiceRecord.debtAmountSYP)` — but sumMoney's real signature (see
 * lib/utils/money.ts) is `sumMoney(values: MoneyInput[]): string`, a
 * single-array parameter, not two separate arguments. Passing two
 * arguments silently dropped the second one (JS does not error on extra
 * call arguments), so `values` inside sumMoney was just `currentBalance`
 * itself — a string, not an array — and `values.reduce(...)` threw
 * `TypeError: currentBalance.reduce is not a function` the moment this
 * ran. Since submitOfflineSale() (pos-service.ts) calls
 * saveOfflineInvoiceWithBalance() for every offline sale, this meant ANY
 * offline sale carrying debt to an existing (non-walk-in) customer threw
 * inside the Dexie transaction and never completed — the single most
 * common T4b sale scenario. Fixed by using addMoney(a, b), the function
 * actually designed for two-value addition; sumMoney is reserved for
 * summing an already-built array (e.g. cart line totals).
 *
 * [REVIEWED — review pass 6, no change needed] db.ts's OfflineInvoice now
 * carries nullable USD-derived fields (totalUSD/paidAmountUSD/
 * debtAmountUSD/exchangeRateUsed can be `string | null` for a SYP-only
 * sale — see db.ts's own file-header FIX note). Nothing in this file is
 * affected: both helpers below read and write ONLY the SYP-authoritative
 * fields (debtAmountSYP, amountSYP, cachedBalanceDebtSYP), which remain
 * required, non-nullable strings regardless of whether a rate was
 * available for that sale's USD figures. This file was re-reviewed
 * specifically for that ripple effect and requires no changes.
 */

import { getOfflineDb, type OfflineDatabase, type OfflineInvoice, type OfflinePayment } from "./db";
import { addMoney, subtractMoney, compareMoney } from "../utils/money";

/**
 * Saves an offline invoice and synchronously updates the target customer's
 * `cachedCustomers.cachedBalanceDebtSYP` in the same Dexie transaction.
 *
 * - If `debtAmountSYP != 0`, the customer's cached balance is adjusted by `debtAmountSYP`.
 * - If `debtAmountSYP == 0`, the customer balance is untouched.
 */
export async function saveOfflineInvoiceWithBalance(
  invoiceRecord: OfflineInvoice,
  dbInstance?: OfflineDatabase
): Promise<OfflineInvoice> {
  const db = dbInstance ?? getOfflineDb();

  await db.transaction("rw", [db.offlineInvoices, db.cachedCustomers], async () => {
    await db.offlineInvoices.add(invoiceRecord);

    const targetCustomerId = invoiceRecord.customerId || invoiceRecord.offlineCustomerId;
    const hasDebtImpact = compareMoney(invoiceRecord.debtAmountSYP, 0) !== 0;

    if (hasDebtImpact && targetCustomerId) {
      const customer = await db.cachedCustomers.get(targetCustomerId);
      if (customer) {
        const currentBalance = customer.cachedBalanceDebtSYP ?? "0.0000";
        // [FIX] addMoney(a, b), not sumMoney(a, b) — see file-header note.
        const updatedBalance = addMoney(currentBalance, invoiceRecord.debtAmountSYP);
        await db.cachedCustomers.update(customer.id, {
          cachedBalanceDebtSYP: updatedBalance,
        });
      }
    }
  });

  return invoiceRecord;
}

/**
 * Saves an offline customer payment and updates the target customer's
 * `cachedCustomers.cachedBalanceDebtSYP` in the same Dexie transaction.
 *
 * - Independent repayment (`!paymentRecord.invoiceId`): decrements `cachedBalanceDebtSYP` by `amountSYP`.
 * - Same-invoice payment (`paymentRecord.invoiceId` present): does NOT adjust the customer balance,
 *   as it is already accounted for in that invoice's `debtAmountSYP` (prevents double counting).
 */
export async function saveOfflinePaymentWithBalance(
  paymentRecord: OfflinePayment,
  dbInstance?: OfflineDatabase
): Promise<OfflinePayment> {
  const db = dbInstance ?? getOfflineDb();

  await db.transaction("rw", [db.offlinePayments, db.cachedCustomers], async () => {
    await db.offlinePayments.add(paymentRecord);

    // Only independent repayments decrement customer balance.
    // Payments linked to an invoice were already factored into invoice.debtAmountSYP.
    const isIndependentRepayment = !paymentRecord.invoiceId && !paymentRecord.offlineInvoiceId;
    const targetCustomerId = paymentRecord.customerId || paymentRecord.offlineCustomerId;

    if (isIndependentRepayment && targetCustomerId) {
      const customer = await db.cachedCustomers.get(targetCustomerId);
      if (customer) {
        const currentBalance = customer.cachedBalanceDebtSYP ?? "0.0000";
        const updatedBalance = subtractMoney(currentBalance, paymentRecord.amountSYP);
        await db.cachedCustomers.update(customer.id, {
          cachedBalanceDebtSYP: updatedBalance,
        });
      }
    }
  });

  return paymentRecord;
}