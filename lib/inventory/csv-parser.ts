import Papa from "papaparse";
import { Prisma } from "@prisma/client";
import type { getTenantDb } from "@/lib/db/tenant-scope";
// [FIX] validatePackagingUnits now lives in units.ts (merged in), not the
// deleted packaging-unit-validation.ts.
import { validatePackagingUnits, toBaseUnit, BASE_UNIT_CONVERSION_FACTOR, type PackagingUnit } from "./units";
// [FIX — critical] This file previously called rowTx.product.*/
// rowTx.productUnit.*/db.product.*/db.productUnit.* directly everywhere —
// exactly the model-level access eslint.config.mjs's PRODUCT_MODEL_RULES
// bans outside lib/data/products.ts, and this file is not on that ban's
// exemption list. Routed through the sanctioned gateway instead.
import {
  findProductUnitByBarcode,
  findProductUnitById,
  updateProductUnit,
  createProductWithBaseUnit,
  createAdditionalUnit,
  findProductByNameCategory,
  listAllProductsWithUnitsForPackagingCheck,
  listAllUnitsForTenantWithProductName,
} from "@/lib/data/products";
// [FIX — critical] Resolves the product's REAL base unit before writing a
// batch for an additional (non-base) packaging unit — see the
// commitCsvImport doc comment below for the full bug this closes.
import { requireBaseUnit } from "@/lib/inventory/base-unit";

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

  const barcodeMap = new Map<string, (typeof existingUnits)[number]>();
  for (const u of existingUnits) {
    if (u.barcode) {
      barcodeMap.set(u.barcode.trim(), u);
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

    if (!rawPrice || !DECIMAL_STRING_REGEX.test(rawPrice) || Number(rawPrice) <= 0) {
      rejectedRows.push({
        lineNumber,
        rowContent: rowContentSummary,
        reason: `السطر ${lineNumber}: السعر يجب أن يكون رقماً موجباً أكبر من الصفر.`,
      });
      continue;
    }

    // Barcode check: existing in DB?
    const existingUnit = barcode ? barcodeMap.get(barcode) : undefined;
    if (existingUnit) {
      priceUpdates.push({
        lineNumber,
        barcode: existingUnit.barcode || barcode,
        productName: existingUnit.productName || name || "منتج غير مسمى",
        unitName: existingUnit.unitName,
        currentPriceWholesale: Number(existingUnit.priceWholesale ?? 0),
        newPriceWholesale: rawPrice,
        pricingCurrency: existingUnit.pricingCurrency,
        unitId: existingUnit.id,
      });
      continue;
    }

    // Barcode check: introduced by an earlier row in the same CSV?
    const earlierNewProduct = barcode ? inFileDataBarcodeMap.get(barcode) : undefined;
    if (earlierNewProduct) {
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

    // From this point on, the row is definitely a net-new product/unit row.

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
 * All model access now goes through lib/data/products.ts /
 * lib/inventory/base-unit.ts — this file no longer calls
 * rowTx.product./rowTx.productUnit.* directly anywhere.
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
            // [FIX] Routed through lib/data/products.ts.
            const found = await findProductUnitByBarcode(rowTx, tenantId, update.barcode.trim());
            if (found) unitToUpdate = { id: found.id };
          }

          if (!unitToUpdate && update.unitId && !update.unitId.startsWith("pending-")) {
            // [FIX] Routed through lib/data/products.ts.
            const found = await findProductUnitById(rowTx, tenantId, update.unitId);
            if (found) unitToUpdate = { id: found.id };
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

          // [FIX] Routed through lib/data/products.ts.
          await updateProductUnit(rowTx, tenantId, unitToUpdate.id, {
            priceWholesale: update.newPriceWholesale.toString(),
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
          // 1. Live DB check: does this barcode already exist?
          if (np.barcode && np.barcode.trim()) {
            const existingUnit = await findProductUnitByBarcode(rowTx, tenantId, np.barcode.trim());
            if (existingUnit) {
              await updateProductUnit(rowTx, tenantId, existingUnit.id, {
                priceWholesale: np.priceWholesale.toString(),
              });
              updatedPricesCount++;
              return;
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

          const batchNum = (np.initialBatchNumber || np.batchNumber)!.trim();
          const batchQty = (np.initialQuantity !== undefined ? np.initialQuantity : np.quantity)!.toString();
          const expDate = np.expiryDate ? new Date(np.expiryDate) : null;

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
                priceRetail: np.priceRetail ? np.priceRetail.toString() : null,
                barcode: np.barcode?.trim() || null,
                barcodeSource: null,
                isActive: true,
              }
            );

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
                expiryDate: expDate,
              },
            });

            createdProductsCount++;
          } else {
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
                priceRetail: np.priceRetail ? np.priceRetail.toString() : null,
                barcode: np.barcode?.trim() || null,
                barcodeSource: null,
                isActive: true,
              }
            );

            const baseUnit = await requireBaseUnit(rowTx, tenantId, existingProduct.id);
            const baseQty = toBaseUnit(batchQty, np.conversionFactor.toString());

            await rowTx.productBatch.create({
              data: {
                tenantId,
                productId: existingProduct.id,
                unitId: baseUnit.id,
                batchNumber: batchNum,
                quantity: baseQty.toString(),
                expiryDate: expDate,
              },
            });

            createdProductsCount++;
            void createdUnit; // referenced above for its id/factor only
          }
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

class PackagingConsistencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PackagingConsistencyError";
  }
}

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