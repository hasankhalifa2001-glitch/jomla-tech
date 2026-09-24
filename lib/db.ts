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
//        tenant's session. Imports the SAME `prisma` re-exported from this
//        file (not a separate `new PrismaClient()`), so it shares this
//        client's singleton/logging configuration like every other
//        legitimate consumer of the raw client.
//
//     4. Platform Super-Admin routes gated by `isPlatformAdmin` (T6), which
//        legitimately operate across tenants by design (e.g. the
//        subscription-approval dashboard listing every tenant's pending
//        Subscription rows).
//
//     5. Routes/functions that call a SHARED helper typed to accept exactly
//        `Prisma.TransactionClient` (like commitFifoAllocation) where that
//        helper enforces tenant isolation MANUALLY via its own explicit
//        `tenantId` filtering on every internal query — rather than relying
//        on the getTenantDb() Client Extension.
//        getTenantDb(tenantId)'s extended client/`$transaction` callback
//        produces a type (`DynamicClientExtensionThis<...>`) that is NOT
//        structurally assignable to `Prisma.TransactionClient` — passing it
//        into such a helper fails to compile, not just redundant. Current
//        members of this category (also whole-file exempted in
//        eslint.config.mjs's no-restricted-imports override, since every
//        query in these files legitimately needs the raw/transaction
//        client, not just one lookup line):
//          - app/api/sync/route.ts (T4c) — see that route's own header
//            comment for the full reasoning and the manual-tenantId
//            discipline it requires on every query/write in the file.
//          - app/api/orders/[id]/status/route.ts (T5) — the B2B order
//            approval path, which must lock batches via
//            lockBatchesForFifoAllocations() and allocate via
//            commitFifoAllocation() inside the same transaction that claims
//            the order row. Same manual-tenantId discipline: every query in
//            that file carries tenantId explicitly in its own `where`.
//          - lib/inventory/fifo.ts — commitFifoAllocation() accepts
//            exactly Prisma.TransactionClient as its required first
//            parameter, shared with app/api/sync/route.ts's (T4c) and
//            T5's B2B-approval transaction context; tenant isolation for
//            that function comes entirely from its own explicit
//            `tenantId` filtering on every query, never from the client
//            type it's handed. [CORRECTED] previewFifoAllocation() in the
//            same file does NOT belong in this exception category — it
//            takes no `tx` parameter at all and uses getTenantDb(tenantId)
//            like any other ordinary read-only call site in the codebase.
//            An earlier revision of this comment incorrectly stated that
//            previewFifoAllocation() also read via the raw prisma client;
//            that was true of an earlier draft of fifo.ts, before it was
//            corrected to use getTenantDb() and this comment was not
//            updated to match at the time. Only commitFifoAllocation()
//            requires the raw/transaction client.
//        A future call site belongs in this category ONLY if it shares a
//        helper with an existing member above under the same structural
//        constraint — not merely because getTenantDb() felt inconvenient.
//
//     6. [ADDED] The public storefront's initial tenant-by-slug lookup ONLY
//        — app/(store)/[tenantSlug]/**'s and app/api/store/**'s very first
//        query, resolving the incoming `tenantSlug` route param to a real
//        Tenant row (and, for orders, that lookup's immediate use to attach
//        the correct tenantId to the new B2BOrderRequest). Same structural
//        reasoning as category 1 (register): a public visitor arrives with
//        no session and no tenantId — the slug IS the only identifier
//        available, and resolving it is necessarily an unscoped lookup by
//        definition.
//
//        UNLIKE categories 1–5, this is deliberately NOT a whole-file
//        exemption in eslint.config.mjs. A storefront route file also
//        contains every subsequent query for that tenant's public
//        Products/ProductUnits/ProductBatches — and those queries, once the
//        tenantId is known, MUST go through getTenantDb(tenantId) like any
//        other tenant-scoped read. This is a public, unauthenticated,
//        Internet-facing surface where a cross-tenant data leak (one
//        merchant's competitor seeing their storefront's soon-to-be-fixed
//        query accidentally return another tenant's rows) is maximally
//        visible and maximally embarrassing — so only the single slug
//        lookup line is exempted, via an inline
//        `eslint-disable-next-line no-restricted-imports` comment with a
//        one-line justification, at that exact call site. Every other line
//        in the same file is linted normally and must use getTenantDb().
//
//   Importing `prisma` anywhere else is almost certainly a bug — if you're
//   inside an authenticated request handler outside the six categories
//   above, you should be using getTenantDb(session.user.tenantId) instead.
//
//   ENFORCEMENT: a `no-restricted-imports` ESLint rule restricts *who* may
//   import `prisma` from this file — see eslint.config.mjs. Categories 1–5
//   above are whole-file exemptions in that config (their files have no
//   legitimate tenant-scoped-only lines). Category 6 is NOT a file
//   exemption — it relies on the inline-disable-plus-justification
//   convention instead, exactly as this header used to describe as an
//   "outstanding" idea before the rule existed; now that the rule is real,
//   this is the one category that still depends on that per-line discipline
//   rather than a config-level allowlist, precisely because it's the one
//   category where a whole-file exemption would be unsafe.
// ============================================================================

export { getTenantDb, tenantScopedRawQuery } from "./db/tenant-scope";
export { rawPrisma as prisma } from "./db/client";