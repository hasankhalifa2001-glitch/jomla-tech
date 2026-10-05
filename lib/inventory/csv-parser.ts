import Papa from "papaparse";
import { Prisma, type BarcodeSource } from "@prisma/client";
import type { getTenantDb } from "@/lib/db/tenant-scope";
// [FIX] validatePackagingUnits now lives in units.ts (merged in), not the
// deleted packaging-unit-validation.ts.
import { validatePackagingUnits, toBaseUnit, BASE_UNIT_CONVERSION_FACTOR, type PackagingUnit } from "./units";
// [FIX — critical] This file previously called rowTx.product.*/
// rowTx.productUnit.*/db.product.*/db.productUnit.* directly everywhere —
// exactly the model-level access eslint.config.mjs's PRODUCT_MODEL_RULES
// bans outside lib/data/products.ts, and this file is not on that ban's
// exemption list. Routed through the sanctioned gateway instead.
//
// [v4.5] The ProductUnitBarcode model is subject to the SAME rule, and this
// file is not on that ban's exemption list either — so nothing here calls
// tx.productUnitBarcode.* directly. Every barcode row is written through
// createUnitBarcode(), and every GS1 shared-catalog decision through
// resolveSharedCatalogForBarcode().
import {
  findProductUnitByBarcode,
  findProductUnitById,
  updateProductUnit,
  createProductWithBaseUnit,
  createAdditionalUnit,
  findProductByNameCategory,
  listAllProductsWithUnitsForPackagingCheck,
  listAllUnitsForTenantWithProductName,
  // [v4.5] The barcode model's two sanctioned write/decision gateways.
  // `createUnitBarcode()` is the ONLY way a barcode row is attached to a unit
  // (this file previously passed a `barcode` scalar straight into
  // createProductWithBaseUnit()/createAdditionalUnit()'s `data` — a key that
  // no longer exists on those Safe types, and that could never have
  // represented more than one barcode per unit anyway).
  // `resolveSharedCatalogForBarcode()` owns the whole GS1 shared-catalog
  // decision, exactly as it does for the two product PATCH/POST routes.
  createUnitBarcode,
  resolveSharedCatalogForBarcode,
} from "@/lib/data/products";
// [FIX — critical] Resolves the product's REAL base unit before writing a
// batch for an additional (non-base) packaging unit — see the
// commitCsvImport doc comment below for the full bug this closes.
import { requireBaseUnit, type TxOrClient } from "@/lib/inventory/base-unit";
// [v4.4, Spec Addendum Section 10.2] The ONE sanctioned batchNumber
// construction module. This import path is exactly why it exists: the CSV
// import must NOT write the initialBatchNumber column verbatim into
// ProductBatch.batchNumber, and must NOT re-implement the date-prefix
// concatenation locally either — it calls the identical shared function
// T3a's screens call.
import { constructBatchNumber } from "@/lib/inventory/batch-number";
// [FIX] Real calendar-date check (rejects 2027-02-30, 2026-13-45). A bare
// `new Date(str)` + isNaN check can silently roll an impossible date over
// into the next month depending on the JS engine.
import { isRealCalendarDate } from "./date-utils";

export interface CsvRowRaw {
  [key: string]: string | undefined;
}

/**
 * [v4.5] One confirmed barcode on an imported unit: a value PLUS the source
 * the merchant explicitly stated for it. Mirrors the two ProductUnitBarcode
 * columns and BarcodeSourceModal's per-row confirmation exactly.
 */
export interface ImportUnitBarcode {
  barcode: string;
  barcodeSource: BarcodeSource;
}

export interface NewProductImportData {
  lineNumber: number;
  /**
   * [v4.5] REPLACED the old single `barcode?: string` scalar, which could only
   * ever describe ONE barcode per unit. Zero, one, or many — exactly the
   * ProductUnitBarcode model's shape. Populated from the CSV's delimited
   * `barcodes` column (see splitBarcodeCell()), or folded from the legacy
   * single `barcode` column for a file written before v4.5.
   *
   * Each entry already carries its human-confirmed `barcodeSource`: the source
   * is NEVER inferred from a barcode's digit pattern (T3a §5), so a row that
   * supplies any barcode without a valid `barcodeSource` is rejected at
   * preview time rather than stored unclassified.
   */
  barcodes: ImportUnitBarcode[];
  name: string;
  category?: string;
  unitName: string;
  conversionFactor: string | number;
  priceWholesale: string | number;
  pricingCurrency?: "SYP" | "USD";
  /**
   * [v4.4, Spec Addendum Section 10.2] The MERCHANT-SUPPLIED SUFFIX ONLY —
   * never a full, pre-formatted batch number. The stored
   * ProductBatch.batchNumber is always
   * `{server-date at row-processing time}-{this value}`, built through
   * lib/inventory/batch-number.ts's constructBatchNumber() — the SAME
   * shared construction every other creation path uses. A row whose
   * initialBatchNumber is empty is rejected and named in the import report,
   * exactly like a missing unitName/conversionFactor/initialQuantity/
   * costPrice.
   */
  initialBatchNumber: string;
  initialQuantity: string | number;
  /**
   * [v4.4, T4g] Required for any row that creates a new ProductBatch
   * (a genuinely new product, or a new additional packaging unit on an
   * existing product). Cost per the product's BASE unit, always SYP —
   * deliberately with no pricingCurrency counterpart (unlike
   * priceWholesale), since this is an internal accounting
   * figure feeding the ledger's SYP-authoritative profit calculation and
   * never a price a retailer negotiates in. Taken as-is: never divided by
   * the row's conversionFactor.
   */
  costPrice: string | number;
  expiryDate?: string | null;
  // Aliases for compatibility
  batchNumber?: string;
  quantity?: string | number;
}

export interface PriceUpdateImportData {
  lineNumber: number;
  barcode: string;
  productName: string;
  unitName: string;
  // [FIX] Always a decimal string now — never a native JS number (T1's
  // "no native number in any monetary field" rule).
  currentPriceWholesale: number | string;
  newPriceWholesale: string | number;
  pricingCurrency: "SYP" | "USD";
  unitId: string;
}

export interface RejectedRowData {
  lineNumber: number;
  rowContent: string;
  reason: string;
}

export interface CsvPreviewResult {
  summary: {
    totalRows: number;
    newProductsCount: number;
    priceUpdatesCount: number;
    rejectedRowsCount: number;
  };
  newProducts: NewProductImportData[];
  priceUpdates: PriceUpdateImportData[];
  rejectedRows: RejectedRowData[];
}

export const STRICT_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
export const DECIMAL_STRING_REGEX = /^-?\d{1,14}(\.\d{1,4})?$/;

// [FIX #3 — critical, tenant isolation] These two types previously read:
//   type PrismaReadClient = PrismaClient | Prisma.TransactionClient;
//   type PrismaWriteClient = PrismaClient;
// accepting the RAW, unscoped Prisma client (or a raw transaction client)
// directly. `TenantScopedDb` is the actual type returned by
// getTenantDb(tenantId) — the tenant-scoped Prisma Client Extension. This
// file has no structural reason to accept a raw transaction client the
// way lib/inventory/fifo.ts's commitFifoAllocation() does (see
// lib/db.ts's category-5 note) — CSV import never hands its transaction
// into a shared helper that requires the raw Prisma.TransactionClient
// type, so there's no reason to widen this file's accepted type to match.
type TenantScopedDb = ReturnType<typeof getTenantDb>;

type PrismaReadClient = TenantScopedDb;
type PrismaWriteClient = TenantScopedDb;

/**
 * Normalizes a (name, category) pair into a single lookup key for matching
 * a CSV row against an existing Product. CONFIRMED PRODUCT DECISION: this
 * match is case-INsensitive on both name and category — "Cola" / "cola" /
 * "COLA" are treated as the same product, and likewise for category. This
 * was explicitly confirmed (not merely assumed) as the intended behavior,
 * matching the case-insensitive Prisma query (`mode: "insensitive"`) used
 * in commitCsvImport's live (name, category) lookup below — the two must
 * stay in sync, since this key is used at preview time purely to group
 * candidate packaging-unit validation, while the Prisma query does the
 * authoritative match at commit time.
 */
function normalizeProductKey(name: string, category?: string | null): string {
  return `${name.trim().toLowerCase()}|${(category || "").trim().toLowerCase()}`;
}

/**
 * [v4.5] Splits ONE `barcodes` cell into individual barcode values.
 *
 * `;`, tab and newline are the separators — deliberately the SAME three the
 * two product modals use for their barcode input (AddProductModal's /
 * EditProductModal's splitBarcodeInput()), so a merchant who learned the
 * separator on the add-product screen uses the same one in a CSV cell.
 *
 * Duplicates within the cell are collapsed (Set), mirroring the modals'
 * `Array.from(new Set(splitBarcodeInput(...)))` fix: the same value twice is
 * one physical barcode, and letting it through would produce two identical
 * ProductUnitBarcode rows and trip @@unique([tenantId, barcode]) with a
 * confusing, whole-row failure instead.
 */
export function splitBarcodeCell(raw: string | undefined): string[] {
  return Array.from(
    new Set(
      (raw || "")
        .split(/[;\n\t]+/)
        .map((v) => v.trim())
        .filter(Boolean)
    )
  );
}

/**
 * [v4.5] Parses the row's mandatory `barcodeSource` cell.
 *
 * Returns `null` for "the cell is empty / not one of the two allowed values",
 * which the caller treats as a REJECTED ROW whenever that row also supplied
 * one or more barcodes. Case-insensitive on input ("gs1" is accepted), but
 * never widened beyond the enum: an unrecognised value is never coerced to
 * GS1 or INTERNAL, and the digit pattern is never consulted (T3a §5).
 */
export function parseBarcodeSourceCell(raw: string | undefined): BarcodeSource | null {
  const value = (raw || "").trim().toUpperCase();
  if (value === "GS1") return "GS1";
  if (value === "INTERNAL") return "INTERNAL";
  return null;
}

/**
 * Two-Pass Validation (Pass 1): Parse & Validate CSV without writing to DB
 *
 * T3d Rules: (unchanged from before — see inline comments below)
 *
 * [FIX] Both DB reads below now go through lib/data/products.ts instead of
 * calling db.productUnit.findMany({ include: { product: true } }) /
 * db.product.findMany({ include: { units: ... } }) directly.
 */
export async function validateAndPreviewCsv(
  db: PrismaReadClient,
  tenantId: string,
  csvString: string
): Promise<CsvPreviewResult> {
  const parseResult = Papa.parse<CsvRowRaw>(csvString, {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (header) => normalizeHeaderKey(header),
  });

  const rows = parseResult.data || [];
  const totalRows = rows.length;

  const newProducts: NewProductImportData[] = [];
  const priceUpdates: PriceUpdateImportData[] = [];
  const rejectedRows: RejectedRowData[] = [];

  for (const err of parseResult.errors) {
    const lineNumber = (err.row ?? 0) + 2;
    rejectedRows.push({
      lineNumber,
      rowContent: "",
      reason: `السطر ${lineNumber}: خطأ في تنسيق الملف (${err.message}).`,
    });
  }

  // [FIX] Routed through lib/data/products.ts — never a raw
  // db.productUnit.findMany({ include: { product: true } }) call.
  const existingUnits = await listAllUnitsForTenantWithProductName(db, tenantId);

  // [v4.5] ONE index entry per ProductUnitBarcode row: a unit with three
  // barcodes contributes three keys, so a CSV row carrying ANY of them
  // resolves to that unit — the whole point of multi-barcode support. The
  // value carries the MATCHED barcode value alongside the unit because the
  // unit no longer has a scalar `barcode` to read it back from, and the
  // price-update report must name the exact value the row used.
  const barcodeMap = new Map<
    string,
    { unit: (typeof existingUnits)[number]; barcode: string }
  >();
  for (const u of existingUnits) {
    for (const b of u.barcodes ?? []) {
      const value = b.barcode?.trim();
      if (value) barcodeMap.set(value, { unit: u, barcode: value });
    }
  }

  // [FIX] Routed through lib/data/products.ts — never a raw
  // db.product.findMany({ include: { units: ... } }) call. Seeds the
  // packaging-unit consistency check (see the function-level note below).
  const existingProducts = await listAllProductsWithUnitsForPackagingCheck(db, tenantId);

  const existingProductUnitsByKey = new Map<string, PackagingUnit[]>();
  for (const p of existingProducts) {
    const key = normalizeProductKey(p.name, p.category);
    existingProductUnitsByKey.set(
      key,
      p.units.map((u) => ({
        unitName: u.unitName,
        conversionFactor: u.conversionFactor,
      }))
    );
  }

  // Running combined unit list per (name, category) key across this whole
  // file — seeded from existingProductUnitsByKey the first time a key is
  // seen, then extended in place as each accepted row adds its own unit.
  const productUnitsSoFarByKey = new Map<string, PackagingUnit[]>();

  // Track new products created earlier in this file to handle in-file duplicate barcodes sequentially
  const inFileDataBarcodeMap = new Map<string, NewProductImportData>();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const lineNumber = i + 2; // Line 1 is header
    const rowContentSummary = Object.entries(row)
      .map(([k, v]) => `${k}: ${v}`)
      .join(", ");

    // [v4.5] Zero, one, or many barcodes for this row. The delimited
    // `barcodes` column is authoritative; the legacy single `barcode` column is
    // still accepted (a template saved before v4.5) and folded in ONLY when
    // `barcodes` is empty — the same precedence both product routes and both
    // product modals apply to their own legacy scalar shim.
    const rawBarcodesCell = (row.barcodes || "").trim();
    const legacyBarcodeCell = (row.barcode || "").trim();
    const rowBarcodeValues =
      rawBarcodesCell.length > 0
        ? splitBarcodeCell(rawBarcodesCell)
        : splitBarcodeCell(legacyBarcodeCell);
    // Parsed once per row: this column is row-wide (one source applies to
    // every barcode in the cell), because a single CSV cell cannot carry a
    // per-barcode source — see the template's own help text.
    const rowBarcodeSource = parseBarcodeSourceCell(row.barcodeSource);
    const name = (row.name || "").trim();
    const category = (row.category || "").trim() || undefined;
    const unitName = (row.unitName || "").trim();
    const rawBatchNumber = (row.initialBatchNumber || row.batchNumber || "").trim();
    const rawQuantity = (row.initialQuantity || row.quantity || "").trim();
    // [v4.4, T4g] Always SYP, always per the product's base unit — no
    // currency column applies to this figure.
    const rawCostPrice = (row.costPrice || "").trim();
    const rawFactor = (row.conversionFactor || "").trim();
    const rawPrice = (row.priceWholesale || "").trim();
    const rawCurrency = (row.pricingCurrency || "").trim().toUpperCase();
    const expiryDateStr = (row.expiryDate || "").trim() || undefined;

    if (!rawPrice || !DECIMAL_STRING_REGEX.test(rawPrice) || Number(rawPrice) <= 0) {
      rejectedRows.push({
        lineNumber,
        rowContent: rowContentSummary,
        reason: `السطر ${lineNumber}: السعر يجب أن يكون رقماً موجباً أكبر من الصفر.`,
      });
      continue;
    }

    // Barcode check: does ANY barcode on this row already belong to a unit in
    // the live DB? First match wins — a tenant-wide barcode identifies exactly
    // one unit (ProductUnitBarcode is @@unique([tenantId, barcode])), so at
    // most one of the row's values can match, but checking all of them is what
    // makes a row work when it carries several barcodes for the same product.
    const existingMatch = rowBarcodeValues
      .map((value) => barcodeMap.get(value))
      .find((hit) => hit !== undefined);
    if (existingMatch) {
      const { unit: existingUnit, barcode: matchedBarcode } = existingMatch;

      // [FIX] A price-update row writes NO barcode rows. If the row also
      // carries a barcode that does NOT belong to this same unit, that value
      // would be dropped silently. Reject instead, so the merchant knows.
      const ownBarcodes = new Set((existingUnit.barcodes ?? []).map((b) => b.barcode.trim()));
      const foreign = rowBarcodeValues.filter((v) => !ownBarcodes.has(v));
      if (foreign.length > 0) {
        rejectedRows.push({
          lineNumber,
          rowContent: rowContentSummary,
          reason: `السطر ${lineNumber}: الصف يحتوي على باركود لا ينتمي لنفس الوحدة (${foreign.join("، ")}) — لن يتم حفظه. أزل الباركود الزائد أو أضفه من شاشة تعديل المنتج.`,
        });
        continue;
      }

      priceUpdates.push({
        lineNumber,
        barcode: matchedBarcode,
        productName: existingUnit.productName || name || "منتج غير مسمى",
        unitName: existingUnit.unitName,
        // [FIX] decimal string, never Number().
        currentPriceWholesale: existingUnit.priceWholesale ?? "0",
        newPriceWholesale: rawPrice,
        pricingCurrency: existingUnit.pricingCurrency,
        unitId: existingUnit.id,
      });
      continue;
    }

    // Barcode check: introduced by an earlier row in the same CSV?
    // (The local key is deliberately NOT named `product` — eslint.config.mjs's
    // PRODUCT_MODEL_RULES bans a `.product`/`.productUnit` MEMBER ACCESS by
    // name anywhere outside lib/data/products.ts, and it cannot tell a plain
    // local field apart from a Prisma relation. See
    // createProductWithBaseUnit()'s identical `createdProduct` rename.)
    const earlierEntry = rowBarcodeValues
      .map((value) => ({ value, matchedRow: inFileDataBarcodeMap.get(value) }))
      .find((hit) => hit.matchedRow !== undefined);
    if (earlierEntry?.matchedRow) {
      const earlierNewProduct = earlierEntry.matchedRow;

      // [FIX] Same silent-drop guard as the existing-unit branch above.
      const ownEarlier = new Set(earlierNewProduct.barcodes.map((b) => b.barcode));
      const foreignEarlier = rowBarcodeValues.filter((v) => !ownEarlier.has(v));
      if (foreignEarlier.length > 0) {
        rejectedRows.push({
          lineNumber,
          rowContent: rowContentSummary,
          reason: `السطر ${lineNumber}: الصف يحتوي على باركود لا ينتمي لنفس الوحدة (${foreignEarlier.join("، ")}) — لن يتم حفظه.`,
        });
        continue;
      }

      priceUpdates.push({
        lineNumber,
        barcode: earlierEntry.value,
        productName: earlierNewProduct.name,
        unitName: earlierNewProduct.unitName,
        // [FIX] decimal string, never Number().
        currentPriceWholesale: earlierNewProduct.priceWholesale.toString(),
        newPriceWholesale: rawPrice,
        pricingCurrency: earlierNewProduct.pricingCurrency || "SYP",
        unitId: `pending-${earlierEntry.value}`,
      });
      continue;
    }

    // From this point on, the row is definitely a net-new product/unit row.

    if (expiryDateStr) {
      if (!STRICT_DATE_REGEX.test(expiryDateStr)) {
        rejectedRows.push({
          lineNumber,
          rowContent: rowContentSummary,
          reason: `السطر ${lineNumber}: تاريخ الانتهاء يجب أن يكون بالصيغة YYYY-MM-DD (مثال: 2026-12-31).`,
        });
        continue;
      }
      // [FIX] Real calendar check — see the import note above.
      if (!isRealCalendarDate(expiryDateStr)) {
        rejectedRows.push({
          lineNumber,
          rowContent: rowContentSummary,
          reason: `السطر ${lineNumber}: تاريخ الانتهاء غير صالح.`,
        });
        continue;
      }
    }

    let pricingCurrency: "SYP" | "USD" = "SYP";
    if (rawCurrency) {
      if (rawCurrency !== "SYP" && rawCurrency !== "USD") {
        rejectedRows.push({
          lineNumber,
          rowContent: rowContentSummary,
          reason: `السطر ${lineNumber}: عملة التسعير "${row.pricingCurrency}" غير صالحة. العملات المدعومة هي SYP أو USD فقط.`,
        });
        continue;
      }
      pricingCurrency = rawCurrency;
    }

    const missingFields: string[] = [];
    if (!name) missingFields.push("اسم المنتج");
    if (!unitName) missingFields.push("اسم الوحدة");
    if (!rawFactor || !DECIMAL_STRING_REGEX.test(rawFactor) || Number(rawFactor) <= 0) {
      missingFields.push("معامل التحويل");
    }
    if (!rawQuantity || !DECIMAL_STRING_REGEX.test(rawQuantity) || Number(rawQuantity) < 0) {
      missingFields.push("الكمية الأولية");
    }
    if (!rawBatchNumber) {
      missingFields.push("رقم الدفعة الأولى");
    }
    // [v4.4, T4g] Required for every row that reaches this point — this
    // code path only runs for rows that will create a NEW ProductBatch
    // (either a genuinely new product, or a new additional packaging unit
    // on an existing one). A row that merely updates an existing,
    // barcode-matched unit returned earlier above and never gets here.
    // Validated with the same positivity rule as every other cost input:
    // a zero/negative/malformed value is "missing" for this purpose, so it
    // is named in the report the same way rather than silently accepted.
    if (!rawCostPrice || !DECIMAL_STRING_REGEX.test(rawCostPrice) || Number(rawCostPrice) <= 0) {
      missingFields.push("سعر التكلفة");
    }
    // [v4.5] The `barcodeSource` column is MANDATORY for any row that supplies
    // one or more barcodes: a barcode value and its human-confirmed source
    // always travel together, and the source is NEVER inferred from the value's
    // digit shape (T3a §5). Deliberately checked HERE, in the new-product
    // branch, rather than before the barcode-match checks above: a row whose
    // barcode already resolved to an existing unit is a pure price-update row
    // that writes no barcode row at all, so it legitimately needs no source —
    // which is exactly why the downloadable template's price-only example row
    // leaves this column empty.
    if (rowBarcodeValues.length > 0 && !rowBarcodeSource) {
      missingFields.push("مصدر الباركود (GS1 أو INTERNAL)");
    }

    if (missingFields.length > 0) {
      rejectedRows.push({
        lineNumber,
        rowContent: rowContentSummary,
        reason: `السطر ${lineNumber}: الحقول التالية مطلوبة للمنتجات الجديدة: ${missingFields.join("، ")}.`,
      });
      continue;
    }

    // [UNCHANGED — this is the correct, deciding check] The candidate set
    // is either [this row's unit alone] (genuinely new product — must be
    // factor 1) or [existing/earlier-in-file units ..., this row's unit]
    // (additional unit — must NOT duplicate an existing factor and must
    // not itself be a second factor-1 unit). This is what actually
    // decides whether a given conversionFactor value is acceptable — NOT
    // a blanket "must equal 1" rule at the API-schema layer, which would
    // incorrectly reject legitimate additional-packaging-unit rows.
    const productKey = normalizeProductKey(name, category);
    if (!productUnitsSoFarByKey.has(productKey)) {
      productUnitsSoFarByKey.set(productKey, [...(existingProductUnitsByKey.get(productKey) || [])]);
    }
    const unitsSoFarForProduct = productUnitsSoFarByKey.get(productKey)!;
    const candidateUnits: PackagingUnit[] = [
      ...unitsSoFarForProduct,
      { unitName, conversionFactor: rawFactor },
    ];

    const packagingCheck = validatePackagingUnits(candidateUnits);
    if (!packagingCheck.valid) {
      rejectedRows.push({
        lineNumber,
        rowContent: rowContentSummary,
        reason: `السطر ${lineNumber}: ${packagingCheck.error}`,
      });
      continue;
    }

    const newProductData: NewProductImportData = {
      lineNumber,
      // The invariant enforced by the missingFields check directly above: a
      // NON-EMPTY barcode list always has a non-null source, so this ternary
      // can never silently drop a barcode. An unclassified barcode is a
      // rejected row, never a stored one.
      barcodes: rowBarcodeSource
        ? rowBarcodeValues.map((value) => ({ barcode: value, barcodeSource: rowBarcodeSource }))
        : [],
      name,
      category,
      unitName,
      conversionFactor: rawFactor,
      priceWholesale: rawPrice,
      pricingCurrency,
      initialBatchNumber: rawBatchNumber,
      initialQuantity: rawQuantity,
      costPrice: rawCostPrice,
      batchNumber: rawBatchNumber,
      quantity: rawQuantity,
      expiryDate: expiryDateStr,
    };

    newProducts.push(newProductData);
    productUnitsSoFarByKey.set(productKey, candidateUnits);

    // EVERY barcode of this row indexes back to it, so a later row carrying any
    // ONE of them is handled as a price update for the unit created here — the
    // old single-value sequential behaviour, generalised to N barcodes.
    for (const entry of newProductData.barcodes) {
      inFileDataBarcodeMap.set(entry.barcode, newProductData);
    }
  }

  return {
    summary: {
      totalRows,
      newProductsCount: newProducts.length,
      priceUpdatesCount: priceUpdates.length,
      rejectedRowsCount: rejectedRows.length,
    },
    newProducts,
    priceUpdates,
    rejectedRows,
  };
}

export interface CommitCsvImportResult {
  createdProductsCount: number;
  updatedPricesCount: number;
  skippedPriceUpdates: { lineNumber: number; barcode: string; unitName: string; reason: string }[];
  failedNewProducts: { lineNumber: number; name: string; barcode?: string; reason: string }[];
  failedPriceUpdates: { lineNumber: number; barcode: string; unitName: string; reason: string }[];
}

/**
 * Import Confirmation (Pass 2): Strictly sequential per-row execution.
 *
 * [FIX — critical, two real v4.0 bugs closed]
 *
 * BUG 1: a genuinely new product created via CSV previously never had
 * Product.baseUnitId set at all (the old code called rowTx.product.create()
 * directly and never called commitBaseUnitLink()) — every such product was
 * left in a structurally broken state that would throw
 * MissingBaseUnitError the moment anything (POS, inventory screen, sync)
 * tried to resolve its base unit. Fixed: a genuinely new product now goes
 * through lib/data/products.ts's createProductWithBaseUnit(), which
 * creates the Product + its base ProductUnit + the baseUnitId link as one
 * atomic three-write transaction (per T1's nested-write rule) — exactly
 * the same path the manual product-creation route uses.
 *
 * BUG 2: a CSV row adding an ADDITIONAL packaging unit to an
 * already-existing product previously wrote the initial batch's quantity
 * directly against the newly-created (non-base) unit, with no conversion
 * — reopening the historical "21.9984 قطعة" rounding bug via the CSV path.
 * Fixed: the new unit is created via createAdditionalUnit() (never as the
 * base unit), the product's REAL base unit is resolved via
 * requireBaseUnit(), and the entered quantity is converted into the base
 * unit via toBaseUnit() — using the NEWLY-ENTERED unit's own
 * conversionFactor (trusted here because it's the exact value used to
 * create that same unit within this same transaction, not a
 * separately-submitted later payload — contrast with T4c/T5, which must
 * re-fetch the factor from the DB instead of trusting a client payload)
 * — before the ProductBatch row is ever written.
 *
 * [FIX] Result counters (created/updated/skipped) are now incremented AFTER
 * the per-row $transaction resolves, from the value the callback returns —
 * never from inside the callback. A commit failure after the callback ran
 * therefore can no longer leave a row counted as created/updated.
 *
 * All model access now goes through lib/data/products.ts /
 * lib/inventory/base-unit.ts — this file no longer calls
 * rowTx.product./rowTx.productUnit.* directly anywhere.
 */
/**
 * [v4.5] Human-readable rendering of ONE imported row's barcodes, for the
 * merchant-facing failure report (`failedNewProducts[].barcode`).
 *
 * A single barcode renders EXACTLY as it always did ("621000111222"), so the
 * existing failure-message text is unchanged for the overwhelmingly common
 * one-barcode row; several are joined with the same Arabic comma the
 * multi-value UI uses. `undefined` when the row carried no barcode at all.
 */
function barcodeSummary(np: NewProductImportData): string | undefined {
  if (np.barcodes.length === 0) return undefined;
  return np.barcodes.map((entry) => entry.barcode).join("، ");
}

/**
 * [v4.5] Attaches every confirmed barcode of ONE imported row to the unit that
 * row just created, then reconciles the GS1 ones against the shared catalog.
 *
 * THE single place in this file that writes a ProductUnitBarcode row: both
 * creation branches of commitCsvImport() call it, so the base-unit path and
 * the additional-packaging-unit path cannot drift apart. Each createUnitBarcode()
 * is its own top-level call inside the caller's transaction (T1's nested-write
 * ban — never `barcodes: { create: ... }`), and `tenantId` is passed explicitly
 * for the same belt-and-suspenders reason lib/data/products.ts documents.
 */
async function attachRowBarcodes(
  tx: TxOrClient,
  tenantId: string,
  unitId: string,
  np: NewProductImportData
): Promise<void> {
  for (const entry of np.barcodes) {
    await createUnitBarcode(tx, tenantId, unitId, {
      barcode: entry.barcode,
      barcodeSource: entry.barcodeSource,
    });
  }

  // GS1 shared-catalog reconciliation — the same request-scoped continuity rule
  // as app/api/inventory/products/route.ts's POST and the [id] route's PATCH:
  // the first GS1 barcode of this row creates (or resolves to) exactly ONE
  // ProductCatalogEntry, and every later GS1 barcode of the same row LINKS to
  // that same entry rather than creating a near-duplicate. INTERNAL barcodes
  // never enter the cross-tenant catalog (T3a §5). A barcode the platform
  // already knows simply resolves to its own existing entry — nothing is
  // rewritten.
  let sharedCatalogEntryId: string | null = null;
  for (const entry of np.barcodes) {
    if (entry.barcodeSource !== "GS1") continue;
    sharedCatalogEntryId = await resolveSharedCatalogForBarcode(tx, {
      barcode: entry.barcode,
      name: np.name.trim(),
      category: np.category?.trim() || null,
      // The CSV format has no image column, so a CSV-created catalog entry is
      // image-less — exactly like a manually created product whose unit has no
      // image. Never a fabricated placeholder.
      imageUrl: null,
      addedByTenantId: tenantId,
      preferEntryId: sharedCatalogEntryId,
    });
  }
}

export async function commitCsvImport(
  db: PrismaWriteClient,
  tenantId: string,
  payload: {
    newProducts: NewProductImportData[];
    priceUpdates: PriceUpdateImportData[];
  }
): Promise<CommitCsvImportResult> {
  let updatedPricesCount = 0;
  let createdProductsCount = 0;
  const skippedPriceUpdates: CommitCsvImportResult["skippedPriceUpdates"] = [];
  const failedNewProducts: CommitCsvImportResult["failedNewProducts"] = [];
  const failedPriceUpdates: CommitCsvImportResult["failedPriceUpdates"] = [];

  type QueueItem =
    | { type: "new"; data: NewProductImportData }
    | { type: "update"; data: PriceUpdateImportData };

  const queue: QueueItem[] = [
    ...payload.newProducts.map((np) => ({ type: "new" as const, data: np })),
    ...payload.priceUpdates.map((pu) => ({ type: "update" as const, data: pu })),
  ].sort((a, b) => a.data.lineNumber - b.data.lineNumber);

  for (const item of queue) {
    if (item.type === "update") {
      const update = item.data;
      try {
        const outcome = await db.$transaction(async (rowTx) => {
          let unitToUpdate: { id: string } | null = null;

          if (update.barcode) {
            // [FIX] Routed through lib/data/products.ts.
            const found = await findProductUnitByBarcode(rowTx, tenantId, update.barcode.trim());
            if (found) unitToUpdate = { id: found.id };
          }

          if (!unitToUpdate && update.unitId && !update.unitId.startsWith("pending-")) {
            // [FIX] Routed through lib/data/products.ts.
            const found = await findProductUnitById(rowTx, tenantId, update.unitId);
            if (found) unitToUpdate = { id: found.id };
          }

          if (!unitToUpdate) return "skipped" as const;

          // [FIX] Routed through lib/data/products.ts.
          await updateProductUnit(rowTx, tenantId, unitToUpdate.id, {
            priceWholesale: update.newPriceWholesale.toString(),
          });

          return "updated" as const;
        });

        if (outcome === "skipped") {
          skippedPriceUpdates.push({
            lineNumber: update.lineNumber,
            barcode: update.barcode,
            unitName: update.unitName,
            reason: `السطر ${update.lineNumber}: تعذّر إيجاد الوحدة المطابقة للباركود (${update.barcode}) — قد يكون الصف الذي كان يفترض إنشاء هذه الوحدة سابقاً في هذا الملف قد فشل.`,
          });
        } else {
          updatedPricesCount++;
        }
      } catch (error) {
        const reason =
          error instanceof Error
            ? `السطر ${update.lineNumber}: تعذّر تحديث السعر (${error.message}).`
            : `السطر ${update.lineNumber}: تعذّر تحديث السعر بسبب خطأ غير متوقع.`;
        failedPriceUpdates.push({
          lineNumber: update.lineNumber,
          barcode: update.barcode,
          unitName: update.unitName,
          reason,
        });
      }
    } else {
      const np = item.data;
      try {
        const outcome = await db.$transaction(async (rowTx) => {
          // 1. Live DB check: does ANY of this row's barcodes already exist?
          //    [v4.5] Loops the whole list rather than one scalar value — the
          //    same first-match-wins resolution preview used, re-run against
          //    the live DB because state can change between preview and commit.
          if (np.barcodes.length > 0) {
            for (const entry of np.barcodes) {
              const existingUnit = await findProductUnitByBarcode(rowTx, tenantId, entry.barcode);
              if (existingUnit) {
                await updateProductUnit(rowTx, tenantId, existingUnit.id, {
                  priceWholesale: np.priceWholesale.toString(),
                });
                return "updated-existing" as const;
              }
            }
          }

          // 2. Name & Category match — CONFIRMED case-insensitive on both
          // fields. [FIX] Routed through lib/data/products.ts.
          const existingProduct = await findProductByNameCategory(
            rowTx,
            tenantId,
            np.name.trim(),
            np.category?.trim() || null
          );

          const liveUnitsForProduct: PackagingUnit[] = existingProduct
            ? existingProduct.units.map((u) => ({ unitName: u.unitName, conversionFactor: u.conversionFactor }))
            : [];

          // [FIX — critical] Live re-validation against the product's
          // ACTUAL current units, never trusting preview's earlier check.
          const candidateUnits: PackagingUnit[] = [
            ...liveUnitsForProduct,
            { unitName: np.unitName.trim(), conversionFactor: np.conversionFactor.toString() },
          ];
          const packagingCheck = validatePackagingUnits(candidateUnits);
          if (!packagingCheck.valid) {
            throw new PackagingConsistencyError(
              packagingCheck.error || "فشل التحقق من اتساق وحدات التعبئة."
            );
          }

          const batchQty = (np.initialQuantity !== undefined ? np.initialQuantity : np.quantity)!.toString();
          const expDate = np.expiryDate ? new Date(np.expiryDate) : null;
          // [v4.4, Sections 10.2 + T4g] The column holds the MERCHANT-SUPPLIED
          // SUFFIX only — the stored value always carries the server-date
          // prefix, built through the same shared constructBatchNumber() the
          // single-batch and multi-product screens use. The column's raw
          // value is NEVER written verbatim into ProductBatch.batchNumber.
          const batchNum = constructBatchNumber((np.initialBatchNumber || np.batchNumber)!.trim());
          // Always SYP, always per the product's BASE unit, taken as-is — no
          // conversionFactor division (unlike the quantity below).
          const costPricePerBaseUnit = np.costPrice.toString();

          if (!existingProduct) {
            // [FIX — BUG 1] Genuinely new product: created atomically with
            // its base unit via createProductWithBaseUnit() — Product +
            // base ProductUnit + baseUnitId link, all in one transaction.
            // validatePackagingUnits() above already guarantees
            // np.conversionFactor === "1" here (a lone candidate unit must
            // be the base unit), so this is exactly the base unit.
            const { createdProduct, createdBaseUnit } = await createProductWithBaseUnit(
              rowTx,
              tenantId,
              { name: np.name.trim(), category: np.category?.trim() || null, isPublic: false },
              {
                unitName: np.unitName.trim(),
                pricingCurrency: np.pricingCurrency || "SYP",
                priceWholesale: np.priceWholesale.toString(),
                // [v4.5] No barcode/barcodeSource keys here any more: those
                // scalars were removed from ProductUnit, and SafeProductUnitCreate
                // (this parameter's type) no longer declares them. This unit's
                // barcodes are attached immediately below, as separate
                // ProductUnitBarcode rows inside this SAME transaction.
                isActive: true,
              }
            );

            // [v4.5] This row's confirmed barcodes (zero, one, or many) — each
            // its own top-level row via the model's single sanctioned gateway.
            await attachRowBarcodes(rowTx, tenantId, createdBaseUnit.id, np);

            // The base unit's own factor is always exactly 1 — no
            // conversion changes the quantity, but toBaseUnit() is still
            // called for consistency/auditability with every other write
            // path in this codebase.
            const baseQty = toBaseUnit(batchQty, BASE_UNIT_CONVERSION_FACTOR);

            await rowTx.productBatch.create({
              data: {
                tenantId,
                productId: createdProduct.id,
                unitId: createdBaseUnit.id,
                batchNumber: batchNum,
                quantity: baseQty.toString(),
                // [v4.4, T4g] Required, non-nullable — see the field's own note
                // above this transaction.
                costPricePerBaseUnit,
                expiryDate: expDate,
              },
            });

            return "created" as const;
          }

          // [FIX — BUG 2] Additional packaging unit on an existing
          // product: created via createAdditionalUnit() (never as the
          // base unit), and the initial quantity is converted into the
          // product's REAL base unit before the ProductBatch is
          // written — never against the newly-created non-base unit.
          const createdUnit = await createAdditionalUnit(
            rowTx,
            tenantId,
            existingProduct.id,
            np.conversionFactor.toString(),
            {
              unitName: np.unitName.trim(),
              pricingCurrency: np.pricingCurrency || "SYP",
              priceWholesale: np.priceWholesale.toString(),
              // [v4.5] Same removal as the base-unit branch above — the
              // unit's barcodes are separate ProductUnitBarcode rows, written
              // immediately below inside this same transaction.
              isActive: true,
            }
          );

          // [v4.5] Same per-barcode treatment as the base-unit branch.
          await attachRowBarcodes(rowTx, tenantId, createdUnit.id, np);

          const baseUnit = await requireBaseUnit(rowTx, tenantId, existingProduct.id);
          const baseQty = toBaseUnit(batchQty, np.conversionFactor.toString());

          await rowTx.productBatch.create({
            data: {
              tenantId,
              productId: existingProduct.id,
              unitId: baseUnit.id,
              batchNumber: batchNum,
              quantity: baseQty.toString(),
              // [v4.4, T4g] Required, non-nullable — see the field's own note
              // above this transaction.
              costPricePerBaseUnit,
              expiryDate: expDate,
            },
          });

          return "created" as const;
        });

        // [FIX] Counted only after the transaction has actually resolved.
        if (outcome === "created") createdProductsCount++;
        else updatedPricesCount++;
      } catch (error) {
        if (error instanceof PackagingConsistencyError) {
          failedNewProducts.push({
            lineNumber: np.lineNumber,
            name: np.name,
            barcode: barcodeSummary(np),
            reason: `السطر ${np.lineNumber}: ${error.message}`,
          });
          continue;
        }

        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          failedNewProducts.push({
            lineNumber: np.lineNumber,
            name: np.name,
            barcode: barcodeSummary(np),
            reason: `السطر ${np.lineNumber}: تعارض في الباركود (${barcodeSummary(np)}) — تم إنشاؤه مسبقاً ضمن هذا الملف أو في قاعدة البيانات.`,
          });
          continue;
        }

        const reason =
          error instanceof Error
            ? `السطر ${np.lineNumber}: تعذّر إنشاء المنتج (${error.message}).`
            : `السطر ${np.lineNumber}: تعذّر إنشاء المنتج بسبب خطأ غير متوقع.`;

        failedNewProducts.push({
          lineNumber: np.lineNumber,
          name: np.name,
          barcode: barcodeSummary(np),
          reason,
        });
      }
    }
  }

  return {
    createdProductsCount,
    updatedPricesCount,
    skippedPriceUpdates,
    failedNewProducts,
    failedPriceUpdates,
  };
}

class PackagingConsistencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PackagingConsistencyError";
  }
}

function normalizeHeaderKey(key: string): string {
  const k = key.trim().toLowerCase();
  // [v4.5] Two barcode columns now. `barcodes` is the authoritative, DELIMITED
  // one; the legacy singular `barcode` is still recognised so a file saved
  // before v4.5 keeps importing (its single value is folded into `barcodes` by
  // the row-parsing block, only when `barcodes` is empty). If a file somehow
  // carries both columns, `barcodes` wins — deterministic, not order-dependent.
  if (["barcodes", "الباركودات", "باركودات", "رموز الباركود"].includes(k)) return "barcodes";
  if (["barcode", "الباركود", "باركود", "رمز الباركود", "رمز_الباركود"].includes(k)) return "barcode";
  // [v4.5] The mandatory source column — English name plus its Arabic
  // equivalents, the same courtesy every other column gets.
  if (["barcodesource", "barcode_source", "مصدر الباركود", "مصدر_الباركود"].includes(k)) return "barcodeSource";
  if (["name", "اسم المنتج", "الاسم", "اسم_المنتج", "اسم"].includes(k)) return "name";
  if (["category", "التصنيف", "الفئة", "قسم"].includes(k)) return "category";
  if (["unitname", "unit", "اسم الوحدة", "الوحدة", "اسم_الوحدة"].includes(k)) return "unitName";
  if (["conversionfactor", "factor", "معامل التحويل", "معامل_التحويل", "المعامل"].includes(k)) return "conversionFactor";
  if (["pricewholesale", "priceusd", "price", "السعر", "السعر (usd)", "السعر_بالدولار", "سعر_البيع", "سعر_الجملة", "سعر الجملة"].includes(k)) return "priceWholesale";
  if (["pricingcurrency", "currency", "العملة", "عملة_السعر", "عملة السعر"].includes(k)) return "pricingCurrency";
  if (["initialbatchnumber", "batchnumber", "batch", "رقم الدفعة", "رقم_الدفعة", "الدفعة", "رقم الدفعة الأولى", "رقم_الدفعة_الأولى", "الدفعة الأولى", "الدفعة_الأولى"].includes(k)) return "initialBatchNumber";
  // [v4.4, T4g] costPrice is its own column, always SYP per base unit. Kept
  // clearly separate from the priceWholesale aliases above: it is an
  // internal cost figure, never a customer-facing price, and never
  // denominated in the row's pricingCurrency.
  if (["costprice", "cost", "costpriceperbaseunit", "سعر التكلفة", "سعر_التكلفة", "التكلفة", "تكلفة", "الكلفة", "سعر الكلفة", "سعر_الكلفة"].includes(k)) return "costPrice";
  if (["initialquantity", "quantity", "qty", "الكمية", "العدد", "كمية_المخزون", "الكمية الأولى", "الكمية_الأولية", "الكمية الأولية"].includes(k)) return "initialQuantity";
  if (["expirydate", "expiry", "تاريخ الانتهاء", "تاريخ_الانتهاء", "تاريخ الصلاحية"].includes(k)) return "expiryDate";
  return k;
}