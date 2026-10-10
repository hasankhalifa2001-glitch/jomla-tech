/**
 * lib/data/receipts.ts
 *
 * T4f addendum — Rule 3: "the first share generates and caches the PDF,
 * subsequent shares reuse it", with a concurrency guard so two simultaneous
 * first-shares cannot both generate, both upload, and disagree about which URL
 * the invoice points at.
 *
 * [THE GUARD, AND WHY THIS SHAPE] The write is a single conditional UPDATE:
 *
 *   UPDATE "Invoice" SET "receiptPdfUrl" = $url
 *   WHERE id = $id AND "tenantId" = $tenant AND "receiptPdfUrl" IS NULL
 *
 * and the caller inspects the affected-row count. That is the same
 * first-write-wins idiom this codebase already uses everywhere a row must be
 * claimed exactly once — most directly app/api/orders/[id]/status/route.ts's
 * `tx.b2BOrderRequest.updateMany({ where: { ...status: "PENDING_REVIEW" } })`
 * claim on the B2B approval path, which treats `count === 0` as "someone else
 * already did this". No new lock, no new status column, and no new raw query:
 * the UPDATE is atomic on its own, and nothing else in the operation needs to
 * stay atomic with it.
 *
 * [THE THREE CASES THIS FUNCTION HANDLES]
 *   1. We win the conditional UPDATE → our URL is the invoice's URL.
 *   2. We lose it → another request already persisted a URL. We re-read and
 *      serve THEIRS, and discard our own artifact if it is not the one they
 *      referenced, so a losing request never leaves orphaned storage behind.
 *   3. The object already existed in storage (`alreadyExisted`) — the crash
 *      case: an earlier attempt uploaded bytes and died before its UPDATE
 *      committed. A naive `upsert: false` upload would then fail forever and
 *      the invoice could never be shared; instead the conditional UPDATE is
 *      still attempted, which is what actually decides the winner. See
 *      lib/storage.ts's uploadFileToStorageIfAbsent().
 *
 * [WHAT IS DELIBERATELY NOT HERE] No PDF rendering (lib/receipts/pdf.ts), no
 * raster validation (lib/receipts/raster-validation.ts), no auth. This module
 * only owns "who gets to write the URL, and what happens to the loser's file".
 *
 * [v4.7] This file ALSO hosts the goods-receiving gateway (further below).
 * The two concerns share only the word "receipt"; if this file keeps growing,
 * the receiving half is the one to move to lib/inventory/receiving.ts.
 */

import type { TxOrClient } from "@/lib/db/tenant-scope";
import {
  PDF_CONTENT_TYPE,
  buildDeterministicStorageKey,
  removeFileFromStorage,
  uploadFileToStorageIfAbsent,
  type StorageKind,
} from "@/lib/storage";
import { z } from "zod";
import Decimal from "decimal.js";
import { constructBatchNumber } from "@/lib/inventory/batch-number";
import {
  createBatchRow,
  batchNumberSuffixSchema,
  expiryDateSchema,
  type CreatedBatchRow,
} from "@/lib/inventory/batch-creation";
import {
  businessDateToDbDate,
  isFutureBusinessDate,
  isTooOldBusinessDate,
  isRealCalendarDate,
} from "@/lib/inventory/date-utils";
import { COST_PER_BASE_UNIT_REGEX } from "@/lib/inventory/units";

export const RECEIPT_PDF_STORAGE_KIND: StorageKind = "invoice-pdfs";
export const RECEIPT_PDF_EXTENSION = "pdf";

/**
 * The deterministic object key for an invoice's cached PDF. Determinism is
 * load-bearing — see lib/storage.ts's buildDeterministicStorageKey() header.
 */
export function buildInvoiceReceiptPdfKey(params: {
  tenantId: string;
  invoiceId: string;
}): string {
  return buildDeterministicStorageKey({
    tenantId: params.tenantId,
    invoiceId: params.invoiceId,
    kind: RECEIPT_PDF_STORAGE_KIND,
    extension: RECEIPT_PDF_EXTENSION,
  });
}

export async function readReceiptPdfUrl(
  db: TxOrClient,
  tenantId: string,
  invoiceId: string
): Promise<string | null> {
  const row = await db.invoice.findUnique({
    where: { id: invoiceId, tenantId },
    select: { receiptPdfUrl: true },
  });
  return row?.receiptPdfUrl ?? null;
}

export interface CacheReceiptPdfResult {
  /** The URL the invoice now points at — ours if we won, otherwise the winner's. */
  url: string;
  /** True when THIS request's conditional UPDATE is what persisted the URL. */
  wonRace: boolean;
  /** True when the object already existed in storage (the crash-recovery case). */
  reusedExistingObject: boolean;
  /** True when this request uploaded bytes and then deleted them again. */
  discardedOwnUpload: boolean;
}

/**
 * Uploads `pdf` and claims `Invoice.receiptPdfUrl` if — and only if — it is
 * still empty. Callers must already have checked the invoice exists and is
 * readable by the caller; this function never widens access.
 */
export async function cacheReceiptPdfOnce(params: {
  db: TxOrClient;
  tenantId: string;
  invoiceId: string;
  pdf: Uint8Array;
}): Promise<CacheReceiptPdfResult> {
  const { db, tenantId, invoiceId } = params;
  const key = buildInvoiceReceiptPdfKey({ tenantId, invoiceId });

  const upload = await uploadFileToStorageIfAbsent({
    buffer: Buffer.from(params.pdf),
    key,
    contentType: PDF_CONTENT_TYPE,
  });

  const claimed = await db.invoice.updateMany({
    where: { id: invoiceId, tenantId, receiptPdfUrl: null },
    data: { receiptPdfUrl: upload.url },
  });

  if (claimed.count === 1) {
    return {
      url: upload.url,
      wonRace: true,
      reusedExistingObject: upload.alreadyExisted,
      discardedOwnUpload: false,
    };
  }

  // count === 0: another request (or a previous attempt) persisted a URL first.
  // Re-read rather than assuming our own upload is what the row now holds.
  const persisted = await readReceiptPdfUrl(db, tenantId, invoiceId);

  if (!persisted) {
    // The row exists (the caller checked) yet holds no URL and our conditional
    // write did not take: refuse rather than inventing a value.
    throw new Error(
      "تعذّر تثبيت رابط إيصال PDF على الفاتورة — يرجى إعادة المحاولة."
    );
  }

  let discardedOwnUpload = false;

  if (persisted !== upload.url && !upload.alreadyExisted) {
    // Our freshly uploaded object is not the one the invoice references, so it
    // would be orphaned storage. Delete it. Best-effort: a failed delete costs
    // a few kilobytes, never correctness, and must not fail the share.
    try {
      await removeFileFromStorage(key);
      discardedOwnUpload = true;
    } catch (error) {
      console.error("Failed to discard a losing receipt PDF upload:", error);
    }
  }

  return {
    url: persisted,
    wonRace: false,
    reusedExistingObject: upload.alreadyExisted,
    discardedOwnUpload,
  };
}

// ============================================================================
// [v4.7] GOODS-RECEIVING RECEIPT GATEWAY - createReceiptWithBatches()
// ============================================================================
//
// THE receiving write path. This module contains the ONLY call to
// productReceipt.create() anywhere in the codebase (asserted by a static
// source scan in the v4.7 test suite); lib/inventory/batch-creation.ts's
// createBatchRow() takes a REQUIRED receiptId and never creates a receipt
// itself. Every path that writes a ProductBatch routes through here:
//
//   - POST /api/inventory/batches            (single add-batch screen)
//   - POST /api/inventory/batches/receipt    (multi-product receipt screen)
//   - POST /api/inventory/products           (initialBatch, step 3)
//   - commitCsvImport()                      (one receipt per import file)
//
// (prisma/seed.ts writes its demo receipt with a plain top-level
// prisma.productReceipt.create - demo data, never an API path.)
//
// [ATOMICITY] This function opens NO transaction of its own: it issues
// top-level `productReceipt.create` and per-line `createBatchRow` calls on
// whatever `tx` it was given. A failure on any line throws straight out of
// the CALLER's $transaction and rolls back the receipt AND every batch.
//
// [BATCH NUMBER] constructBatchNumber() runs exactly ONCE per submission, so
// every line shares one "{business-date}-{suffix}" prefix even if the Syria
// business day rolls over mid-loop. The prefix is the business date, NOT
// purchaseDate - schema.prisma's v4.7 header states the two are unrelated.
//
// [MONEY] SYP only - no USD figure exists anywhere in this feature. A typed
// `totalCost` is stored EXACTLY as given; the CSV path's
// costPricePerBaseUnit x baseQuantity product is computed and rounded ONCE
// inside createBatchRow() via lib/utils/money.ts.
// ============================================================================

/** Quantity / total-cost shape: up to 14 integer digits + up to 4 decimals (Decimal(18,4)). */
const RECEIPT_AMOUNT_REGEX = /^\d{1,14}(\.\d{1,4})?$/;

function isPositiveAmount(value: string): boolean {
  if (!RECEIPT_AMOUNT_REGEX.test(value)) return false;
  try {
    return new Decimal(value).gt(0);
  } catch {
    return false;
  }
}

function isPositiveCostPerBaseUnit(value: string): boolean {
  if (!COST_PER_BASE_UNIT_REGEX.test(value)) return false;
  try {
    return new Decimal(value).gt(0);
  } catch {
    return false;
  }
}

/**
 * The merchant's purchase date - a BUSINESS date string: required, a real
 * calendar date, never in the future relative to today's Syria business day,
 * and never older than MAX_BACKDATE_DAYS (730 days).
 *
 * [ONE `now` PER VALIDATION] The future and too-old rules run inside a single
 * superRefine that captures `now` ONCE and hands the same instant to both, so
 * a business-day rollover between the two checks can never make them disagree
 * about which day it is. They are pure 'YYYY-MM-DD' string comparisons.
 *
 * zod keeps running later refinements after an earlier string check failed
 * (the value is only "dirty", not aborted), so the superRefine re-checks
 * isRealCalendarDate itself and stays silent on a malformed value: the format
 * refines above have already reported it, and a comparison against a
 * non-date string would only add a misleading second message.
 */
export const purchaseDateSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "تاريخ الشراء يجب أن يكون بالصيغة YYYY-MM-DD (مثال: 2026-12-31).")
  .refine(isRealCalendarDate, { message: "تاريخ الشراء غير صالح." })
  .superRefine((value, ctx) => {
    if (!isRealCalendarDate(value)) return;
    const now = new Date();
    if (isFutureBusinessDate(value, now)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "لا يمكن تسجيل استلام بتاريخ في المستقبل.",
      });
      return;
    }
    if (isTooOldBusinessDate(value, now)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "لا يمكن تسجيل استلام بتاريخ أقدم من سنتين (730 يوماً) — تاريخ الشراء قديم جدا بالنسبة لليوم.",
      });
    }
  });

/**
 * Optional supplier name - trimmed, bounded (120), no control characters
 * (it is shown in the receipts history table), empty collapses to null.
 * The control-character pattern accepts the empty string on purpose.
 */
export const supplierNameSchema = z
  .string()
  .trim()
  .max(120, "اسم المورد طويل جدا (الحد الأقصى 120 حرفا).")
  .regex(/^[^\u0000-\u001f\u007f]*$/, "اسم المورد لا يمكن أن يحتوي على أسطر جديدة أو رموز تحكم.")
  .optional()
  .nullable();

/**
 * One receipt line. Exactly ONE cost input per line:
 *   - `totalCost` - interactive paths: EXACTLY what the merchant typed (SYP),
 *     never re-derived from the per-unit figure.
 *   - `costPricePerBaseUnit` - the CSV import only: the column's
 *     per-base-unit price, stored verbatim (see csv-parser.ts's column note);
 *     totalCostSYP is derived from it once inside createBatchRow().
 */
export const receiptLineSchema = z
  .object({
    productId: z.string().trim().min(1, "معرف المنتج مطلوب في كل سطر."),
    entryUnitId: z.string().trim().min(1, "معرف الوحدة مطلوب في كل سطر."),
    quantity: z
      .string()
      .trim()
      .regex(RECEIPT_AMOUNT_REGEX, "صيغة الكمية غير صالحة (مثال: 10 أو 10.5).")
      .refine(isPositiveAmount, { message: "الكمية يجب أن تكون أكبر من صفر في كل سطر." }),
    totalCost: z
      .string()
      .trim()
      .regex(RECEIPT_AMOUNT_REGEX, "صيغة إجمالي التكلفة غير صالحة (مثال: 9000 أو 9000.5).")
      .refine(isPositiveAmount, {
        message: "لا يمكن قبول سطر بتكلفة صفر — إجمالي تكلفة الشراء يجب أن يكون أكبر من صفر في كل سطر.",
      })
      .optional(),
    costPricePerBaseUnit: z
      .string()
      .trim()
      .regex(COST_PER_BASE_UNIT_REGEX, "صيغة سعر التكلفة للوحدة الأساسية غير صالحة (حتى 8 خانات عشرية).")
      .refine(isPositiveCostPerBaseUnit, {
        message: "سعر التكلفة للوحدة الأساسية يجب أن يكون أكبر من صفر.",
      })
      .optional(),
    expiryDate: expiryDateSchema,
  })
  .refine(
    (line) => (line.totalCost !== undefined) !== (line.costPricePerBaseUnit !== undefined),
    {
      message:
        "كل سطر يستقبل إجمالي تكلفة أو سعر تكلفة الوحدة الأساسية — بالظبط واحد منهما.",
    }
  );

export interface ReceiptLineInput {
  productId: string;
  entryUnitId: string;
  quantity: string;
  totalCost?: string;
  costPricePerBaseUnit?: string;
  expiryDate?: string | null;
}

export interface CreateReceiptWithBatchesInput {
  tenantId: string;
  /** session.user.id - becomes ProductReceipt.createdByUserId. */
  userId: string;
  /** Required business date 'YYYY-MM-DD' (purchaseDateSchema). */
  purchaseDate: string;
  supplierName?: string | null;
  /** Required merchant suffix (batchNumberSuffixSchema) - the date prefix is added here. */
  batchNumberSuffix: string;
  lines: ReceiptLineInput[];
  /**
   * CSV: the receipt id already committed by an EARLIER row of this same file.
   * VERIFIED to belong to `tenantId` before use - a foreign or unknown id
   * throws ReceiptNotFoundForTenantError and writes nothing.
   */
  existingReceiptId?: string;
}

export interface CreateReceiptWithBatchesResult {
  receiptId: string;
  /** The ONE batchNumber every line of this submission shares. */
  batchNumber: string;
  created: CreatedBatchRow[];
  /** false when existingReceiptId was supplied (no receipt row written here). */
  receiptCreated: boolean;
}

/**
 * Thrown when `existingReceiptId` does not exist for this tenant. The foreign
 * key alone only proves the receipt EXISTS somewhere; without this check an id
 * belonging to another tenant would link this tenant's batches to it.
 */
export class ReceiptNotFoundForTenantError extends Error {
  readonly code = "RECEIPT_NOT_FOUND";
  constructor() {
    super("الاستلام المحدد غير موجود لهذا المتجر.");
    this.name = "ReceiptNotFoundForTenantError";
  }
}

export async function createReceiptWithBatches(
  tx: TxOrClient,
  input: CreateReceiptWithBatchesInput
): Promise<CreateReceiptWithBatchesResult> {
  // Cheap, DB-free validation FIRST - nothing below touches the database
  // until every input is known to be well-formed. A ZodError thrown here
  // escapes the caller's transaction callback and rolls everything back.
  const purchaseDate = purchaseDateSchema.parse(input.purchaseDate);
  const suffix = batchNumberSuffixSchema.parse(input.batchNumberSuffix);
  const lines = z
    .array(receiptLineSchema)
    .min(1, "يجب إضافة صنف واحد على الأقل إلى الاستلام.")
    .parse(input.lines);
  const supplierTrimmed = supplierNameSchema.parse(input.supplierName ?? undefined);
  const supplierName = supplierTrimmed ? supplierTrimmed : null;

  let receiptId: string;
  let receiptCreated = false;
  if (input.existingReceiptId) {
    // Tenant-scoped lookup: the receipt must belong to THIS tenant.
    const existing = await tx.productReceipt.findFirst({
      where: { id: input.existingReceiptId, tenantId: input.tenantId },
      select: { id: true },
    });
    if (!existing) {
      throw new ReceiptNotFoundForTenantError();
    }
    receiptId = existing.id;
  } else {
    const receipt = await tx.productReceipt.create({
      data: {
        tenantId: input.tenantId,
        createdByUserId: input.userId,
        supplierName,
        purchaseDate: businessDateToDbDate(purchaseDate),
      },
    });
    receiptId = receipt.id;
    receiptCreated = true;
  }

  // Constructed ONCE: all lines share one "{business-date}-{suffix}" prefix
  // even if the Syria business day rolls over between two lines of the loop.
  const batchNumber = constructBatchNumber(suffix);

  const created: CreatedBatchRow[] = [];
  for (const line of lines) {
    const base = {
      tenantId: input.tenantId,
      receiptId,
      productId: line.productId,
      entryUnitId: line.entryUnitId,
      batchNumber,
      quantityInEntryUnit: line.quantity,
      expiryDate: line.expiryDate ?? null,
    };
    created.push(
      await createBatchRow(
        tx,
        line.totalCost !== undefined
          ? { ...base, totalCost: line.totalCost }
          : { ...base, costPricePerBaseUnit: line.costPricePerBaseUnit as string }
      )
    );
  }

  return { receiptId, batchNumber, created, receiptCreated };
}