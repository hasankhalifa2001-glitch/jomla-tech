import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
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
          selector:
            "Property[key.name=/^(create|update|upsert)$/] Property[key.name=/^(create|createMany|update|updateMany|upsert|set|disconnect)$/]",
          message:
            "Nested create/update/upsert/set/disconnect on tenant-scoped models is forbidden because it bypasses tenant isolation. Perform separate top-level model operations inside a $transaction instead.",
        },
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
            "Property[key.name=/^(create|update|upsert)$/] Property[key.name=/^(create|createMany|update|updateMany|upsert|set|disconnect)$/]",
          message:
            "Nested create/update/upsert/set/disconnect on tenant-scoped models is forbidden because it bypasses tenant isolation. Perform separate top-level model operations inside a $transaction instead.",
        },
      ],
    },
  },
]);

export default eslintConfig;
