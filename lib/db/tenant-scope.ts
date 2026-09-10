/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * ============================================================================
 * TENANT ISOLATION ARCHITECTURE & PROJECT-WIDE RULES
 * ============================================================================
 *
 * 1. RAW QUERIES:
 * Direct `$queryRaw` or `$queryRawUnsafe` calls are forbidden outside this file.
 * Any raw SQL query must use `tenantScopedRawQuery()` below, which strictly
 * requires `tenantId` at the type level.
 *
 * [FIX] `tenantScopedRawQuery` no longer appends `AND "tenantId" = $1` blindly
 * to the end of whatever SQL it's given. The one sanctioned call site in this
 * system (T4c's batch lock) has the shape:
 *   SELECT ... WHERE id = ANY($1) ORDER BY id ASC FOR UPDATE
 * Appending `AND "tenantId" = $1` after `ORDER BY ... FOR UPDATE` is not
 * syntactically valid SQL — the previous version of this function could
 * never actually be used for the query it was written for. It now takes a
 * builder callback that receives a pre-built `Prisma.Sql` tenant condition
 * fragment, so the caller places it correctly inside their own WHERE clause
 * instead of it being force-appended at the end.
 *
 * 2. NESTED WRITES BANNED ON TENANT-SCOPED MODELS:
 * Prisma Client Extensions intercept top-level model operations (e.g., `prisma.invoice.create(...)`)
 * but do NOT intercept nested writes buried inside another model's `data` payload
 * (e.g., `prisma.invoice.create({ data: { items: { create: [...] } } })`).
 * Nested writes bypass extension tenantId injection entirely.
 *
 * RULE:
 * NO nested create/update/upsert/set/disconnect targeting a tenant-scoped model,
 * anywhere in the codebase. Every write to a tenant-scoped model must be its own
 * top-level `prisma.model.<method>(...)` call, executed inside the same `$transaction`
 * as related writes it must stay atomic with.
 *
 * Enforced by ESLint via `no-restricted-syntax`. CI fails the build on violation.
 *
 * 3. THE RAW CLIENT IS NEVER RE-EXPORTED FROM THIS FILE:
 * `rawPrisma` (imported below from lib/db/client.ts) is used internally to build
 * the extended client and nowhere else. This file must never re-export it under
 * any name (including `prisma`) — doing so hands out an unscoped client to any
 * caller and defeats every guarantee below.
 *
 * lib/db.ts is the public entry point for getTenantDb()/tenantScopedRawQuery(),
 * and it ALSO re-exports `rawPrisma` under the name `prisma`, deliberately, for
 * the small, documented allowlist of call sites that must run before any
 * tenant/session context exists (registration, seed.ts, isPlatformAdmin-gated
 * super-admin routes, the T4c/fifo-preview shared-helper category, and the
 * narrow storefront tenant-by-slug lookup — see lib/db.ts's own header
 * comment for the full, current allowlist). That export is intentional, not
 * a leak — the actual safety boundary is the `no-restricted-imports` ESLint
 * rule (see eslint.config.mjs) restricting who is allowed to import the
 * `prisma` name from lib/db.ts to that specific allowlist, plus required
 * inline `eslint-disable-next-line` justification comments at any one-off
 * exemption site that isn't a whole-file exemption (see eslint.config.mjs's
 * notes on the storefront category specifically).
 *
 * 4. TENANT_SCOPED_MODELS MUST STAY IN SYNC WITH schema.prisma:
 * [FIX] Every model in schema.prisma that carries a denormalized tenantId
 * column and a `Tenant` relation is tenant-scoped and MUST appear in the set
 * below. This previously omitted the three models added in schema.prisma
 * v3.7 — B2BOrderRequest, B2BOrderRequestItem, and CustomerMergeLog — which
 * silently meant getTenantDb() never injected tenantId into any query
 * against them: a call site that forgot to filter by tenantId manually on
 * one of these three models would have executed completely unscoped, with
 * no error, no warning, nothing. This directly violated T1's own acceptance
 * criterion: "Every tenant-scoped Prisma model — including B2BOrderRequest,
 * B2BOrderRequestItem, and CustomerMergeLog — is covered by the tenant-scope
 * extension; a query missing tenant context throws rather than executing
 * unscoped." All three are now included below.
 *
 * [FIX — this revision] The exact same silent gap existed for the two
 * models schema.prisma's v3.9 revision added for T3c — StockAdjustment and
 * BatchDeletionLog. Both carry a denormalized tenantId and a Tenant
 * relation just like every other model in this set, and T1's Tenant
 * Isolation acceptance criteria explicitly name them as carrying "no
 * special exemption from anything." Before this fix, a call site writing
 * `prisma.stockAdjustment.create(...)` or `prisma.batchDeletionLog.create(...)`
 * through getTenantDb() would NOT have had tenantId auto-injected — the
 * write would only be tenant-safe if every call site remembered to pass
 * tenantId manually, which is precisely the failure mode this whole
 * extension exists to eliminate. Both are now included below.
 *
 * Deliberately NOT in this set (correct, not an oversight):
 *   - Tenant itself — it IS the scope, not scoped by it.
 *   - VerifiedRetailer, ProductCatalogEntry, ProductCatalogEntryReport —
 *     platform-wide models with no tenantId column at all (see their
 *     model-level notes in schema.prisma for why).
 * ============================================================================
 */

import { Prisma, PrismaClient } from "@prisma/client";
import { rawPrisma } from "./client";

export const TENANT_SCOPED_MODELS = new Set([
  "User",
  "Product",
  "ProductUnit",
  "ProductBatch",
  "Customer",
  "Invoice",
  "InvoiceItem",
  "CustomerPayment",
  "Subscription",
  // v3.7 additions — see the file-header note above.
  "B2BOrderRequest",
  "B2BOrderRequestItem",
  "CustomerMergeLog",
  // [FIX] v3.9 additions (T3c) — see the file-header note above.
  "StockAdjustment",
  "BatchDeletionLog",
]);

// Operations that read/target existing rows and must be scoped via `where`.
const WHERE_SCOPED_READ_OPS = new Set([
  "findMany",
  "findFirst",
  "findFirstOrThrow",
  "findUnique",
  "findUniqueOrThrow",
  "count",
  "aggregate",
  "groupBy",
]);

// Operations that target existing rows for a write and must be scoped via
// `where`, with `data.tenantId` (if present) stripped so a caller can never
// reassign a row to a different tenant through the payload.
const WHERE_SCOPED_WRITE_OPS = new Set([
  "update",
  "updateMany",
  "delete",
  "deleteMany",
]);

/**
 * Executes a tenant-isolated raw query.
 *
 * Takes a `buildQuery` callback instead of a flat `sql` fragment. The
 * caller receives a ready-made `tenantCondition` fragment (`"tenantId" = $1`)
 * and is responsible for placing it correctly inside their own WHERE clause
 * — this function can't safely guess where in an arbitrary query a bolted-on
 * `AND` belongs (before ORDER BY / FOR UPDATE, inside a subquery, etc.), and
 * guessing wrong produces invalid SQL rather than an isolation gap, which is
 * at least fail-loud — but "always fails" is still wrong. This shape is
 * fail-loud AND correct: the type signature forces every call site to
 * consciously place the condition, and tenantId itself is still required at
 * the type level, so a call site that forgets to use the fragment at all
 * simply won't compile against a query with no matching placeholder logic.
 *
 * Column name is `"tenantId"` (double-quoted, camelCase) — this schema has
 * no @map/@@map, so Postgres's actual column name is camelCase and folds to
 * lowercase (and fails to be found) unless quoted.
 */
export async function tenantScopedRawQuery<T>(
  tx: Prisma.TransactionClient,
  tenantId: string,
  buildQuery: (tenantCondition: Prisma.Sql) => Prisma.Sql
): Promise<T> {
  if (!tenantId || typeof tenantId !== "string" || !tenantId.trim()) {
    throw new Error("Tenant isolation error: tenantId is required for raw query execution.");
  }
  const tenantCondition = Prisma.sql`"tenantId" = ${tenantId}`;
  return tx.$queryRaw<T>(buildQuery(tenantCondition));
}

/**
 * Returns a tenant-scoped Prisma client instance using Prisma Client Extensions.
 * Automatically injects `tenantId` into queries on tenant-scoped models and
 * throws if tenantId context is missing or invalid.
 */
export function getTenantDb(tenantId: string, client: PrismaClient = rawPrisma) {
  if (!tenantId || typeof tenantId !== "string" || !tenantId.trim()) {
    throw new Error("Tenant isolation error: tenantId context is missing or invalid.");
  }

  return client.$extends({
    query: {
      $allModels: {
        // `args` is typed by Prisma as a union of every operation's args
        // shape across every model — TypeScript has no way to narrow that
        // union to "the variant that has `where`" just because we checked
        // `operation === "findMany"` at runtime. Treated as `any` inside
        // this callback specifically; shape safety comes from the
        // `operation` string checks below, not the static type.
        async $allOperations({ model, operation, args, query }: {
          model?: string;
          operation: string;
          args: any;
          query: (args: any) => Promise<any>;
        }) {
          if (model && TENANT_SCOPED_MODELS.has(model)) {
            if (WHERE_SCOPED_READ_OPS.has(operation)) {
              args.where = { ...(args?.where || {}), tenantId };
            } else if (operation === "create") {
              args.data = { ...(args?.data || {}), tenantId };
            } else if (operation === "createMany") {
              // Prisma's createMany always takes an array for `data` — no
              // single-object branch exists in the real input type, so
              // only that shape is handled here.
              args.data = (args.data as Record<string, unknown>[]).map((item) => ({
                ...item,
                tenantId,
              }));
            } else if (operation === "upsert") {
              // `where` so the lookup can't match another tenant's row,
              // `create` so a genuinely new row lands on the right tenant,
              // and any caller-supplied tenantId is stripped out of
              // `update` so an existing row can never be reassigned.
              args.where = { ...(args?.where || {}), tenantId };
              args.create = { ...(args?.create || {}), tenantId };
              if (args.update && typeof args.update === "object" && "tenantId" in args.update) {
                const { tenantId: _ignored, ...restUpdate } = args.update as Record<string, unknown>;
                args.update = restUpdate;
              }
            } else if (WHERE_SCOPED_WRITE_OPS.has(operation)) {
              args.where = { ...(args?.where || {}), tenantId };
              // Strip any caller-supplied tenantId from the update payload
              // itself — `where` scoping prevents targeting another
              // tenant's row to begin with, but this closes the same class
              // of gap defensively for update/updateMany's `data` payload.
              if (
                (operation === "update" || operation === "updateMany") &&
                args.data &&
                typeof args.data === "object" &&
                "tenantId" in args.data
              ) {
                const { tenantId: _ignored, ...restData } = args.data as Record<string, unknown>;
                args.data = restData;
              }
            }
          }
          return query(args);
        },
      },
    },
  });
}

// The raw client is deliberately NOT re-exported from this file under any
// name. lib/db.ts is the file that intentionally re-exports rawPrisma as
// `prisma` for a specific, documented allowlist of call sites — see that
// file's header comment.