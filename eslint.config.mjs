import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// ============================================================================
// [FIX — supersedes the previous "arithmetic-only" conversionFactor rule]
//
// The earlier revision of this config only blocked MULTIPLYING/DIVIDING
// by `.conversionFactor` outside lib/inventory/units.ts. Two real gaps
// followed from that (see lib/inventory/units.ts's own header for the
// full narrative):
//   1. The relation name leading to the field varies by model —
//      `InvoiceItem.unit`, `ProductBatch.unit`, `B2BOrderRequestItem.unit`
//      — never `.productUnit`. The model-level `product`/`productUnit`
//      rule below never even sees `item.unit.conversionFactor`, since
//      that's a different top-level model (InvoiceItem) with an
//      unrelated relation field name. Chasing every possible relation
//      name by regex is a losing game.
//   2. The arithmetic-only rule only matched a raw `*`/`/` operator —
//      never decimal.js method calls (`qty.times(unit.conversionFactor)`),
//      which is the ONLY sanctioned way to do this arithmetic anywhere
//      else in this codebase (native `*`/`/` on money/quantity figures is
//      banned project-wide). The rule could never fire on the exact
//      pattern the rest of the architecture requires everyone to use.
//
// FIX: stop trying to block specific *usages* of conversionFactor and
// instead block the field NAME itself, full stop, anywhere it appears
// syntactically outside lib/inventory/units.ts — the same treatment
// `baseUnitId` already gets. This is relation-name-agnostic (it fires on
// `select: { unit: { select: { conversionFactor: true } } }` exactly as
// readily as on `productUnit.conversionFactor}`), and it makes the
// arithmetic concern moot: nothing outside units.ts can hold a reference
// to the value at all, so there is nothing left to multiply, divide, or
// call `.times()` on.
//
// The same reasoning applies to the model-level `product`/`productUnit`
// rule below: the previous version only covered `MemberExpression` and
// `ObjectPattern` destructuring, missing a bare `Property` key inside an
// ordinary object literal — e.g. `include: { product: { select: {...} } } }`
// — which is exactly the same AST-node-type gap the `baseUnitId` rule was
// designed around from the start. A bare `Property[key.name=...]`
// selector is added below to close that too.
// ============================================================================

const BASE_UNIT_ID_RULES = [
  {
    selector: "Property[key.name=/^(data|select|include|where)$/] Property[key.name=/^(baseUnitId|baseUnit)$/]",
    message:
      "Direct access to '.baseUnitId'/'.baseUnit' (as a select/data/include key or a destructured field) is forbidden outside lib/inventory/base-unit.ts. Use requireBaseUnit()/requireBaseUnits()/commitBaseUnitLink() instead — see T1's Unit Conversion Architecture.",
  },
  {
    selector: "MemberExpression[property.name=/^(baseUnitId|baseUnit)$/]",
    message:
      "Direct access to '.baseUnitId'/'.baseUnit' is forbidden outside lib/inventory/base-unit.ts. Use requireBaseUnit()/requireBaseUnits() instead — see T1's Unit Conversion Architecture.",
  },
  {
    selector: "MemberExpression[computed=true] > Literal[value=/^(baseUnitId|baseUnit)$/]",
    message:
      "Direct access to '.baseUnitId'/'.baseUnit' is forbidden outside lib/inventory/base-unit.ts. Use requireBaseUnit()/requireBaseUnits() instead — see T1's Unit Conversion Architecture.",
  },
];

// [FIX — new] Full field-name-level ban, replacing the old arithmetic-only
// rule. See the module header above for why.
const CONVERSION_FACTOR_RULES = [
  {
    selector: "Property[key.name='conversionFactor']",
    message:
      "Naming 'conversionFactor' (as a select/data/include key, a shorthand property, or a destructured field) is forbidden outside lib/inventory/units.ts, regardless of which relation path leads to it (.unit, .productUnit, .baseUnit...). Use units.ts's getUnitConversionFactor() to read it, or buildConversionFactorField()/isReservedBaseUnitFactor() to write/check it — see T1's Unit Conversion Architecture and the rounding-error bug this exists to prevent.",
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

// [FIX — new] Model-level rule for Product/ProductUnit, now including the
// previously-missing bare Property selector (catches `include: { product:
// {...} } }` / `select: { productUnit: {...} } }`, which the old
// MemberExpression + ObjectPattern-only version missed entirely).
const PRODUCT_MODEL_RULES = [
  {
    selector: "Property[key.name=/^(product|productUnit)$/]",
    message:
      "Naming 'product'/'productUnit' (as a select/data/include key, a shorthand property, or a destructured field) is forbidden outside lib/data/products.ts. Import the matching helper from lib/data/products.ts instead — see that file's header for why this is model-level, not just field-level.",
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
    // Global default: every restriction active. Per-file overrides below
    // lift exactly the ones each sanctioned file legitimately needs.
    rules: {
      "no-restricted-syntax": [
        "error",
        QUERY_RAW_RULE,
        NESTED_WRITE_RULE,
        ...BASE_UNIT_ID_RULES,
        ...CONVERSION_FACTOR_RULES,
        ...PRODUCT_MODEL_RULES,
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
    // lib/db/tenant-scope.ts — the sanctioned $queryRaw wrapper. Lifts
    // ONLY the queryRaw ban (by omitting it below); every other
    // restriction stays fully active, including the (new, full) model-
    // level and conversionFactor bans — this file's raw-query wrapper
    // operates generically via Prisma.Sql fragments, never by naming
    // 'product'/'productUnit'/'conversionFactor'/'baseUnitId' literally.
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
    // call tx.product.* / tx.productUnit.* (per lib/data/products.ts's
    // header) — for that one field. It still does NOT name
    // 'conversionFactor' anywhere in its own source (see this file's own
    // header FIX note — writes go through units.ts's
    // buildConversionFactorField()), so that ban stays fully active here.
    files: ["lib/inventory/base-unit.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        QUERY_RAW_RULE,
        NESTED_WRITE_RULE,
        ...CONVERSION_FACTOR_RULES,
        // baseUnitId ban lifted (this IS the sanctioned file for it).
        // Model-level ban lifted (this IS one of the two sanctioned
        // files for tx.product.*/tx.productUnit.* — see
        // lib/data/products.ts's header).
      ],
    },
  },
  {
    // [FIX] The one sanctioned file permitted to name 'conversionFactor'
    // anywhere. It now ALSO legitimately calls tx.productUnit.* directly
    // (getUnitConversionFactor()), so the model-level ban is lifted here
    // too — it was NOT lifted in the previous revision of this config,
    // which assumed (incorrectly, once getUnitConversionFactor() was
    // added) that this file "does not touch tx.product/tx.productUnit at
    // all." baseUnitId stays fully banned — this file has no legitimate
    // reason to touch that field.
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
    // restriction stays fully active, INCLUDING the full conversionFactor
    // ban (not just arithmetic) — this file never names that field
    // literally either; see its own header FIX note. baseUnitId also
    // stays fully banned — this file only ever touches it indirectly, via
    // base-unit.ts's commitBaseUnitLink().
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
    // [FIX] seed.ts legitimately creates Product/ProductUnit rows
    // directly (documented in T1's Developer Tooling section) — exempted
    // from the model-level rule the same way it's already exempted from
    // no-restricted-imports below. Recommendation (not yet enforced by
    // this config): migrate seed.ts's product-creation helper to call
    // lib/data/products.ts's createProductWithBaseUnit() directly instead
    // of constructing its own Product/ProductUnit writes — if that
    // migration happens, this file would no longer need ANY of these
    // exemptions, since it would never name baseUnitId/conversionFactor/
    // product/productUnit itself at all. Until then, baseUnitId and
    // conversionFactor stay fully banned here (seed.ts has no legitimate
    // reason to write either directly — even its own product-creation
    // helper should call requireBaseUnit()/buildConversionFactorField()
    // if it needs them). no-nested-write stays intentionally ACTIVE —
    // createInvoiceAtomic()'s whole documented purpose is to DEMONSTRATE
    // the nested-write ban correctly (T1's Developer Tooling section);
    // lifting it here would defeat that.
    files: ["seed.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        NESTED_WRITE_RULE,
        ...BASE_UNIT_ID_RULES,
        ...CONVERSION_FACTOR_RULES,
        // Model-level ban lifted (documented direct Product/ProductUnit
        // creation in seed.ts). queryRaw ban lifted too (unchanged from
        // the previous revision of this config).
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
