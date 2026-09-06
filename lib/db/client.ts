import { PrismaClient } from "@prisma/client";

// ============================================================================
// INTERNAL ONLY.
//
// [FIX] Corrected allowlist: this file may be imported from exactly TWO
// places — lib/db/tenant-scope.ts (which wraps this raw client via
// `$extends` into the tenant-aware client) AND lib/db.ts (the public entry
// point, which intentionally re-exports this module's `rawPrisma` under the
// name `prisma` for its own documented, narrow allowlist of call sites —
// see lib/db.ts's own header comment for the full list and reasoning).
// The previous version of this comment said "do not import this file from
// anywhere except lib/db/tenant-scope.ts," which was already inaccurate the
// moment lib/db.ts was written to re-export `rawPrisma as prisma` directly
// from here — that import is intentional and documented, not a bug, but the
// stale comment made it look like an unreviewed violation of this file's
// own rule. Any import of this file from a THIRD location (i.e. anywhere
// other than these two) is a real bug: it bypasses both this file's
// isolation boundary and lib/db.ts's own allowlist enforcement in one step.
//
// This file exists separately from lib/db.ts specifically so the raw
// client is never part of the public API surface on its own: nothing
// downstream of tenant-scope.ts/lib/db.ts ever imports straight from here.
// Importing from here outside the two files above bypasses every
// tenant-isolation guarantee documented in schema.prisma's Tenant Isolation
// note — this import restriction is enforced by the `no-restricted-imports`
// ESLint rule targeting "@/lib/db/client" (see eslint.config.mjs), the same
// mechanism that blocks stray $queryRaw calls.
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