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
 */

import type { TxOrClient } from "@/lib/db/tenant-scope";
import {
  PDF_CONTENT_TYPE,
  buildDeterministicStorageKey,
  removeFileFromStorage,
  uploadFileToStorageIfAbsent,
  type StorageKind,
} from "@/lib/storage";

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
