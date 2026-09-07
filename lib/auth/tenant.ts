import { getTenantDb } from "@/lib/db";
import type { TenantSubscriptionStatus } from "@prisma/client";

/**
 * Returns the fresh subscriptionStatus for a tenant directly from the database.
 * Never trusted from the JWT session payload, since subscriptionStatus can change
 * mid-session (e.g. Super-Admin approval in T6).
 */
export async function getFreshTenantStatus(
  tenantId: string
): Promise<TenantSubscriptionStatus | null> {
  const db = getTenantDb(tenantId);
  const tenant = await db.tenant.findUnique({
    where: { id: tenantId },
    select: { subscriptionStatus: true },
  });
  return tenant?.subscriptionStatus ?? null;
}

/**
 * Returns the fresh dailyExchangeRate for a tenant directly from the database as a
 * Decimal-serialized string (or null if not set).
 *
 * Adheres to T1 money.ts convention: monetary and exchange rate figures are preserved
 * as Decimal strings to eliminate floating-point precision drift. Never returns a plain
 * JavaScript number.
 */
export async function getFreshExchangeRate(
  tenantId: string
): Promise<string | null> {
  const db = getTenantDb(tenantId);
  const tenant = await db.tenant.findUnique({
    where: { id: tenantId },
    select: { dailyExchangeRate: true },
  });
  return tenant?.dailyExchangeRate != null ? tenant.dailyExchangeRate.toString() : null;
}
