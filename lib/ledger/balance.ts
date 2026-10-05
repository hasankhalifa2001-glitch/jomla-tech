/**
 * lib/ledger/balance.ts
 *
 * T4e — THE one and only implementation of a customer's ledger balance.
 *
 * FORMULA (T1's Customer model, unchanged):
 *
 *   net debt (SYP) = SUM(Invoice.debtAmountSYP)
 *                  − SUM(CustomerPayment.amountSYP WHERE invoiceId IS NULL)
 *
 * CustomerPayment.invoiceId is non-null for a sale-time payment (already baked
 * into that invoice's own debtAmountSYP at creation) and null for an
 * independent later repayment — only the latter is ever subtracted. Summing an
 * invoiceId-having payment in here would double-count a sale-time payment
 * against the very debt it already reduced.
 *
 * WHY THIS FILE EXISTS (single-source rule):
 * Before this file, the formula lived as an inline loop inside
 * app/api/customers/route.ts, and a new repayment path would have had no
 * choice but to re-type it — exactly the "two divergent copies of one
 * financial formula" failure this project bans. There are now exactly two
 * entry points into it, and BOTH end in the same `computeBalanceSYP`:
 *
 *   - `computeBalanceSYP(debt[], repayments[])` — the pure formula. Used by
 *     GET /api/customers, which already loads every customer's invoices and
 *     repayments in ONE grouped query (an N+1 per-customer recalculation there
 *     would be a real regression, so the route maps the arrays it already has
 *     through this function instead).
 *   - `getCustomerBalanceSYP(tx, tenantId, customerId)` — the same formula for
 *     ONE customer, reading its two sums with two targeted queries. Used by
 *     lib/ledger/repayment.ts's recordRepayment() to validate an amount
 *     against the customer's current balance.
 *
 * Both routes go through lib/utils/money.ts for every arithmetic step — never
 * native float math — per that module's scope note.
 */

import type { TxOrClient } from "@/lib/db/tenant-scope";
import { addMoney, subtractMoney } from "@/lib/utils/money";

/**
 * The ledger formula itself — pure, no I/O, no Prisma.
 *
 * Both inputs are plain arrays of Decimal-serialized SYP strings (the shape
 * Prisma's `Decimal.toString()` produces). Invalid input throws `MoneyError`
 * from lib/utils/money.ts rather than silently contributing a wrong figure —
 * see that file's "fail loud, not fail silent" header.
 */
export function computeBalanceSYP(
  debtAmountsSYP: string[],
  repaymentAmountsSYP: string[]
): string {
  let balanceSYP = "0.0000";
  for (const debt of debtAmountsSYP) {
    if (debt == null) continue;
    balanceSYP = addMoney(balanceSYP, debt);
  }
  for (const repayment of repaymentAmountsSYP) {
    if (repayment == null) continue;
    balanceSYP = subtractMoney(balanceSYP, repayment);
  }
  return balanceSYP;
}

/**
 * Current balance (SYP) for ONE customer, via the shared formula above.
 *
 * Two targeted reads:
 *   - every Invoice row of this customer (any status — a VOIDED invoice is a
 *     negated mirror that already nets its original out to exactly zero, and
 *     excluding it here would silently un-reverse the void), selecting only
 *     debtAmountSYP;
 *   - only the independent repayments (`invoiceId: null`).
 *
 * `customerId` must be an ALREADY-RESOLVED customer id — merge resolution
 * (lib/customers/resolve-active.ts) happens before this is called, inside the
 * caller's own transaction, so this function never has to know about merges.
 *
 * The `where` clauses carry `tenantId` explicitly even though the
 * getTenantDb() extension would inject it: this function is also called with a
 * raw transaction client from the sync engine (see lib/db.ts's category-5
 * note), where no injection happens.
 */
export async function getCustomerBalanceSYP(
  tx: TxOrClient,
  tenantId: string,
  customerId: string
): Promise<string> {
  const invoices = await tx.invoice.findMany({
    where: { tenantId, customerId },
    select: { debtAmountSYP: true },
  });

  const repayments = await tx.customerPayment.findMany({
    where: { tenantId, customerId, invoiceId: null },
    select: { amountSYP: true },
  });

  return computeBalanceSYP(
    invoices.map((invoice) => invoice.debtAmountSYP.toString()),
    repayments.map((repayment) => repayment.amountSYP.toString())
  );
}