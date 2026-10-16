import { getTenantDb } from "@/lib/db";
import type { TenantSubscriptionStatus } from "@prisma/client";
import { NextResponse } from "next/server";

export class SubscriptionLockedError extends Error {
  readonly status: TenantSubscriptionStatus | null;

  constructor(status: TenantSubscriptionStatus | null) {
    const message =
      status === "PENDING"
        ? "اشتراك هذا المتجر قيد التفعيل حالياً. يرجى الانتظار حتى تتم الموافقة."
        : "عذراً، اشتراك هذا المتجر غير مفعّل حالياً. يرجى التجديد لتفادي إيقاف الميزات.";
    super(message);
    this.name = "SubscriptionLockedError";
    this.status = status;
  }
}

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
 * Asserts that a tenant's subscription is currently ACTIVE by performing a fresh,
 * authoritative database read within the same request lifecycle.
 *
 * This is the actual security boundary: it rejects direct mutating API calls against
 * EXPIRED or PENDING tenants independent of JWT/session token staleness.
 *
 * Throws SubscriptionLockedError if the tenant is EXPIRED, PENDING, or not found.
 */
export async function assertTenantWritable(
  tenantId: string
): Promise<TenantSubscriptionStatus> {
  const status = await getFreshTenantStatus(tenantId);
  if (status !== "ACTIVE") {
    throw new SubscriptionLockedError(status);
  }
  return status;
}

/**
 * Standard HTTP 403 response for SubscriptionLockedError.
 */
export function subscriptionLockedResponse(error: SubscriptionLockedError) {
  return NextResponse.json(
    {
      error: "SUBSCRIPTION_LOCKED",
      message: error.message,
      status: error.status,
    },
    { status: 403 }
  );
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

/**
 * T6a — named, narrow lockout-exemption list for the subscription checkout
 * API surface. These paths are deliberately allowed for PENDING/EXPIRED
 * tenants because that surface's whole purpose is to let a locked merchant
 * create a subscription request and upload a receipt to unlock.
 *
 * This is NOT a weakening of assertTenantWritable(): every route on this
 * list simply does NOT call assertTenantWritable(). Every other mutating
 * route continues to call it unconditionally. The list exists so the
 * exemption is explicit, auditable, and confined to exactly these prefixes
 * rather than scattered or implicit.
 */
export const SUBSCRIPTION_LOCKOUT_EXEMPT_API_PREFIXES = [
  "/api/billing/subscriptions",
  "/api/billing/status",
] as const;

/**
 * True when `pathname` is one of the T6a subscription-checkout API routes
 * that are exempt from the EXPIRED/PENDING write block. Such routes still
 * require an authenticated ADMIN session and a fresh isActive user check.
 */
export function isLockoutExemptPath(pathname: string): boolean {
  return SUBSCRIPTION_LOCKOUT_EXEMPT_API_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(prefix + "/")
  );
}


