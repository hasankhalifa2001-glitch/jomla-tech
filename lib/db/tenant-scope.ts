/**
 * ============================================================================
 * TENANT ISOLATION ARCHITECTURE & PROJECT-WIDE RULES
 * ============================================================================
 *
 * 1. RAW QUERIES:
 * Direct `$queryRaw` or `$queryRawUnsafe` calls are forbidden outside this file.
 * Any raw SQL query must use `tenantScopedRawQuery()` below, which strictly
 * requires `tenantId` at the type level and appends `AND tenant_id = ${tenantId}`.
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
 * ============================================================================
 */

import { Prisma, PrismaClient } from "@prisma/client";
import { prisma as basePrisma } from "../db";

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

/**
 * Executes a tenant-isolated raw query.
 * Required by v3.3 isolation spec: raw SQL queries must explicitly pass tenantId.
 */
export async function tenantScopedRawQuery<T>(
  tx: Prisma.TransactionClient,
  tenantId: string,
  sql: Prisma.Sql
): Promise<T> {
  if (!tenantId || typeof tenantId !== "string" || !tenantId.trim()) {
    throw new Error("Tenant isolation error: tenantId is required for raw query execution.");
  }
  return tx.$queryRaw<T>`${sql} AND tenant_id = ${tenantId}`;
}

/**
 * Returns a tenant-scoped Prisma client instance using Prisma Client Extensions.
 * Automatically injects `tenantId` into queries on tenant-scoped models and throws if tenantId is missing.
 */
export function getTenantDb(tenantId: string, client: PrismaClient = basePrisma) {
  if (!tenantId || typeof tenantId !== "string" || !tenantId.trim()) {
    throw new Error("Tenant isolation error: tenantId context is missing or invalid.");
  }

  return client.$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          if (model && TENANT_SCOPED_MODELS.has(model)) {
            if (
              operation === "findMany" ||
              operation === "findFirst" ||
              operation === "findUnique" ||
              operation === "count" ||
              operation === "aggregate" ||
              operation === "groupBy"
            ) {
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
            } else if (
              operation === "update" ||
              operation === "updateMany" ||
              operation === "delete" ||
              operation === "deleteMany"
            ) {
              args.where = { ...(args?.where || {}), tenantId };
            }
          }
          return query(args);
        },
      },
    },
  });
}

export { basePrisma as prisma };

