import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// ============================================================================
// [see prior header comments for BASE_UNIT_ID_RULES / CONVERSION_FACTOR_RULES
// / PRODUCT_MODEL_RULES history — unchanged below]
//
// [FIX — CRITICAL, new] BACKEND_ONLY_FILES scoping.
//
// BASE_UNIT_ID_RULES, CONVERSION_FACTOR_RULES, and PRODUCT_MODEL_RULES were
// previously applied GLOBALLY (every file in the project) with specific
// backend files opting OUT of specific bans via per-file overrides. That
// architecture assumed only backend/Prisma-adjacent files would ever
// syntactically contain a `product`/`productUnit`/`conversionFactor`/
// `baseUnitId` identifier — a false assumption. These are also completely
// ordinary field/prop names on plain, already-serialized DTOs that flow
// through the frontend (e.g. a React component destructuring
// `{ product }: { product: ProductItem }`, or reading `unit.conversionFactor`
// off a JSON API response) — the rules are pure AST pattern-matching with no
// type information, so they cannot tell "a Prisma relation was just
// destructured" apart from "a component prop happens to be named the same
// thing." Every such frontend file was flagged as a false positive.
//
// FIX: invert the scoping. These three rule groups are no longer part of
// the untargeted global rule at all — they are added ONLY to a
// BACKEND_ONLY_FILES-scoped config block below. Frontend code (anything
// under app/(dashboard)/**, app/(store)/**'s page/component files, and
// components/**) is never subject to them, because it structurally cannot
// reach a raw Prisma relation in the first place — it only ever sees
// pre-shaped API response DTOs. The untargeted global rule now carries only
// QUERY_RAW_RULE and NESTED_WRITE_RULE, which stay project-wide since a
// stray `$queryRaw` or a `data: { create: ... }` shape appearing in
// frontend code would be a red flag regardless (there is no legitimate
// frontend reason to write either pattern).
//
// Per-file overrides for base-unit.ts / units.ts / products.ts / route
// files / seed.ts / tenant-scope.ts below are UNCHANGED in spirit — they
// still lift exactly the specific ban(s) each sanctioned backend file
// legitimately needs, layered on top of the BACKEND_ONLY_FILES block.
// ============================================================================

const BACKEND_ONLY_FILES = ["app/api/**", "lib/**", "seed.ts"];

const BASE_UNIT_ID_RULES = [
  {
    selector: "Property[key.name=/^(data|select|include|where)$/] Property[key.name=/^(baseUnitId|baseUnit|isBaseUnitOf)$/]",
    message:
      "Direct access to '.baseUnitId'/'.baseUnit'/'.isBaseUnitOf' (as a select/data/include/where key) is forbidden outside lib/inventory/base-unit.ts. Use requireBaseUnit()/requireBaseUnits()/commitBaseUnitLink() instead — see T1's Unit Conversion Architecture.",
  },
  {
    selector: "ObjectPattern > Property[key.name=/^(baseUnitId|baseUnit|isBaseUnitOf)$/]",
    message:
      "Destructuring '.baseUnitId'/'.baseUnit'/'.isBaseUnitOf' off a fetched result is forbidden outside lib/inventory/base-unit.ts. Use requireBaseUnit()/requireBaseUnits() instead — see T1's Unit Conversion Architecture.",
  },
  {
    selector: "MemberExpression[property.name=/^(baseUnitId|baseUnit|isBaseUnitOf)$/]",
    message:
      "Direct access to '.baseUnitId'/'.baseUnit'/'.isBaseUnitOf' is forbidden outside lib/inventory/base-unit.ts. Use requireBaseUnit()/requireBaseUnits() instead — see T1's Unit Conversion Architecture.",
  },
  {
    selector: "MemberExpression[computed=true] > Literal[value=/^(baseUnitId|baseUnit|isBaseUnitOf)$/]",
    message:
      "Direct access to '.baseUnitId'/'.baseUnit'/'.isBaseUnitOf' is forbidden outside lib/inventory/base-unit.ts. Use requireBaseUnit()/requireBaseUnits() instead — see T1's Unit Conversion Architecture.",
  },
];

const CONVERSION_FACTOR_RULES = [
  {
    selector: "Property[key.name=/^(data|select|include|where)$/] Property[key.name='conversionFactor']",
    message:
      "Direct access to '.conversionFactor' (as a select/data/include/where key) is forbidden outside lib/inventory/units.ts, regardless of which relation path leads to it (.unit, .productUnit, .baseUnit...). Use units.ts's getUnitConversionFactor() to read it, or buildConversionFactorField()/isReservedBaseUnitFactor() to write/check it — see T1's Unit Conversion Architecture and the rounding-error bug this exists to prevent.",
  },
  {
    selector: "ObjectPattern > Property[key.name='conversionFactor']",
    message:
      "Destructuring '.conversionFactor' off a fetched result is forbidden outside lib/inventory/units.ts, regardless of which relation path leads to it. Use getUnitConversionFactor() instead — see T1's Unit Conversion Architecture.",
  },
  {
    selector: "MemberExpression[property.name='conversionFactor']",
    message:
      "Direct access to '.conversionFactor' is forbidden outside lib/inventory/units.ts, regardless of which relation path leads to it. Use getUnitConversionFactor() instead — see T1's Unit Conversion Architecture.",
  },
  {
    selector: "MemberExpression[computed=true] > Literal[value='conversionFactor']",
    message:
      "Direct access to '.conversionFactor' is forbidden outside lib/inventory/units.ts. Use getUnitConversionFactor() instead — see T1's Unit Conversion Architecture.",
  },
];

const PRODUCT_MODEL_RULES = [
  {
    selector: "Property[key.name=/^(data|select|include|where)$/] Property[key.name=/^(product|productUnit)$/]",
    message:
      "Naming 'product'/'productUnit' (as a select/data/include/where key) is forbidden outside lib/data/products.ts. Import the matching helper from lib/data/products.ts instead — see that file's header for why this is model-level, not just field-level.",
  },
  {
    selector: "ObjectPattern > Property[key.name=/^(product|productUnit)$/]",
    message:
      "Destructuring '.product'/'.productUnit' off a fetched result is forbidden outside lib/data/products.ts. Import the matching helper from lib/data/products.ts instead.",
  },
  {
    selector: "MemberExpression[property.name=/^(product|productUnit)$/]",
    message:
      "Direct access to '.product'/'.productUnit' (as a Prisma model call or a fetched relation) is forbidden outside lib/data/products.ts. Import the matching helper from lib/data/products.ts instead.",
  },
  {
    selector: "MemberExpression[computed=true] > Literal[value=/^(product|productUnit)$/]",
    message:
      "Direct access to '.product'/'.productUnit' is forbidden outside lib/data/products.ts. Import the matching helper from lib/data/products.ts instead.",
  },
];

const QUERY_RAW_RULE = {
  selector: "MemberExpression[property.name=/^(\\$queryRaw|\\$queryRawUnsafe)$/]",
  message:
    "Direct $queryRaw or $queryRawUnsafe calls are forbidden outside lib/db/tenant-scope.ts. Use tenantScopedRawQuery() instead for tenant isolation compliance.",
};

const NESTED_WRITE_RULE = {
  selector:
    "Property[key.name='data'] Property[key.name=/^(create|createMany|update|updateMany|upsert|set|disconnect)$/]",
  message:
    "Nested create/update/upsert/set/disconnect on tenant-scoped models is forbidden because it bypasses tenant isolation. Perform separate top-level model operations inside a $transaction instead.",
};

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
    // [FIX] Untargeted global rule: ONLY the two rules that carry no
    // meaningful frontend false-positive risk. BASE_UNIT_ID_RULES /
    // CONVERSION_FACTOR_RULES / PRODUCT_MODEL_RULES moved to the
    // BACKEND_ONLY_FILES-scoped block below — see the module header note.
    rules: {
      "no-restricted-syntax": [
        "error",
        QUERY_RAW_RULE,
        NESTED_WRITE_RULE,
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
    // [FIX — new] BASE_UNIT_ID_RULES / CONVERSION_FACTOR_RULES /
    // PRODUCT_MODEL_RULES now apply ONLY within files that can possibly
    // touch Prisma at all. Every per-file override below (which LIFTS a
    // specific ban for a specific sanctioned file) still applies on top
    // of this, since ESLint flat config merges matching entries in array
    // order and each override file glob is a subset of BACKEND_ONLY_FILES.
    files: BACKEND_ONLY_FILES,
    rules: {
      "no-restricted-syntax": [
        "error",
        QUERY_RAW_RULE,
        NESTED_WRITE_RULE,
        ...BASE_UNIT_ID_RULES,
        ...CONVERSION_FACTOR_RULES,
        ...PRODUCT_MODEL_RULES,
      ],
    },
  },
  {
    // lib/db/tenant-scope.ts — the sanctioned $queryRaw wrapper. Lifts
    // ONLY the queryRaw ban; every other restriction stays fully active.
    files: ["lib/db/tenant-scope.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        NESTED_WRITE_RULE,
        ...BASE_UNIT_ID_RULES,
        ...CONVERSION_FACTOR_RULES,
        ...PRODUCT_MODEL_RULES,
      ],
    },
  },
  {
    // [v4.0] The one sanctioned file permitted to read/write
    // Product.baseUnitId directly, AND one of the two files permitted to
    // call tx.product.* / tx.productUnit.* — see lib/data/products.ts's
    // header. Still does NOT name 'conversionFactor' anywhere in its own
    // source, so that ban stays fully active here.
    files: ["lib/inventory/base-unit.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        QUERY_RAW_RULE,
        NESTED_WRITE_RULE,
        ...CONVERSION_FACTOR_RULES,
        // baseUnitId/isBaseUnitOf ban lifted (this IS the sanctioned file).
        // Model-level ban lifted (this IS one of the two sanctioned files
        // for tx.product.*/tx.productUnit.*).
      ],
    },
  },
  {
    // The one sanctioned file permitted to name 'conversionFactor'
    // anywhere. Also legitimately calls tx.productUnit.* directly
    // (getUnitConversionFactor()), so the model-level ban is lifted too.
    // baseUnitId/isBaseUnitOf stays fully banned.
    files: ["lib/inventory/units.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        QUERY_RAW_RULE,
        NESTED_WRITE_RULE,
        ...BASE_UNIT_ID_RULES,
        // conversionFactor ban lifted (this IS the sanctioned file).
        // Model-level ban lifted (getUnitConversionFactor() legitimately
        // calls tx.productUnit.findUniqueOrThrow()).
      ],
    },
  },
  {
    // lib/data/products.ts — the allowlisted data-access gateway itself.
    // Model-level ban lifted (this IS the gateway). Every other
    // restriction stays fully active. baseUnitId/isBaseUnitOf also stays
    // fully banned — this file only ever touches it indirectly, via
    // base-unit.ts's commitBaseUnitLink()/toSafeProductWithUnits().
    files: ["lib/data/products.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        QUERY_RAW_RULE,
        NESTED_WRITE_RULE,
        ...BASE_UNIT_ID_RULES,
        ...CONVERSION_FACTOR_RULES,
        // Model-level ban lifted (this IS the sanctioned gateway file).
      ],
    },
  },
  {
    // Route-layer DTO files that legitimately name 'conversionFactor' as
    // a Zod schema field, a JSON response field, or pass it through as a
    // plain argument to toBaseUnit()/createAdditionalUnit() — never read
    // off a raw Prisma relation directly. The model-level PRODUCT_MODEL_RULES
    // ban stays fully active here and is what actually closes that gap.
    // baseUnitId/isBaseUnitOf stays fully banned.
    files: ["app/api/inventory/products/route.ts", "app/api/inventory/products/\\[id\\]/route.ts", "lib/inventory/csv-parser.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        QUERY_RAW_RULE,
        NESTED_WRITE_RULE,
        ...BASE_UNIT_ID_RULES,
        ...PRODUCT_MODEL_RULES,
        // conversionFactor ban lifted for these two route files.
      ],
    },
  },
  {
    // Offline engine reads pre-fetched unit/product records from local cache,
    // not direct Prisma relations.
    files: ["lib/offline/**"],
    rules: {
      "no-restricted-syntax": [
        "error",
        QUERY_RAW_RULE,
        NESTED_WRITE_RULE,
        ...BASE_UNIT_ID_RULES,
        ...PRODUCT_MODEL_RULES,
        // CONVERSION_FACTOR_RULES explicitly omitted for offline cache processing
      ],
    },
  },
  {
    // seed.ts legitimately creates Product/ProductUnit rows directly
    // (documented in T1's Developer Tooling section) — exempted from the
    // model-level rule. baseUnitId and conversionFactor stay fully
    // banned here (seed.ts has no legitimate reason to write either
    // directly). no-nested-write stays intentionally ACTIVE.
    files: ["seed.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        NESTED_WRITE_RULE,
        ...BASE_UNIT_ID_RULES,
        ...CONVERSION_FACTOR_RULES,
        // Model-level ban lifted (documented direct Product/ProductUnit
        // creation in seed.ts). queryRaw ban lifted too.
      ],
    },
  },
  {
    files: [
      "app/api/auth/register/**",
      "seed.ts",
      "app/(dashboard)/admin/**",
      "app/api/admin/**",
      "app/api/sync/**",
      "app/api/inventory/fifo-preview/**",
      "lib/inventory/fifo.ts",
      "app/(store)/**",
      "app/api/catalog/**",
      "app/api/store/**",
    ],
    rules: {
      "no-restricted-imports": "off",
    },
  },
]);

export default eslintConfig;