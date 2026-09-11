import Papa from "papaparse";
import { Prisma } from "@prisma/client";
import type { getTenantDb } from "@/lib/db/tenant-scope";
import { validatePackagingUnits, type PackagingUnit } from "./conversions";

export interface CsvRowRaw {
  [key: string]: string | undefined;
}

export interface NewProductImportData {
  lineNumber: number;
  barcode?: string;
  name: string;
  category?: string;
  unitName: string;
  conversionFactor: string | number;
  priceWholesale: string | number;
  priceRetail?: string | number | null;
  pricingCurrency?: "SYP" | "USD";
  initialBatchNumber: string;
  initialQuantity: string | number;
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
// directly. That let a caller compile-clean while passing in the raw
// `prisma` export from lib/db.ts — which is exactly what
// app/api/inventory/csv/commit/route.ts was doing before its own fix.
// Every tenant-isolation guarantee in this file's row-processing logic
// below rests entirely on the manual `tenantId` filtering written into
// each query — correct today, but with zero structural backstop if a
// future edit to this file ever missed one on a new query.
//
// `TenantScopedDb` is the actual type returned by getTenantDb(tenantId) —
// the tenant-scoped Prisma Client Extension (see lib/db/tenant-scope.ts).
// Typing both client parameters against it means a caller that tries to
// pass the raw `prisma` client (a plain PrismaClient) or a raw
// `Prisma.TransactionClient` now fails to compile, instead of silently
// bypassing tenant scoping. This file has no structural reason to accept
// a raw transaction client the way T4c's /api/sync route or
// lib/inventory/fifo.ts's commitFifoAllocation() do (see lib/db.ts's
// category-5 note for why THOSE two are the documented exception) — CSV
// import never hands its transaction into a shared helper that requires
// the raw `Prisma.TransactionClient` type, so there's no reason to widen
// this file's accepted type to match.
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
 * Two-Pass Validation (Pass 1): Parse & Validate CSV without writing to DB
 *
 * T3d Rules:
 * 1. Barcode match against existing DB unit -> Price update only.
 * 2. Barcode match against an earlier row's new product in the same file -> Price update (sequential visibility).
 * 3. Net-new product (unmatched barcode) requires 4 mandatory columns:
 *    - unitName
 *    - conversionFactor (> 0)
 *    - initialQuantity (>= 0)
 *    - initialBatchNumber
 *    Plus name and priceWholesale (> 0). Missing any rejects the row outright naming all missing fields.
 * 4. Currency validation: if provided, must strictly be "SYP" or "USD" (case-insensitive); defaults to "SYP" if empty.
 * 5. Decimal strings are preserved end-to-end to prevent IEEE-754 precision loss.
 * 6. [FIX — critical] Packaging-unit consistency (T3a's confirmed rule: every
 *    product must have exactly one unit with conversionFactor === 1, and no
 *    two units on the same product may share a conversionFactor) is now
 *    enforced for every CSV-introduced unit, via the SAME validatePackagingUnits()
 *    function conversions.ts already uses for the manual add/edit path —
 *    never a separate, CSV-specific reimplementation of this rule.
 *
 *    This was a real gap: previously, a CSV row for a genuinely brand-new
 *    product (no barcode match, no existing product by name/category) could
 *    be imported with ANY conversionFactor — e.g. 12 — leaving that product
 *    with no base unit (factor === 1) at all. Such a product would then be
 *    permanently stuck: EditProductModal's manual edit path (T3a) calls
 *    validatePackagingUnits() and would refuse any further edit to that
 *    product until a base unit exists, but there is no way to add one
 *    without going through that same blocked edit path.
 *
 *    The fix distinguishes two cases, both resolved by feeding the FULL
 *    resulting unit set (not just the new row's own single unit) through
 *    validatePackagingUnits():
 *      a) The row targets a genuinely new product (no existing DB product,
 *         no earlier-in-file row, matches this exact (name, category)):
 *         the candidate set is just this row's own unit alone — validatePackagingUnits
 *         then requires it to be exactly conversionFactor === 1, since a
 *         lone unit that isn't the base unit fails the "at least one base
 *         unit" rule.
 *      b) The row attaches a new packaging unit to a product that already
 *         exists (in the DB, or introduced earlier in this same file): the
 *         candidate set is [...that product's already-known units, this
 *         row's new unit] — validatePackagingUnits then correctly allows
 *         a non-1 factor (e.g. 12 for "كرتونة") as long as it doesn't
 *         duplicate an existing factor and a base unit already exists
 *         somewhere in the combined set.
 *    `productUnitsSoFarByKey` tracks the running combined unit list per
 *    (name, category) key across the whole file, seeded from each
 *    product's real DB units the first time that key is encountered.
 *
 * NOTE (known, documented limitation — cosmetic, not a correctness bug):
 * `summary.newProductsCount` counts every row that lands in `newProducts`,
 * which includes both "brand-new Product" rows and "new packaging unit on
 * an already-existing Product" rows — it does not distinguish the two for
 * reporting purposes. The actual database write is always correct (a
 * name/category match always reuses the existing Product, per case a)
 * above) — this only means the preview count isn't a precise "how many new
 * Product rows will be created" figure. Revisit only if merchants report
 * this as confusing in practice.
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

  const existingUnits = await db.productUnit.findMany({
    where: {
      tenantId,
    },
    include: {
      product: true,
    },
  });

  const barcodeMap = new Map<string, (typeof existingUnits)[number]>();

  for (const u of existingUnits) {
    if (u.barcode) {
      barcodeMap.set(u.barcode.trim(), u);
    }
  }

  // [FIX] Fetched once up front, alongside existingUnits above, purely to
  // seed the packaging-unit consistency check (see the function-level note
  // above). Keyed by normalizeProductKey(name, category) so a CSV row can
  // be checked against the real, already-committed packaging units of
  // whatever product it will attach to.
  const existingProducts = await db.product.findMany({
    where: { tenantId },
    include: {
      units: { select: { unitName: true, conversionFactor: true } },
    },
  });

  const existingProductUnitsByKey = new Map<string, PackagingUnit[]>();
  for (const p of existingProducts) {
    const key = normalizeProductKey(p.name, p.category);
    existingProductUnitsByKey.set(
      key,
      p.units.map((u) => ({
        unitName: u.unitName,
        conversionFactor: u.conversionFactor.toString(),
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

    const barcode = (row.barcode || "").trim();
    const name = (row.name || "").trim();
    const category = (row.category || "").trim() || undefined;
    const unitName = (row.unitName || "").trim();
    const rawBatchNumber = (row.initialBatchNumber || row.batchNumber || "").trim();
    const rawQuantity = (row.initialQuantity || row.quantity || "").trim();
    const rawFactor = (row.conversionFactor || "").trim();
    const rawPrice = (row.priceWholesale || "").trim();
    const rawRetail = (row.priceRetail || "").trim();
    const rawCurrency = (row.pricingCurrency || "").trim().toUpperCase();
    const expiryDateStr = (row.expiryDate || "").trim() || undefined;

    // Validate price wholesale format — shared by BOTH a price-update row
    // and a net-new row, since both use rawPrice as "the price to write."
    if (!rawPrice || !DECIMAL_STRING_REGEX.test(rawPrice) || Number(rawPrice) <= 0) {
      rejectedRows.push({
        lineNumber,
        rowContent: rowContentSummary,
        reason: `السطر ${lineNumber}: السعر يجب أن يكون رقماً موجباً أكبر من الصفر.`,
      });
      continue;
    }

    // [FIX — reordering] Barcode-match determination now happens
    // immediately after the one check both row types share (price), and
    // BEFORE priceRetail/expiryDate validation. Those two fields are only
    // ever used on a net-new row (PriceUpdateImportData has neither field
    // at all) — validating them for a price-update row was rejecting rows
    // over data that row would never actually use, e.g. a merchant
    // updating only the price of an existing product via CSV, whose file
    // happens to carry a stray/malformed priceRetail or expiryDate column
    // left over from a different template.

    // Barcode check: existing in DB?
    const existingUnit = barcode ? barcodeMap.get(barcode) : undefined;
    if (existingUnit) {
      // Barcode match found in DB -> update priceWholesale only
      const existingCurrency = existingUnit.pricingCurrency as "SYP" | "USD";

      priceUpdates.push({
        lineNumber,
        barcode: existingUnit.barcode || barcode,
        productName: existingUnit.product?.name || name || "منتج غير مسمى",
        unitName: existingUnit.unitName,
        currentPriceWholesale: Number(existingUnit.priceWholesale ?? 0),
        newPriceWholesale: rawPrice,
        pricingCurrency: existingCurrency,
        unitId: existingUnit.id,
      });
      continue;
    }

    // Barcode check: introduced by an earlier row in the same CSV?
    const earlierNewProduct = barcode ? inFileDataBarcodeMap.get(barcode) : undefined;
    if (earlierNewProduct) {
      // In sequential processing, this later row acts as a price update on the newly created unit
      priceUpdates.push({
        lineNumber,
        barcode,
        productName: earlierNewProduct.name,
        unitName: earlierNewProduct.unitName,
        currentPriceWholesale: Number(earlierNewProduct.priceWholesale),
        newPriceWholesale: rawPrice,
        pricingCurrency: earlierNewProduct.pricingCurrency || "SYP",
        unitId: `pending-${barcode}`,
      });
      continue;
    }

    // From this point on, the row is definitely a net-new product/unit row
    // — every check below (priceRetail, expiryDate, currency, required
    // fields, packaging consistency) applies ONLY here, never to a
    // price-update row.

    // Validate retail price if provided
    let priceRetailStr: string | undefined = undefined;
    if (rawRetail) {
      if (!DECIMAL_STRING_REGEX.test(rawRetail) || Number(rawRetail) < 0) {
        rejectedRows.push({
          lineNumber,
          rowContent: rowContentSummary,
          reason: `السطر ${lineNumber}: سعر التجزئة يجب أن يكون رقماً غير سالب (صفر أو أكثر).`,
        });
        continue;
      }
      priceRetailStr = rawRetail;
    }

    // Validate expiry date if provided
    if (expiryDateStr) {
      if (!STRICT_DATE_REGEX.test(expiryDateStr)) {
        rejectedRows.push({
          lineNumber,
          rowContent: rowContentSummary,
          reason: `السطر ${lineNumber}: تاريخ الانتهاء يجب أن يكون بالصيغة YYYY-MM-DD (مثال: 2026-12-31).`,
        });
        continue;
      }
      const parsedDate = new Date(expiryDateStr);
      if (isNaN(parsedDate.getTime())) {
        rejectedRows.push({
          lineNumber,
          rowContent: rowContentSummary,
          reason: `السطر ${lineNumber}: تاريخ الانتهاء غير صالح.`,
        });
        continue;
      }
    }

    // Validate currency strictly on new products (SYP or USD allowed, default to SYP if omitted)
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

    // Check all required fields for net-new products:
    // 1. name
    // 2. unitName
    // 3. conversionFactor (> 0)
    // 4. initialQuantity (>= 0)
    // 5. initialBatchNumber
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

    if (missingFields.length > 0) {
      rejectedRows.push({
        lineNumber,
        rowContent: rowContentSummary,
        reason: `السطر ${lineNumber}: الحقول التالية مطلوبة للمنتجات الجديدة: ${missingFields.join("، ")}.`,
      });
      continue;
    }

    // [FIX — critical] Packaging-unit consistency check. See the
    // function-level note above for the full reasoning. rawFactor is
    // guaranteed a valid, positive decimal string at this point (checked
    // in missingFields above), so it's safe to feed directly into the
    // candidate unit set.
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
      barcode: barcode || undefined,
      name,
      category,
      unitName,
      conversionFactor: rawFactor,
      priceWholesale: rawPrice,
      priceRetail: priceRetailStr,
      pricingCurrency,
      initialBatchNumber: rawBatchNumber,
      initialQuantity: rawQuantity,
      batchNumber: rawBatchNumber,
      quantity: rawQuantity,
      expiryDate: expiryDateStr,
    };

    newProducts.push(newProductData);
    productUnitsSoFarByKey.set(productKey, candidateUnits);

    if (barcode) {
      inFileDataBarcodeMap.set(barcode, newProductData);
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
  // Detailed array (not a bare counter), mirroring failedNewProducts/
  // failedPriceUpdates — a merchant needs to know WHICH row/barcode was
  // skipped and WHY (e.g. a price-update row whose barcode was supposed
  // to be created a few rows earlier in this same file, but that earlier
  // "new product" row itself failed).
  skippedPriceUpdates: { lineNumber: number; barcode: string; unitName: string; reason: string }[];
  failedNewProducts: { lineNumber: number; name: string; barcode?: string; reason: string }[];
  // Mirrors failedNewProducts's shape. Every price-update failure is
  // caught per-row and reported here instead of aborting the whole import.
  failedPriceUpdates: { lineNumber: number; barcode: string; unitName: string; reason: string }[];
}

/**
 * Import Confirmation (Pass 2): Strictly sequential per-row execution.
 *
 * T3d Execution Invariants:
 * 1. Process rows strictly sequentially, each in its own $transaction.
 * 2. In each transaction, query live DB for (tenantId, barcode) match:
 *    - Match found -> update priceWholesale only (idempotent, supports re-imports).
 *    - Match not found:
 *      a) Check if (tenantId, name, category) already exists — CONFIRMED
 *         case-insensitive match on both fields (see normalizeProductKey's
 *         doc comment above; this is the same rule, just enforced live via
 *         Prisma's `mode: "insensitive"` rather than the in-memory key used
 *         during preview). If found, reuse existing Product.id. If not,
 *         create Product.
 *      b) [FIX — critical, live re-check] Re-validates packaging-unit
 *         consistency (T3a's confirmed rule) against the PRODUCT'S ACTUAL,
 *         LIVE units at the moment of commit — never trusting preview's
 *         earlier validation. Time can pass between preview and commit
 *         (a concurrent manual edit could add/remove a base unit on the
 *         same product in the meantime), so this row's candidate unit is
 *         checked against a fresh read of the target product's units,
 *         inside this same transaction, immediately before creating the
 *         ProductUnit. This mirrors the same "commit must independently
 *         re-verify, never reuse preview's classification" principle
 *         already applied to the barcode-match check above.
 *      c) Create ProductUnit with barcodeSource: null, isActive: true.
 *      d) Create ProductBatch with initialQuantity, initialBatchNumber, expiryDate.
 * 3. Catch P2002 error on unique barcode constraint and surface as friendly actionable message.
 * 4. Never touches ProductCatalogEntry and never writes non-null barcodeSource.
 */
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

  // Merge items into a single sequential list ordered by lineNumber
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
        await db.$transaction(async (rowTx) => {
          let unitToUpdate: { id: string } | null = null;

          if (update.barcode) {
            unitToUpdate = await rowTx.productUnit.findUnique({
              where: {
                tenantId_barcode: {
                  tenantId,
                  barcode: update.barcode.trim(),
                },
              },
              select: { id: true },
            });
          }

          if (!unitToUpdate && update.unitId && !update.unitId.startsWith("pending-")) {
            unitToUpdate = await rowTx.productUnit.findFirst({
              where: {
                id: update.unitId,
                tenantId,
              },
              select: { id: true },
            });
          }

          if (!unitToUpdate) {
            skippedPriceUpdates.push({
              lineNumber: update.lineNumber,
              barcode: update.barcode,
              unitName: update.unitName,
              reason: `السطر ${update.lineNumber}: تعذّر إيجاد الوحدة المطابقة للباركود (${update.barcode}) — قد يكون الصف الذي كان يفترض إنشاء هذه الوحدة سابقاً في هذا الملف قد فشل.`,
            });
            return;
          }

          await rowTx.productUnit.update({
            where: {
              id: unitToUpdate.id,
            },
            data: {
              priceWholesale: update.newPriceWholesale.toString(),
            },
          });

          updatedPricesCount++;
        });
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
        await db.$transaction(async (rowTx) => {
          // 1. Live DB check: does this barcode already exist in the database?
          // (Handles in-file duplicate barcodes and re-imports gracefully)
          if (np.barcode && np.barcode.trim()) {
            const existingUnit = await rowTx.productUnit.findUnique({
              where: {
                tenantId_barcode: {
                  tenantId,
                  barcode: np.barcode.trim(),
                },
              },
              select: { id: true },
            });

            if (existingUnit) {
              // Barcode already exists -> update priceWholesale only
              await rowTx.productUnit.update({
                where: { id: existingUnit.id },
                data: {
                  priceWholesale: np.priceWholesale.toString(),
                },
              });
              updatedPricesCount++;
              return;
            }
          }

          // 2. Name & Category match check — CONFIRMED case-insensitive on
          // both fields (see normalizeProductKey's doc comment above).
          // Prevents duplicate Product rows when merchants import brand
          // names with mixed capitalization (e.g. "Cola" vs "cola") while
          // attaching new packaging units (ProductUnit) to the same product.
          let targetProductId: string;

          const existingProduct = await rowTx.product.findFirst({
            where: {
              tenantId,
              name: { equals: np.name.trim(), mode: "insensitive" },
              category: np.category?.trim()
                ? { equals: np.category.trim(), mode: "insensitive" }
                : null,
            },
            include: {
              units: { select: { unitName: true, conversionFactor: true } },
            },
          });

          let liveUnitsForProduct: PackagingUnit[] = [];

          if (existingProduct) {
            targetProductId = existingProduct.id;
            liveUnitsForProduct = existingProduct.units.map((u) => ({
              unitName: u.unitName,
              conversionFactor: u.conversionFactor.toString(),
            }));
          } else {
            const createdProduct = await rowTx.product.create({
              data: {
                tenantId,
                name: np.name.trim(),
                category: np.category?.trim() || null,
                isPublic: false,
              },
            });
            targetProductId = createdProduct.id;
            // Freshly created — no units yet.
            liveUnitsForProduct = [];
          }

          // [FIX — critical] Live re-validation of packaging-unit
          // consistency, against the product's ACTUAL units at this exact
          // moment (never trusting preview's earlier check — see the
          // function-level note above). This is what stops a brand-new
          // product from ever being created without a base unit, and
          // stops a duplicate/conflicting conversionFactor from slipping
          // in due to a concurrent change made between preview and commit.
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

          // 3. Create top-level ProductUnit:
          // barcodeSource is explicitly null per T3d / T3a specification.
          const createdUnit = await rowTx.productUnit.create({
            data: {
              tenantId,
              productId: targetProductId,
              unitName: np.unitName.trim(),
              conversionFactor: np.conversionFactor.toString(),
              pricingCurrency: np.pricingCurrency || "SYP",
              priceWholesale: np.priceWholesale.toString(),
              priceRetail: np.priceRetail ? np.priceRetail.toString() : null,
              barcode: np.barcode?.trim() || null,
              barcodeSource: null,
              isActive: true,
            },
          });

          // 4. Create top-level ProductBatch:
          const batchNum = (np.initialBatchNumber || np.batchNumber)!.trim();
          const batchQty = (np.initialQuantity !== undefined ? np.initialQuantity : np.quantity)!.toString();
          const expDate = np.expiryDate ? new Date(np.expiryDate) : null;

          await rowTx.productBatch.create({
            data: {
              tenantId,
              productId: targetProductId,
              unitId: createdUnit.id,
              batchNumber: batchNum,
              quantity: batchQty,
              expiryDate: expDate,
            },
          });

          createdProductsCount++;
        });
      } catch (error) {
        if (error instanceof PackagingConsistencyError) {
          failedNewProducts.push({
            lineNumber: np.lineNumber,
            name: np.name,
            barcode: np.barcode,
            reason: `السطر ${np.lineNumber}: ${error.message}`,
          });
          continue;
        }

        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          failedNewProducts.push({
            lineNumber: np.lineNumber,
            name: np.name,
            barcode: np.barcode,
            reason: `السطر ${np.lineNumber}: تعارض في الباركود (${np.barcode}) — تم إنشاؤه مسبقاً ضمن هذا الملف أو في قاعدة البيانات.`,
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
          barcode: np.barcode,
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

/**
 * [FIX] Dedicated error type so the packaging-consistency failure inside
 * commitCsvImport's transaction can be distinguished from a P2002 unique
 * violation or any other unexpected error, and reported to the merchant
 * with the exact validatePackagingUnits() message rather than a generic
 * "تعذّر إنشاء المنتج" fallback.
 */
class PackagingConsistencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PackagingConsistencyError";
  }
}

/**
 * Normalizes header keys to standard names
 */
function normalizeHeaderKey(key: string): string {
  const k = key.trim().toLowerCase();
  if (["barcode", "الباركود", "باركود", "رمز الباركود", "رمز_الباركود"].includes(k)) return "barcode";
  if (["name", "اسم المنتج", "الاسم", "اسم_المنتج", "اسم"].includes(k)) return "name";
  if (["category", "التصنيف", "الفئة", "قسم"].includes(k)) return "category";
  if (["unitname", "unit", "اسم الوحدة", "الوحدة", "اسم_الوحدة"].includes(k)) return "unitName";
  if (["conversionfactor", "factor", "معامل التحويل", "معامل_التحويل", "المعامل"].includes(k)) return "conversionFactor";
  if (["pricewholesale", "priceusd", "price", "السعر", "السعر (usd)", "السعر_بالدولار", "سعر_البيع", "سعر_الجملة", "سعر الجملة"].includes(k)) return "priceWholesale";
  if (["priceretail", "سعر_التجزئة", "سعر التجزئة", "تجزئة"].includes(k)) return "priceRetail";
  if (["pricingcurrency", "currency", "العملة", "عملة_السعر", "عملة السعر"].includes(k)) return "pricingCurrency";
  if (["initialbatchnumber", "batchnumber", "batch", "رقم الدفعة", "رقم_الدفعة", "الدفعة", "رقم الدفعة الأولى", "رقم_الدفعة_الأولى", "الدفعة الأولى", "الدفعة_الأولى"].includes(k)) return "initialBatchNumber";
  if (["initialquantity", "quantity", "qty", "الكمية", "العدد", "كمية_المخزون", "الكمية الأولى", "الكمية_الأولية", "الكمية الأولية"].includes(k)) return "initialQuantity";
  if (["expirydate", "expiry", "تاريخ الانتهاء", "تاريخ_الانتهاء", "تاريخ الصلاحية"].includes(k)) return "expiryDate";
  return k;
}