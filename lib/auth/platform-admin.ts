/**
 * lib/auth/platform-admin.ts
 *
 * T6b Phase 1 — Super-Admin (platform) guard.
 *
 * requirePlatformAdmin() reads User.isActive + User.isPlatformAdmin FRESH from
 * the DB on EVERY call and never trusts the JWT/session snapshot: a demoted
 * or deactivated platform admin is rejected on the very next request, and a
 * stale token claiming isPlatformAdmin:true is worthless when the DB says
 * otherwise. A tenant role=ADMIN without isPlatformAdmin can never pass.
 *
 * The lookup goes through getTenantDb(session.user.tenantId) (User IS
 * tenant-scoped), so this file needs no raw-prisma import and no ESLint
 * allow-list entry. The platform tenant owns its super-admin row, so scoping
 * the lookup to the caller's own tenant is exact, not a limitation.
 *
 * PlatformAdminContext is a branded type (unique symbol): lib/db/platform.ts's
 * getPlatformDb(ctx) cannot be called without one, so a missing auth check
 * fails to COMPILE, not just at review time.
 */

import { auth } from "@/auth";
import { getTenantDb } from "@/lib/db/tenant-scope";
import { NextResponse } from "next/server";
import { notFound } from "next/navigation";

const PlatformAdminBrand: unique symbol = Symbol("PlatformAdminContext");

export interface PlatformAdminContext {
    readonly [PlatformAdminBrand]: true;
    readonly userId: string;
    readonly tenantId: string;
}

export class PlatformAdminDeniedError extends Error {
    constructor() {
        super("غير مصرح: هذه الصفحة مخصصة لإدارة المنصة فقط.");
        this.name = "PlatformAdminDeniedError";
    }
}

/**
 * Fresh-DB platform-admin check. Throws PlatformAdminDeniedError when there
 * is no session, the user row is missing/inactive, or isPlatformAdmin is
 * false in the database — regardless of what the JWT claims.
 */
export async function requirePlatformAdmin(): Promise<PlatformAdminContext> {
    const session = await auth();
    if (!session?.user?.id || !session.user.tenantId) {
        throw new PlatformAdminDeniedError();
    }
    const db = getTenantDb(session.user.tenantId);
    const row = await db.user.findFirst({
        where: { id: session.user.id },
        select: { id: true, tenantId: true, isActive: true, isPlatformAdmin: true },
    });
    if (!row || !row.isActive || !row.isPlatformAdmin) {
        throw new PlatformAdminDeniedError();
    }
    return {
        [PlatformAdminBrand]: true as const,
        userId: row.id,
        tenantId: row.tenantId,
    };
}

/** Standard HTTP 403 for the denied error — billing error shape { error, message }. */
export function platformAdminForbiddenResponse(error?: unknown) {
    const message =
        error instanceof PlatformAdminDeniedError
            ? error.message
            : "غير مصرح: هذه الصفحة مخصصة لإدارة المنصة فقط.";
    return NextResponse.json({ error: "FORBIDDEN", message }, { status: 403 });
}

/**
 * Page-level guard for app/(dashboard)/admin/* server components.
 * API routes use requirePlatformAdmin() + platformAdminForbiddenResponse()
 * (403); pages call this and render notFound() when access is DENIED.
 *
 * Only PlatformAdminDeniedError becomes a 404. Any other failure (a database
 * outage, a bug) is rethrown so it surfaces as a real error instead of
 * masquerading as "page not found".
 */
export async function requirePlatformAdminForPage(): Promise<PlatformAdminContext> {
    try {
        return await requirePlatformAdmin();
    } catch (error) {
        if (error instanceof PlatformAdminDeniedError) {
            notFound();
        }
        throw error;
    }
}