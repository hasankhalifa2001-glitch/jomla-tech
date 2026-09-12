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
 * Reads Tenant.dailyExchangeRate through getTenantDb(tenantId) — the same
 * tenant-scoped client used for the customer.findMany call below — rather
 * than a second, separately unscoped Prisma client instance, so every read
 * on this route goes through one consistent client per request.
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
          select: {
            debtAmountSYP: true,
          },
        },
        // Only independent repayments count against the balance — a
        // sale-time payment (invoiceId set) is already baked into that
        // invoice's own debtAmountSYP and must never be subtracted again.
        // NOTE: the relation on Customer is named `payments`, not
        // `customerPayments` — see schema.prisma's Customer model
        // (`payments CustomerPayment[]`).
        payments: {
          where: { invoiceId: null },
          select: {
            amountSYP: true,
          },
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