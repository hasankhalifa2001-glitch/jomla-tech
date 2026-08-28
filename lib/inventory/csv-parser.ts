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
  priceUSD: number;
  batchNumber?: string;
  quantity?: number;
  expiryDate?: string;
}

export interface PriceUpdateImportData {
  lineNumber: number;
  barcode: string;
  productName: string;
  unitName: string;
  currentPriceUSD: number;
  newPriceUSD: number;
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

// The Arabic error message has always claimed "YYYY-MM-DD" but the old code
// just called `new Date(str)`, which happily parses ambiguous formats like
// "03/04/2026" (day/month or month/day, interpreted silently depending on
// engine). A strict format check means a badly-formatted date is REJECTED
// with a clear reason instead of silently imported as the wrong date.
const STRICT_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

type PrismaTx = PrismaClient | Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends">;

/**
 * Two-Pass Validation (Pass 1): Parse & Validate CSV without writing to DB
 */
export async function validateAndPreviewCsv(
  tx: PrismaTx,
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

  const existingUnits = await (tx as any).productUnit.findMany({
    where: {
      tenantId,
      barcode: { not: null },
    },
    include: {
      product: true,
    },
  });

  const barcodeMap = new Map<string, any>();
  for (const u of existingUnits) {
    if (u.barcode) {
      barcodeMap.set(u.barcode.trim(), u);
    }
  }

  // Tracks barcodes already claimed by an earlier row in THIS SAME file.
  // Without this, two new-product rows sharing one not-yet-registered
  // barcode both sail through Pass 1 as valid "new products" — then Pass 2
  // hits the DB's @@unique([tenantId, barcode]) constraint on the second
  // one. See commitCsvImport below for the second half of this protection
  // (a concurrent import racing THIS one, which no amount of in-file
  // checking here can catch).
  const seenBarcodesInFile = new Set<string>();

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

    const rawPrice = (row.priceUSD || "").toString().trim();
    const priceUSD = parseFloat(rawPrice);

    if (!rawPrice || isNaN(priceUSD) || priceUSD <= 0) {
      rejectedRows.push({
        lineNumber,
        rowContent: rowContentSummary,
        reason: `السطر ${lineNumber}: السعر يجب أن يكون رقماً موجباً أكبر من الصفر.`,
      });
      continue;
    }

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
      if (isNaN(quantity) || quantity < 0) {
        rejectedRows.push({
          lineNumber,
          rowContent: rowContentSummary,
          reason: `السطر ${lineNumber}: الكمية يجب أن تكون رقماً غير سالب.`,
        });
        continue;
      }
    }

    if (expiryDateStr) {
      // FIX: reject anything that isn't strictly YYYY-MM-DD before even
      // trying `new Date()` — see STRICT_DATE_REGEX comment above.
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

    if (barcode && barcodeMap.has(barcode)) {
      const existingUnit = barcodeMap.get(barcode)!;
      priceUpdates.push({
        lineNumber,
        barcode,
        productName: existingUnit.product?.name || "منتج غير مسمى",
        unitName: existingUnit.unitName,
        currentPriceUSD: Number(existingUnit.priceUSD),
        newPriceUSD: priceUSD,
        unitId: existingUnit.id,
      });
    } else {
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

      newProducts.push({
        lineNumber,
        barcode: barcode || undefined,
        name,
        category,
        unitName,
        conversionFactor,
        priceUSD,
        batchNumber,
        quantity,
        expiryDate: expiryDateStr,
      });
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
  skippedPriceUpdates: number;
  failedNewProducts: { lineNumber: number; name: string; barcode?: string; reason: string }[];
}

/**
 * Import Confirmation (Pass 2): Write validated CSV payload to DB.
 *
 * FIX (critical, see import/commit/route.ts): this function must be called
 * with the plain `prisma` client, NOT a `tx` obtained from an outer
 * `prisma.$transaction(async (tx) => ...)`. Each `product.create()` /
 * `productUnit.updateMany()` call below is already an atomic write on its
 * own (Prisma nested writes are atomic per call); wrapping the whole loop
 * in one outer transaction meant that on PostgreSQL, a single row's P2002 error
 * — even though caught here in JS — left the *entire* database transaction
 * in an "aborted" state, causing every subsequent row's write to fail too
 * and forcing a full rollback of rows that had already committed
 * successfully. Calling this with a non-transactional client means each
 * row's success or failure is now genuinely independent, matching what the
 * comments below (and the T3 spec) actually promise.
 */
export async function commitCsvImport(
  tx: PrismaTx,
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

  for (const update of payload.priceUpdates) {
    const result = await (tx as any).productUnit.updateMany({
      where: {
        id: update.unitId,
        tenantId,
      },
      data: {
        priceUSD: update.newPriceUSD,
      },
    });

    if (result.count === 0) {
      skippedPriceUpdates++;
      continue;
    }
    updatedPricesCount++;
  }

  for (const np of payload.newProducts) {
    // Each row's create is its own atomic unit of work — see the function
    // doc comment above. A P2002 here (barcode claimed by a concurrent
    // import between preview and commit) only ever affects THIS row.
    try {
      const createdProduct = await (tx as any).product.create({
        data: {
          tenantId,
          name: np.name,
          category: np.category || null,
          isPublic: false,
          units: {
            create: {
              tenantId,
              unitName: np.unitName,
              conversionFactor: np.conversionFactor,
              priceUSD: np.priceUSD,
              barcode: np.barcode || null,
            },
          },
        },
        include: {
          units: true,
        },
      });

      createdProductsCount++;

      if (np.batchNumber || (np.quantity !== undefined && np.quantity > 0)) {
        const createdUnit = createdProduct.units[0];
        const batchNum = np.batchNumber || `BATCH-INIT-${Date.now().toString().slice(-6)}-${np.lineNumber}`;
        const batchQty = np.quantity !== undefined ? np.quantity : 0;
        const expDate = np.expiryDate ? new Date(np.expiryDate) : null;

        await (tx as any).productBatch.create({
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
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        failedNewProducts.push({
          lineNumber: np.lineNumber,
          name: np.name,
          barcode: np.barcode,
          reason: `السطر ${np.lineNumber}: الباركود (${np.barcode}) تم استخدامه من قبل عملية استيراد أخرى في نفس اللحظة تقريباً. لم يتم إنشاء هذا المنتج — يرجى مراجعته وإعادة استيراده منفرداً إذا لزم الأمر.`,
        });
        continue;
      }
      // Any other error is unexpected (not a barcode race) — rethrow so it
      // still surfaces as a real 500 rather than being silently swallowed.
      throw error;
    }
  }

  return {
    createdProductsCount,
    updatedPricesCount,
    skippedPriceUpdates,
    failedNewProducts,
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
  if (["priceusd", "price", "السعر", "السعر (usd)", "السعر_بالدولار", "سعر_البيع"].includes(k)) return "priceUSD";
  if (["batchnumber", "batch", "رقم الدفعة", "رقم_الدفعة", "الدفعة"].includes(k)) return "batchNumber";
  if (["quantity", "qty", "الكمية", "العدد", "كمية_المخزون"].includes(k)) return "quantity";
  if (["expirydate", "expiry", "تاريخ الانتهاء", "تاريخ_الانتهاء", "تاريخ الصلاحية"].includes(k)) return "expiryDate";
  return k;
}