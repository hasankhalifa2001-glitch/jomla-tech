import Papa from "papaparse";
import { PrismaClient, Prisma } from "@prisma/client";

export interface CsvRowRaw {
  [key: string]: string | undefined;
}

export interface NewProductImportData {
  lineNumber: number;
  barcode?: string;
  name: string;
  category?: string;
  unitName: string;
  conversionFactor: number;
  priceWholesale: number;
  priceRetail?: number;
  pricingCurrency?: "SYP" | "USD";
  batchNumber?: string;
  quantity?: number;
  expiryDate?: string;
}

export interface PriceUpdateImportData {
  lineNumber: number;
  barcode: string;
  productName: string;
  unitName: string;
  currentPriceWholesale: number;
  newPriceWholesale: number;
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

const STRICT_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

type PrismaReadClient = PrismaClient | Prisma.TransactionClient;
type PrismaWriteClient = PrismaClient;

/**
 * Two-Pass Validation (Pass 1): Parse & Validate CSV without writing to DB
 *
 * [FIX — duplicate barcode on price-update rows] The previous version only
 * tracked `seenBarcodesInFile` inside the NEW-product branch. Two rows in
 * the same file that both matched an EXISTING unit by the same barcode
 * (i.e., two price-update rows for the same product) were never flagged —
 * both silently entered `priceUpdates` targeting the same `unitId`, and at
 * commit time the second `updateMany` would just overwrite the first with
 * no warning (last-write-wins, invisible to the merchant). A separate
 * `seenUpdateBarcodesInFile` set now catches this the same way duplicate
 * new-product barcodes were already caught.
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

  const seenBarcodesInFile = new Set<string>();
  const seenNamesInFile = new Map<string, number>(); // normalized name -> first line number
  // [FIX] Tracks barcodes already claimed by a PRICE-UPDATE row in this
  // file — a separate set from `seenBarcodesInFile` (which only guards
  // NEW-product rows) since the two branches represent different kinds of
  // duplicates and must not share one counter.
  const seenUpdateBarcodesInFile = new Map<string, number>(); // barcode -> first line number

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const lineNumber = i + 2; // Line 1 is header
    const rowContentSummary = Object.entries(row)
      .map(([k, v]) => `${k}: ${v}`)
      .join(", ");

    const barcode = (row.barcode || "").trim();
    const name = (row.name || "").trim();
    const category = (row.category || "").trim() || undefined;
    const unitName = (row.unitName || "").trim() || "قطعة";
    const batchNumber = (row.batchNumber || "").trim() || undefined;
    const expiryDateStr = (row.expiryDate || "").trim() || undefined;

    const rawPrice = (row.priceWholesale || "").toString().trim();
    const priceWholesale = parseFloat(rawPrice);

    if (!rawPrice || isNaN(priceWholesale) || priceWholesale <= 0) {
      rejectedRows.push({
        lineNumber,
        rowContent: rowContentSummary,
        reason: `السطر ${lineNumber}: السعر يجب أن يكون رقماً موجباً أكبر من الصفر.`,
      });
      continue;
    }

    let priceRetail: number | undefined = undefined;
    const rawRetail = (row.priceRetail || "").toString().trim();
    if (rawRetail) {
      priceRetail = parseFloat(rawRetail);
      if (isNaN(priceRetail) || priceRetail < 0) {
        rejectedRows.push({
          lineNumber,
          rowContent: rowContentSummary,
          reason: `السطر ${lineNumber}: سعر التجزئة يجب أن يكون رقماً غير سالب.`,
        });
        continue;
      }
    }

    const currencyInputRaw = (row.pricingCurrency || "").toString().trim().toUpperCase();
    const currencyInput: "SYP" | "USD" | undefined =
      currencyInputRaw === "USD" ? "USD" : currencyInputRaw === "SYP" ? "SYP" : undefined;

    const rawFactor = (row.conversionFactor || "").toString().trim();
    let conversionFactor = 1;
    if (rawFactor) {
      conversionFactor = parseFloat(rawFactor);
      if (isNaN(conversionFactor) || conversionFactor <= 0) {
        rejectedRows.push({
          lineNumber,
          rowContent: rowContentSummary,
          reason: `السطر ${lineNumber}: معامل التحويل يجب أن يكون رقماً موجباً أكبر من الصفر.`,
        });
        continue;
      }
    }

    let quantity: number | undefined = undefined;
    const rawQty = (row.quantity || "").toString().trim();
    if (rawQty) {
      quantity = parseFloat(rawQty);
      if (isNaN(quantity)) {
        rejectedRows.push({
          lineNumber,
          rowContent: rowContentSummary,
          reason: `السطر ${lineNumber}: الكمية يجب أن تكون رقماً صالحاً.`,
        });
        continue;
      }
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

    const existingUnit = barcode ? barcodeMap.get(barcode) : undefined;

    if (existingUnit) {
      // [FIX] Reject a second (or later) price-update row in this same
      // file claiming the same barcode — same "duplicate within file"
      // protection new-product rows already had, extended to this branch.
      if (barcode) {
        const firstSeenLine = seenUpdateBarcodesInFile.get(barcode);
        if (firstSeenLine !== undefined) {
          rejectedRows.push({
            lineNumber,
            rowContent: rowContentSummary,
            reason: `السطر ${lineNumber}: الباركود (${barcode}) مكرر ضمن نفس الملف لتحديث سعر (أول ظهور في السطر ${firstSeenLine}) — تم رفض هذا السطر لتفادي تعارض الأسعار.`,
          });
          continue;
        }
        seenUpdateBarcodesInFile.set(barcode, lineNumber);
      }

      const existingCurrency = existingUnit.pricingCurrency as "SYP" | "USD";

      if (currencyInput && currencyInput !== existingCurrency) {
        rejectedRows.push({
          lineNumber,
          rowContent: rowContentSummary,
          reason:
            `السطر ${lineNumber}: عملة السعر في الملف (${currencyInput}) لا تطابق عملة المنتج الحالية ` +
            `(${existingCurrency}) لهذه الوحدة. لتغيير عملة التسعير يجب تعديلها يدوياً من صفحة المنتج، ` +
            `وليس عبر استيراد CSV — تم رفض هذا السطر لتفادي احتساب السعر بعملة خاطئة.`,
        });
        continue;
      }

      priceUpdates.push({
        lineNumber,
        barcode: existingUnit.barcode || barcode,
        productName: existingUnit.product?.name || name || "منتج غير مسمى",
        unitName: existingUnit.unitName,
        currentPriceWholesale: Number(existingUnit.priceWholesale ?? 0),
        newPriceWholesale: priceWholesale,
        pricingCurrency: existingCurrency,
        unitId: existingUnit.id,
      });
      continue;
    }

    if (!name) {
      rejectedRows.push({
        lineNumber,
        rowContent: rowContentSummary,
        reason: `السطر ${lineNumber}: اسم المنتج مطلوب للمنتجات الجديدة التي لا تملك باركود مسجل سابقاً.`,
      });
      continue;
    }

    if (barcode) {
      if (seenBarcodesInFile.has(barcode)) {
        rejectedRows.push({
          lineNumber,
          rowContent: rowContentSummary,
          reason: `السطر ${lineNumber}: الباركود (${barcode}) مكرر ضمن نفس الملف.`,
        });
        continue;
      }
      seenBarcodesInFile.add(barcode);
    }

    const normName = name.toLowerCase();
    const firstSeenLine = seenNamesInFile.get(normName);
    if (firstSeenLine !== undefined) {
      rejectedRows.push({
        lineNumber,
        rowContent: rowContentSummary,
        reason: `السطر ${lineNumber}: اسم المنتج "${name}" مكرر ضمن نفس الملف (أول ظهور في السطر ${firstSeenLine}) — تم الاحتفاظ بالسطر الأول فقط.`,
      });
      continue;
    }
    seenNamesInFile.set(normName, lineNumber);

    const pricingCurrency: "SYP" | "USD" = currencyInput ?? "SYP";

    newProducts.push({
      lineNumber,
      barcode: barcode || undefined,
      name,
      category,
      unitName,
      conversionFactor,
      priceWholesale,
      priceRetail,
      pricingCurrency,
      batchNumber,
      quantity,
      expiryDate: expiryDateStr,
    });
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
  skippedPriceUpdates: number;
  failedNewProducts: { lineNumber: number; name: string; barcode?: string; reason: string }[];
  // [FIX] New — mirrors `failedNewProducts`'s shape. Previously a price
  // update that hit an unexpected error (not just "0 rows matched") threw
  // and killed the entire remaining commit (new products included), with
  // no record of which row or why. Every failure is now caught per-row
  // and reported here instead of aborting the whole import.
  failedPriceUpdates: { lineNumber: number; barcode: string; unitName: string; reason: string }[];
}

/**
 * Import Confirmation (Pass 2): Write validated CSV payload to DB.
 *
 * [FIX — price-update loop error isolation] The previous version's
 * price-update loop had no try/catch at all, unlike the new-products loop
 * right below it. A single `updateMany` throwing for any reason (a
 * transient DB error, a constraint violation, anything) aborted the ENTIRE
 * `commitCsvImport` call immediately — silently skipping every remaining
 * price update AND every new product in the same payload, with zero
 * indication of which row caused it. That directly contradicted this
 * function's own stated design goal ("Each row here is independent").
 * Each price-update row is now wrapped individually, matching the
 * new-products loop's pattern, and failures are collected into
 * `failedPriceUpdates` with the specific line/barcode/reason instead of
 * propagating and killing the rest of the import.
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
  let skippedPriceUpdates = 0;
  const failedNewProducts: CommitCsvImportResult["failedNewProducts"] = [];
  const failedPriceUpdates: CommitCsvImportResult["failedPriceUpdates"] = [];

  for (const update of payload.priceUpdates) {
    try {
      const result = await db.productUnit.updateMany({
        where: {
          id: update.unitId,
          tenantId,
        },
        data: {
          priceWholesale: update.newPriceWholesale,
        },
      });

      if (result.count === 0) {
        skippedPriceUpdates++;
        continue;
      }
      updatedPricesCount++;
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
  }

  for (const np of payload.newProducts) {
    try {
      await db.$transaction(async (rowTx) => {
        const createdProduct = await rowTx.product.create({
          data: {
            tenantId,
            name: np.name,
            category: np.category || null,
            isPublic: false,
          },
        });

        const createdUnit = await rowTx.productUnit.create({
          data: {
            tenantId,
            productId: createdProduct.id,
            unitName: np.unitName,
            conversionFactor: np.conversionFactor,
            pricingCurrency: np.pricingCurrency || "SYP",
            priceWholesale: np.priceWholesale,
            priceRetail: np.priceRetail !== undefined ? np.priceRetail : null,
            barcode: np.barcode || null,
          },
        });

        if (np.batchNumber || (np.quantity !== undefined && np.quantity > 0)) {
          const batchNum =
            np.batchNumber || `BATCH-INIT-${Date.now().toString().slice(-6)}-${np.lineNumber}`;
          const batchQty = np.quantity !== undefined ? np.quantity : 0;
          const expDate = np.expiryDate ? new Date(np.expiryDate) : null;

          await rowTx.productBatch.create({
            data: {
              tenantId,
              productId: createdProduct.id,
              unitId: createdUnit.id,
              batchNumber: batchNum,
              quantity: batchQty,
              expiryDate: expDate,
            },
          });
        }
      });

      createdProductsCount++;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        failedNewProducts.push({
          lineNumber: np.lineNumber,
          name: np.name,
          barcode: np.barcode,
          reason: `السطر ${np.lineNumber}: تعارض في البيانات للباركود أو الاسم. لم يتم إنشاء هذا المنتج.`,
        });
        continue;
      }
      throw error;
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
  if (["batchnumber", "batch", "رقم الدفعة", "رقم_الدفعة", "الدفعة"].includes(k)) return "batchNumber";
  if (["quantity", "qty", "الكمية", "العدد", "كمية_المخزون"].includes(k)) return "quantity";
  if (["expirydate", "expiry", "تاريخ الانتهاء", "تاريخ_الانتهاء", "تاريخ الصلاحية"].includes(k)) return "expiryDate";
  return k;
}