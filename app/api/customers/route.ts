import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getTenantDb } from "@/lib/db/tenant-scope";
import { toDecimal, subtractMoney, convertCurrency, compareMoney } from "@/lib/utils/money";

/**
 * GET /api/customers
 *
 * Returns the authenticated tenant's active customers with their current
 * debt balance, for T4a's refreshCustomerCache() to populate Dexie's
 * cachedCustomers table.
 *
 * Debt formula — per T1's Customer model:
 *   net debt (SYP) = SUM(Invoice.debtAmountSYP) − SUM(CustomerPayment.amountSYP WHERE invoiceId IS NULL)
 *
 * CustomerPayment.invoiceId is non-null for a sale-time payment (already
 * reflected inside that invoice's own debtAmountSYP at creation) and null
 * for an independent later repayment — only the latter is ever subtracted
 * here. Including invoiceId-having payments in this sum would double-count
 * a sale-time payment against the same debt it already reduced.
 *
 * cachedBalanceDebtUSD is NOT a sum of each historical invoice's own
 * debtAmountUSD — those were each frozen at a different transaction-time
 * exchange rate, and adding them together produces a number with no real
 * meaning. Instead it's a single conversion of the final SYP balance using
 * the tenant's CURRENT dailyExchangeRate, since this field is explicitly a
 * display-only, informational approximation (T1: "USD is never validated
 * against, never gates any action").
 *
 * [ADDED — offline credit-sale gate] hasPriorInvoices: true when this
 * customer has at least one Invoice on record (any status), i.e. a
 * documented prior relationship with the merchant, as opposed to a
 * customer row that exists but has never actually transacted. Computed
 * from the exact same `invoices` relation already fetched below for the
 * debt sum — no additional query needed. Consumed by
 * lib/offline/pos-service.ts's isEligibleForCredit() to gate offline
 * credit sales; see CachedCustomer.hasPriorInvoices's doc comment
 * (lib/offline/db.ts) for the full reasoning.
 *
 * Reads Tenant.dailyExchangeRate through getTenantDb(tenantId) — the same
 * tenant-scoped client used for the customer.findMany call below — rather
 * than a second, separately unscoped Prisma client instance, so every read
 * on this route goes through one consistent client per request.
 *
 * [FIX — defense in depth on the nested include] lib/db/tenant-scope.ts's
 * Prisma Client Extension only intercepts the TOP-LEVEL model.operation
 * call (customer.findMany here) — it does not, and structurally cannot,
 * intercept `include: { invoices: {...}, payments: {...} }` as separate
 * operations, since Prisma resolves those as part of the same query, not
 * as independent calls the extension's $allOperations hook ever sees. The
 * safety of those two included relations therefore rested entirely on an
 * unenforced application invariant — "every Invoice/CustomerPayment row's
 * tenantId always matches its Customer's tenantId" — rather than on the
 * isolation layer itself. That invariant should always hold given the
 * nested-write ban elsewhere in the codebase, but a single future bug at
 * some other write path (an Invoice written with a mismatched tenantId)
 * would leak that customer's debt figures — and, now, their
 * hasPriorInvoices credit eligibility — across tenants right here, with
 * nothing in this file to catch it. Both relations below carry an
 * explicit `tenantId` filter of their own — redundant with the
 * FK-derived guarantee in the common case, but a real, independent
 * second check rather than trusting the FK alone.
 */
export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.tenantId) {
      return NextResponse.json(
        { error: "UNAUTHORIZED", message: "يرجى تسجيل الدخول أولاً." },
        { status: 401 }
      );
    }

    const tenantId = session.user.tenantId;
    const db = getTenantDb(tenantId);

    // Current exchange rate — read fresh from the DB (never from the JWT),
    // per T2a's rule that dailyExchangeRate must never be trusted from a
    // cached/session value. Used only for the informational USD figure.
    const tenant = await db.tenant.findUnique({
      where: { id: tenantId },
      select: { dailyExchangeRate: true },
    });
    const currentRate = tenant?.dailyExchangeRate?.toString();
    const hasValidRate = !!currentRate && compareMoney(currentRate, 0) > 0;

    const customers = await db.customer.findMany({
      where: {
        isActive: true,
      },
      include: {
        invoices: {
          // [FIX] Explicit tenantId filter — see the defense-in-depth note
          // above. Not redundant with the extension; the extension never
          // sees this nested relation at all.
          where: { tenantId },
          // debtAmountSYP is used for the balance sum below; the array's
          // own length (regardless of which fields are selected) is what
          // hasPriorInvoices is computed from further down.
          select: { debtAmountSYP: true },
        },
        // Only independent repayments count against the balance — a
        // sale-time payment (invoiceId set) is already baked into that
        // invoice's own debtAmountSYP and must never be subtracted again.
        // NOTE: the relation on Customer is named `payments`, not
        // `customerPayments` — see schema.prisma's Customer model
        // (`payments CustomerPayment[]`).
        payments: {
          // [FIX] Same explicit tenantId filter as `invoices` above.
          where: { invoiceId: null, tenantId },
          select: { amountSYP: true },
        },
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    const mappedCustomers = customers.map((c) => {
      let debtSYP = "0.0000";

      for (const inv of c.invoices) {
        if (inv.debtAmountSYP) {
          debtSYP = toDecimal(debtSYP).plus(toDecimal(inv.debtAmountSYP.toString())).toFixed(4);
        }
      }

      for (const pay of c.payments) {
        if (pay.amountSYP) {
          debtSYP = subtractMoney(debtSYP, pay.amountSYP.toString());
        }
      }

      // Informational only — a single conversion of the final balance at
      // today's rate, never a sum of historically-frozen USD figures.
      // Omitted (not zeroed) when no valid rate is cached, matching T1's
      // "USD fields are nullable/derived... never an error" rule.
      const debtUSD = hasValidRate
        ? convertCurrency(debtSYP, currentRate!, "SYP", "USD")
        : undefined;

      return {
        id: c.id,
        tenantId,
        name: c.name,
        phone: c.phone || null,
        shopName: c.shopName || null,
        cachedBalanceDebtSYP: debtSYP,
        cachedBalanceDebtUSD: debtUSD,
        isSystemGenerated: c.isSystemGenerated,
        // [ADDED] Any invoice at all (any status) counts as a documented
        // prior relationship — see this file's own header note and
        // CachedCustomer.hasPriorInvoices's doc comment for why this is
        // deliberately not narrowed to e.g. status === "COMPLETED" only.
        hasPriorInvoices: c.invoices.length > 0,
        // [v4.2] T4e Addendum: Customer merge comparison screen requires invoice & payment counts
        invoiceCount: c.invoices.length,
        paymentCount: c.payments.length,
      };
    });

    return NextResponse.json({
      success: true,
      customers: mappedCustomers,
    });
  } catch (error) {
    console.error("Failed to fetch customers:", error);
    return NextResponse.json(
      { error: "SERVER_ERROR", message: "حدث خطأ أثناء جلب قائمة الزبائن." },
      { status: 500 }
    );
  }
}