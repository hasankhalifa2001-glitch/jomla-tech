// ============================================================================
// PUBLIC DB ENTRY POINT
//
// Two exports:
//   getTenantDb(tenantId) — the tenant-scoped wrapper. Use this for EVERY
//   query/write inside an authenticated, tenant-context request UNLESS your
//   call site falls into one of the documented exceptions below.
//
//   prisma — the raw, UNSCOPED client. Use ONLY in the following,
//   documented categories, each of which has a structural reason it cannot
//   go through getTenantDb():
//
//     1. app/api/auth/register/route.ts — creating the Tenant itself; no
//        tenant exists yet to scope to.
//
//     2. lib/auth.ts's authorize() callback ONLY — looks up a User by email
//        before any session/tenantId exists, same reasoning as register.
//        Every OTHER NextAuth callback (jwt, session), and all other
//        application code, runs after a session already exists and must
//        use getTenantDb(session.user.tenantId) instead — this exception
//        covers exactly one function, not the whole auth module.
//
//     3. seed.ts — dev-only; separately guarded by its own
//        `NODE_ENV === "production"` refusal, never runs against a real
//        tenant's session.
//
//     4. Platform Super-Admin routes gated by `isPlatformAdmin` (T6), which
//        legitimately operate across tenants by design (e.g. the
//        subscription-approval dashboard listing every tenant's pending
//        Subscription rows).
//
//     5. Routes/functions that call a SHARED helper typed to accept exactly
//        `Prisma.TransactionClient` (or the raw `PrismaClient`), where that
//        helper enforces tenant isolation MANUALLY via its own explicit
//        `tenantId` filtering on every internal query — rather than relying
//        on the getTenantDb() Client Extension. This category exists
//        because such a helper is, by construction, shared across two kinds
//        of call site that CANNOT both use the extension:
//          (a) a read-only PREVIEW call made directly with the top-level
//              client (e.g. app/api/inventory/fifo-preview/route.ts calling
//              lib/inventory/fifo.ts's resolveFifoAllocation in its default
//              PREVIEW mode), and
//          (b) a COMMIT-mode call made from inside an interactive
//              `prisma.$transaction(async (tx) => ...)` callback
//              (e.g. app/api/sync/route.ts, T4c), where no getTenantDb()
//              extension is ever applied to `tx` in the first place.
//        getTenantDb(tenantId)'s extended client/`$transaction` callback
//        produces a type (`DynamicClientExtensionThis<...>`) that is NOT
//        structurally assignable to `Prisma.TransactionClient` — passing it
//        into such a helper fails to compile, not just redundant. Current
//        members of this category:
//          - app/api/sync/route.ts (T4c) — see that route's own header
//            comment for the full reasoning and the manual-tenantId
//            discipline it requires on every query/write in the file.
//          - app/api/inventory/fifo-preview/route.ts — PREVIEW-mode calls
//            into resolveFifoAllocation(); tenant isolation for that
//            function comes entirely from its own internal `tenantId`
//            filtering (see fifo.ts), never from which client type is
//            passed to it.
//        A future call site belongs in this category ONLY if it shares a
//        helper with an existing member above under the same structural
//        constraint — not merely because getTenantDb() felt inconvenient.
//
//   Importing `prisma` anywhere else is almost certainly a bug — if you're
//   inside an authenticated request handler outside the five categories
//   above, you should be using getTenantDb(session.user.tenantId) instead.
//
//   [OUTSTANDING] No ESLint rule yet restricts *who* may import `prisma`
//   from this file to the categories above — until one exists, this
//   allowlist is enforced by code review and by the inline
//   `eslint-disable-next-line no-restricted-imports` comment (with
//   reasoning) required at every legitimate import site. Adding a real
//   `no-restricted-imports` rule scoped to this export, configured with
//   this same allowlist, is a launch-blocking item alongside the raw-query
//   and nested-write rules already enforced for lib/db/tenant-scope.ts.
// ============================================================================

export { getTenantDb, tenantScopedRawQuery } from "./db/tenant-scope";
export { rawPrisma as prisma } from "./db/client";