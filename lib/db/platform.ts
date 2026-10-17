/**
 * lib/db/platform.ts
 *
 * T6b Phase 1 — the ONE narrow cross-tenant gateway in the codebase.
 *
 * getTenantDb() forcibly scopes Subscription reads to the caller's tenant,
 * so the Super-Admin queue (subscriptions across ALL tenants) structurally
 * cannot go through it. This module exposes the raw client ONLY behind a
 * PlatformAdminContext branded value: there is no overload that accepts a
 * plain string/void, so calling it without first awaiting
 * requirePlatformAdmin() fails to compile.
 *
 * RULES:
 *  - Only lib/data/platform-admin.ts may import this file (enforced by the
 *    T6b static scan in lib/data/__tests__/t6b-phase1-platform-rate.test.ts;
 *    the merchant platform-rate reader lib/data/platform-rate.ts is
 *    intentionally NOT migrated — it serves the merchant checkout path).
 *  - Every query through this client carries its tenant scope explicitly in
 *    its own `where` (Tenant by slug platform-internal; Subscription by id
 *    or by explicit tenantId) — never an unfiltered findMany.
 *  - No nested writes; top-level calls inside $transaction only.
 */

import { rawPrisma } from "@/lib/db/client";
import type { PlatformAdminContext } from "@/lib/auth/platform-admin";

/**
 * Returns the raw Prisma client. The ctx parameter is unused at runtime —
 * it exists so the auth check is a compile-time prerequisite.
 */
export function getPlatformDb(_ctx: PlatformAdminContext) {
    void _ctx;
    return rawPrisma;
}

export type PlatformDb = ReturnType<typeof getPlatformDb>;
