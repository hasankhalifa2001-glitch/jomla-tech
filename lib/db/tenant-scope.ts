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
 * 2. NESTED WRITES BANNED ON TENANT-SCOPED MODELS:
 * Prisma Client Extensions intercept top-level model operations but do NOT
 * intercept nested writes buried inside another model's `data` payload.
 * Nested writes bypass extension tenantId injection entirely.
 *
 * RULE: NO nested create/update/upsert/set/disconnect targeting a
 * tenant-scoped model, anywhere in the codebase. Every write to a
 * tenant-scoped model must be its own top-level `prisma.model.<method>(...)`
 * call, executed inside the same `$transaction` as related writes it must
 * stay atomic with. Enforced by ESLint via `no-restricted-syntax`.
 *
 * 3. THE RAW CLIENT IS NEVER RE-EXPORTED FROM THIS FILE.
 * lib/db.ts is the public entry point that re-exports `rawPrisma` as
 * `prisma` for a small, documented allowlist of call sites.
 *
 * 4. TENANT_SCOPED_MODELS MUST STAY IN SYNC WITH schema.prisma:
 * Every model in schema.prisma that carries a denormalized tenantId column
 * and a `Tenant` relation is tenant-scoped and MUST appear in the set below.
 *
 * History of this exact gap recurring (do not let it happen a fourth time —
 * see the CI recommendation at the bottom of this file):
 *   - v3.7 omitted B2BOrderRequest, B2BOrderRequestItem, CustomerMergeLog.
 *   - v3.9 omitted StockAdjustment, BatchDeletionLog.
 *   - v4.0 omitted BaseUnitChangeLog — [FIX, this revision] now included.
 * Each omission meant getTenantDb() never injected tenantId into queries
 * against that model: a call site that forgot to filter by tenantId
 * manually would have executed completely unscoped, with no error, no
 * warning, nothing.
 *
 * Deliberately NOT in this set (correct, not an oversight):
 *   - Tenant itself — it IS the scope, not scoped by it.
 *   - VerifiedRetailer, ProductCatalogEntry, ProductCatalogEntryReport —
 *     platform-wide models with no tenantId column at all.
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
  "B2BOrderRequest",
  "B2BOrderRequestItem",
  "CustomerMergeLog",
  "StockAdjustment",
  "BatchDeletionLog",
  // [FIX] v4.0 addition — see the file-header history note above. Same
  // shape (tenantId + Tenant relation) as StockAdjustment/BatchDeletionLog.
  "BaseUnitChangeLog",
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
 * and is responsible for placing it correctly inside their own WHERE clause.
 *
 * Column name is `"tenantId"` (double-quoted, camelCase) — this schema has
 * no @map/@@map, so Postgres's actual column name is camelCase and folds to
 * lowercase (and fails to be found) unless quoted.
 */
export async function tenantScopedRawQuery<T>(
  tx: TxOrClient,
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
        async $allOperations({ model, operation, args, query }: {
          model?: string;
          operation: string;
          args: any;
          query: (args: any) => Promise<any>;
        }) {
          // [FIX] `args` can be undefined for a call with no arguments at
          // all (e.g. db.product.findMany()) — the `args.where = ...`
          // writes below would previously throw
          // "Cannot set properties of undefined" in that case.
          args = args ?? {};

          if (model && TENANT_SCOPED_MODELS.has(model)) {
            if (WHERE_SCOPED_READ_OPS.has(operation)) {
              args.where = { ...(args?.where || {}), tenantId };
            } else if (operation === "create") {
              args.data = { ...(args?.data || {}), tenantId };
            } else if (operation === "createMany") {
              args.data = (args.data as Record<string, unknown>[]).map((item) => ({
                ...item,
                tenantId,
              }));
            } else if (operation === "upsert") {
              args.where = { ...(args?.where || {}), tenantId };
              args.create = { ...(args?.create || {}), tenantId };
              if (args.update && typeof args.update === "object" && "tenantId" in args.update) {
                const { tenantId: _ignored, ...restUpdate } = args.update as Record<string, unknown>;
                args.update = restUpdate;
              }
            } else if (WHERE_SCOPED_WRITE_OPS.has(operation)) {
              args.where = { ...(args?.where || {}), tenantId };
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

// ============================================================================
// [NEW] Shared transaction/client types, exported from the single place
// that actually knows getTenantDb()'s real return type.
//
// WHY THIS LIVES HERE, NOT IN lib/inventory/base-unit.ts (where it used to
// be defined): getTenantDb() returns an EXTENDED client (via $extends()
// above). Calling `.$transaction(async (tx) => ...)` on an extended client
// returns a `tx` whose type is NOT structurally identical to
// `Prisma.TransactionClient` — the extended client's model methods use a
// different (Exact<...> vs SelectSubset<...>) generic signature. Any
// function previously typed to accept `Prisma.TransactionClient` fails to
// compile against the real `tx` this codebase actually produces, since
// every $transaction() call in this system goes through getTenantDb(),
// never a raw, unextended PrismaClient.
//
// `TenantTransactionClient` is derived directly from getTenantDb's own
// `$transaction` signature instead of being guessed/hand-written, so it
// can never drift out of sync with the real extended-client type.
// ============================================================================

export type TenantDb = ReturnType<typeof getTenantDb>;

/**
 * The real type of `tx` inside `tenantDb.$transaction(async (tx) => ...)`.
 * Use this — never `Prisma.TransactionClient` — for any function that must
 * be invoked inside a real transaction (multi-write atomicity).
 */
export type TenantTransactionClient =
  Parameters<Parameters<TenantDb["$transaction"]>[0]>[0];

/**
 * For read-only or single-top-level-write helpers that may be called
 * either with a real transaction client OR the plain tenant-scoped client
 * returned by getTenantDb() directly (no transaction needed).
 *
 * [FIX] Widened to also include the RAW, unextended `Prisma.TransactionClient`.
 * A handful of functions in this codebase — most notably
 * lib/inventory/base-unit.ts's requireBaseUnit()/requireBaseUnits() — never
 * rely on the getTenantDb() Client Extension for their own tenant
 * isolation; they filter by `tenantId` explicitly in every query's own
 * `where` clause, the same manual-filtering discipline lib/db.ts's
 * category-5 exception (commitFifoAllocation, app/api/sync/route.ts)
 * documents. That makes these functions structurally safe to call with
 * EITHER client shape — but requireBaseUnit() is called from BOTH sides:
 * from ordinary tenant-scoped write helpers (lib/data/products.ts,
 * running inside a getTenantDb()-derived transaction) AND from
 * lib/inventory/fifo.ts's commitFifoAllocation(), which is deliberately
 * pinned to the raw `Prisma.TransactionClient` (lib/db.ts's category-5
 * exception) because it's shared across T4c's sync engine and T5's B2B
 * approval transaction contexts. Without this widening, TypeScript
 * correctly but unhelpfully rejected passing a raw `Prisma.TransactionClient`
 * into a `TxOrClient` parameter — even though the underlying `tx.model.*`
 * calls are runtime-identical in shape between the raw and extended
 * client. Adding `Prisma.TransactionClient` to this union closes that
 * compile error without loosening any actual isolation guarantee: a
 * caller passing the raw client into a `TxOrClient` function is exactly
 * as safe as calling it with the extended client, since none of these
 * functions depend on the extension's auto-injection to begin with.
 *
 * Do NOT use this reasoning to widen a function that DOES rely on the
 * extension's auto-injection (i.e. one that omits `tenantId` from its own
 * `where`/`data` and trusts getTenantDb() to have added it) — those
 * functions must stay pinned to `TenantTransactionClient | TenantDb` only,
 * since a raw `Prisma.TransactionClient` would silently skip that
 * injection and produce an unscoped query.
 */
export type TxOrClient = TenantTransactionClient | TenantDb | Prisma.TransactionClient;

// The raw client is deliberately NOT re-exported from this file under any
// name. lib/db.ts is the file that intentionally re-exports rawPrisma as
// `prisma` for a specific, documented allowlist of call sites — see that
// file's header comment.

// ============================================================================
// [RECOMMENDATION — not yet enforced] This exact "a new tenant-scoped model
// shipped in schema.prisma but was never added to TENANT_SCOPED_MODELS" gap
// has now recurred three times (v3.7, v3.9, v4.0). Consider adding a CI
// check (not a runtime one) that parses schema.prisma for every model with
// a `tenantId` field + `Tenant` relation and asserts TENANT_SCOPED_MODELS
// contains exactly that set — so the next new model fails the build
// automatically instead of depending on someone remembering this file.
// ============================================================================