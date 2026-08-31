import { PrismaClient } from "@prisma/client";

// ============================================================================
// INTERNAL ONLY — do not import this file from anywhere except
// lib/db/tenant-scope.ts. This is the raw, unscoped PrismaClient instance
// with no tenant isolation applied. tenant-scope.ts wraps it (via
// $extends) into the tenant-aware client that every route/server action
// must actually use — see lib/db.ts, the only public entry point.
//
// This file exists separately from lib/db.ts specifically so the raw
// client is never part of the public API surface: lib/db.ts re-exports
// only getTenantDb()/tenantScopedRawQuery(), never this module's default
// export. Importing straight from here bypasses every tenant-isolation
// guarantee documented in schema.prisma's Tenant Isolation note — treat
// an import of this file from outside tenant-scope.ts as a bug, and add
// it to the same ESLint no-restricted-imports rule that already blocks
// stray $queryRaw calls (see tenant-scope.ts's header comment).
// ============================================================================

const globalForPrisma = globalThis as unknown as {
    rawPrisma: PrismaClient | undefined;
};

export const rawPrisma =
    globalForPrisma.rawPrisma ??
    new PrismaClient({
        log:
            process.env.NODE_ENV === "development"
                ? ["query", "error", "warn"]
                : ["error"],
    });

if (process.env.NODE_ENV !== "production") {
    globalForPrisma.rawPrisma = rawPrisma;
}