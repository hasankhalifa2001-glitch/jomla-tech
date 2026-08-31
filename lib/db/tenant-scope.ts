/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * ============================================================================
 * TENANT ISOLATION ARCHITECTURE & PROJECT-WIDE RULES
 * ============================================================================
 *
 * 1. RAW QUERIES:
 * Direct `$queryRaw` or `$queryRawUnsafe` calls are forbidden outside this file.
 * Any raw SQL query must use `tenantScopedRawQuery()` below, which strictly
 * requires `tenantId` at the type level and appends `AND "tenantId" = ${tenantId}`.
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
 * caller and defeats every guarantee below. lib/db.ts is the only public entry
 * point, and it exports getTenantDb()/tenantScopedRawQuery() only.
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
// [FIX] findUniqueOrThrow / findFirstOrThrow were missing — both are direct,
// commonly-used siblings of findUnique/findFirst and were previously
// completely unscoped.
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
 * Required by v3.3 isolation spec: raw SQL queries must explicitly pass tenantId.
 *
 * [FIX] Column name corrected from `tenant_id` to `"tenantId"` — this schema
 * has no @map/@@map, so Postgres's actual column name is camelCase and must
 * be double-quoted or Postgres folds it to lowercase and the query fails to
 * find the column at all.
 */
export async function tenantScopedRawQuery<T>(
  tx: Prisma.TransactionClient,
  tenantId: string,
  sql: Prisma.Sql
): Promise<T> {
  if (!tenantId || typeof tenantId !== "string" || !tenantId.trim()) {
    throw new Error("Tenant isolation error: tenantId is required for raw query execution.");
  }
  return tx.$queryRaw<T>`${sql} AND "tenantId" = ${tenantId}`;
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
        // [FIX] `args` is typed by Prisma as a union of every operation's
        // args shape across every model (200+ variants) — TypeScript has
        // no way to narrow that union to "the variant that has `where`"
        // just because we checked `operation === "findMany"` at runtime;
        // the check and the type system aren't linked. Prisma's own
        // extension examples handle this the same way: treat `args` as
        // `any` inside this callback specifically, since the actual shape
        // safety here comes from the `operation` string checks below, not
        // from the (structurally uncheckable) static type. This does not
        // weaken tenant isolation itself — it only affects whether the
        // compiler double-checks a shape that runtime logic already
        // enforces correctly.
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
              if (Array.isArray(args.data)) {
                args.data = args.data.map((item: Record<string, unknown>) => ({
                  ...item,
                  tenantId,
                }));
              } else if (args.data) {
                args.data = { ...(args.data || {}), tenantId };
              }
            } else if (operation === "upsert") {
              // [FIX] `upsert` was previously not intercepted at all — every
              // idempotent lookup-by-offlineId pattern this schema is built
              // around (Customer.offlineId, Invoice.offlineId,
              // CustomerPayment.offlineId) is exactly the shape that tempts
              // a caller to reach for upsert instead of findUnique+create.
              // Scope both halves: `where` so the lookup can't match another
              // tenant's row, `create` so a genuinely new row lands on the
              // right tenant, and strip any caller-supplied tenantId out of
              // `update` so an existing row can never be reassigned.
              args.where = { ...(args?.where || {}), tenantId };
              args.create = { ...(args?.create || {}), tenantId };
              if (args.update) {
                const { tenantId: _ignored, ...restUpdate } = args.update as Record<
                  string,
                  unknown
                >;
                args.update = restUpdate;
              }
            } else if (WHERE_SCOPED_WRITE_OPS.has(operation)) {
              args.where = { ...(args?.where || {}), tenantId };
              // [FIX] Strip any caller-supplied tenantId from the update
              // payload itself — previously only `where` was scoped, so
              // `update({ where: {...}, data: { tenantId: 'other-tenant' } })`
              // could silently move a row to a different tenant. `where`
              // scoping prevents targeting another tenant's row to begin
              // with, but this closes the same class of gap defensively for
              // update/updateMany's `data` payload.
              if (
                (operation === "update" || operation === "updateMany") &&
                args.data &&
                typeof args.data === "object" &&
                "tenantId" in args.data
              ) {
                const { tenantId: _ignored, ...restData } = args.data as Record<
                  string,
                  unknown
                >;
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

// [FIX] The raw client is deliberately NOT re-exported from this file under
// any name. `lib/db.ts` (the only public entry point) exports getTenantDb()
// and tenantScopedRawQuery() exclusively — see the file-header note above.