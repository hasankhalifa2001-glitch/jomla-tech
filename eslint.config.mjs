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

// [FIX — missed by every prior pass] The seed script's path here must be
// spelled in full ("prisma/seed.ts"), NOT as a bare "seed.ts".
//
// In ESLint flat config a `files` pattern containing no "/" is matched against
// the path RELATIVE TO THIS CONFIG FILE, so a bare "seed.ts" matches only a
// seed.ts sitting in the project root — which does not exist. prisma/seed.ts
// therefore received NONE of these rule arrays: BASE_UNIT_ID_RULES,
// CONVERSION_FACTOR_RULES and both barcode-model rule arrays were silently
// inert for it, even though the block below (and prisma/seed.ts's own header)
// states they are active there. Verified with
// `npx eslint --print-config prisma/seed.ts`, which reported ZERO hits for the
// productUnitBarcode selector while the same probe against
// app/api/inventory/products/route.ts reported eight. Only QUERY_RAW_RULE and
// NESTED_WRITE_RULE reached prisma/seed.ts, and only because they also live in
// the untargeted global block. Re-verify with --print-config after any edit to
// this constant.
const BACKEND_ONLY_FILES = ["app/api/**", "lib/**", "prisma/seed.ts"];

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

// ============================================================================
// [v4.5] MULTI-BARCODE SUPPORT — model-level confinement for the TWO models
// that replaced the removed ProductUnit.barcode/barcodeSource scalars and the
// removed ProductCatalogEntry.barcode scalar.
//
// WHY TWO SEPARATE ARRAYS RATHER THAN EXTENDING PRODUCT_MODEL_RULES: that
// array's selectors are anchored /^(product|productUnit)$/, so they COULD have
// been widened in place — but they must not be, because PRODUCT_MODEL_RULES is
// deliberately LIFTED for seed.ts and lib/offline/** (both of which
// legitimately call tx.product.*/tx.productUnit.* directly). Flat config
// REPLACES a rule's whole configuration at the last matching block, so folding
// productUnitBarcode into PRODUCT_MODEL_RULES would have silently carried that
// same lift over to the new model for both of those blocks; and closing that
// hole by re-adding PRODUCT_MODEL_RULES to them would newly ban seed.ts's
// legitimate tx.product.create(). Two separate arrays keep each lift narrow and
// self-documenting: a block that OMITS an array lifts exactly that array's ban
// for itself, and every block that must keep the ban active lists it
// explicitly (see each block below).
//
//   ProductUnitBarcode — lifted for exactly TWO files:
//     * lib/data/products.ts    (the sanctioned gateway)
//     * lib/inventory/base-unit.ts (ONE narrow, documented call site:
//       resetProductUnits()'s hard-delete of the barcode rows belonging to the
//       units it is deactivating — see that file's [v4.5] header note)
//
//   ProductCatalogEntryBarcode — lifted for exactly TWO places:
//     * lib/data/products.ts (the gateway that owns all catalog WRITES)
//     * app/api/catalog/**   (a documented READ-ONLY exception: this table is
//       platform-wide with no tenantId column, so the tenant-scoped gateway
//       cannot own the lookup; lint cannot distinguish a read from a write, so
//       the read-only half of that exception is enforced instead by the static
//       source scan in lib/inventory/__tests__/t3a-addendum-multi-barcode.test.ts,
//       which fails if a create/update/upsert/delete against that model ever
//       appears under app/api/catalog/**)
// ============================================================================
const barcodeModelRules = (model, allowedPaths) => {
  const why =
    `'${model}' may only be touched by ${allowedPaths}. Every barcode read/write goes through ` +
    "lib/data/products.ts's listBarcodesForUnit()/createUnitBarcode()/deleteUnitBarcode() (and, for the " +
    "shared catalog, that same file's catalog-entry gateway functions) — each as its OWN top-level model " +
    "call inside the caller's $transaction, never as a nested relation write (T1's nested-write rule).";

  return [
    {
      selector: `Property[key.name=/^(data|select|include|where)$/] Property[key.name='${model}']`,
      message: `Naming '${model}' as a select/data/include/where key is forbidden. ${why}`,
    },
    {
      selector: `ObjectPattern > Property[key.name='${model}']`,
      message: `Destructuring '${model}' off a fetched result is forbidden. ${why}`,
    },
    {
      selector: `MemberExpression[property.name='${model}']`,
      message: `Direct access to '${model}' is forbidden. ${why}`,
    },
    {
      selector: `MemberExpression[computed=true] > Literal[value='${model}']`,
      message: `Direct access to '${model}' is forbidden. ${why}`,
    },
  ];
};

const PRODUCT_UNIT_BARCODE_MODEL_RULES = barcodeModelRules(
  "productUnitBarcode",
  "lib/data/products.ts (the sanctioned gateway) and lib/inventory/base-unit.ts (documented resetProductUnits() exception only)"
);

const PRODUCT_CATALOG_ENTRY_BARCODE_MODEL_RULES = barcodeModelRules(
  "productCatalogEntryBarcode",
  "lib/data/products.ts (the sanctioned gateway) and app/api/catalog/** (documented read-only lookup)"
);

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

// ============================================================================
// [T4f — Rule 4] WEB BLUETOOTH CONFINEMENT (the static-analysis criterion).
//
// Rule 4's first acceptance criterion asks for a static check that no code path
// can infer a printer's dots-per-line from Bluetooth device metadata:
//
//   "No code path infers dots-per-line from Bluetooth device metadata or from
//    paper-width selection alone without an explicit, confirmable value — a
//    static-analysis check mirroring T3a's 'no inference from digit pattern'
//    verification."
//
// The decisive half of that is structural rather than semantic: if exactly ONE
// file in the codebase can reach Web Bluetooth at all, then no other file can
// infer a width from a device, because no other file can reach a device. So
// these three selectors ban every route to the API everywhere except
// lib/receipts/bluetooth-printer.ts:
//
//   navigator.bluetooth      — the only entry point to a device
//   <anything>.gatt          — service discovery, where a model/resolution
//                              could be snooped out of the device
//   <anything>.requestDevice — the pairing call
//
// WHY A SEPARATE RULE KEY RATHER THAN MORE no-restricted-syntax SELECTORS:
// ESLint flat config REPLACES a rule's entire configuration at the last
// matching entry, so appending these selectors to the untargeted
// `no-restricted-syntax` array would mean every per-file override in this file
// (lib/offline/**, lib/data/invoices.ts, units.ts, base-unit.ts, the inventory
// route DTO files, seed.ts, tenant-scope.ts) silently DROPPED the ban for
// itself — lib/offline/** included, which is exactly where a stray Bluetooth
// call would be most plausible. `no-restricted-properties` is a DISTINCT rule
// key, so it composes additively with every existing block instead of
// competing with them, and it is the idiomatic ESLint construct for "ban this
// member access".
//
// The independent, source-level counterpart of this check lives in
// lib/receipts/__tests__/t4f-printer-config.test.ts, which scans
// printer-config.ts's own source for these identifiers — following the
// precedent of lib/offline/__tests__/t4d-offline-void.test.ts's source scans, so
// the guarantee survives someone deleting the lint rule.
// ============================================================================

const T4F_BLUETOOTH_ONLY_FILE = "lib/receipts/bluetooth-printer.ts";

const T4F_BLUETOOTH_CONFINEMENT_MESSAGE =
  "Web Bluetooth is confined to lib/receipts/bluetooth-printer.ts. Rule 4 requires the printer's dots-per-line to be an explicit, per-device, human-confirmed setting — it is never inferred from device metadata (name / GATT / model), and a second call site is exactly how that inference would creep in.";

const T4F_NO_RESTRICTED_PROPERTIES = [
  "error",
  {
    object: "navigator",
    property: "bluetooth",
    message: T4F_BLUETOOTH_CONFINEMENT_MESSAGE,
  },
  { property: "gatt", message: T4F_BLUETOOTH_CONFINEMENT_MESSAGE },
  { property: "requestDevice", message: T4F_BLUETOOTH_CONFINEMENT_MESSAGE },
];

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
      // [T4f — Rule 4] Active for EVERY file; the single sanctioned transport
      // re-enables it via its own override at the end of this config. See the
      // T4F block above for why this is not inside no-restricted-syntax.
      "no-restricted-properties": T4F_NO_RESTRICTED_PROPERTIES,
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
        // [v4.5] Both barcode models stay fully banned by default; only the
        // explicit per-file blocks further down lift either one.
        ...PRODUCT_UNIT_BARCODE_MODEL_RULES,
        ...PRODUCT_CATALOG_ENTRY_BARCODE_MODEL_RULES,
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
        // [v4.5] tenant-scope.ts owns tenantId INJECTION, never barcode rows —
        // both bans stay fully active here.
        ...PRODUCT_UNIT_BARCODE_MODEL_RULES,
        ...PRODUCT_CATALOG_ENTRY_BARCODE_MODEL_RULES,
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
        //
        // [v4.5] PRODUCT_UNIT_BARCODE_MODEL_RULES is deliberately OMITTED here
        // — this file's ONE narrow, documented exception is
        // resetProductUnits()'s hard-delete of the barcode rows belonging to
        // the units it is deactivating (ProductUnitBarcode's
        // @@unique([tenantId, barcode]) does not distinguish active from
        // inactive parent units, so leaving those rows behind would
        // permanently block the value from ever being reused). Every OTHER
        // barcode read/write in this codebase goes through
        // lib/data/products.ts.
        //
        // PRODUCT_CATALOG_ENTRY_BARCODE_MODEL_RULES, by contrast, stays FULLY
        // ACTIVE here: base-unit.ts has no business touching the shared
        // cross-tenant catalog at all.
        ...PRODUCT_CATALOG_ENTRY_BARCODE_MODEL_RULES,
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
        //
        // [v4.5] Both barcode-model bans stay FULLY ACTIVE here — this file
        // only reshapes barcode data its callers already fetched (see its
        // [v4.5] header note); it never queries either model itself.
        ...PRODUCT_UNIT_BARCODE_MODEL_RULES,
        ...PRODUCT_CATALOG_ENTRY_BARCODE_MODEL_RULES,
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
        //
        // [v4.5] BOTH barcode-model bans are deliberately OMITTED here too:
        // this file is the sole sanctioned gateway for
        // tx.productUnitBarcode.* (listBarcodesForUnit / createUnitBarcode /
        // deleteUnitBarcode) AND for the shared-catalog writes against
        // productCatalogEntryBarcode. See the [v4.5] note on
        // PRODUCT_UNIT_BARCODE_MODEL_RULES / PRODUCT_CATALOG_ENTRY_BARCODE_MODEL_RULES
        // above — this is the only block that lifts both.
      ],
    },
  },
  {
    // lib/data/invoices.ts — the allowlisted data-access gateway itself.
    // Model-level ban lifted (this IS the gateway). Every other
    // restriction stays fully active. baseUnitId/isBaseUnitOf also stays
    // fully banned — this file only ever touches it indirectly, via
    // base-unit.ts's commitBaseUnitLink()/toSafeProductWithUnits().
    files: ["lib/data/invoices.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        QUERY_RAW_RULE,
        NESTED_WRITE_RULE,
        ...BASE_UNIT_ID_RULES,
        ...CONVERSION_FACTOR_RULES,
        // Model-level ban lifted (this IS the sanctioned gateway file).
        //
        // [v4.5] Both barcode-model bans stay FULLY ACTIVE: a sale keys off
        // unitId and never off a barcode (see schema.prisma's [v4.5] note),
        // so nothing in the invoice gateway has any reason to hold one.
        ...PRODUCT_UNIT_BARCODE_MODEL_RULES,
        ...PRODUCT_CATALOG_ENTRY_BARCODE_MODEL_RULES,
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
        //
        // [v4.5] Both barcode-model bans stay FULLY ACTIVE: these files call
        // lib/data/products.ts's barcode gateways (listBarcodesForUnit /
        // createUnitBarcode / deleteUnitBarcode / the catalog-entry helpers)
        // and never the models themselves — which is exactly why the GS1
        // shared-catalog matching logic lives behind those helpers instead of
        // being inlined here.
        ...PRODUCT_UNIT_BARCODE_MODEL_RULES,
        ...PRODUCT_CATALOG_ENTRY_BARCODE_MODEL_RULES,
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
        // CONVERSION_FACTOR_RULES explicitly omitted for offline cache processing.
        //
        // [v4.5] Both barcode-model bans are listed EXPLICITLY here (they would
        // otherwise be silently lifted along with the deliberately-omitted
        // PRODUCT_MODEL_RULES above): the offline layer reads barcode data out
        // of Dexie's own cachedProductBarcodes table, never out of Prisma, so
        // there is no legitimate reason for any file under lib/offline/** to
        // name either model.
        ...PRODUCT_UNIT_BARCODE_MODEL_RULES,
        ...PRODUCT_CATALOG_ENTRY_BARCODE_MODEL_RULES,
      ],
    },
  },
  {
    // seed.ts legitimately creates Product/ProductUnit rows directly
    // (documented in T1's Developer Tooling section) — exempted from the
    // model-level rule. baseUnitId and conversionFactor stay fully
    // banned here, with exactly ONE documented, line-local exception at
    // createProductWithUnit()'s write (a plain demo-data read — see that
    // line's own comment). no-nested-write stays intentionally ACTIVE.
    //
    // [FIX — see BACKEND_ONLY_FILES above] This block previously said "seed.ts"
    // and therefore never applied to prisma/seed.ts at all; every array listed
    // here was inert. The path is now spelled in full.
    files: ["prisma/seed.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        NESTED_WRITE_RULE,
        ...BASE_UNIT_ID_RULES,
        ...CONVERSION_FACTOR_RULES,
        // Model-level ban lifted (documented direct Product/ProductUnit
        // creation in seed.ts). queryRaw ban lifted too.
        //
        // [v4.5] Both barcode-model bans stay ACTIVE even here: seed.ts attaches
        // demo barcodes through lib/data/products.ts's createUnitBarcode()
        // (imported relatively, since this script runs outside Next's
        // bundler) rather than writing tx.productUnitBarcode directly — the
        // model genuinely has exactly two sanctioned touch points.
        ...PRODUCT_UNIT_BARCODE_MODEL_RULES,
        ...PRODUCT_CATALOG_ENTRY_BARCODE_MODEL_RULES,
      ],
    },
  },
  {
    // [v4.5] app/api/catalog/** — the ONE documented READ-ONLY exception for
    // ProductCatalogEntryBarcode. This table is platform-wide (no tenantId
    // column), so the tenant-scoped gateway in lib/data/products.ts cannot own
    // a lookup by bare barcode value; /api/catalog/lookup does one indexed
    // findUnique on it. Lint cannot tell a read from a write, so this block
    // lifts the whole ban and the READ-ONLY half is enforced by the static
    // source scan in lib/inventory/__tests__/t3a-addendum-multi-barcode.test.ts
    // (which fails if any create/update/upsert/delete/deleteMany against
    // productCatalogEntryBarcode ever appears under app/api/catalog/**).
    // Everything else stays fully active, exactly as the BACKEND_ONLY_FILES
    // block above had it.
    files: ["app/api/catalog/**"],
    rules: {
      "no-restricted-syntax": [
        "error",
        QUERY_RAW_RULE,
        NESTED_WRITE_RULE,
        ...BASE_UNIT_ID_RULES,
        ...CONVERSION_FACTOR_RULES,
        ...PRODUCT_MODEL_RULES,
        ...PRODUCT_UNIT_BARCODE_MODEL_RULES,
        // PRODUCT_CATALOG_ENTRY_BARCODE_MODEL_RULES deliberately omitted (read-only exception).
      ],
    },
  },
  {
    files: [
      "app/api/auth/register/**",
      "prisma/seed.ts",
      "app/(dashboard)/admin/**",
      "app/api/admin/**",
      "app/api/sync/**",
      // [T5] The B2B order approval route is a category-5 raw-client call
      // site: it must call lockBatchesForFifoAllocations(), which is typed to
      // accept exactly Prisma.TransactionClient — a shape getTenantDb()'s
      // extended client is deliberately NOT assignable to. See lib/db.ts's
      // category-5 rationale and that route's own header comment.
      "app/api/orders/**",
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
  {
    // [T4f — Rule 4] The ONE sanctioned Web Bluetooth call site: the ESC/POS
    // transport itself (requestThermalPrinter / printEscPosBytes /
    // isPrinterConnected / disconnectThermalPrinter). Every other file in the
    // project is covered by the untargeted `no-restricted-properties` rule added
    // to the global block above — see the T4F block's comment for why the ban
    // is a separate rule key.
    //
    // Note what this override deliberately does NOT do: it replaces only
    // `no-restricted-properties`. This file is still inside lib/**, so
    // QUERY_RAW_RULE, NESTED_WRITE_RULE and BASE_UNIT_ID_RULES /
    // CONVERSION_FACTOR_RULES / PRODUCT_MODEL_RULES all remain in force here —
    // a whole-rule-family "off" would have silently loosened them.
    files: [T4F_BLUETOOTH_ONLY_FILE],
    rules: {
      "no-restricted-properties": "off",
    },
  },
]);

export default eslintConfig;