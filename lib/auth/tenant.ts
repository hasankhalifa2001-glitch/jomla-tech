import { getTenantDb } from "@/lib/db";
import type { TenantSubscriptionStatus } from "@prisma/client";
import { NextResponse } from "next/server";
import { getEffectiveTenantStatus } from "@/lib/subscription/effective-status";

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
 *
 * [T6c] Kept for the read-only status-poll endpoint only. Write enforcement
 * goes through assertTenantWritable() → getEffectiveTenantStatus().
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
 * [T6c] The actual security boundary: fresh, authoritative tenant row read
 * within the same request lifecycle, decided SOLELY by
 * getEffectiveTenantStatus() (lib/subscription/effective-status.ts).
 * Writable ⇔ effective ACTIVE or GRACE; PENDING and effective EXPIRED throw.
 *
 * Rejects direct mutating API calls independent of JWT/session staleness and
 * of any page redirect. Locking depends on NO cron job: a tenant is locked
 * exactly when expiresAt + grace passes, evaluated live on every request.
 *
 * Throws SubscriptionLockedError if the tenant is locked or not found.
 * Never caches across calls.
 */
export async function assertTenantWritable(
  tenantId: string
): Promise<TenantSubscriptionStatus> {
  const db = getTenantDb(tenantId);
  const tenant = await db.tenant.findUnique({
    where: { id: tenantId },
    select: { subscriptionStatus: true, expiresAt: true },
  });
  if (!tenant) {
    throw new SubscriptionLockedError(null);
  }
  const effective = getEffectiveTenantStatus(
    { subscriptionStatus: tenant.subscriptionStatus, expiresAt: tenant.expiresAt },
    new Date()
  );
  if (!effective.writable) {
    throw new SubscriptionLockedError(tenant.subscriptionStatus);
  }
  return tenant.subscriptionStatus;
}

/**
 * [T6c] Fresh effective status for callers that need the computed value
 * (sync's per-item D10 rule) rather than just the throw/no-throw gate.
 */
export async function getFreshEffectiveStatus(tenantId: string) {
  const db = getTenantDb(tenantId);
  const tenant = await db.tenant.findUnique({
    where: { id: tenantId },
    select: { subscriptionStatus: true, expiresAt: true },
  });
  if (!tenant) return null;
  return getEffectiveTenantStatus(
    { subscriptionStatus: tenant.subscriptionStatus, expiresAt: tenant.expiresAt },
    new Date()
  );
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
 * [T6c] THE lockout exemption list — one named constant. Routes/pages that
 * must stay reachable when the tenant is locked, so a lapsed merchant can
 * always (a) pay/renew and (b) retrieve their own data:
 *   - billing routes (T6a checkout surface, API + pages)
 *   - /account-locked (the lockout explanation screen itself)
 *   - auth routes (/login, /register, NextAuth internals)
 *   - the data-export surface (T7 item 6: /api/export/* + /settings/export)
 *
 * A merchant whose subscription lapsed can always retrieve their own data
 * and pay. Anything NOT on this list keeps calling assertTenantWritable().
 */
export const SUBSCRIPTION_LOCKOUT_EXEMPT_API_PREFIXES = [
  "/api/billing/subscriptions",
  "/api/billing/status",
  "/api/tenant/status",
  "/api/export",
] as const;

/** Page (non-API) prefixes covered by the same exemption policy. */
export const SUBSCRIPTION_LOCKOUT_EXEMPT_PAGE_PREFIXES = [
  "/settings/billing",
  "/dashboard/settings/billing",
  "/account-locked",
  "/settings/export",
  "/dashboard/settings/export",
  "/login",
  "/register",
] as const;

/**
 * True when `pathname` is exempt from the locked-tenant write/redirect block
 * (API or page). Such routes still require an authenticated session and a
 * fresh isActive user check — exemption is from the SUBSCRIPTION lock only.
 */
export function isLockoutExemptPath(pathname: string): boolean {
  const all = [...SUBSCRIPTION_LOCKOUT_EXEMPT_API_PREFIXES, ...SUBSCRIPTION_LOCKOUT_EXEMPT_PAGE_PREFIXES];
  return all.some(
    (prefix) => pathname === prefix || pathname.startsWith(prefix + "/")
  );
}


