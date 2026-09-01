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
          // [FIX] Requires the offending create/update/... Property to be a
          // descendant of a `data` Property specifically — this is what
          // actually matches Prisma's real nested-write shape
          // (`data: { items: { create: [...] } } }`). The previous
          // double-Property selector required two nested matching
          // Property keys, which never occurs in real Prisma syntax
          // (the outer operation is a method call, not an object key) —
          // it never fired on any real violation.
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
                "Importing the unscoped `prisma` client is restricted. Use getTenantDb(tenantId) inside authenticated request handlers instead.",
            },
            {
              name: "@/lib/db/client",
              message:
                "lib/db/client.ts is internal-only — import getTenantDb from lib/db/tenant-scope.ts instead.",
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
    files: [
      "app/api/auth/register/**",
      "seed.ts",
      "app/(dashboard)/admin/**",
      "app/api/admin/**",
      "app/(store)/**",
      "app/api/catalog/**", // [ADD] storefront pages (e.g. [tenantSlug]/page.tsx)
      // run with no session/tenantId — they look up the
      // Tenant by slug via the raw client before any
      // tenant-scoped query is even possible.
    ],
    rules: {
      "no-restricted-imports": "off",
    },
  },
]);

export default eslintConfig;