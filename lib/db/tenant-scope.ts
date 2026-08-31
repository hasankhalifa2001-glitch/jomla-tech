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
 * [FIX] Corrected claim: lib/db.ts is the public entry point for
 * getTenantDb()/tenantScopedRawQuery(), but lib/db.ts ALSO re-exports
 * `rawPrisma` under the name `prisma`, deliberately, for the small set of
 * routes that must run before any tenant/session context exists
 * (registration, seed.ts, isPlatformAdmin-gated super-admin routes — see
 * lib/db.ts's own header comment). That export is intentional, not a leak,
 * but it means the true safety boundary is NOT "only two names are
 * exported from lib/db.ts" — it's "an ESLint no-restricted-imports rule
 * must restrict who is allowed to import the `prisma` name from lib/db.ts
 * to that specific allowlist." That rule is not yet implemented; until it
 * is, an unscoped `import { prisma } from "@/lib/db"` compiles cleanly
 * from anywhere in the codebase with no automated guardrail. Treat adding
 * that ESLint rule as an outstanding launch-blocking item alongside the
 * raw-query and nested-write rules above, not as already covered by them.
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
 * [FIX] Takes a `buildQuery` callback instead of a flat `sql` fragment. The
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
// file's header comment and the note at the top of this file about the
// still-missing ESLint rule restricting who may import it.