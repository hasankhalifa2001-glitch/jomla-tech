/**
 * lib/receipts/raster-validation.ts
 *
 * T4f — the server's independent verification of the raster a browser uploads
 * for PDF generation (the approved plan's Condition 1).
 *
 * [WHY THE SERVER RE-VALIDATES AT ALL] The client renders the PNG (the browser
 * is the only thing that can shape Arabic properly — see the plan's Condition
 * 2 discussion) and posts the pixels. `lib/receipts/constraints.ts` exports the
 * same bounds to both sides, but a shared constant is a CONVENIENCE, never a
 * boundary: the client can be modified, cached from an older build, or simply
 * buggy. So this module re-derives every limit from the bytes themselves and
 * refuses anything that does not match — the identical posture
 * app/api/upload/receipt/route.ts already takes toward client-claimed
 * content-types.
 *
 * [WHAT IT CANNOT VERIFY — stated, not implied] The server cannot re-render
 * Arabic, so it cannot confirm that the pixels SAY what the invoice says. That
 * trust boundary is inherent to the approved raster strategy and is why the
 * route accepts no numbers, names, or totals from the client — only pixels,
 * keyed to an invoice id the caller demonstrably owns. Everything the server
 * CAN check mechanically (declared type, magic bytes, chunk structure,
 * dimensions, size) it does check, and each failure is its own error code so a
 * test can prove the check is real rather than incidentally satisfied.
 */

import {
  MAX_RECEIPT_RASTER_BYTES,
  MAX_RECEIPT_RASTER_HEIGHT,
  MIN_RECEIPT_RASTER_HEIGHT,
  PNG_HEIGHT_OFFSET,
  PNG_IHDR_TYPE_OFFSET,
  PNG_MAGIC_BYTES,
  PNG_WIDTH_OFFSET,
  RECEIPT_PDF_MIME,
  RECEIPT_PDF_RASTER_WIDTH,
} from "./constraints";

export type ReceiptRasterValidationCode =
  | "EMPTY_UPLOAD"
  | "CONTENT_TYPE"
  | "SIZE"
  | "MAGIC_BYTES"
  | "IHDR"
  | "WIDTH"
  | "HEIGHT";

export class ReceiptRasterValidationError extends Error {
  readonly code: ReceiptRasterValidationCode;

  constructor(code: ReceiptRasterValidationCode, message: string) {
    super(message);
    this.name = "ReceiptRasterValidationError";
    this.code = code;
  }
}

export interface ValidatedReceiptRaster {
  widthPx: number;
  heightPx: number;
}

function readUint32BE(buffer: Buffer, offset: number): number {
  return buffer.readUInt32BE(offset);
}

/**
 * Validates an uploaded receipt raster. Returns its dimensions on success and
 * throws ReceiptRasterValidationError otherwise — never a boolean, so a caller
 * cannot accidentally continue past a failure.
 */
export function validateReceiptRasterPng(
  buffer: Buffer,
  declaredContentType: string | null | undefined
): ValidatedReceiptRaster {
  if (!buffer || buffer.length === 0) {
    throw new ReceiptRasterValidationError(
      "EMPTY_UPLOAD",
      "لم يتم إرفاق صورة الإيصال."
    );
  }

  // 1. Declared content type — checked first because it is the cheapest, and
  //    because a browser sending this is a bug worth naming precisely.
  if (declaredContentType !== RECEIPT_PDF_MIME) {
    throw new ReceiptRasterValidationError(
      "CONTENT_TYPE",
      `صيغة الإيصال غير مدعومة (${declaredContentType ?? "غير محددة"}) — الصيغة المطلوبة PNG فقط.`
    );
  }

  // 2. Size ceiling, before any parsing.
  if (buffer.length > MAX_RECEIPT_RASTER_BYTES) {
    throw new ReceiptRasterValidationError(
      "SIZE",
      `حجم صورة الإيصال يتجاوز الحد المسموح (${Math.floor(
        MAX_RECEIPT_RASTER_BYTES / 1024
      )} كيلوبايت).`
    );
  }

  // 3. Magic bytes — the claim in step 1 is not trusted on its own.
  if (buffer.length < 24) {
    throw new ReceiptRasterValidationError(
      "MAGIC_BYTES",
      "ملف الإيصال تالف أو مبتور."
    );
  }
  for (let i = 0; i < PNG_MAGIC_BYTES.length; i += 1) {
    if (buffer[i] !== PNG_MAGIC_BYTES[i]) {
      throw new ReceiptRasterValidationError(
        "MAGIC_BYTES",
        "ملف الإيصال ليس صورة PNG صالحة."
      );
    }
  }

  // 4. The first chunk must be IHDR — a PNG without it has no dimensions to
  //    trust further down.
  const ihdr = buffer.subarray(PNG_IHDR_TYPE_OFFSET, PNG_IHDR_TYPE_OFFSET + 4);
  if (ihdr.toString("latin1") !== "IHDR") {
    throw new ReceiptRasterValidationError(
      "IHDR",
      "بنية ملف PNG غير صالحة (ترويسة IHDR مفقودة)."
    );
  }

  const widthPx = readUint32BE(buffer, PNG_WIDTH_OFFSET);
  const heightPx = readUint32BE(buffer, PNG_HEIGHT_OFFSET);

  // 5. Exact width. Not "<=", not "approximately": the cached PDF is one
  //    artifact shared across devices, so every share must submit the same
  //    geometry (see constraints.ts's header for why this is NOT the thermal
  //    printer's dots-per-line).
  if (widthPx !== RECEIPT_PDF_RASTER_WIDTH) {
    throw new ReceiptRasterValidationError(
      "WIDTH",
      `عرض صورة الإيصال يجب أن يكون ${RECEIPT_PDF_RASTER_WIDTH} نقطة بالضبط (تم استلام ${widthPx}).`
    );
  }

  // 6. Height bounds — a pathological or truncated image must not become a
  //    multi-metre PDF page.
  if (heightPx < MIN_RECEIPT_RASTER_HEIGHT || heightPx > MAX_RECEIPT_RASTER_HEIGHT) {
    throw new ReceiptRasterValidationError(
      "HEIGHT",
      `ارتفاع صورة الإيصال خارج الحدود المسموحة (${MIN_RECEIPT_RASTER_HEIGHT}–${MAX_RECEIPT_RASTER_HEIGHT}) — تم استلام ${heightPx}.`
    );
  }

  return { widthPx, heightPx };
}
