import { getTenantDb } from "@/lib/db";
import { NextResponse } from "next/server";

export class UserInactiveError extends Error {
  readonly userId: string;

  constructor(userId: string) {
    super("تم تعطيل هذا الحساب من قبل إدارة المتجر.");
    this.name = "UserInactiveError";
    this.userId = userId;
  }
}

/**
 * Returns the fresh isActive status for a user directly from the database,
 * scoped to the given tenantId. Never trusted from the JWT session payload,
 * since account deactivation can happen mid-session by an ADMIN.
 *
 * [FIX] Now requires tenantId and goes through getTenantDb(tenantId) instead
 * of importing the raw `prisma` client directly — the raw client is
 * restricted by eslint's no-restricted-imports rule to a small, documented
 * allowlist (see lib/db.ts's header comment), and this file was never
 * added to it. This also closes a real scoping gap: previously, a userId
 * could be looked up with no tenant boundary at all; now the lookup is
 * always constrained to the tenant of the session making the call.
 */
export async function getFreshUserStatus(
  tenantId: string,
  userId: string
): Promise<boolean | null> {
  const db = getTenantDb(tenantId);
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { isActive: true },
  });
  return user?.isActive ?? null;
}

/**
 * Asserts that a user account is currently active (`isActive: true`) by performing
 * a fresh, authoritative database read within the same request lifecycle, scoped
 * to tenantId.
 *
 * This guarantees immediate lockout on the very next mutating request when a user
 * is deactivated, without adding DB overhead to passive session reads or Edge middleware.
 *
 * Throws UserInactiveError if the user is inactive, not found, or belongs to a
 * different tenant than tenantId (the tenant-scoped lookup simply returns null
 * in that case, same as "not found").
 */
export async function assertUserActive(tenantId: string, userId: string): Promise<void> {
  const isActive = await getFreshUserStatus(tenantId, userId);
  if (!isActive) {
    throw new UserInactiveError(userId);
  }
}

/**
 * Standard HTTP 403 response for UserInactiveError.
 */
export function userInactiveResponse(error: UserInactiveError) {
  return NextResponse.json(
    {
      error: "ACCOUNT_DEACTIVATED",
      message: error.message,
    },
    { status: 403 }
  );
}