/**
 * lib/receipts/pdf.ts
 *
 * T4f — the server-side PDF wrapper (the approved plan's option 1: client
 * raster → server wraps).
 *
 * [WHY THE SERVER WRAPS A RASTER INSTEAD OF DRAWING TEXT] Arabic text needs
 * shaping and bidi reordering. In the browser that is free and correct (the
 * text engine does it); on the server it would need an embedded font plus a
 * shaper plus a bidi pass — three dependencies and a class of ligature bugs,
 * for a document whose only consumer is a human reading a receipt on a phone.
 * So the browser renders the pixels and this module does the one thing a
 * server can do trivially and exactly: put those pixels on a page.
 *
 * [WHY THE PAGE WIDTH IS A CONSTANT, NOT A PARAMETER] The PDF is cached once
 * per invoice and shared to every recipient on every device (Rule 3), so its
 * geometry must not depend on the sharing device's thermal printer (Rule 4).
 * Page width comes from constraints.ts's RECEIPT_PDF_PAGE_WIDTH_PT — note
 * this is a DIFFERENT number from RECEIPT_PDF_RASTER_WIDTH (the route
 * validates the incoming raster against): the raster represents the ~72mm
 * printable area of an 80mm thermal head, while the PDF page is the full
 * 80mm paper width. That's deliberate, not a mismatch to fix — a PDF viewed
 * on screen has no thermal-head mechanical margin to preserve, so the raster
 * is scaled uniformly below (same factor on both axes, aspect ratio
 * preserved) to fill the page edge-to-edge, rather than reproducing the
 * printer's side margins inside the PDF.
 *
 * The page height follows the image's own aspect ratio: a long receipt becomes
 * one long page rather than being split across pages mid-line item.
 */

import { PDFDocument } from "pdf-lib";
import { RECEIPT_PDF_PAGE_WIDTH_PT } from "./constraints";

export interface RasterDimensions {
  width: number;
  height: number;
}

/**
 * Wraps a validated PNG into a single-page PDF sized to a fixed 80 mm width.
 *
 * `png` must be the exact bytes that were validated by
 * lib/receipts/raster-validation.ts — pdf-lib's embedPng() re-parses the image
 * itself (and will throw on a corrupt stream), but it does NOT re-check the
 * size/width policy, which is why validation is a separate, mandatory step.
 */
export async function buildReceiptPdfFromPng(
  png: Uint8Array,
  dimensions: RasterDimensions
): Promise<Uint8Array> {
  if (
    !Number.isFinite(dimensions?.width) ||
    !Number.isFinite(dimensions?.height) ||
    dimensions.width <= 0 ||
    dimensions.height <= 0
  ) {
    throw new Error(
      `Receipt PDF: invalid raster dimensions (${dimensions?.width}×${dimensions?.height}).`
    );
  }

  const document = await PDFDocument.create();
  const image = await document.embedPng(png);

  const pageWidth = RECEIPT_PDF_PAGE_WIDTH_PT;
  const scale = pageWidth / dimensions.width;
  const pageHeight = dimensions.height * scale;

  const page = document.addPage([pageWidth, pageHeight]);
  page.drawImage(image, {
    x: 0,
    y: 0,
    width: pageWidth,
    height: pageHeight,
  });

  return document.save();
}