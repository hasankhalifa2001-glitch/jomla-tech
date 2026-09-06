import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  {
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "MemberExpression[property.name=/^(\\$queryRaw|\\$queryRawUnsafe)$/]",
          message:
            "Direct $queryRaw or $queryRawUnsafe calls are forbidden outside lib/db/tenant-scope.ts. Use tenantScopedRawQuery() instead for tenant isolation compliance.",
        },
        {
          // Requires the offending create/update/... Property to be a
          // descendant of a `data` Property specifically — this is what
          // actually matches Prisma's real nested-write shape
          // (`data: { items: { create: [...] } } }`). A selector requiring
          // two directly-nested matching Property keys never occurs in
          // real Prisma syntax (the outer operation is a method call, not
          // an object key) and never fires on any real violation — this
          // descendant-combinator form is the one that actually catches it.
          selector:
            "Property[key.name='data'] Property[key.name=/^(create|createMany|update|updateMany|upsert|set|disconnect)$/]",
          message:
            "Nested create/update/upsert/set/disconnect on tenant-scoped models is forbidden because it bypasses tenant isolation. Perform separate top-level model operations inside a $transaction instead.",
        },
      ],
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@/lib/db",
              importNames: ["prisma"],
              message:
                "Importing the unscoped `prisma` client is restricted. Use getTenantDb(tenantId) inside authenticated request handlers instead. If this really is one of the documented exceptions in lib/db.ts's header comment, either (a) add this file to the whole-file allowlist below if every query in it legitimately needs the raw client, or (b) if only ONE lookup line needs it (e.g. a storefront tenant-by-slug resolution), use an inline `eslint-disable-next-line no-restricted-imports` with a one-line justification at that exact line instead of exempting the whole file.",
            },
            {
              name: "@/lib/db/client",
              message:
                "lib/db/client.ts is internal-only — import getTenantDb from lib/db/tenant-scope.ts, or `prisma`/`getTenantDb` from lib/db.ts, instead of importing this file directly.",
            },
          ],
        },
      ],
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { "argsIgnorePattern": "^_", "varsIgnorePattern": "^_" }
      ],
    },
  },
  {
    // The one sanctioned $queryRaw call site in the whole system (T4c's
    // batch lock, via tenantScopedRawQuery itself). Only the raw-query
    // restriction is lifted here — nested-write is re-declared below
    // because ESLint flat config replaces (does not merge) a rule key when
    // it's set again for a matching file, so omitting it here would
    // silently re-enable nested writes in this file too, which is not the
    // intent.
    files: ["lib/db/tenant-scope.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "Property[key.name='data'] Property[key.name=/^(create|createMany|update|updateMany|upsert|set|disconnect)$/]",
          message:
            "Nested create/update/upsert/set/disconnect on tenant-scoped models is forbidden because it bypasses tenant isolation. Perform separate top-level model operations inside a $transaction instead.",
        },
      ],
    },
  },
  {
    // [FIX] Whole-file `no-restricted-imports` exemptions — restricted to
    // lib/db.ts categories 1–5 ONLY (see that file's header comment). Every
    // file listed here has NO legitimate tenant-scoped-only lines, so
    // exempting the whole file carries no isolation risk.
    //
    // [FIX] Category 6 (the public storefront's tenant-by-slug lookup) is
    // deliberately NOT listed here. `app/(store)/**` and `app/api/store/**`
    // route files contain both the initial no-session slug lookup AND every
    // subsequent tenant-scoped read for that tenant's public catalog —
    // whole-file exemption here would silently allow those catalog reads to
    // skip getTenantDb() too, on a public, unauthenticated, Internet-facing
    // surface where a cross-tenant leak is maximally visible. Storefront
    // code must use an inline `eslint-disable-next-line no-restricted-imports`
    // (with a one-line justification) at the single slug-lookup call site
    // only — see lib/db.ts's header comment, category 6.
    //
    // [FIX] The previous version of this list included `app/api/catalog/**`,
    // which does not correspond to any route in the Master Technical
    // Spec's Arabic App Router Folder Structure — the real B2B order
    // submission endpoint is `app/api/store/orders/route.ts`. Removed as a
    // stale/mistaken path; `app/api/store/**` below covers the real route,
    // subject to the same inline-disable discipline as the rest of the
    // storefront (not a blanket exemption).
    //
    // [FIX] Added `app/api/sync/**` and `app/api/inventory/fifo-preview/**`
    // — lib/db.ts's category 5 names these two routes explicitly as members
    // of the shared-helper exemption (resolveFifoAllocation's
    // Prisma.TransactionClient-typed signature), but they were missing from
    // this list entirely. Without this, T4c's real /api/sync implementation
    // and the FIFO preview endpoint would fail to lint/build the moment
    // they're written, despite being explicitly documented as legitimate.
    files: [
      "app/api/auth/register/**",
      "seed.ts",
      "app/(dashboard)/admin/**",
      "app/api/admin/**",
      "app/api/sync/**",
      "app/api/inventory/fifo-preview/**",
      "app/(store)/**",
      "app/api/catalog/**",
    ],
    rules: {
      "no-restricted-imports": "off",
    },
  },
]);

export default eslintConfig;
