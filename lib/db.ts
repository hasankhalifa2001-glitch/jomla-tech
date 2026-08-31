// ============================================================================
// PUBLIC DB ENTRY POINT...
//
// Two exports:
//   getTenantDb(tenantId) — the tenant-scoped wrapper. Use this for EVERY
//   query/write inside an authenticated, tenant-context request.
//
//   prisma — the raw, UNSCOPED client. Use ONLY in the small set of routes
//   that legitimately run before any tenant/session context exists:
//     - app/api/auth/register/route.ts (creating the Tenant itself)
//     - seed.ts
//     - platform Super-Admin routes gated by isPlatformAdmin (T6), which
//       operate across tenants by design.
//   Importing `prisma` anywhere else is almost certainly a bug — if you're
//   inside an authenticated request handler, you should be using
//   getTenantDb(session.tenantId) instead.
// ============================================================================

export { getTenantDb, tenantScopedRawQuery } from "./db/tenant-scope";
export { rawPrisma as prisma } from "./db/client";